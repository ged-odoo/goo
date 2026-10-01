// The worktree-workspace action layer. createWorktree materializes a
// worktree-located workspace — its branches forked into a git worktree at
// <worktree_dir>/<slug>/<repo>, on its own db — persisted through the canonical
// `workspaces` config key. Such a workspace runs its own odoo server concurrently
// with the main server (and other worktrees), on its own stable port. Per-workspace
// state — { exists, state, port } — lives in the shared servers map, updated live
// from the backend's "server" SSE events (relayed by ServerPlugin), and each
// worktree server log streams into its own LogBuffer (the unified "log" SSE).
// `worktree` is { base, dir, venv }: `venv` (optional) marks a dedicated
// <dir>/.venv built from this worktree's own requirements.txt — build_start_config
// (backend/services/config.py) activates it instead of the global venv_activate.

import { ConfigPlugin } from "./config_plugin.ts";
import { StorePlugin } from "./store_plugin.ts";
import { ServerPlugin } from "./server_plugin.ts";
import { CodePlugin } from "./code_plugin.ts";
import { EventLogPlugin } from "./event_log_plugin.ts";
import { DialogPlugin } from "./dialog_plugin.ts";
import { LogBuffer } from "./log_buffer.ts";
import { postJSON, worktreeDirFor, descendantWorkspaces } from "./utils.ts";

import { Plugin, usePlugin, signal, markRaw } from "@odoo/owl";
import type { CheckoutConfig, WorkspaceConfig } from "./config.ts";
import type { ServerSnapshot, ServerStatus } from "./runtime_models.ts";

// Every `catch (e)` below catches what postJSON rejects with — an Error — so
// `(e as Error).message` is its message.

// a workspace as these methods take it: a config workspace, or the create flow's
// transient (not-yet-persisted) spec — only `id` is always there
export type WorkspaceLike = Pick<WorkspaceConfig, "id"> & Partial<WorkspaceConfig>;

// a launch_mode "external" workspace's last container check (externalStatus())
export interface ExternalStatus {
  checking: boolean;
  running?: boolean;
  url?: string;
  error?: string;
}

// one repo of an existing worktree workspace, resolved against config (wtRepos())
export interface WorktreeRepo {
  repo: string;
  branch: string;
  mainPath: string; // the configured main checkout the worktree hangs off
  github: string;
  worktreePath: string; // the worktree's own checkout of this repo
}

// createWorktree's spec (see the comment above it)
export interface CreateWorktreeSpec {
  name: string;
  dbName: string;
  cloneSource?: string; // a db to clone into dbName first ("" = none)
  checkouts: CheckoutConfig[];
  startPointByRepo?: Record<string, string>; // repo id -> the start point to fork from
  baseId?: string;
  on_create_args?: string;
  demo_data?: boolean;
  favorite?: boolean;
  category?: string;
  parent?: string;
  createVenv?: boolean;
  forkRepos?: Set<string>; // repo ids to fork fresh (the rest attach an existing branch)
  select?: boolean;
}

// the sibling plugins cascadeRemoveDescendants drives
export interface CascadePlugins {
  config: Pick<ConfigPlugin, "config" | "workspace" | "updateConfig">;
  wt: Pick<WorkspacePlugin, "running" | "removeSilently">;
  eventLog: Pick<EventLogPlugin, "add">;
  server: Pick<ServerPlugin, "loadedWorkspaceId">;
}

// the last selected workspace, remembered per browser so the Workspaces screen
// reopens (and a page refresh lands) on what you were last working on. A browser
// view preference like the list ordering — not server config.
const SELECTED_KEY = "goo-workspace-selected";

function savedSelection(): string {
  try {
    return localStorage.getItem(SELECTED_KEY) || "";
  } catch {
    return ""; // browser storage can be disabled; selection just won't persist
  }
}

export class WorkspacePlugin extends Plugin {
  static sequence = 5;

