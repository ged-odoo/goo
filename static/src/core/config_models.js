// The config family as owl-orm models — the first real conversion of goo's state
// onto the client ORM (vendor/owl-orm, bundled into the app, sharing goo's window.owl
// reactivity).
//
// ConfigPlugin (config_plugin.js) is the adapter that owns an ORM seeded from these
// models and keeps its flat `config` / `getState` / `setState` / `updateConfig` API,
// so the ~72 `config.config.*` consumers, the backend, and the full-blob write wire
// are all unchanged. This module holds the models + the pure serializers that bridge
// the flat config blob (config.js DEFAULT_CONFIG shape) and the normalized records:
//
//   toModels(orm, config, state)  blob  → records   (boot / reset / preset / import)
//   toConfig(orm)                 records → config blob   (the `config` getter + POST)
//   toState(orm)                  AppState → state blob   (the POST)
//   applyPatch(orm, patch)        a flat updateConfig patch → minimal record edits
//
// Leaf/positional collections (start, tabs, links, test_presets) are json fields on
// Settings for round-trip fidelity; promoting Link/TestPreset to their own models is
// a later refinement. The relational spine — Workspace → Checkout → Repository — is
// real; Template is flat (json checkouts).
//
// Workspaces (the successors of targets — see the workspaces roadmap): the records
// are the source of truth, and `toConfig` emits BOTH the canonical `workspaces` /
// `templates` keys AND `targets`, a legacy view in the exact old target shape, so the
// ~30 `config.config.targets` readers, the `updateConfig({targets})` writers and the
// backend resolver all keep working until the UI phases migrate them.

import { Model, ORM, fields } from "../../../vendor/owl-orm/index.ts";
import { DEFAULT_CONFIG, BASE_BRANCH_RE, MERGEBOT } from "./config.js";
import { worktreeDirFor } from "./utils.js";
// Plugin classes are imported for the models' action methods to resolve via plugin().
// This makes config_models ↔ config_plugin / code_plugin a cycle, but every use is
// call-time (inside a method), so the bindings are live by the time any method runs.
import { ConfigPlugin } from "./config_plugin.js";
import { ServerPlugin } from "./server_plugin.js";
import { CodePlugin } from "./code_plugin.js";
import { EventLogPlugin } from "./event_log_plugin.js";

import { plugin } from "@odoo/owl";

export { ORM };

// Resolve owl plugins from a record's own ORM scope, at call time. A config record is
// seeded during ConfigPlugin construction — before higher-sequence plugins start — so a
// field-initializer plugin() would resolve too early; running inside the record's stored
// scope (orm._ctx) at call time resolves against the fully-started plugin manager.
function withScope(rec, fn) {
  const ctx = rec.orm._ctx;
  return ctx ? ctx.run(fn) : fn();
}

// scalar settings that live as flat keys on the config blob
const SETTINGS_CHARS = [
  "work_dir",
  "venv_activate",
  "server_path",
  "worktree_dir",
  "db_user",
  "db_password",
  "filestore",
  "editor",
];
const SETTINGS_BOOLS = ["auto_open_event_log", "update_check", "rust_bundler"];
const SETTINGS_JSON = ["start", "tabs", "links", "test_presets"];
// the app-state blob keys (were the scattered oo-* localStorage keys, see config_plugin)
const STATE_CHARS = ["active_workspace", "claude_model"];
const STATE_JSON = ["test_history", "reviews_favorites", "reviews_merged", "reviews_no_mergebot"];

export class Settings extends Model {
  static id = "settings"; // singleton
  work_dir = fields.char();
  venv_activate = fields.char();
  server_path = fields.char();
  worktree_dir = fields.char();
  db_user = fields.char();
  db_password = fields.char();
  filestore = fields.char();
  editor = fields.char();
  auto_open_event_log = fields.bool();
  update_check = fields.bool();
  rust_bundler = fields.bool();
  start = fields.json();
  tabs = fields.json();
  links = fields.json();
  test_presets = fields.json();
}

