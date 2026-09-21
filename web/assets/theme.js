// Applies a saved theme before first paint (loaded in <head>), and wires any [data-theme-toggle] button.
;(() => {
  const root = document.documentElement
  try {
    const saved = localStorage.getItem('ledgerly-theme')
    if (saved === 'light' || saved === 'dark') root.dataset.theme = saved
  } catch {}
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
        const next = dark ? 'light' : 'dark'
        root.dataset.theme = next
        try {
          localStorage.setItem('ledgerly-theme', next)
        } catch {}
      })
    })
  })
})()
