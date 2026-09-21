import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { APPROVAL_TTL_MS, listPending } from './approvals.js'
import { approveAny, rejectAny } from './approve.js'
import { tokenBalance, walletAddress } from './chain.js'
import { config, liveBlockedReason } from './config.js'
import { cancelPlan, createPlan, listPlans, runDue } from './dca.js'
import { readAll, spentToday } from './ledger.js'
import { getPaper, resetPaper } from './paper.js'
import { portfolioView, runRebalance, setTargets } from './portfolio.js'
import { bumpVersion } from './store.js'
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
  paper: z.object({ cashUsd: z.number().min(0).max(1_000_000) }),
  prepare: z.object({ id: z.string(), account: z.string() }),
  complete: z.object({ id: z.string(), account: z.string(), hashes: z.array(z.string()).min(1).max(3) })
}

const EXPLORER = config.network === 'mainnet' ? 'https://robinhoodchain.blockscout.com/tx/' : 'https://explorer.testnet.chain.robinhood.com/tx/'

async function state() {
  const entries = readAll()
  return {
    network: config.network,
    dryRun: config.dryRun,
    liveBlocked: liveBlockedReason,
    signing: signingAvailable(),
    explorer: EXPLORER,
    wallet: walletAddress() ?? null,
    balance: await tokenBalance().catch(() => 'unavailable'),
    policy: config.policy,
    spentToday: spentToday(entries),
    payees: listPayees(),
    pending: listPending().map(p => {
      const expiresAt = new Date(new Date(p.createdAt).getTime() + APPROVAL_TTL_MS).toISOString()
      return p.kind === 'pay'
        ? { id: p.id, kind: p.kind, module: p.req.module, amountUsd: p.req.amountUsd, label: p.req.memo, to: p.req.to, createdAt: p.createdAt, expiresAt }
        : { id: p.id, kind: p.kind, module: p.trade.module, amountUsd: p.trade.amountUsd, label: `${p.trade.side === 'buy' ? 'Buy' : 'Sell'} ${p.trade.symbol}`, to: '', createdAt: p.createdAt, expiresAt }
    }),
    paper: getPaper(),
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
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
}

/** Serve a file from web/. Refuses anything that resolves outside that folder or has an unknown extension. */
function serveStatic(res: ServerResponse, urlPath: string): boolean {
  const map: Record<string, string> = { '/': 'index.html', '/app': 'app.html', '/app/': 'app.html' }
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
  let size = 0
  const chunks: Buffer[] = []
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > 10_000) throw new Error('Body too large')
    chunks.push(c as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

export function startDashboard(port = Number(process.env.DASHBOARD_PORT) || 3000) {
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`])

  const server = createServer(async (req, res) => {
    try {
      // Guards against DNS rebinding and cross-site requests: this UI can move money.
      if (!allowedHosts.has(req.headers.host ?? '')) return send(res, 403, { error: 'Forbidden host' })
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, await state())
      if (req.method === 'GET' && url.pathname === '/api/wallet') return send(res, 200, await walletBalances(url.searchParams.get('account') ?? ''))
      if (req.method === 'GET' && !url.pathname.startsWith('/api/') && serveStatic(res, url.pathname)) return

      if (req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'JSON only' })
        const raw = await readJson(req)
        switch (url.pathname) {
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
          case '/api/paper/reset': {
            const p = resetPaper(bodies.paper.parse(raw).cashUsd)
            bumpVersion()
            return send(res, 200, p)
          }
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
        }
      }
      send(res, 404, { error: 'Not found' })
    } catch (err) {
      const msg = err instanceof z.ZodError ? err.issues.map(i => i.message).join('; ') : (err as Error).message
      send(res, 400, { error: msg })
    }
  })

  server.listen(port, '127.0.0.1', () => {
    console.log(`Ledgerly dashboard: http://localhost:${port}`)
    if (liveBlockedReason) console.warn(`WARNING: ${liveBlockedReason}`)
    else if (!config.dryRun) console.warn(`LIVE MODE on ${config.network}: transactions will use real funds.`)
  })
  return server
}
