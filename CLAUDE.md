# goo — GED Odoo Overseer

Local web app for Odoo dev: manages server instances, multi-repo git workflows,
test runs, and PR tracking. Single stdlib-Python server + Owl 3 frontend.

## Stack

- **Backend**: the `backend/` package, Python 3.10+, **stdlib only** (no pip deps).
- **Frontend**: `static/src/` — Owl 3, authored as ES modules with real
  `import { … } from "@odoo/owl"`. `npm run build` (esbuild) bundles `static/src/main.js`
  → **`static/dist/app.js`**, which is **committed**, so the app still runs straight from
  the checkout with no build/install at dev time. The Owl runtime itself
  (`static/lib/owl.js`) stays a classic global `<script>`; the build aliases `@odoo/owl`
  to `vendor/owl-orm/owl-global.js`, a shim re-exporting `globalThis.owl`, so the whole
  bundle (app + vendored `@odoo/owl-orm`) shares one `window.owl` reactivity. `npm run
watch` rebuilds on change. Rebuild + commit `static/dist/app.js` whenever you edit
  `static/src/` or `vendor/owl-orm/`.
- Runs straight from the checkout: `python3 goo.py` (UI on `127.0.0.1:8068`).

## Layout

- `goo.py` — thin launcher at the repo root (executable, shebang); just calls
  `backend.server.main()`. Keeps `python3 goo.py` / `alias goo=…/goo.py` working.
- `backend/` — the Python package (import with `from backend import …`):
  - `server.py` — the HTTP server: routing + thin request handlers, the `EventBus`
    (SSE), and the **process subsystem** (`OdooManager` + the PTY/CLI websocket
    handlers + the goo self-update), which owns its own inherent process
    side-effects. `GOO_DIR` is the repo root (parent of this package) — where
    `static/`, `addons/`, and the git checkout live.
  - `effects.py` — the IO seam: the one place raw subprocess / network / filesystem
    happen (`run`, `http_get`, `read_text`/`list_dir`/`read_json_file`/…,
    `log_request`). Fake this in tests.
  - `services.py` — domain services over the seam (`GitService`, `GitHubService`,
    `RunbotService`, `MergebotService`, `DatabaseService`, `AddonsService`); fetch +
    parse external state, cached server-side where it's worth it (PRs/runbot/
    mergebot/databases have TTLs; git reads are volatile so they're uncached). Also
    `ConfigStore` — the server-owned config, persisted to `~/.config/goo/config.json`
    as `{rev, config, state}` (config = user settings/repos/targets, state =
    active target/test history/reviews/claude model). The frontend owns the schema
    and mirrors it (`GET/POST /api/config`, rev-checked, SSE-broadcast for multi-tab);
    the CLI / auto-reloader / update-check read it directly. It lives outside `GOO_DIR`
    so the self-updater's `git pull` never touches it. Overridable with `goo --config`.
  - `cache.py` — `TTLCache` (TTL + single-flight) used by the services.
- `tests/` — stdlib `unittest` suite; services run against a fake IO (no network,
  subprocess, or disk). Run `python3 -m unittest discover`.
- Architecture: scattered fetch/parse/IO is behind the `effects` seam + `services`;
  the cohesive `OdooManager`/PTY subsystem keeps its own process side-effects (it's
  integration-proven, not unit-tested — abstracting it buys little).
- `addons/` — Odoo addons goo injects (e.g. `autologin`) to the odoo instance
  in the addons path. `rust_bundler/native/` is Goo's minimal Rust/PyO3 asset
  bundler; Odoo's resolved file list is authoritative and imports are never crawled.
