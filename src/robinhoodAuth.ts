import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'

/** Where the OAuth client registration and tokens are kept. Git-ignored: the refresh token in it is a credential. */
export const AUTH_FILE = process.env.ROBINHOOD_MCP_AUTH_FILE || join(process.cwd(), '.robinhood-mcp-oauth.json')
export const CALLBACK_PORT = 53682
export const REDIRECT_URL = `http://127.0.0.1:${CALLBACK_PORT}/callback`

interface Saved {
  client?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  verifier?: string
  state?: string
}

const read = (): Saved => {
  try {
    return existsSync(AUTH_FILE) ? (JSON.parse(readFileSync(AUTH_FILE, 'utf8')) as Saved) : {}
  } catch {
    return {}
  }
}
const write = (patch: Partial<Saved>) => writeFileSync(AUTH_FILE, JSON.stringify({ ...read(), ...patch }, null, 2), { mode: 0o600 })

/** fetch that retries a dropped connection: Node sometimes reuses an idle socket the server already closed and fails once. */
export async function robustFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  let last: unknown
  for (let i = 0; i < 3; i++) {
    try {
      return await fetch(input, init)
    } catch (e) {
      last = e
      await new Promise(r => setTimeout(r, 400 * (i + 1)))
    }
  }
  throw last
}

/** The real reason behind Node's bare "fetch failed": the nested cause (DNS, refused, timeout, TLS...). */
export function describeError(e: unknown): string {
  const parts: string[] = []
  for (let x: unknown = e, n = 0; x && n < 4; n++) {
    const err = x as { message?: string; code?: string; hostname?: string; cause?: unknown }
    parts.push([err.message, err.code, err.hostname].filter(Boolean).join(' '))
    x = err.cause
  }
  return parts.join(' <- ')
}

export const hasSavedTokens = () => Boolean(read().tokens?.access_token)

/**
 * OAuth client for Robinhood's Agentic Trading MCP (dynamic client registration, PKCE, refresh tokens), backed by a local file.
 * `onRedirect` is only given by the interactive login tool. Everywhere else, needing a fresh sign-in is an error, never a prompt.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  constructor(private onRedirect?: (url: URL) => void | Promise<void>) {}

  get redirectUrl() {
    return REDIRECT_URL
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Ledgerly',
      redirect_uris: [REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      logo_uri: undefined,
      tos_uri: undefined
    }
  }
  state() {
    const s = crypto.randomUUID()
    write({ state: s })
    return s
  }
  savedState = () => read().state
  clientInformation() {
    return read().client
  }
  saveClientInformation(client: OAuthClientInformationMixed) {
    write({ client })
  }
  tokens() {
    return read().tokens
  }
  saveTokens(tokens: OAuthTokens) {
    write({ tokens })
  }
  saveCodeVerifier(verifier: string) {
    write({ verifier })
  }
  codeVerifier() {
    const v = read().verifier
    if (!v) throw new Error('No PKCE verifier saved. Start the sign-in again.')
    return v
  }
  async redirectToAuthorization(url: URL) {
    if (!this.onRedirect) throw new Error('Robinhood MCP needs you to sign in again. Run: npm run robinhood -- login')
    await this.onRedirect(url)
  }
}
