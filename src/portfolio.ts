import { formatUnits } from 'viem'
import { walletAddress } from './chain.js'
import { config } from './config.js'
import { dryRun } from './mode.js'
import { isUser } from './store.js'
import { record } from './ledger.js'
import { getQuote } from './market.js'
import { getPaper } from './paper.js'
import { explain } from './reasoning.js'
import { bumpVersion, dataPath, getVersion, isRemote, readJson, writeJson } from './store.js'
import { ADDR, balanceOf } from './swap.js'
import { requestTrade, type TradeResult } from './trading.js'

export interface PortfolioConfig {
  targets: Record<string, number> // symbol -> target percent. Whatever is left over is the cash (USDG) target.
  driftThresholdPct: number // only rebalance an asset when it is this far (in points) from its target
  minTradeUsd: number // ignore trades smaller than this
}

export interface Row {
  symbol: string
  valueUsd: number
  currentPct: number
  targetPct: number
  driftPct: number // current - target, in percentage points
}

export interface PlannedTrade {
  side: 'buy' | 'sell'
  symbol: string
  amountUsd: number
}

export interface Plan {
  totalUsd: number
  cashUsd: number
  cashPct: number
  cashTargetPct: number
  rows: Row[]
  trades: PlannedTrade[]
}

const FILE = dataPath('portfolio.json')
const DEFAULTS: PortfolioConfig = { targets: {}, driftThresholdPct: 5, minTradeUsd: 1 }
const cents = (n: number) => Math.round(n * 100) / 100

export const getPortfolioConfig = (): PortfolioConfig => ({ ...DEFAULTS, ...readJson<Partial<PortfolioConfig>>(FILE, {}) })

export function setTargets(targets: Record<string, number>, driftThresholdPct = 5, minTradeUsd = 1): PortfolioConfig {
  const clean: Record<string, number> = {}
  for (const [sym, pct] of Object.entries(targets)) {
    const s = sym.trim().toUpperCase()
    if (!/^[A-Z0-9.]{1,10}$/.test(s)) throw new Error(`Invalid symbol: ${sym}`)
    if (!(pct > 0 && pct <= 100)) throw new Error(`Target for ${s} must be between 0 and 100.`)
    clean[s] = pct
  }
  const sum = Object.values(clean).reduce((a, b) => a + b, 0)
  if (sum > 100 + 1e-9) throw new Error(`Targets add up to ${sum}%, which is over 100%.`)
  if (!(driftThresholdPct >= 0.5 && driftThresholdPct <= 50)) throw new Error('Drift threshold must be between 0.5 and 50 percentage points.')
  const cfg = { targets: clean, driftThresholdPct, minTradeUsd: Math.max(0.01, minTradeUsd) }
  writeJson(FILE, cfg)
  bumpVersion()
  return cfg
}

/**
 * Pure rebalancing math. Sells overweight assets and buys underweight ones, but only for assets whose drift
 * is at least the threshold. Buys are scaled down if there isn't enough cash (existing cash + sale proceeds).
 */
export function planRebalance(holdingsUsd: Record<string, number>, cashUsd: number, cfg: PortfolioConfig): Plan {
  const symbols = Object.keys(cfg.targets)
  const invested = symbols.reduce((s, k) => s + (holdingsUsd[k] ?? 0), 0)
  const totalUsd = cashUsd + invested
  const targetSum = symbols.reduce((s, k) => s + cfg.targets[k], 0)
  const cashTargetPct = 100 - targetSum
  const pct = (v: number) => (totalUsd > 0 ? (v / totalUsd) * 100 : 0)

  const rows: Row[] = symbols.map(symbol => {
    const valueUsd = holdingsUsd[symbol] ?? 0
    const currentPct = pct(valueUsd)
    return { symbol, valueUsd: cents(valueUsd), currentPct, targetPct: cfg.targets[symbol], driftPct: currentPct - cfg.targets[symbol] }
  })

  const sells: PlannedTrade[] = []
  let buys: PlannedTrade[] = []
  for (const r of rows) {
    if (Math.abs(r.driftPct) < cfg.driftThresholdPct) continue
    const diffUsd = (totalUsd * r.targetPct) / 100 - r.valueUsd
    const amountUsd = cents(Math.abs(diffUsd))
    if (amountUsd < cfg.minTradeUsd) continue
    if (diffUsd < 0) sells.push({ side: 'sell', symbol: r.symbol, amountUsd })
    else buys.push({ side: 'buy', symbol: r.symbol, amountUsd })
  }

  const available = cashUsd + sells.reduce((s, t) => s + t.amountUsd, 0)
  const wanted = buys.reduce((s, t) => s + t.amountUsd, 0)
  if (wanted > available && wanted > 0) {
    const k = available / wanted
    buys = buys.map(t => ({ ...t, amountUsd: cents(t.amountUsd * k) })).filter(t => t.amountUsd >= cfg.minTradeUsd)
  }

  return { totalUsd: cents(totalUsd), cashUsd: cents(cashUsd), cashPct: pct(cashUsd), cashTargetPct, rows, trades: [...sells, ...buys] }
}

