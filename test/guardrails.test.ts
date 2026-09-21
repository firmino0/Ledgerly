import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluate } from '../src/guardrails.js'

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
