// Show the "Try the sandbox" buttons only when this site has a sandbox switched on.
fetch('/api/session')
  .then(r => r.json())
  .then(s => {
    if (s.sandboxEnabled) document.querySelectorAll('[data-sandbox]').forEach(e => (e.hidden = false))
    if (s.accountsEnabled) document.querySelectorAll('[data-accounts]').forEach(e => (e.hidden = false))
  })
  .catch(() => {})
