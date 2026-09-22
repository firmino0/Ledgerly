import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAddress } from 'viem'
import { z } from 'zod'
import { USER_ALLOWED, USER_LIMITS, checkLogin, createAccount, loginAllowed, removeAccount, signupAllowed, usersEnabled, validatePassword, validateUsername } from './accounts.js'
import { APPROVAL_TTL_MS, listPending } from './approvals.js'
import { approveAny, rejectAny } from './approve.js'
import { authConfigProblem, authRequired, checkPassword, clearedCookie, clearedUserCookie, clientId, cronAuthorized, hosted, isAuthed, makeToken, makeUserToken, sameOrigin, sessionCookie, userCookie, userIdFrom } from './auth.js'
import { tokenBalance, walletAddress } from './chain.js'
import { config, tradingOffReason } from './config.js'
import { policy } from './mode.js'
import { cancelPlan, createPlan, listPlans, runDue } from './dca.js'
import { readAll, spentToday } from './ledger.js'
import { portfolioView, runRebalance, runRebalanceIfDue, setTargets } from './portfolio.js'
import { researchAsset } from './research.js'
import { backendName, currentTenant, dataPath, isUser, readJson as readSaved, withinRateLimit, withStore, writeJson } from './store.js'
import { addPayee, listPayees, pay } from './treasury.js'
import { completeSigned, prepareSigned, signingAvailable, walletBalances } from './walletSign.js'

const WEB = resolve(fileURLToPath(new URL('../web/', import.meta.url)))
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a 0x EVM address')

const bodies = {
  dca: z.object({ symbol: z.string(), amountUsd: z.number().positive(), intervalHours: z.number().min(1) }),
  cancel: z.object({ id: z.string() }),
  payee: z.object({ address, label: z.string().min(1).max(60) }),
  pay: z.object({ module: z.enum(['payroll', 'bills']), to: address, amountUsd: z.number().positive(), memo: z.string().max(120) }),
  id: z.object({ id: z.string() }),
  targets: z.object({ targets: z.record(z.string(), z.number()), driftThresholdPct: z.number().optional() }),
  prepare: z.object({ id: z.string(), account: z.string() }),
  complete: z.object({ id: z.string(), account: z.string(), hashes: z.array(z.string()).min(1).max(3) }),
  linkWallet: z.object({ address }),
  confirm: z.object({ password: z.string().min(1).max(128) }),
  signup: z.object({ username: z.string(), password: z.string(), accept: z.literal(true, { errorMap: () => ({ message: 'Please confirm that you understand the risks.' }) }) }),
  signin: z.object({ username: z.string(), password: z.string() })
}

const PROFILE = dataPath('profile.json')

const EXPLORER = config.network === 'mainnet' ? 'https://robinhoodchain.blockscout.com/tx/' : 'https://explorer.testnet.chain.robinhood.com/tx/'

async function state() {
  const entries = readAll()
  return {
    network: config.network,
    live: config.live,
    offReason: tradingOffReason,
    signing: signingAvailable(),
    hosted: hosted(),
    user: isUser() ? { username: readSaved<{ username?: string }>(PROFILE, {}).username ?? null } : null,
    store: backendName(),
    explorer: EXPLORER,
    wallet: walletAddress() ?? null,
    balance: await tokenBalance().catch(() => 'unavailable'),
    policy: policy(),
    spentToday: spentToday(entries),
    payees: listPayees(),
    pending: listPending().map(p => {
      const expiresAt = new Date(new Date(p.createdAt).getTime() + APPROVAL_TTL_MS).toISOString()
      return p.kind === 'pay'
        ? { id: p.id, kind: p.kind, module: p.req.module, amountUsd: p.req.amountUsd, label: p.req.memo, to: p.req.to, createdAt: p.createdAt, expiresAt }
        : { id: p.id, kind: p.kind, module: p.trade.module, amountUsd: p.trade.amountUsd, label: `${p.trade.side === 'buy' ? 'Buy' : 'Sell'} ${p.trade.symbol}`, to: '', createdAt: p.createdAt, expiresAt }
    }),
    portfolio: await portfolioView().catch(e => ({ error: (e as Error).message })),
    plans: listPlans(),
    ledger: entries.slice(-200).reverse()
  }
}

// Everything is same-origin: no inline scripts or styles, no third-party hosts.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

function baseHeaders(type: string, cache: string): Record<string, string> {
  return { 'content-type': type, 'cache-control': cache, 'x-content-type-options': 'nosniff', 'content-security-policy': CSP, 'referrer-policy': 'no-referrer' }
}

function send(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, baseHeaders('application/json; charset=utf-8', 'no-store'))
  res.end(JSON.stringify(body))
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
}

