# Deploying Ledgerly to Vercel

This puts the website **and** the dashboard online. Running locally stays exactly as it is and needs none of this.

## What changes when it is hosted

A hosted copy has no lasting disk, and anyone on the internet can reach it. So in hosted mode:

| Local | Hosted on Vercel |
|---|---|
| State in `data/*.json` files | State in **Upstash Redis** (free tier, added from Vercel's Marketplace) |
| A timer inside the running app checks DCA plans every minute | **Vercel Cron** calls `/api/cron`, protected by a secret |
| No login (only your computer can reach it) | **Password login.** With no password set, the API refuses to run |
| `Sign with my wallet` and `Let agent send` | The same. Which one you get depends on whether you set `AGENT_PRIVATE_KEY` |

## Two modes

| Mode | Server holds a key? | What can happen if someone breaks in |
|---|---|---|
| **A. Signing only** (recommended) | **No.** Leave `AGENT_PRIVATE_KEY` unset. | They cannot move funds. Every trade or payment needs *your* wallet's signature. They could still create plans and spend your SERV credit. |
| **B. Autonomous** | Yes, in a Vercel environment variable. | They could make the agent wallet spend, up to your caps. Keep that wallet small. |

You can start with A and add B later by adding one variable.

## Steps

### 1. Import the repository
Go to https://vercel.com/new, sign in with GitHub, and import **firmino0/Ledgerly**. Leave every setting as it is. `vercel.json` already sets the output folder and turns the build step off.

### 2. Add Redis (state)
In the project: **Storage → Create → Upstash for Redis** (from the Marketplace). Connect it to the project. This adds the connection variables automatically (`KV_REST_API_URL` and `KV_REST_API_TOKEN`, or the `UPSTASH_REDIS_REST_*` equivalents).

### 3. Add environment variables
**Settings → Environment Variables**, for *Production*:

| Name | Value | Notes |
|---|---|---|
| `DASHBOARD_PASSWORD` | a long random password | At least 12 characters. **Use 20 or more.** The app refuses to serve the API without it. |
| `AUTH_SECRET` | a long random string | Signs the login cookie. |
| `CRON_SECRET` | a long random string | Vercel Cron sends this automatically as a bearer token. |
| `SERV_API_KEY` | your SERV Reasoning key | Mark as **Sensitive**. |
| `SERV_MODEL` | `gpt-5.4-mini-serv-multipath` | |
| `NETWORK` | `mainnet` | |
| `DRY_RUN` | `true` | **Start in dry run.** Change later. |
| `LIVE_MAINNET` | `no` | Live needs this to be `yes` as well as `DRY_RUN=false`. |
| `MAX_PER_TX` / `MAX_PER_DAY` / `APPROVAL_THRESHOLD` | for example `2` / `5` / `0.1` | Keep them small. |
| `AGENT_PRIVATE_KEY` | **Mode B only** | Mark **Sensitive**. Use a throwaway wallet. |

To make a random value, run this in a terminal:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Never put these values in the repository. `.env` is ignored by git.

### 4. Deploy
Click **Deploy** (or **Redeploy** after changing variables, since variables only apply to new deployments).

### 5. Check it
- `https://<your-app>.vercel.app/` shows the website.
- `/app` sends you to `/login`. Sign in with your password.
- The banner should say **Dry run**. Add a DCA plan, press **Run due plans now**, and look at the Ledger.
- Sign out, and confirm `/app` sends you back to the login.

## The scheduled job (DCA timer)

`vercel.json` runs `/api/cron` once a day. That is the most the free **Hobby** plan allows, and Vercel may run it any time within that hour. DCA plans are measured in hours, so daily is fine for a demo.

For finer timing you have two options:
- **Vercel Pro:** change `"schedule": "0 9 * * *"` in `vercel.json` to `"* * * * *"` (every minute). On Hobby that setting fails the deployment.
- **A free external pinger** (for example cron-job.org): call `https://<your-app>.vercel.app/api/cron` every 5 minutes with the header `Authorization: Bearer <your CRON_SECRET>`.

Running it twice is safe: a plan that just ran is not due again.

## Going live on mainnet (real money)

Do this only after the dry run works.

1. Set `LIVE_MAINNET` to `yes` and `DRY_RUN` to `false`, and redeploy.
2. The banner turns red: **Live · Robinhood Chain mainnet · real funds**.
3. In **Mode A**, held actions show **Sign with my wallet**. Connect MetaMask, confirm each step, and the server verifies what your wallet sent before recording it.
4. In **Mode B**, they also show **Let agent send**.

Start with a $1 plan, and check the transaction on the block explorer link in the Ledger.

## Security notes

- The login sets a signed cookie (`HttpOnly`, `SameSite=Strict`, `Secure`) that lasts 12 hours (`SESSION_HOURS` to change). Failed logins are rate-limited to 8 a minute per address.
- Requests that change anything must come from the same site.
- It is a **single shared password for one person**, not a multi-user system.
- Anyone with the password can create plans and add payees. In Mode A they still cannot move funds. In Mode B they can trigger the agent wallet within your caps.
- Use a password you have used nowhere else. Rotate `DASHBOARD_PASSWORD` and `AUTH_SECRET` (and redeploy) if you think either leaked. That signs everyone out.
- Data collection: the ledger stores model explanations. Do not put private information in payee names or memos.
- The ledger keeps the latest 1000 entries in Redis.

## When you change the code

The Vercel function runs `lib/ledgerly-server.mjs`, which is **generated** from `src/`. After changing anything in `src/`, run:

```bash
npm run build:vercel
```

and commit the result. `npm test` fails if the bundle is out of date, so you cannot forget quietly.

## Trying hosted mode on your own computer

```bash
LEDGERLY_STORE=memory DASHBOARD_PASSWORD="a-long-password-here" npm run dashboard
```

This uses an in-memory store (it forgets everything on restart) and turns the login on, so you can see the sign-in flow without deploying.
