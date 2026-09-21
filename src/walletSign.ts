import { encodeFunctionData, erc20Abi, formatEther, formatUnits, getAddress, isAddress, parseUnits } from 'viem'
import { mainnetClient } from './chain.js'
import { getPending, payeeSet, takePending, type PayRequest, type TradeRequest } from './approvals.js'
import { config } from './config.js'
import { evaluate } from './guardrails.js'
import { type LedgerEntry, readAll, record, spentToday } from './ledger.js'
import { getQuote } from './market.js'
import { ADDR, balanceOf, minOut, quoteBuy, quoteSell, routerAbi } from './swap.js'
import { bumpVersion } from './store.js'

/**
 * "Sign with my wallet": the human's browser wallet signs and sends a held action, so no server-side key is used.
 * The server prepares the exact transactions (after re-checking the guardrails), remembers them, and later verifies
 * that the transaction your wallet sent matches what was prepared before recording anything.
 */
type Address = `0x${string}`
type Hex = `0x${string}`

export interface TxStep {
  label: string
  to: Address
  data: Hex
}

interface Prepared {
  account: Address
  steps: TxStep[]
  expiresAt: number
  entry: Pick<LedgerEntry, 'module' | 'action' | 'amountUsd' | 'to'> & { why: string }
}

export const CHAIN_ID = 4663
const PREPARE_TTL_MS = 10 * 60_000
const prepared = new Map<string, Prepared>()

// ---------- pure transaction builders (unit-tested) ----------
export const approveStep = (token: Address, spender: Address, amount: bigint, label: string): TxStep => ({
  label,
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] })
})

export const transferStep = (token: Address, to: Address, amount: bigint, label: string): TxStep => ({
  label,
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] })
})

export const swapStep = (tokenIn: Address, tokenOut: Address, fee: number, recipient: Address, amountIn: bigint, amountOutMinimum: bigint, label: string): TxStep => ({
  label,
  to: ADDR.swapRouter02,
  data: encodeFunctionData({ abi: routerAbi, functionName: 'exactInputSingle', args: [{ tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96: 0n }] })
})

// ---------- helpers ----------
export const signingAvailable = () => config.network === 'mainnet' && !config.dryRun

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const allowanceOf = (token: Address, owner: Address, spender: Address) =>
  mainnetClient.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] })

export function parseAccount(account: unknown): Address {
  if (typeof account !== 'string' || !isAddress(account)) throw new Error('That is not a valid wallet address.')
  return getAddress(account)
}

/** Read-only balances for the connected wallet, shown in the dashboard. */
export async function walletBalances(account: string) {
  const a = parseAccount(account)
  const [usdg, eth] = await Promise.all([balanceOf(ADDR.usdg, a), mainnetClient.getBalance({ address: a })])
  return { usdg: formatUnits(usdg, 6), eth: formatEther(eth) }
}

function dropExpired() {
  const now = Date.now()
  for (const [id, p] of prepared) if (p.expiresAt < now) prepared.delete(id)
}

// ---------- prepare ----------
async function prepareTrade(t: TradeRequest, account: Address) {
  const verdict = evaluate({ ...config.policy, approvalThreshold: Infinity }, { amountUsd: t.amountUsd }, spentToday(readAll()), new Set())
  if (verdict.decision === 'deny') throw new Error(`Blocked by your rules: ${verdict.reason}`)

  const q = await getQuote(t.symbol)
  if (q.halted) throw new Error(`${t.symbol} trading is halted right now.`)
  if (!q.contract) throw new Error(`${t.symbol} has no Robinhood Chain deployment.`)
  const token = q.contract as Address

  if (t.side === 'buy') {
    const amountIn = parseUnits(t.amountUsd.toString(), 6)
    const [bal, allowed] = await Promise.all([balanceOf(ADDR.usdg, account), allowanceOf(ADDR.usdg, account, ADDR.swapRouter02)])
    if (bal < amountIn) throw new Error(`Your wallet holds ${formatUnits(bal, 6)} USDG, but this buy needs ${t.amountUsd}.`)
    const route = await quoteBuy(token, t.amountUsd, q.ask)
    const steps: TxStep[] = []
    if (allowed < amountIn) steps.push(approveStep(ADDR.usdg, ADDR.swapRouter02, amountIn, 'Approve USDG'))
    steps.push(swapStep(ADDR.usdg, token, route.fee, account, amountIn, minOut(route.amountOut, config.slippageBps), `Buy ${t.symbol}`))
    const detail = `~${route.tokens.toFixed(6)} tokens via ${route.fee / 10_000}% pool @ $${route.impliedPriceUsd.toFixed(2)}`
    return { steps, summary: `Buy $${t.amountUsd} of ${t.symbol}, ${detail}`, action: `Buy ${t.symbol}: ${detail}` }
  }

  const held = await balanceOf(token, account)
  const wanted = parseUnits((t.amountUsd / q.mid).toFixed(18), 18)
  const amountIn = held < wanted ? held : wanted
  if (amountIn <= 0n) throw new Error(`Your wallet holds no ${t.symbol}.`)
  const route = await quoteSell(token, amountIn, q.bid)
  const allowed = await allowanceOf(token, account, ADDR.swapRouter02)
  const steps: TxStep[] = []
  if (allowed < amountIn) steps.push(approveStep(token, ADDR.swapRouter02, amountIn, `Approve ${t.symbol}`))
  steps.push(swapStep(token, ADDR.usdg, route.fee, account, amountIn, minOut(route.amountOut, config.slippageBps), `Sell ${t.symbol}`))
  const detail = `~${formatUnits(amountIn, 18).slice(0, 10)} tokens for ~$${route.usdOut.toFixed(2)} via ${route.fee / 10_000}% pool`
  return { steps, summary: `Sell ${detail}`, action: `Sell ${t.symbol}: ${detail}` }
}

