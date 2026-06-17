// The single odoo process: live status, SSE log fan-out, start/stop/restart.

import { ConfigPlugin, LAST_TARGET_KEY } from "./config_plugin.js";
import { LogBuffer } from "./log_buffer.js";
import { postJSON } from "./utils.js";

const { Plugin, plugin, signal } = owl;

export class ServerPlugin extends Plugin {
  static sequence = 2;

  config = plugin(ConfigPlugin);
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
      this.log(`[goo] ${label} failed: ${e.message}`);
    }
  }

  async start(targetId, otherArgs) {
    const cfg = this.buildStartConfig(targetId, otherArgs);
    if (!cfg) return this.log(`[goo] no such target: "${targetId}"`);
    this.lastConfig = cfg;
    this.setLastTarget(cfg.target);
    await this._run("/api/start", cfg, "start");
  }

  async restart(targetId, otherArgs) {
    const cfg = this.buildStartConfig(targetId, otherArgs);
    if (!cfg) return;
    this.lastConfig = cfg;
    this.setLastTarget(cfg.target);
    await this._run("/api/restart", cfg, "restart");
  }

  // re-start the server with the last config used (e.g. after a one-shot install
  // that had to stop a running server)
  async resume() {
    const cfg = this.lastConfig || this.buildStartConfig(this.lastTarget());
    if (cfg) await this._run("/api/start", cfg, "resume");
  }

  async stop() {
    await this._run("/api/stop", undefined, "stop");
  }
}