  config = usePlugin(ConfigPlugin);
  store = usePlugin(StorePlugin); // worktree servers live in the shared servers map
  server = usePlugin(ServerPlugin);
  code = usePlugin(CodePlugin);
  eventLog = usePlugin(EventLogPlugin);
  dialogs = usePlugin(DialogPlugin);
  // the workspace selected in the Workspaces screen, seeded from the previous
  // session (the screen validates it still exists before honouring it)
  selectedId = signal(savedSelection());
  requestedSelection = signal(""); // one-shot explicit target for the next screen open
  // one-shot: a detail pane the Workspaces screen should open on its next render
  // (set by the event log's [jump] — survives the screen not being mounted yet)
  requestedPane = signal("");
  // targetId -> LogBuffer (per-server scrollback + live stream). Raw: logBuffer()
  // lazily inserts on first access and is called straight from a template
  // (workspaces.ts's Server-log LogConsole), so a reactive Map would notify the
  // very key it just read on that first insert — a write-during-render that
  // sends the component into a render loop (see tests_plugin.ts's _slots for the
  // fuller explanation; LogBuffer's own signals stay reactive regardless).
  logs = markRaw(new Map<string, LogBuffer>());
  _startEids: Record<string, string> = {}; // targetId -> pending "starting worktree server" timed-event id
  _externalStatus = new Map<string, ExternalStatus>(); // targetId -> { checking, running, url, error }
  _externalStatusTick = signal(0); // bumped after a fetch so externalStatus() re-renders

  setup(): void {
    this.server.onWorktree((d) => this.applyStatus(d));
    // every non-main server's log lines land in its own buffer (main's live in
    // ServerPlugin.output)
    this.server.onLog(({ server, line }) => {
      if (server !== "main") this.logBuffer(server).append(line);
    });
    this.load();
  }

  // ── which targets are worktrees ──────────────────────────────────────────────
  // canonical records carry `location`; the metadata-object fallback covers a
  // transient (not-yet-persisted) spec passed by the create flow.
  isWorktree(tgt: WorkspaceLike | null | undefined): boolean {
    if (!tgt) return false;
    const rec = this.config.workspace(tgt.id);
    if (rec) return rec.isWorktree(); // logic lives on the Workspace model
    return (tgt.location || (tgt.worktree ? "worktree" : "main")) === "worktree"; // transient
  }

  worktreeWorkspaces(): WorkspaceConfig[] {
    return (this.config.config.workspaces || []).filter((w) => this.isWorktree(w));
  }

  selected(): WorkspaceConfig | null {
    return this.worktreeWorkspaces().find((t) => t.id === this.selectedId()) || null;
  }

  select(id: string): void {
    this.selectedId.set(id);
    try {
      if (id) localStorage.setItem(SELECTED_KEY, id);
      else localStorage.removeItem(SELECTED_KEY);
    } catch {
      /* storage disabled — the in-memory selection still works */
    }
    const ws = id ? (this.config.config.workspaces || []).find((w) => w.id === id) : null;
    if (ws && this.isWorktree(ws)) {
      // only worktree workspaces have a per-server tail to prime (a main-located
      // workspace's log is the shared main-server buffer)
      this._primeLogs(id);
      // people who launch servers by hand (launch_mode "external") get a passive
      // external-status check instead of goo's own live tracking -- refresh it
      // on selection so the /odoo, /web/tests buttons aren't stuck disabled
      // until a manual "Check status" click
      if (this.config.config.launch_mode === "external") this.refreshExternalStatus(ws);
    }
  }

  selectOnOpen(id: string): void {
    this.requestedSelection.set(id);
    this.select(id);
  }

  // branch names owned by a worktree (for the Branches/PRs "wt" badge)
  worktreeBranches(): Set<string> {
    const s = new Set<string>();
    for (const t of this.worktreeWorkspaces())
      for (const c of t.checkouts || []) if (c.branch) s.add(c.branch);
    return s;
  }

  isWorktreeBranch(name: string | null | undefined): boolean {
    return !!name && this.worktreeBranches().has(name);
  }

  // ── paths ────────────────────────────────────────────────────────────────────
  // the worktree's checkout directory: the value frozen at creation
  // (worktree.dir), else derived from the name. Persisting it means a later rename
  // can't move the path off the real on-disk checkout (worktreeDirFor in utils.ts).
  dirPath(tgt: WorkspaceLike): string {
    const rec = this.config.workspace(tgt.id);
    if (rec) return rec.dirPath(); // logic lives on the Target model
    return tgt.worktree?.dir || worktreeDirFor(this.config.config.worktree_dir, tgt); // transient
  }

  hasMainRepo(tgt: WorkspaceLike): boolean {
    const rec = this.config.workspace(tgt.id);
    if (rec) return rec.hasMainRepo();
    const mainRepoId = this.config.config.main_repo_id || "community";
    return (tgt.checkouts || []).some((c) => c.repo === mainRepoId); // transient
  }

