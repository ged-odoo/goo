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
// are the source of truth; `toConfig` emits the canonical `workspaces` / `templates`
// keys. The legacy `targets` view is gone (Phase 6) — `workspaceFromTarget` survives
// only for the one-time migration of stored pre-workspace configs.

import { Model, ORM, fields } from "../../../vendor/owl-orm/index.ts";
import { DEFAULT_CONFIG, BASE_BRANCH_RE, MERGEBOT, baseBranchOf } from "./config.js";
import { worktreeDirFor } from "./utils.js";
// Plugin classes are imported for the models' action methods to resolve via usePlugin().
// This makes config_models ↔ config_plugin / code_plugin a cycle, but every use is
// call-time (inside a method), so the bindings are live by the time any method runs.
import { ConfigPlugin } from "./config_plugin.js";
import { ServerPlugin } from "./server_plugin.js";
import { CodePlugin } from "./code_plugin.js";
import { EventLogPlugin } from "./event_log_plugin.js";

import { usePlugin } from "@odoo/owl";

export { ORM };

// Resolve owl plugins from a record's own ORM scope, at call time. A config record is
// seeded during ConfigPlugin construction — before higher-sequence plugins start — so a
// field-initializer usePlugin() would resolve too early; running inside the record's stored
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
const SETTINGS_BOOLS = [
  "auto_open_event_log",
  "update_check",
  "rust_bundler",
  "workspace_categories_enabled",
];
const SETTINGS_JSON = ["start", "tabs", "links", "test_presets", "workspace_categories"];
// the app-state blob keys (were the scattered oo-* localStorage keys, see config_plugin)
const STATE_CHARS = ["active_workspace", "claude_model"];
const STATE_JSON = ["test_history"];

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
  workspace_categories_enabled = fields.bool();
  start = fields.json();
  tabs = fields.json();
  links = fields.json();
  test_presets = fields.json();
  workspace_categories = fields.json(); // [{ id }] — group order for the Workspaces list
}

export class Repository extends Model {
  static id = "repository";
  path = fields.char();
  github = fields.char();
  pull_remote = fields.char();
  push_remote = fields.char();
  favorite = fields.bool();
  external = fields.bool();
  autoreload = fields.bool();
  checkouts = fields.one2many({ comodel: () => Checkout, inverse: "repository" });

  // the canonical GitHub slug — the stored value, else the built-in default for this id
  githubOrDefault() {
    return this.github() || DEFAULT_CONFIG.repos.find((d) => d.id === this.id)?.github || "";
  }

  // the configured git remotes, never blank — fetch/rebase pull from pullRemote,
  // push/remote-delete go to pushRemote
  pullRemote() {
    return this.pull_remote() || "origin";
  }

  pushRemote() {
    return this.push_remote() || "dev";
  }

  // `pushSlug`: the push remote's actual resolved "owner/repo" (from live git
  // state — see CodePlugin), so the fork link/compare page point at the real
  // fork rather than the hardcoded odoo-dev fallback baked into repoUrls.
  compareUrl(branch, pushSlug) {
    return repoUrls.compare(this.githubOrDefault(), branch, pushSlug);
  }

  forkBranchUrl(branch, pushSlug) {
    return repoUrls.fork(this.githubOrDefault(), branch, pushSlug);
  }

  remoteBranchUrl(branch, pushSlug) {
    return repoUrls.remote(this.githubOrDefault(), branch, pushSlug);
  }

  mergebotUrl(number) {
    return repoUrls.mergebot(this.githubOrDefault(), number);
  }

  pullRequestUrl(number) {
    return repoUrls.pullRequest(this.githubOrDefault(), number);
  }
}

