// Config + app-state store, owned by the server (backend/services/config.py ConfigStore,
// persisted to ~/.config/goo/config.json as {rev, config, state}). This plugin is the
// client's adapter over that config: it seeds an owl-orm ORM from GET /api/config at
// boot (see loadServerConfig + config_models.ts), and keeps its flat public API —
// `config` / `getState` / `setState` / `updateConfig` / presets / snapshot — so the
// ~72 config consumers and the full-blob write wire are unchanged. Internally the
// state now lives in normalized ORM records (Settings/Repository/Workspace/Template/
// Checkout/AppState) instead of a flat signal; the changeset write wire + migrating
// consumers to read records directly are later passes.
//
//   config = the user's settings/repos/targets/… (schema in config.ts; the models
//            mirror it, and DEFAULT_CONFIG is merged in at read for new keys)
//   state  = app-recorded: active_workspace, test_history, claude_model

import { BASE_BRANCH_RE, DEFAULT_CONFIG, SECTIONS } from "./config.ts";
import { PRESETS } from "./presets.ts";
import type { Preset } from "./presets.ts";
import { errorMessage, worktreeDirFor } from "./utils.ts";
import type {
  AppStateBlob,
  Config,
  ConfigInput,
  LegacyTarget,
  StateInput,
  TemplateInput,
} from "./config.ts";
import {
  ORM,
  AppState,
  Workspace,
  Repository,
  CONFIG_MODELS,
  toModels,
  toConfig,
  toState,
  applyPatch,
  workspaceFromTarget,
  RESERVED_PORTS,
} from "./config_models.ts";
import type { ConfigBlob } from "./config_models.ts";

import { Plugin, signal, computed } from "@odoo/owl";
import type { Signal } from "@odoo/owl";

// a {rev, config, state} triple as GET/POST /api/config and the SSE "config" event carry it
interface ConfigPayload {
  rev: number;
  config: ConfigInput;
  state: StateInput;
}

// a portable config + state export (ConfigPlugin.snapshot / importSnapshot)
export interface ConfigSnapshot {
  config: ConfigBlob;
  state: Partial<AppStateBlob>;
}

// a target once migrateConfigState ran: every one has its id backfilled
type MigratedTarget = LegacyTarget & { id: string };

// the AppState record's fields, one signal per state blob key
type StateFields = { [K in keyof AppStateBlob]: Signal<AppStateBlob[K]> };

// old localStorage keys → their field in the server `state` blob. Used to adopt an
// upgrading user's browser data on first boot, and to translate config presets.
const STATE_KEYS: Record<string, keyof AppStateBlob> = {
  "oo-last-target": "active_workspace",
  "oo-test-history": "test_history",
  "oo-claude-model": "claude_model",
};

// a stable, unique id for a new target (referenced internally so renaming is safe)
export function newWorkspaceId(): string {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// a deterministic id derived from a name (used when migrating old configs so a
// re-run — e.g. re-adopting the same source — yields the same ids)
function slugId(name: string | undefined, used: Set<string>): string {
  const base =
    (name || "target")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "target";
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
  return id;
}

function tryParse(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return v; // plain strings (active_workspace, claude_model) aren't JSON
  }
}