  // ── external (non-goo-launched) server detection ─────────────────────────────
  // for people who launch Odoo by hand outside of goo (launch_mode "external"):
  // a read-only check of whether a container matching this workspace's db/branch
  // name is already running, and at what URL. goo never starts/stops it itself.
  externalStatus(tgt: WorkspaceLike): ExternalStatus | null {
    this._externalStatusTick(); // subscribe this render to future refreshes
    return this._externalStatus.get(tgt.id) || null;
  }

  async refreshExternalStatus(tgt: WorkspaceLike): Promise<void> {
    if (!tgt.db) return;
    this._externalStatus.set(tgt.id, { checking: true });
    this._externalStatusTick.set(this._externalStatusTick() + 1);
    let next: ExternalStatus;
    try {
      const res = await postJSON<{ running: boolean; url: string }>(
        "/api/workspace/external_status",
        { name: tgt.db },
      );
      next = { checking: false, running: res.running, url: res.url };
    } catch (e) {
      next = { checking: false, error: (e as Error).message };
    }
    this._externalStatus.set(tgt.id, next);
    this._externalStatusTick.set(this._externalStatusTick() + 1);
  }

  // one-shot external-container check for a bare db name, independent of any
  // workspace target — used to warn before a destructive db op (drop/rename)
  // when launch_mode is "external": goo's own "active db" tracking
  // (server.status().db) is permanently empty in that mode (it only ever
  // reflects goo's own subprocess/container), so it can't tell a db an external
  // container is actively serving from an unused one. Returns null (never
  // blocks the caller) on a failed check.
  async checkDbInUse(
    dbName: string | null | undefined,
  ): Promise<{ running: boolean; url: string } | null> {
    if (!dbName) return null;
    try {
      const res = await postJSON<{ running?: boolean; url?: string }>(
        "/api/workspace/external_status",
        { name: dbName },
      );
      return { running: !!res.running, url: res.url || "" };
    } catch {
      return null;
    }
  }

  // per-repo worktree descriptors for an existing worktree target (start / remove)
  wtRepos(tgt: WorkspaceLike): WorktreeRepo[] {
    const g = this.code.groups();
    const dir = this.dirPath(tgt);
    return (tgt.checkouts || [])
      .map(({ repo, branch }) => ({
        repo,
        branch,
        mainPath: g.pathByRepo[repo] || "",
        github: g.githubByRepo[repo] || "",
        worktreePath: `${dir}/${repo}`,
      }))
      .filter((r) => r.mainPath);
  }

  // ── live state (from the shared servers map, keyed by target id) ─────────────
  state(tgt: WorkspaceLike): ServerStatus {
    return this.store.server(tgt.id) || { exists: false, state: "stopped", port: null };
  }

  exists(tgt: WorkspaceLike): boolean {
    return !!this.state(tgt).exists;
  }

  serverState(tgt: WorkspaceLike): string {
    return this.state(tgt).state || "stopped";
  }

  running(tgt: WorkspaceLike): boolean {
    const s = this.serverState(tgt);
    return s === "running" || s === "starting";
  }

  port(tgt: WorkspaceLike): number | null {
    return this.state(tgt).port || null;
  }

  _merge(id: string, patch: Partial<ServerSnapshot>): void {
    // mergeServer spread-merges into the held snapshot, so a patch carries only the
    // fields it changes (a missing record's absent state reads as "stopped", see
    // serverState)
    this.store.mergeServer({ id, ...patch });
  }

  // resolve a worktree's pending start timed-event on a state transition. The store
  // merge already happened in ServerPlugin's "server" SSE handler (which relays each
  // worktree snapshot here); this just drives the event-log row.
  applyStatus(d: ServerSnapshot | null | undefined): void {
    if (!d || !d.id) return;
    const eid = this._startEids[d.id];
    if (eid && (d.state === "running" || d.state === "stopped")) {
      this.eventLog.finish(eid, d.state === "running" ? "done" : "error");
      delete this._startEids[d.id];
    }
  }

