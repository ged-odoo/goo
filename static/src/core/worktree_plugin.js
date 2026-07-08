// The worktree-workspace action layer. createWorktree materializes a
// worktree-located workspace — its branches forked into a git worktree at
// <worktree_dir>/<slug>/<repo>, on its own db — persisted through the canonical
// `workspaces` config key. Such a workspace runs its own odoo server concurrently
// with the main server (and other worktrees), on its own stable port. Per-workspace
// state — { exists, state, port } — lives in the shared servers map, updated live
// from the backend's "server" SSE events (relayed by ServerPlugin), and each
// worktree's server log streams into its own LogBuffer ("worktree_log").

import { ConfigPlugin } from "./config_plugin.js";
import { StorePlugin } from "./store_plugin.js";
import { ServerPlugin } from "./server_plugin.js";
import { CodePlugin } from "./code_plugin.js";
import { EventLogPlugin } from "./event_log_plugin.js";
import { DialogPlugin } from "./dialog_plugin.js";
import { LogBuffer } from "./log_buffer.js";
import { postJSON, worktreeDirFor } from "./utils.js";

import { Plugin, plugin, signal } from "@odoo/owl";

export class WorktreePlugin extends Plugin {
  static sequence = 5;

  config = plugin(ConfigPlugin);
  store = plugin(StorePlugin); // worktree servers live in the shared servers map
  server = plugin(ServerPlugin);
  code = plugin(CodePlugin);
  eventLog = plugin(EventLogPlugin);
  dialogs = plugin(DialogPlugin);
  selectedId = signal(""); // the workspace selected in the Workspaces screen
  // one-shot: a detail pane the Workspaces screen should open on its next render
  // (set by the event log's [jump] — survives the screen not being mounted yet)
  requestedPane = signal("");
  logs = new Map(); // targetId -> LogBuffer (per-server scrollback + live stream)
  _startEids = {}; // targetId -> pending "starting worktree server" timed-event id

  setup() {
    this.server.onWorktree((d) => this.applyStatus(d));
    this.server.onWorktreeLog(({ target, line }) => this.logBuffer(target).append(line));
    this.load();
  }

  // ── which targets are worktrees ──────────────────────────────────────────────
  // the explicit `kind` marks a worktree; fall back to the presence of the
  // `worktree` metadata object for any target not yet carrying a kind.
  isWorktree(tgt) {
    if (!tgt) return false;
    const rec = this.config.target(tgt.id);
    if (rec) return rec.isWorktree(); // logic lives on the Target model
    return (tgt.kind || (tgt.worktree ? "worktree" : "plain")) === "worktree"; // transient
  }

  worktreeTargets() {
    return (this.config.config.targets || []).filter((t) => this.isWorktree(t));
  }

  selected() {
    return this.worktreeTargets().find((t) => t.id === this.selectedId()) || null;
  }

  select(id) {
    this.selectedId.set(id);
    // only worktree workspaces have a per-server tail to prime (a main-located
    // workspace's log is the shared main-server buffer)
    if (id && this.isWorktree(this.config.config.targets.find((t) => t.id === id)))
      this._primeLogs(id);
  }

  // branch names owned by a worktree (for the Branches/PRs "wt" badge)
  worktreeBranches() {
    const s = new Set();
    for (const t of this.worktreeTargets())
      for (const c of t.checkouts || []) if (c.branch) s.add(c.branch);
    return s;
  }

  isWorktreeBranch(name) {
    return !!name && this.worktreeBranches().has(name);
  }

  // ── paths ────────────────────────────────────────────────────────────────────
  // the worktree's checkout directory: the value frozen at creation
  // (worktree.dir), else derived from the name. Persisting it means a later rename
  // can't move the path off the real on-disk checkout (worktreeDirFor in utils.js).
  dirPath(tgt) {
    const rec = this.config.target(tgt.id);
    if (rec) return rec.dirPath(); // logic lives on the Target model
    return tgt.worktree?.dir || worktreeDirFor(this.config.config.worktree_dir, tgt); // transient
  }

  hasCommunity(tgt) {
    const rec = this.config.target(tgt.id);
    if (rec) return rec.hasCommunity();
    return (tgt.checkouts || []).some((c) => c.repo === "community"); // transient
  }

