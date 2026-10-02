# goo — GED Odoo Overseer

Local web app for Odoo dev: manages server instances, multi-repo git workflows,
test runs, and PR tracking. Single stdlib-Python server + Owl 3 frontend.

## Stack

- **Backend**: the `backend/` package, Python 3.10+, **stdlib only** (no pip deps),
  fully type-annotated and checked with pyright.
- **Frontend**: `static/src/` — Owl 3, in **strict TypeScript** (ES modules with real
  `import { … } from "@odoo/owl"`, typed by the published `@odoo/owl` package of the exact
  vendored version — a devDependency for its types only). `npm run build` (esbuild) bundles `static/src/main.ts`
  → **`static/dist/app.js`**, which is **committed**, so the app still runs straight from
  the checkout with no build/install at dev time. The Owl runtime itself
  (`static/lib/owl.js`) stays a classic global `<script>`; the build aliases `@odoo/owl`
  to `vendor/owl-orm/owl-global.ts`, a shim re-exporting `globalThis.owl`, so the whole
  bundle (app + vendored `@odoo/owl-orm`) shares one `window.owl` reactivity. `npm run
watch` rebuilds on change. Rebuild + commit `static/dist/app.js` whenever you edit
  `static/src/` or `vendor/owl-orm/`.
- Runs straight from the checkout: `python3 goo.py` (UI on `127.0.0.1:8068`).

## Layout

- `goo.py` — thin launcher at the repo root (executable, shebang); just calls
  `backend.server.main()`. Keeps `python3 goo.py` / `alias goo=…/goo.py` working.
- `backend/` — the Python package (import with `from backend import …`):
  - `server.py` — the HTTP server: the declarative POST route table (`@post_route`
    declares the path + required body fields; the dispatch does the shared
    read-json/validate/send-json envelope) and every `_api_*` handler, the
    module-level service singletons (`GIT`, `CONFIG`, `DATABASE`, … — tests swap
    them on this module, so whatever reads them stays here: the handlers,
    `WorkspaceManager`, the DATABASE-probing odoo/docker command builders, the
    update state/loop), `Handler` and `main`. It re-imports the moved names other
    code uses (`server.<name>`).
  - `events.py` — the `EventBus` (SSE). `processes.py` — the port/process/editor
    helpers, the service-free command builders, the PTY/CLI websocket frame helpers
    and `_Entry`; `GOO_DIR` (the repo root — where `static/`, `addons/`, and the git
    checkout live). `update.py` — the goo self-update git probes. `claude.py` — the
    Claude chat (`ClaudeManager`) and its persisted reviews. The process subsystem
    owns its own inherent process side-effects. New modules never import `server`.
  - `effects.py` — the IO seam: the one place raw subprocess / network / filesystem
    happen (`run`, `http_get`, `read_text`/`list_dir`/`read_json_file`/…,
    `log_request`). Fake this in tests.
  - `services/` — domain services over the seam, one module per domain (`git.py`,
    `github.py`, `runbot.py` (runbot/mergebot/CI/nightly/memory), `database.py`,
    `odoo.py` (venv/addons/assets/rust bundler), `docker.py`, `config.py`);
    `__init__.py` re-exports every name, so `services.X` is the import to use. They
    fetch + parse external state, cached server-side where it's worth it (PRs/runbot/
    mergebot/databases have TTLs; git reads are volatile so they're uncached). Also
    `ConfigStore` — the server-owned config, persisted to `~/.config/goo/config.json`
    as `{rev, config, state}` (config = user settings/repos/targets, state =
    active target/test history/claude model). The frontend owns the schema
    and mirrors it (`GET/POST /api/config`, rev-checked, SSE-broadcast for multi-tab);
    the CLI / auto-reloader / update-check read it directly. It lives outside `GOO_DIR`
    so the self-updater's `git pull` never touches it. Overridable with `goo --config`.
    `services/templates/` holds the static files of the generated Claude skills,
    copied verbatim into worktrees (excluded from ruff/pyright/prettier — edit
    them as the files they are).
  - `cache.py` — `TTLCache` (TTL + single-flight) used by the services.