  // hydrate existence + current server state for every worktree workspace
  async load(): Promise<void> {
    const workspaces = this.worktreeWorkspaces().map((t) => ({
      id: t.id,
      dirPath: this.dirPath(t),
    }));
    if (!workspaces.length) return;
    try {
      const res = await postJSON<{ servers?: Record<string, ServerSnapshot> }>(
        "/api/workspace/list",
        { workspaces },
      );
      for (const snap of Object.values(res.servers || {})) this.store.mergeServer(snap);
    } catch {
      /* leave current state */
    }
  }

  // ── logs ─────────────────────────────────────────────────────────────────────
  logBuffer(id: string): LogBuffer {
    if (!this.logs.has(id)) this.logs.set(id, new LogBuffer());
    return this.logs.get(id)!; // inserted just above when missing
  }

  // fill scrollback from the server's tail once, only if we don't already hold the
  // live stream (e.g. after a page reload while the server was already running)
  async _primeLogs(id: string): Promise<void> {
    const buf = this.logBuffer(id);
    if (buf.count()) return;
    try {
      const res = await postJSON<{ lines?: string[] }>("/api/workspace/logs", { workspace: id });
      buf.clear();
      for (const line of res.lines || []) buf.append(line);
    } catch {
      /* ignore */
    }
  }

  // ── create ─────────────────────────────────────────────────────────────────
  _newId(seed: string | null | undefined): string {
    const base =
      "wt-" +
      (seed || "wt")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase();
    const taken = new Set((this.config.config.workspaces || []).map((w) => w.id));
    let id = base;
    let n = 2;
    while (taken.has(id)) id = `${base}-${n++}`;
    return id;
  }

  // Materialize a worktree-located workspace: per repo, create checkout.branch
  // (forked from startPointByRepo[repo]) as a git worktree under a frozen dir;
  // optionally clone <cloneSource> into the workspace's own db first. On success,
  // persist the workspace (canonical `workspaces` write — the create path deals it
  // the next stable port) and select it.
  // spec: { name, dbName, cloneSource, checkouts: [{repo, branch}], startPointByRepo,
  //         baseId?, on_create_args?, demo_data?, favorite?, parent?, createVenv?,
  //         forkRepos? }
  async createWorktree({
    name,
    dbName,
    cloneSource,
    checkouts,
    startPointByRepo = {},
    baseId = "",
    on_create_args = "",
    demo_data = true,
    favorite = false,
    category = "",
    parent = "",
    createVenv = false,
    forkRepos = new Set(),
    select = true,
  }: CreateWorktreeSpec): Promise<string | false> {
    if (!checkouts || !checkouts.length)
      return this._error("Create workspace", "the workspace has no checkouts");
    const id = this._newId(name);
    const now = new Date().toISOString();
    const ws: Omit<WorkspaceConfig, "notes" | "port" | "worktree"> & {
      worktree: { base: string; dir?: string; venv?: boolean };
    } = {
      id,
      name,
      created_at: now,
      last_activity: now,
      favorite,
      category,
      parent,
      db: dbName,
      on_create_args,
      demo_data,
      location: "worktree",
      checkouts,
      worktree: { base: baseId },
    };
    const g = this.code.groups();
    // dirPath derives from the name here (no dir stored yet); freeze it onto the
    // workspace so a later rename can't orphan the checkout git is about to create.
    const dir = this.dirPath(ws);
    ws.worktree.dir = dir;
    // no equivalent freezing for a Docker container name (launch_mode
    // "docker"): that's a "dev"/"dev1"/"dev2" pooled slot picked live at
    // each Start (see dockerUrl below), not a per-workspace value
    // a checkout NOT in forkRepos already has a real local branch (the caller
    // determined this from actual git state, or from an earlier fetch) — attach
    // it as-is; `-b <branch>` would fail with "already exists" since the branch
    // is real, not a fresh name to fork from a start point. Everything in
    // forkRepos forks fresh from startPointByRepo instead.
    const repos = checkouts
      .map(({ repo, branch }) =>
        forkRepos.has(repo)
          ? {
              repo,
              newBranch: branch,
              startPoint: startPointByRepo[repo],
              mainPath: g.pathByRepo[repo] || "",
              pull_remote: g.pullRemoteByRepo[repo],
              worktreePath: `${dir}/${repo}`,
            }
          : {
              repo,
              branch,
              mainPath: g.pathByRepo[repo] || "",
              pull_remote: g.pullRemoteByRepo[repo],
              worktreePath: `${dir}/${repo}`,
            },
      )
      .filter((r) => r.mainPath);
    if (!repos.length) return this._error("Create workspace", "no local repos for the checkouts");

    const eid = this.eventLog.begin(`creating worktree workspace ${ws.name}`);
    try {
      if (cloneSource) {
        await postJSON("/api/databases/clone", {
          source: cloneSource,
          dest: dbName,
          filestore: this.config.config.filestore,
        });
      }
      const res = await postJSON<{
        ok: boolean;
        results?: { ok: boolean; repo: string; error?: string }[];
      }>("/api/workspace/create", { workspace: id, repos });
      if (!res.ok) {
        this.eventLog.finish(eid, "error");
        const msg = (res.results || [])
          .filter((r) => !r.ok)
          .map((r) => `${r.repo}: ${r.error}`)
          .join("\n");
        return this._error("Workspace creation failed", msg || "git worktree add failed");
      }
      // best-effort: a failed venv build doesn't undo the worktrees that already
      // exist, so it just leaves worktree.venv unset (falls back to the global
      // venv_activate at launch, same as any workspace without a dedicated venv)
      if (createVenv) {
        const veid = this.eventLog.begin(`creating venv (${ws.name})`);
        try {
          await postJSON("/api/workspace/venv/create", {
            venvPath: `${dir}/.venv`,
            requirementsPath: `${dir}/community/requirements.txt`,
          });
          ws.worktree.venv = true;
          this.eventLog.finish(veid, "done");
        } catch (e) {
          this.eventLog.finish(veid, "error");
          this._error("Venv creation failed", (e as Error).message);
        }
      }
      // canonical write: spread the existing workspaces so their ports survive;
      // this workspace carries none — the reconcile deals it the next stable port
      this.config.updateConfig({ workspaces: [...this.config.config.workspaces, ws] });
      this._merge(id, { exists: true, state: "stopped", port: null });
      this.eventLog.finish(eid, "done");
      if (select) this.select(id);
      return id;
    } catch (e) {
      this.eventLog.finish(eid, "error");
      return this._error("Workspace creation failed", (e as Error).message);
    }
  }

