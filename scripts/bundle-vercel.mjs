// Builds what the Vercel deployment needs, from src/ and web/app.html. Run: npm run build:vercel
//  - lib/ledgerly-server.mjs : the server code bundled into one file (dependencies stay external)
//  - web/me.html : a copy of the dashboard page for the signed-in account address
import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { options } from './bundle-options.mjs'
import { PAGES, renderPage } from './pages.mjs'

await build({ ...options, outfile: 'lib/ledgerly-server.mjs' })
console.log('Wrote lib/ledgerly-server.mjs')

const app = readFileSync('web/app.html', 'utf8').replace(/\r\n/g, '\n')
for (const [name, title] of Object.entries(PAGES)) {
  writeFileSync(`web/${name}.html`, renderPage(app, title))
  console.log(`Wrote web/${name}.html`)
}