- `static/src/` — the Owl 3 frontend application (ES modules; `main.js` at the root is the
  entry). Organized **by feature**: a shared `core/` plus one folder per screen.
  - `core/` — the application basics everything builds on: the shared plugins (state/action
    layer — `config_plugin`, `store_plugin`, `server_plugin`, `code_plugin`, `dialog_plugin`,
    `event_log_plugin`, `router_plugin`, `worktree_plugin`, `database_plugin`, `review_plugin`,
    `terminal_plugin`, `tests_plugin`, `update_plugin`), the owl-orm models (`config_models`,
    `observed_models`, `runtime_models`) + wire normalizers (`models.js`), the shared UI
    (`common.js` — `appBus`/`ICONS`/`m`/`NAV` + reusable widgets — `menus.js`, `dialogs.js`,
    `terminal.js`, `recordset.js`, `panel.js` (the shared screen-header `Panel`, title + five
    slots: title-extra/top-middle/top-right/bottom-left/bottom-right), the `event_log.js` panel,
    and `app.js` = `Topbar`/`Sidebar`/
    `App` + the `SCREENS` registry, which `main.js` imports), and the leaf libs `config.js`,
    `utils.js`, `presets.js`, `log_buffer.js`. `appBus` is a single shared `EventBus` exported
    from `core/common.js` — import it, never re-instantiate.
  - One folder per screen, each suffixed `_screen/` (`dashboard_screen/`, `code_screen/`,
    `workspaces_screen/`, `branches_screen/`, `prs_screen/`, `databases_screen/`,
    `nightly_screen/`, `memory_screen/`, `config_screen/`): each holds its screen component; some also hold a dedicated plugin
    (`workspaces_screen/claude_plugin.js`, `nightly_screen/nightly_plugin.js`,
    `memory_screen/memory_plugin.js`). `workspaces_screen/` is the primary surface — the
    master-detail Workspaces screen with per-workspace Code/Logs/Tests/Addons/Assets/Claude/
    Terminal tabs (`panes.js`) + the shared create/delete dialogs (`dialogs.js`).
    `assets_screen/` and `addons_screen/` are plugin-only folders (their standalone screens
    retired into the Workspaces tabs; `assets_screen/analysis.js` is the bundle-analysis view
    those tabs render). Everything else is shared → `core/`. A screen folder may import from
    `core/` (and, rarely, another screen — e.g. `workspaces_screen/panes.js` reuses the
    assets/addons plugins); `core/` never imports from a screen folder.
- `static/dist/app.js` — the committed esbuild bundle of `static/src/` (the file the
  page actually loads). Generated — never hand-edit; rebuild with `npm run build`.
- `vendor/owl-orm/` — pinned `@odoo/owl-orm` source (`index.ts`/`orm.ts`) + `owl-global.js`,
  the `@odoo/owl` → `window.owl` build shim (the single list of owl primitives the app may
  import). It's bundled into `static/dist/app.js` straight from source. The frontend state
  layer has been rewritten onto this ORM (see the `state-model-refactor` memory).

## Commands

- `python3 goo.py` — run (add `--open` to launch the browser).
- `python3 -m unittest discover` — run the backend tests (from the repo root).
- `npm run lint` / `npm run lint:fix` — eslint (`static/src` only).
- `npm run format` — prettier (js/css/html/md).
- `npm run build` — bundle `static/src/main.js` → `static/dist/app.js` (esbuild;
  `@odoo/owl` aliased to the `window.owl` shim). Run + commit the output after editing
  `static/src/` or `vendor/owl-orm/`. `npm run watch` does it on change during dev.
- `ruff check --fix` / `ruff format` — Python lint+format.
- `cd addons/rust_bundler/native && cargo test --locked` — native asset-bundler tests.
- `pre-commit` runs ruff + prettier + eslint on changed files.

## Conventions

- Python: ruff, line length 100, target py310; `static/` excluded from ruff.
- Frontend: lint/format only touch `static/src` — `static/lib/` (vendored) and
  `static/dist/` (generated bundle) are left alone (both are prettier/eslint-ignored).
- Keep the server dependency-free — no pip packages.

## Gotchas

- Needs on PATH: `git`, `psql`/`dropdb`, `gh` (authed), Chrome (for hoot tests).
- A working Odoo checkout + venv is required — goo launches `odoo-bin` (port 8069).
- owl 3 is an early release version of owl. It is not fully compatible with owl 2
