import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Saved state. Two modes:
 *  - files (default, local use): JSON files in data/, exactly as before.
 *  - remote (hosted): Upstash Redis. A serverless function has no lasting disk, so each request loads the state it
 *    needs, works on its own private copy, and writes the changes back at the end (under a lock when it mutates).
 *
 * Callers use the same readJson / writeJson / dataPath in both modes.
 */

export interface Backend {
  name: string
  load(keys: string[]): Promise<Record<string, unknown>>
  /** ttlSeconds optionally makes the saved keys expire. */
  save(entries: Record<string, unknown>, ttlSeconds?: number): Promise<void>
  /** Returns a release function, or null if the named lock is taken. */
  lock(name: string, ttlMs: number): Promise<(() => Promise<void>) | null>
  /** Increment a counter that expires after ttlSeconds (used for login rate limiting). */
  incr(key: string, ttlSeconds: number): Promise<number>
  /** Create a key only if it does not exist yet. False if it was already there. */
  create(key: string, value: unknown): Promise<boolean>
  remove(keys: string[]): Promise<void>
}

const PREFIX = 'ledgerly:'
export const STORE_KEYS = ['state.json', 'portfolio.json', 'dca.json', 'ledger.json', 'prepared.json', 'profile.json']

/** In-process backend for tests and for trying hosted mode locally (LEDGERLY_STORE=memory). Not shared between processes. */
export function memoryBackend(): Backend {
  const data = new Map<string, unknown>()
  const counters = new Map<string, { n: number; exp: number }>()
  const locks = new Set<string>()
  return {
    name: 'memory',
    async load(keys) {
      return Object.fromEntries(keys.map(k => [k, data.has(k) ? structuredClone(data.get(k)) : null]))
    },
    async save(entries) {
      for (const [k, v] of Object.entries(entries)) data.set(k, structuredClone(v))
    },
    async lock(name) {
      if (locks.has(name)) return null
      locks.add(name)
      return async () => {
        locks.delete(name)
      }
    },
    async incr(key, ttlSeconds) {
      const now = Date.now()
      const c = counters.get(key)
      if (!c || c.exp < now) {
        counters.set(key, { n: 1, exp: now + ttlSeconds * 1000 })
        return 1
      }
      return ++c.n
    },
    async create(key, value) {
      if (data.has(key)) return false
      data.set(key, structuredClone(value))
      return true
    },
    async remove(keys) {
      for (const k of keys) data.delete(k)
    }
  }
}

const RELEASE_LOCK = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

function upstashBackend(url: string, token: string): Backend {
  let client: Promise<import('@upstash/redis').Redis> | null = null
  const redis = () => (client ??= import('@upstash/redis').then(m => new m.Redis({ url, token })))
  return {
    name: 'upstash',
    async load(keys) {
      const r = await redis()
      const values = await r.mget<unknown[]>(...keys)
      return Object.fromEntries(keys.map((k, i) => [k, values[i] ?? null]))
    },
    async save(entries, ttlSeconds) {
      if (!Object.keys(entries).length) return
      const r = await redis()
      if (!ttlSeconds) return void (await r.mset(entries))
      const p = r.pipeline()
      for (const [k, v] of Object.entries(entries)) p.set(k, v, { ex: ttlSeconds })
      await p.exec()
    },
    async lock(name, ttlMs) {
      const r = await redis()
      const mine = randomUUID()
      const key = PREFIX + 'lock:' + name
      const ok = await r.set(key, mine, { nx: true, px: ttlMs })
      if (ok !== 'OK') return null
      return async () => {
        await r.eval(RELEASE_LOCK, [key], [mine]).catch(() => undefined)
      }
    },
    async incr(key, ttlSeconds) {
      const r = await redis()
      const n = await r.incr(PREFIX + key)
      if (n === 1) await r.expire(PREFIX + key, ttlSeconds)
      return n
    },
    async create(key, value) {
      return (await (await redis()).set(key, value, { nx: true })) === 'OK'
    },
    async remove(keys) {
      if (keys.length) await (await redis()).del(...keys)
    }
  }
}

function pickBackend(): Backend | null {
  if (process.env.LEDGERLY_STORE === 'memory') return memoryBackend()
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN
  return url && token ? upstashBackend(url, token) : null
}

let backend: Backend | null = pickBackend()
export const isRemote = () => backend !== null
export const backendName = () => backend?.name ?? 'files'
/** Tests only: swap the backend. */
export function setBackendForTests(b: Backend | null) {
  backend = b
}

// ---------- per-request context (remote mode) ----------
/** Who a request works for, beyond the owner: a signed-in account. Each gets private data. */
export interface Tenant {
  kind: 'user'
  id: string
}

const tenantPrefix = (t?: Tenant) => PREFIX + (t ? `u:${t.id}:` : '')

interface Ctx {
  cache: Map<string, unknown>
  dirty: Set<string>
  /** Key prefix, so one tenant can never see the owner's data or another tenant's. */
  prefix: string
  tenant?: Tenant
}
const als = new AsyncLocalStorage<Ctx>()

