import { addPending, type PayRequest, payeeSet } from './approvals.js'
import { sendPayment } from './chain.js'
import { config, tradingOffReason } from './config.js'
import { policy } from './mode.js'
import { isUser } from './store.js'
import { evaluate } from './guardrails.js'
import { type LedgerEntry, readAll, record, spentToday } from './ledger.js'
import { explain } from './reasoning.js'

export type { PayRequest } from './approvals.js'
export { addPayee, listPayees } from './approvals.js'

export interface PayResult {
  status: 'executed' | 'pending_approval' | 'denied' | 'failed'
  message: string
  approvalId?: string
  txHash?: string
}

const off = () => tradingOffReason ?? 'Trading is switched off.'

const entry = (req: PayRequest, verdict: LedgerEntry['verdict'], executed: boolean, reasoning: string, extra: Partial<LedgerEntry> = {}) =>
  record({ module: req.module, action: req.memo, amountUsd: req.amountUsd, to: req.to, verdict, executed, reasoning, ...extra })

async function execute(req: PayRequest, reasoning: string, verdict: LedgerEntry['verdict']): Promise<PayResult> {
  if (isUser()) throw new Error('Accounts sign their own transactions, so nothing is sent from the server. Use "Sign with my wallet".')
  if (!config.live) throw new Error(off())
  try {
    const txHash = await sendPayment(req.to as `0x${string}`, req.amountUsd)
    entry(req, verdict, true, reasoning, { txHash })
    return { status: 'executed', txHash, message: `Paid ${req.amountUsd} to ${req.to}. ${reasoning}` }
  } catch (err) {
    const msg = (err as Error).message
    entry(req, verdict, false, `Failed: ${msg}`)
    return { status: 'failed', message: `Payment failed: ${msg}` }
  }
}

/** Single path for every outgoing payment (payroll and bills). The model never bypasses this. */
export async function pay(req: PayRequest): Promise<PayResult> {
  if (!config.live) return { status: 'denied', message: off() }
  const verdict = evaluate(policy(), req, spentToday(readAll()), payeeSet())
  const context = `Module: ${req.module}. Memo: ${req.memo}. Amount: ${req.amountUsd}. To: ${req.to}. Verdict: ${verdict.decision}${'reason' in verdict ? ` (${verdict.reason})` : ''}.`
  const reasoning = await explain(context)

  if (verdict.decision === 'deny') {
    entry(req, 'deny', false, `${verdict.reason} ${reasoning}`)
    return { status: 'denied', message: `Denied: ${verdict.reason}` }
  }
  if (verdict.decision === 'needs_approval') {
    const p = addPending({ kind: 'pay', req })
    entry(req, 'needs_approval', false, `${verdict.reason} ${reasoning}`)
    return { status: 'pending_approval', approvalId: p.id, message: `Needs human approval (${verdict.reason}). Approval id: ${p.id}` }
  }
  return execute(req, reasoning, 'allow')
}

/** Run a payment a human has approved. Per-tx cap, daily cap and allowlist are re-checked. */
export async function executeApprovedPayment(req: PayRequest, approvalId: string): Promise<PayResult> {
  const recheck = evaluate({ ...policy(), approvalThreshold: Infinity }, req, spentToday(readAll()), payeeSet())
  if (recheck.decision === 'deny') {
    entry(req, 'deny', false, `Approved but blocked: ${recheck.reason}`)
    return { status: 'denied', message: `Blocked on re-check: ${recheck.reason}` }
  }
  return execute(req, `Approved by a human (id ${approvalId}).`, 'needs_approval')
}
