// Read-only readiness check for Robinhood Chain mainnet. Sends no transactions and never prints the private key.
import { erc20Abi, formatEther, formatUnits } from 'viem'
import { mainnetClient, walletAddress } from './chain.js'
import { config, liveBlockedReason } from './config.js'
import { getQuote } from './market.js'
import { ADDR, quoteBuy } from './swap.js'

let problems = 0
const ok = (msg: string) => console.log(`  [ok]   ${msg}`)
const bad = (msg: string) => {
  problems++
  console.log(`  [FAIL] ${msg}`)
}
const note = (msg: string) => console.log(`  [note] ${msg}`)

console.log(`\nLedgerly preflight (${config.network}, ${config.dryRun ? 'DRY RUN' : 'LIVE'})\n`)
if (liveBlockedReason) note(liveBlockedReason)
if (config.network !== 'mainnet') note('NETWORK is not "mainnet". Stock tokens and Uniswap exist only on mainnet (4663).')

console.log('Chain and contracts')
try {
  const id = await mainnetClient.getChainId()
  id === 4663 ? ok('Connected to Robinhood Chain mainnet (4663)') : bad(`Unexpected chain id ${id}`)
  for (const [name, address] of Object.entries(ADDR)) {
    const code = await mainnetClient.getCode({ address })
    code && code.length > 2 ? ok(`${name} has contract code`) : bad(`${name} has no contract code at ${address}`)
  }
} catch (e) {
  bad(`Cannot reach the RPC: ${(e as Error).message}`)
}

console.log('\nMarket data and routing')
try {
  const q = await getQuote('NVDA')
  ok(`Price API: NVDA bid ${q.bid} / ask ${q.ask}${q.halted ? ' (HALTED)' : ''}`)
  if (q.contract) {
    const r = await quoteBuy(q.contract as `0x${string}`, 1, q.ask)
    ok(`Onchain quote: $1 buys ~${r.tokens.toFixed(6)} NVDA via the ${r.fee / 10_000}% pool`)
  } else bad('NVDA has no Robinhood Chain deployment in the price API')
} catch (e) {
  bad(`Quote failed: ${(e as Error).message}`)
}

console.log('\nWallet')
const wallet = walletAddress()
if (!wallet) {
  note('AGENT_PRIVATE_KEY is not set. Fine for dry runs. Live payments and swaps need a funded throwaway wallet.')
} else {
  ok(`Wallet ${wallet}`)
  try {
    const eth = await mainnetClient.getBalance({ address: wallet })
    const usdg = await mainnetClient.readContract({ address: ADDR.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] })
    Number(formatEther(eth)) > 0 ? ok(`ETH for gas: ${formatEther(eth)}`) : bad('No ETH for gas. Every transaction needs a little ETH on Robinhood Chain.')
    Number(formatUnits(usdg, 6)) > 0 ? ok(`USDG: ${formatUnits(usdg, 6)}`) : note('No USDG yet. Live payments and buys need USDG in this wallet.')
  } catch (e) {
    bad(`Could not read balances: ${(e as Error).message}`)
  }
}

console.log('\nGuardrails')
ok(`Max per transaction $${config.policy.maxPerTx}, max per day $${config.policy.maxPerDay}, approval above $${config.policy.approvalThreshold}, slippage ${config.slippageBps / 100}%`)
config.servApiKey ? ok(`SERV Reasoning key set, model ${config.servModel}`) : note('SERV_API_KEY not set. Decisions fall back to plain scheduled buys.')

console.log(problems ? `\n${problems} problem(s) to fix before going live.\n` : '\nReady. Start live mode with a tiny amount first (see .env: DRY_RUN=false and LIVE_MAINNET=yes).\n')
process.exit(problems ? 1 : 0)
