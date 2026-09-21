import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const norm = (s: string) => s.replace(/\r\n/g, '\n')

// Each dashboard address needs a real file on the host. They are generated from web/app.html; this fails if one is stale.
test('web/demo.html, sandbox.html and me.html match web/app.html', async () => {
  const { PAGES, renderPage } = (await import(pathToFileURL('scripts/pages.mjs').href)) as {
    PAGES: Record<string, string>
    renderPage: (html: string, title: string) => string
  }
  const app = norm(readFileSync('web/app.html', 'utf8'))
  for (const [name, title] of Object.entries(PAGES)) {
    assert.equal(norm(readFileSync(`web/${name}.html`, 'utf8')), renderPage(app, title), `web/${name}.html is stale. Run: npm run build:vercel`)
  }
})

test('vercel.json has no page rewrites that depend on the host\'s routing', () => {
  const cfg = JSON.parse(readFileSync('vercel.json', 'utf8')) as { rewrites?: { source: string; destination: string }[] }
  for (const r of cfg.rewrites ?? []) assert.match(r.destination, /^\/api$/, `unexpected rewrite ${r.source} -> ${r.destination}`)
})