// one-time, idempotent, deterministic migration of a {config, state} pair. Normalizes
// each target (backfill a stable id; rename the checkout list `config`→`checkouts`; add
// an explicit `kind`; freeze a worktree's `dir` so a rename can't orphan its checkout)
// and maps a name-based active target to its id. Runs as the first stage of
// migrateToWorkspaces (which every blob entry point goes through).
export function migrateConfigState(
  config: ConfigInput | null | undefined,
  state: StateInput | null | undefined,
): { config: ConfigInput; state: StateInput } {
  config = { ...(config || {}) };
  state = { ...(state || {}) };
  // active_target → active_workspace (Phase 2 state rename). Only when the new key
  // is absent, so a stray write from a still-open pre-workspace tab can't clobber a
  // live value; the old key is dropped (toState never re-emits it).
  if (state.active_workspace === undefined && state.active_target !== undefined) {
    state.active_workspace = state.active_target;
  }
  delete state.active_target;
  if (Array.isArray(config.targets)) {
    const stale = (t: LegacyTarget) =>
      !t.id || t.config !== undefined || !t.kind || (t.worktree && !t.worktree.dir);
    if (config.targets.some(stale)) {
      const worktreeDir = config.worktree_dir ?? DEFAULT_CONFIG.worktree_dir;
      const used = new Set(config.targets.map((t) => t.id).filter((id): id is string => !!id));
      config.targets = config.targets.map((t) => {
        const { config: checkoutList, ...rest } = t;
        const id = t.id || slugId(t.name, used);
        used.add(id);
        const worktree = t.worktree
          ? { ...t.worktree, dir: t.worktree.dir ?? worktreeDirFor(worktreeDir, { ...t, id }) }
          : t.worktree;
        return {
          ...rest,
          id,
          checkouts: t.checkouts ?? checkoutList ?? [],
          kind: t.kind ?? (t.worktree ? "worktree" : "plain"),
          ...(worktree ? { worktree } : {}),
        };
      });
    }
  }
  const at = state.active_workspace;
  if (at && Array.isArray(config.targets) && !config.targets.some((t) => t.id === at)) {
    const byName = config.targets.find((t) => t.name === at);
    if (byName) state.active_workspace = byName.id;
  }
  // tab list hygiene: retired section ids linger in stored configs (harmless — the
  // sidebar filters unknown ids — but they'd sit there forever). Map the renamed
  // ones onto their successors and drop the rest.
  if (Array.isArray(config.tabs)) {
    const RENAMED: Record<string, string> = { worktree: "workspaces" }; // retired ids just drop below
    const seen = new Set<string>();
    config.tabs = config.tabs
      .map((t) => (RENAMED[t.id] ? { ...t, id: RENAMED[t.id] } : t))
      .filter((t) => SECTIONS.includes(t.id) && !seen.has(t.id) && seen.add(t.id));
  }
  return { config, state };
}

// One-time, idempotent, deterministic targets→workspaces migration (the workspaces
// roadmap, Phase 1). Every target becomes a workspace (ids/order preserved; plain →
// location "main", worktree → "worktree" with a stable port dealt from 8070 up), and
// a fresh `templates` list is seeded from the targets whose branches are all base
// branches. `targets` stays in the blob — from now on it's the legacy view that
// toConfig re-emits from the Workspace records.
export function migrateToWorkspaces(
  config: ConfigInput | null | undefined,
  state: StateInput | null | undefined,
): { config: ConfigInput; state: StateInput; changed: boolean } {
  // the state-key rename + tabs cleanup below must reach the server even when the
  // workspace conversion already ran — track them as their own change
  const renamed = state?.active_workspace === undefined && state?.active_target !== undefined;
  const tabsBefore = JSON.stringify(config?.tabs ?? null);
  ({ config, state } = migrateConfigState(config, state));
  let cleaned = renamed || JSON.stringify(config.tabs ?? null) !== tabsBefore;
  // Creation/activity timestamps arrived after the workspace migration. Existing
  // arrays were append-ordered, so preserve that best-known chronology while
  // backfilling them: the first entry is oldest and the last one newest.
  if (
    Array.isArray(config.workspaces) &&
    config.workspaces.some((w) => !w.created_at || !w.last_activity)
  ) {
    const end = Date.now();
    const n = config.workspaces.length;
    config = {
      ...config,
      workspaces: config.workspaces.map((w, i) => {
        const created_at = w.created_at || new Date(end - (n - 1 - i)).toISOString();
        return { ...w, created_at, last_activity: w.last_activity || created_at };
      }),
    };
    cleaned = true;
  }
  // migrateConfigState (above) backfilled every target's id
  const targets = (Array.isArray(config.targets) ? config.targets : []) as MigratedTarget[];
  if ((Array.isArray(config.workspaces) && config.workspaces.length) || !targets.length) {
    return { config, state, changed: cleaned };
  }
  // 8069 = the main server; 8072 = its default gevent port — both off-limits
  const used = new Set(RESERVED_PORTS);
  const workspaces = targets.map((t) => {
    const w = workspaceFromTarget(t);
    if (w.location === "worktree") {
      let p = 8070;
      while (used.has(p)) p++;
      used.add(p);
      w.port = p;
    } else {
      w.port = null;
    }
    return w;
  });
  const end = Date.now();
  for (const [i, w] of workspaces.entries()) {
    w.created_at ||= new Date(end - (workspaces.length - 1 - i)).toISOString();
    w.last_activity ||= w.created_at;
  }
  const seen = new Set<string | undefined>();
  const templates: TemplateInput[] = targets
    .filter((t) => t.checkouts?.length && t.checkouts.every((c) => BASE_BRANCH_RE.test(c.branch)))
    .filter((t) => !seen.has(t.name) && seen.add(t.name))
    .map((t) => ({
      id: t.id,
      name: t.name,
      db: t.db ?? "",
      on_create_args: t.on_create_args ?? "",
      demo_data: t.demo_data ?? true,
      checkouts: t.checkouts,
    }));
  // the consumed legacy list is dropped from the persisted blob (toConfig never
  // re-emits it; merge() only re-injects DEFAULT's transient copy in memory)
  const { targets: _consumed, ...rest } = config;
  return { config: { ...rest, workspaces, templates }, state, changed: true };
}

