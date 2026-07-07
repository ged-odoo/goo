// Worktrees as first-class targets. "Create Worktree" forks a NEW branch from a
// base target into a git worktree at <worktree_dir>/<slug>/<repo>, on its own db,
// and appends a target carrying a `worktree` metadata object. Such a target runs
// its own odoo server concurrently with the main server (and other worktrees), on
// its own port. Per-target state — { exists, state, port } — is kept here and
// updated live from the backend's "worktree" SSE events (relayed by ServerPlugin),
// and each worktree's server log streams into its own LogBuffer ("worktree_log").

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
  selectedId = signal(""); // the worktree selected in the Worktree screen
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
    if (id) this._primeLogs(id);
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

  // Fork <branch> from <baseTargetId>'s branches into a fresh worktree; optionally
  // clone <cloneSource> into the worktree's own db first. On success, persist a new
  // worktree target and select it. spec: {baseTargetId, name, branch, dbName, cloneSource}
  async createWorktree({ baseTargetId, name, branch, dbName, cloneSource }) {
    const base = (this.config.config.targets || []).find((t) => t.id === baseTargetId);
    if (!base) return this._error("Create worktree", "unknown base target");
    const id = this._newId(name || branch);
    const tgt = {
      id,
      name: name || branch,
      favorite: false,
      kind: "worktree",
      checkouts: (base.checkouts || []).map((c) => ({ repo: c.repo, branch })),
      db: dbName,
      on_create_args: base.on_create_args || "",
      demo_data: base.demo_data ?? true,
      worktree: { base: baseTargetId },
    };
    // per-repo: create the NEW branch <branch> forked from the base's branch
    const g = this.code.groups();
    // dirPath derives from the name here (no dir stored yet); freeze it onto the
    // target so a later rename can't orphan the checkout git is about to create.
    const dir = this.dirPath(tgt);
    tgt.worktree.dir = dir;
    const repos = (base.checkouts || [])
      .map((c) => ({
        repo: c.repo,
        newBranch: branch,
        startPoint: c.branch,
        mainPath: g.pathByRepo[c.repo] || "",
        github: g.githubByRepo[c.repo] || "",
        worktreePath: `${dir}/${c.repo}`,
      }))
      .filter((r) => r.mainPath);
    if (!repos.length) return this._error("Create worktree", "the base target has no local repos");

    const eid = this.eventLog.begin(`creating worktree ${tgt.name}`);
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
        return this._error("Worktree creation failed", msg || "git worktree add failed");
      }
      this.config.updateConfig({ targets: [...this.config.config.targets, tgt] });
      this._merge(id, { exists: true, state: "stopped", port: null });
      this.eventLog.finish(eid, "done");
      this.select(id);
      return true;
    } catch (e) {
      this.eventLog.finish(eid, "error");
      return this._error("Worktree creation failed", e.message);
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
      this._merge(tgt.id, { state: "starting", port: res.port });
    } catch (e) {
      delete this._startEids[tgt.id];
      this.eventLog.finish(eid, "error");
      this._merge(tgt.id, { state: "stopped" });
      this._error("Could not start the worktree server", e.message);
    }
  }

  async stopServer(tgt) {
    this.eventLog.add(`stopping worktree server (${tgt.name})`);
    try {
      await postJSON("/api/workspace/stop", { target: tgt.id });
      this._merge(tgt.id, { state: "stopped" });
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
    // drop the target from config + local state
    this.config.updateConfig({
      targets: (this.config.config.targets || []).filter((t) => t.id !== tgt.id),
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