export class Repository extends Model {
  static id = "repository";
  path = fields.char();
  github = fields.char();
  favorite = fields.bool();
  external = fields.bool();
  autoreload = fields.bool();
  checkouts = fields.one2many({ comodel: () => Checkout, inverse: "repository" });

  // the canonical GitHub slug — the stored value, else the built-in default for this id
  githubOrDefault() {
    return this.github() || DEFAULT_CONFIG.repos.find((d) => d.id === this.id)?.github || "";
  }

  compareUrl(branch) {
    return repoUrls.compare(this.githubOrDefault(), branch);
  }

  forkBranchUrl(branch) {
    return repoUrls.fork(this.githubOrDefault(), branch);
  }

  remoteBranchUrl(branch) {
    return repoUrls.remote(this.githubOrDefault(), branch);
  }

  mergebotUrl(number) {
    return repoUrls.mergebot(this.githubOrDefault(), number);
  }
}

// The pure GitHub/mergebot URL builders (keyed by slug). The Repository methods above
// are the model-facing API; these back them and are exported so CodePlugin can build a
// URL for a PR whose repo isn't in config (a reviewed PR from an unfavorited repo has no
// Repository record). One source of truth, callable with a record or a bare slug.
export const repoUrls = {
  // GitHub "create PR" compare page for a work branch (base inferred from the name)
  compare(github, branch) {
    const base = (/^(saas-\d+\.\d+|\d+\.\d+|master)/.exec(branch) || ["", "master"])[1];
    const name = github.split("/")[1];
    return `https://github.com/${github}/compare/${base}...odoo-dev:${name}:${branch}?expand=1`;
  },
  // the branch on the odoo-dev fork
  fork(github, branch) {
    const name = github.split("/")[1];
    return `https://github.com/odoo-dev/${name}/tree/${encodeURIComponent(branch)}`;
  },
  // where a branch lives remotely: base branches on the canonical repo, work branches on the fork
  remote(github, branch) {
    if (BASE_BRANCH_RE.test(branch)) {
      return `https://github.com/${github}/tree/${encodeURIComponent(branch)}`;
    }
    return repoUrls.fork(github, branch);
  },
  // the mergebot page for one of this repo's PRs
  mergebot(github, number) {
    return `${MERGEBOT}/${github}/pull/${number}`;
  },
};

export class Workspace extends Model {
  static id = "workspace";
  name = fields.char();
  favorite = fields.bool();
  db = fields.char();
  on_create_args = fields.char();
  demo_data = fields.bool({ defaultValue: true });
  // where the workspace physically lives: "main" = the primary checkout (shared —
  // only one main-located workspace is loaded at a time, on the implicit :8069),
  // "worktree" = its own git worktree dir, running concurrently on its own port
  location = fields.char({ defaultValue: "main" });
  worktree = fields.json(); // { base, dir } | null — only worktree workspaces
  port = fields.number(); // stable server port (worktree only; 0 = none/main)
  checkouts = fields.one2many({ comodel: () => Checkout, inverse: "workspace" });

  // ── derivations (pure — this + this.orm) ─────────────────────────────────────
  // "repo:branch, …" — the human-readable checkout list
  checkoutsLabel() {
    return this.checkouts()
      .map((c) => `${c.repository().id}:${c.branch()}`)
      .join(", ");
  }

  // the explicit `location` marks a worktree, falling back to `worktree` metadata presence
  isWorktree() {
    return (this.location() || (this.worktree() ? "worktree" : "main")) === "worktree";
  }

  hasCommunity() {
    return this.checkouts().some((c) => c.repository().id === "community");
  }

  // the repo ids this workspace checks out
  repoIds() {
    return this.checkouts().map((c) => c.repository().id);
  }

  // the worktree's on-disk directory: the value frozen at creation (worktree.dir),
  // else derived from <settings.worktree_dir>/<name>. Persisting it means a later
  // rename can't move the path off the real checkout (worktreeDirFor, utils.js).
  dirPath() {
    const dir = this.worktree()?.dir;
    if (dir) return dir;
    const settings = this.orm.getById(Settings, "settings");
    return worktreeDirFor(settings?.worktree_dir(), { name: this.name(), id: this.id });
  }

