// The dashboard is one page (web/app.html) shown two ways: owner and signed-in account.
// The mode is chosen by the address (/app, /me), so each address needs a real file. Real files work on
// any host, unlike routing rules. They are generated from app.html so they can never drift apart.
export const PAGES = { me: 'Your account' }

export function renderPage(appHtml, title) {
  return appHtml
    .replace('<html lang="en">', '<html lang="en">\n<!-- Generated from app.html by `npm run build:vercel`. Do not edit by hand. -->')
    .replace('<title>Ledgerly &middot; Dashboard</title>', `<title>Ledgerly &middot; ${title}</title>`)
}
