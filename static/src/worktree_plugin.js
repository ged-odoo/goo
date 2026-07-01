// Worktrees as first-class targets. "Create Worktree" forks a NEW branch from a
// base target into a git worktree at <worktree_dir>/<slug>/<repo>, on its own db,
// and appends a target carrying a `worktree` metadata object. Such a target runs
// its own odoo server concurrently with the main server (and other worktrees), on
// its own port. Per-target state — { exists, state, port } — is kept here and
// updated live from the backend's "worktree" SSE events (relayed by ServerPlugin),
// and each worktree's server log streams into its own LogBuffer ("worktree_log").

import { ConfigPlugin } from "./config_plugin.js";
import { ServerPlugin } from "./server_plugin.js";
import { CodePlugin } from "./code_plugin.js";
import { EventLogPlugin } from "./event_log_plugin.js";
import { DialogPlugin } from "./dialog_plugin.js";
import { LogBuffer } from "./log_buffer.js";
import { postJSON } from "./utils.js";

const { Plugin, plugin, signal } = owl;

export class WorktreePlugin extends Plugin {
  static sequence = 5;

  config = plugin(ConfigPlugin);
  server = plugin(ServerPlugin);
  code = plugin(CodePlugin);
  eventLog = plugin(EventLogPlugin);
  dialogs = plugin(DialogPlugin);
  worktrees = signal({}); // targetId -> { exists, state, port }
  selectedId = signal(""); // the worktree selected in the Worktree screen
  logs = new Map(); // targetId -> LogBuffer (per-server scrollback + live stream)
  _startEids = {}; // targetId -> pending "starting worktree server" timed-event id

  setup() {
    this.server.onWorktree((d) => this.applyStatus(d));
    this.server.onWorktreeLog(({ target, line }) => this.logBuffer(target).append(line));
    this.load();
  }

  // ── which targets are worktrees ──────────────────────────────────────────────
  // a worktree target carries a `worktree` metadata object; its presence marks it.
  isWorktree(tgt) {
    return !!(tgt && tgt.worktree);
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
      for (const c of t.config || []) if (c.branch) s.add(c.branch);
    return s;
  }

  isWorktreeBranch(name) {
    return !!name && this.worktreeBranches().has(name);
  }

  // ── paths ────────────────────────────────────────────────────────────────────
  // filesystem-safe folder name from the target name (fall back to the id)
  slug(tgt) {
    const s = (tgt.name || tgt.id).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return s || tgt.id;
  }

  dirPath(tgt) {
    const base = (this.config.config.worktree_dir || "/tmp").replace(/\/+$/, "");
    return `${base}/${this.slug(tgt)}`;
  }

  hasCommunity(tgt) {
    return (tgt.config || []).some((c) => c.repo === "community");
  }

  // per-repo worktree descriptors for an existing worktree target (start / remove)
  wtRepos(tgt) {
    const g = this.code.groups();
    const dir = this.dirPath(tgt);
    return (tgt.config || [])
      .map(({ repo, branch }) => ({
        repo,
        branch,
        mainPath: g.pathByRepo[repo] || "",
        github: g.githubByRepo[repo] || "",
        worktreePath: `${dir}/${repo}`,
      }))
      .filter((r) => r.mainPath);
  }

  // ── live state ─────────────────────────────────────────────────────────────
  state(tgt) {
    return this.worktrees()[tgt.id] || { exists: false, state: "stopped", port: null };
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
    const all = this.worktrees();
    const cur = all[id] || { exists: false, state: "stopped", port: null };
    this.worktrees.set({ ...all, [id]: { ...cur, ...patch } });
  }

  // live SSE update for one target; also resolves its pending start timed-event
  applyStatus(d) {
    if (!d || !d.target) return;
    this._merge(d.target, { state: d.state, port: d.port });
    const eid = this._startEids[d.target];
    if (eid && (d.state === "running" || d.state === "stopped")) {
      this.eventLog.finish(eid, d.state === "running" ? "done" : "error");
      delete this._startEids[d.target];
    }
  }

  // hydrate existence + current server state for every worktree target
  async load() {
    const targets = this.worktreeTargets().map((t) => ({ id: t.id, dirPath: this.dirPath(t) }));
    if (!targets.length) return;
    try {
      const res = await postJSON("/api/worktree/list", { targets });
      this.worktrees.set({ ...this.worktrees(), ...(res.worktrees || {}) });
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
      const res = await postJSON("/api/worktree/logs", { target: id });
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
      config: (base.config || []).map((c) => ({ repo: c.repo, branch })),
      db: dbName,
      on_create_args: base.on_create_args || "",
      worktree: { base: baseTargetId },
    };
    // per-repo: create the NEW branch <branch> forked from the base's branch
    const g = this.code.groups();
    const dir = this.dirPath(tgt);
    const repos = (base.config || [])
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
      const res = await postJSON("/api/worktree/create", { target: id, repos });
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
  // a worktree start config: the target's repos pointed at the worktree copies, the
  // worktree's own odoo-bin, on the target's own db (the backend assigns the port)
  buildWorktreeStartConfig(tgt) {
    const cfg = this.config.config;
    const dir = this.dirPath(tgt);
    const wt = this.wtRepos(tgt);
    if (!wt.length || !this.hasCommunity(tgt)) return null;
    return {
      ...cfg,
      target: tgt.id,
      repos: wt.map((r) => ({ id: r.repo, path: r.worktreePath, github: r.github })),
      server_path: `${dir}/community/odoo-bin`,
      start: {
        repos: wt.map((r) => r.repo),
        db: tgt.db,
        on_create_args: tgt.on_create_args || "",
        other_args: cfg.start.other_args,
      },
    };
  }

  async startServer(tgt) {
    if (this.running(tgt)) return;
    const cfg = this.buildWorktreeStartConfig(tgt);
    if (!cfg)
      return this._error("Cannot start worktree server", "this target has no community repo");
    const eid = this.eventLog.begin(`starting worktree server (${tgt.name})`);
    this._startEids[tgt.id] = eid;
    this._merge(tgt.id, { state: "starting" });
    try {
      const res = await postJSON("/api/worktree/start", { target: tgt.id, config: cfg });
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
      await postJSON("/api/worktree/stop", { target: tgt.id });
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
      await postJSON("/api/worktree/remove", { target: tgt.id, dirPath: this.dirPath(tgt), repos });
      if (res.dropDb && tgt.db)
        await postJSON("/api/databases/drop", {
          name: tgt.db,
          filestore: this.config.config.filestore,
        });
    } catch (e) {
      this._error("Worktree removal failed", e.message);
    }
    // drop the target from config + local state
    this.config.updateConfig({
      targets: (this.config.config.targets || []).filter((t) => t.id !== tgt.id),
    });
    const all = { ...this.worktrees() };
    delete all[tgt.id];
    this.worktrees.set(all);
    this.logs.delete(tgt.id);
    if (this.selectedId() === tgt.id) this.selectedId.set("");
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
