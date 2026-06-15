// Addons of the currently running server's database: list installed/available
// modules and install/upgrade one (via the shared process). No target selector
// — the tab is scoped to whatever the server is running.

import { ConfigPlugin } from "./config_plugin.js";
import { ServerPlugin } from "./server_plugin.js";
import { LogBuffer } from "./log_buffer.js";
import { postJSON } from "./utils.js";

const { Plugin, plugin, effect, signal, computed } = owl;

export class AddonsPlugin extends Plugin {
  static sequence = 3;
  static MAX_ROWS = 200;

  config = plugin(ConfigPlugin);
  server = plugin(ServerPlugin);
  output = new LogBuffer();
  modules = signal([]);
  db = signal(""); // the managed db: the running server's db, sticky across one-shot installs
  target = signal(""); // its target id (used to resolve addons-path and to install/upgrade)
  loadedDb = signal("");
  loading = signal(false);
  error = signal("");
  filter = signal("");
  status = signal("");
  runActive = signal(false);
  sawRun = signal(false);
  // filtered + sorted modules — recomputed only when modules/filter change
  filtered = computed(() => this._filtered());

  setup() {
    // adopt the running server's db/target as the managed context
    effect(() => {
      const s = this.server.status();
      if ((s.state === "running" || s.state === "starting") && s.db && s.db !== this.db()) {
        this.db.set(s.db);
        this.target.set(s.target || "");
      }
    });
    // (re)load the module list whenever the managed db changes
    effect(() => {
      const db = this.db();
      if (db && db !== this.loadedDb() && !this.loading()) this.load();
    });
    effect(() => this._onStatus(this.server.status()));
    this.server.onLine((line) => {
      if (this.runActive()) this.output.append(line);
    });
  }

  get serverRunning() {
    const s = this.server.status().state;
    return s === "running" || s === "starting";
  }

  _targetObj() {
    return this.config.config.targets.find((t) => t.id === this.target()) || null;
  }

  _repoPaths(target) {
    const paths = Object.fromEntries(this.config.config.repos.map((r) => [r.id, r.path]));
    return (target ? target.repos : [])
      .map((id) => ({ id, path: paths[id] }))
      .filter((r) => r.path);
  }

  async load() {
    const db = this.db();
    if (!db) {
      this.modules.set([]);
      this.loadedDb.set("");
      return;
    }
    this.loading.set(true);
    this.error.set("");
    try {
      const data = await postJSON("/api/addons", { repos: this._repoPaths(this._targetObj()), db });
      this.modules.set(data.modules);
      this.loadedDb.set(db);
    } catch (e) {
      this.error.set(e.message);
    } finally {
      this.loading.set(false);
    }
  }

  _filtered() {
    const q = this.filter().trim().toLowerCase();
    const matched = this.modules().filter(
      (mod) =>
        !q ||
        mod.name.toLowerCase().includes(q) ||
        mod.summary.toLowerCase().includes(q) ||
        mod.category.toLowerCase().includes(q),
    );
    matched.sort(
      (a, b) =>
        (b.state === "installed") - (a.state === "installed") || a.name.localeCompare(b.name),
    );
    return { total: matched.length, shown: matched.slice(0, AddonsPlugin.MAX_ROWS) };
  }

  _onStatus(status) {
    const active = status.state === "starting" || status.state === "running";
    const running = active && (status.mode === "install" || status.mode === "upgrade");
    if (running) {
      this.sawRun.set(true);
      this.status.set(`${status.mode === "upgrade" ? "upgrading" : "installing"}…`);
    } else if (this.runActive() && this.sawRun() && status.state === "stopped") {
      this.runActive.set(false);
      this.sawRun.set(false);
      this.status.set(
        status.exited_unexpectedly
          ? status.returncode
            ? `failed — exit ${status.returncode}`
            : "done"
          : "stopped",
      );
      this.load(); // refresh install states (psql reads the db even while stopped)
    }
  }

  get running() {
    const s = this.server.status();
    return (
      (s.state === "starting" || s.state === "running") &&
      (s.mode === "install" || s.mode === "upgrade")
    );
  }

  async run(op, name) {
    const cfg = this.server.buildStartConfig(this.target());
    if (!cfg) return;
    if (!confirm(`${op === "upgrade" ? "Upgrade" : "Install"} "${name}" on ${cfg.start.db}?`))
      return;
    cfg.start[op] = name;
    this.output.clear();
    this.runActive.set(true);
    this.sawRun.set(false);
    this.status.set(`${op === "upgrade" ? "upgrading" : "installing"} ${name}…`);
    try {
      await postJSON("/api/addons/run", cfg);
    } catch (e) {
      this.runActive.set(false);
      this.status.set(`failed to start: ${e.message}`);
    }
  }
}
