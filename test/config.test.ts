import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tradingOffReasonFor } from '../src/config.js'

test('trading is on only for mainnet with LIVE_MAINNET=yes', () => {
  assert.equal(tradingOffReasonFor({ NETWORK: 'mainnet', LIVE_MAINNET: 'yes' }), null)
})

test('trading stays off, and refuses rather than simulates, when a switch is missing', () => {
  assert.ok(tradingOffReasonFor({ NETWORK: 'mainnet' }))
  assert.ok(tradingOffReasonFor({ NETWORK: 'testnet', LIVE_MAINNET: 'yes' }))
  assert.ok(tradingOffReasonFor({ NETWORK: 'mainnet', LIVE_MAINNET: 'yes', DRY_RUN: 'true' }))
})
