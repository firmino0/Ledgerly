import { fetchWithRetry } from './market.js'

export interface RegistryAsset {
  symbol: string
  name: string
  contract: string
}

interface RhDeployment {
  contractAddress: string
  chainId: number
}
interface RhAsset {
  tokenSymbol: string
  tokenName: string
  status: string
  deployments: RhDeployment[]
}

const REGISTRY_URL = 'https://api.robinhood.com/rhj/assets'
// This list rarely changes and is the same for everyone, so one cache serves every visitor.
const CACHE_TTL_MS = 3_600_000

let cache: { at: number; assets: RegistryAsset[] } | null = null

/**
 * Every tokenized stock and ETF Robinhood has actually deployed on Robinhood Chain mainnet (chain 4663), straight
 * from Robinhood's own public asset registry (the same one their docs site's contracts page reads). This only ever
 * returns assets Robinhood marks active with a live chain 4663 deployment: Robinhood does not publish a list of
 * assets it plans to add later, so there is no "coming soon" section here.
 */
export async function listRegistry(): Promise<RegistryAsset[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.assets
  const res = await fetchWithRetry(REGISTRY_URL)
  if (!res.ok) throw new Error(`Robinhood's asset registry returned ${res.status}.`)
  const body = (await res.json()) as { assets?: RhAsset[] }
  const assets = (body.assets ?? [])
    .filter(a => a.status === 'ASSET_STATUS_ACTIVE' && a.deployments.some(d => d.chainId === 4663))
    .map(a => ({
      symbol: a.tokenSymbol.toUpperCase(),
      name: a.tokenName.replace(/\s*•\s*Robinhood Token\s*$/i, '').trim(),
      contract: a.deployments.find(d => d.chainId === 4663)!.contractAddress
    }))
    .sort((x, y) => x.symbol.localeCompare(y.symbol))
  cache = { at: Date.now(), assets }
  return assets
}
