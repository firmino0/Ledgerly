// Vercel entry point. Every /api/* request is rewritten here (see vercel.json) and handled by the same code
// that runs locally. The bundle is generated from src/ by `npm run build:vercel`.
import { handleRequest } from '../lib/ledgerly-server.mjs'

export const config = { maxDuration: 60 }

export default async function handler(req, res) {
  await handleRequest(req, res, { serveFiles: false })
}