  // ── mutations (edit records, persist via ConfigPlugin's existing save wire) ───
  _configPlugin() {
    return withScope(this, () => plugin(ConfigPlugin));
  }

  toggleFavorite() {
    this.favorite.set(!this.favorite());
    this._configPlugin().touch();
  }

  toggleDemoData() {
    this.demo_data.set(!this.demo_data());
    this._configPlugin().touch();
  }

  // commit an inline edit onto the target (favorite/demo_data untouched — each is
  // toggled directly via its own checkbox).
  // The caller validates; checkouts arrive already parsed as [{repo, branch}].
  applyEdit({ name, checkouts, db, on_create_args }) {
    this.name.set(name);
    this.db.set(db);
    this.on_create_args.set(on_create_args);
    reconcileCheckouts(this.orm, { id: this.id, checkouts });
    this._configPlugin().touch();
  }

  // ── action: stop the server, switch to this target, check out its branches ────
  async activate() {
    const { server, code, eventLog } = withScope(this, () => ({
      server: plugin(ServerPlugin),
      code: plugin(CodePlugin),
      eventLog: plugin(EventLogPlugin),
    }));
    // live git state per repo — for the guard + deciding which repos actually switch
    const repoMap = {};
    for (const r of code.branchRepos()) {
      repoMap[r.id] = {
        current: r.current,
        dirty: r.dirty,
        branches: new Set((r.branches || []).map((b) => b.name)),
      };
    }
    const cos = this.checkouts().map((c) => ({ repo: c.repository().id, branch: c.branch() }));
    // guard (mirrors canActivate): not already active, all branches present, none dirty
    const s = server.status();
    const activeId =
      s.state === "running" || s.state === "starting" ? s.target : server.lastTarget();
    if (this.id === activeId) return;
    if (!cos.every(({ repo, branch }) => repoMap[repo]?.branches.has(branch))) return;
    if (cos.some(({ repo }) => repoMap[repo]?.dirty)) return;
    const pathByRepo = code.groups().pathByRepo;
    const repos = cos
      .map(({ repo, branch }) => ({ repo, path: pathByRepo[repo], branch }))
      .filter((r) => r.path);
    const switched = repos.filter((r) => repoMap[r.repo]?.current !== r.branch);
    eventLog.add(`activating target ${this.name()}`);
    for (const r of switched) eventLog.add(`checking out ${r.branch} (${r.repo})`);
    // stop the server and switch branches concurrently (independent ops)
    const stopping = s.state === "running" || s.state === "starting" ? server.stop() : null;
    await Promise.all([stopping, code.checkout(repos)]);
    server.setLastTarget(this.id);
  }
}

export class Checkout extends Model {
  static id = "checkout"; // id = `${workspace}:${repo}` (workspace ids = the old target ids)
  workspace = fields.many2one({ comodel: () => Workspace, inverse: "checkouts" });
  repository = fields.many2one({ comodel: () => Repository, inverse: "checkouts" });
  branch = fields.char();
}

// A template is what the old "target" becomes conceptually: a preset of configuration
// keys that prefills workspace creation. Flat on purpose — `checkouts` is plain json
// (template checkout ids would collide with workspace ones), and it carries none of a
// workspace's physical identity (location/worktree/port).
export class Template extends Model {
  static id = "template";
  name = fields.char();
  db = fields.char();
  on_create_args = fields.char();
  demo_data = fields.bool({ defaultValue: true });
  checkouts = fields.json(); // [{repo, branch}]
}

export class AppState extends Model {
  static id = "appstate"; // singleton — the app-recorded state blob
  active_workspace = fields.char();
  claude_model = fields.char();
  test_history = fields.json();
  reviews_favorites = fields.json();
  reviews_merged = fields.json();
  reviews_no_mergebot = fields.json();
}

