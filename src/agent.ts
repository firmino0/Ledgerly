import { Agent, run } from '@openserv-labs/sdk'
import { z } from 'zod'
import { tokenBalance, walletAddress } from './chain.js'
import { config } from './config.js'
import { startDashboard } from './dashboard.js'
import { cancelPlan, createPlan, listPlans, runDue } from './dca.js'
import { readAll } from './ledger.js'
import { approveAny } from './approve.js'
import { listPending } from './approvals.js'
import { getPortfolioConfig, portfolioView, runRebalance, runRebalanceIfDue, setTargets } from './portfolio.js'
import { researchAsset } from './research.js'
import { listRegistry } from './registry.js'
import { callRobinhoodReadTool, listRobinhoodTools } from './robinhoodMcp.js'
import { withStore } from './store.js'
import { addPayee, listPayees, pay } from './treasury.js'

const agent = new Agent({
  systemPrompt: `You are Ledgerly, an autonomous treasury agent on Robinhood Chain. You pay contractors and bills and explain every move. All money movement goes through capabilities that enforce spend caps, a payee allowlist and human approval above a threshold. Never claim a payment happened unless a capability returned it. Trading is ${config.live ? 'ON' : 'OFF'}.`
})

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a 0x EVM address')

agent.addCapability({
  name: 'add_payee',
  description: 'Register a payee (contractor or biller) on the allowlist. Payments to unregistered addresses are always denied.',
  inputSchema: z.object({ address, label: z.string().describe('Name of the contractor or biller') }),
  async run({ args }) {
    addPayee(args.address, args.label)
    return `Added ${args.label} (${args.address}) to the allowlist.`
  }
})

agent.addCapability({
  name: 'pay_freelancer',
  description: 'Pay a freelancer for a completed milestone. Subject to guardrails.',
  inputSchema: z.object({
    to: address,
    amountUsd: z.number().positive(),
    milestone: z.string().describe('What was delivered')
  }),
  async run({ args }) {
    const r = await pay({ module: 'payroll', to: args.to, amountUsd: args.amountUsd, memo: `Milestone: ${args.milestone}` })
    return JSON.stringify(r)
  }
})

agent.addCapability({
  name: 'pay_bill',
  description: 'Pay a bill or recurring obligation. Subject to guardrails.',
  inputSchema: z.object({
    to: address,
    amountUsd: z.number().positive(),
    invoice: z.string().describe('Invoice number or description')
  }),
  async run({ args }) {
    const r = await pay({ module: 'bills', to: args.to, amountUsd: args.amountUsd, memo: `Bill: ${args.invoice}` })
    return JSON.stringify(r)
  }
})

agent.addCapability({
  name: 'approve_action',
  description: 'Approve a payment or trade that was held for human approval. Only call this when the human user explicitly says to approve.',
  inputSchema: z.object({ approvalId: z.string() }),
  async run({ args }) {
    return JSON.stringify(await approveAny(args.approvalId))
  }
})

agent.addCapability({
  name: 'treasury_status',
  description: 'Show wallet, balance, guardrail policy, payees, pending approvals and recent decisions.',
  inputSchema: z.object({}),
  async run() {
    return JSON.stringify(
      {
        network: config.network,
        live: config.live,
        wallet: walletAddress() ?? 'unconfigured',
        balance: await tokenBalance().catch(e => `error: ${(e as Error).message}`),
        policy: config.policy,
        payees: listPayees(),
        pending: listPending(),
        recent: readAll().slice(-10)
      },
      null,
      2
    )
  }
})

agent.addCapability({
  name: 'dca_create',
  description: 'Create a recurring dollar-cost-averaging plan for a tokenized stock (e.g. NVDA). SERV Reasoning decides each run whether to buy, skip, or scale the amount between 0.5x and 1.5x.',
  inputSchema: z.object({
    symbol: z.string().describe('Ticker, e.g. NVDA'),
    amountUsd: z.number().positive().describe('Planned USD amount per buy'),
    intervalHours: z.number().min(1).describe('Hours between buys, e.g. 24 for daily')
  }),
  async run({ args }) {
    return JSON.stringify(createPlan(args.symbol, args.amountUsd, args.intervalHours))
  }
})

agent.addCapability({
  name: 'dca_run_now',
  description: 'Run all DCA plans that are due right now and report what happened. Buys are subject to guardrails.',
  inputSchema: z.object({}),
  async run() {
    return JSON.stringify(await runDue(), null, 2)
  }
})

agent.addCapability({
  name: 'dca_list',
  description: 'List DCA plans.',
  inputSchema: z.object({}),
  async run() {
    return JSON.stringify(listPlans(), null, 2)
  }
})

