import { createPublicClient, createWalletClient, defineChain, erc20Abi, http, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { config } from './config.js'

const rhTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Explorer', url: 'https://explorer.testnet.chain.robinhood.com' } }
})

const rhMainnet = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } }
})

export const chain = config.network === 'mainnet' ? rhMainnet : rhTestnet

export const publicClient = createPublicClient({ chain, transport: http() })

/** Read-only mainnet client. Stock tokens and Uniswap only exist on mainnet, so quotes always use it. */
export const mainnetClient = createPublicClient({ chain: rhMainnet, transport: http() })

export function walletClient() {
  if (!config.privateKey) throw new Error('AGENT_PRIVATE_KEY is not set.')
  return createWalletClient({ account: privateKeyToAccount(config.privateKey), chain, transport: http() })
}

export function walletAddress(): `0x${string}` | undefined {
  return config.privateKey ? privateKeyToAccount(config.privateKey).address : undefined
}

export async function tokenBalance(): Promise<string> {
  const addr = walletAddress()
  if (!addr || !config.paymentToken) return 'unconfigured'
  const raw = await publicClient.readContract({
    address: config.paymentToken,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [addr]
  })
  return (Number(raw) / 10 ** config.paymentDecimals).toString()
}

/** Send the payment token. Only called after the guardrails allow it and dry-run is off. */
export async function sendPayment(to: `0x${string}`, amountUsd: number): Promise<`0x${string}`> {
  if (!config.privateKey || !config.paymentToken) {
    throw new Error('AGENT_PRIVATE_KEY and PAYMENT_TOKEN_ADDRESS must be set for live payments.')
  }
  const wallet = createWalletClient({ account: privateKeyToAccount(config.privateKey), chain, transport: http() })
  return wallet.writeContract({
    address: config.paymentToken,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [to, parseUnits(amountUsd.toString(), config.paymentDecimals)]
  })
}
