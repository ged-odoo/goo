# goo — GED Odoo Overseer

`goo` is a local web app for Odoo development. It manages Odoo server instances,
git workflows across multiple repositories, test execution, and PR tracking —
all from the browser, backed by a single stdlib Python server (`goo.py`) with an
Owl 3 frontend (`static/`, served as-is, no bundler).

## Requirements

- **Python 3.10+** — the server is stdlib only, no pip dependencies.
- **git** — for branch/PR state across repos.
- **PostgreSQL** — `psql` / `dropdb` on the PATH (database management).
- A working **Odoo checkout + virtualenv** — goo launches `odoo-bin` from your
  community repo, so its Python dependencies must be installed in a venv.
- **gh** ([GitHub CLI](https://cli.github.com/)), authenticated, for the PR
  features (listing PRs, creating/closing them). Runbot/mergebot state is scraped
  over plain HTTP and needs no auth.
- **Google Chrome** — only for running the JS (hoot) test suites headlessly.

## Install

No installation step — it runs straight from the checkout:

```bash
git clone <repo-url> goo
cd goo
python3 goo.py
```

Optionally make it a global command by adding an alias to your `~/.bashrc`:

```bash
alias goo='/path/to/goo/goo.py'   # goo.py is executable (has a shebang)
```

For the frontend dev tooling (lint/format) only, install the npm dev deps:

```bash
npm install
```

## Start

```bash
python3 goo.py          # then open the printed URL
python3 goo.py --open   # opens it in your browser automatically
```

The UI is served at **http://127.0.0.1:8068** (the Odoo servers it launches use
port 8069). Stop goo with `Ctrl-C`.

## Configure

Everything is configured from the **Config** tab in the UI — no config files to
edit by hand:

- **Repositories** — the local paths and GitHub slugs of your repos (community,
  enterprise, …).
- **work dir / venv / database credentials** — where your repos live, the command
  that activates your Odoo venv, and the Postgres user/password.
- **Storage** — config and favorites live in the browser's localStorage by
  default; set a JSON file path to persist them on disk and share across browsers.

**Targets** are the core concept: a named combination of a database, per-repo
branches (`repo:branch`), and start args. Manage them in the **Targets** tab
(create from an existing one, edit, star). Starring a target shows it on the
Dashboard.
