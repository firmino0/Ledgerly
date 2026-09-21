import { dataPath, readJson, writeJson } from './store.js'

/**
 * A simulated portfolio used in dry-run mode, so DCA and rebalancing can be demonstrated end to end
 * without a funded wallet. Prices come from real quotes; only the balances are simulated.
 */
export interface Paper {
  cashUsd: number
  holdings: Record<string, number> // symbol -> token amount
}

const FILE = dataPath('paper.json')
export const DEFAULT_PAPER_CASH = 1000

export const getPaper = (): Paper => {
  const p = readJson<Partial<Paper>>(FILE, {})
  return { cashUsd: p.cashUsd ?? DEFAULT_PAPER_CASH, holdings: p.holdings ?? {} }
}
const save = (p: Paper) => writeJson(FILE, p)

export function resetPaper(cashUsd: number): Paper {
  const p: Paper = { cashUsd, holdings: {} }
  save(p)
  return p
}

export function paperBuy(symbol: string, usd: number, tokens: number): void {
  const p = getPaper()
  if (usd > p.cashUsd + 1e-9) throw new Error(`Paper portfolio has $${p.cashUsd.toFixed(2)} cash, need $${usd}.`)
  p.cashUsd -= usd
  p.holdings[symbol] = (p.holdings[symbol] ?? 0) + tokens
  save(p)
}

export function paperSell(symbol: string, tokens: number, usd: number): void {
  const p = getPaper()
  const have = p.holdings[symbol] ?? 0
  if (tokens > have + 1e-12) throw new Error(`Paper portfolio holds ${have} ${symbol}, cannot sell ${tokens}.`)
  p.holdings[symbol] = Math.max(0, have - tokens)
  p.cashUsd += usd
  save(p)
}
