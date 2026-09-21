import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type DcaPlan, isDue, parseDecision } from '../src/dca.js'
import { parseQuote } from '../src/market.js'

const plan = (over: Partial<DcaPlan> = {}): DcaPlan => ({
  id: 'p1', symbol: 'NVDA', amountUsd: 10, intervalHours: 24,
  createdAt: '2026-09-01T00:00:00Z', lastRunAt: null, active: true, ...over
})

test('parseDecision clamps multiplier into 0.5-1.5', () => {
  assert.equal(parseDecision('{"action":"buy","multiplier":9,"why":"x"}').multiplier, 1.5)
  assert.equal(parseDecision('{"action":"buy","multiplier":0.01,"why":"x"}').multiplier, 0.5)
})
test('parseDecision reads JSON wrapped in prose', () => {
  const d = parseDecision('Sure! {"action":"skip","multiplier":1,"why":"halt risk"} done')
  assert.equal(d.action, 'skip')
  assert.equal(d.source, 'serv')
})
test('parseDecision falls back to a normal buy on garbage or null', () => {
  for (const t of [null, '', 'no json here', '{bad json}']) {
    const d = parseDecision(t)
    assert.equal(d.action, 'buy')
    assert.equal(d.multiplier, 1)
    assert.equal(d.source, 'default')
  }
})
test('parseDecision accepts "reason" as an alias for "why"', () => {
  assert.equal(parseDecision('{"action":"buy","multiplier":0.5,"reason":"near the top"}').why, 'near the top')
})
test('unknown action never becomes skip by accident', () => {
  assert.equal(parseDecision('{"action":"sell","multiplier":1,"why":"x"}').action, 'buy')
})
test('isDue: first run, interval elapsed, not yet, inactive', () => {
  const now = new Date('2026-09-20T12:00:00Z')
  assert.equal(isDue(plan(), now), true)
  assert.equal(isDue(plan({ lastRunAt: '2026-09-19T11:00:00Z' }), now), true)
  assert.equal(isDue(plan({ lastRunAt: '2026-09-20T00:00:00Z' }), now), false)
  assert.equal(isDue(plan({ active: false }), now), false)
})
test('parseQuote reads a real-shaped response', () => {
  const q = parseQuote('NVDA', {
    quotes: [{ tokenSymbol: 'NVDA', bid: '222.48', ask: '223', dailyHigh: '222.73', dailyLow: '218.04', isTradingHalt: false,
      deployments: [{ contractAddress: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', chainId: 4663 }] }]
  })
  assert.equal(q.ask, 223)
  assert.equal(q.halted, false)
  assert.equal(q.contract, '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC')
})
test('parseQuote rejects empty or invalid data', () => {
  assert.throws(() => parseQuote('X', { quotes: [] }))
  assert.throws(() => parseQuote('X', { quotes: [{ bid: '0', ask: 'abc' }] }))
})