- `tests/` — stdlib `unittest` suite. Services run against a fake IO (no network,
  subprocess, or disk); `effects` itself and the process subsystem are tested for
  real but local and fast: temp dirs, a `127.0.0.1` HTTP server on port 0, real git
  repos in a temp dir, and fake `odoo-bin` / `claude` executables driven through the
  real PTY / websocket paths (`test_effects`, `test_processes`, `test_http`, `test_update`,
  `test_workspace_manager`, `test_claude`). Every wait has a deadline — no bare
  sleeps. Run `python3 -m unittest discover`; CI enforces a coverage floor
  (`fail_under` in `pyproject.toml`).
- Architecture: scattered fetch/parse/IO is behind the `effects` seam + `services`;
  the cohesive `WorkspaceManager`/PTY subsystem keeps its own process side-effects
  (not abstracted behind the seam — its tests run it against a fake `odoo-bin`).
- `static/tests/` — Vitest + jsdom suite, one folder per `static/src/<feature>/` (files
  named by module, or `<module>_<topic>`). `static/tests/setup.ts` populates `globalThis.owl` (via
  `vm.runInThisContext` on `static/lib/owl.js`, matching the classic `<script>`
  semantics `static/index.html` itself relies on) before any test imports
  `@odoo/owl`. `static/tests/helpers/plugin_harness.ts` builds a real
  `pluginManager` (via `new owl.App({})`, no DOM) for plugins that use
  `usePlugin()`; a dependency-free plugin (e.g. `StorePlugin`) can be `new`'d
  directly. `static/tests/helpers/app.ts` `mountApp({ section, routes })` boots the real
  `App` with every plugin (`static/src/plugins.ts`) against a routed fake `fetch` — screens
  are tested through it, asserting the rendered DOM and the requests sent. Run
  `npm run test` (`npm run test:coverage` for the coverage report + thresholds).
- `addons/` — Odoo addons goo injects (e.g. `autologin`) to the odoo instance
  in the addons path. `rust_bundler/native/` is Goo's minimal Rust/PyO3 asset
  bundler; Odoo's resolved file list is authoritative and imports are never crawled.
- `static/src/` — the Owl 3 frontend application (TypeScript ES modules; `main.ts` at the root
  is the entry, `plugins.ts` the registered plugin list, `globals.d.ts` the `<script>`-loaded
  globals: owl, xterm, Chart.js). Organized **by feature**: a shared `core/` plus one folder per screen.
  - `core/` — the application basics everything builds on: the shared plugins (state/action
    layer — `config_plugin`, `store_plugin`, `server_plugin`, `code_plugin`, `dialog_plugin`,
    `event_log_plugin`, `router_plugin`, `workspace_plugin`, `database_plugin`,
    `tests_plugin`, `update_plugin`), the owl-orm models (`config_models`,
    `observed_models`, `runtime_models`) + wire normalizers (`models.ts`), the shared UI
    (`common.ts` — `appBus`/`ICONS`/`m`/`NAV` + reusable widgets — `menus.ts`, `dialogs.ts`,
    `terminal.ts`, `recordset.ts` (the generic `RecordList` — flat or grouped-by-field with
    group-header slot/actions, collapsible groups, rich `component` cells; the Branches & PRs
    screen is its first consumer), `panel.ts` (the shared screen-header `Panel`, title + five
    slots: title-extra/top-middle/top-right/bottom-left/bottom-right), the `event_log.ts` panel,
    and `app.ts` = `Topbar`/`Sidebar`/
    `App` + the `SCREENS` registry, which `main.ts` imports), and the leaf libs `config.ts`,
    `utils.ts`, `presets.ts`, `log_buffer.ts`, `drag.ts` (the shared pointer-based
    row drag-and-drop: cursor-following ghost + midline drop index — every
    reorderable list uses it, never HTML5 dnd). `appBus` is a single shared `EventBus` exported
    from `core/common.ts` — import it, never re-instantiate.
  - One folder per screen, each suffixed `_screen/` (`workspaces_screen/`,
    `branches_screen/`, `todo_screen/`, `databases_screen/`, `nightly_screen/`,
    `memory_screen/`, `config_screen/`, `ci_screen/`, `reviews_screen/`): each holds its screen component; some also hold a dedicated plugin
    (`workspaces_screen/claude_plugin.ts`, `nightly_screen/nightly_plugin.ts`,
    `memory_screen/memory_plugin.ts`, `ci_screen/ci_plugin.ts`,
    `reviews_screen/reviews_plugin.ts`). `workspaces_screen/` is the primary surface — the
    master-detail Workspaces screen, split one file per component: `workspaces.ts`
    (the screen/list), `code_pane.ts` (the Code tab), `history.ts` (`CommitHistory`,
    the reorder/squash/drop commit editor), `claude_chat.ts`, the other tab panes
    (`panes.ts`) + the shared create/delete dialogs (`dialogs.ts`).
    `branches_screen/` is the merged **Branches & PRs** screen (one RecordList grouped by
    branch name: local branches + their PRs, plus PR-only rows for authored PRs with no
    local branch; the old separate PRs screen and the PR-review feature are retired —
    `#prs`/`#reviews` alias to `#branches`). `reviews_screen/` is a different, live feature:
    the opt-in **Reviews** tab (section id `review-queue`, a review queue + Claude reviews).
    `assets_screen/` and `addons_screen/` are plugin-only folders (their standalone screens
    retired into the Workspaces tabs; `assets_screen/analysis.ts` is the bundle-analysis view
    those tabs render). Everything else is shared → `core/`. A screen folder may import from
    `core/` (and, rarely, another screen — e.g. `workspaces_screen/panes.ts` reuses the
    assets/addons plugins); `core/` never imports from a screen folder.
