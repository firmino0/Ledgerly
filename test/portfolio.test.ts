import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planRebalance, type PortfolioConfig } from '../src/portfolio.js'

const cfg = (over: Partial<PortfolioConfig> = {}): PortfolioConfig => ({
  targets: { NVDA: 50, AAPL: 30 }, // cash target 20%
  driftThresholdPct: 5,
  minTradeUsd: 1,
  ...over
})

test('all cash: buys every asset up to target', () => {
  const p = planRebalance({}, 1000, cfg())
  assert.deepEqual(p.trades, [
    { side: 'buy', symbol: 'NVDA', amountUsd: 500 },
    { side: 'buy', symbol: 'AAPL', amountUsd: 300 }
  ])
  assert.equal(p.cashTargetPct, 20)
})
test('overweight asset is sold and proceeds fund the underweight one', () => {
  const p = planRebalance({ NVDA: 800, AAPL: 0 }, 200, cfg())
  assert.equal(p.totalUsd, 1000)
  assert.deepEqual(p.trades[0], { side: 'sell', symbol: 'NVDA', amountUsd: 300 })
  assert.deepEqual(p.trades[1], { side: 'buy', symbol: 'AAPL', amountUsd: 300 })
})
test('within the drift threshold: no trades', () => {
  const p = planRebalance({ NVDA: 480, AAPL: 320 }, 200, cfg())
  assert.equal(p.trades.length, 0)
})
test('buys are scaled down when cash is short', () => {
  // total 1000, targets 60/40/0% cash. NVDA 640 is only 4 points over (below the 5-point threshold, so not sold).
  // AAPL 340 is 6 points under and wants a $60 buy, but only $20 cash exists.
  const p = planRebalance({ NVDA: 640, AAPL: 340 }, 20, cfg({ targets: { NVDA: 60, AAPL: 40 } }))
  assert.deepEqual(p.trades, [{ side: 'buy', symbol: 'AAPL', amountUsd: 20 }])
})
test('trades smaller than the minimum are ignored', () => {
  const p = planRebalance({ NVDA: 495, AAPL: 300 }, 205, cfg({ driftThresholdPct: 0.5, minTradeUsd: 10 }))
  assert.equal(p.trades.length, 0)
})
test('empty portfolio and zero cash produces no trades and no NaN', () => {
  const p = planRebalance({}, 0, cfg())
  assert.equal(p.trades.length, 0)
  assert.ok(Number.isFinite(p.totalUsd))
})
