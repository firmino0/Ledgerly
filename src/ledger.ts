import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dataPath } from './store.js'

export interface LedgerEntry {
  ts: string
  module: 'payroll' | 'bills' | 'dca' | 'rebalance' | 'system'
  action: string
  amountUsd?: number
  to?: string
  verdict: 'allow' | 'needs_approval' | 'deny'
  executed: boolean
  dryRun: boolean
  txHash?: string
  reasoning: string
}

const DEFAULT_FILE = dataPath('ledger.jsonl')

export function record(entry: Omit<LedgerEntry, 'ts'>, file: string = DEFAULT_FILE): LedgerEntry {
  const full: LedgerEntry = { ts: new Date().toISOString(), ...entry }
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(full) + '\n')
  return full
}

export function readAll(file: string = DEFAULT_FILE): LedgerEntry[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as LedgerEntry)
}

/** Executed spend (dry-run included, so demos exercise the caps) for the current UTC day. */
export function spentToday(entries: LedgerEntry[], now = new Date()): number {
  const day = now.toISOString().slice(0, 10)
  return entries.filter(e => e.executed && e.ts.startsWith(day)).reduce((s, e) => s + (e.amountUsd ?? 0), 0)
}
