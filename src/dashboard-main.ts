// Standalone dashboard (no OpenServ connection needed). Handy for running it on your own machine.
import { runDue } from './dca.js'
import { startDashboard } from './dashboard.js'
import { withStore } from './store.js'

startDashboard()
setInterval(() => {
  withStore(() => runDue(), { lock: true }).catch(err => console.error('DCA tick failed:', err))
}, 60_000)