export const CONFIG_MODELS = [Settings, Repository, Workspace, Template, Checkout, AppState];

const checkoutId = (workspaceId, repo) => `${workspaceId}:${repo}`;

// ── legacy target shape ↔ workspace shape (pure, the one mapping) ────────────────

// a legacy target object → the workspace shape (no `port` — the caller allocates one
// for worktree-located workspaces, so a legacy patch can't clobber a stable port)
export function workspaceFromTarget(t) {
  const location =
    (t.kind || (t.worktree ? "worktree" : "plain")) === "worktree" ? "worktree" : "main";
  return {
    id: t.id,
    name: t.name ?? "",
    favorite: !!t.favorite,
    db: t.db ?? "",
    on_create_args: t.on_create_args ?? "",
    demo_data: t.demo_data ?? true,
    location,
    worktree: t.worktree ?? null,
    checkouts: t.checkouts || [],
  };
}

// a Workspace record → the exact old target blob shape (byte-compatible: `kind`
// instead of `location`, `worktree` only when set, no `port`)
function targetFromWorkspace(w) {
  const tgt = {
    id: w.id,
    name: w.name(),
    favorite: w.favorite(),
    db: w.db(),
    on_create_args: w.on_create_args(),
    demo_data: w.demo_data(),
    kind: w.isWorktree() ? "worktree" : "plain",
    checkouts: w.checkouts().map((c) => ({ repo: c.repository().id, branch: c.branch() })),
  };
  const wt = w.worktree();
  if (wt) tgt.worktree = wt;
  return tgt;
}

// ports a workspace may never claim: 8069 = the main server, 8072 = its default
// gevent (websocket) port — a workspace bound there would collide with a running main
export const RESERVED_PORTS = [8069, 8072];

// the smallest stable port ≥ 8070 not held by any workspace and not reserved
export function nextFreePort(orm) {
  const used = new Set([...RESERVED_PORTS, ...orm.records(Workspace).map((w) => w.port())]);
  let p = 8070;
  while (used.has(p)) p++;
  return p;
}

// ── blob → records ────────────────────────────────────────────────────────────

// seed an empty ORM from a {config, state} pair (boot / reset / preset / import).
// The blob arrives normalized (config_plugin's normalizeConfigState ran the one-time
// targets→workspaces migration), so `workspaces`/`templates` are authoritative here.
export function toModels(orm, config = {}, state = {}) {
  const settings = { id: "settings" };
  for (const k of SETTINGS_CHARS) settings[k] = config[k] ?? "";
  for (const k of SETTINGS_BOOLS) settings[k] = !!config[k];
  settings.start = config.start ?? {};
  settings.tabs = config.tabs ?? [];
  settings.links = config.links ?? [];
  settings.test_presets = config.test_presets ?? [];
  orm.create(Settings, settings);

  for (const r of config.repos || []) createRepo(orm, r);
  for (const w of config.workspaces || []) createWorkspace(orm, w); // repos exist → checkout m2o resolves
  for (const t of config.templates || []) createTemplate(orm, t);

  const st = { id: "state" };
  for (const k of STATE_CHARS) st[k] = state[k] ?? "";
  for (const k of STATE_JSON) st[k] = state[k] ?? [];
  orm.create(AppState, st);
}

function repoData(r) {
  return {
    id: r.id,
    path: r.path ?? "",
    github: r.github ?? "",
    favorite: !!r.favorite,
    external: !!r.external,
    autoreload: !!r.autoreload,
  };
}
function createRepo(orm, r) {
  orm.create(Repository, repoData(r));
}

function workspaceData(w) {
  return {
    id: w.id,
    name: w.name ?? "",
    favorite: !!w.favorite,
    db: w.db ?? "",
    on_create_args: w.on_create_args ?? "",
    demo_data: w.demo_data ?? true,
    location: w.location || (w.worktree ? "worktree" : "main"),
    worktree: w.worktree ?? null,
    port: w.port ?? 0,
  };
}
function createWorkspace(orm, w) {
  orm.create(Workspace, workspaceData(w));
  for (const c of w.checkouts || []) {
    orm.create(Checkout, {
      id: checkoutId(w.id, c.repo),
      workspace: w.id,
      repository: c.repo,
      branch: c.branch ?? "",
    });
  }
}

