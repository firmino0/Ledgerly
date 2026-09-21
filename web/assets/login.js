const form = document.getElementById('form')
const input = document.getElementById('password')
const error = document.getElementById('error')
const submit = document.getElementById('submit')

// Already signed in, or no login needed (running locally): go straight to the dashboard.
fetch('/api/session')
  .then(r => r.json())
  .then(s => {
    if (s.authed) location.replace('/app')
  })
  .catch(() => {})

form.addEventListener('submit', async e => {
  e.preventDefault()
  error.hidden = true
  submit.disabled = true
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: input.value }) })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(json.error || `Sign in failed (${res.status})`)
    location.replace('/app')
  } catch (err) {
    error.textContent = err.message
    error.hidden = false
    input.select()
  } finally {
    submit.disabled = false
  }
})
