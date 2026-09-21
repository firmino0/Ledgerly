# Ledgerly

**A treasury agent on Robinhood Chain that invests, rebalances and pays, and explains every move.**

Ledgerly runs on **SERV Reasoning**. It handles four jobs from one place: recurring buys (DCA), portfolio rebalancing, contractor payroll and bill payments. A model helps decide and explain each action, but the model never holds the keys to the money. A deterministic guardrail engine decides what is allowed.

> Built for the SERV Hackathon, Edition 01, Robinhood Mainnet & MCP track.

## Why it exists

Giving an AI agent a wallet is risky. Ledgerly is built around one rule: **the model proposes, plain code decides.**

- **Spend caps:** a per-transaction cap and a daily cap.
- **Payee allowlist:** payments to an address that was not registered first are always denied.
- **Human approval:** anything above a threshold is held until you approve it. Approvals expire after 24 hours, and the caps are re-checked when you approve.
- **Dry run by default:** nothing touches real money unless you turn it on deliberately. Going live on mainnet needs two separate settings.
- **A record of every decision:** each action is logged with the model's plain-English reasoning.

## What it does

| Module | What it does |
|---|---|
| **DCA** | Recurring buys of Robinhood stock tokens (for example NVDA). SERV Reasoning decides each time whether to buy, skip, or scale the amount between 0.5x and 1.5x, using live prices and the day's price range. |
| **Portfolio rebalancing** | You set target weights such as `NVDA 40, AAPL 30`; the rest stays in USDG. It sells overweight assets and buys underweight ones when they drift past a threshold. The trade sizing is deterministic and unit-tested; SERV writes the explanation. |
| **Payroll and Bills** | Pay freelancers per milestone and pay bills in USDG, only to allowlisted payees. |
| **Robinhood MCP (read-only)** | An optional connector for Robinhood's Agentic Trading MCP. It refuses any tool that looks like trading or transferring. |

Every buy, sell and payment goes through **one path** in the code, so the guardrails cannot be bypassed by a module.

## How SERV Reasoning is used

- **Multipath:** turned on through the model name (`gpt-5.4-mini-serv-multipath`). It kept the model's JSON reply in the exact format we need.
- **Prompt Guard:** always on, because payee names and memos are user-typed text that reaches the prompt.
- **Shadow Agent:** validates DCA decisions against a strict format and regenerates weak replies.
- **Fallback:** if reasoning is unavailable, a DCA run falls back to a plain scheduled buy. The guardrails still apply.

## Architecture

```
            dashboard / agent capabilities
                        |
        DCA   Rebalance   Payroll   Bills
          \       |         |        /
        [ trading.ts ]  [ treasury.ts ]      <- one path each
                        |
              [ guardrails.ts ]              <- caps, allowlist, approval (plain code)
                        |
       dry run: paper portfolio  |  live: Uniswap v3 on Robinhood Chain
                        |
                  [ ledger.ts ]              <- every decision + reasoning
```

Robinhood Chain mainnet (chain ID 4663). Swaps go through Uniswap v3 SwapRouter02 with quotes from QuoterV2, compared across fee tiers and checked against Robinhood's public price API so an empty or broken pool is rejected. Payments use USDG.

## Frontend

Two parts, served by the same small Node server, with no framework and no build step:

| Path | What it is |
|---|---|
| `/` | The website: what Ledgerly is, how a decision is made, the rules, and what has and hasn't been proven. It is fully static and can be hosted on its own. |
| `/app` | The dashboard: Overview, Portfolio, DCA, Payments and Ledger, with an always-visible banner that says whether the app is in dry run or live. |

Files live in `web/`. Design tokens are in `web/assets/tokens.css` (light and dark), and the fonts are served locally from `web/assets/fonts`.

**Hosting on Vercel.** The website and the dashboard can both be hosted. Hosted mode adds a password login, keeps state in Upstash Redis instead of local files, and runs the DCA timer through a secured cron endpoint. See [DEPLOY.md](DEPLOY.md). Running it on your own computer is unchanged and needs no login.

Other people can try it in three ways, each switched off unless you enable it: a read-only **demo** with sample data (`/demo`), a private simulated **sandbox** for each visitor (`/sandbox`), and real **accounts** (`/account`) where each person signs every transaction with their own wallet. Accounts have no server-side key, so the owner's wallet can never be reached from them.

Design notes: the look is a printed ledger (warm paper, one green accent, a serif for headings, monospace tabular figures, thin rules instead of shadowed cards). All text is inserted as text nodes rather than HTML, and the server sends a strict Content-Security-Policy with no inline scripts or styles. Approving a held action while in live mode asks for a browser confirmation first.

## Quick start

Requires Node.js 20+.

```bash
npm install
cp .env.example .env
```

Edit `.env` and set at least `SERV_API_KEY` (the SERV Reasoning key from console.openserv.ai). Then:

```bash
npm run dashboard
```

Open http://localhost:3000 for the website and http://localhost:3000/app for the dashboard. In dry-run mode you can try everything with a simulated portfolio and real prices, with no wallet or funds.