function ctx(): Ctx {
  const c = als.getStore()
  if (!c) throw new Error('Saved state was used outside a request. Wrap the work in withStore().')
  return c
}

export const isUser = () => als.getStore()?.tenant?.kind === 'user'
export const currentTenant = () => als.getStore()?.tenant

async function flush(c: Ctx) {
  if (!backend || !c.dirty.size) return
  const entries: Record<string, unknown> = {}
  for (const k of c.dirty) entries[k] = c.cache.get(k)
  await backend.save(entries)
  c.dirty.clear()
}

async function acquire(name: string): Promise<() => Promise<void>> {
  for (let i = 0; i < 40; i++) {
    const release = await backend!.lock(name, 60_000)
    if (release) return release
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('Another request is still changing the saved state. Try again in a moment.')
}

/**
 * Run `fn` with saved state available. In file mode this just calls `fn`. In remote mode it loads the state, runs `fn`
 * on a private copy, and saves the changes afterwards. Pass `lock: true` for anything that changes state, so two
 * requests cannot overwrite each other.
 */
export async function withStore<T>(fn: () => Promise<T>, opts: { lock?: boolean; tenant?: Tenant } = {}): Promise<T> {
  if (!backend) {
    if (opts.tenant) throw new Error('Accounts need the hosted (Redis) store so each person stays separate.')
    return fn()
  }
  const prefix = tenantPrefix(opts.tenant)
  const release = opts.lock ? await acquire(opts.tenant ? prefix : 'main') : null
  const c: Ctx = { cache: new Map(), dirty: new Set(), prefix, tenant: opts.tenant }
  try {
    const keys = STORE_KEYS.map(k => c.prefix + k)
    const loaded = await backend.load(keys)
    for (const k of keys) if (loaded[k] !== null && loaded[k] !== undefined) c.cache.set(k, loaded[k])
    return await als.run(c, fn)
  } finally {
    try {
      await flush(c)
    } finally {
      if (release) await release()
    }
  }
}

// ---------- file / key helpers ----------
/** In file mode: the path of a file in data/ (or LEDGERLY_DATA_DIR, so tests never touch real data). In remote mode: its key. */
export const dataPath = (name: string) =>
  backend ? PREFIX + name : process.env.LEDGERLY_DATA_DIR ? join(process.env.LEDGERLY_DATA_DIR, name) : fileURLToPath(new URL(`../data/${name}`, import.meta.url))

/** A file path or key from either mode becomes the same remote key in the caller's own namespace. */
const remoteKey = (c: Ctx, file: string) => c.prefix + (file.startsWith(PREFIX) ? file.slice(PREFIX.length) : basename(file))

export function readJson<T>(file: string, fallback: T): T {
  if (backend) {
    const c = ctx()
    const key = remoteKey(c, file)
    return c.cache.has(key) ? (structuredClone(c.cache.get(key)) as T) : fallback
  }
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** File mode writes atomically (temp file + rename) so a crash mid-write never leaves a half-written file. */
export function writeJson(file: string, value: unknown): void {
  if (backend) {
    const c = ctx()
    const key = remoteKey(c, file)
    c.cache.set(key, structuredClone(value))
    c.dirty.add(key)
    return
  }
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, file)
}

// ---------- records outside any tenant (account logins) ----------
function remote() {
  if (!backend) throw new Error('Accounts need the hosted (Redis) store.')
  return backend
}
const rawKey = (name: string) => PREFIX + name
export async function rawGet<T>(name: string): Promise<T | null> {
  const k = rawKey(name)
  return ((await remote().load([k]))[k] ?? null) as T | null
}
/** Create a record only if the name is free. */
export const rawCreate = (name: string, value: unknown) => remote().create(rawKey(name), value)
export const rawSet = (name: string, value: unknown) => remote().save({ [rawKey(name)]: value })
/** Delete a tenant's private data and any named records. */
export async function rawRemove(names: string[], tenant?: Tenant) {
  const keys = names.map(rawKey)
  if (tenant) keys.push(...STORE_KEYS.map(k => tenantPrefix(tenant) + k))
  await remote().remove(keys)
}

// ---------- rate limiting ----------
const localCounters = new Map<string, { n: number; exp: number }>()

/** True if this call is within the limit. Uses Redis when hosted so the limit holds across serverless instances. */
export async function withinRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  if (backend) return (await backend.incr('rl:' + key, windowSeconds)) <= limit
  const now = Date.now()
  const c = localCounters.get(key)
  if (!c || c.exp < now) {
    localCounters.set(key, { n: 1, exp: now + windowSeconds * 1000 })
    return true
  }
  return ++c.n <= limit
}

/** Bumped whenever balances change (a trade executes), so cached views know to refresh. */
let version = 0
export const bumpVersion = () => ++version
export const getVersion = () => version