agent.addCapability({
  name: 'dca_cancel',
  description: 'Cancel a DCA plan by id.',
  inputSchema: z.object({ planId: z.string() }),
  async run({ args }) {
    return cancelPlan(args.planId) ? `Cancelled ${args.planId}.` : `No plan with id ${args.planId}.`
  }
})

agent.addCapability({
  name: 'list_tokenized_assets',
  description: 'List every tokenized stock and ETF Robinhood has actually deployed on Robinhood Chain mainnet, from Robinhood\'s own public asset registry. Use this to see what is available before researching or setting up a DCA plan for a symbol you are not sure about.',
  inputSchema: z.object({}),
  async run() {
    return JSON.stringify(await listRegistry(), null, 2)
  }
})

agent.addCapability({
  name: 'research_asset',
  description: 'Look up a tokenized stock: its live quote, whether Ledgerly can actually trade it onchain right now, and a short SERV Reasoning summary of where the price sits. Read-only, not financial advice. Use this before setting up a DCA plan or portfolio target for a symbol you have not tried before.',
  inputSchema: z.object({ symbol: z.string().describe('Ticker, e.g. NVDA') }),
  async run({ args }) {
    return JSON.stringify(await researchAsset(args.symbol), null, 2)
  }
})

agent.addCapability({
  name: 'set_portfolio_targets',
  description: 'Set target portfolio weights, e.g. {"NVDA": 40, "AAPL": 30}. Whatever is left over is held as USDG cash. Percentages must add up to 100 or less.',
  inputSchema: z.object({
    targets: z.record(z.string(), z.number()).describe('Ticker to target percent'),
    driftThresholdPct: z.number().optional().describe('Only rebalance assets at least this many points off target (default 5)')
  }),
  async run({ args }) {
    return JSON.stringify(setTargets(args.targets, args.driftThresholdPct))
  }
})

agent.addCapability({
  name: 'portfolio_status',
  description: 'Show current portfolio weights against targets and the trades a rebalance would make.',
  inputSchema: z.object({}),
  async run() {
    return JSON.stringify({ config: getPortfolioConfig(), view: await portfolioView() }, null, 2)
  }
})

agent.addCapability({
  name: 'rebalance_now',
  description: 'Rebalance the portfolio toward its targets. Every trade goes through the guardrails and may be held for human approval.',
  inputSchema: z.object({}),
  async run() {
    return JSON.stringify(await runRebalance(), null, 2)
  }
})

agent.addCapability({
  name: 'robinhood_list_tools',
  description: 'List the tools offered by Robinhood Agentic Trading MCP and which ones Ledgerly may use (read-only only). Needs ROBINHOOD_MCP_TOKEN.',
  inputSchema: z.object({}),
  async run() {
    try {
      return JSON.stringify(await listRobinhoodTools(), null, 2)
    } catch (e) {
      return `Robinhood MCP unavailable: ${(e as Error).message}`
    }
  }
})

agent.addCapability({
  name: 'robinhood_read',
  description: 'Call a read-only Robinhood MCP tool (portfolio, positions, balances, history). Trading tools are refused.',
  inputSchema: z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).optional() }),
  async run({ args }) {
    try {
      return JSON.stringify(await callRobinhoodReadTool(args.tool, args.args ?? {}), null, 2)
    } catch (e) {
      return `Robinhood MCP unavailable: ${(e as Error).message}`
    }
  }
})

startDashboard()

// Check for due DCA plans every minute, and drift-check the portfolio at the same time (throttled internally).
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

// A rejected platform key surfaces as an uncaught error from the tunnel's websocket handler. Keep the
// dashboard and DCA timer alive in that case; anything else still crashes as normal.
process.on('uncaughtException', err => {
  if (/api key|tunnel|openserv/i.test(err.message)) {
    console.error(`\nOpenServ connection failed: ${err.message}`)
    console.error('Check OPENSERV_API_KEY (the agent secret key from Your Agents, not the SERV Reasoning key).')
    console.error('The dashboard and DCA scheduler are still running, but the agent is not reachable from OpenServ.\n')
    return
  }
  console.error(err)
  process.exit(1)
})

// The OpenServ agent connection is optional. Without an agent key, only the dashboard and DCA scheduler run.
let stop: (() => Promise<void>) | undefined
if (!process.env.OPENSERV_API_KEY) {
  console.log('OPENSERV_API_KEY not set: running the dashboard and DCA scheduler only (agent not connected to OpenServ).')
} else {
  try {
    ;({ stop } = await run(agent))
  } catch (err) {
    console.error(`Could not start the OpenServ agent: ${(err as Error).message}`)
  }
}
process.on('SIGINT', () => {
  void (stop?.() ?? Promise.resolve()).finally(() => process.exit(0))
})
