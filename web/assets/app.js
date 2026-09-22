// Ledgerly dashboard. No framework, no build step. All text is inserted as text nodes, never as HTML:
// log lines can contain model output and user-typed memos.

/* ---------- small helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel)

function h(tag, props, ...kids) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue
    if (k === 'class') n.className = v
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v)
    else n.setAttribute(k, v === true ? '' : String(v))
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)))
  return n
}

const usd = (n, d = 2) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
/** Whole dollars when the amount is a whole number, otherwise cents (so $0.10 never shows as $0). */
const whole = n => usd(n, Number.isInteger(Number(n)) ? 0 : 2)
const pct = n => Number(n).toFixed(1) + '%'
const short = a => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '')
const clock = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const dayTime = iso => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + ' min ago'
  if (s < 86400) return Math.floor(s / 3600) + ' h ago'
  return Math.floor(s / 86400) + ' d ago'
}
function left(iso) {
  const s = (new Date(iso).getTime() - Date.now()) / 1000
  if (s <= 0) return 'expired'
  return s < 3600 ? Math.ceil(s / 60) + ' min left' : Math.floor(s / 3600) + ' h left'
}

/** Long model explanations collapse to their first lines; the full text stays one click away. */
function reason(text, cls) {
  const t = String(text || '').trim()
  if (t.length <= 170) return h('div', { class: cls }, t)
  const cut = t.slice(0, 160).replace(/\s+\S*$/, '') + '…'
  return h('details', { class: cls + ' more' }, h('summary', {}, cut), h('div', { class: 'full' }, t))
}

const MODULES = { dca: 'DCA', rebalance: 'Rebalance', payroll: 'Payroll', bills: 'Bills', system: 'System' }

/** [label, css class] for a ledger entry. */
function markFor(e) {
  if (e.executed) return ['Executed', 'mark-allow']
  if (e.verdict === 'deny') return ['Denied', 'mark-deny']
  if (e.verdict === 'needs_approval') return ['Held', 'mark-hold']
  return ['No action', 'mark-quiet']
}
const mark = e => {
  const [label, cls] = markFor(e)
  return h('span', { class: 'mark ' + cls }, label)
}

/* ---------- modes: owner (the operator's own dashboard) or a signed-in account ---------- */
const MODE = location.pathname === '/me' ? 'user' : 'owner'
const HAS_WALLET = true

