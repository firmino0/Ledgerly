import { erc20Abi, formatUnits, parseAbi, parseUnits } from 'viem'
import { mainnetClient, walletClient } from './chain.js'
import { config } from './config.js'

// Robinhood Chain mainnet (4663). Sources: docs.robinhood.com/chain/contracts and Uniswap's v3 deployments page,
// both checked onchain (contract code present, NVDA/USDG pools exist, QuoterV2 returns quotes).
export const ADDR = {
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  quoterV2: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
  swapRouter02: '0xcaf681a66d020601342297493863e78c959e5cb2'
} as const

const USDG_DECIMALS = 6
const STOCK_DECIMALS = 18
const FEE_TIERS = [100, 500, 3000, 10000] as const
/** A quote whose implied price is further than this from the price API is treated as a broken pool. */
const MAX_PRICE_DEVIATION = 0.03

const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)'
])
export const routerAbi = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)'
])

export interface Route {
  fee: number
  amountOut: bigint
  tokens: number
  impliedPriceUsd: number
}

export interface Candidate {
  fee: number
  amountOut: bigint
}

/** Best candidate by output, ignoring any whose implied price strays too far from the reference price. Pure. */
export function pickBest(cands: Candidate[], amountUsd: number, refPriceUsd: number): Route | null {
  let best: Route | null = null
  for (const c of cands) {
    const tokens = Number(formatUnits(c.amountOut, STOCK_DECIMALS))
    if (tokens <= 0) continue
    const implied = amountUsd / tokens
    if (Math.abs(implied / refPriceUsd - 1) > MAX_PRICE_DEVIATION) continue
    if (!best || c.amountOut > best.amountOut) best = { fee: c.fee, amountOut: c.amountOut, tokens, impliedPriceUsd: implied }
  }
  return best
}

/** Minimum acceptable output after slippage, in basis points. Pure. */
export function minOut(amountOut: bigint, slippageBps: number): bigint {
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n
}

/** Read-only: quote USDG -> stock token across fee tiers and return the best sane route. */
export async function quoteBuy(tokenOut: `0x${string}`, amountUsd: number, refPriceUsd: number): Promise<Route> {
  const amountIn = parseUnits(amountUsd.toString(), USDG_DECIMALS)
  const results = await Promise.all(
    FEE_TIERS.map(async fee => {
      try {
        const { result } = await mainnetClient.simulateContract({
          address: ADDR.quoterV2,
          abi: quoterAbi,
          functionName: 'quoteExactInputSingle',
          args: [{ tokenIn: ADDR.usdg, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }]
        })
        return { fee, amountOut: result[0] } as Candidate
      } catch {
        return null
      }
    })
  )
  const route = pickBest(results.filter((r): r is Candidate => r !== null), amountUsd, refPriceUsd)
  if (!route) throw new Error('No pool returned a sane quote (empty pool or price mismatch).')
  return route
}

/**
 * Live buy: approve the exact USDG amount to SwapRouter02, then exactInputSingle with a minimum output.
 * Only called after guardrails allow it and DRY_RUN=false on mainnet.
 */
