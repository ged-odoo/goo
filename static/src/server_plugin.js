// The single odoo process: live status, SSE log fan-out, start/stop/restart.

import { ConfigPlugin, LAST_TARGET_KEY } from "./config_plugin.js";
import { EventLogPlugin } from "./event_log_plugin.js";
import { CodePlugin } from "./code_plugin.js";
import { DialogPlugin } from "./dialog_plugin.js";
import { LogBuffer } from "./log_buffer.js";
import { postJSON } from "./utils.js";

const { Plugin, plugin, signal } = owl;

export class ServerPlugin extends Plugin {
  static sequence = 2;

  config = plugin(ConfigPlugin);
  eventLog = plugin(EventLogPlugin);
  code = plugin(CodePlugin);
  dialogs = plugin(DialogPlugin);
  status = signal({ state: "stopped" }); // whole status object, replaced wholesale
  now = signal(Date.now());
  output = new LogBuffer(); // the persistent server-log element
  lineListeners = new Set(); // tests/addons mirror lines from here
  lastConfig = null; // last server start config (to resume after a one-shot run)
  // the active target (last started or activated), persisted + reactive
  activeTarget = signal(this.config.read(LAST_TARGET_KEY) || "");

  setup() {
    setInterval(() => this.now.set(Date.now()), 1000);
    this._connect();
  }

  onLine(cb) {
    this.lineListeners.add(cb);
    return () => this.lineListeners.delete(cb);
  }

  log(line) {
    this.output.append(line);
    for (const cb of this.lineListeners) cb(line);
  }

  _connect() {
    const es = new EventSource("/api/events");
    es.onopen = () => this.output.clear(); // server replays its buffer on connect
    es.onerror = () => this.status.set({ ...this.status(), state: "disconnected" });
    es.addEventListener("status", (e) => this.status.set(JSON.parse(e.data)));
    es.addEventListener("log", (e) => this.log(JSON.parse(e.data).line));
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

  lastTarget() {
    return this.activeTarget();
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
    if (!(await this._confirmBranches(targetId))) return;
    this.lastConfig = cfg;
    this.setLastTarget(cfg.target);
    this.eventLog.add(`starting server (target: ${this._targetName(cfg.target)})`);
    await this._run("/api/start", cfg, "start");
  }

  async restart(targetId, otherArgs) {
    const cfg = this.buildStartConfig(targetId, otherArgs);
    if (!cfg) return;
    if (!(await this._confirmBranches(targetId))) return;
    this.lastConfig = cfg;
    this.setLastTarget(cfg.target);
    this.eventLog.add(`restarting server (target: ${this._targetName(cfg.target)})`);
    await this._run("/api/restart", cfg, "restart");
  }

  // re-start the server with the last config used (e.g. after a one-shot install
  // that had to stop a running server)
  async resume() {
    const cfg = this.lastConfig || this.buildStartConfig(this.lastTarget());
    if (cfg) {
      this.eventLog.add(`restarting server (target: ${this._targetName(cfg.target)})`);
      await this._run("/api/start", cfg, "resume");
    }
  }

  async stop() {
    this.eventLog.add("stopping server");
    await this._run("/api/stop", undefined, "stop");
  }
}
