const $ = id => document.getElementById(id)
const formIn = $('form-in')
const formUp = $('form-up')

function show(which) {
  const signIn = which === 'in'
  formIn.hidden = !signIn
  formUp.hidden = signIn
  $('tab-in').setAttribute('aria-selected', String(signIn))
  $('tab-up').setAttribute('aria-selected', String(!signIn))
  ;(signIn ? $('in-user') : $('up-user')).focus()
}
$('tab-in').addEventListener('click', () => show('in'))
$('tab-up').addEventListener('click', () => show('up'))
if (location.hash === '#create') show('up')

// Accounts only exist when the site owner switched them on. If you are already signed in, go straight to your dashboard.
fetch('/api/session', { headers: { 'x-ledgerly-mode': 'user' } })
  .then(r => r.json())
  .then(s => {
    if (!s.user || !s.user.enabled) {
      $('off').hidden = false
      formIn.hidden = formUp.hidden = true
    } else if (s.user.active) {
      location.replace('/me')
    }
  })
  .catch(() => {})

async function submit(form, url, body, errorEl) {
  errorEl.hidden = true
  const btn = form.querySelector('button[type=submit]')
  btn.disabled = true
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(json.error || `Something went wrong (${res.status})`)
    location.replace('/me')
  } catch (err) {
    errorEl.textContent = err.message
    errorEl.hidden = false
  } finally {
    btn.disabled = false
  }
}

formIn.addEventListener('submit', e => {
  e.preventDefault()
  submit(formIn, '/api/signin', { username: $('in-user').value, password: $('in-pass').value }, formIn.querySelector('.in-error'))
})
formUp.addEventListener('submit', e => {
  e.preventDefault()
  submit(formUp, '/api/signup', { username: $('up-user').value, password: $('up-pass').value, accept: $('up-accept').checked }, formUp.querySelector('.up-error'))
})