// The pure GitHub/mergebot URL builders (keyed by slug). The Repository methods above
// are the model-facing API; these back them and are exported so CodePlugin can build a
// URL for a PR whose repo isn't in config (e.g. a forward port in an unfavorited repo
// has no Repository record). One source of truth, callable with a record or a bare slug.
//
// `pushSlug` ("owner/repo") is the push remote's actual resolved fork, from live git
// state (a repo's fork can live under a different owner — and even a differently-named
// repo — than its upstream `github` slug, and that varies independently per repo). It
// falls back to "odoo-dev" + the upstream repo name when not supplied (not yet resolved,
// or a repo outside config entirely) — the old hardcoded assumption, kept only as a
// last resort so a URL is still produced.
export const repoUrls = {
  // GitHub "create PR" compare page for a work branch (base inferred from the name)
  compare(github, branch, pushSlug) {
    const base = baseBranchOf(branch);
    const name = github.split("/")[1];
    const [forkOwner, forkRepo] = pushSlug ? pushSlug.split("/") : ["odoo-dev", name];
    return `https://github.com/${github}/compare/${base}...${forkOwner}:${forkRepo}:${branch}?expand=1`;
  },
  // the branch on the fork the push remote actually points to
  fork(github, branch, pushSlug) {
    const name = github.split("/")[1];
    const slug = pushSlug || `odoo-dev/${name}`;
    return `https://github.com/${slug}/tree/${encodeURIComponent(branch)}`;
  },
  // where a branch lives remotely: base branches on the canonical repo, work branches on the fork
  remote(github, branch, pushSlug) {
    if (BASE_BRANCH_RE.test(branch)) {
      return `https://github.com/${github}/tree/${encodeURIComponent(branch)}`;
    }
    return repoUrls.fork(github, branch, pushSlug);
  },
  // the mergebot page for one of this repo's PRs
  mergebot(github, number) {
    return `${MERGEBOT}/${github}/pull/${number}`;
  },
  // the canonical GitHub page for an existing PR
  pullRequest(github, number) {
    return `https://github.com/${github}/pull/${number}`;
  },
};

export class Workspace extends Model {
  static id = "workspace";
  name = fields.char();
  created_at = fields.char(); // ISO timestamp; immutable after creation
  last_activity = fields.char(); // ISO timestamp; intentional workspace actions only
  favorite = fields.bool();
  category = fields.char(); // a workspace_categories id ("" = uncategorized)
  parent = fields.char(); // the id of the workspace this one was spawned from
  // ("" = none/root); cascade-deleted with it — see cascadeRemoveDescendants
  // (workspace_plugin.js)
  notes = fields.char(); // free-form user notes (the Details tab)
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
  // the explicit `location` marks a worktree, falling back to `worktree` metadata presence
  isWorktree() {
    return (this.location() || (this.worktree() ? "worktree" : "main")) === "worktree";
  }

  hasCommunity() {
    return this.checkouts().some((c) => c.repository().id === "community");
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
    return withScope(this, () => usePlugin(ConfigPlugin));
  }

  toggleDemoData() {
    this.demo_data.set(!this.demo_data());
    this._configPlugin().touch();
  }

  // persist the Details tab's notes (no touchActivity — writing a note is
  // bookkeeping, not workspace activity)
  setNotes(text) {
    if (text === this.notes()) return;
    this.notes.set(text);
    this._configPlugin().touch();
  }

  touchActivity() {
    this.last_activity.set(new Date().toISOString());
    this._configPlugin().touch();
  }

  // commit an inline edit onto the target (favorite/demo_data untouched — each is
  // toggled directly via its own checkbox).
  // The caller validates; checkouts arrive already parsed as [{repo, branch}].
  applyEdit({ name, checkouts, db, on_create_args, category }) {
    this.name.set(name);
    this.db.set(db);
    this.on_create_args.set(on_create_args);
    if (category !== undefined) this.category.set(category);
    reconcileCheckouts(this.orm, { id: this.id, checkouts });
    this.touchActivity();
  }

  // move the workspace to <category> ("" = uncategorized) leaving the rest —
  // including its activity stamp — untouched (archiving is shelving, not use)
  setCategory(category) {
    this.category.set(category || "");
  }

  // demote to root ("" = no parent) — used only by cascadeRemoveDescendants
  // when this workspace's own removal was blocked; parent is otherwise fixed
  // once, at creation
  setParent(parent) {
    this.parent.set(parent || "");
    this._configPlugin().touch();
  }

