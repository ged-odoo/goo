# goo — GED Odoo Overseer

`goo` is a local web app for Odoo development, replacing `odev`. It manages Odoo server instances, git workflows across multiple repositories, test execution, and PR tracking — all from the browser, backed by a single stdlib Python server.

## What it does today (odev)

The current `odev` tool is a single-file Python TUI (~1600 lines) that handles:

- **Target system** — Hierarchical targets (e.g. `community`, `enterprise`, `19.0e`) that define which repos, branches, database, and server args to use. Child targets inherit from parents, so a task branch only needs to declare what's different.
- **Multi-repo management** — Tracks community, enterprise, and tutorials repos. Tab to cycle between them. Shows branch, dirty state, ahead/behind indicators in the status bar.
- **Odoo server lifecycle** — Start/stop the server with the right addons path, database, and flags. Auto-detects new databases and applies `on_create_args` (e.g. `-i sale_management`). Detects "Registry loaded" to know when the server is ready.
- **Test running** — Python tests via `--test-tags`, JS tests via hoot (`/web:WebSuite`), tour shortcuts.
- **PR tracking** — Track GitHub PRs and poll their status from both the GitHub API and Odoo's mergebot (review status, CI, staging).
- **Git integration** — Run git commands in the active repo, open tig, auto-fetch stale branches in the background.
- **Browser integration** — Open Odoo or the JS test runner in Chrome, with optional test filters.
- **CLI mode** — `odev st`, `odev pr`, `odev help` work outside the TUI for quick checks.

## Goals for oo

### Keep what works

- The target/inheritance model is the core abstraction and should be preserved
- The TUI with bottom chrome (status bar + prompt) is effective
- Background fetching and sync indicators are valuable
- PR tracking with mergebot integration is unique and useful

### Improve

- **Architecture** — Break the monolith into modules (config, git, server, tui, targets, pr tracking)
- **Configuration** — Move hardcoded paths, repos, and credentials to a config file (`~/.config/oo/config.toml` or similar)
- **Error handling** — The current tool silently swallows many errors; surface them clearly
- **Extensibility** — Plugin or hook system so custom workflows can be added without modifying core code
- **Testing** — The current tool has zero tests; oo should be testable from the start
- **Startup time** — Lazy-load expensive operations (git status, repo sync) to keep the TUI snappy

### New ideas to explore

- **Workspace profiles** — Support multiple Odoo work directories (not just `/home/odoo/work`)
- **Smart server restart** — Watch for file changes and auto-restart (or leverage `--dev all` more intelligently)
- **Log filtering/search** — Parse Odoo logs, highlight errors, filter by module
- **Database snapshots** — Save/restore database states for quick context switching between tasks
- **Runbot integration** — Open the runbot build for the current branch, trigger rebuilds
- **Shell completions** — Tab completion for targets, commands, test tags
- **Task branches** — Streamline the create-branch → work → PR → merge cycle
- **Notifications** — Desktop notifications when tests finish, server is ready, or a PR status changes

## Project structure (planned)

```
oo/
├── README.md
├── pyproject.toml
├── src/
│   └── oo/
│       ├── __init__.py
│       ├── cli.py          # Entry point, argument parsing
│       ├── config.py       # Configuration loading (TOML/JSON)
│       ├── targets.py      # Target resolution and inheritance
│       ├── server.py       # Odoo process management
│       ├── git.py          # Git operations across repos
│       ├── pr.py           # PR tracking and mergebot
│       ├── tui/
│       │   ├── __init__.py
│       │   ├── app.py      # Main TUI loop
│       │   ├── chrome.py   # Status bar and prompt rendering
│       │   └── terminal.py # Terminal escape helpers
│       └── utils.py
└── tests/
```

## Requirements

- Python 3.10+
- git
- PostgreSQL (psql, dropdb)
- gh (GitHub CLI) for PR features
- No pip dependencies (stdlib only, like odev)

## Current status

Working: a stdlib Python server (`goo.py`) with an Owl 3 frontend (`static/`).
