# goo — GED Odoo Overseer

Local web app for Odoo dev: manages server instances, multi-repo git workflows,
test runs, and PR tracking. Single stdlib-Python server + Owl 3 frontend.

## Stack

- **Backend**: `goo.py` — single-file, Python 3.10+, **stdlib only** (no pip deps).
- **Frontend**: `static/` — Owl 3, served as-is (**no bundler**, no build step).
- Runs straight from the checkout: `python3 goo.py` (UI on `127.0.0.1:8068`).

## Layout

- `goo.py` — the whole server (routing, git, db, Odoo process mgmt).
- `addons/` — Odoo addons goo injects (e.g. `autologin`) to the odoo instance
  in the addons path
- `static/src/` a owl 3 frontend application
- `static/src/main.js` — app entry

## Commands

- `python3 goo.py` — run (add `--open` to launch the browser).
- `npm run lint` / `npm run lint:fix` — eslint (`static/src` only).
- `npm run format` — prettier (js/css/html/md).
- `ruff check --fix` / `ruff format` — Python lint+format.
- `pre-commit` runs ruff + prettier + eslint on changed files.

## Conventions

- Python: ruff, line length 100, target py310; `static/` excluded from ruff.
- Frontend: lint/format only touch `static/src` — `static/lib/` is vendored, leave it.
- Keep the server dependency-free — no pip packages.

## Gotchas

- Needs on PATH: `git`, `psql`/`dropdb`, `gh` (authed), Chrome (for hoot tests).
- A working Odoo checkout + venv is required — goo launches `odoo-bin` (port 8069).
- owl 3 is an early release version of owl. It is not fully compatible with owl 2