/** Serve a file from web/. Refuses anything that resolves outside that folder or has an unknown extension. */
function serveStatic(res: ServerResponse, urlPath: string): boolean {
  const map: Record<string, string> = { '/': 'index.html', '/app': 'app.html', '/app/': 'app.html', '/login': 'login.html', '/me': 'app.html', '/account': 'account.html' }
  const rel = map[urlPath] ?? decodeURIComponent(urlPath).replace(/^\/+/, '')
  const file = resolve(WEB, rel)
  const inside = relative(WEB, file)
  if (inside.startsWith('..') || isAbsolute(inside) || !TYPES[extname(file)]) return false
  if (!existsSync(file) || !statSync(file).isFile()) return false
  const ext = extname(file)
  res.writeHead(200, baseHeaders(TYPES[ext], ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache'))
  res.end(readFileSync(join(WEB, inside)))
  return true
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  // Vercel parses JSON bodies before our code runs and exposes them as req.body (reading the stream would find it empty).
  const parsed = (req as { body?: unknown }).body
  if (parsed !== undefined && parsed !== null) {
    if (Buffer.isBuffer(parsed)) return JSON.parse(parsed.toString('utf8') || '{}')
    if (typeof parsed === 'string') return JSON.parse(parsed || '{}')
    return parsed
  }
  let size = 0
  const chunks: Buffer[] = []
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > 10_000) throw new Error('Body too large')
    chunks.push(c as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

async function login(req: IncomingMessage, res: ServerResponse, secure: boolean) {
  const problem = authConfigProblem()
  if (problem) return send(res, 503, { error: problem })
  if (!authRequired()) return send(res, 200, { ok: true }) // nothing to sign in to
  if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'JSON only' })
  if (!sameOrigin(req)) return send(res, 403, { error: 'Cross-site request refused' })
  if (!(await withinRateLimit('login:' + clientId(req), 8, 60))) return send(res, 429, { error: 'Too many attempts. Wait a minute and try again.' })
  const body = (await readJson(req)) as { password?: unknown }
  if (!checkPassword(body.password)) {
    await new Promise(r => setTimeout(r, 400)) // slows down guessing
    return send(res, 401, { error: 'Wrong password.' })
  }
  res.setHeader('set-cookie', sessionCookie(makeToken(), secure))
  send(res, 200, { ok: true })
}

/**
 * Scheduled trigger (Vercel Cron, or any pinger) that runs due DCA plans and checks the portfolio for drift.
 * Needs `Authorization: Bearer CRON_SECRET`.
 */
async function cron(req: IncomingMessage, res: ServerResponse) {
  if (!cronAuthorized(req)) return send(res, 401, { error: 'Unauthorized' })
  const { dca, rebalance } = await withStore(async () => {
    const dca = await runDue()
    let rebalance: Awaited<ReturnType<typeof runRebalanceIfDue>> = null
    try {
      rebalance = await runRebalanceIfDue()
    } catch (err) {
      rebalance = { message: `Rebalance check failed: ${(err as Error).message}`, results: [] }
    }
    return { dca, rebalance }
  }, { lock: true })
  send(res, 200, {
    ran: dca.length,
    results: dca.map(r => ({ symbol: r.symbol, outcome: r.outcome })),
    rebalance: rebalance ? { message: rebalance.message, trades: rebalance.results.length } : null
  })
}

const RESEARCH_MAX_PER_DAY = Number(process.env.RESEARCH_MAX_PER_DAY) || 100

async function route(req: IncomingMessage, res: ServerResponse, method: string, path: string, url: URL) {
  if (method === 'GET' && path === '/api/state') return send(res, 200, await state())
  if (method === 'GET' && path === '/api/wallet') return send(res, 200, await walletBalances(url.searchParams.get('account') ?? ''))
  if (method === 'GET' && path === '/api/research') {
    const symbol = (url.searchParams.get('symbol') ?? '').trim()
    if (!symbol) return send(res, 400, { error: 'Symbol is required.' })
    const key = 'research:' + (currentTenant()?.id ?? 'owner')
    if (!(await withinRateLimit(key, RESEARCH_MAX_PER_DAY, 86400))) return send(res, 429, { error: 'Research lookups are limited per day. Try again tomorrow.' })
    return send(res, 200, await researchAsset(symbol))
  }

  if (method === 'POST') {
    if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'JSON only' })
    const raw = await readJson(req)
    switch (path) {
      case '/api/dca': {
        const b = bodies.dca.parse(raw)
        return send(res, 200, createPlan(b.symbol, b.amountUsd, b.intervalHours))
      }
      case '/api/dca/run':
        return send(res, 200, await runDue())
      case '/api/dca/cancel':
        return send(res, 200, { ok: cancelPlan(bodies.cancel.parse(raw).id) })
      case '/api/payee': {
        const b = bodies.payee.parse(raw)
        addPayee(b.address, b.label)
        return send(res, 200, { ok: true })
      }
      case '/api/pay': {
        const b = bodies.pay.parse(raw)
        return send(res, 200, await pay({ module: b.module, to: b.to, amountUsd: b.amountUsd, memo: b.memo || 'Manual payment' }))
      }
      case '/api/portfolio/targets': {
        const b = bodies.targets.parse(raw)
        return send(res, 200, setTargets(b.targets, b.driftThresholdPct))
      }
      case '/api/portfolio/rebalance':
        return send(res, 200, await runRebalance())
      case '/api/approve':
        return send(res, 200, await approveAny(bodies.id.parse(raw).id))
      case '/api/wallet/prepare': {
        const b = bodies.prepare.parse(raw)
        return send(res, 200, await prepareSigned(b.id, b.account))
      }
      case '/api/wallet/complete': {
        const b = bodies.complete.parse(raw)
        return send(res, 200, await completeSigned(b.id, b.account, b.hashes))
      }
      case '/api/reject':
        return send(res, 200, rejectAny(bodies.id.parse(raw).id))
      case '/api/account/wallet': {
        if (!isUser()) return send(res, 403, { error: 'Only for accounts.' })
        const b = bodies.linkWallet.parse(raw)
        writeJson(PROFILE, { ...readSaved<Record<string, unknown>>(PROFILE, {}), wallet: getAddress(b.address) })
        return send(res, 200, { ok: true })
      }
    }
  }
  send(res, 404, { error: 'Not found' })
}

