import 'dotenv/config'

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d)

const network = (process.env.NETWORK === 'mainnet' ? 'mainnet' : 'testnet') as 'mainnet' | 'testnet'

// Real money is only touched when DRY_RUN=false AND, on mainnet, LIVE_MAINNET=yes is also set on purpose.
const wantsLive = process.env.DRY_RUN === 'false'
const mainnetConfirmed = process.env.LIVE_MAINNET === 'yes'
export const liveBlockedReason =
  wantsLive && network === 'mainnet' && !mainnetConfirmed
    ? 'DRY_RUN=false on mainnet also needs LIVE_MAINNET=yes. Staying in dry-run mode.'
    : null

export const config = {
  network,
  dryRun: !wantsLive || liveBlockedReason !== null,
  servApiKey: process.env.SERV_API_KEY ?? '',
  servModel: process.env.SERV_MODEL || 'gpt-5.4-mini',
  privateKey: process.env.AGENT_PRIVATE_KEY as `0x${string}` | undefined,
  slippageBps: Math.min(500, Math.max(1, num(process.env.SLIPPAGE_BPS, 50))),
  // Defaults to USDG on mainnet (docs.robinhood.com/chain/contracts). Testnet has no known address, so set it.
  paymentToken: (process.env.PAYMENT_TOKEN_ADDRESS ||
    (process.env.NETWORK === 'mainnet' ? '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' : undefined)) as `0x${string}` | undefined,
  paymentDecimals: num(process.env.PAYMENT_TOKEN_DECIMALS, 6),
  policy: {
    maxPerTx: num(process.env.MAX_PER_TX, 50),
    maxPerDay: num(process.env.MAX_PER_DAY, 200),
    approvalThreshold: num(process.env.APPROVAL_THRESHOLD, 25)
  }
}
