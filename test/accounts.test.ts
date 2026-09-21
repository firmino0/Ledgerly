import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { USER_ALLOWED, USER_POLICY, checkLogin, createAccount, loginAllowed, removeAccount, signupAllowed, usersEnabled, validatePassword, validateUsername } from '../src/accounts.js'
import { makeUserToken, verifyUserToken } from '../src/auth.js'
import { walletAddress, walletClient } from '../src/chain.js'
import { policy } from '../src/mode.js'
import { type Backend, dataPath, isUser, memoryBackend, rawGet, readJson, setBackendForTests, withStore, writeJson } from '../src/store.js'

const saved = { ...process.env }
let lastTtl: number | undefined | null = null

beforeEach(() => {
  process.env.AUTH_SECRET = 'accounts-test-secret'
  process.env.USERS_ENABLED = 'yes'
  const inner = memoryBackend()
  const spy: Backend = { ...inner, save: (entries, ttl) => ((lastTtl = ttl), inner.save(entries, ttl)) }
  lastTtl = null
  setBackendForTests(spy)
})
afterEach(() => {
  setBackendForTests(null)
  for (const k of ['AUTH_SECRET', 'USERS_ENABLED', 'USERS_MAX_SIGNUPS_PER_DAY']) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

test('usernames are normalised and validated', () => {
  assert.equal(validateUsername('  Alice_01 '), 'alice_01')
  for (const bad of ['', 'ab', 'a'.repeat(25), 'has space', 'semi;colon', '../etc', null, 42]) assert.throws(() => validateUsername(bad), /Username/)
})

test('passwords must be long enough and must not contain the username', () => {
  assert.equal(validatePassword('a-long-enough-password', 'alice'), 'a-long-enough-password')
  assert.throws(() => validatePassword('short', 'alice'), /at least 10/)
  assert.throws(() => validatePassword('x'.repeat(129), 'alice'), /at most 128/)
  assert.throws(() => validatePassword('my-alice-password', 'alice'), /username/)
  assert.throws(() => validatePassword(undefined, 'alice'), /at least 10/)
})

test('an account can be created once and logged into with the right password only', async () => {
  const made = await createAccount('Alice', 'correct horse battery')
  assert.equal(made.username, 'alice')
  const ok = await checkLogin('ALICE', 'correct horse battery')
  assert.equal(ok?.id, made.id)
  assert.equal(await checkLogin('alice', 'correct horse batterY'), null)
  assert.equal(await checkLogin('alice', ''), null)
  assert.equal(await checkLogin('nobody', 'correct horse battery'), null)
  await assert.rejects(createAccount('alice', 'another long password'), /taken/)
})

test('the stored record holds a salted hash, never the password', async () => {
  await createAccount('bob', 'a very private phrase')
  const rec = await rawGet<Record<string, string>>('acct:bob')
  assert.ok(rec && rec.hash && rec.salt)
  assert.doesNotMatch(JSON.stringify(rec), /very private phrase/)
  await createAccount('carol', 'a very private phrase')
  const other = await rawGet<Record<string, string>>('acct:carol')
  assert.notEqual(rec.hash, other?.hash, 'same password, different salt, different hash')
})

test('account tokens verify only for the right secret and time', () => {
  const now = Date.now()
  const t = makeUserToken('abcdefgh12345678', now)
  assert.equal(verifyUserToken(t, now + 1000), 'abcdefgh12345678')
  assert.equal(verifyUserToken(t, now + 8 * 24 * 3600 * 1000), null)
  const [id, exp, sig] = t.split('.')
  assert.equal(verifyUserToken(`otheridvalue1234.${exp}.${sig}`, now + 1000), null)
  assert.equal(verifyUserToken(`${id}.${Number(exp) + 100000}.${sig}`, now + 1000), null)
  process.env.AUTH_SECRET = 'a-different-secret'
  assert.equal(verifyUserToken(t, now + 1000), null)
  for (const bad of [undefined, '', 'a', 'a.b', 'a.b.c.d', '../x.1.2']) assert.equal(verifyUserToken(bad), null)
})

test('accounts are off unless enabled and configured', () => {
  assert.equal(usersEnabled(), true)
  delete process.env.USERS_ENABLED
  assert.equal(usersEnabled(), false)
  process.env.USERS_ENABLED = 'yes'
  delete process.env.AUTH_SECRET
  assert.equal(usersEnabled(), false)
})

test('an account has its own private data, permanent, separate from the owner and other accounts', async () => {
  const put = (v: unknown) => writeJson(dataPath('state.json'), v)
  const get = () => readJson<unknown>(dataPath('state.json'), null)
  await withStore(async () => put({ who: 'owner' }), { lock: true })
  await withStore(async () => put({ who: 'ann' }), { lock: true, tenant: { kind: 'user', id: 'user-ann-123456' } })
  assert.equal(lastTtl, undefined, 'account data does not expire')
  await withStore(async () => put({ who: 'ben' }), { lock: true, tenant: { kind: 'user', id: 'user-ben-123456' } })
  assert.deepEqual(await withStore(async () => get()), { who: 'owner' })
  assert.deepEqual(await withStore(async () => get(), { tenant: { kind: 'user', id: 'user-ann-123456' } }), { who: 'ann' })
  assert.deepEqual(await withStore(async () => get(), { tenant: { kind: 'user', id: 'user-ben-123456' } }), { who: 'ben' })
  assert.equal(await withStore(async () => get(), { tenant: { kind: 'user', id: 'user-new-123456' } }), null)
})

test('an account can never reach a server wallet or the owner\'s spending limits', async () => {
  await withStore(async () => {
    assert.equal(isUser(), true)
    assert.equal(policy(), USER_POLICY)
    assert.equal(USER_POLICY.approvalThreshold, 0, 'every action is held for the person to sign')
    assert.throws(() => walletClient(), /Only the owner has a server-side wallet/)
  }, { tenant: { kind: 'user', id: 'user-zed-123456' } })
  await withStore(async () => assert.equal(isUser(), false))
})

test('an account\'s wallet is the address it linked, read-only', async () => {
  const addr = '0x6A66533AF4e2EDD299A097310dF7f8e0935Fb510'
  const tenant = { kind: 'user' as const, id: 'user-wal-123456' }
  await withStore(async () => assert.equal(walletAddress(), undefined), { tenant })
  await withStore(async () => writeJson(dataPath('profile.json'), { username: 'wal', wallet: addr }), { lock: true, tenant })
  await withStore(async () => assert.equal(walletAddress(), addr), { tenant })
  await withStore(async () => assert.notEqual(walletAddress(), addr), { tenant: { kind: 'user', id: 'user-other-12345' } })
})

test('the account allow-list has no cron and no owner, login or delete-account endpoints', () => {
  for (const entry of USER_ALLOWED) assert.doesNotMatch(entry, /cron|login|logout|signup|signin|delete/, entry)
  for (const needed of ['GET /api/state', 'POST /api/wallet/prepare', 'POST /api/wallet/complete', 'POST /api/reject', 'POST /api/account/wallet']) assert.ok(USER_ALLOWED.has(needed), needed)
})

test('deleting an account removes the login and all of its data', async () => {
  const made = await createAccount('dave', 'a long enough password')
  const tenant = { kind: 'user' as const, id: made.id }
  await withStore(async () => writeJson(dataPath('ledger.json'), [{ a: 1 }]), { lock: true, tenant })
  assert.ok(await rawGet('acct:dave'))
  await removeAccount('dave', made.id)
  assert.equal(await rawGet('acct:dave'), null)
  assert.equal(await checkLogin('dave', 'a long enough password'), null)
  assert.deepEqual(await withStore(async () => readJson(dataPath('ledger.json'), []), { tenant }), [])
  await createAccount('dave', 'another long password')
})

test('sign-ups and log-in attempts are rate limited', async () => {
  const results: boolean[] = []
  for (let i = 0; i < 5; i++) results.push((await signupAllowed('9.9.9.9')).ok)
  assert.deepEqual(results, [true, true, true, false, false])
  process.env.USERS_MAX_SIGNUPS_PER_DAY = '2'
  setBackendForTests(memoryBackend())
  assert.equal((await signupAllowed('a')).ok, true)
  assert.equal((await signupAllowed('b')).ok, true)
  assert.equal((await signupAllowed('c')).ok, false)
  const tries: boolean[] = []
  for (let i = 0; i < 10; i++) tries.push(await loginAllowed('1.1.1.1', 'Erin'))
  assert.equal(tries.filter(Boolean).length, 8)
})
