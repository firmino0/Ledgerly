export interface Policy {
  maxPerTx: number
  maxPerDay: number
  approvalThreshold: number
  /** More than this many executed actions in 24 hours holds the next one for approval. 0 or unset turns it off. */
  maxActionsPerDay?: number
  /** A payee added less than this many hours ago holds every payment for approval. 0 or unset turns it off. */
  payeeCoolingHours?: number
}

/** Facts about the recent past that a plain amount check cannot see. Left out when a human has already approved the action. */
export interface Context {
  actionsToday?: number
  payeeAgeMs?: number | null
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
  allowlist: ReadonlySet<string>,
  ctx: Context = {}
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
  // These two close the paths a cap cannot: a newly added address paid straight away, and many small payments under the line.
  const cooling = (policy.payeeCoolingHours ?? 0) * 3_600_000
  if (req.to && cooling > 0 && ctx.payeeAgeMs != null && ctx.payeeAgeMs < cooling) {
    const left = Math.ceil((cooling - ctx.payeeAgeMs) / 3_600_000)
    return { decision: 'needs_approval', reason: `This payee was added less than ${policy.payeeCoolingHours} hours ago (about ${left} h left), so a payment to it holds for approval whatever the amount.` }
  }
  const maxActions = policy.maxActionsPerDay ?? 0
  if (maxActions > 0 && (ctx.actionsToday ?? 0) >= maxActions) {
    return { decision: 'needs_approval', reason: `${ctx.actionsToday} actions already ran in the last 24 hours, which reaches the limit of ${maxActions}, so this holds for approval.` }
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
