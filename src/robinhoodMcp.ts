import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

/**
 * Read-only connector to Robinhood's Agentic Trading MCP server.
 *
 * Status: written against the public MCP protocol, but only the "rejected without a token" path has been tested.
 * Robinhood's login is an OAuth flow completed in a desktop browser, so a headless agent needs a bearer token
 * you obtain yourself and pass as ROBINHOOD_MCP_TOKEN. Tool names are not published, so read-only access is
 * enforced by name pattern below. Trading through this connector is intentionally not supported.
 */
const URL_MCP = 'https://agent.robinhood.com/mcp/trading'
const TIMEOUT_MS = 15_000

// A tool may run only if it starts with a read verb and contains no action word anywhere in its name.
const READ_VERBS = new Set(['get', 'list', 'search', 'read', 'fetch', 'view', 'query', 'find', 'describe', 'show'])
const ACTION_WORDS = new Set([
  'place', 'create', 'submit', 'cancel', 'replace', 'modify', 'update', 'delete', 'remove', 'buy', 'sell',
  'transfer', 'withdraw', 'deposit', 'execute', 'trade', 'open', 'close', 'send', 'set', 'add', 'stake', 'lend'
])

const tokens = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

/** Pure. True only for tools that look strictly read-only. */
export function isReadOnlyTool(name: string): boolean {
  const t = tokens(name)
  return t.length > 0 && READ_VERBS.has(t[0]) && !t.some(w => ACTION_WORDS.has(w))
}

export const robinhoodMcpConfigured = () => Boolean(process.env.ROBINHOOD_MCP_TOKEN)

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const token = process.env.ROBINHOOD_MCP_TOKEN
  if (!token) throw new Error('ROBINHOOD_MCP_TOKEN is not set. Robinhood requires a login (OAuth) that this agent cannot do on its own.')
  const client = new Client({ name: 'ledgerly', version: '0.1.0' })
  const transport = new StreamableHTTPClientTransport(new URL(URL_MCP), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
  const timer = setTimeout(() => void client.close().catch(() => {}), TIMEOUT_MS)
  try {
    await client.connect(transport)
    return await fn(client)
  } finally {
    clearTimeout(timer)
    await client.close().catch(() => {})
  }
}

/** Tools the server offers, marking which ones this connector allows. */
export async function listRobinhoodTools() {
  return withClient(async c => {
    const { tools } = await c.listTools()
    return tools.map(t => ({ name: t.name, description: t.description ?? '', readOnlyAllowed: isReadOnlyTool(t.name) }))
  })
}

/** Call a read-only Robinhood tool (portfolio, positions, balances, history). Anything else is refused. */
export async function callRobinhoodReadTool(name: string, args: Record<string, unknown> = {}) {
  if (!isReadOnlyTool(name)) throw new Error(`Refused: "${name}" is not a read-only tool. Ledgerly never trades through Robinhood MCP.`)
  return withClient(async c => {
    const res = await c.callTool({ name, arguments: args })
    return res.content
  })
}
