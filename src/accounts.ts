import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { isRemote, rawCreate, rawGet, rawRemove, withinRateLimit } from './store.js'

/**
 * Real accounts. A person signs up with a username and password, gets private saved data, and signs every
 * transaction with THEIR OWN wallet. There is no server-side key for an account, so the owner's agent wallet can
 * never be reached from here. Off unless USERS_ENABLED=yes (and the hosted store and AUTH_SECRET are present).
 */
const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) && Number(v) >= 0 ? Number(v) : d)

export const usersEnabled = () => process.env.USERS_ENABLED === 'yes' && isRemote() && Boolean(process.env.AUTH_SECRET)

/** Default limits for an account. Every action still needs the person's own wallet signature. */
export const USER_POLICY = {
  maxPerTx: num(process.env.USER_MAX_PER_TX, 25),
  maxPerDay: num(process.env.USER_MAX_PER_DAY, 100),
  approvalThreshold: 0 // 0 means every action is held for that person to sign
}

/** Selling and rebalancing have not run on-chain yet, so accounts cannot do them live until this is switched on. */
export const allowLiveSells = () => process.env.USERS_ALLOW_SELLS === 'yes'

export const USER_LIMITS = {
  signupsPerIpPerHour: 3,
  signupsPerDay: () => num(process.env.USERS_MAX_SIGNUPS_PER_DAY, 100),
  loginsPerIpPer5Min: 15,
  loginsPerNamePer15Min: 8,
  actionsPerDay: 2000
}

/** Only these calls work for an account. There is no agent send, no cron and no owner endpoint. */
export const USER_ALLOWED = new Set([
  'GET /api/state',
  'GET /api/wallet',
  'POST /api/dca',
  'POST /api/dca/run',
  'POST /api/dca/cancel',
  'POST /api/payee',
  'POST /api/pay',
  'POST /api/portfolio/targets',
  'POST /api/portfolio/rebalance',
  'POST /api/paper/reset',
  'POST /api/reject',
  'POST /api/approve', // paper mode only; live approval is signing (approveAny refuses otherwise)
  'POST /api/wallet/prepare',
  'POST /api/wallet/complete',
  'POST /api/account/wallet'
])

export interface AccountRecord {
  id: string
  username: string
  salt: string
  hash: string
  createdAt: string
}

export function validateUsername(input: unknown): string {
  const u = typeof input === 'string' ? input.trim().toLowerCase() : ''
  if (!/^[a-z0-9_]{3,24}$/.test(u)) throw new Error('Username must be 3 to 24 characters: letters, numbers and underscores.')
  return u
}

export function validatePassword(input: unknown, username: string): string {
  const p = typeof input === 'string' ? input : ''
  if (p.length < 10) throw new Error('Password must be at least 10 characters.')
  if (p.length > 128) throw new Error('Password must be at most 128 characters.')
  if (p.toLowerCase().includes(username)) throw new Error('Password must not contain your username.')
  return p
}

const kdf = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key))))

const DUMMY_SALT = randomBytes(16)
const recordName = (username: string) => 'acct:' + username

export async function hashPassword(password: string) {
  const salt = randomBytes(16)
  return { salt: salt.toString('base64'), hash: (await kdf(password, salt)).toString('base64') }
}

export async function createAccount(usernameInput: unknown, passwordInput: unknown): Promise<{ id: string; username: string }> {
  const username = validateUsername(usernameInput)
  const password = validatePassword(passwordInput, username)
  const record: AccountRecord = { id: randomBytes(12).toString('base64url'), username, ...(await hashPassword(password)), createdAt: new Date().toISOString() }
  if (!(await rawCreate(recordName(username), record))) throw new Error('That username is taken.')
  return { id: record.id, username }
}

/** The account for a correct username and password, or null. Takes the same time whether or not the username exists. */
export async function checkLogin(usernameInput: unknown, password: unknown): Promise<{ id: string; username: string } | null> {
  const username = typeof usernameInput === 'string' ? usernameInput.trim().toLowerCase() : ''
  const pw = typeof password === 'string' ? password : ''
  const rec = /^[a-z0-9_]{3,24}$/.test(username) ? await rawGet<AccountRecord>(recordName(username)) : null
  const salt = rec ? Buffer.from(rec.salt, 'base64') : DUMMY_SALT
  const got = await kdf(pw.slice(0, 128), salt)
  if (!rec) return null
  const want = Buffer.from(rec.hash, 'base64')
  return got.length === want.length && timingSafeEqual(got, want) ? { id: rec.id, username: rec.username } : null
}

export async function removeAccount(username: string, id: string) {
  await rawRemove([recordName(username)], { kind: 'user', id })
}

export async function signupAllowed(ip: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!(await withinRateLimit('acct-new-ip:' + ip, USER_LIMITS.signupsPerIpPerHour, 3600))) return { ok: false, message: 'Too many sign-ups from this connection. Try again in an hour.' }
  if (!(await withinRateLimit('acct-new:' + new Date().toISOString().slice(0, 10), USER_LIMITS.signupsPerDay(), 86400))) return { ok: false, message: 'Sign-ups are full for today. Please come back tomorrow.' }
  return { ok: true }
}

export async function loginAllowed(ip: string, username: string): Promise<boolean> {
  return (await withinRateLimit('acct-login-ip:' + ip, USER_LIMITS.loginsPerIpPer5Min, 300)) && (await withinRateLimit('acct-login:' + username.toLowerCase(), USER_LIMITS.loginsPerNamePer15Min, 900))
}
