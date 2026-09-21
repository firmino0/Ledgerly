import { randomUUID } from 'node:crypto'
import { dataPath, readJson, writeJson } from './store.js'

export interface PayRequest {
  module: 'payroll' | 'bills'
  to: string
  amountUsd: number
  memo: string
}

export interface TradeRequest {
  side: 'buy' | 'sell'
  symbol: string
  amountUsd: number
  module: 'dca' | 'rebalance'
  why: string
}

export type Pending = { id: string; createdAt: string } & (
  | { kind: 'pay'; req: PayRequest }
  | { kind: 'trade'; trade: TradeRequest }
)

interface State {
  payees: Record<string, string> // lowercase address -> label
  pending: Pending[]
}

/** A held action goes stale: prices move, so an old approval must not fire hours later. */
export const APPROVAL_TTL_MS = 24 * 3_600_000

const FILE = dataPath('state.json')
const load = (): State => {
  const s = readJson<Partial<State>>(FILE, {})
  return { payees: s.payees ?? {}, pending: s.pending ?? [] }
}
const save = (s: State) => writeJson(FILE, s)

// ---------- payees ----------
export function addPayee(address: string, label: string): void {
  const s = load()
  s.payees[address.toLowerCase()] = label
  save(s)
}
export const listPayees = () => Object.entries(load().payees).map(([address, label]) => ({ address, label }))
export const payeeSet = (): Set<string> => new Set(Object.keys(load().payees))

// ---------- pending approvals ----------
export const isExpired = (p: Pending, now = Date.now()) => now - new Date(p.createdAt).getTime() > APPROVAL_TTL_MS

export function addPending(item: { kind: 'pay'; req: PayRequest } | { kind: 'trade'; trade: TradeRequest }): Pending {
  const s = load()
  const p = { id: randomUUID().slice(0, 8), createdAt: new Date().toISOString(), ...item } as Pending
  s.pending.push(p)
  save(s)
  return p
}

/** Live (non-expired) approvals. Expired ones are pruned as a side effect. */
export function listPending(): Pending[] {
  const s = load()
  const live = s.pending.filter(p => !isExpired(p))
  if (live.length !== s.pending.length) save({ ...s, pending: live })
  return live
}

/** Look at a pending item without consuming it. Undefined if it doesn't exist or has expired. */
export function getPending(id: string): Pending | undefined {
  const p = load().pending.find(x => x.id === id)
  return p && !isExpired(p) ? p : undefined
}

/** Remove and return a pending item, or undefined if it doesn't exist or has expired. */
export function takePending(id: string): Pending | undefined {
  const s = load()
  const p = s.pending.find(x => x.id === id)
  if (!p) return undefined
  save({ ...s, pending: s.pending.filter(x => x.id !== id) })
  return isExpired(p) ? undefined : p
}
