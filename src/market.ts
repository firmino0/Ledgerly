export interface Quote {
  symbol: string
  bid: number
  ask: number
  mid: number
  dailyHigh: number
  dailyLow: number
  halted: boolean
  generatedAt: string
  contract?: string
}

const BASE = 'https://api.robinhood.com/rhj'

/** Parse the /prices/{symbol} response. Pure, so it can be tested without the network. */
export function parseQuote(symbol: string, body: unknown): Quote {
  const q = (body as { quotes?: Record<string, unknown>[] })?.quotes?.[0]
  if (!q) throw new Error(`No quote returned for ${symbol}`)
  const bid = Number(q.bid)
  const ask = Number(q.ask)
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
    throw new Error(`Invalid bid/ask for ${symbol}`)
  }
  const deployments = q.deployments as { contractAddress: string; chainId: number }[] | undefined
  return {
    symbol: String(q.tokenSymbol ?? symbol).toUpperCase(),
    bid,
    ask,
    mid: (bid + ask) / 2,
    dailyHigh: Number(q.dailyHigh) || ask,
    dailyLow: Number(q.dailyLow) || bid,
    halted: q.isTradingHalt === true,
    generatedAt: String(q.generatedAt ?? ''),
    contract: deployments?.find(d => d.chainId === 4663)?.contractAddress
  }
}

/**
 * GET with a couple of retries. Reusing an idle connection the server already closed makes the first request fail in
 * Node ("fetch failed"); the next one works. A short retry hides that from the person using the app.
 */
export async function fetchWithRetry(url: string, tries = 3): Promise<Response> {
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(10_000) })
    } catch {
      if (i < tries - 1) await new Promise(r => setTimeout(r, 250 * (i + 1)))
    }
  }
  throw new Error('Could not reach the Robinhood price service. Please try again in a moment.')
}

export async function getQuote(symbol: string): Promise<Quote> {
  const sym = symbol.trim().toUpperCase()
  if (!/^[A-Z0-9.]{1,10}$/.test(sym)) throw new Error(`Invalid symbol: ${symbol}`)
  const res = await fetchWithRetry(`${BASE}/prices/${sym}`)
  if (!res.ok) throw new Error(`Price API returned ${res.status} for ${sym}`)
  return parseQuote(sym, await res.json())
}