  // ── server lifecycle ─────────────────────────────────────────────────────────
  // The backend builds the worktree launch config from the target id (repos pointed
  // at the worktree copies + the worktree's odoo-bin, from the persisted worktree.dir).
  async startServer(tgt: WorkspaceLike): Promise<false | void> {
    if (this.running(tgt)) return;
    if (!this.hasMainRepo(tgt))
      return this._error("Cannot start the server", "this workspace has no main repo checkout");
    const eid = this.eventLog.begin(`starting server (${tgt.name})`);
    this.config.workspace(tgt.id)?.touchActivity();
    this._startEids[tgt.id] = eid;
    this._merge(tgt.id, { state: "starting" });
    try {
      const res = await postJSON<{ port: number | null }>("/api/workspace/start", {
        workspace: tgt.id,
      });
      // merge only the port: a fast server's SSE "running" snapshot can beat this
      // reply, and re-merging "starting" here would clobber it
      this._merge(tgt.id, { port: res.port });
    } catch (e) {
      delete this._startEids[tgt.id];
      this.eventLog.finish(eid, "error");
      this._merge(tgt.id, { state: "stopped" });
      this._error("Could not start the server", (e as Error).message);
    }
  }

  async stopServer(tgt: WorkspaceLike): Promise<void> {
    this.config.workspace(tgt.id)?.touchActivity();
    this.eventLog.add(`stopping server (${tgt.name})`);
    // optimistic feedback only BEFORE the POST: the backend stop is synchronous and
    // may itself restart the server (a stop mid-run finalizes the run and resumes
    // the server it interrupted), so a merge after the reply would clobber the
    // fresher starting/running SSE snapshots that arrived during the request
    this._merge(tgt.id, { state: "stopping" });
    try {
      await postJSON("/api/workspace/stop", { workspace: tgt.id });
    } catch {
      /* the SSE status will reconcile */
    }
  }

  // stop is synchronous on the backend, so a plain stop-then-start restarts cleanly
  async restartServer(tgt: WorkspaceLike): Promise<void> {
    await this.stopServer(tgt);
    await this.startServer(tgt);
  }