/** Sign up: a username and password, plus an acknowledgement that real funds are involved. */
async function signup(req: IncomingMessage, res: ServerResponse, secure: boolean) {
  if (!usersEnabled()) return send(res, 404, { error: 'Accounts are not switched on for this site.' })
  if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'JSON only' })
  if (!sameOrigin(req)) return send(res, 403, { error: 'Cross-site request refused' })
  // Check the form first: a typo should not use up the sign-up allowance. Only well-formed attempts are counted.
  const b = bodies.signup.parse(await readJson(req))
  validatePassword(b.password, validateUsername(b.username))
  const allowed = await signupAllowed(clientId(req))
  if (!allowed.ok) return send(res, 429, { error: allowed.message })
  const { id, username } = await createAccount(b.username, b.password)
  await withStore(async () => writeJson(PROFILE, { username, acceptedAt: new Date().toISOString() }), { lock: true, tenant: { kind: 'user', id } })
  res.setHeader('set-cookie', userCookie(makeUserToken(id), secure))
  send(res, 200, { ok: true })
}

async function signin(req: IncomingMessage, res: ServerResponse, secure: boolean) {
  if (!usersEnabled()) return send(res, 404, { error: 'Accounts are not switched on for this site.' })
  if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'JSON only' })
  if (!sameOrigin(req)) return send(res, 403, { error: 'Cross-site request refused' })
  const b = bodies.signin.parse(await readJson(req))
  if (!(await loginAllowed(clientId(req), b.username))) return send(res, 429, { error: 'Too many attempts. Wait a few minutes and try again.' })
  const who = await checkLogin(b.username, b.password)
  if (!who) {
    await new Promise(r => setTimeout(r, 300))
    return send(res, 401, { error: 'Wrong username or password.' })
  }
  res.setHeader('set-cookie', userCookie(makeUserToken(who.id), secure))
  send(res, 200, { ok: true })
}

/** Delete an account and all of its saved data. Needs the password again. */
async function deleteAccount(req: IncomingMessage, res: ServerResponse, tenant: { kind: 'user'; id: string }, secure: boolean) {
  if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'JSON only' })
  const { password } = bodies.confirm.parse(await readJson(req))
  const profile = await withStore(async () => readSaved<{ username?: string }>(PROFILE, {}), { tenant })
  const who = profile.username ? await checkLogin(profile.username, password) : null
  if (!who || who.id !== tenant.id) return send(res, 403, { error: 'Wrong password.' })
  await removeAccount(who.username, tenant.id)
  res.setHeader('set-cookie', clearedUserCookie(secure))
  send(res, 200, { ok: true })
}

