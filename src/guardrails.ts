export interface Policy {
  maxPerTx: number
  maxPerDay: number
  approvalThreshold: number
}

export type Verdict =
  | { decision: 'allow' }
  | { decision: 'needs_approval'; reason: string }
  | { decision: 'deny'; reason: string }

export interface ActionRequest {
  amountUsd: number
  to?: string
}

/**
 * Pure, deterministic policy check. The model proposes; this decides.
 * `spentTodayUsd` is what has already been executed in the current UTC day.
 */
export function evaluate(
  policy: Policy,
  req: ActionRequest,
  spentTodayUsd: number,
  allowlist: ReadonlySet<string>
): Verdict {
  if (!Number.isFinite(req.amountUsd) || req.amountUsd <= 0) {
    return { decision: 'deny', reason: 'Amount must be a positive number.' }
  }
  if (req.to && !allowlist.has(req.to.toLowerCase())) {
    return { decision: 'deny', reason: `Recipient ${req.to} is not on the allowlist.` }
  }
  if (req.amountUsd > policy.maxPerTx) {
    return { decision: 'deny', reason: `Amount ${req.amountUsd} exceeds per-transaction cap ${policy.maxPerTx}.` }
  }
  if (spentTodayUsd + req.amountUsd > policy.maxPerDay) {
    return {
      decision: 'deny',
      reason: `Would bring today's spend to ${spentTodayUsd + req.amountUsd}, over the daily cap ${policy.maxPerDay}.`
    }
  }
  if (req.amountUsd > policy.approvalThreshold) {
    return {
      decision: 'needs_approval',
      reason: `Amount ${req.amountUsd} is above the auto-approve threshold ${policy.approvalThreshold}.`
    }
  }
  return { decision: 'allow' }
}

/**
 * A short, structured label for which rule decided this verdict — the auditable half of the ledger, kept apart
 * from any model commentary. `allow` has no `reason` field on the type, so this fills one in for it.
 */
export function ruleFor(v: Verdict): string {
  return v.decision === 'allow' ? 'Within the per-transaction cap, the daily cap and the approval threshold.' : v.reason
}