Try this: set targets `NVDA 40, AAPL 30`, reset the paper portfolio to $100, press **Rebalance now**, and approve the held trades.

### Commands

| Command | What it does |
|---|---|
| `npm run dashboard` | Dashboard plus the DCA scheduler |
| `npm run dev` | Same, and connects as an OpenServ agent if `OPENSERV_API_KEY` is set |
| `npm run preflight` | Read-only mainnet readiness check (chain, contracts, quotes, wallet balances) |
| `npm test` | Unit tests |
| `npm run check` | Type check |
| `npm run build:vercel` | Rebuild the bundle the Vercel function runs (needed after changing `src/`; `npm test` fails if it is stale) |

## Two ways to approve a held action

In live mode, each held payment or trade can be approved two ways:

| Button | Who signs | Key needed on the server |
|---|---|---|
| **Sign with my wallet** | Your own browser wallet (MetaMask or similar), through **Connect wallet** in the header | No |
| **Let agent send** | The agent's wallet (`AGENT_PRIVATE_KEY`), within your caps | Yes |

For "Sign with my wallet" the server re-checks your rules, builds the exact transactions (an exact-amount approval where needed, then the swap or transfer), and the dashboard asks your wallet to switch to Robinhood Chain and confirm each step. Afterwards the server waits for the transaction and checks that it came from your connected wallet, went to the prepared contract with exactly the prepared data, and succeeded. Only then is the action recorded. Anything that does not match is refused.

**Tested two ways.** The flow was driven through the real buttons against a wallet stand-in, and the transaction data was decoded and checked. Both approval paths have also run for real: a $0.50 NVDA buy was signed with a connected wallet and confirmed on chain before it was recorded, and the agent wallet has sent a buy and a payment. Failure paths on a real chain, such as a swap that reverts, have not been run.

## Going live on mainnet (real money)

Live mode moves real funds. Use a **fresh throwaway wallet** and start with a few dollars.

1. Set `NETWORK=mainnet` and `AGENT_PRIVATE_KEY` for the throwaway wallet.
2. Fund it with a little ETH for gas and a few dollars of USDG.
3. Run `npm run preflight` until it says Ready.
4. Lower the caps for the first run, for example `MAX_PER_TX=5`, `MAX_PER_DAY=10`, `APPROVAL_THRESHOLD=3`.
5. Set `DRY_RUN=false` **and** `LIVE_MAINNET=yes`. Without the second setting, Ledgerly stays in dry-run mode.

## Configuration

See `.env.example`. Main settings: `SERV_API_KEY`, `SERV_MODEL`, `NETWORK`, `DRY_RUN`, `LIVE_MAINNET`, `MAX_PER_TX`, `MAX_PER_DAY`, `APPROVAL_THRESHOLD`, `SLIPPAGE_BPS`.

## Status and honest limits

**Tested:** guardrails, rebalancing math, swap route selection, wallet transaction data, DCA decision parsing and the MCP read-only filter (77 unit tests); live SERV Reasoning calls; live Robinhood price API; live onchain quotes on mainnet; the dashboard end to end in dry-run mode, including approvals and restart persistence; and three live mainnet transactions, all confirmed on Robinhood Chain: a $0.50 NVDA buy signed with a connected wallet (`0xf353df4d5b9a925ea02399237bc6badf7d5ac75e41088ea104a6083dc2b9dfe1`), a $0.50 NVDA DCA buy sent by the agent wallet (`0xfea991d5425612b143af50a78677f64c1381e960b3de2f36bda7f8f19ff93088`), and a $0.20 USDG payment (`0xb342bac44a45e0eadacf90f50184efccf6604d9a283499df0172b728877a953e`).

**Not yet run with real funds:** live sells and live rebalancing. The code is written and the dry-run path exercises the same quoting, but only buys and one payment have run on mainnet. Treat the next live run of those as a test.

**Robinhood MCP:** the connector is unverified with a real login. Robinhood's sign-in is an OAuth flow in a desktop browser, so a token has to be supplied as `ROBINHOOD_MCP_TOKEN`. It is off by default and read-only.

**Simplifications:**
- Holdings are valued at the mid price and ignore Robinhood's small share multiplier (about 0.1%).
- Dry-run trades count toward the daily cap, so long demos may need a higher `MAX_PER_DAY`.
- Locally the dashboard listens on localhost only and has no login. Hosted, it is protected by a single shared password (one user, not a multi-user system).

## Security notes

- Never commit `.env`. It is already in `.gitignore`.
- Locally the dashboard binds to localhost, rejects unexpected Host headers and non-JSON requests, and renders log text safely. Hosted, it also requires a password, rate-limits sign-in, and refuses to serve the API if no strong password is set.
- The decision log records model output, which can include user-typed memos. Do not put private information in payee names or memos, especially if your SERV workspace has data collection turned on.

## Tech

TypeScript, viem, Uniswap v3, the OpenServ SDK, the OpenAI-compatible SERV Reasoning API, and the Model Context Protocol SDK. The frontend is plain HTML, CSS and JavaScript.

Fonts: Newsreader and IBM Plex, both under the SIL Open Font License (licence files are in `web/assets/fonts`).
