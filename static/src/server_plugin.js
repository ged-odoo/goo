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

  buildStartConfig(targetId) {
    const cfg = this.config.config;
    const target = cfg.targets.find((t) => t.id === targetId);
    if (!target) return null;
    return {
      ...cfg,
      target: target.id,
      start: {
        repos: target.repos,
        db: target.db,
        on_create_args: target.on_create_args || "",
        other_args: cfg.start.other_args,
      },
    };
  }

  lastTarget() {
    return this.config.read(LAST_TARGET_KEY) || "";
  }

  async _run(path, body, label) {
    try {
      await postJSON(path, body);
    } catch (e) {
      this.log(`[oo] ${label} failed: ${e.message}`);
    }
  }

  async start(targetId) {
    const cfg = this.buildStartConfig(targetId);
    if (!cfg) return this.log(`[oo] no such target: "${targetId}"`);
    this.config.write(LAST_TARGET_KEY, cfg.target);
    await this._run("/api/start", cfg, "start");
  }

  async restart(targetId) {
    const cfg = this.buildStartConfig(targetId);
    if (!cfg) return;
    this.config.write(LAST_TARGET_KEY, cfg.target);
    await this._run("/api/restart", cfg, "restart");
  }

  async stop() {
    await this._run("/api/stop", undefined, "stop");
  }
}
