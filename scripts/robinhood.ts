// Robinhood Agentic Trading MCP: sign in once, then list and read.
//   npm run robinhood -- login            sign in with your own Robinhood account, in your browser
//   npm run robinhood -- tools            list the tools Robinhood offers and which ones Ledgerly allows (read-only only)
//   npm run robinhood -- call <tool> [json args]   call one read-only tool
// You sign in on Robinhood's own page. Ledgerly never sees your password. The saved tokens stay in a git-ignored file.
import { exec } from 'node:child_process'
import { createServer } from 'node:http'
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import { AUTH_FILE, CALLBACK_PORT, FileOAuthProvider, describeError, robustFetch } from '../src/robinhoodAuth.js'
import { callRobinhoodReadTool, listRobinhoodTools } from '../src/robinhoodMcp.js'

const SERVER = 'https://agent.robinhood.com/mcp/trading'

const openBrowser = (url: string) =>
  exec(process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`)

async function login() {
  let resolveCode!: (c: string) => void
  let rejectCode!: (e: Error) => void
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res
    rejectCode = rej
  })

  const provider = new FileOAuthProvider(url => {
    console.log('\nOpening Robinhood in your browser. If nothing opens, paste this into a desktop browser:\n\n' + url.toString() + '\n')
    openBrowser(url.toString())
  })

  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', `http://127.0.0.1:${CALLBACK_PORT}`)
    if (u.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    const code = u.searchParams.get('code')
    const state = u.searchParams.get('state')
    const err = u.searchParams.get('error')
    res.writeHead(200, { 'content-type': 'text/plain' })
    if (err) {
      res.end(`Robinhood returned an error: ${err}. You can close this tab.`)
      rejectCode(new Error(`Robinhood returned an error: ${err} ${u.searchParams.get('error_description') ?? ''}`))
    } else if (!code || state !== provider.savedState()) {
      res.end('That sign-in did not match this session. You can close this tab.')
      rejectCode(new Error('The callback did not match this sign-in session (state mismatch).'))
    } else {
      res.end('Signed in. You can close this tab and return to the terminal.')
      resolveCode(code)
    }
  })
  await new Promise<void>((res, rej) => server.once('error', rej).listen(CALLBACK_PORT, '127.0.0.1', res))
  const timer = setTimeout(() => rejectCode(new Error('Timed out after 5 minutes waiting for the sign-in.')), 300_000)

  try {
    const first = await auth(provider, { serverUrl: SERVER, fetchFn: robustFetch })
    if (first === 'REDIRECT') {
      const code = await codePromise
      const second = await auth(provider, { serverUrl: SERVER, authorizationCode: code, fetchFn: robustFetch })
      if (second !== 'AUTHORIZED') throw new Error('Robinhood did not authorize the sign-in.')
    }
    console.log(`Signed in. Tokens saved to ${AUTH_FILE} (git-ignored, keep it private).\n`)
  } finally {
    clearTimeout(timer)
    server.close()
  }
  await tools()
}

async function tools() {
  const list = await listRobinhoodTools()
  console.log(`${list.length} tools offered by Robinhood. Ledgerly will only run the ones marked allowed:\n`)
  for (const t of list) console.log(`  ${t.readOnlyAllowed ? 'allowed' : 'REFUSED'}  ${t.name}${t.description ? ' - ' + t.description.split('\n')[0].slice(0, 90) : ''}`)
}

async function call(name: string, rawArgs?: string) {
  const args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {}
  console.log(JSON.stringify(await callRobinhoodReadTool(name, args), null, 2))
}

const [cmd, ...rest] = process.argv.slice(2)
try {
  if (cmd === 'login') await login()
  else if (cmd === 'tools') await tools()
  else if (cmd === 'call' && rest[0]) await call(rest[0], rest[1])
  else console.log('Usage: npm run robinhood -- login | tools | call <tool> [json args]')
} catch (e) {
  console.error('\n' + describeError(e))
  process.exit(1)
}
process.exit(0)