  // the actual cleanup (backend worktree removal + optional db drop + config/local
  // bookkeeping) — shared by the interactive `remove` (after its own confirm dialog)
  // and the silent cascade (no confirm, no dropDb prompt — a db drop wasn't
  // explicitly asked for a cascaded child, matching the interactive default of
  // leaving it alone unless the checkbox was ticked). Returns false (kept) on
  // failure, true on success.
  async _removeCleanup(tgt: WorkspaceLike, { dropDb = false } = {}): Promise<boolean> {
    const repos = this.wtRepos(tgt).map(({ repo, mainPath, worktreePath }) => ({
      repo,
      mainPath,
      worktreePath,
    }));
    this.eventLog.add(`removing workspace ${tgt.name} (worktree)`);
    try {
      await postJSON("/api/workspace/remove", {
        workspace: tgt.id,
        dirPath: this.dirPath(tgt),
        repos,
      });
    } catch (e) {
      // the worktree is still on disk / registered with git — keep the target so
      // there's a UI handle to retry, rather than orphaning it.
      this._error("Worktree removal failed", (e as Error).message);
      return false;
    }
    if (dropDb && tgt.db) {
      try {
        await postJSON("/api/databases/drop", {
          name: tgt.db,
          filestore: this.config.config.filestore,
        });
      } catch (e) {
        // the worktree itself is gone, so still drop the target below; just report
        // the leftover database.
        this._error("Database drop failed", (e as Error).message);
      }
    }
    // drop the workspace from config (canonical write) + local state
    this.config.updateConfig({
      workspaces: (this.config.config.workspaces || []).filter((w) => w.id !== tgt.id),
    });
    this.store.dropServer(tgt.id);
    this.store.dropWorktreeRepoStatusFor(tgt.id);
    this.logs.delete(tgt.id);
    // through select() so the remembered selection is cleared too, not just the signal
    if (this.selectedId() === tgt.id) this.select("");
    return true;
  }

  async remove(tgt: WorkspaceLike): Promise<false | void> {
    if (this.running(tgt))
      return this._error(
        "Stop the server first",
        "Stop the workspace's server before removing it.",
      );
    const descendants = descendantWorkspaces(this.config.config.workspaces || [], tgt.id);
    const res = await this.dialogs.open({
      title: `Remove workspace "${tgt.name}"?`,
      message:
        `This deletes ${this.dirPath(tgt)} and its git worktrees. Uncommitted changes there are lost.` +
        (descendants.length
          ? ` This also removes ${descendants.length} sub-workspace${descendants.length === 1 ? "" : "s"} spawned from it.`
          : ""),
      fields: [
        { key: "dropDb", type: "checkbox", label: `Also drop database "${tgt.db}"`, value: false },
      ],
      okLabel: "Remove",
    });
    if (!res) return;
    // cascade the sub-workspaces while the parent still exists: once it's gone, the
    // config's dangling-parent heal demotes its children to root
    const { skipped } = await cascadeRemoveDescendants(
      { config: this.config, wt: this, eventLog: this.eventLog, server: this.server },
      tgt,
    );
    if (skipped.length) this._notifyKept(skipped);
    await this._removeCleanup(tgt, { dropDb: !!res.dropDb });
  }

  // silent per-child removal the cascade drives — no confirm, no dropDb prompt
  async removeSilently(tgt: WorkspaceLike): Promise<boolean> {
    if (this.running(tgt)) return false;
    return this._removeCleanup(tgt, { dropDb: false });
  }

  _notifyKept(skipped: WorkspaceConfig[]): void {
    this.dialogs.open({
      title: "Some sub-workspaces were kept",
      message: skipped
        .map(
          (w) =>
            `"${w.name}" is still busy (its server is running, or it's the loaded workspace) — kept, no longer linked to the deleted parent.`,
        )
        .join("\n"),
      okLabel: "OK",
      cancelLabel: null,
    });
  }

  // open the worktree's repo folders in the configured editor (all in one window);
  // works whether or not the server is running — it's just the checkout on disk
  openEditor(tgt: WorkspaceLike): void {
    this.config.workspace(tgt.id)?.touchActivity();
    const paths = this.wtRepos(tgt).map((r) => r.worktreePath);
    if (paths.length) this.code.openEditorPaths(paths, `worktree ${tgt.name}`);
  }

