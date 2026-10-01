// The config family as owl-orm models — the first real conversion of goo's state
// onto the client ORM (vendor/owl-orm, bundled into the app, sharing goo's window.owl
// reactivity).
//
// ConfigPlugin (config_plugin.ts) is the adapter that owns an ORM seeded from these
// models and keeps its flat `config` / `getState` / `setState` / `updateConfig` API,
// so the ~72 `config.config.*` consumers, the backend, and the full-blob write wire
// are all unchanged. This module holds the models + the pure serializers that bridge
// the flat config blob (config.ts DEFAULT_CONFIG shape) and the normalized records:
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
import {
  ARCHIVED_CATEGORY,
  DEFAULT_CONFIG,
  BASE_BRANCH_RE,
  MERGEBOT,
  baseBranchOf,
} from "./config.ts";
import { worktreeDirFor } from "./utils.ts";
// Plugin classes are imported for the models' action methods to resolve via usePlugin().
// This makes config_models ↔ config_plugin / code_plugin a cycle, but every use is
// call-time (inside a method), so the bindings are live by the time any method runs.
import { ConfigPlugin } from "./config_plugin.ts";
import { ServerPlugin } from "./server_plugin.ts";
import { CodePlugin } from "./code_plugin.ts";
import { EventLogPlugin } from "./event_log_plugin.ts";

import { usePlugin } from "@odoo/owl";
import type { Signal } from "@odoo/owl";
import type {
  AppStateBlob,
  CheckoutConfig,
  Config,
  ConfigInput,
  DockerImage,
  LegacyTarget,
  NavLink,
  RepoConfig,
  RepoInput,
  ReviewEntry,
  StartConfig,
  StateInput,
  TabConfig,
  TemplateConfig,
  TemplateInput,
  WorkspaceConfig,
  WorkspaceInput,
  WorktreeInfo,
} from "./config.ts";

export { ORM };

// an owl-orm model class (the ORM's own constraint on records()/create())
type ModelClass = typeof Model & { id: string };

// Resolve owl plugins from a record's own ORM scope, at call time. A config record is
// seeded during ConfigPlugin construction — before higher-sequence plugins start — so a
// field-initializer usePlugin() would resolve too early; running inside the record's stored
// scope (orm._ctx) at call time resolves against the fully-started plugin manager.
function withScope<T>(rec: Model, fn: () => T): T {
  const ctx = rec.orm._ctx;
  return ctx ? ctx.run(fn) : fn();
}

// what Workspace.applyEdit takes: the inline edit form, checkouts already parsed
export interface WorkspaceEdit {
  name: string;
  checkouts: CheckoutConfig[];
  db: string;
  on_create_args: string;
  category?: string;
}

// toConfig's output: every Config key Settings carries, plus the record collections
export type ConfigBlob = Partial<Config> & Pick<Config, "repos" | "workspaces" | "templates">;

// scalar settings that live as flat keys on the config blob
const SETTINGS_CHARS = [
  "work_dir",
  "venv_activate",
  "server_path",
  "worktree_dir",
  "db_user",
  "db_password",
  "db_host",
  "db_port",
  "filestore",
  "log_level",
  "editor",
  "main_repo_id",
  "launch_mode",
  "docker_network",
  "docker_postgres_image",
  "docker_postgres_container",
  "docker_postgres_port",
  "docker_postgres_volume",
  "docker_nginx_image",
  "docker_nginx_container",
  "docker_nginx_port",
  "docker_mount_path",
  "docker_filestore_mount",
  "docker_container_user",
  "docker_extra_run_args",
  "default_workspace_location",
] as const;
const SETTINGS_BOOLS = [
  "auto_open_event_log",
  "update_check",
  "rust_bundler",
  "workspace_categories_enabled",
  "autologin_links",
  "cleanup_enabled",
  "docker_headed_browser",
  "auto_workspace_on_review",
  "auto_claude_review",
] as const;
const SETTINGS_JSON = [
  "start",
  "tabs",
  "links",
  "test_presets",
  "workspace_categories",
  "reviews",
  "docker_images",
] as const;
// the app-state blob keys (were the scattered oo-* localStorage keys, see config_plugin)
type SettingsKey =
  | (typeof SETTINGS_CHARS)[number]
  | (typeof SETTINGS_BOOLS)[number]
  | (typeof SETTINGS_JSON)[number];
