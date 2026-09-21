import { USER_POLICY } from './accounts.js'
import { config } from './config.js'
import { isSandbox, isUser } from './store.js'

/**
 * What applies to the current request. A sandbox visitor is always dry run, has no wallet, and gets roomy demo limits
 * instead of the owner's small live limits. Everything that decides "real or simulated" asks here, not config directly.
 */
export const SANDBOX_POLICY = { maxPerTx: 500, maxPerDay: 2000, approvalThreshold: 25 }

export const dryRun = () => config.dryRun || isSandbox()
export const policy = () => (isSandbox() ? SANDBOX_POLICY : isUser() ? USER_POLICY : config.policy)
