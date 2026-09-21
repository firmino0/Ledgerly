import { takePending } from './approvals.js'
import { config } from './config.js'
import { dryRun } from './mode.js'
import { isUser } from './store.js'
import { record } from './ledger.js'
import { executeApprovedPayment } from './treasury.js'
import { requestTrade } from './trading.js'

export interface ApproveResult {
  status: string
  message: string
  txHash?: string
}

/** Approve any held action (a payment or a trade) by id. Expired or unknown ids are refused. */
export async function approveAny(id: string): Promise<ApproveResult> {
  if (isUser() && !dryRun()) return { status: 'denied', message: 'Accounts approve by signing with their own wallet. Use "Sign with my wallet".' }
  const p = takePending(id)
  if (!p) return { status: 'denied', message: `No pending action with id ${id}, or it expired (approvals last 24 hours).` }
  if (p.kind === 'pay') return executeApprovedPayment(p.req, p.id)
  return requestTrade(p.trade, { approved: true })
}

/** A human declines a held action. It is removed and the refusal is written to the ledger. */
export function rejectAny(id: string): ApproveResult {
  const p = takePending(id)
  if (!p) return { status: 'denied', message: `No pending action with id ${id}, or it expired.` }
  const detail =
    p.kind === 'pay'
      ? { module: p.req.module, action: p.req.memo, amountUsd: p.req.amountUsd, to: p.req.to }
      : { module: p.trade.module, action: `${p.trade.side === 'buy' ? 'Buy' : 'Sell'} ${p.trade.symbol}`, amountUsd: p.trade.amountUsd }
  record({ ...detail, verdict: 'deny', executed: false, dryRun: dryRun(), reasoning: 'Rejected by a human.' })
  return { status: 'rejected', message: 'Rejected. Nothing was executed.' }
}
