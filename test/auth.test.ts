import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { afterEach, beforeEach, test } from 'node:test'
import { authConfigProblem, checkPassword, cronAuthorized, makeToken, parseCookies, safeEqual, sameOrigin, verifyToken } from '../src/auth.js'

const saved = { ...process.env }
beforeEach(() => {
  process.env.DASHBOARD_PASSWORD = 'correct horse battery staple'
  process.env.AUTH_SECRET = 'test-secret-value'
  delete process.env.VERCEL
  delete process.env.CRON_SECRET
})
afterEach(() => {
  for (const k of ['DASHBOARD_PASSWORD', 'AUTH_SECRET', 'VERCEL', 'CRON_SECRET']) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})
const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage

test('password check accepts only the exact password', () => {
  assert.equal(checkPassword('correct horse battery staple'), true)
  for (const bad of ['', 'correct horse battery stapl', 'CORRECT HORSE BATTERY STAPLE', null, undefined, 42]) assert.equal(checkPassword(bad), false)
})

test('a login is impossible when no password is configured', () => {
  delete process.env.DASHBOARD_PASSWORD
  assert.equal(checkPassword('anything'), false)
})

test('a fresh token verifies; an expired one does not', () => {
  const now = Date.now()
  assert.equal(verifyToken(makeToken(now), now + 1000), true)
  assert.equal(verifyToken(makeToken(now), now + 13 * 3600 * 1000), false)
})

test('a tampered or foreign token is rejected', () => {
  const t = makeToken()
  const [exp, sig] = t.split('.')
  assert.equal(verifyToken(`${Number(exp) + 999999}.${sig}`), false)
  assert.equal(verifyToken(`${exp}.${sig.slice(0, -2)}xx`), false)
  process.env.AUTH_SECRET = 'a-different-secret'
  assert.equal(verifyToken(t), false)
})

test('malformed tokens never verify', () => {
  for (const bad of [undefined, '', 'abc', '123', '123.', '.abc', 'x.y', '12.3.4']) assert.equal(verifyToken(bad), false)
})

test('cookies are parsed', () => {
  assert.deepEqual(parseCookies('a=1; ledgerly_session=abc.def; b=x%20y'), { a: '1', ledgerly_session: 'abc.def', b: 'x y' })
  assert.deepEqual(parseCookies(undefined), {})
})

test('cron needs the exact bearer secret and fails closed without one', () => {
  assert.equal(cronAuthorized(req({ authorization: 'Bearer nope' })), false)
  process.env.CRON_SECRET = 'cron-secret-1234567890'
  assert.equal(cronAuthorized(req({ authorization: 'Bearer cron-secret-1234567890' })), true)
  assert.equal(cronAuthorized(req({ authorization: 'Bearer wrong' })), false)
  assert.equal(cronAuthorized(req({})), false)
})

test('hosted mode refuses to run without a strong password', () => {
  process.env.VERCEL = '1'
  delete process.env.DASHBOARD_PASSWORD
  assert.match(authConfigProblem() ?? '', /DASHBOARD_PASSWORD/)
  process.env.DASHBOARD_PASSWORD = 'short'
  assert.match(authConfigProblem() ?? '', /too short/)
  process.env.DASHBOARD_PASSWORD = 'a-long-random-password-1234'
  assert.equal(authConfigProblem(), null)
  delete process.env.VERCEL
  delete process.env.DASHBOARD_PASSWORD
  assert.equal(authConfigProblem(), null)
})

test('same-origin check blocks other sites', () => {
  assert.equal(sameOrigin(req({ origin: 'https://app.example', host: 'app.example' })), true)
  assert.equal(sameOrigin(req({ origin: 'https://evil.example', host: 'app.example' })), false)
  assert.equal(sameOrigin(req({ origin: 'not a url', host: 'app.example' })), false)
  assert.equal(sameOrigin(req({ 'sec-fetch-site': 'cross-site', host: 'app.example' })), false)
  assert.equal(sameOrigin(req({ 'sec-fetch-site': 'same-origin', host: 'app.example' })), true)
})

test('safeEqual compares by value', () => {
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('abc', 'abd'), false)
  assert.equal(safeEqual('abc', 'abcd'), false)
})
