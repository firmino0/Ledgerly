import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { build, type BuildOptions } from 'esbuild'

const norm = (s: string) => s.replace(/\r\n/g, '\n')

// The Vercel function runs lib/ledgerly-server.mjs, which is generated from src/. If someone edits src/ and forgets to
// rebuild, the deployed code would silently differ from what was tested. This fails until `npm run build:vercel` is run.
test('lib/ledgerly-server.mjs is up to date with src/', async () => {
  const { options } = (await import(pathToFileURL('scripts/bundle-options.mjs').href)) as { options: BuildOptions }
  const built = await build({ ...options, write: false, outfile: 'lib/ledgerly-server.mjs' })
  const fresh = norm(built.outputFiles[0].text)
  const committed = norm(readFileSync('lib/ledgerly-server.mjs', 'utf8'))
  assert.equal(committed, fresh, 'The Vercel bundle is stale. Run: npm run build:vercel')
})
