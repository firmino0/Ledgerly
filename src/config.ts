import 'dotenv/config'

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d)

const network = (process.env.NETWORK === 'mainnet' ? 'mainnet' : 'testnet') as 'mainnet' | 'testnet'

/**
 * Ledgerly has no simulation. It either trades for real on Robinhood Chain mainnet, or it refuses to trade.
 * This is the reason it would refuse, or null when trading is on. Trading needs NETWORK=mainnet and LIVE_MAINNET=yes.
 * (DRY_RUN=true is still honoured as an explicit "off", so an old setting can never start spending by accident.)
 */
export function tradingOffReasonFor(env: NodeJS.ProcessEnv): string | null {
  if (env.NETWORK !== 'mainnet') return 'Set NETWORK=mainnet. Ledgerly only trades on Robinhood Chain mainnet.'
  if (env.DRY_RUN === 'true') return 'DRY_RUN=true is set, which switches trading off. Remove it to trade.'
  if (env.LIVE_MAINNET !== 'yes') return 'Trading is switched off. Set LIVE_MAINNET=yes to turn it on.'
  return null
}

export const tradingOffReason = tradingOffReasonFor(process.env)

export const config = {
  network,
  /** True when real trades and payments are switched on. */
  live: tradingOffReason === null,
  servApiKey: process.env.SERV_API_KEY ?? '',
  servModel: process.env.SERV_MODEL || 'gpt-5.4-mini',
  privateKey: process.env.AGENT_PRIVATE_KEY as `0x${string}` | undefined,
  slippageBps: Math.min(500, Math.max(1, num(process.env.SLIPPAGE_BPS, 50))),
  // Defaults to USDG on mainnet (docs.robinhood.com/chain/contracts).
  paymentToken: (process.env.PAYMENT_TOKEN_ADDRESS ||
    (process.env.NETWORK === 'mainnet' ? '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' : undefined)) as `0x${string}` | undefined,
  paymentDecimals: num(process.env.PAYMENT_TOKEN_DECIMALS, 6),
  policy: {
    maxPerTx: num(process.env.MAX_PER_TX, 50),
    maxPerDay: num(process.env.MAX_PER_DAY, 200),
    approvalThreshold: num(process.env.APPROVAL_THRESHOLD, 25)
  }
}
