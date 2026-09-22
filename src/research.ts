import { getQuote } from './market.js'
import { ask, usableExplanation } from './reasoning.js'
import { quoteBuy } from './swap.js'

export interface ResearchResult {
  symbol: string
  quote: {
    bid: number
    ask: number
    mid: number
    dailyHigh: number
    dailyLow: number
    halted: boolean
    generatedAt: string
  }
  contract?: string
  /** True only when a live Uniswap v3 pool against USDG was actually found on Robinhood Chain, not just that the API named a contract. */
  tradable: boolean
  note: string
}

const SYSTEM =
  "You help someone research a tokenized stock before they decide whether to dollar-cost-average into it or add it to their portfolio targets. You are given its current quote. In 2-3 plain sentences, describe where the price sits in today's range and note anything relevant, such as a trading halt or a missing onchain pool. Never recommend buying or selling, never give a price target or prediction, and say plainly that this is not financial advice."

/**
 * Look up a symbol: its live quote from Robinhood, whether Ledgerly can actually trade it onchain right now
 * (a real Uniswap v3 pool against USDG, not just a contract address), and a short SERV Reasoning summary.
 * Entirely read-only: nothing here moves money or is affected by the guardrails.
 */
export async function researchAsset(symbol: string): Promise<ResearchResult> {
  const quote = await getQuote(symbol)

  let tradable = false
  let poolNote = 'No Robinhood Chain deployment was found for this symbol.'
  if (quote.contract) {
    try {
      await quoteBuy(quote.contract as `0x${string}`, 1, quote.mid)
      tradable = true
      poolNote = 'A live Uniswap v3 pool against USDG was found on Robinhood Chain.'
    } catch (err) {
      poolNote = `No live pool was found on Robinhood Chain (${(err as Error).message}).`
    }
  }

  const context = `Symbol: ${quote.symbol}. Bid ${quote.bid}, ask ${quote.ask}, mid ${quote.mid}. Today's range: ${quote.dailyLow} to ${quote.dailyHigh}. ${quote.halted ? 'Trading is currently halted.' : 'Trading normally.'} ${poolNote}`
  const reply = await ask(SYSTEM, context, { maxTokens: 220 })
  const note = usableExplanation(reply) ? reply : context

  return {
    symbol: quote.symbol,
    quote: { bid: quote.bid, ask: quote.ask, mid: quote.mid, dailyHigh: quote.dailyHigh, dailyLow: quote.dailyLow, halted: quote.halted, generatedAt: quote.generatedAt },
    contract: quote.contract,
    tradable,
    note
  }
}