  // per-repo worktree descriptors for an existing worktree target (start / remove)
  wtRepos(tgt) {
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
  state(tgt) {
    return this.store.server(tgt.id) || { exists: false, state: "stopped", port: null };
  }

  exists(tgt) {
    return !!this.state(tgt).exists;
  }

  serverState(tgt) {
    return this.state(tgt).state || "stopped";
  }

  running(tgt) {
    const s = this.serverState(tgt);
    return s === "running" || s === "starting";
  }

  port(tgt) {
    return this.state(tgt).port || null;
  }

  _merge(id, patch) {
    this.store.mergeServer({ id, ...patch });
  }

  // resolve a worktree's pending start timed-event on a state transition. The store
  // merge already happened in ServerPlugin's "server" SSE handler (which relays each
  // worktree snapshot here); this just drives the event-log row.
  applyStatus(d) {
    if (!d || !d.id) return;
    const eid = this._startEids[d.id];
    if (eid && (d.state === "running" || d.state === "stopped")) {
      this.eventLog.finish(eid, d.state === "running" ? "done" : "error");
      delete this._startEids[d.id];
    }
  }

  // hydrate existence + current server state for every worktree target
  async load() {
    const targets = this.worktreeTargets().map((t) => ({ id: t.id, dirPath: this.dirPath(t) }));
    if (!targets.length) return;
    try {
      const res = await postJSON("/api/workspace/list", { targets });
      for (const snap of Object.values(res.worktrees || {})) this.store.mergeServer(snap);
    } catch {
      /* leave current state */
    }
  }

  // ── logs ─────────────────────────────────────────────────────────────────────
  logBuffer(id) {
    if (!this.logs.has(id)) this.logs.set(id, new LogBuffer());
    return this.logs.get(id);
  }

  // fill scrollback from the server's tail once, only if we don't already hold the
  // live stream (e.g. after a page reload while the server was already running)
  async _primeLogs(id) {
    const buf = this.logBuffer(id);
    if (buf.count()) return;
    try {
      const res = await postJSON("/api/workspace/logs", { target: id });
      buf.clear();
      for (const line of res.lines || []) buf.append(line);
    } catch {
      /* ignore */
    }
  }

  // ── create ─────────────────────────────────────────────────────────────────
  _newId(seed) {
    const base =
      "wt-" +
      (seed || "wt")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase();
    const taken = new Set((this.config.config.targets || []).map((t) => t.id));
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
  //         baseId?, on_create_args?, demo_data?, favorite? }
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
  }) {
    if (!checkouts || !checkouts.length)
      return this._error("Create workspace", "the workspace has no checkouts");
    const id = this._newId(name);
    const ws = {
      id,
      name,
      favorite,
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
    const repos = checkouts
      .map(({ repo, branch }) => ({
        repo,
        newBranch: branch,
        startPoint: startPointByRepo[repo],
        mainPath: g.pathByRepo[repo] || "",
        github: g.githubByRepo[repo] || "",
        worktreePath: `${dir}/${repo}`,
      }))
      .filter((r) => r.mainPath);
    if (!repos.length) return this._error("Create workspace", "no local repos for the checkouts");

    const eid = this.eventLog.begin(`creating worktree workspace ${ws.name}`);
    try {
      if (cloneSource) {
        await postJSON("/api/databases/clone", {
          source: cloneSource,
          target: dbName,
          filestore: this.config.config.filestore,
        });
      }
      const res = await postJSON("/api/workspace/create", { target: id, repos });
      if (!res.ok) {
        this.eventLog.finish(eid, "error");
        const msg = (res.results || [])
          .filter((r) => !r.ok)
          .map((r) => `${r.repo}: ${r.error}`)
          .join("\n");
        return this._error("Workspace creation failed", msg || "git worktree add failed");
      }
      // canonical write: spread the existing workspaces so their ports survive;
      // this workspace carries none — the reconcile deals it the next stable port
      this.config.updateConfig({ workspaces: [...this.config.config.workspaces, ws] });
      this._merge(id, { exists: true, state: "stopped", port: null });
      this.eventLog.finish(eid, "done");
      this.select(id);
      return true;
    } catch (e) {
      this.eventLog.finish(eid, "error");
      return this._error("Workspace creation failed", e.message);
    }
  }

  // ── server lifecycle ─────────────────────────────────────────────────────────
  // The backend builds the worktree launch config from the target id (repos pointed
  // at the worktree copies + the worktree's odoo-bin, from the persisted worktree.dir).
  async startServer(tgt) {
    if (this.running(tgt)) return;
    if (!this.hasCommunity(tgt))
      return this._error("Cannot start worktree server", "this target has no community repo");
    const eid = this.eventLog.begin(`starting worktree server (${tgt.name})`);
    this._startEids[tgt.id] = eid;
    this._merge(tgt.id, { state: "starting" });
    try {
      const res = await postJSON("/api/workspace/start", { target: tgt.id });
      // merge only the port: a fast server's SSE "running" snapshot can beat this
      // reply, and re-merging "starting" here would clobber it
      this._merge(tgt.id, { port: res.port });
    } catch (e) {
      delete this._startEids[tgt.id];
      this.eventLog.finish(eid, "error");
      this._merge(tgt.id, { state: "stopped" });
      this._error("Could not start the worktree server", e.message);
    }
  }

  async stopServer(tgt) {
    this.eventLog.add(`stopping worktree server (${tgt.name})`);
    // optimistic feedback only BEFORE the POST: the backend stop is synchronous and
    // may itself restart the server (a stop mid-run finalizes the run and resumes
    // the server it interrupted), so a merge after the reply would clobber the
    // fresher starting/running SSE snapshots that arrived during the request
    this._merge(tgt.id, { state: "stopping" });
    try {
      await postJSON("/api/workspace/stop", { target: tgt.id });
    } catch {
      /* the SSE status will reconcile */
    }
  }

  // stop is synchronous on the backend, so a plain stop-then-start restarts cleanly
  async restartServer(tgt) {
    await this.stopServer(tgt);
    await this.startServer(tgt);
  }

  async remove(tgt) {
    if (this.running(tgt))
      return this._error("Stop the server first", "Stop the worktree server before removing it.");
    const res = await this.dialogs.open({
      title: `Remove worktree "${tgt.name}"?`,
      message: `This deletes ${this.dirPath(tgt)} and its git worktrees. Uncommitted changes there are lost.`,
      fields: [
        { key: "dropDb", type: "checkbox", label: `Also drop database "${tgt.db}"`, value: false },
      ],
      okLabel: "Remove",
    });
    if (!res) return;
    const repos = this.wtRepos(tgt).map(({ repo, mainPath, worktreePath }) => ({
      repo,
      mainPath,
      worktreePath,
    }));
    this.eventLog.add(`removing worktree ${tgt.name}`);
    try {
      await postJSON("/api/workspace/remove", {
        target: tgt.id,
        dirPath: this.dirPath(tgt),
        repos,
      });
    } catch (e) {
      // the worktree is still on disk / registered with git — keep the target so
      // there's a UI handle to retry, rather than orphaning it.
      return this._error("Worktree removal failed", e.message);
    }
    if (res.dropDb && tgt.db) {
      try {
        await postJSON("/api/databases/drop", {
          name: tgt.db,
          filestore: this.config.config.filestore,
        });
      } catch (e) {
        // the worktree itself is gone, so still drop the target below; just report
        // the leftover database.
        this._error("Database drop failed", e.message);
      }
    }
    // drop the workspace from config (canonical write) + local state
    this.config.updateConfig({
      workspaces: (this.config.config.workspaces || []).filter((w) => w.id !== tgt.id),
    });
    this.store.dropServer(tgt.id);
    this.logs.delete(tgt.id);
    if (this.selectedId() === tgt.id) this.selectedId.set("");
  }

  // open the worktree's repo folders in the configured editor (all in one window);
  // works whether or not the server is running — it's just the checkout on disk
  openEditor(tgt) {
    const paths = this.wtRepos(tgt).map((r) => r.worktreePath);
    if (paths.length) this.code.openEditorPaths(paths, `worktree ${tgt.name}`);
  }

  // ── autologin URLs against the worktree server's port ("" when not running) ──
  odooUrl(tgt) {
    const port = this.port(tgt);
    return port
      ? `http://localhost:${port}/dev/autologin?to=${encodeURIComponent("/odoo?debug=assets")}`
      : "";
  }

  testsUrl(tgt) {
    const port = this.port(tgt);
    return port
      ? `http://localhost:${port}/dev/autologin?to=${encodeURIComponent(
          "/web/tests?debug=assets&timeout=500000&manual=true",
        )}`
      : "";
  }

  _error(title, message) {
    this.dialogs.open({ title, message, cls: "dialog-error", okLabel: "OK", cancelLabel: null });
    return false;
  }
}
