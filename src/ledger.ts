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
  /**
   * The deterministic rule that produced the verdict (a cap, the allowlist, a drift threshold), when one applied.
   * Kept separate from `reasoning` on purpose: this is the auditable fact a human or regulator can point to;
   * `reasoning` is the model's own commentary and is never what decided anything.
   */
  rule?: string
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

export const OUTCOME = (e: LedgerEntry) => (e.executed ? 'executed' : e.verdict === 'deny' ? 'denied' : e.verdict === 'needs_approval' ? 'held' : 'no_action')

/** One CSV cell. Quotes are doubled, and text that a spreadsheet would run as a formula is neutralised with a leading apostrophe. */
const cell = (v: unknown, text = true): string => {
  let s = v == null ? '' : String(v)
  if (text && /^[=+\-@\t\r]/.test(s)) s = "'" + s
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

/** The ledger as CSV, oldest first, with a stable column set for whoever keeps the books. */
export function ledgerToCsv(entries: LedgerEntry[]): string {
  const head = ['date', 'job', 'action', 'payee', 'amount_usd', 'outcome', 'transaction_hash', 'rule', 'reasoning']
  const rows = entries.map(e => [cell(e.ts), cell(e.module), cell(e.action), cell(e.to), cell(e.amountUsd, false), cell(OUTCOME(e)), cell(e.txHash), cell(e.rule), cell(e.reasoning)].join(','))
  return [head.join(','), ...rows].join('\r\n') + '\r\n'
}

/** How many real actions moved money in the last 24 hours, for the velocity rule. */
export function actionsInWindow(entries: LedgerEntry[], now = new Date(), windowMs = 86_400_000): number {
  return entries.filter(e => e.executed && !e.dryRun && e.amountUsd != null && now.getTime() - new Date(e.ts).getTime() < windowMs).length
}

/** Real executed spend for the current UTC day. */
export function spentToday(entries: LedgerEntry[], now = new Date()): number {
  const day = now.toISOString().slice(0, 10)
  return entries.filter(e => e.executed && !e.dryRun && e.ts.startsWith(day)).reduce((s, e) => s + (e.amountUsd ?? 0), 0)
}