// the one normalization every external {config, state} blob goes through before it
// reaches the ORM (boot, broadcast, reset, preset, import, adoption)
function normalizeConfigState(
  config: ConfigInput | null | undefined,
  state: StateInput | null | undefined,
): { config: ConfigInput; state: StateInput } {
  const { config: c, state: s } = migrateToWorkspaces(config, state);
  return { config: c, state: s };
}

// the payload GET /api/config returned at boot (or an adopted/seeded one), stashed by
// loadServerConfig() for the plugin's field initializers to read at construction.
let _boot: ConfigPayload | null = null;

// a full records-derived blob merges into a complete Config; anything else stays an input
function merge(config: ConfigBlob): Config;
function merge(config: ConfigInput | null | undefined): ConfigInput;
function merge(config: ConfigInput | null | undefined): ConfigInput {
  return { ...DEFAULT_CONFIG, ...(config || {}) };
}

// Fetch the server config before mount. If the server has none yet (first run), adopt
// this browser's existing localStorage (an upgrading user) or DEFAULT_CONFIG (fresh),
// migrate it, and seed the server. Always resolves — on any failure the UI still boots
// from the migrated/default data in memory. Called from main.ts before mount().
export async function loadServerConfig(): Promise<void> {
  // GET /api/config: {ok, rev, config, state} — config null until first seeded
  let payload: {
    ok?: boolean;
    rev: number;
    config?: ConfigInput | null;
    state?: StateInput;
  } | null = null;
  try {
    const resp = await fetch("/api/config");
    payload = await resp.json();
  } catch {
    /* server unreachable — fall through to defaults */
  }
  if (payload && payload.ok && payload.config) {
    const boot: ConfigPayload = {
      rev: payload.rev,
      config: payload.config,
      state: payload.state || {},
    };
    // one-time targets→workspaces migration of an already-adopted server config:
    // persist it now (rev-checked) so the stored blob gains workspaces/templates and
    // every later boot short-circuits. On any failure the UI still boots from the
    // migrated blob in memory.
    const migrated = migrateToWorkspaces(merge(boot.config), boot.state);
    _boot = migrated.changed
      ? await _writeBackMigration(boot.rev, migrated.config, migrated.state)
      : boot;
    return;
  }
  // no server config yet — adopt + seed
  const rev = payload && payload.ok ? payload.rev : 0;
  const adopted = adoptFromLocalStorage();
  const { config, state } = normalizeConfigState(adopted.config, adopted.state);
  try {
    const resp = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rev, config, state }),
    });
    const res: Partial<ConfigPayload> = await resp.json();
    // 200 → our seed; 409 → another tab seeded first, adopt theirs
    // a 500 (write failed) reply carries no rev — keep ours, as _writeBackMigration does
    _boot = { rev: res.rev ?? rev, config: res.config ?? config, state: res.state ?? state };
  } catch {
    _boot = { rev, config, state };
  }
}

// POST the migrated blob back, rev-checked. A 409 means another tab migrated (or
// wrote) concurrently: re-run the migration on the server's copy; if it already
// carries the migrated workspace fields this is a no-op and we adopt theirs — and retry
// once. Network failure → boot from the migrated blob in memory (same resilience as
// the rest of boot).
async function _writeBackMigration(
  rev: number,
  config: ConfigInput,
  state: StateInput,
  retry = true,
): Promise<ConfigPayload> {
  try {
    const resp = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rev, config, state }),
    });
    const res: Partial<ConfigPayload> = await resp.json();
    if (resp.status === 409 && retry) {
      const theirs = {
        rev: res.rev ?? rev,
        config: res.config ?? config,
        state: res.state ?? state,
      };
      const again = migrateToWorkspaces(merge(theirs.config), theirs.state || {});
      if (!again.changed) return theirs;
      return _writeBackMigration(theirs.rev, again.config, again.state, false);
    }
    return { rev: res.rev ?? rev, config, state };
  } catch {
    return { rev, config, state };
  }
}

