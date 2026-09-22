// Standalone dashboard (no OpenServ connection needed). Handy for running it on your own machine.
import { runDue } from './dca.js'
import { startDashboard } from './dashboard.js'
import { runRebalanceIfDue } from './portfolio.js'
import { withStore } from './store.js'

startDashboard()
setInterval(() => {
  withStore(async () => {
    await runDue()
    try {
      await runRebalanceIfDue()
    } catch (err) {
      console.error('Rebalance check failed:', err)
    }
  }, { lock: true }).catch(err => console.error('DCA tick failed:', err))
}, 60_000)