async function preparePayment(req: PayRequest, account: Address) {
  const verdict = evaluate({ ...config.policy, approvalThreshold: Infinity }, req, spentToday(readAll()), payeeSet())
  if (verdict.decision === 'deny') throw new Error(`Blocked by your rules: ${verdict.reason}`)
  const token = (config.paymentToken ?? ADDR.usdg) as Address
  const amount = parseUnits(req.amountUsd.toString(), config.paymentDecimals)
  const bal = await balanceOf(token, account)
  if (bal < amount) throw new Error(`Your wallet holds ${formatUnits(bal, config.paymentDecimals)} USDG, but this payment needs ${req.amountUsd}.`)
  return { steps: [transferStep(token, getAddress(req.to), amount, `Pay ${short(req.to)}`)], summary: `Pay $${req.amountUsd} to ${short(req.to)} (${req.memo})`, action: req.memo }
}

/** Build the transactions for a held action so the user's own wallet can sign them. Nothing is sent or consumed. */
export async function prepareSigned(id: string, accountInput: unknown) {
  if (!signingAvailable()) throw new Error('Signing with your wallet needs live mode on mainnet (DRY_RUN=false and LIVE_MAINNET=yes).')
  const account = parseAccount(accountInput)
  const p = getPending(id)
  if (!p) throw new Error('That action no longer exists or has expired.')
  dropExpired()

  const built = p.kind === 'trade' ? await prepareTrade(p.trade, account) : await preparePayment(p.req, account)
  const entry =
    p.kind === 'trade'
      ? { module: p.trade.module, action: built.action, amountUsd: p.trade.amountUsd, why: p.trade.why }
      : { module: p.req.module, action: built.action, amountUsd: p.req.amountUsd, to: p.req.to, why: 'Held for approval, then signed by the owner.' }
  prepared.set(id, { account, steps: built.steps, expiresAt: Date.now() + PREPARE_TTL_MS, entry })
  return { steps: built.steps, summary: built.summary, chainId: CHAIN_ID }
}

// ---------- complete ----------
const isHash = (h: unknown): h is Hex => typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h)

export interface CompleteResult {
  status: 'executed' | 'pending'
  message: string
  txHash?: string
}

/**
 * After the wallet has sent the transactions: wait for the last one, check it came from this account, went to the
 * prepared contract with exactly the prepared data, and succeeded. Only then is the action consumed and logged.
 */
export async function completeSigned(id: string, accountInput: unknown, hashes: unknown): Promise<CompleteResult> {
  const account = parseAccount(accountInput)
  const prep = prepared.get(id)
  if (!prep || prep.expiresAt < Date.now()) throw new Error('This signing session expired. Press the button again to prepare it.')
  if (prep.account !== account) throw new Error('A different wallet was prepared for this action.')
  if (!Array.isArray(hashes) || !hashes.length || hashes.length > 3 || !hashes.every(isHash)) throw new Error('Expected 1 to 3 transaction hashes.')

  const mainHash = hashes[hashes.length - 1]
  const mainStep = prep.steps[prep.steps.length - 1]

  let receipt
  try {
    receipt = await mainnetClient.waitForTransactionReceipt({ hash: mainHash, timeout: 30_000 })
  } catch {
    return { status: 'pending', message: 'Not confirmed on the chain yet. It will be recorded once it is.', txHash: mainHash }
  }

  const tx = await mainnetClient.getTransaction({ hash: mainHash })
  if (tx.from.toLowerCase() !== account.toLowerCase()) throw new Error('That transaction was not sent from the connected wallet.')
  if (tx.to?.toLowerCase() !== mainStep.to.toLowerCase() || tx.input.toLowerCase() !== mainStep.data.toLowerCase()) {
    throw new Error('That transaction does not match what was prepared, so it was not recorded.')
  }
  if (receipt.status !== 'success') {
    const { why: _why, ...base } = prep.entry
    record({ ...base, verdict: 'needs_approval', executed: false, dryRun: false, txHash: mainHash, reasoning: `Signed by ${short(account)} but the transaction reverted on chain.` })
    prepared.delete(id)
    throw new Error('The transaction reverted on chain. Nothing was bought or paid; only gas was used.')
  }

  takePending(id)
  const { why, ...entry } = prep.entry
  record({ ...entry, verdict: 'needs_approval', executed: true, dryRun: false, txHash: mainHash, reasoning: `${why} Signed with the owner's wallet ${short(account)}.` })
  prepared.delete(id)
  bumpVersion()
  return { status: 'executed', message: `Confirmed on chain. ${prep.entry.action}`, txHash: mainHash }
}