const STATE_CHARS = ["active_workspace", "claude_model"] as const;
const STATE_JSON = ["test_history"] as const;

export class Settings extends Model {
  static id = "settings"; // singleton
  work_dir = fields.char();
  venv_activate = fields.char();
  server_path = fields.char();
  worktree_dir = fields.char();
  db_user = fields.char();
  db_password = fields.char();
  // empty = local unix socket (unchanged default); set both for a Postgres
  // only reachable over TCP (e.g. running in Docker)
  db_host = fields.char();
  db_port = fields.char();
  filestore = fields.char();
  log_level = fields.char();
  editor = fields.char();
  // the repo id that holds odoo-bin (default "community", matching upstream) —
  // configurable so a fork's own folder convention (e.g. "odoo") doesn't require
  // patching every hardcoded "community" check
  main_repo_id = fields.char();
  auto_open_event_log = fields.bool();
  update_check = fields.bool();
  rust_bundler = fields.bool();
  workspace_categories_enabled = fields.bool();
  // off = the /odoo, /web/tests buttons link the plain path instead of going
  // through goo's autologin route -- for people who'd rather log in themselves
  autologin_links = fields.bool();
  // off by default -- automatically deletes merged worktree workspaces once a
  // day (see backend/cleanup.py); opt-in since it deletes things on its own
  cleanup_enabled = fields.bool();
  // off by default -- when a PR is added in the Reviews screen (including any
  // sibling PR auto-discovered on the same branch), auto-create a worktree
  // workspace for it (createReviewWorkspace, workspaces_screen/dialogs.ts)
  auto_workspace_on_review = fields.bool();
  // off by default, nested under auto_workspace_on_review -- also auto-run a
  // Claude review (runClaudeReview, workspaces_screen/dialogs.ts) in the
  // freshly-created review workspace. The manual "Review" action in the
  // Reviews screen works regardless of this setting.
  auto_claude_review = fields.bool();
  // "local" | "docker" | "external" — see DEFAULT_CONFIG's comment (config.ts).
  // Replaces the old hide_start_controls boolean (migrated in toModels below);
  // "docker"/"local" both get goo's own Start/Stop/logs/terminal, "external" hides them.
  launch_mode = fields.char();
  // ── docker_*: only read/shown when launch_mode is "docker" ────────────────
  docker_network = fields.char();
  docker_postgres_image = fields.char();
  docker_postgres_container = fields.char();
  docker_postgres_port = fields.char();
  docker_postgres_volume = fields.char();
  docker_nginx_image = fields.char();
  docker_nginx_container = fields.char();
  docker_nginx_port = fields.char();
  docker_mount_path = fields.char();
  docker_filestore_mount = fields.char();
  docker_container_user = fields.char();
  docker_extra_run_args = fields.char();
  // forwards the host's X11 display + a larger --shm-size + --privileged, so a
  // headed browser (watch=True, a debugged tour) renders on the host desktop
  docker_headed_browser = fields.bool();
  docker_images: Signal<DockerImage[]> = fields.json(); // [{id, label, versions: [...], dockerfile_path?, image?, is_default}]
  // "main" or "worktree" — the create-workspace dialog's Location default
  default_workspace_location = fields.char();
  start: Signal<StartConfig> = fields.json();
  tabs: Signal<TabConfig[]> = fields.json();
  links: Signal<NavLink[]> = fields.json();
  test_presets: Signal<{ tags: string }[]> = fields.json();
  workspace_categories: Signal<{ id: string }[]> = fields.json(); // [{ id }] — group order for the Workspaces list
  reviews: Signal<ReviewEntry[]> = fields.json(); // [{ id, github, number, important? }] — the Reviews screen's tracked PRs
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
  githubOrDefault(): string {
    return this.github() || DEFAULT_CONFIG.repos.find((d) => d.id === this.id)?.github || "";
  }