/* ---------- api, toast, state ---------- */
async function api(path, body) {
  const extra = MODE === 'user' ? { 'x-ledgerly-mode': 'user' } : {}
  const res = await fetch(path, body === undefined ? { headers: extra } : { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) })
  const json = await res.json().catch(() => ({}))
  if (res.status === 401) {
    if (MODE === 'user') {
      location.replace('/account')
      throw new Error('Sign in required')
    }
    if (path !== '/api/login') {
      location.replace('/login')
      throw new Error('Sign in required')
    }
  }
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`)
  return json
}

let toastTimer
function toast(msg, bad = false) {
  const t = $('#toast')
  t.textContent = msg
  t.className = 'show' + (bad ? ' bad' : '')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (t.className = ''), 5500)
}

let S = null // latest server state
let current = null // mounted view

async function act(btn, fn, okMsg) {
  if (btn) btn.disabled = true
  try {
    const r = await fn()
    toast(okMsg ? okMsg(r) : 'Done')
    await refresh()
  } catch (e) {
    toast(e.message, true)
  } finally {
    if (btn) btn.disabled = false
  }
}

function onSubmit(form, build, okMsg) {
  form.addEventListener('submit', e => {
    e.preventDefault()
    const btn = e.submitter
    act(
      btn,
      async () => {
        const r = await build(new FormData(form))
        form.reset()
        form.dispatchEvent(new Event('ledgerly:reset'))
        return r
      },
      okMsg
    )
  })
}

const field = (label, input) => h('label', { class: 'field' }, h('span', {}, label), input)
const secHead = (title, hint) => h('div', { class: 'sec-head' }, h('h2', {}, title), hint ? h('span', { class: 'hint' }, hint) : null)
const empty = (strong, rest) => h('div', { class: 'empty' }, h('strong', {}, strong), ' ', rest)

/* ---------- your wallet (a browser extension such as MetaMask, EIP-1193) ---------- */
const CHAIN = {
  id: '0x1237', // 4663, Robinhood Chain mainnet
  params: {
    chainId: '0x1237',
    chainName: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
    blockExplorerUrls: ['https://robinhoodchain.blockscout.com']
  }
}
const wallet = { account: null, usdg: null }
const provider = () => window.ethereum || null
const OFF_KEY = 'ledgerly-wallet-off'
const remember = off => {
  try {
    off ? localStorage.setItem(OFF_KEY, '1') : localStorage.removeItem(OFF_KEY)
  } catch {}
}
const wasOff = () => {
  try {
    return localStorage.getItem(OFF_KEY) === '1'
  } catch {
    return false
  }
}

function paintWallet() {
  const bal = wallet.usdg != null ? ` · ${usd(wallet.usdg)} USDG` : ''
  const btn = $('#wallet-btn')
  btn.textContent = wallet.account ? short(wallet.account) : 'Connect wallet'
  btn.title = wallet.account ? `Connected: ${wallet.account}${bal}. Click to copy the address.` : 'Connect a browser wallet such as MetaMask'
  $('#wallet-x').hidden = !wallet.account
  $('#side-you').textContent = wallet.account ? `You: ${short(wallet.account)}${bal}` : ''
}

async function loadWalletBalance() {
  if (!wallet.account) return
  try {
    wallet.usdg = (await api('/api/wallet?account=' + wallet.account)).usdg
  } catch {
    wallet.usdg = null
  }
  paintWallet()
}

function setAccount(a) {
  wallet.account = a || null
  wallet.usdg = null
  paintWallet()
  if (a) loadWalletBalance()
  // An account's live portfolio is read from the wallet it links.
  if (a && MODE === 'user') api('/api/account/wallet', { address: a }).then(() => refresh()).catch(() => {})
}

async function connectWallet() {
  const p = provider()
  if (!p) {
    toast('No browser wallet found. Install MetaMask or a similar wallet, then reload this page.', true)
    return false
  }
  try {
    const accounts = await p.request({ method: 'eth_requestAccounts' })
    remember(false)
    setAccount(accounts[0])
    return Boolean(accounts[0])
  } catch (e) {
    toast(e && e.code === 4001 ? 'Connection cancelled.' : (e && e.message) || 'Could not connect.', true)
    return false
  }
}

async function ensureChain() {
  const p = provider()
  if ((await p.request({ method: 'eth_chainId' })) === CHAIN.id) return
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN.id }] })
  } catch (e) {
    // 4902: the wallet does not know this chain yet, so offer to add it.
    if (e && (e.code === 4902 || e.code === -32603)) await p.request({ method: 'wallet_addEthereumChain', params: [CHAIN.params] })
    else throw e
  }
}

async function waitReceipt(hash) {
  const p = provider()
  for (let i = 0; i < 45; i++) {
    const r = await p.request({ method: 'eth_getTransactionReceipt', params: [hash] })
    if (r) {
      if (r.status === '0x1') return
      throw new Error('A step reverted on chain, so nothing further was sent.')
    }
    await new Promise(res => setTimeout(res, 2000))
  }
  throw new Error('Timed out waiting for the approval to confirm. Check your wallet, then try again.')
}

/** Have the user's own wallet sign and send a held action. The server prepares it and verifies the result. */
async function signWithWallet(p) {
  if (!wallet.account && !(await connectWallet())) throw new Error('Connect your wallet to sign.')
  const eth = provider()
  try {
    await ensureChain()
    const prep = await api('/api/wallet/prepare', { id: p.id, account: wallet.account })
    const hashes = []
    for (let i = 0; i < prep.steps.length; i++) {
      const s = prep.steps[i]
      toast(`Step ${i + 1} of ${prep.steps.length}: confirm "${s.label}" in your wallet`)
      hashes.push(await eth.request({ method: 'eth_sendTransaction', params: [{ from: wallet.account, to: s.to, data: s.data, value: '0x0' }] }))
      if (i < prep.steps.length - 1) {
        toast(`Waiting for "${s.label}" to confirm on the chain…`)
        await waitReceipt(hashes[i])
      }
    }
    toast('Waiting for the chain to confirm…')
    let r = await api('/api/wallet/complete', { id: p.id, account: wallet.account, hashes })
    if (r.status === 'pending') r = await api('/api/wallet/complete', { id: p.id, account: wallet.account, hashes })
    return r
  } catch (e) {
    if (e && e.code === 4001) throw new Error('You cancelled in your wallet. Nothing was sent.')
    throw e
  }
}

/* ---------- approvals (shared by overview) ---------- */
function confirmLive(what) {
  return confirm(`${what}\n\nThis will send a real transaction from your wallet. Continue?`)
}

function queueList() {
  if (!S.pending.length) {
    return empty('Nothing is waiting.', MODE === 'user' ? 'Every action you propose appears here, and you sign it with your own wallet.' : `Anything above your ${whole(S.policy.approvalThreshold)} approval line will appear here for you to approve or reject.`)
  }
  return h(
    'ul',
    { class: 'queue' },
    S.pending.map(p =>
      h(
        'li',
        {},
        h('div', { class: 'what' }, h('strong', {}, p.label), h('div', { class: 'meta' }, [MODULES[p.module] || p.module, p.to ? 'to ' + short(p.to) : null, `held ${ago(p.createdAt)}`, left(p.expiresAt)].filter(Boolean).join(' · '))),
        h('span', { class: 'amt' }, usd(p.amountUsd)),
        h(
          'div',
          { class: 'acts' },
          S.signing ? h('button', { class: 'btn btn-primary btn-sm', type: 'button', title: 'Your own wallet signs and sends this. The agent key is not used.', onclick: e => act(e.currentTarget, () => signWithWallet(p), r => r.message) }, 'Sign with my wallet') : null,
          // Live with no agent key on the server: the agent has no wallet to send from, so only signing (or rejecting) applies.
          MODE === 'user' && S.signing
            ? null
            : S.signing && !S.wallet
            ? null
            : h('button', { class: 'btn btn-sm' + (S.signing ? '' : ' btn-primary'), type: 'button', title: S.signing ? "The agent's own wallet sends this within your limits." : null, onclick: e => confirmLive(`Approve ${p.label} for ${usd(p.amountUsd)}?`) && act(e.currentTarget, () => api('/api/approve', { id: p.id }), r => r.message || 'Approved') }, S.signing ? 'Let agent send' : 'Approve'),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: e => act(e.currentTarget, () => api('/api/reject', { id: p.id }), r => r.message) }, 'Reject')
        )
      )
    )
  )
}

/* ---------- views ---------- */
function viewHead(title, sub, actions) {
  return h('div', { class: 'view-head' }, h('div', {}, h('h1', {}, title), sub ? h('p', {}, sub) : null), actions || null)
}

function feedList(entries) {
  if (!entries.length) return empty('No decisions yet.', 'Add a DCA plan or set portfolio targets, and every decision will be written here with its reason.')
  return h(
    'ul',
    { class: 'feed' },
    entries.map(e =>
      h(
        'li',
        {},
        h('span', { class: 't num' }, clock(e.ts)),
        h('div', { class: 'what' }, h('strong', {}, e.action), reason(e.reasoning, 'why')),
        h('div', { class: 'side-r' }, e.amountUsd != null ? h('span', { class: 'num' }, usd(e.amountUsd)) : null, mark(e))
      )
    )
  )
}

function overview() {
  const figs = h('div', { class: 'figures' })
  const queue = h('div')
  const feed = h('div')
  const rules = h('div')
  const root = h(
    'div',
    {},
    viewHead('Overview', 'What is waiting for you, what was spent today, and what the agent decided recently.'),
    figs,
    h(
      'div',
      { class: 'two' },
      h('div', {}, h('section', { class: 'sec' }, secHead('Waiting on you', 'Held until you approve or reject'), queue), h('section', { class: 'sec' }, secHead('Recent decisions', h('a', { href: '#/ledger' }, 'Full ledger')), feed)),
      h('div', {}, h('section', { class: 'sec' }, secHead('Rules in force'), rules))
    )
  )

  const fig = (label, value, note, extra) => h('div', { class: 'fig' }, h('span', { class: 'eyebrow' }, label), h('div', { class: 'v' }, value), h('div', { class: 'note' }, note), extra)

  return {
    root,
    update(s) {
      const balanceOk = !['unconfigured', 'unavailable'].includes(s.balance)
      const capUsed = Math.min(1, s.spentToday / s.policy.maxPerDay)
      const meter = h('div', { class: 'meter' + (capUsed > 0.8 ? ' hot' : ''), role: 'img', 'aria-label': `${Math.round(capUsed * 100)}% of the daily cap used` }, h('i'))
      meter.firstChild.style.width = capUsed * 100 + '%'
      const plan = s.portfolio && s.portfolio.plan
      figs.replaceChildren(
        fig(MODE === 'user' ? 'Your wallet · USDG' : 'Agent wallet · USDG', balanceOk ? usd(s.balance) : '—', s.wallet ? short(s.wallet) : MODE === 'user' ? 'Connect your wallet to see it' : 'No wallet configured'),
        fig('Spent today', usd(s.spentToday), `of ${whole(s.policy.maxPerDay)} daily cap`, meter),
        fig('Portfolio', plan ? usd(plan.totalUsd) : '—', plan ? 'From your wallet' : 'No targets set'),
        fig('Waiting on you', String(s.pending.length), 'payments and trades')
      )
      queue.replaceChildren(queueList())
      feed.replaceChildren(feedList(s.ledger.slice(0, 6)))
      rules.replaceChildren(
        h(
          'dl',
          { class: 'rules' },
          [
            ['Per-transaction cap', whole(s.policy.maxPerTx)],
            ['Daily cap', whole(s.policy.maxPerDay)],
            MODE === 'user' ? ['Approval', 'Your own signature'] : ['Approval needed above', whole(s.policy.approvalThreshold)],
            ['Approvals expire after', '24 h'],
            ['Payees', 'Allowlist only']
          ].map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', { class: v.startsWith('$') || v.endsWith('h') ? 'num' : '' }, v)))
        ),
        h('p', { class: 'muted' }, MODE === 'user' ? 'Set by the site owner. The model cannot change them.' : 'Set in your .env file. The model cannot change them.')
      )
    }
  }
}

/** Look up a tokenized stock: its live quote, whether Ledgerly can trade it onchain right now, and SERV's summary. */
/** A market-data terminal: search a ticker, see its quote and SERV's summary, and keep a running watchlist. */
/** Browse every tokenized stock live on Robinhood Chain, and look one up: its quote, whether it is actually tradable onchain, and SERV's summary. */
/** Browse every tokenized stock live on Robinhood Chain, look one up, and act on it (DCA or portfolio target) without leaving the page. */
function research() {
  const fig = (label, value, note) => {
    const v = h('div', { class: 'v' }, value)
    return { v, el: h('div', { class: 'fig' }, h('span', { class: 'eyebrow' }, label), v, h('div', { class: 'note' }, note)) }
  }
  const netFig = fig('Network', 'Robinhood Chain', 'mainnet \u00b7 chain 4663')
  const assetsFig = fig('Live assets', '\u2026', 'tokenized on Robinhood Chain')
  const loadedFig = fig('Prices loaded', '\u2026', 'live quotes shown below')
  const statCards = h('div', { class: 'figures figures-3' }, netFig.el, assetsFig.el, loadedFig.el)

  const filterInput = h('input', { placeholder: 'Filter by symbol or name, or type a ticker and press Enter\u2026', autocomplete: 'off', spellcheck: 'false' })
  const searchForm = h('form', { class: 'form wide-first' }, field('Live tokenized assets', filterInput), h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, 'Look up')))
  const countLine = h('p', { class: 'muted' }, 'Loading the list of tokenized assets\u2026')
  const listBox = h('div')
  const detailBox = h('div')

  let assets = []
  const PAGE_SIZE = 30
  let visibleCount = PAGE_SIZE
  const quotesById = new Map() // symbol -> quote | 'error'
  const pending = new Set()

  function renderList() {
    const q = filterInput.value.trim().toLowerCase()
    const filtered = q ? assets.filter(a => a.symbol.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)) : assets
    countLine.textContent = assets.length ? `${filtered.length} of ${assets.length} tokenized assets live on Robinhood Chain mainnet` : ''
    if (!filtered.length) return listBox.replaceChildren(empty('No matches.', 'Try a different symbol or name.'))

    const visible = filtered.slice(0, visibleCount)
    const rows = visible.map(a => {
      const qt = quotesById.get(a.symbol)
      const known = qt && qt !== 'error'
      const price = known ? usd(qt.mid) : qt === 'error' ? '\u2014' : '\u2026'
      const range = known ? `${usd(qt.dailyLow)}\u2013${usd(qt.dailyHigh)}` : ''
      const status = known ? h('span', { class: 'mark ' + (qt.halted ? 'mark-hold' : 'mark-allow') }, qt.halted ? 'Halted' : 'Trading') : ''
      const row = h('tr', {}, h('td', { class: 'num' }, a.symbol), h('td', { class: 'muted' }, a.name), h('td', { class: 'r num' }, price), h('td', { class: 'muted num' }, range), h('td', {}, status))
      row.addEventListener('click', () => lookup(a.symbol))
      return row
    })
    const more = filtered.length - visible.length
    const moreBtn = more > 0
      ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { visibleCount += PAGE_SIZE; renderList() } }, `Show ${Math.min(more, PAGE_SIZE)} more`)
      : null
    listBox.replaceChildren(
      h('div', { class: 'table-wrap' },
        h('table', { class: 'asset-list' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Symbol'), h('th', {}, 'Name'), h('th', { class: 'r' }, 'Price'), h('th', {}, 'Day range'), h('th', {}, 'Status'))),
          h('tbody', {}, rows)
        )
      ),
      ...(moreBtn ? [h('div', { class: 'actions', style: 'margin-top:14px' }, moreBtn)] : [])
    )

    const missing = visible.map(a => a.symbol).filter(sym => !quotesById.has(sym) && !pending.has(sym))
    if (missing.length) loadQuotes(missing)
  }
  filterInput.addEventListener('input', () => {
    visibleCount = PAGE_SIZE
    renderList()
  })

  async function loadQuotes(symbols) {
    symbols.forEach(sym => pending.add(sym))
    try {
      const { quotes } = await api('/api/quotes?symbols=' + symbols.map(encodeURIComponent).join(','))
      for (const qt of quotes) quotesById.set(qt.symbol, qt.ok ? qt : 'error')
    } catch {
      symbols.forEach(sym => quotesById.set(sym, 'error'))
    } finally {
      symbols.forEach(sym => pending.delete(sym))
    }
    loadedFig.v.textContent = `${quotesById.size} of ${assets.length}`
    renderList()
  }

  async function loadDirectory() {
    try {
      assets = (await api('/api/registry')).assets
      assetsFig.v.textContent = String(assets.length)
      loadedFig.v.textContent = `0 of ${assets.length}`
      renderList()
    } catch (e) {
      countLine.textContent = ''
      listBox.replaceChildren(h('p', { class: 'form-error' }, e.message))
    }
  }

  async function lookup(sym) {
    detailBox.scrollIntoView({ behavior: 'smooth', block: 'start' })
    detailBox.replaceChildren(h('p', { class: 'muted' }, `Looking up ${sym}\u2026`))
    try {
      const r = await api('/api/research?symbol=' + encodeURIComponent(sym))
      const q = r.quote

      let quickActions = null
      if (r.tradable) {
        const dcaForm = h('form', { class: 'form' },
          h('p', { class: 'form-title' }, 'Start a DCA plan'),
          field('USD per buy', h('input', { name: 'amountUsd', class: 'num', inputmode: 'decimal', placeholder: '10', required: true })),
          field('Every (hours)', h('input', { name: 'intervalHours', class: 'num', inputmode: 'numeric', placeholder: '24', required: true })),
          h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Create plan'))
        )
        onSubmit(dcaForm, f => api('/api/dca', { symbol: r.symbol, amountUsd: Number(f.get('amountUsd')), intervalHours: Number(f.get('intervalHours')) }), p => `DCA plan created for ${p.symbol}`)

        const targetForm = h('form', { class: 'form' },
          h('p', { class: 'form-title' }, 'Add to portfolio targets'),
          field('Target percent', h('input', { name: 'pct', class: 'num', inputmode: 'decimal', placeholder: '10', required: true })),
          h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Add target'))
        )
        onSubmit(
          targetForm,
          async f => {
            const pct = Number(f.get('pct'))
            if (!(pct > 0 && pct <= 100)) throw new Error('Enter a percent between 0 and 100.')
            const cfg = await api('/api/portfolio/config')
            return api('/api/portfolio/targets', { targets: { ...cfg.targets, [r.symbol]: pct }, driftThresholdPct: cfg.driftThresholdPct })
          },
          () => `${r.symbol} added to your portfolio targets`
        )

        quickActions = h('div', {},
          h('div', { class: 'quick-actions' }, dcaForm, targetForm),
          h('div', { class: 'actions', style: 'margin-top:10px' },
            h('a', { class: 'btn btn-quiet btn-sm', href: '#/dca' }, 'Manage all DCA plans'),
            h('a', { class: 'btn btn-quiet btn-sm', href: '#/portfolio' }, 'Manage portfolio targets'))
        )
      }

      detailBox.replaceChildren(
        h('div', {},
          secHead(r.symbol, q.halted ? 'Trading halted right now' : r.tradable ? 'Tradable on Robinhood Chain mainnet' : 'No live pool on Robinhood Chain yet'),
          h('div', { class: 'figures' },
            fig('Mid price', usd(q.mid), `bid ${usd(q.bid)} \u00b7 ask ${usd(q.ask)}`).el,
            fig('Day range', `${usd(q.dailyLow)}\u2013${usd(q.dailyHigh)}`, q.halted ? 'Halted' : 'Live').el
          ),
          h('p', { class: 'muted' }, r.note),
          quickActions
        )
      )
    } catch (e) {
      detailBox.replaceChildren(h('p', { class: 'form-error' }, e.message))
    }
  }

  searchForm.addEventListener('submit', e => {
    e.preventDefault()
    const sym = filterInput.value.trim().toUpperCase()
    if (sym) lookup(sym)
  })

  loadDirectory()
  const prefill = (routeParams.get('symbol') || '').toUpperCase()
  if (prefill) {
    filterInput.value = prefill
    lookup(prefill)
  } else {
    detailBox.replaceChildren(empty('Pick a symbol from the list, or search above.', 'SERV Reasoning summarizes where its price sits, and checks whether Ledgerly can actually trade it onchain right now. Nothing here is financial advice.'))
  }

  return {
    root: h('div', {},
      viewHead('Terminal', "Every tokenized stock and ETF Robinhood has live on its chain, straight from Robinhood's own asset registry. Pick one, or search, to see its quote and SERV's summary, then DCA or add it to your portfolio right here."),
      statCards,
      h('section', { class: 'sec' }, secHead('Look up an asset'), searchForm, detailBox),
      h('section', { class: 'sec' }, secHead('Live assets'), countLine, listBox)
    ),
    update() {}
  }
}

function portfolio() {
  const summary = h('div')
  const targetsInput = h('input', { name: 'targets', placeholder: 'NVDA 40, AAPL 30', required: true, autocomplete: 'off', spellcheck: 'false' })
  const driftInput = h('input', { name: 'drift', class: 'num', inputmode: 'decimal', placeholder: '5' })
  let dirty = false
  if (routeParams.get('symbol')) {
    targetsInput.value = routeParams.get('symbol').toUpperCase() + ' '
    dirty = true // keep the prefill: skip the auto-sync from loaded targets below until the form is submitted or reset
  }
  targetsInput.addEventListener('input', () => (dirty = true))

  const targetsForm = h('form', { class: 'form wide-first' }, field('Assets and percent, comma separated', targetsInput), field('Drift threshold (points)', driftInput), h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, 'Save targets')))
  targetsForm.addEventListener('ledgerly:reset', () => (dirty = false))
  onSubmit(
    targetsForm,
    f => {
      const targets = {}
      for (const part of String(f.get('targets')).split(',')) {
        const m = part.trim().match(/^([A-Za-z0-9.]{1,10})[\s:=]+([0-9.]+)%?$/)
        if (!m) throw new Error('Write targets like: NVDA 40, AAPL 30')
        targets[m[1].toUpperCase()] = Number(m[2])
      }
      const drift = f.get('drift')
      return api('/api/portfolio/targets', drift ? { targets, driftThresholdPct: Number(drift) } : { targets })
    },
    () => 'Targets saved'
  )

  const rebalanceBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: e => act(e.currentTarget, () => api('/api/portfolio/rebalance', {}), r => (r.results.length ? r.results.map(x => `${x.trade.side} ${x.trade.symbol}: ${x.result.status.replace('_', ' ')}`).join(' · ') : r.message)) }, 'Rebalance now')
  const root = h('div', {}, viewHead('Portfolio', 'Target weights against what is held now. Ledgerly rebalances only when an asset drifts past your threshold.', rebalanceBtn), summary, h('section', { class: 'sec' }, secHead('Set targets', 'Whatever is not allocated stays in USDG cash'), targetsForm))

  return {
    root,
    update(s) {
      const pf = s.portfolio
      if (!pf || pf.error) return summary.replaceChildren(empty('Could not load the portfolio.', pf ? pf.error : ''))
      if (!pf.plan) return summary.replaceChildren(empty('No targets yet.', 'Set them below, for example NVDA 40, AAPL 30. The rest stays in cash.'))
      if (!dirty && document.activeElement !== targetsInput) targetsInput.value = pf.plan.rows.map(r => `${r.symbol} ${r.targetPct}`).join(', ')
      if (document.activeElement !== driftInput) driftInput.value = pf.cfg.driftThresholdPct

      const p = pf.plan
      const colors = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)']
      const bar = (label, segs) => {
        const b = h('div', { class: 'bar', role: 'img', 'aria-label': `${label}: ${segs.map(x => `${x.name} ${x.v.toFixed(0)}%`).join(', ')}` })
        for (const x of segs) {
          const i = h('i')
          i.style.width = Math.max(0, x.v) + '%'
          i.style.background = x.c
          b.append(i)
        }
        return h('div', { class: 'alloc-row' }, h('span', {}, label), b)
      }
      const now = [...p.rows.map((r, i) => ({ name: r.symbol, v: r.currentPct, c: colors[i % 4] })), { name: 'Cash', v: p.cashPct, c: 'var(--cash)' }]
      const tgt = [...p.rows.map((r, i) => ({ name: r.symbol, v: r.targetPct, c: colors[i % 4] })), { name: 'Cash', v: p.cashTargetPct, c: 'var(--cash)' }]
      const legend = h('div', { class: 'legend' }, now.map(x => { const s = h('span', {}, x.name); s.style.setProperty('--c', x.c); return s }))

      const hot = r => Math.abs(r.driftPct) >= pf.cfg.driftThresholdPct
      const signed = n => (n > 0 ? '+' : '') + n.toFixed(1)
      summary.replaceChildren(
        h('section', { class: 'sec' },
          secHead('Allocation', `${usd(p.totalUsd)} total · from your wallet`),
          h('div', { class: 'alloc' }, bar('Now', now), bar('Target', tgt)),
          legend
        ),
        h('section', { class: 'sec' },
          secHead('Drift', `Rebalance when an asset is ${pf.cfg.driftThresholdPct}+ points off target`),
          h('div', { class: 'table-wrap' },
            h('table', {},
              h('thead', {}, h('tr', {}, h('th', {}, 'Asset'), h('th', { class: 'r' }, 'Value'), h('th', { class: 'r' }, 'Now'), h('th', { class: 'r' }, 'Target'), h('th', { class: 'r' }, 'Drift'))),
              h('tbody', {},
                p.rows.map(r => h('tr', {}, h('td', {}, r.symbol), h('td', { class: 'r num' }, usd(r.valueUsd)), h('td', { class: 'r num' }, pct(r.currentPct)), h('td', { class: 'r num' }, pct(r.targetPct)), h('td', { class: 'r num' + (hot(r) ? ' drift-hot' : '') }, signed(r.driftPct)))),
                h('tr', {}, h('td', {}, 'Cash (USDG)'), h('td', { class: 'r num' }, usd(p.cashUsd)), h('td', { class: 'r num' }, pct(p.cashPct)), h('td', { class: 'r num' }, pct(p.cashTargetPct)), h('td', { class: 'r' }, ''))
              )
            )
          ),
          h('p', { class: 'muted' }, p.trades.length ? 'A rebalance now would: ' + p.trades.map(t => `${t.side} ${usd(t.amountUsd)} ${t.symbol}`).join(', ') + '.' : 'Within tolerance. No trades needed.')
        )
      )
    }
  }
}

function dca() {
  const plansBox = h('div')
  const symbolInput = h('input', { name: 'symbol', placeholder: 'NVDA', required: true, maxlength: 10, autocomplete: 'off', spellcheck: 'false' })
  if (routeParams.get('symbol')) symbolInput.value = routeParams.get('symbol').toUpperCase()
  const addForm = h('form', { class: 'form' },
    h('p', { class: 'form-title' }, 'New plan'),
    field('Asset', symbolInput),
    field('USD per buy', h('input', { name: 'amountUsd', class: 'num', inputmode: 'decimal', placeholder: '10', required: true })),
    field('Every (hours)', h('input', { name: 'intervalHours', class: 'num', inputmode: 'numeric', placeholder: '24', required: true })),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add plan'))
  )
  onSubmit(addForm, f => api('/api/dca', { symbol: f.get('symbol'), amountUsd: Number(f.get('amountUsd')), intervalHours: Number(f.get('intervalHours')) }), p => `Plan created for ${p.symbol}`)
  const runBtn = h('button', { class: 'btn', type: 'button', onclick: e => act(e.currentTarget, () => api('/api/dca/run', {}), r => (r.length ? r.map(x => `${x.symbol}: ${x.outcome.replace(/_/g, ' ')}`).join(' · ') : 'No plans are due yet')) }, 'Run due plans now')

  return {
    root: h('div', {}, viewHead('DCA', 'Recurring buys. Each run, SERV Reasoning reads the day and decides whether to buy, skip, or scale the amount between half and one and a half times.', runBtn), h('section', { class: 'sec' }, secHead('Plans'), plansBox, addForm)),
    update(s) {
      const active = s.plans.filter(p => p.active)
      if (!active.length) return plansBox.replaceChildren(empty('No plans yet.', 'Add one below. Plans run on a timer while the app is running.'))
      const next = p => (p.lastRunAt ? dayTime(new Date(new Date(p.lastRunAt).getTime() + p.intervalHours * 3600e3).toISOString()) : 'Next check')
      plansBox.replaceChildren(
        h('div', { class: 'table-wrap' },
          h('table', {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Asset'), h('th', { class: 'r' }, 'Planned'), h('th', { class: 'r' }, 'Every'), h('th', {}, 'Last run'), h('th', {}, 'Next'), h('th', {}, ''))),
            h('tbody', {}, active.map(p => h('tr', {}, h('td', {}, p.symbol), h('td', { class: 'r num' }, usd(p.amountUsd)), h('td', { class: 'r num' }, p.intervalHours + ' h'), h('td', { class: 'muted' }, p.lastRunAt ? dayTime(p.lastRunAt) : 'Never'), h('td', { class: 'muted' }, next(p)), h('td', { class: 'r' }, h('button', { class: 'btn btn-quiet btn-sm btn-danger', type: 'button', onclick: e => act(e.currentTarget, () => api('/api/dca/cancel', { id: p.id }), () => 'Plan cancelled') }, 'Cancel')))))
          )
        )
      )
    }
  }
}

function payments() {
  const payeesBox = h('div')
  const recent = h('div')
  const datalist = h('datalist', { id: 'payee-list' })
  const payeeForm = h('form', { class: 'form wide-first' }, h('p', { class: 'form-title' }, 'Add a payee'), field('Address', h('input', { name: 'address', class: 'mono', placeholder: '0x…', required: true, autocomplete: 'off', spellcheck: 'false' })), field('Name', h('input', { name: 'label', placeholder: 'Alice, designer', required: true, maxlength: 60 })), h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, 'Add payee')))
  onSubmit(payeeForm, f => api('/api/payee', { address: f.get('address'), label: f.get('label') }), () => 'Payee added')

  const payForm = h('form', { class: 'form wide-first' },
    h('p', { class: 'form-title' }, 'New payment'),
    field('To (must be a payee)', h('input', { name: 'to', class: 'mono', list: 'payee-list', placeholder: '0x…', required: true, autocomplete: 'off', spellcheck: 'false' })),
    field('Type', h('select', { name: 'module' }, h('option', { value: 'payroll' }, 'Payroll'), h('option', { value: 'bills' }, 'Bill'))),
    field('USD', h('input', { name: 'amountUsd', class: 'num', inputmode: 'decimal', placeholder: '25', required: true })),
    field('Milestone or invoice', h('input', { name: 'memo', maxlength: 120, placeholder: 'Logo milestone' })),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Pay'))
  )
  onSubmit(payForm, f => api('/api/pay', { module: f.get('module'), to: f.get('to'), amountUsd: Number(f.get('amountUsd')), memo: f.get('memo') || '' }), r => r.message.split('. ')[0])

  return {
    root: h('div', {}, viewHead('Payments', 'Payroll and bills. Money only goes to addresses you registered first, and large amounts wait for your approval.'),
      h('section', { class: 'sec' }, secHead('Payees', 'The allowlist'), payeesBox, payeeForm),
      h('section', { class: 'sec' }, secHead('Send a payment'), payForm, datalist),
      h('section', { class: 'sec' }, secHead('Recent payments'), recent)),
    update(s) {
      datalist.replaceChildren(...s.payees.map(p => h('option', { value: p.address }, p.label)))
      payeesBox.replaceChildren(s.payees.length
        ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Address'))), h('tbody', {}, s.payees.map(p => h('tr', {}, h('td', {}, p.label), h('td', { class: 'addr' }, p.address))))))
        : empty('No payees yet.', 'Payments to an address that is not listed here are always refused.'))
      const pays = s.ledger.filter(e => e.module === 'payroll' || e.module === 'bills').slice(0, 8)
      recent.replaceChildren(pays.length ? feedList(pays) : empty('No payments yet.', ''))
    }
  }
}

function ledger() {
  let module = ''
  let verdict = ''
  const body = h('div')
  const count = h('span', { class: 'hint' })
  const sel = (label, opts, set) => field(label, h('select', { onchange: e => { set(e.target.value); if (S) render() } }, opts.map(([v, t]) => h('option', { value: v }, t))))
  function render() {
    let rows = S.ledger
    if (module) rows = rows.filter(e => e.module === module)
    if (verdict) rows = rows.filter(e => (verdict === 'executed' ? e.executed : e.verdict === verdict))
    count.textContent = `${rows.length} of the latest ${S.ledger.length}`
    if (!rows.length) return body.replaceChildren(empty('Nothing matches.', S.ledger.length ? 'Try clearing a filter.' : 'Decisions appear here as soon as the agent acts.'))
    body.replaceChildren(
      h('div', { class: 'table-wrap' },
        h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'Action'), h('th', { class: 'r' }, 'Amount'), h('th', {}, 'Result'))),
          h('tbody', {}, rows.map(e => h('tr', {},
            h('td', { class: 'num muted' }, dayTime(e.ts)),
            h('td', {}, h('strong', {}, `${MODULES[e.module] || e.module} · ${e.action}`), reason(e.reasoning, 'sub'), e.txHash ? h('span', { class: 'sub' }, 'Transaction ', h('a', { href: S.explorer + e.txHash, target: '_blank', rel: 'noopener noreferrer' }, short(e.txHash))) : null),
            h('td', { class: 'r num' }, e.amountUsd != null ? usd(e.amountUsd) : ''),
            h('td', {}, mark(e))
          )))
        )
      )
    )
  }
  return {
    root: h('div', {}, viewHead('Ledger', 'Every decision, with the reason it was made. Held and refused actions are kept too.'),
      h('div', { class: 'filters' },
        sel('Type', [['', 'All'], ['dca', 'DCA'], ['rebalance', 'Rebalance'], ['payroll', 'Payroll'], ['bills', 'Bills']], v => (module = v)),
        sel('Outcome', [['', 'All'], ['executed', 'Ran'], ['needs_approval', 'Held'], ['deny', 'Denied']], v => (verdict = v))),
      h('section', { class: 'sec' }, secHead('Decisions', count), body)),
    update: render
  }
}

/* ---------- chrome: banner, sidebar, routing ---------- */
function paintChrome() {
  const banner = $('#banner')
  const msg = $('#banner-msg')
  const net = S.network === 'mainnet' ? 'Robinhood Chain mainnet' : 'Robinhood Chain testnet'
  if (S.live) {
    banner.className = 'banner live'
    msg.textContent = MODE === 'user' ? `Live · ${net} · your own wallet signs every transaction` : `Live · ${net} · real funds`
  } else {
    banner.className = 'banner'
    msg.textContent = `Trading is off: ${S.offReason || 'it has not been switched on.'}`
  }
  $('#side-net').textContent = S.network === 'mainnet' ? 'Robinhood Chain · mainnet 4663' : 'Robinhood Chain · testnet 46630'
  $('#side-wallet').textContent = S.wallet ? short(S.wallet) : 'No wallet'
  const copy = $('#copy-wallet')
  copy.hidden = !S.wallet
  const badge = $('#nav-count')
  badge.hidden = !S.pending.length
  badge.textContent = S.pending.length
}

async function refresh() {
  try {
    S = await api('/api/state')
    paintChrome()
    if (!current) mount()
    else current.update(S)
    if (wallet.account) loadWalletBalance()
  } catch (e) {
    const banner = $('#banner')
    banner.className = 'banner error'
    $('#banner-msg').textContent = 'Cannot reach the Ledgerly server. Is it still running?'
  }
}

const ROUTES = { overview, research, portfolio, dca, payments, ledger }
const TITLES = { overview: 'Overview', research: 'Terminal', portfolio: 'Portfolio', dca: 'DCA', payments: 'Payments', ledger: 'Ledger' }
let firstRoute = true

let wanted = 'overview'
/** Query params from the current hash, e.g. #/dca?symbol=NVDA. Read once at view construction time. */
let routeParams = new URLSearchParams()

function mount() {
  current = ROUTES[wanted]()
  $('#view').replaceChildren(current.root)
  current.update(S)
}

function route() {
  const hash = location.hash.replace('#/', '')
  const qi = hash.indexOf('?')
  const name = qi === -1 ? hash : hash.slice(0, qi)
  routeParams = new URLSearchParams(qi === -1 ? '' : hash.slice(qi + 1))
  wanted = ROUTES[name] ? name : 'overview'
  document.title = `${TITLES[wanted]} · Ledgerly`
  document.querySelectorAll('#nav a').forEach(a => (a.dataset.view === wanted ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')))
  current = null
  if (S) mount()
  else {
    $('#view').replaceChildren(h('div', {}, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' })))
  }
  if (!firstRoute) $('#main').focus({ preventScroll: true })
  firstRoute = false
  scrollTo(0, 0)
}

$('#copy-wallet').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(S.wallet)
    toast('Wallet address copied')
  } catch {
    toast('Could not copy. Select the address instead.', true)
  }
})

$('#wallet-btn').addEventListener('click', async () => {
  if (!wallet.account) return void connectWallet()
  try {
    await navigator.clipboard.writeText(wallet.account)
    toast('Your wallet address copied')
  } catch {
    toast('Could not copy. Select the address instead.', true)
  }
})
$('#wallet-x').addEventListener('click', () => {
  remember(true)
  setAccount(null)
  toast('Disconnected from this page. Your wallet may still list the site as connected.')
})
if (HAS_WALLET && provider()) {
  // Restore a previous connection silently (no popup), unless the user disconnected on purpose.
  if (!wasOff()) provider().request({ method: 'eth_accounts' }).then(a => a[0] && setAccount(a[0])).catch(() => {})
  if (provider().on) provider().on('accountsChanged', a => !wasOff() && setAccount(a[0] || null))
}

if (MODE === 'owner') {
  // Sign-in: when the server has a password, send visitors without a session to the login page.
  fetch('/api/session')
    .then(r => r.json())
    .then(s => {
      if (!s.authRequired) return
      if (!s.authed) return void location.replace('/login')
      $('#signout').hidden = false
    })
    .catch(() => {})
  $('#signout').addEventListener('click', async () => {
    try {
      await fetch('/api/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    } finally {
      location.replace('/login')
    }
  })
} else if (MODE === 'user') {
  // A signed-in account: its own wallet and its own sign-out. There is no owner login here.
  $('#signout').hidden = false
  $('#signout').addEventListener('click', async () => {
    try {
      await fetch('/api/signout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    } finally {
      location.replace('/account')
    }
  })
  const del = $('#delete-account')
  del.hidden = false
  del.addEventListener('click', async () => {
    if (!confirm('Delete your account and all of its saved plans, payees and ledger? Your wallet and funds are not affected. This cannot be undone.')) return
    const password = prompt('Enter your password to confirm.')
    if (!password) return
    try {
      await api('/api/account/delete', { password })
      location.replace('/account')
    } catch (e) {
      toast(e.message, true)
    }
  })
}

addEventListener('hashchange', route)
document.addEventListener('visibilitychange', () => !document.hidden && refresh())
// Hosted copies refresh less often (each refresh reads the database).
{
  const tick = async () => {
    if (!document.hidden) await refresh()
    setTimeout(tick, S && S.hosted ? 20000 : 5000)
  }
  setTimeout(tick, 5000)
}

route()
refresh()
