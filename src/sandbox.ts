import { currentTenant, isRemote, isSandbox, withinRateLimit } from './store.js'

/**
 * The public try-it sandbox. Off unless SANDBOX_ENABLED=yes, and it needs the hosted store (so each visitor stays
 * separate) and AUTH_SECRET (to sign sessions). Every limit below exists so an open sandbox cannot burn your model
 * credit, fill the database, or reach anything real.
 */
const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) && Number(v) > 0 ? Number(v) : d)

export const sandboxEnabled = () => process.env.SANDBOX_ENABLED === 'yes' && isRemote() && Boolean(process.env.AUTH_SECRET)

export const LIMITS = {
  newPerIpPerHour: 5,
  newPerDay: () => num(process.env.SANDBOX_MAX_SESSIONS, 500),
  actionsPerSessionPerDay: 200,
  modelCallsPerSession: () => num(process.env.SANDBOX_MODEL_CALLS_PER_SESSION, 20),
  modelCallsPerDay: () => num(process.env.SANDBOX_MODEL_CALLS_PER_DAY, 300),
  plans: 5,
  payees: 10
}

/** Only these calls work in a sandbox. Anything that could touch a wallet, the schedule or the owner's data is absent. */
export const SANDBOX_ALLOWED = new Set([
  'GET /api/state',
  'POST /api/dca',
  'POST /api/dca/run',
  'POST /api/dca/cancel',
  'POST /api/payee',
  'POST /api/pay',
  'POST /api/portfolio/targets',
  'POST /api/portfolio/rebalance',
  'POST /api/paper/reset',
  'POST /api/approve',
  'POST /api/reject'
])

const today = () => new Date().toISOString().slice(0, 10)

export async function canStartSandbox(ip: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!(await withinRateLimit('sb-new:' + ip, LIMITS.newPerIpPerHour, 3600))) return { ok: false, message: 'Too many sandboxes from this connection. Try again in an hour.' }
  if (!(await withinRateLimit('sb-new:' + today(), LIMITS.newPerDay(), 86400))) return { ok: false, message: 'The sandbox is full for today. Please come back tomorrow, or run Ledgerly locally.' }
  return { ok: true }
}

export const actionAllowed = (id: string) => withinRateLimit('sb-act:' + id, LIMITS.actionsPerSessionPerDay, 86400)

/** Model calls cost money. Inside a sandbox they are capped per visitor and per day; past the cap the plain rules run instead. */
export async function modelBudgetOk(): Promise<boolean> {
  const id = isSandbox() ? currentTenant()?.id : undefined
  if (!id) return true
  if (!(await withinRateLimit('sb-model:' + id, LIMITS.modelCallsPerSession(), 86400))) return false
  return withinRateLimit('sb-model:' + today(), LIMITS.modelCallsPerDay(), 86400)
}
