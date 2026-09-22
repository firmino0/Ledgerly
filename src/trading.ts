import { formatUnits, parseUnits } from 'viem'
import { addPending, type TradeRequest } from './approvals.js'
import { config, tradingOffReason } from './config.js'
import { allowLiveSells } from './accounts.js'
import { policy } from './mode.js'
import { isUser } from './store.js'
import { evaluate, ruleFor } from './guardrails.js'
import { readAll, record, spentToday } from './ledger.js'
import { getQuote, type Quote } from './market.js'
import { balanceOf, buyToken, quoteBuy, quoteSell, sellToken } from './swap.js'
import { walletAddress } from './chain.js'
import { bumpVersion } from './store.js'

export interface TradeResult {
  status: 'executed' | 'denied' | 'pending_approval' | 'skipped' | 'error'
  message: string
  approvalId?: string
  amountUsd?: number
  tokens?: number
  txHash?: string
}

const log = (t: TradeRequest, verdict: 'allow' | 'needs_approval' | 'deny', action: string, executed: boolean, reasoning: string, txHash?: string, rule?: string) =>
  record({ module: t.module, action, amountUsd: t.amountUsd, verdict, executed, txHash, reasoning, rule })

async function execute(t: TradeRequest, q: Quote, rule: string): Promise<TradeResult> {
  if (isUser()) throw new Error('Accounts sign their own transactions, so nothing is sent from the server. Use "Sign with my wallet".')
  const label = `${t.side === 'buy' ? 'Buy' : 'Sell'} ${t.symbol}`
  const contract = q.contract as `0x${string}`

  if (t.side === 'buy') {
    const route = await quoteBuy(contract, t.amountUsd, q.ask)
    const detail = `~${route.tokens.toFixed(6)} tokens via ${route.fee / 10_000}% pool @ $${route.impliedPriceUsd.toFixed(2)} (ask ${q.ask})`
    const { swapTx } = await buyToken(contract, t.amountUsd, route)
    log(t, 'allow', `${label}: ${detail}`, true, t.why, swapTx, rule)
    return { status: 'executed', amountUsd: t.amountUsd, tokens: route.tokens, txHash: swapTx, message: `Bought $${t.amountUsd} of ${t.symbol}, ${detail}. tx ${swapTx}` }
  }

  // sell: never sell more than is held
  const wanted = t.amountUsd / q.mid
  let held: number
  const owner = walletAddress()
  if (owner) held = Number(formatUnits(await balanceOf(contract, owner), 18))
  else throw new Error('AGENT_PRIVATE_KEY is not set.')
  const tokens = Math.min(wanted, held)
  if (tokens <= 0) return { status: 'skipped', message: `Nothing to sell: no ${t.symbol} held.` }
  const usdEstimate = Math.round(tokens * q.mid * 100) / 100

  const amountIn = parseUnits(tokens.toFixed(18), 18)
  const route = await quoteSell(contract, amountIn, q.bid)
  const detail = `~${tokens.toFixed(6)} tokens for ~$${route.usdOut.toFixed(2)} via ${route.fee / 10_000}% pool @ $${route.impliedPriceUsd.toFixed(2)} (bid ${q.bid})`
  const { swapTx } = await sellToken(contract, amountIn, route)
  log(t, 'allow', `${label}: ${detail}`, true, t.why, swapTx, rule)
  return { status: 'executed', amountUsd: usdEstimate, tokens, txHash: swapTx, message: `Sold ${detail}. tx ${swapTx}` }
}

/**
 * Single path for every buy and sell (DCA and rebalancing): quote -> guardrails -> hold, deny or execute.
 * `approved` is set only when a human has approved a held trade; caps are still re-checked.
 */
export async function requestTrade(t: TradeRequest, opts: { approved?: boolean } = {}): Promise<TradeResult> {
  const label = `${t.side === 'buy' ? 'Buy' : 'Sell'} ${t.symbol}`
  try {
    if (!config.live) return { status: 'denied', message: tradingOffReason ?? 'Trading is switched off.' }
    if (isUser() && t.side === 'sell' && !allowLiveSells()) {
      log(t, 'deny', label, false, 'Live selling is not switched on for accounts yet.')
      return { status: 'denied', message: 'Live selling and rebalancing are not switched on for accounts yet. Buying is available.' }
    }
    const q = await getQuote(t.symbol)
    if (q.halted) {
      log(t, 'allow', `Skip ${label}`, false, 'Trading is halted for this asset.')
      return { status: 'skipped', message: `${t.symbol} trading is halted.` }
    }
    if (!q.contract) {
      log(t, 'allow', `Skip ${label}`, false, 'No Robinhood Chain deployment found for this symbol.')
      return { status: 'error', message: `${t.symbol} has no Robinhood Chain deployment.` }
    }

    const rules = opts.approved ? { ...policy(), approvalThreshold: Infinity } : policy()
    const verdict = evaluate(rules, { amountUsd: t.amountUsd }, spentToday(readAll()), new Set())

    if (verdict.decision === 'deny') {
      log(t, 'deny', label, false, t.why, undefined, ruleFor(verdict))
      return { status: 'denied', amountUsd: t.amountUsd, message: `Denied: ${verdict.reason}` }
    }
    if (verdict.decision === 'needs_approval') {
      const p = addPending({ kind: 'trade', trade: t })
      log(t, 'needs_approval', label, false, t.why, undefined, ruleFor(verdict))
      return { status: 'pending_approval', approvalId: p.id, amountUsd: t.amountUsd, message: `Held for approval (${verdict.reason}) id ${p.id}` }
    }
    const result = await execute(t, q, ruleFor(verdict))
    bumpVersion()
    return result
  } catch (err) {
    const msg = (err as Error).message
    log(t, 'allow', label, false, `Error: ${msg}`)
    return { status: 'error', message: msg }
  }
}
