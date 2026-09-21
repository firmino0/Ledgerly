// Show the "Create an account" buttons only when this site has accounts switched on.
fetch('/api/session')
  .then(r => r.json())
  .then(s => {
    if (s.accountsEnabled) document.querySelectorAll('[data-accounts]').forEach(e => (e.hidden = false))
  })
  .catch(() => {})
