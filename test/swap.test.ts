import assert from 'node:assert/strict'
import { test } from 'node:test'
import { minOut, pickBest } from '../src/swap.js'

const t = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n // n tokens at 18 decimals

test('pickBest chooses the highest output among sane quotes', () => {
  const r = pickBest([{ fee: 500, amountOut: t(0.0451) }, { fee: 3000, amountOut: t(0.0450) }], 10, 222)
  assert.equal(r?.fee, 500)
})
test('pickBest rejects an empty-pool quote with an absurd price', () => {
  const r = pickBest([{ fee: 100, amountOut: 493458173394n }, { fee: 3000, amountOut: t(0.0450) }], 10, 222)
  assert.equal(r?.fee, 3000)
})
test('pickBest rejects a suspiciously good quote (too cheap vs reference)', () => {
  assert.equal(pickBest([{ fee: 500, amountOut: t(0.09) }], 10, 222), null)
})
test('pickBest returns null when nothing is sane or nothing quoted', () => {
  assert.equal(pickBest([], 10, 222), null)
  assert.equal(pickBest([{ fee: 500, amountOut: 0n }], 10, 222), null)
})
test('minOut applies slippage in basis points', () => {
  assert.equal(minOut(10_000n, 50), 9_950n)
  assert.equal(minOut(10_000n, 100), 9_900n)
})
