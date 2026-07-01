// The single odoo process: live status, SSE log fan-out, start/stop/restart.

import { ConfigPlugin, LAST_TARGET_KEY } from "./config_plugin.js";
import { EventLogPlugin } from "./event_log_plugin.js";
import { CodePlugin } from "./code_plugin.js";
import { DialogPlugin } from "./dialog_plugin.js";
import { LogBuffer } from "./log_buffer.js";
import { postJSON } from "./utils.js";

const { Plugin, plugin, signal, useEffect } = owl;

export class ServerPlugin extends Plugin {
  static sequence = 2;

  config = plugin(ConfigPlugin);
  eventLog = plugin(EventLogPlugin);
  code = plugin(CodePlugin);
  dialogs = plugin(DialogPlugin);
  status = signal({ state: "stopped" }); // whole status object, replaced wholesale
  // optimistic in-flight action, for immediate button feedback in the gap between
  // a click and the first real status event: "start" | "stop" | "restart" | ""
  pending = signal("");
  now = signal(Date.now());
  output = new LogBuffer(); // the persistent server-log element
  lineListeners = new Set(); // tests/addons mirror lines from here
  gooUpdateListeners = new Set(); // UpdatePlugin refreshes the navbar badge from here
  worktreeListeners = new Set(); // WorktreePlugin updates per-worktree state from here
  worktreeLogListeners = new Set(); // WorktreePlugin streams per-worktree logs from here
  claudeListeners = new Set(); // ClaudePlugin appends per-worktree chat items from here
  lastConfig = null; // last server start config (to resume after a one-shot run)
  _startEid = null; // pending "starting server" timed event, resolved on the green dot
  // the active target (last started or activated), persisted + reactive
  activeTarget = signal(this.config.read(LAST_TARGET_KEY) || "");

  setup() {
    setInterval(() => this.now.set(Date.now()), 1000);
    this._connect();
    // mirror the current target's launch config to the backend so `goo --test-tags`
    // can run a one-shot test without the server having been started
    useEffect(() => {
      const targets = this.config.config.targets;
      const tid = targets.find((t) => t.id === this.activeTarget())?.id || targets[0]?.id;
      const cfg = tid && this.buildStartConfig(tid);
      if (cfg) postJSON("/api/cli/config", cfg).catch(() => {});
    });
  }

  onLine(cb) {
    this.lineListeners.add(cb);
    return () => this.lineListeners.delete(cb);
  }

  onGooUpdate(cb) {
    this.gooUpdateListeners.add(cb);
    return () => this.gooUpdateListeners.delete(cb);
  }

  onWorktree(cb) {
    this.worktreeListeners.add(cb);
    return () => this.worktreeListeners.delete(cb);
  }

  onWorktreeLog(cb) {
    this.worktreeLogListeners.add(cb);
    return () => this.worktreeLogListeners.delete(cb);
  }

  onClaude(cb) {
    this.claudeListeners.add(cb);
    return () => this.claudeListeners.delete(cb);
  }

  log(line) {
    this.output.append(line);
    for (const cb of this.lineListeners) cb(line);
  }

