import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dataPath, isRemote, readJson, writeJson } from './store.js'

export interface LedgerEntry {
  ts: string
  module: 'payroll' | 'bills' | 'dca' | 'rebalance' | 'system'
  action: string
  amountUsd?: number
  to?: string
  verdict: 'allow' | 'needs_approval' | 'deny'
  executed: boolean
  /** Only on old entries from when simulation existed. Nothing writes it any more, and it never counts as spend. */
  dryRun?: boolean
  txHash?: string
  reasoning: string
}

// Local files keep the existing one-entry-per-line format. Hosted mode keeps the latest entries as one JSON list.
const DEFAULT_FILE = dataPath('ledger.jsonl')
const REMOTE_KEY = dataPath('ledger.json')
const REMOTE_MAX = 1000

export function record(entry: Omit<LedgerEntry, 'ts'>, file: string = DEFAULT_FILE): LedgerEntry {
  const full: LedgerEntry = { ts: new Date().toISOString(), ...entry }
  if (isRemote() && file === DEFAULT_FILE) {
    writeJson(REMOTE_KEY, [...readJson<LedgerEntry[]>(REMOTE_KEY, []), full].slice(-REMOTE_MAX))
    return full
  }
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(full) + '\n')
  return full
}

export function readAll(file: string = DEFAULT_FILE): LedgerEntry[] {
  if (isRemote() && file === DEFAULT_FILE) return readJson<LedgerEntry[]>(REMOTE_KEY, [])
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as LedgerEntry)
}

/** Real executed spend for the current UTC day. */
export function spentToday(entries: LedgerEntry[], now = new Date()): number {
  const day = now.toISOString().slice(0, 10)
  return entries.filter(e => e.executed && !e.dryRun && e.ts.startsWith(day)).reduce((s, e) => s + (e.amountUsd ?? 0), 0)
}
