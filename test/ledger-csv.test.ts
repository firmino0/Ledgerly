import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type LedgerEntry, ledgerToCsv } from '../src/ledger.js'

const base = { ts: '2026-09-25T10:00:00.000Z', module: 'dca', action: 'Buy NVDA', verdict: 'allow', executed: true, reasoning: 'ok' } as LedgerEntry

test('the CSV has a stable header and one row per entry, with outcomes spelled out', () => {
  const csv = ledgerToCsv([
    { ...base, amountUsd: 0.5, txHash: '0xabc', rule: 'Within the caps.' },
    { ...base, executed: false, verdict: 'needs_approval' },
    { ...base, executed: false, verdict: 'deny' },
    { ...base, executed: false, verdict: 'allow' }
  ]).trim().split('\r\n')
  assert.equal(csv[0], 'date,job,action,payee,amount_usd,outcome,transaction_hash,rule,reasoning')
  assert.equal(csv.length, 5)
  assert.match(csv[1], /,0\.5,executed,0xabc,/)
  assert.match(csv[2], /,held,/)
  assert.match(csv[3], /,denied,/)
  assert.match(csv[4], /,no_action,/)
})

test('commas, quotes and line breaks are quoted, and formula-looking text is neutralised', () => {
  const csv = ledgerToCsv([{ ...base, reasoning: 'said "no", then\nstopped', action: '=HYPERLINK("x")' }])
  assert.ok(csv.includes('"said ""no"", then\nstopped"'))
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`))
})

import { actionsInWindow } from '../src/ledger.js'

test('the velocity count only includes real executed actions inside the last 24 hours', () => {
  const now = new Date('2026-09-25T12:00:00.000Z')
  const at = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString()
  const n = actionsInWindow(
    [
      { ...base, ts: at(1), amountUsd: 1 },
      { ...base, ts: at(23), amountUsd: 1 },
      { ...base, ts: at(25), amountUsd: 1 },
      { ...base, ts: at(2), amountUsd: 1, executed: false },
      { ...base, ts: at(3) }
    ],
    now
  )
  assert.equal(n, 2)
})
