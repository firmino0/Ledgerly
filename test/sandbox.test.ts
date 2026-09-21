import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { makeSandboxId, makeSandboxToken, verifySandboxToken } from '../src/auth.js'
import { walletClient } from '../src/chain.js'
import { dryRun, policy, SANDBOX_POLICY } from '../src/mode.js'
import { LIMITS, SANDBOX_ALLOWED, actionAllowed, canStartSandbox, modelBudgetOk, sandboxEnabled } from '../src/sandbox.js'
import { type Backend, dataPath, isSandbox, memoryBackend, readJson, setBackendForTests, withStore, writeJson } from '../src/store.js'

const saved = { ...process.env }
let backend: Backend
let lastTtl: number | undefined

beforeEach(() => {
  process.env.AUTH_SECRET = 'sandbox-test-secret'
  process.env.SANDBOX_ENABLED = 'yes'
  const inner = memoryBackend()
  backend = { ...inner, save: (entries, ttl) => ((lastTtl = ttl), inner.save(entries, ttl)) }
  lastTtl = undefined
  setBackendForTests(backend)
})
afterEach(() => {
  setBackendForTests(null)
  for (const k of ['AUTH_SECRET', 'SANDBOX_ENABLED', 'SANDBOX_MODEL_CALLS_PER_SESSION', 'SANDBOX_MAX_SESSIONS']) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

const write = (v: unknown) => writeJson(dataPath('state.json'), v)
const read = () => readJson<unknown>(dataPath('state.json'), null)

test('a sandbox token verifies only for the id it was made for', () => {
  const id = makeSandboxId()
  assert.equal(verifySandboxToken(makeSandboxToken(id)), id)
  const other = makeSandboxId()
  const [, sig] = makeSandboxToken(id).split('.')
  assert.equal(verifySandboxToken(`${other}.${sig}`), null)
})

test('forged, malformed or re-signed tokens are rejected', () => {
  const id = makeSandboxId()
  for (const bad of [undefined, '', 'abc', `${id}`, `${id}.`, `${id}.xxxx`, 'short.sig', `${id}.a.b`, '../../etc.x']) assert.equal(verifySandboxToken(bad), null)
  const t = makeSandboxToken(id)
  process.env.AUTH_SECRET = 'a-different-secret'
  assert.equal(verifySandboxToken(t), null)
})

test('two sandboxes and the owner never see each other\'s data', async () => {
  await withStore(async () => write({ who: 'owner' }), { lock: true })
  await withStore(async () => write({ who: 'A' }), { lock: true, tenant: { kind: 'sandbox', id: 'aaaaaaaaaaaaaaaaaaaaaa' } })
  await withStore(async () => write({ who: 'B' }), { lock: true, tenant: { kind: 'sandbox', id: 'bbbbbbbbbbbbbbbbbbbbbb' } })
  assert.deepEqual(await withStore(async () => read()), { who: 'owner' })
  assert.deepEqual(await withStore(async () => read(), { tenant: { kind: 'sandbox', id: 'aaaaaaaaaaaaaaaaaaaaaa' } }), { who: 'A' })
  assert.deepEqual(await withStore(async () => read(), { tenant: { kind: 'sandbox', id: 'bbbbbbbbbbbbbbbbbbbbbb' } }), { who: 'B' })
})

test('a fresh sandbox starts empty, whatever the owner has saved', async () => {
  await withStore(async () => write({ secret: 'owner data' }), { lock: true })
  assert.equal(await withStore(async () => read(), { tenant: { kind: 'sandbox', id: 'cccccccccccccccccccccc' } }), null)
})

test('sandbox data expires on its own; the owner\'s does not', async () => {
  await withStore(async () => write({ a: 1 }), { lock: true, tenant: { kind: 'sandbox', id: 'dddddddddddddddddddddd' } })
  assert.ok(lastTtl && lastTtl >= 24 * 3600, 'sandbox writes carry a time limit')
  await withStore(async () => write({ a: 1 }), { lock: true })
  assert.equal(lastTtl, undefined)
})

test('a sandbox is always dry run, uses demo limits, and cannot reach a wallet', async () => {
  await withStore(async () => {
    assert.equal(isSandbox(), true)
    assert.equal(dryRun(), true)
    assert.deepEqual(policy(), SANDBOX_POLICY)
    assert.throws(() => walletClient(), /Only the owner has a server-side wallet/)
  }, { tenant: { kind: 'sandbox', id: 'eeeeeeeeeeeeeeeeeeeeee' } })
  await withStore(async () => {
    assert.equal(isSandbox(), false)
  })
})

test('without the hosted store a sandbox refuses to run rather than share data', async () => {
  setBackendForTests(null)
  await assert.rejects(withStore(async () => 1, { tenant: { kind: 'sandbox', id: 'ffffffffffffffffffffff' } }), /hosted/)
  assert.equal(sandboxEnabled(), false)
})

test('the sandbox is off unless explicitly enabled and configured', () => {
  assert.equal(sandboxEnabled(), true)
  delete process.env.SANDBOX_ENABLED
  assert.equal(sandboxEnabled(), false)
  process.env.SANDBOX_ENABLED = 'yes'
  delete process.env.AUTH_SECRET
  assert.equal(sandboxEnabled(), false)
})

test('the allow-list has nothing that touches a wallet, the schedule or the owner login', () => {
  for (const entry of SANDBOX_ALLOWED) {
    assert.doesNotMatch(entry, /wallet|cron|login|logout|sandbox|prepare|complete/, entry)
  }
  assert.ok(SANDBOX_ALLOWED.has('GET /api/state'))
})

test('model calls are capped per sandbox, then the plain rules take over', async () => {
  process.env.SANDBOX_MODEL_CALLS_PER_SESSION = '3'
  const results: boolean[] = []
  await withStore(async () => {
    for (let i = 0; i < 5; i++) results.push(await modelBudgetOk())
  }, { tenant: { kind: 'sandbox', id: 'gggggggggggggggggggggg' } })
  assert.deepEqual(results, [true, true, true, false, false])
  await withStore(async () => assert.equal(await modelBudgetOk(), true), { tenant: { kind: 'sandbox', id: 'hhhhhhhhhhhhhhhhhhhhhh' } })
  assert.equal(await modelBudgetOk(), true, 'the owner is never limited')
})

test('starting sandboxes is limited per connection and per day', async () => {
  for (let i = 0; i < LIMITS.newPerIpPerHour; i++) assert.deepEqual(await canStartSandbox('1.2.3.4'), { ok: true })
  const blocked = await canStartSandbox('1.2.3.4')
  assert.equal(blocked.ok, false)
  assert.deepEqual(await canStartSandbox('5.6.7.8'), { ok: true })
  process.env.SANDBOX_MAX_SESSIONS = '2'
  setBackendForTests(memoryBackend())
  assert.equal((await canStartSandbox('a')).ok, true)
  assert.equal((await canStartSandbox('b')).ok, true)
  const full = await canStartSandbox('c')
  assert.equal(full.ok, false)
})

test('each sandbox has a daily action cap', async () => {
  const id = 'iiiiiiiiiiiiiiiiiiiiii'
  let allowed = 0
  for (let i = 0; i < LIMITS.actionsPerSessionPerDay + 5; i++) if (await actionAllowed(id)) allowed++
  assert.equal(allowed, LIMITS.actionsPerSessionPerDay)
})

test('empty, short and refusal-style model replies are not treated as explanations', async () => {
  const { usableExplanation } = await import('../src/reasoning.js')
  for (const bad of [null, '', '   ', "I can't share that.", 'I cannot help with that request, sorry about it all.', 'Sorry, I am unable to do this at present time.', 'ok']) assert.equal(usableExplanation(bad), false, String(bad))
  assert.equal(usableExplanation('This payment is allowed: the recipient is on your allowlist and the amount is under the cap.'), true)
})
