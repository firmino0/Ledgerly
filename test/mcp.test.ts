import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isReadOnlyTool } from '../src/robinhoodMcp.js'

test('read verbs are allowed', () => {
  for (const n of ['get_portfolio', 'list_positions', 'getBuyingPower', 'get_order_history', 'search_instruments', 'view-watchlist']) {
    assert.equal(isReadOnlyTool(n), true, n)
  }
})
test('anything that acts is refused', () => {
  for (const n of ['place_order', 'create_order', 'cancel_order', 'submit_trade', 'transfer_funds', 'buy_crypto', 'sell_stock', 'withdraw', 'set_alert', 'stake_eth']) {
    assert.equal(isReadOnlyTool(n), false, n)
  }
})
test('a read verb cannot smuggle in an action word', () => {
  for (const n of ['get_and_place_order', 'list_then_cancel', 'getAndSell', 'fetch_transfer_execute']) {
    assert.equal(isReadOnlyTool(n), false, n)
  }
})
test('unknown or empty names are refused', () => {
  for (const n of ['', 'portfolio', 'do_thing', '___']) assert.equal(isReadOnlyTool(n), false, n)
})