function templateData(t) {
  return {
    id: t.id,
    name: t.name ?? "",
    db: t.db ?? "",
    on_create_args: t.on_create_args ?? "",
    demo_data: t.demo_data ?? true,
    checkouts: t.checkouts || [],
  };
}
function createTemplate(orm, t) {
  orm.create(Template, templateData(t));
}

// ── records → blob ──────────────────────────────────────────────────────────────

export function toConfig(orm) {
  const s = orm.getById(Settings, "settings");
  const out = {};
  if (s) {
    for (const k of SETTINGS_CHARS) out[k] = s[k]();
    for (const k of SETTINGS_BOOLS) out[k] = s[k]();
    out.start = s.start() ?? {};
    out.tabs = s.tabs() ?? [];
    out.links = s.links() ?? [];
    out.test_presets = s.test_presets() ?? [];
  }
  out.repos = orm.records(Repository).map((r) => ({
    id: r.id,
    path: r.path(),
    github: r.github(),
    favorite: r.favorite(),
    external: r.external(),
    autoreload: r.autoreload(),
  }));
  const workspaces = orm.records(Workspace);
  out.workspaces = workspaces.map((w) => ({
    id: w.id,
    name: w.name(),
    favorite: w.favorite(),
    db: w.db(),
    on_create_args: w.on_create_args(),
    demo_data: w.demo_data(),
    location: w.location(),
    worktree: w.worktree(),
    port: w.port() || null,
    checkouts: w.checkouts().map((c) => ({ repo: c.repository().id, branch: c.branch() })),
  }));
  out.templates = orm.records(Template).map((t) => ({
    id: t.id,
    name: t.name(),
    db: t.db(),
    on_create_args: t.on_create_args(),
    demo_data: t.demo_data(),
    checkouts: t.checkouts() || [],
  }));
  // the legacy view — the exact old target shape, until the UI phases retire it
  out.targets = workspaces.map(targetFromWorkspace);
  return out;
}

export function toState(orm) {
  const st = orm.getById(AppState, "state");
  if (!st) return {};
  const out = {};
  for (const k of STATE_CHARS) out[k] = st[k]();
  for (const k of STATE_JSON) out[k] = st[k]();
  return out;
}

// ── flat patch → minimal record edits (the updateConfig diff-sync) ───────────────

export function applyPatch(orm, patch) {
  const s = orm.getById(Settings, "settings");
  if (s) {
    for (const k of [...SETTINGS_CHARS, ...SETTINGS_BOOLS, ...SETTINGS_JSON]) {
      if (k in patch) s[k].set(patch[k]);
    }
  }
  if ("repos" in patch) reconcileRepos(orm, patch.repos || []);
  // canonical routes first; a legacy `targets` patch (today's ~10 writers) reconciles
  // onto the Workspace records through the shape mapping. If a patch carries both,
  // `workspaces` wins.
  if ("templates" in patch) reconcileTemplates(orm, patch.templates || []);
  if ("workspaces" in patch) reconcileWorkspaces(orm, patch.workspaces || []);
  else if ("targets" in patch)
    reconcileWorkspaces(orm, (patch.targets || []).map(workspaceFromTarget), {
      legacy: true,
    });
}

// reconcile a model's records against a desired array, keyed by `keyOf`: update the
// ones that stay, create the new ones, delete the ones that left. Returns nothing.
function reconcile(orm, Cls, desired, keyOf, update, create) {
  const have = new Map(orm.records(Cls).map((rec) => [rec.id, rec]));
  const keep = new Set();
  for (const item of desired) {
    const id = keyOf(item);
    keep.add(id);
    const rec = have.get(id);
    if (rec) update(rec, item);
    else create(orm, item);
  }
  for (const [id, rec] of have) if (!keep.has(id)) orm.delete(rec);
}