  _connect() {
    const es = new EventSource("/api/events");
    es.onopen = () => this.output.clear(); // server replays its buffer on connect
    es.onerror = () => this.status.set({ ...this.status(), state: "disconnected" });
    es.addEventListener("status", (e) => {
      const prev = this.status();
      const s = JSON.parse(e.data);
      this.status.set(s);
      this.pending.set(""); // the real state is in — drop the optimistic override
      this._resolveStartEvent(prev, s);
    });
    es.addEventListener("log", (e) => this.log(JSON.parse(e.data).line));
    // backend-originated business events (e.g. a `goo --test-tags` CLI run) → event log.
    // A timed event carries an `id` + `status`: "start" opens a row with an animated
    // "...", "done"/"error" resolves that same row to "ok"/"failed".
    es.addEventListener("event", (e) => {
      const d = JSON.parse(e.data);
      if (d.status === "start") this.eventLog.start(d.id, d.text, d.level || "");
      else if (d.status === "done" || d.status === "error")
        this.eventLog.finish(d.id, d.status, d.text, d.level || "");
      else this.eventLog.add(d.text, "", d.level || "");
    });
    // the hourly goo-update check pushes its recomputed status here so the navbar
    // badge updates live (UpdatePlugin listens via onGooUpdate)
    es.addEventListener("goo_update", (e) => {
      const d = JSON.parse(e.data);
      for (const cb of this.gooUpdateListeners) cb(d);
    });
    // per-worktree server status (starting/running/stopped) → WorktreePlugin
    es.addEventListener("worktree", (e) => {
      const d = JSON.parse(e.data);
      for (const cb of this.worktreeListeners) cb(d);
    });
    // per-worktree server log lines → WorktreePlugin's per-target LogBuffer
    es.addEventListener("worktree_log", (e) => {
      const d = JSON.parse(e.data);
      for (const cb of this.worktreeLogListeners) cb(d);
    });
    // per-worktree Claude chat items (assistant text / tool activity / result) → ClaudePlugin
    es.addEventListener("claude", (e) => {
      const d = JSON.parse(e.data);
      for (const cb of this.claudeListeners) cb(d);
    });
  }

  buildStartConfig(targetId, otherArgs) {
    const cfg = this.config.config;
    const target = cfg.targets.find((t) => t.id === targetId);
    if (!target) return null;
    return {
      ...cfg,
      // `target` carries the id (the backend just echoes it back in status);
      // the frontend maps it to the name for display
      target: target.id,
      start: {
        // addons path is built from the target's repos; the branches in the
        // config are stored for later (not checked out yet)
        repos: (target.config || []).map((c) => c.repo),
        db: target.db,
        on_create_args: target.on_create_args || "",
        other_args: otherArgs ?? cfg.start.other_args,
      },
    };
  }

  // fetch the live status once, synchronously, before the first render — the SSE
  // delivers it too, but only after connecting, which leaves a "stopped" flash
  // (Start → Stop) on a reload of an already-running server. Await this in the
  // app's onWillStart. Best-effort: on failure the SSE still fills it in shortly.
  async loadStatus() {
    try {
      const res = await fetch("/api/status");
      if (res.ok) this.status.set(await res.json());
    } catch {
      // ignore — the SSE status event will arrive once connected
    }
  }

  lastTarget() {
    return this.activeTarget();
  }

  // the state the UI should reflect: an optimistic "start" click reads as
  // "starting" before the backend confirms, so the navbar dot and the favicon
  // flip the instant the button is pressed (and stay in lockstep with each other)
  displayState() {
    return this.pending() === "start" ? "starting" : this.status().state;
  }

  _targetName(id) {
    return this.config.config.targets.find((t) => t.id === id)?.name || id;
  }

  setLastTarget(id) {
    this.activeTarget.set(id);
    this.config.write(LAST_TARGET_KEY, id);
  }

  // the command that would launch this target (built by the backend); "" if invalid
  async previewCommand(targetId, otherArgs) {
    const cfg = this.buildStartConfig(targetId, otherArgs);
    if (!cfg) return "";
    try {
      return (await postJSON("/api/command", cfg)).cmd;
    } catch (e) {
      return `# ${e.message}`;
    }
  }

  async _run(path, body, label) {
    try {
      await postJSON(path, body);
    } catch (e) {
      // the start never got off the ground → fail its pending timed event now
      // (the status resolver won't, since the server never reaches "starting")
      this._failStart();
      // surface the failure everywhere — server log (record), event log (badge +
      // history) and a modal — so it can't go unnoticed from another screen
      this.log(`[goo] ${label} failed: ${e.message}`);
      this.eventLog.add(`${label} failed: ${e.message}`, "", "error");
      this.dialogs.open({
        title: `Could not ${label} the server`,
        message: e.message,
        cls: "dialog-error",
        okLabel: "OK",
        cancelLabel: null,
      });
    }
  }

  // The "starting server" line is a timed event: it shows an animated "..." right
  // away (logged before the branch-confirm load, so there's no delay) and resolves
  // to "ok" once the server reports "running" (the green dot) — or "failed" if it
  // never gets there. A new start supersedes any still-pending one.
  _beginStart(text) {
    if (this._startEid) this.eventLog.drop(this._startEid);
    this._startEid = this.eventLog.begin(text);
  }

