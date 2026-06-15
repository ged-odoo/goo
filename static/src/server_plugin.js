// The single odoo process: live status, SSE log fan-out, start/stop/restart.

import { ConfigPlugin, LAST_TARGET_KEY } from "./config_plugin.js";
import { postJSON } from "./utils.js";

const { Plugin, plugin, signal } = owl;

export class ServerPlugin extends Plugin {
  static sequence = 2;

  config = plugin(ConfigPlugin);
  status = signal({ state: "stopped" });   // whole status object, replaced wholesale
  now = signal(Date.now());
  buffer = [];                              // recent log lines (replayed to late subscribers)
  logListeners = new Set();

  setup() {
    setInterval(() => this.now.set(Date.now()), 1000);
    this._connect();
  }

  // log fan-out: console components subscribe; cb({type:'reset'} | {type:'line',line})
  onLog(cb) {
    for (const line of this.buffer) cb({ type: "line", line });
    this.logListeners.add(cb);
    return () => this.logListeners.delete(cb);
  }
  _emit(ev) { for (const cb of this.logListeners) cb(ev); }
  log(line) {
    this.buffer.push(line);
    if (this.buffer.length > 2000) this.buffer.shift();
    this._emit({ type: "line", line });
  }

  _connect() {
    const es = new EventSource("/api/events");
    es.onopen = () => { this.buffer = []; this._emit({ type: "reset" }); };
    es.onerror = () => this.status.set({ ...this.status(), state: "disconnected" });
    es.addEventListener("status", (e) => this.status.set(JSON.parse(e.data)));
    es.addEventListener("log", (e) => this.log(JSON.parse(e.data).line));
  }

  buildStartConfig(targetId) {
    const cfg = this.config.config;
    const target = cfg.targets.find((t) => t.id === targetId);
    if (!target) return null;
    return {
      ...cfg, target: target.id,
      start: {
        repos: target.repos, db: target.db,
        on_create_args: target.on_create_args || "", other_args: cfg.start.other_args,
      },
    };
  }
  lastTarget() { return this.config.read(LAST_TARGET_KEY) || ""; }

  async _run(path, body, label) {
    try { await postJSON(path, body); }
    catch (e) { this.log(`[oo] ${label} failed: ${e.message}`); }
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
  async stop() { await this._run("/api/stop", undefined, "stop"); }
}
