# goo odoo session bridge

A small browser extension that lets goo's "show Odoo task stage" setting
(Configuration screen) read task stages from odoo.com using your own browser
session, instead of a separate API key.

It reads the `session_id` cookie of odoo.com through the browser's own
`chrome.cookies` API — the same sanctioned access any extension has to its
declared sites — and posts it to goo on `http://127.0.0.1:8068`, whenever it
changes and every few minutes as a heartbeat. goo keeps it in memory only
(`backend/server.py`'s `ODOO_SESSION`); it is never written to goo's config
file or anywhere on disk, and this extension never reads or decrypts the
browser's own cookie/credential storage — only the one cookie value the
cookies API hands it for a site it's allowed to see.

goo only accepts this extension's own pinned origin
(`chrome-extension://agbhbdlhocoednglikaebfoinablbkci`, fixed by this
manifest's `key`) on `/api/odoo-session` — no other extension or site can set
it.

## Install

1. Open `chrome://extensions` (or `brave://extensions`).
2. Turn on _Developer mode_ (top right).
3. _Load unpacked_ → pick this folder (`extension/odoo-session/`).
4. Open an odoo.com tab you're logged into. goo picks up the session right
   away, and again whenever it changes.

A goo restart loses the session from memory; the extension resends it within
a few minutes on its own, or reload any odoo.com tab to send it immediately.