function reconcileRepos(orm, repos) {
  reconcile(
    orm,
    Repository,
    repos,
    (r) => r.id,
    (rec, r) => {
      const d = repoData(r);
      for (const k of ["path", "github", "favorite", "external", "autoreload"]) rec[k].set(d[k]);
    },
    createRepo,
  );
}

// desired = workspace-shaped objects. A legacy patch (mapped from `targets`) carries
// no `port`: updates leave the record's stable port untouched, and creates allocate
// the next free one for a worktree-located workspace.
function reconcileWorkspaces(orm, desired, { legacy = false } = {}) {
  reconcile(
    orm,
    Workspace,
    desired,
    (w) => w.id,
    (rec, w) => {
      const d = workspaceData(w);
      for (const k of ["name", "favorite", "db", "on_create_args", "demo_data", "worktree"]) {
        rec[k].set(d[k]);
      }
      rec.location.set(d.location);
      if (!legacy) rec.port.set(d.port);
      reconcileCheckouts(orm, w);
    },
    (o, w) => {
      const port = w.port ?? (workspaceData(w).location === "worktree" ? nextFreePort(o) : 0);
      createWorkspace(o, { ...w, port });
    },
  );
  // a deleted workspace's checkouts must go too (o2m is unlinked, not cascade-deleted)
  const live = new Set(desired.map((w) => w.id));
  for (const c of orm.records(Checkout)) {
    const ws = c.workspace();
    if (!ws || !live.has(ws.id)) orm.delete(c);
  }
  // persist the desired ORDER too: orm.records() returns insertion order and the
  // in-place reconcile above never moves records, so a reorder patch (the Targets
  // screen's drag) wouldn't survive toConfig (bug present since the ORM refactor).
  // When the id order changed, rebuild the records in the desired order — the data is
  // fully carried by `desired` plus the ports the reconcile just settled.
  const have = orm.records(Workspace).map((r) => r.id);
  const want = desired.map((w) => w.id);
  if (have.join("\n") !== want.join("\n")) {
    const portById = new Map(orm.records(Workspace).map((r) => [r.id, r.port()]));
    for (const c of orm.records(Checkout)) orm.delete(c);
    for (const r of orm.records(Workspace)) orm.delete(r);
    for (const w of desired) {
      createWorkspace(orm, { ...w, port: w.port ?? portById.get(w.id) ?? 0 });
    }
  }
}

function reconcileTemplates(orm, templates) {
  // order-aware (like workspaces): the Templates screen's drag-reorder sends the
  // same id set in a new order — rebuild the records so the order persists
  // (templates are flat, no dependents, so a full rebuild is cheap and safe)
  const have = orm.records(Template).map((r) => r.id);
  const want = templates.map((t) => t.id);
  if (have.length === want.length && have.join("\n") !== want.join("\n")) {
    for (const r of orm.records(Template)) orm.delete(r);
    for (const t of templates) createTemplate(orm, t);
    return;
  }
  reconcile(
    orm,
    Template,
    templates,
    (t) => t.id,
    (rec, t) => {
      const d = templateData(t);
      for (const k of ["name", "db", "on_create_args", "demo_data", "checkouts"]) {
        rec[k].set(d[k]);
      }
    },
    createTemplate,
  );
}

function reconcileCheckouts(orm, w) {
  const desired = (w.checkouts || []).map((c) => ({
    id: checkoutId(w.id, c.repo),
    repo: c.repo,
    branch: c.branch ?? "",
  }));
  const have = new Map(
    orm
      .records(Checkout)
      .filter((c) => c.workspace()?.id === w.id)
      .map((c) => [c.id, c]),
  );
  const keep = new Set();
  for (const c of desired) {
    keep.add(c.id);
    const rec = have.get(c.id);
    if (rec) rec.branch.set(c.branch);
    else orm.create(Checkout, { id: c.id, workspace: w.id, repository: c.repo, branch: c.branch });
  }
  for (const [id, rec] of have) if (!keep.has(id)) orm.delete(rec);
}