  // the configured git remotes, never blank — fetch/rebase pull from pullRemote,
  // push/remote-delete go to pushRemote
  pullRemote(): string {
    return this.pull_remote() || "origin";
  }

  pushRemote(): string {
    return this.push_remote() || "dev";
  }

  // `pushSlug`: the push remote's actual resolved "owner/repo" (from live git
  // state — see CodePlugin), so the fork link/compare page point at the real
  // fork rather than the hardcoded odoo-dev fallback baked into repoUrls.
  compareUrl(branch: string, pushSlug?: string | null): string {
    return repoUrls.compare(this.githubOrDefault(), branch, pushSlug);
  }

  forkBranchUrl(branch: string, pushSlug?: string | null): string {
    return repoUrls.fork(this.githubOrDefault(), branch, pushSlug);
  }

  remoteBranchUrl(branch: string, pushSlug?: string | null): string {
    return repoUrls.remote(this.githubOrDefault(), branch, pushSlug);
  }

  mergebotUrl(number: number): string {
    return repoUrls.mergebot(this.githubOrDefault(), number);
  }

  pullRequestUrl(number: number): string {
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
  compare(github: string, branch: string, pushSlug?: string | null): string {
    const base = baseBranchOf(branch);
    const name = github.split("/")[1];
    const [forkOwner, forkRepo] = pushSlug ? pushSlug.split("/") : ["odoo-dev", name];
    return `https://github.com/${github}/compare/${base}...${forkOwner}:${forkRepo}:${branch}?expand=1`;
  },
  // the branch on the fork the push remote actually points to
  fork(github: string, branch: string, pushSlug?: string | null): string {
    const name = github.split("/")[1];
    const slug = pushSlug || `odoo-dev/${name}`;
    return `https://github.com/${slug}/tree/${encodeURIComponent(branch)}`;
  },
  // where a branch lives remotely: base branches on the canonical repo, work branches on the fork
  remote(github: string, branch: string, pushSlug?: string | null): string {
    if (BASE_BRANCH_RE.test(branch)) {
      return `https://github.com/${github}/tree/${encodeURIComponent(branch)}`;
    }
    return repoUrls.fork(github, branch, pushSlug);
  },
  // the mergebot page for one of this repo's PRs
  mergebot(github: string, number: number): string {
    return `${MERGEBOT}/${github}/pull/${number}`;
  },
  // the canonical GitHub page for an existing PR
  pullRequest(github: string, number: number): string {
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
  // (workspace_plugin.ts)
  notes = fields.char(); // free-form user notes (the Details tab)
  db = fields.char();
  on_create_args = fields.char();
  demo_data = fields.bool({ defaultValue: true });
  // where the workspace physically lives: "main" = the primary checkout (shared —
  // only one main-located workspace is loaded at a time, on the implicit :8069),
  // "worktree" = its own git worktree dir, running concurrently on its own port
  location = fields.char({ defaultValue: "main" });
  worktree: Signal<WorktreeInfo | null> = fields.json(); // { base, dir, venv? } | null — only worktree workspaces
  port = fields.number(); // stable server port (worktree only; 0 = none/main)
  checkouts = fields.one2many({ comodel: () => Checkout, inverse: "workspace" });

  // ── derivations (pure — this + this.orm) ─────────────────────────────────────
  // the explicit `location` marks a worktree, falling back to `worktree` metadata presence
  isWorktree(): boolean {
    return (this.location() || (this.worktree() ? "worktree" : "main")) === "worktree";
  }

  // does this workspace have a checkout of the configured main repo (default
  // "community", see Settings.main_repo_id) — the one that holds odoo-bin
  hasMainRepo(): boolean {
    const settings = this.orm.getById(Settings, "settings");
    const mainRepoId = settings?.main_repo_id() || "community";
    return this.checkouts().some((c) => c.repository()!.id === mainRepoId);
  }

  // every workspace spawned from this one, at any depth, parent-before-child. The
  // subtree that travels with it — see setCategory (archiving) and, on the delete
  // side, cascadeRemoveDescendants (workspace_plugin.ts), which walks the blob
  // level-by-level instead so it can stop descending at a child it couldn't remove.
  descendants(): Workspace[] {
    const byParent = new Map<string, Workspace[]>();
    for (const w of this.orm.records(Workspace)) {
      const p = w.parent();
      if (!p) continue;
      let children = byParent.get(p);
      if (!children) byParent.set(p, (children = []));
      children.push(w);
    }
    const out: Workspace[] = [];
    const seen = new Set([this.id]); // cycle guard — `parent` is set once, at creation,
    let frontier = byParent.get(this.id) || []; // to an existing ancestor, but stay safe
    while (frontier.length) {
      const next: Workspace[] = [];
      for (const w of frontier) {
        if (seen.has(w.id)) continue;
        seen.add(w.id);
        out.push(w);
        next.push(...(byParent.get(w.id) || []));
      }
      frontier = next;
    }
    return out;
  }

  // the worktree's on-disk directory: the value frozen at creation (worktree.dir),
  // else derived from <settings.worktree_dir>/<name>. Persisting it means a later
  // rename can't move the path off the real checkout (worktreeDirFor, utils.ts).
  dirPath(): string {
    const dir = this.worktree()?.dir;
    if (dir) return dir;
    const settings = this.orm.getById(Settings, "settings");
    return worktreeDirFor(settings?.worktree_dir(), { name: this.name(), id: this.id });
  }

  // ── mutations (edit records, persist via ConfigPlugin's existing save wire) ───
  _configPlugin() {
    return withScope(this, () => usePlugin(ConfigPlugin));
  }

  toggleDemoData(): void {
    this.demo_data.set(!this.demo_data());
    this._configPlugin().touch();
  }

  // persist the Details tab's notes (no touchActivity — writing a note is
  // bookkeeping, not workspace activity)
  setNotes(text: string): void {
    if (text === this.notes()) return;
    this.notes.set(text);
    this._configPlugin().touch();
  }

  touchActivity(): void {
    this.last_activity.set(new Date().toISOString());
    this._configPlugin().touch();
  }

  // commit an inline edit onto the target (favorite/demo_data untouched — each is
  // toggled directly via its own checkbox).
  // The caller validates; checkouts arrive already parsed as [{repo, branch}].
  applyEdit({ name, checkouts, db, on_create_args, category }: WorkspaceEdit): void {
    this.name.set(name);
    this.db.set(db);
    this.on_create_args.set(on_create_args);
    if (category !== undefined) this.setCategory(category); // cascades in/out of "archived"
    reconcileCheckouts(this.orm, { id: this.id, checkouts });
    this.touchActivity();
  }

  // move the workspace to <category> ("" = uncategorized) leaving the rest —
  // including its activity stamp — untouched (archiving is shelving, not use).
  // Crossing the archived boundary carries the whole sub-workspace subtree along: a
  // sub-workspace only exists because of the workspace it was spawned from, so
  // shelving that parent shelves the work spawned from it, and restoring the parent
  // brings the subtree back with it (it also keeps parent and children in one list
  // group, which is what makes the nested rendering possible).
  setCategory(category: string | null | undefined): void {
    const cat = category || "";
    const wasArchived = this.category() === ARCHIVED_CATEGORY;
    const nowArchived = cat === ARCHIVED_CATEGORY;
    this.category.set(cat);
    if (nowArchived !== wasArchived) {
      for (const child of this.descendants()) {
        // leaving the archive only lifts the descendants that were shelved with it —
        // one re-categorized in the meantime keeps the category it was given
        if (nowArchived || child.category() === ARCHIVED_CATEGORY) child.category.set(cat);
      }
    }
    this._configPlugin().touch();
  }

  // demote to root ("" = no parent) — used only by cascadeRemoveDescendants
  // when this workspace's own removal was blocked; parent is otherwise fixed
  // once, at creation
  setParent(parent: string | null | undefined): void {
    this.parent.set(parent || "");
    this._configPlugin().touch();
  }

  // ── action: stop the server, switch to this workspace, check out its branches ─
  // restore: re-checkout even when this workspace is already the active one — the
  // recovery path when a manual `git checkout` drifted the main checkout away from
  // the workspace's branches (the guards on missing/dirty branches still apply).
  async activate({ restore = false }: { restore?: boolean } = {}): Promise<void> {
    const { server, code, eventLog } = withScope(this, () => ({
      server: usePlugin(ServerPlugin),
      code: usePlugin(CodePlugin),
      eventLog: usePlugin(EventLogPlugin),
    }));
    // live git state per repo — for the guard + deciding which repos actually switch
    const repoMap: Record<string, { current: string; dirty: boolean; branches: Set<string> }> = {};
    for (const r of code.branchRepos()) {
      repoMap[r.id] = {
        current: r.current,
        dirty: r.dirty,
        branches: new Set((r.branches || []).map((b) => b.name)),
      };
    }
    const cos = this.checkouts().map((c) => ({ repo: c.repository()!.id, branch: c.branch() }));
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
  workspace = fields.many2one({ comodel: () => Workspace });
  // never null: every Checkout is created with its repo id (createWorkspace /
  // reconcileCheckouts), hence the `repository()!` reads
  repository = fields.many2one({ comodel: () => Repository });
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
  category = fields.char(); // default workspace_categories id new workspaces inherit ("" = none)
  checkouts: Signal<CheckoutConfig[]> = fields.json();
}

export class AppState extends Model {
  static id = "appstate"; // singleton — the app-recorded state blob
  active_workspace = fields.char();
  claude_model = fields.char();
  test_history: Signal<string[]> = fields.json();
}

export const CONFIG_MODELS = [Settings, Repository, Workspace, Template, Checkout, AppState];

const checkoutId = (workspaceId: string, repo: string): string => `${workspaceId}:${repo}`;

// ── legacy target shape → workspace shape (migration-only mapping) ───────────────

// a stored legacy target object → the workspace shape (no `port` — the migration
// deals stable ports itself). Used ONLY by migrateToWorkspaces (config_plugin).
export function workspaceFromTarget(t: LegacyTarget & { id: string }): WorkspaceInput {
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
export function nextFreePort(orm: ORM): number {
  const used = new Set([...RESERVED_PORTS, ...orm.records(Workspace).map((w) => w.port())]);
  let p = 8070;
  while (used.has(p)) p++;
  return p;
}

// ── blob → records ────────────────────────────────────────────────────────────

// seed an empty ORM from a {config, state} pair (boot / reset / preset / import).
// The blob arrives normalized (config_plugin's normalizeConfigState ran the one-time
// targets→workspaces migration), so `workspaces`/`templates` are authoritative here.
export function toModels(orm: ORM, config: ConfigInput = {}, state: StateInput = {}): void {
  const settings: Record<string, unknown> = { id: "settings" };
  for (const k of SETTINGS_CHARS) settings[k] = config[k] ?? "";
  for (const k of SETTINGS_BOOLS) settings[k] = !!config[k];
  // one-time migration: hide_start_controls (boolean) → launch_mode (3-way).
  // hide_start_controls is no longer a stored field at all — this is its only
  // remaining use, a migration input read straight off the raw incoming blob.
  if (!settings.launch_mode) {
    settings.launch_mode = config.hide_start_controls ? "external" : "local";
  }
  settings.start = config.start ?? {};
  settings.tabs = config.tabs ?? [];
  settings.links = config.links ?? [];
  settings.test_presets = config.test_presets ?? [];
  settings.workspace_categories = config.workspace_categories ?? [];
  settings.reviews = config.reviews ?? [];
  settings.docker_images = config.docker_images ?? [];
  orm.create(Settings, settings);

  for (const r of config.repos || []) createRepo(orm, r);
  for (const w of config.workspaces || []) createWorkspace(orm, w); // repos exist → checkout m2o resolves
  for (const t of config.templates || []) createTemplate(orm, t);

  const st: Record<string, unknown> = { id: "state" };
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
interface FieldSpec<B, R> {
  name: string;
  in(v: unknown, blob: B): unknown;
  out?(rec: R): unknown;
  reconcile?: "set" | "ifPresent";
}

// the reflective side of the specs: a blob is a plain JSON object read by key, and every
// spec name is one of the model's own fields.*() signals (the specs list exactly those)
const blobValue = (blob: object, key: string): unknown => (blob as Record<string, unknown>)[key];
const fieldOf = (rec: Model, name: string): Signal<unknown> =>
  (rec as unknown as Record<string, Signal<unknown>>)[name];

const char = (name: string) => ({ name, in: (v: unknown) => v ?? "" });
const bool = (name: string, dflt = false) => ({
  name,
  in: dflt ? (v: unknown) => v ?? true : (v: unknown) => !!v,
});

const REPO_FIELDS: FieldSpec<RepoInput, Repository>[] = [
  char("path"),
  char("github"),
  // `||` normalization migrates configs saved before these fields existed (blank → default)
  { name: "pull_remote", in: (v) => v || "origin", out: (r) => r.pullRemote() },
  { name: "push_remote", in: (v) => v || "dev", out: (r) => r.pushRemote() },
  bool("favorite"),
  bool("external"),
  bool("autoreload"),
];

const WORKSPACE_FIELDS: FieldSpec<WorkspaceInput, Workspace>[] = [
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

const TEMPLATE_FIELDS: FieldSpec<TemplateInput, Template>[] = [
  char("name"),
  char("db"),
  char("on_create_args"),
  bool("demo_data", true),
  char("category"),
  { name: "checkouts", in: (v) => v || [], out: (t) => t.checkouts() || [] },
];

function dataFromBlob<B extends { id: string }>(
  fields: FieldSpec<B, never>[],
  blob: B,
): Record<string, unknown> {
  const data: Record<string, unknown> = { id: blob.id };
  for (const f of fields) data[f.name] = f.in(blobValue(blob, f.name), blob);
  return data;
}
// O = the blob shape the specs describe: they emit every one of its fields
function blobFromRecord<R extends Model, O>(fields: FieldSpec<never, R>[], rec: R): O {
  const out: Record<string, unknown> = { id: rec.id };
  for (const f of fields) out[f.name] = f.out ? f.out(rec) : fieldOf(rec, f.name)();
  return out as O;
}
function updateFromBlob<B extends object, R extends Model>(
  fields: FieldSpec<B, R>[],
  rec: R,
  item: B,
): void {
  for (const f of fields) {
    if (f.reconcile === "ifPresent" && !(f.name in item)) continue;
    fieldOf(rec, f.name).set(f.in(blobValue(item, f.name), item));
  }
}

function createRepo(orm: ORM, r: RepoInput): void {
  orm.create(Repository, dataFromBlob(REPO_FIELDS, r));
}

function createWorkspace(orm: ORM, w: WorkspaceInput): void {
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

function createTemplate(orm: ORM, t: TemplateInput): void {
  orm.create(Template, dataFromBlob(TEMPLATE_FIELDS, t));
}

// ── records → blob ──────────────────────────────────────────────────────────────

export function toConfig(orm: ORM): ConfigBlob {
  const s = orm.getById(Settings, "settings");
  const out: Partial<Config> = {};
  if (s) {
    for (const k of SETTINGS_CHARS) out[k] = s[k]();
    for (const k of SETTINGS_BOOLS) out[k] = s[k]();
    out.start = s.start() ?? {};
    out.tabs = s.tabs() ?? [];
    out.links = s.links() ?? [];
    out.test_presets = s.test_presets() ?? [];
    out.workspace_categories = s.workspace_categories() ?? [];
    out.reviews = s.reviews() ?? [];
    out.docker_images = s.docker_images() ?? [];
  }
  const repos = orm
    .records(Repository)
    .map((r) => blobFromRecord<Repository, RepoConfig>(REPO_FIELDS, r));
  const workspaces = orm.records(Workspace).map((w): WorkspaceConfig => ({
    ...blobFromRecord<Workspace, Omit<WorkspaceConfig, "checkouts">>(WORKSPACE_FIELDS, w),
    checkouts: w.checkouts().map((c) => ({ repo: c.repository()!.id, branch: c.branch() })),
  }));
  const templates = orm
    .records(Template)
    .map((t) => blobFromRecord<Template, TemplateConfig>(TEMPLATE_FIELDS, t));
  return { ...out, repos, workspaces, templates };
}

export function toState(orm: ORM): Partial<AppStateBlob> {
  const st = orm.getById(AppState, "state");
  if (!st) return {};
  const out: Partial<AppStateBlob> = {};
  for (const k of STATE_CHARS) out[k] = st[k]();
  for (const k of STATE_JSON) out[k] = st[k]();
  return out;
}

// ── flat patch → minimal record edits (the updateConfig diff-sync) ───────────────

export function applyPatch(orm: ORM, patch: ConfigInput): void {
  const s = orm.getById(Settings, "settings");
  if (s) {
    // each key's Settings signal holds that same key's Config value
    const settingsFields: Record<SettingsKey, Signal<unknown>> = s;
    for (const k of [...SETTINGS_CHARS, ...SETTINGS_BOOLS, ...SETTINGS_JSON]) {
      if (k in patch) settingsFields[k].set(patch[k]);
    }
  }
  if ("repos" in patch) reconcileRepos(orm, patch.repos || []);
  if ("templates" in patch) reconcileTemplates(orm, patch.templates || []);
  if ("workspaces" in patch) reconcileWorkspaces(orm, patch.workspaces || []);
}

// reconcile a model's records against a desired array, keyed by `keyOf`: update the
// ones that stay, create the new ones, delete the ones that left. Returns nothing.
function reconcile<M extends ModelClass, I>(
  orm: ORM,
  Cls: M,
  desired: I[],
  keyOf: (item: I) => string,
  update: (rec: InstanceType<M>, item: I) => void,
  create: (orm: ORM, item: I) => void,
): void {
  const have = new Map(orm.records(Cls).map((rec) => [rec.id, rec]));
  const keep = new Set<string>();
  for (const item of desired) {
    const id = keyOf(item);
    keep.add(id);
    const rec = have.get(id);
    if (rec) update(rec, item);
    else create(orm, item);
  }
  for (const [id, rec] of have) if (!keep.has(id)) orm.delete(rec);
}

function reconcileRepos(orm: ORM, repos: RepoInput[]): void {
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
function reconcileWorkspaces(orm: ORM, desired: WorkspaceInput[]): void {
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
  // its descendants (cascadeRemoveDescendants, workspace_plugin.ts) — this is just a
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

function reconcileTemplates(orm: ORM, templates: TemplateInput[]): void {
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

function reconcileCheckouts(orm: ORM, w: { id: string; checkouts?: CheckoutConfig[] }): void {
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
  const keep = new Set<string>();
  for (const c of desired) {
    keep.add(c.id);
    const rec = have.get(c.id);
    if (rec) rec.branch.set(c.branch);
    else orm.create(Checkout, { id: c.id, workspace: w.id, repository: c.repo, branch: c.branch });
  }
  for (const [id, rec] of have) if (!keep.has(id)) orm.delete(rec);
}