/** A signed-in account: private data, its own wallet signs everything, no server-side keys, only the calls below. */
async function userRoute(req: IncomingMessage, res: ServerResponse, method: string, path: string, url: URL, secure: boolean) {
  if (!usersEnabled()) return send(res, 404, { error: 'Accounts are not switched on for this site.' })
  const id = userIdFrom(req)
  if (!id) return send(res, 401, { error: 'Sign in first.', code: 'signin_required' })
  if (method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'Cross-site request refused' })
  const tenant = { kind: 'user' as const, id }
  if (method === 'POST' && path === '/api/account/delete') return await deleteAccount(req, res, tenant, secure)
  if (!USER_ALLOWED.has(`${method} ${path}`)) return send(res, 403, { error: 'That is not available for accounts.' })
  if ((method === 'POST' || path === '/api/wallet') && !(await withinRateLimit('acct-act:' + id, USER_LIMITS.actionsPerDay, 86400))) return send(res, 429, { error: 'Daily action limit reached. Try again tomorrow.' })
  return await withStore(
    async () => {
      // The session token is stateless, so a deleted account's cookie must stop working: no profile means no account.
      if (!readSaved<{ username?: string }>(PROFILE, {}).username) {
        res.setHeader('set-cookie', clearedUserCookie(secure))
        return send(res, 401, { error: 'Sign in first.', code: 'signin_required' })
      }
      return route(req, res, method, path, url)
    },
    { lock: method !== 'GET', tenant }
  )
}

export interface HandleOptions {
  /** Serve web/ files (the local server does; on Vercel the platform serves them). */
  serveFiles: boolean
  /** Local only: refuse requests whose Host header is not one of these (DNS-rebinding guard). */
  allowedHosts?: Set<string>
}

/** One request handler for both the local server and the Vercel function. */
export async function handleRequest(req: IncomingMessage, res: ServerResponse, opts: HandleOptions): Promise<void> {
  try {
    if (opts.allowedHosts && !opts.allowedHosts.has(req.headers.host ?? '')) return send(res, 403, { error: 'Forbidden host' })
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname
    const method = req.method ?? 'GET'
    const secure = hosted() || req.headers['x-forwarded-proto'] === 'https'
    const userMode = req.headers['x-ledgerly-mode'] === 'user'

    // Public endpoints
    if (method === 'GET' && path === '/api/health') return send(res, 200, { ok: true })
    if (method === 'GET' && path === '/api/session') {
      if (userMode) {
        const uid = usersEnabled() ? userIdFrom(req) : null
        const active = uid ? await withStore(async () => Boolean(readSaved<{ username?: string }>(PROFILE, {}).username), { tenant: { kind: 'user', id: uid } }) : false
        if (uid && !active) res.setHeader('set-cookie', clearedUserCookie(secure))
        return send(res, 200, { user: { enabled: usersEnabled(), active } })
      }
      return send(res, 200, { authRequired: authRequired(), authed: !authRequired() || isAuthed(req), accountsEnabled: usersEnabled() })
    }
    if (method === 'POST' && path === '/api/signup') return await signup(req, res, secure)
    if (method === 'POST' && path === '/api/signin') return await signin(req, res, secure)
    if (method === 'POST' && path === '/api/signout') {
      res.setHeader('set-cookie', clearedUserCookie(secure))
      return send(res, 200, { ok: true })
    }
    if (method === 'POST' && path === '/api/login') return await login(req, res, secure)
    if (method === 'POST' && path === '/api/logout') {
      res.setHeader('set-cookie', clearedCookie(secure))
      return send(res, 200, { ok: true })
    }
    if (path === '/api/cron') return await cron(req, res)

    if (method === 'GET' && !path.startsWith('/api/') && opts.serveFiles && serveStatic(res, path)) return
    if (!path.startsWith('/api/')) return send(res, 404, { error: 'Not found' })

    if (userMode) return await userRoute(req, res, method, path, url, secure)

    // Everything else is behind the login. Hosted mode fails closed if the password is missing or weak.
    const problem = authConfigProblem()
    if (problem) return send(res, 503, { error: problem })
    if (authRequired()) {
      if (!isAuthed(req)) return send(res, 401, { error: 'Sign in required' })
      if (method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'Cross-site request refused' })
    }
    return await withStore(() => route(req, res, method, path, url), { lock: method !== 'GET' })
  } catch (err) {
    if (res.headersSent) return void res.end()
    const msg = err instanceof z.ZodError ? err.issues.map(i => i.message).join('; ') : (err as Error).message
    send(res, 400, { error: msg })
  }
}

export function startDashboard(port = Number(process.env.DASHBOARD_PORT) || 3000) {
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`])
  const server = createServer((req, res) => void handleRequest(req, res, { serveFiles: true, allowedHosts }))

  server.listen(port, '127.0.0.1', () => {
    console.log(`Ledgerly dashboard: http://localhost:${port}`)
    if (authRequired()) console.log('Login is on (DASHBOARD_PASSWORD is set).')
    if (tradingOffReason) console.warn(`Trading is OFF: ${tradingOffReason}`)
    else console.warn(`LIVE on ${config.network}: transactions use real funds.`)
  })
  return server
}