  // ── action: stop the server, switch to this workspace, check out its branches ─
  // restore: re-checkout even when this workspace is already the active one — the
  // recovery path when a manual `git checkout` drifted the main checkout away from
  // the workspace's branches (the guards on missing/dirty branches still apply).
  async activate({ restore = false } = {}) {
    const { server, code, eventLog } = withScope(this, () => ({
      server: usePlugin(ServerPlugin),
      code: usePlugin(CodePlugin),
      eventLog: usePlugin(EventLogPlugin),
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
    if (this.id === server.loadedWorkspaceId() && !restore) return;
    if (!cos.every(({ repo, branch }) => repoMap[repo]?.branches.has(branch))) return;
    if (cos.some(({ repo }) => repoMap[repo]?.dirty)) return;
    this.touchActivity();
    const pathByRepo = code.groups().pathByRepo;
    const repos = cos
      .map(({ repo, branch }) => ({ repo, path: pathByRepo[repo], branch }))
      .filter((r) => r.path);
    eventLog.add(`activating workspace ${this.name()}`);
    // checking out several repos takes seconds; the flag drives the Workspaces
    // screen's blocking overlay so the wait doesn't look like nothing happening
    server.activatingId.set(this.id);
    try {
      // no per-repo pre-log: the backend announces each checkout as a timed SSE
      // event ("checking out …" with a live "..." resolving to ok/failed) — a
      // plain line here would just duplicate it
      // stop the server and switch branches concurrently (independent ops)
      const s = server.status();
      const stopping =
        s.state === "running" || s.state === "starting"
          ? server.stop({ trackActivity: false })
          : null;
      await Promise.all([stopping, code.checkout(repos)]);
      server.setLastWorkspace(this.id);
    } finally {
      // must clear even if a checkout throws, or the UI stays blocked for good
      server.activatingId.set("");
    }
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
}

export const CONFIG_MODELS = [Settings, Repository, Workspace, Template, Checkout, AppState];

const checkoutId = (workspaceId, repo) => `${workspaceId}:${repo}`;

// ── legacy target shape → workspace shape (migration-only mapping) ───────────────

// a stored legacy target object → the workspace shape (no `port` — the migration
// deals stable ports itself). Used ONLY by migrateToWorkspaces (config_plugin).
export function workspaceFromTarget(t) {
  const location =
    (t.kind || (t.worktree ? "worktree" : "plain")) === "worktree" ? "worktree" : "main";
  return {
    id: t.id,
    name: t.name ?? "",
    created_at: t.created_at ?? "",
    last_activity: t.last_activity ?? "",
    favorite: !!t.favorite,
    db: t.db ?? "",
    on_create_args: t.on_create_args ?? "",
    demo_data: t.demo_data ?? true,
    location,
    worktree: t.worktree ?? null,
    checkouts: t.checkouts || [],
  };
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
  settings.workspace_categories = config.workspace_categories ?? [];
  orm.create(Settings, settings);

  for (const r of config.repos || []) createRepo(orm, r);
  for (const w of config.workspaces || []) createWorkspace(orm, w); // repos exist → checkout m2o resolves
  for (const t of config.templates || []) createTemplate(orm, t);

  const st = { id: "state" };
  for (const k of STATE_CHARS) st[k] = state[k] ?? "";
  for (const k of STATE_JSON) st[k] = state[k] ?? [];
  orm.create(AppState, st);
}

// ── blob-facing field specs ───────────────────────────────────────────────────
// One entry per scalar field a model round-trips through the config blob:
//   in(value, blob)  blob value → record value (defaults / normalization)
//   out(rec)         record value → blob value (default: rec[name]())
//   reconcile        "set" (default) = a patch always overwrites the field;
//                    "ifPresent" = only when the patch object carries the key
// toModels, toConfig and the reconcilers all iterate these specs, so adding a field
// is the fields.*() declaration on the model + one line here — nothing else to keep
// in sync (relational fields — checkouts — stay hand-wired).
const char = (name) => ({ name, in: (v) => v ?? "" });
const bool = (name, dflt = false) => ({ name, in: dflt ? (v) => v ?? true : (v) => !!v });

const REPO_FIELDS = [
  char("path"),
  char("github"),
  // `||` normalization migrates configs saved before these fields existed (blank → default)
  { name: "pull_remote", in: (v) => v || "origin", out: (r) => r.pullRemote() },
  { name: "push_remote", in: (v) => v || "dev", out: (r) => r.pushRemote() },
  bool("favorite"),
  bool("external"),
  bool("autoreload"),
];

const WORKSPACE_FIELDS = [
  char("name"),
  { ...char("created_at"), reconcile: "ifPresent" },
  { ...char("last_activity"), reconcile: "ifPresent" },
  bool("favorite"),
  char("category"),
  char("parent"),
  char("notes"),
  char("db"),
  char("on_create_args"),
  bool("demo_data", true),
  { name: "location", in: (v, w) => v || (w.worktree ? "worktree" : "main") },
  { name: "worktree", in: (v) => v ?? null },
  // absent key in a patch = keep the stable port; null on the wire = none
  { name: "port", in: (v) => v ?? 0, out: (w) => w.port() || null, reconcile: "ifPresent" },
];

const TEMPLATE_FIELDS = [
  char("name"),
  char("db"),
  char("on_create_args"),
  bool("demo_data", true),
  { name: "checkouts", in: (v) => v || [], out: (t) => t.checkouts() || [] },
];

function dataFromBlob(fields, blob) {
  const data = { id: blob.id };
  for (const f of fields) data[f.name] = f.in(blob[f.name], blob);
  return data;
}
function blobFromRecord(fields, rec) {
  const out = { id: rec.id };
  for (const f of fields) out[f.name] = f.out ? f.out(rec) : rec[f.name]();
  return out;
}
function updateFromBlob(fields, rec, item) {
  for (const f of fields) {
    if (f.reconcile === "ifPresent" && !(f.name in item)) continue;
    rec[f.name].set(f.in(item[f.name], item));
  }
}

function createRepo(orm, r) {
  orm.create(Repository, dataFromBlob(REPO_FIELDS, r));
}

function createWorkspace(orm, w) {
  orm.create(Workspace, dataFromBlob(WORKSPACE_FIELDS, w));
  for (const c of w.checkouts || []) {
    orm.create(Checkout, {
      id: checkoutId(w.id, c.repo),
      workspace: w.id,
      repository: c.repo,
      branch: c.branch ?? "",
    });
  }
}

function createTemplate(orm, t) {
  orm.create(Template, dataFromBlob(TEMPLATE_FIELDS, t));
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
    out.workspace_categories = s.workspace_categories() ?? [];
  }
  out.repos = orm.records(Repository).map((r) => blobFromRecord(REPO_FIELDS, r));
  out.workspaces = orm.records(Workspace).map((w) => ({
    ...blobFromRecord(WORKSPACE_FIELDS, w),
    checkouts: w.checkouts().map((c) => ({ repo: c.repository().id, branch: c.branch() })),
  }));
  out.templates = orm.records(Template).map((t) => blobFromRecord(TEMPLATE_FIELDS, t));
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
  if ("templates" in patch) reconcileTemplates(orm, patch.templates || []);
  if ("workspaces" in patch) reconcileWorkspaces(orm, patch.workspaces || []);
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
    (rec, r) => updateFromBlob(REPO_FIELDS, rec, r),
    createRepo,
  );
}

// desired = workspace-shaped objects. A migration-produced workspace may carry no
// `port` — creates then allocate the next free one for a worktree-located workspace.
function reconcileWorkspaces(orm, desired) {
  reconcile(
    orm,
    Workspace,
    desired,
    (w) => w.id,
    (rec, w) => {
      updateFromBlob(WORKSPACE_FIELDS, rec, w);
      reconcileCheckouts(orm, w);
    },
    (o, w) => {
      const location = w.location || (w.worktree ? "worktree" : "main");
      const port = w.port ?? (location === "worktree" ? nextFreePort(o) : 0);
      const created_at = w.created_at || new Date().toISOString();
      createWorkspace(o, {
        ...w,
        port,
        created_at,
        last_activity: w.last_activity || created_at,
      });
    },
  );
  // a deleted workspace's checkouts must go too (o2m is unlinked, not cascade-deleted)
  const live = new Set(desired.map((w) => w.id));
  for (const c of orm.records(Checkout)) {
    const ws = c.workspace();
    if (!ws || !live.has(ws.id)) orm.delete(c);
  }
  // heal a dangling `parent` (referenced workspace no longer exists) by demoting the
  // child to root. Should never actually trigger — every real removal path cascades
  // its descendants (cascadeRemoveDescendants, workspace_plugin.js) — this is just a
  // cheap safety net for any path that isn't (or a future one that forgets to be).
  const liveIds = new Set(orm.records(Workspace).map((r) => r.id));
  for (const rec of orm.records(Workspace)) {
    if (rec.parent() && !liveIds.has(rec.parent())) rec.parent.set("");
  }
  // persist the desired ORDER too: orm.records() returns insertion order and the
  // in-place reconcile above never moves records, so a reorder patch (the Targets
  // screen's drag) wouldn't survive toConfig (bug present since the ORM refactor).
  // When the id order changed, rebuild the records in the desired order — the data is
  // fully carried by `desired` plus the ports the reconcile just settled.
  const have = orm.records(Workspace).map((r) => r.id);
  const want = desired.map((w) => w.id);
  if (have.join("\n") !== want.join("\n")) {
    const existing = new Map(
      orm
        .records(Workspace)
        .map((r) => [
          r.id,
          { port: r.port(), created_at: r.created_at(), last_activity: r.last_activity() },
        ]),
    );
    for (const c of orm.records(Checkout)) orm.delete(c);
    for (const r of orm.records(Workspace)) orm.delete(r);
    for (const w of desired) {
      const old = existing.get(w.id);
      const created_at = w.created_at || old?.created_at || new Date().toISOString();
      createWorkspace(orm, {
        ...w,
        port: w.port ?? old?.port ?? 0,
        created_at,
        last_activity: w.last_activity || old?.last_activity || created_at,
      });
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
    (rec, t) => updateFromBlob(TEMPLATE_FIELDS, rec, t),
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
