// The config family as owl-orm models — the first real conversion of goo's state
// onto the client ORM (static/lib/owlx.js, sharing goo's window.owl reactivity).
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
// a later refinement. The relational spine — Target → Checkout → Repository — is real.

import { Model, ORM, fields } from "../lib/owlx.js";

export { ORM };

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
const STATE_CHARS = ["active_target", "claude_model"];
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
}

export class Target extends Model {
  static id = "target";
  name = fields.char();
  favorite = fields.bool();
  db = fields.char();
  on_create_args = fields.char();
  kind = fields.char({ defaultValue: "plain" });
  worktree = fields.json(); // { base, dir } | null — only worktree targets
  checkouts = fields.one2many({ comodel: () => Checkout, inverse: "target" });
}

export class Checkout extends Model {
  static id = "checkout"; // id = `${target}:${repo}` — the join formerly mis-named target.config
  target = fields.many2one({ comodel: () => Target, inverse: "checkouts" });
  repository = fields.many2one({ comodel: () => Repository, inverse: "checkouts" });
  branch = fields.char();
}

export class AppState extends Model {
  static id = "appstate"; // singleton — the app-recorded state blob
  active_target = fields.char();
  claude_model = fields.char();
  test_history = fields.json();
  reviews_favorites = fields.json();
  reviews_merged = fields.json();
  reviews_no_mergebot = fields.json();
}

export const CONFIG_MODELS = [Settings, Repository, Target, Checkout, AppState];

const checkoutId = (targetId, repo) => `${targetId}:${repo}`;

// ── blob → records ────────────────────────────────────────────────────────────

// seed an empty ORM from a {config, state} pair (boot / reset / preset / import)
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
  for (const t of config.targets || []) createTarget(orm, t); // repos exist → checkout m2o resolves

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

function targetData(t) {
  return {
    id: t.id,
    name: t.name ?? "",
    favorite: !!t.favorite,
    db: t.db ?? "",
    on_create_args: t.on_create_args ?? "",
    kind: t.kind || "plain",
    worktree: t.worktree ?? null,
  };
}
function createTarget(orm, t) {
  orm.create(Target, targetData(t));
  for (const c of t.checkouts || []) {
    orm.create(Checkout, {
      id: checkoutId(t.id, c.repo),
      target: t.id,
      repository: c.repo,
      branch: c.branch ?? "",
    });
  }
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
  out.targets = orm.records(Target).map((t) => {
    const tgt = {
      id: t.id,
      name: t.name(),
      favorite: t.favorite(),
      db: t.db(),
      on_create_args: t.on_create_args(),
      kind: t.kind(),
      checkouts: t.checkouts().map((c) => ({ repo: c.repository().id, branch: c.branch() })),
    };
    const wt = t.worktree();
    if (wt) tgt.worktree = wt;
    return tgt;
  });
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
  if ("targets" in patch) reconcileTargets(orm, patch.targets || []);
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

function reconcileTargets(orm, targets) {
  reconcile(
    orm,
    Target,
    targets,
    (t) => t.id,
    (rec, t) => {
      const d = targetData(t);
      for (const k of ["name", "favorite", "db", "on_create_args", "kind", "worktree"]) {
        rec[k].set(d[k]);
      }
      reconcileCheckouts(orm, t);
    },
    (o, t) => createTarget(o, t),
  );
  // a deleted target's checkouts must go too (o2m is unlinked, not cascade-deleted)
  const liveTargets = new Set(targets.map((t) => t.id));
  for (const c of orm.records(Checkout)) {
    const tgt = c.target();
    if (!tgt || !liveTargets.has(tgt.id)) orm.delete(c);
  }
}

function reconcileCheckouts(orm, t) {
  const desired = (t.checkouts || []).map((c) => ({
    id: checkoutId(t.id, c.repo),
    repo: c.repo,
    branch: c.branch ?? "",
  }));
  const have = new Map(
    orm
      .records(Checkout)
      .filter((c) => c.target()?.id === t.id)
      .map((c) => [c.id, c]),
  );
  const keep = new Set();
  for (const c of desired) {
    keep.add(c.id);
    const rec = have.get(c.id);
    if (rec) rec.branch.set(c.branch);
    else orm.create(Checkout, { id: c.id, target: t.id, repository: c.repo, branch: c.branch });
  }
  for (const [id, rec] of have) if (!keep.has(id)) orm.delete(rec);
}
