// Standalone dashboard (no OpenServ connection needed). Handy for demos and local testing.
import { runDue } from './dca.js'
import { startDashboard } from './dashboard.js'

startDashboard()
setInterval(() => {
  runDue().catch(err => console.error('DCA tick failed:', err))
}, 60_000)