// build a {config, state} pair from this browser's legacy localStorage keys, for the
// one-time first-boot adoption of an upgrading user's setup
function adoptFromLocalStorage(): { config: ConfigInput; state: StateInput } {
  let config: ConfigInput | null;
  try {
    config = JSON.parse(localStorage.getItem("oo-config") ?? "null");
  } catch {
    config = null;
  }
  config = merge(config); // full config (server needs real repos/targets)
  const state: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(STATE_KEYS)) {
    const v = localStorage.getItem(key);
    if (v !== null) state[field] = tryParse(v);
  }
  // the legacy entries hold exactly what this app once saved under those keys
  return { config, state: state as StateInput };
}

// translate a preset (a bundle of legacy localStorage entries — see presets.ts) into a
// {config, state} pair, migrated, ready to load
function presetToConfigState(preset: Preset): { config: ConfigInput; state: StateInput } {
  const data = preset.data || {};
  let overrides: ConfigInput = {};
  if (data["oo-config"]) {
    try {
      overrides = JSON.parse(data["oo-config"]);
    } catch {
      /* leave empty */
    }
  }
  const state: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(STATE_KEYS)) {
    if (data[key] !== undefined) state[field] = tryParse(data[key]);
  }
  // a preset's entries are legacy localStorage values, same as adoptFromLocalStorage's
  return normalizeConfigState(merge(overrides), state as StateInput);
}

export class ConfigPlugin extends Plugin {
  static sequence = 1; // everything else may depend on config

  _b: ConfigPayload = _boot || { rev: 0, config: {}, state: {} };
  orm = this._seedOrm(); // the config graph as owl-orm records (config_models.ts)
  rev = signal(this._b.rev); // server revision — guards concurrent writes
  // the flat config blob, derived from the ORM records — recomputed only when a
  // record changes, so the ~72 `config.config.*` consumers stay reactive + cheap
  _configView = computed(() => merge(toConfig(this.orm)));
  _dirty = { config: false, state: false }; // blobs edited since the last flush
  _timer: ReturnType<typeof setTimeout> | undefined = undefined;

  // seed a fresh ORM from the boot payload (field initializer, so config + state are
  // populated the moment the plugin is constructed — other plugins' field inits read
  // getState right after `usePlugin(ConfigPlugin)` returns)
  _seedOrm(): ORM {
    const orm = new ORM();
    const { config, state } = normalizeConfigState(merge(this._b.config), this._b.state || {});
    toModels(orm, config, state);
    return orm;
  }

  // clear + re-seed the ORM in place (reset / preset / import / another tab's write).
  // Mutating the existing ORM — not replacing it — keeps `_configView` tracking it.
  // Every incoming blob is normalized (targets→workspaces) so toModels can trust it —
  // this also self-heals a blob a pre-workspace tab flushed (its save drops the
  // workspaces/templates keys; re-deriving them here is deterministic).
  _reload(config: ConfigInput | null | undefined, state: StateInput | null | undefined): void {
    for (const M of CONFIG_MODELS) for (const rec of this.orm.records(M)) this.orm.delete(rec);
    const norm = normalizeConfigState(merge(config), state || {});
    toModels(this.orm, norm.config, norm.state);
  }

  get config(): Config {
    return this._configView(); // read in render -> tracked on the records it touches
  }

  // ── config writes ──────────────────────────────────────────────────────────
  // merge a patch into the config and persist it. Optimistic: the records update now,
  // the POST is debounced/coalesced (see _schedule). ~20 callers across the Config and
  // Targets UIs — their call sites are unchanged.
  updateConfig(patch: ConfigInput): void {
    applyPatch(this.orm, patch);
    this._dirty.config = true;
    this._schedule();
  }

  // persist a model-driven edit (a Target/Repository method mutated its own record)
  // through the same debounced, rev-checked save — the record already reflects it.
  touch(): void {
    this._dirty.config = true;
    this._schedule();
  }

  // record accessors, so consumers holding an id can call the models' own methods
  workspace(id: string): Workspace | null {
    return this.orm.getById(Workspace, id);
  }

  repoByGithub(github: string): Repository | null {
    return this.orm.records(Repository).find((r) => r.githubOrDefault() === github) || null;
  }

