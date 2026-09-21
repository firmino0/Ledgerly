// Bundles the server code into lib/ledgerly-server.mjs for the Vercel function. Run: npm run build:vercel
import { build } from 'esbuild'
import { options } from './bundle-options.mjs'

await build({ ...options, outfile: 'lib/ledgerly-server.mjs' })
console.log('Wrote lib/ledgerly-server.mjs')
