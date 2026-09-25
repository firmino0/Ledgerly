import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluate, ruleFor } from '../src/guardrails.js'

const policy = { maxPerTx: 50, maxPerDay: 100, approvalThreshold: 25 }
const ok = '0xabc0000000000000000000000000000000000001'
const allow = new Set([ok])

test('allows small payment to allowlisted payee', () => {
  assert.equal(evaluate(policy, { amountUsd: 10, to: ok }, 0, allow).decision, 'allow')
})
test('denies unknown recipient', () => {
  assert.equal(evaluate(policy, { amountUsd: 10, to: '0xdead' }, 0, allow).decision, 'deny')
})
test('denies over per-tx cap', () => {
  assert.equal(evaluate(policy, { amountUsd: 60, to: ok }, 0, allow).decision, 'deny')
})
test('denies when daily cap would be exceeded', () => {
  assert.equal(evaluate(policy, { amountUsd: 20, to: ok }, 90, allow).decision, 'deny')
})
test('requires approval above threshold', () => {
  assert.equal(evaluate(policy, { amountUsd: 30, to: ok }, 0, allow).decision, 'needs_approval')
})
test('denies zero, negative and NaN amounts', () => {
  for (const a of [0, -5, NaN]) assert.equal(evaluate(policy, { amountUsd: a, to: ok }, 0, allow).decision, 'deny')
})
test('allowlist match is case-insensitive on the caller side', () => {
  assert.equal(evaluate(policy, { amountUsd: 5, to: ok.toUpperCase().replace('0X', '0x') }, 0, allow).decision, 'allow')
})

test('ruleFor gives an explicit label even for allow, and passes deny/needs_approval reasons through unchanged', () => {
  assert.match(ruleFor(evaluate(policy, { amountUsd: 5, to: ok }, 0, allow)), /within/i)
  const denied = evaluate(policy, { amountUsd: 60, to: ok }, 0, allow)
  assert.equal(ruleFor(denied), denied.decision === 'deny' ? denied.reason : undefined)
  const held = evaluate(policy, { amountUsd: 30, to: ok }, 0, allow)
  assert.equal(ruleFor(held), held.decision === 'needs_approval' ? held.reason : undefined)
})

const strict = { ...policy, maxActionsPerDay: 3, payeeCoolingHours: 24 }
const HOUR = 3_600_000

test('a payee added inside the cooling window holds every payment, whatever the amount', () => {
  const v = evaluate(strict, { amountUsd: 1, to: ok }, 0, allow, { payeeAgeMs: 2 * HOUR })
  assert.equal(v.decision, 'needs_approval')
  assert.match(v.decision === 'needs_approval' ? v.reason : '', /added less than 24 hours ago/)
})

test('an established payee, and one added before this was tracked, is not held by cooling', () => {
  assert.equal(evaluate(strict, { amountUsd: 1, to: ok }, 0, allow, { payeeAgeMs: 30 * HOUR }).decision, 'allow')
  assert.equal(evaluate(strict, { amountUsd: 1, to: ok }, 0, allow, { payeeAgeMs: null }).decision, 'allow')
})

test('many small actions hold once the daily count reaches the limit', () => {
  assert.equal(evaluate(strict, { amountUsd: 1, to: ok }, 0, allow, { actionsToday: 2 }).decision, 'allow')
  assert.equal(evaluate(strict, { amountUsd: 1, to: ok }, 0, allow, { actionsToday: 3 }).decision, 'needs_approval')
})

test('velocity and cooling are off when unset, and skipped when a human has already approved', () => {
  assert.equal(evaluate(policy, { amountUsd: 1, to: ok }, 0, allow, { actionsToday: 999, payeeAgeMs: 0 }).decision, 'allow')
  assert.equal(evaluate(strict, { amountUsd: 1, to: ok }, 0, allow, {}).decision, 'allow')
})

test('a hard deny still wins over a hold', () => {
  assert.equal(evaluate(strict, { amountUsd: 60, to: ok }, 0, allow, { payeeAgeMs: 0, actionsToday: 99 }).decision, 'deny')
  assert.equal(evaluate(strict, { amountUsd: 5, to: '0xdead' }, 0, allow, { payeeAgeMs: 0 }).decision, 'deny')
})