  // ── app-state (the AppState singleton record) ────────────────────────────────
  getState<K extends keyof AppStateBlob>(field: K, fallback: AppStateBlob[K]): AppStateBlob[K];
  getState<K extends keyof AppStateBlob>(field: K): AppStateBlob[K] | null;
  getState<K extends keyof AppStateBlob>(
    field: K,
    fallback: AppStateBlob[K] | null = null,
  ): AppStateBlob[K] | null {
    const st: StateFields | null = this.orm.getById(AppState, "state");
    const v = st && st[field] ? st[field]() : undefined;
    return v === undefined || v === null ? fallback : v;
  }

  setState<K extends keyof AppStateBlob>(field: K, value: AppStateBlob[K]): void {
    const st: StateFields | null = this.orm.getById(AppState, "state");
    if (st && st[field]) st[field].set(value);
    this._dirty.state = true;
    this._schedule();
  }

  // ── server sync ──────────────────────────────────────────────────────────────
  _schedule(): void {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._flush(), 250);
  }

  // POST whatever changed since the last flush, rev-checked. On a stale rev (another
  // tab wrote), adopt the server's rev and retry so our edit lands on top
  // (last-write-wins — fine for a single user); bounded so a pathological loop can't
  // hang. Clears the dirty flags optimistically and re-sets them on failure/conflict.
  async _flush(tries = 0): Promise<void> {
    if (!this._dirty.config && !this._dirty.state) return;
    const sent = { ...this._dirty };
    this._dirty = { config: false, state: false };
    const body: { rev: number; config?: ConfigBlob; state?: Partial<AppStateBlob> } = {
      rev: this.rev(),
    };
    if (sent.config) body.config = toConfig(this.orm);
    if (sent.state) body.state = toState(this.orm);
    try {
      const resp = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const res: { rev: number; error?: string } = await resp.json().catch(() => ({}));
      if (resp.status === 409 && tries < 3) {
        this.rev.set(res.rev);
        this._dirty.config ||= sent.config;
        this._dirty.state ||= sent.state;
        return this._flush(tries + 1);
      }
      if (!resp.ok) throw new Error(res.error || String(resp.status));
      this.rev.set(res.rev);
    } catch (e) {
      this._dirty.config ||= sent.config;
      this._dirty.state ||= sent.state;
      console.error(`[goo] config save failed: ${errorMessage(e)}`);
    }
  }

  // apply a config broadcast from another tab (SSE "config"). Ignored while we have a
  // pending local edit (our own flush reconciles via the 409 retry) or when the rev
  // isn't newer than ours (stale, or the echo of our own write).
  applyBroadcast(payload: Partial<ConfigPayload> | null | undefined): void {
    if (!payload || typeof payload.rev !== "number") return;
    if (this._dirty.config || this._dirty.state) return;
    if (payload.rev <= this.rev()) return;
    this.rev.set(payload.rev);
    this._reload(payload.config, payload.state);
  }

  // ── reset / presets (immediate, awaited so the caller can reload) ─────────────
  async _pushNow(config: ConfigInput, state: StateInput): Promise<void> {
    this._reload(config, state);
    this._dirty = { config: false, state: false };
    clearTimeout(this._timer);
    try {
      const resp = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rev: this.rev(),
          config: toConfig(this.orm),
          state: toState(this.orm),
        }),
      });
      const res: { rev?: number } = await resp.json();
      if (res.rev !== undefined) this.rev.set(res.rev);
    } catch (e) {
      console.error(`[goo] config save failed: ${errorMessage(e)}`);
    }
  }

  // reset the whole config + state back to the built-in defaults
  async resetConfig(): Promise<void> {
    await this._pushNow({ ...DEFAULT_CONFIG }, {});
  }

  // a portable snapshot for the Backup export (config + app state, no rev)
  snapshot(): ConfigSnapshot {
    return { config: toConfig(this.orm), state: toState(this.orm) };
  }

  // restore a snapshot (from a Backup import), replacing config + state on the server
  async importSnapshot(snap: { config?: ConfigInput; state?: StateInput }): Promise<void> {
    await this._pushNow(snap.config || {}, snap.state || {});
  }

  // replace the whole config + state with a preset (see presets.ts)
  async applyPreset(id: string): Promise<boolean> {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return false;
    const { config, state } = presetToConfigState(preset);
    await this._pushNow(config, state);
    return true;
  }
}