- `static/dist/app.js` — the committed esbuild bundle of `static/src/` (the file the
  page actually loads). Generated — never hand-edit; rebuild with `npm run build`.
- `vendor/owl-orm/` — pinned `@odoo/owl-orm` source (`index.ts`/`orm.ts`) + `owl-global.ts`,
  the `@odoo/owl` → `window.owl` build shim (the single list of owl primitives the app may
  import). It's bundled into `static/dist/app.js` straight from source. The frontend state
  layer has been rewritten onto this ORM (see the `state-model-refactor` memory).

## Commands

- `python3 goo.py` — run (add `--open` to launch the browser).
- `python3 -m unittest discover` — run the backend tests (from the repo root).
- `npm run lint` / `npm run lint:fix` — eslint (typescript-eslint; `static/src` + `static/tests`).
- `npm run typecheck:ts` — `tsc` (strict, no emit) twice: `tsconfig.json` (production —
  `static/src`, `vendor/owl-orm`) and `static/tests/tsconfig.json` (the tests, plus
  test-only declarations like `static/tests/helpers/node.d.ts`). CI, pre-commit and the hooks run it.
- `npm run format` — prettier (ts/js/css/html/md).
- `npm run test` / `npm run test:watch` — Vitest suite for `static/src/` (see
  `static/tests/` above; ~40s). Not pre-commit-hooked, same as the Python suite.
- `npm run build` — bundle `static/src/main.ts` → `static/dist/app.js` (esbuild;
  `@odoo/owl` aliased to the `window.owl` shim). Run + commit the output after editing
  `static/src/` or `vendor/owl-orm/`. `npm run watch` does it on change during dev.
- `ruff check --fix` / `ruff format` — Python lint+format.
- `npm run typecheck:py` — pyright over `backend/` + `goo.py` (standard mode, py3.10;
  config in `pyproject.toml`). Runs in CI next to `ruff check`, and in pre-commit.
- CI also reports backend test coverage (`coverage run -m unittest discover`) in the
  job summary — `pip install coverage` to run it locally; a dev tool only.
- `npm run test:coverage` — the frontend suite under v8 coverage; CI fails below the
  thresholds in `vitest.config.js` (`main.ts`, the bare page mount, is excluded).
- `vulture` / `npm run deadcode` (knip) — dead-code checks, both run in CI (config in
  `pyproject.toml` `[tool.vulture]` and `knip.json`). `pip install vulture` locally.
- `cd addons/rust_bundler/native && cargo test --locked` — native asset-bundler tests.
- `pre-commit` runs ruff + pyright + tsc + prettier + eslint on changed files, and rebuilds
  `static/dist/app.js` when `static/src/` or `vendor/owl-orm/` changed.

## Conventions

- Python: ruff, line length 100, target py310; `static/` excluded from ruff.
- Python types: every backend function is annotated (ruff's `ANN` rules enforce it;
  `tests/` and `addons/` are exempt) and must pass pyright. Py3.10 syntax (`X | None`,
  builtin generics); `Any` / `dict[str, Any]` is fine for JSON bodies and config dicts.
  pyright is an npm devDependency — a dev tool, the server itself stays stdlib-only.