export interface Snapshot {
  source: 'paper' | 'onchain'
  holdingsUsd: Record<string, number>
  cashUsd: number
}

/** Current holdings valued at live mid prices. Dry-run uses the simulated portfolio; live reads the wallet. */
export async function snapshot(symbols: string[]): Promise<Snapshot> {
  const quotes = await Promise.all(symbols.map(s => getQuote(s)))
  const holdingsUsd: Record<string, number> = {}

  if (dryRun()) {
    const paper = getPaper()
    quotes.forEach(q => (holdingsUsd[q.symbol] = (paper.holdings[q.symbol] ?? 0) * q.mid))
    return { source: 'paper', holdingsUsd, cashUsd: paper.cashUsd }
  }

  const owner = walletAddress()
  if (!owner) throw new Error(isUser() ? 'Connect your wallet on the dashboard to see your live portfolio.' : 'AGENT_PRIVATE_KEY is not set, so the wallet cannot be read.')
  const usdg = await balanceOf(ADDR.usdg, owner)
  for (const q of quotes) {
    if (!q.contract) throw new Error(`${q.symbol} has no Robinhood Chain deployment.`)
    holdingsUsd[q.symbol] = Number(formatUnits(await balanceOf(q.contract as `0x${string}`, owner), 18)) * q.mid
  }
  return { source: 'onchain', holdingsUsd, cashUsd: Number(formatUnits(usdg, 6)) }
}

let viewCache: { at: number; version: number; value: unknown } | null = null

/** Portfolio table for the dashboard, cached briefly because the page polls. */
export async function portfolioView() {
  const cfg = getPortfolioConfig()
  const symbols = Object.keys(cfg.targets)
  if (!symbols.length) return { cfg, source: dryRun() ? 'paper' : 'onchain', plan: null as Plan | null }
  // The short cache is per process, so it is skipped when hosted (another instance may have changed the balances).
  if (!isRemote() && viewCache && viewCache.version === getVersion() && Date.now() - viewCache.at < 20_000) return viewCache.value as { cfg: PortfolioConfig; source: string; plan: Plan }
  const snap = await snapshot(symbols)
  const value = { cfg, source: snap.source, plan: planRebalance(snap.holdingsUsd, snap.cashUsd, cfg) }
  viewCache = { at: Date.now(), version: getVersion(), value }
  return value
}
export const clearPortfolioCache = () => (viewCache = null)

export interface RebalanceResult {
  message: string
  plan?: Plan
  results: { trade: PlannedTrade; result: TradeResult }[]
}

export async function runRebalance(): Promise<RebalanceResult> {
  const cfg = getPortfolioConfig()
  const symbols = Object.keys(cfg.targets)
  if (!symbols.length) return { message: 'No targets set. Set target percentages first.', results: [] }

  clearPortfolioCache()
  const snap = await snapshot(symbols)
  const plan = planRebalance(snap.holdingsUsd, snap.cashUsd, cfg)

  if (!plan.trades.length) {
    const msg = `Portfolio is within ${cfg.driftThresholdPct} points of target. No trades needed.`
    record({ module: 'rebalance', action: 'Rebalance check', verdict: 'allow', executed: false, dryRun: dryRun(), reasoning: msg })
    return { message: msg, plan, results: [] }
  }

  const table = plan.rows.map(r => `${r.symbol}: ${r.currentPct.toFixed(1)}% vs target ${r.targetPct}%`).join('; ')
  const tradeText = plan.trades.map(t => `${t.side} $${t.amountUsd} ${t.symbol}`).join(', ')
  const why = await explain(`Portfolio rebalance. ${table}; cash ${plan.cashPct.toFixed(1)}% vs target ${plan.cashTargetPct.toFixed(1)}%. Planned trades: ${tradeText}. These trades bring each drifting asset back to its target weight.`)

  const results: RebalanceResult['results'] = []
  for (const trade of plan.trades) {
    results.push({ trade, result: await requestTrade({ ...trade, module: 'rebalance', why }) })
  }
  clearPortfolioCache()
  return { message: `Rebalance: ${tradeText}.`, plan, results }
}
