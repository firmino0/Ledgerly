import { randomUUID } from 'node:crypto'
import { config } from './config.js'
import { record } from './ledger.js'
import { getQuote, type Quote } from './market.js'
import { ask } from './reasoning.js'
import { dataPath, readJson, writeJson } from './store.js'
import { requestTrade } from './trading.js'

export interface DcaPlan {
  id: string
  symbol: string
  amountUsd: number
  intervalHours: number
  createdAt: string
  lastRunAt: string | null
  active: boolean
}

export interface DcaDecision {
  action: 'buy' | 'skip'
  multiplier: number
  why: string
  source: 'serv' | 'default'
}

export interface DcaRunResult {
  planId: string
  symbol: string
  outcome: 'bought_live' | 'skipped' | 'denied' | 'pending_approval' | 'error'
  amountUsd?: number
  estTokens?: number
  txHash?: string
  approvalId?: string
  message: string
}

const MIN_MULT = 0.5
const MAX_MULT = 1.5
const FILE = dataPath('dca.json')

// ---------- persistence ----------
const load = (): DcaPlan[] => readJson<DcaPlan[]>(FILE, [])
const save = (plans: DcaPlan[]): void => writeJson(FILE, plans)

export const listPlans = () => load()

export function createPlan(symbol: string, amountUsd: number, intervalHours: number): DcaPlan {
  if (!/^[A-Za-z0-9.]{1,10}$/.test(symbol.trim())) throw new Error(`Invalid symbol: ${symbol}`)
  const plan: DcaPlan = {
    id: randomUUID().slice(0, 8),
    symbol: symbol.trim().toUpperCase(),
    amountUsd,
    intervalHours,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    active: true
  }
  save([...load(), plan])
  return plan
}

export function cancelPlan(id: string): boolean {
  const plans = load()
  const p = plans.find(x => x.id === id)
  if (!p) return false
  p.active = false
  save(plans)
  return true
}

export function isDue(plan: DcaPlan, now = new Date()): boolean {
  if (!plan.active) return false
  if (!plan.lastRunAt) return true
  return now.getTime() - new Date(plan.lastRunAt).getTime() >= plan.intervalHours * 3_600_000
}

// ---------- decision ----------
const DEFAULT: DcaDecision = { action: 'buy', multiplier: 1, why: 'Default: buy the planned amount.', source: 'default' }

/** Parse the model's JSON reply and clamp it. Anything malformed falls back to a plain scheduled buy. */
export function parseDecision(text: string | null): DcaDecision {
  if (!text) return DEFAULT
  const json = text.match(/\{[\s\S]*\}/)?.[0]
  if (!json) return DEFAULT
  try {
    const o = JSON.parse(json) as { action?: string; multiplier?: number; why?: string; reason?: string }
    const action = o.action === 'skip' ? 'skip' : 'buy'
    const m = Number(o.multiplier)
    const multiplier = Number.isFinite(m) ? Math.min(MAX_MULT, Math.max(MIN_MULT, m)) : 1
    return { action, multiplier, why: String(o.why ?? o.reason ?? '').slice(0, 400) || 'No explanation given.', source: 'serv' }
  } catch {
    return DEFAULT
  }
}

const SYSTEM = `You decide whether a scheduled dollar-cost-averaging buy of a tokenized stock should proceed. Reply with ONLY a JSON object: {"action":"buy"|"skip","multiplier":number between 0.5 and 1.5,"why":"one or two plain sentences"}. Default to buying the planned amount (multiplier 1). Buy a little more (up to 1.5) when the price is near the bottom of its daily range, a little less (down to 0.5) near the top. Skip only for a clear reason. Never suggest chasing momentum or trying to time the market. This is a disciplined recurring purchase.`

async function decide(plan: DcaPlan, q: Quote): Promise<DcaDecision> {
  const pos = q.dailyHigh > q.dailyLow ? (q.mid - q.dailyLow) / (q.dailyHigh - q.dailyLow) : 0.5
  const user = `Symbol ${q.symbol}. Planned buy $${plan.amountUsd}. Bid ${q.bid}, ask ${q.ask}. Daily low ${q.dailyLow}, high ${q.dailyHigh}. Price sits at ${(pos * 100).toFixed(0)}% of today's range.`
  return parseDecision(
    await ask(SYSTEM, user, {
      maxTokens: 400,
      shadowHint: 'The reply must be only a JSON object with "action" ("buy" or "skip"), "multiplier" (a number from 0.5 to 1.5) and "why" (one or two plain sentences).'
    })
  )
}

// ---------- execution ----------
export async function runPlan(plan: DcaPlan, now = new Date()): Promise<DcaRunResult> {
  const base = { planId: plan.id, symbol: plan.symbol }
  const skip = (reasoning: string) =>
    record({ module: 'dca', action: `Skip ${plan.symbol}`, verdict: 'allow', executed: false, reasoning })

  try {
    const q = await getQuote(plan.symbol)
    if (q.halted) {
      skip('Trading is halted for this asset.')
      return { ...base, outcome: 'skipped', message: 'Skipped: trading halted.' }
    }

    const d = await decide(plan, q)
    if (d.action === 'skip') {
      skip(d.why)
      return { ...base, outcome: 'skipped', message: `Skipped: ${d.why}` }
    }

    const amountUsd = Math.round(plan.amountUsd * d.multiplier * 100) / 100
    const r = await requestTrade({ side: 'buy', symbol: plan.symbol, amountUsd, module: 'dca', why: `${d.why} [${d.source}, x${d.multiplier}]` })
    const outcome: DcaRunResult['outcome'] =
      r.status === 'executed' ? 'bought_live' : r.status === 'pending_approval' ? 'pending_approval' : r.status === 'denied' ? 'denied' : r.status === 'skipped' ? 'skipped' : 'error'
    return { ...base, outcome, amountUsd, estTokens: r.tokens, txHash: r.txHash, approvalId: r.approvalId, message: `${r.message} ${r.status === 'executed' ? d.why : ''}`.trim() }
  } catch (err) {
    const msg = (err as Error).message
    skip(`Error: ${msg}`)
    return { ...base, outcome: 'error', message: msg }
  } finally {
    const plans = load()
    const p = plans.find(x => x.id === plan.id)
    if (p) {
      p.lastRunAt = now.toISOString()
      save(plans)
    }
  }
}

export async function runDue(now = new Date()): Promise<DcaRunResult[]> {
  const out: DcaRunResult[] = []
  for (const p of load().filter(x => isDue(x, now))) out.push(await runPlan(p, now))
  return out
}
