import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

/**
 * A single shared password protects the hosted dashboard. Locally (no DASHBOARD_PASSWORD) there is no login, as before.
 * A successful login sets a signed, HttpOnly, SameSite=Strict cookie; nothing about the session is stored server side.
 */
const COOKIE = 'ledgerly_session'
const MIN_PASSWORD = 12
const sessionSeconds = () => Math.min(7 * 24, Math.max(1, Number(process.env.SESSION_HOURS) || 12)) * 3600

export const hosted = () => Boolean(process.env.VERCEL)
export const authRequired = () => Boolean(process.env.DASHBOARD_PASSWORD)

/** Why hosted mode refuses to serve the API, or null if it is configured safely. Fails closed. */
export function authConfigProblem(): string | null {
  if (!hosted()) return null
  const p = process.env.DASHBOARD_PASSWORD
  if (!p) return 'Set DASHBOARD_PASSWORD in the Vercel project settings. The dashboard will not run without a login.'
  if (p.length < MIN_PASSWORD) return `DASHBOARD_PASSWORD is too short. Use at least ${MIN_PASSWORD} characters (a long random one is best).`
  return null
}

const digest = (s: string) => createHash('sha256').update(s).digest()
/** Constant-time string comparison (hashes first so the lengths match). */
export const safeEqual = (a: string, b: string) => timingSafeEqual(digest(a), digest(b))

export const checkPassword = (input: unknown): boolean => typeof input === 'string' && input.length > 0 && authRequired() && safeEqual(input, process.env.DASHBOARD_PASSWORD as string)

const secret = () => process.env.AUTH_SECRET || 'ledgerly-session:' + digest(process.env.DASHBOARD_PASSWORD ?? '').toString('hex')
const sign = (payload: string) => createHmac('sha256', secret()).update(payload).digest('base64url')

export function makeToken(nowMs = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + sessionSeconds()
  return `${exp}.${sign(String(exp))}`
}

export function verifyToken(token: string | undefined, nowMs = Date.now()): boolean {
  if (!token) return false
  const [exp, sig] = token.split('.')
  if (!exp || !sig || !/^\d+$/.test(exp)) return false
  if (Number(exp) < nowMs / 1000) return false
  return safeEqual(sig, sign(exp))
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

export const isAuthed = (req: IncomingMessage) => verifyToken(parseCookies(req.headers.cookie)[COOKIE])

const flags = (secure: boolean) => `HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}`
export const sessionCookie = (token: string, secure: boolean) => `${COOKIE}=${token}; ${flags(secure)}; Max-Age=${sessionSeconds()}`
export const clearedCookie = (secure: boolean) => `${COOKIE}=; ${flags(secure)}; Max-Age=0`

/** True when the request carries `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends this automatically). */
export function cronAuthorized(req: IncomingMessage): boolean {
  const s = process.env.CRON_SECRET
  const h = req.headers.authorization
  return Boolean(s) && typeof h === 'string' && safeEqual(h, `Bearer ${s}`)
}

/** Best-effort client address for rate limiting behind Vercel's proxy. */
export function clientId(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for']
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim()
  return first || req.socket.remoteAddress || 'unknown'
}

/** Same-origin check for state-changing requests made with the session cookie. */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin) {
    try {
      return new URL(origin).host === req.headers.host
    } catch {
      return false
    }
  }
  const site = req.headers['sec-fetch-site']
  return !site || site === 'same-origin' || site === 'none'
}

// ---------- sandbox sessions ----------
// A visitor to /sandbox gets an anonymous session: a random id, signed so it cannot be forged or guessed for someone else.
const SB_COOKIE = 'ledgerly_sb'
export const SANDBOX_SESSION_SECONDS = 24 * 3600

export const makeSandboxId = () => randomBytes(16).toString('base64url')
const sbSign = (id: string) => createHmac('sha256', secret()).update('sandbox:' + id).digest('base64url')
export const makeSandboxToken = (id: string) => `${id}.${sbSign(id)}`

/** The sandbox id inside a valid token, or null. */
export function verifySandboxToken(token: string | undefined): string | null {
  if (!token) return null
  const [id, sig, extra] = token.split('.')
  if (!id || !sig || extra !== undefined || !/^[A-Za-z0-9_-]{16,32}$/.test(id)) return null
  return safeEqual(sig, sbSign(id)) ? id : null
}

export const sandboxIdFrom = (req: IncomingMessage) => verifySandboxToken(parseCookies(req.headers.cookie)[SB_COOKIE])
export const sandboxCookie = (token: string, secure: boolean) => `${SB_COOKIE}=${token}; ${flags(secure)}; Max-Age=${SANDBOX_SESSION_SECONDS}`
export const clearedSandboxCookie = (secure: boolean) => `${SB_COOKIE}=; ${flags(secure)}; Max-Age=0`

// ---------- account sessions ----------
const USER_COOKIE = 'ledgerly_user'
export const USER_SESSION_SECONDS = 7 * 24 * 3600

const userSign = (id: string, exp: string) => createHmac('sha256', secret()).update(`user:${id}.${exp}`).digest('base64url')
export function makeUserToken(id: string, nowMs = Date.now()): string {
  const exp = String(Math.floor(nowMs / 1000) + USER_SESSION_SECONDS)
  return `${id}.${exp}.${userSign(id, exp)}`
}

/** The account id inside a valid, unexpired token, or null. */
export function verifyUserToken(token: string | undefined, nowMs = Date.now()): string | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [id, exp, sig] = parts
  if (!/^[A-Za-z0-9_-]{8,32}$/.test(id) || !/^\d+$/.test(exp) || !sig) return null
  if (Number(exp) < nowMs / 1000) return null
  return safeEqual(sig, userSign(id, exp)) ? id : null
}

export const userIdFrom = (req: IncomingMessage) => verifyUserToken(parseCookies(req.headers.cookie)[USER_COOKIE])
export const userCookie = (token: string, secure: boolean) => `${USER_COOKIE}=${token}; ${flags(secure)}; Max-Age=${USER_SESSION_SECONDS}`
export const clearedUserCookie = (secure: boolean) => `${USER_COOKIE}=; ${flags(secure)}; Max-Age=0`