export async function buyToken(
  tokenOut: `0x${string}`,
  amountUsd: number,
  route: Route
): Promise<{ approveTx?: `0x${string}`; swapTx: `0x${string}` }> {
  if (config.network !== 'mainnet') throw new Error('Live swaps are only supported on mainnet (NETWORK=mainnet).')
  const wallet = walletClient()
  const owner = wallet.account.address
  const amountIn = parseUnits(amountUsd.toString(), USDG_DECIMALS)

  const balance = await mainnetClient.readContract({ address: ADDR.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
  if (balance < amountIn) throw new Error(`Insufficient USDG: have ${formatUnits(balance, USDG_DECIMALS)}, need ${amountUsd}.`)

  let approveTx: `0x${string}` | undefined
  const allowance = await mainnetClient.readContract({ address: ADDR.usdg, abi: erc20Abi, functionName: 'allowance', args: [owner, ADDR.swapRouter02] })
  if (allowance < amountIn) {
    approveTx = await wallet.writeContract({ address: ADDR.usdg, abi: erc20Abi, functionName: 'approve', args: [ADDR.swapRouter02, amountIn] })
    const r = await mainnetClient.waitForTransactionReceipt({ hash: approveTx })
    if (r.status !== 'success') throw new Error('USDG approval reverted.')
  }

  const swapTx = await wallet.writeContract({
    address: ADDR.swapRouter02,
    abi: routerAbi,
    functionName: 'exactInputSingle',
    args: [{ tokenIn: ADDR.usdg, tokenOut, fee: route.fee, recipient: owner, amountIn, amountOutMinimum: minOut(route.amountOut, config.slippageBps), sqrtPriceLimitX96: 0n }]
  })
  const r = await mainnetClient.waitForTransactionReceipt({ hash: swapTx })
  if (r.status !== 'success') throw new Error(`Swap reverted (tx ${swapTx}).`)
  return { approveTx, swapTx }
}

// ---------- selling (stock token -> USDG) ----------

export interface SellRoute {
  fee: number
  amountOut: bigint // USDG, 6 decimals
  usdOut: number
  impliedPriceUsd: number
}

/** Best sell quote by USDG received, ignoring pools whose implied price strays too far from the reference. Pure. */
export function pickBestSell(cands: Candidate[], tokenAmount: bigint, refPriceUsd: number): SellRoute | null {
  const tokens = Number(formatUnits(tokenAmount, STOCK_DECIMALS))
  if (tokens <= 0) return null
  let best: SellRoute | null = null
  for (const c of cands) {
    const usdOut = Number(formatUnits(c.amountOut, USDG_DECIMALS))
    if (usdOut <= 0) continue
    const implied = usdOut / tokens
    if (Math.abs(implied / refPriceUsd - 1) > MAX_PRICE_DEVIATION) continue
    if (!best || c.amountOut > best.amountOut) best = { fee: c.fee, amountOut: c.amountOut, usdOut, impliedPriceUsd: implied }
  }
  return best
}

/** Read-only: quote stock token -> USDG across fee tiers and return the best sane route. */
export async function quoteSell(tokenIn: `0x${string}`, tokenAmount: bigint, refPriceUsd: number): Promise<SellRoute> {
  const results = await Promise.all(
    FEE_TIERS.map(async fee => {
      try {
        const { result } = await mainnetClient.simulateContract({
          address: ADDR.quoterV2,
          abi: quoterAbi,
          functionName: 'quoteExactInputSingle',
          args: [{ tokenIn, tokenOut: ADDR.usdg, amountIn: tokenAmount, fee, sqrtPriceLimitX96: 0n }]
        })
        return { fee, amountOut: result[0] } as Candidate
      } catch {
        return null
      }
    })
  )
  const route = pickBestSell(results.filter((r): r is Candidate => r !== null), tokenAmount, refPriceUsd)
  if (!route) throw new Error('No pool returned a sane sell quote (empty pool or price mismatch).')
  return route
}

/** Live sell: approve the exact token amount to SwapRouter02, then exactInputSingle into USDG with a minimum output. */
export async function sellToken(
  tokenIn: `0x${string}`,
  tokenAmount: bigint,
  route: SellRoute
): Promise<{ approveTx?: `0x${string}`; swapTx: `0x${string}` }> {
  if (config.network !== 'mainnet') throw new Error('Live swaps are only supported on mainnet (NETWORK=mainnet).')
  const wallet = walletClient()
  const owner = wallet.account.address

  const balance = await mainnetClient.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
  if (balance < tokenAmount) throw new Error('Insufficient token balance for this sale.')

  let approveTx: `0x${string}` | undefined
  const allowance = await mainnetClient.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'allowance', args: [owner, ADDR.swapRouter02] })
  if (allowance < tokenAmount) {
    approveTx = await wallet.writeContract({ address: tokenIn, abi: erc20Abi, functionName: 'approve', args: [ADDR.swapRouter02, tokenAmount] })
    const r = await mainnetClient.waitForTransactionReceipt({ hash: approveTx })
    if (r.status !== 'success') throw new Error('Token approval reverted.')
  }

  const swapTx = await wallet.writeContract({
    address: ADDR.swapRouter02,
    abi: routerAbi,
    functionName: 'exactInputSingle',
    args: [{ tokenIn, tokenOut: ADDR.usdg, fee: route.fee, recipient: owner, amountIn: tokenAmount, amountOutMinimum: minOut(route.amountOut, config.slippageBps), sqrtPriceLimitX96: 0n }]
  })
  const r = await mainnetClient.waitForTransactionReceipt({ hash: swapTx })
  if (r.status !== 'success') throw new Error(`Swap reverted (tx ${swapTx}).`)
  return { approveTx, swapTx }
}

/** ERC-20 balance of `owner` on mainnet, as a raw bigint. */
export function balanceOf(token: `0x${string}`, owner: `0x${string}`): Promise<bigint> {
  return mainnetClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
}