  _cancelStart() {
    if (this._startEid) this.eventLog.drop(this._startEid);
    this._startEid = null;
    this.pending.set("");
  }

  _failStart() {
    if (this._startEid) this.eventLog.finish(this._startEid, "error");
    this._startEid = null;
    this.pending.set("");
  }

  // drive the pending start event off the live status: "ok" when it enters
  // "running", "failed" if the process exits before getting there
  _resolveStartEvent(prev, s) {
    if (!this._startEid) return;
    if (s.state === "running" && prev.state !== "running") {
      this.eventLog.finish(this._startEid, "done");
      this._startEid = null;
    } else if (s.state === "stopped" && s.exited_unexpectedly) {
      this._failStart();
    }
  }

  // the server launches whatever branches are currently checked out (the target's
  // branches aren't sent to the backend). If they don't match the target, ask the
  // user to confirm — starting with different branches is a valid use case.
  // Returns true to proceed, false if the user cancelled.
  async _confirmBranches(targetId) {
    const target = this.config.config.targets.find((t) => t.id === targetId);
    if (!target) return true;
    await this.code.load(); // cache-aware; populates branchRepos
    const current = Object.fromEntries(this.code.branchRepos().map((r) => [r.id, r.current]));
    // only flag repos whose current branch we actually know
    const off = (target.config || []).filter(
      ({ repo, branch }) => current[repo] !== undefined && current[repo] !== branch,
    );
    if (!off.length) return true;
    const lines = off
      .map(({ repo, branch }) => `${repo}: on "${current[repo]}" — target wants "${branch}"`)
      .join("\n");
    const ok = await this.dialogs.open({
      title: "Branches don't match this target",
      message:
        `The checked-out branches differ from "${this._targetName(targetId)}":\n\n` +
        `${lines}\n\nStart with the current branches anyway?`,
      okLabel: "Start anyway",
      cancelLabel: "Cancel",
    });
    return !!ok;
  }

  async start(targetId, otherArgs) {
    const cfg = this.buildStartConfig(targetId, otherArgs);
    if (!cfg) return this.log(`[goo] no such target: "${targetId}"`);
    this.pending.set("start"); // immediate feedback, before the confirm/POST awaits
    this._beginStart(`starting server (target: ${this._targetName(cfg.target)})`);
    if (!(await this._confirmBranches(targetId))) return this._cancelStart();
    this.lastConfig = cfg;
    this.setLastTarget(cfg.target);
    await this._run("/api/start", cfg, "start");
  }

  async restart(targetId, otherArgs) {
    const cfg = this.buildStartConfig(targetId, otherArgs);
    if (!cfg) return;
    this.pending.set("restart"); // immediate feedback, before the confirm/POST awaits
    this._beginStart(`restarting server (target: ${this._targetName(cfg.target)})`);
    if (!(await this._confirmBranches(targetId))) return this._cancelStart();
    this.lastConfig = cfg;
    this.setLastTarget(cfg.target);
    await this._run("/api/restart", cfg, "restart");
  }

  // re-start the server with the last config used (e.g. after a one-shot install
  // that had to stop a running server)
  async resume() {
    const cfg = this.lastConfig || this.buildStartConfig(this.lastTarget());
    if (cfg) {
      this._beginStart(`restarting server (target: ${this._targetName(cfg.target)})`);
      await this._run("/api/start", cfg, "resume");
    }
  }

  async stop() {
    this.pending.set("stop"); // immediate feedback, before the POST round-trip
    this.eventLog.add("stopping server");
    await this._run("/api/stop", undefined, "stop");
  }

  // resolve true once the server reports "running", false on timeout
  waitUntilRunning(timeout = 90000) {
    return new Promise((resolve) => {
      if (this.status().state === "running") return resolve(true);
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (this.status().state === "running") {
          clearInterval(iv);
          resolve(true);
        } else if (Date.now() - t0 > timeout) {
          clearInterval(iv);
          resolve(false);
        }
      }, 300);
    });
  }
}