  // ── autologin URLs against the worktree server ("" when not running) ──
  // three-way by launch_mode: goo-managed port (local, from its own live
  // tracking) when available, goo-managed container (docker, routed through
  // nginx by container name — see dockerUrl below), else the externally-
  // launched server's URL (see externalStatus/refreshExternalStatus, for
  // launch_mode "external")
  _baseUrl(tgt: WorkspaceLike): string {
    if (this.config.config.launch_mode === "docker") {
      return this.running(tgt) ? this.dockerUrl(tgt) : "";
    }
    const port = this.port(tgt);
    if (port) return `http://localhost:${port}/`;
    const ext = this.externalStatus(tgt);
    return ext?.running && ext.url ? ext.url : "";
  }

  // the nginx-routed URL for a docker-launched worktree: <container>.localhost,
  // where <container> is the live "dev"/"dev1"/"dev2" slot this run picked
  // (backend's next_container_slot — a pooled slot, not a fixed per-workspace
  // name, so it's read from live server state, never persisted/recomputed)
  dockerUrl(tgt: WorkspaceLike): string {
    const slug = this.state(tgt).docker_container;
    if (!slug) return "";
    const port = this.config.config.docker_nginx_port;
    return `http://${slug}.localhost${port && port !== "80" ? ":" + port : ""}/`;
  }

  // wraps a target path through goo's autologin route, unless autologin_links
  // is off (then it's just the plain path — for people who'd rather log in
  // themselves, e.g. the autologin addon isn't installed on this server)
  _link(tgt: WorkspaceLike, path: string): string {
    const base = this._baseUrl(tgt);
    if (!base) return "";
    if (this.config.config.autologin_links === false) return `${base}${path.replace(/^\//, "")}`;
    return `${base}dev/autologin?to=${encodeURIComponent(path)}`;
  }

  odooUrl(tgt: WorkspaceLike): string {
    return this._link(tgt, "/odoo?debug=assets");
  }

  testsUrl(tgt: WorkspaceLike): string {
    return this._link(tgt, "/web/tests?debug=assets&timeout=500000&manual=true");
  }

  // thin wrapper: `return this._error(…)` deliberately returns false (callers
  // use it to bail out of a flow with a failure result)
  _error(title: string, message: string): false {
    this.dialogs.error(title, message);
    return false;
  }
}

// Silently remove every descendant of `parentWs`, level-by-level (breadth-first),
// each cleaned up through its own location's mechanism: worktree children via the same
// on-disk + server cleanup `remove()` itself uses (minus the confirm dialog and the
// "drop db" offer); main-located children are just dropped from config (no branch
// delete / PR close / db drop — those are deleteWorkspaceDialog's explicit, interactive
// niceties, not implied by a parent's removal). A descendant that can't be cleanly
// removed right now (its worktree server is running, or it's the loaded main-located
// workspace — the exact same predicates removeBlocked uses) stops the cascade at that
// node: it's demoted to root but its OWN subtree is left completely untouched, since
// nobody asked to touch that branch of the tree. plugins: { config, wt, eventLog, server }.
export async function cascadeRemoveDescendants(
  plugins: CascadePlugins,
  parentWs: WorkspaceLike,
): Promise<{ skipped: WorkspaceConfig[] }> {
  const { config, wt, eventLog, server } = plugins;
  const skipped: WorkspaceConfig[] = [];
  let frontier = directChildren(config.config.workspaces || [], parentWs.id);
  while (frontier.length) {
    const next: WorkspaceConfig[] = [];
    for (const child of frontier) {
      const live = (config.config.workspaces || []).find((w) => w.id === child.id);
      if (!live) continue;
      const isWt = live.location === "worktree";
      const busy = isWt ? wt.running(live) : isLoadedMainWorkspace(server, live);
      if (busy) {
        skipped.push(live);
        config.workspace(live.id)?.setParent("");
        continue; // its children stay with it — not cascaded further
      }
      eventLog.add(`removing workspace ${live.name} (cascaded with "${parentWs.name}")`);
      next.push(...directChildren(config.config.workspaces || [], live.id));
      if (isWt) await wt.removeSilently(live);
      else
        config.updateConfig({
          workspaces: (config.config.workspaces || []).filter((w) => w.id !== live.id),
        });
    }
    frontier = next;
  }
  return { skipped };
}

function directChildren(list: WorkspaceConfig[], id: string): WorkspaceConfig[] {
  return list.filter((w) => w.parent === id);
}

function isLoadedMainWorkspace(server: CascadePlugins["server"], ws: WorkspaceConfig): boolean {
  if (ws.location === "worktree") return false;
  return ws.id === server.loadedWorkspaceId();
}