- Frontend types: strict, no `any` without an `eslint-disable` + reason, no
  `@ts-ignore`; `as`/`!` only on stated invariants. Components type props via
  `useProps({...})` (`t.any() as Type<X>` names a non-validated prop's type), plugins via
  `usePlugin(X)` / `PluginInstance<typeof X>`, wire JSON via interfaces
  (`postJSON<Reply>(…)`), and `catch (e)` via `errorMessage(e)` (`core/utils.ts`).
- Frontend: lint/format only touch `static/src` + `static/tests` — `static/lib/` (vendored) and
  `static/dist/` (generated bundle) are left alone (both are prettier/eslint-ignored).
- Keep the server dependency-free — no pip packages.

## Working rules (goo is written with Claude Code)

- **Hooks enforce the checks** (`.claude/settings.json` → `.claude/hooks/`): every
  edited file is formatted + linted on the spot (`format.sh`), and a turn can't end
  while the checks for what the branch changed fail (`check.sh`: ruff check +
  format, pyright, unit tests, tsc, prettier, eslint, vitest; a stale `static/dist/app.js` is rebuilt). It's
  skipped when nothing changed since the last passing run; the frontend checks
  need `npm install`. Fix the failure — don't disable the hook or work around it.
- **Tests check the outcome, not the command sent to a fake.** A test that asserts
  "ran `git worktree add …`" passes even when the result is broken; assert what the
  user would observe (the branch tracks its upstream, the commits are reordered,
  the file exists). For git behavior, prefer a real repo in a temp dir. Test through
  the real plugins (`mountApp`, a real `ConfigPlugin`), not hand-rolled fakes of them
  — a fake config without the real dangling-parent heal hid a bug in three places.
  `mountApp` fails a test on any request no route answers: route each action with
  the reply shape `backend/server.py` really returns, never rely on a default `{}`.
- **Comments describe what the code does now.** History ("used to…", "a bug we
  hit…", "moved from…") belongs in the commit message, not the code. When a file
  moves or is renamed, update every reference to it — `tests/test_doc_paths.py`
  fails on a path in `CLAUDE.md` or a reference to a goo source file that no longer
  exists.
- **Delete dead code, don't leave it behind.** When a feature or caller is removed,
  remove what only it used (vulture + knip fail CI on unused code).
- **Every commit builds on its own** and carries its regenerated `static/dist/app.js`
  (check each one, e.g. in a temporary `git worktree`), so any commit can be checked out.
- **Review in a separate session before every PR.** The session that wrote the code
  shares its blind spots — before opening (or updating) a PR, run `/code-review` on
  the branch in a fresh Claude Code session (or a subagent given only the diff, not
  the implementation reasoning), and address its findings first.

## Gotchas

- Needs on PATH: `git`, `psql`/`dropdb`, `gh` (authed), Chrome (for hoot tests).
- A working Odoo checkout + venv is required — goo launches `odoo-bin` (port 8069).
- CI installs with Node 22's npm 10 (`npm ci`), which rejects a lockfile an incremental
  `npm install` under npm 11 can leave out of sync (optional `@emnapi/*` deps of knip's
  wasm resolver). After changing dependencies: `rm -rf node_modules package-lock.json &&
npm install`, then check `npx npm@10 ci` passes in a copy before pushing.
- Many endpoints report a failure in a **200** reply (`{ok: false, error}` or per-item
  `results`); `postJSON` only throws on HTTP errors, so a caller must check `ok`.
- Removing a workspace: remove the parent's worktree first (a failure keeps
  everything, as a handle to retry), then `cascadeRemoveDescendants` while the parent
  is still in config, then drop the parent — the config's dangling-parent heal
  demotes a removed parent's children to root, so a later cascade finds none.
- A plugin's pending timers must be cleared `onWillDestroy` (the tests destroy the app
  between tests; a leftover debounced save posted into the next test's backend).
- owl 3 is an early release version of owl, not fully compatible with owl 2 — it runs
  in tests from `static/lib/owl.js` itself (see `static/tests/setup.ts`), and mounting
  components in jsdom works (`static/tests/helpers/app.ts`; `await settle()` after each interaction).
- Frontend test exclusions (deliberate, not gaps): real pointer-drag geometry in
  `drag.ts`'s `startRowDrag` and the nightly popover clamping (jsdom has no layout —
  `dropIndex` is tested against fixture rects), and the Chart.js/xterm lazy
  `<script>` loading. xterm, Chart.js, `WebSocket` and `EventSource` are replaced by
  small fakes in the tests that use them.
