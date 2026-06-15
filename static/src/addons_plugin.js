// Browse a database's modules and install/upgrade one (via the shared process).
// A database selector drives the view — defaulting to the running server's db,
// but any database can be selected. Available modules / addons-path come from
// all configured repos, so a module can be installed on any database.

import { ConfigPlugin } from "./config_plugin.js";
import { ServerPlugin } from "./server_plugin.js";
import { DatabasePlugin } from "./database_plugin.js";
import { LogBuffer } from "./log_buffer.js";
import { postJSON } from "./utils.js";

const { Plugin, plugin, effect, signal, computed } = owl;

export class AddonsPlugin extends Plugin {
  static sequence = 4;
  static MAX_ROWS = 200;

  config = plugin(ConfigPlugin);
  server = plugin(ServerPlugin);
  database = plugin(DatabasePlugin);
  output = new LogBuffer();
  modules = signal([]);
  selectedDb = signal("");
  loadedDb = signal("");
  loading = signal(false);
  error = signal("");
  filter = signal("");
  installedOnly = signal(false);
  status = signal("");
  runActive = signal(false);
  sawRun = signal(false);
  _adoptedDb = ""; // last running-server db we auto-selected
  // filtered + sorted modules — recomputed only when modules/filter change
  filtered = computed(() => this._filtered());

  setup() {
    // default selection follows the running server's db (adopted once per change)
    effect(() => {
      const s = this.server.status();
      const sdb = s.state === "running" || s.state === "starting" ? s.db || "" : "";
      if (sdb && sdb !== this._adoptedDb) {
        this._adoptedDb = sdb;
        this.selectedDb.set(sdb);
      }
    });
    // with no server, default to the active/first known database
    effect(() => {
      if (this.selectedDb()) return;
      const dbs = this.database.databases();
      if (dbs.length) this.selectedDb.set(this.database.activeDb || dbs[0].name);
    });
    effect(() => this._onStatus(this.server.status()));
    this.server.onLine((line) => {
      if (this.runActive()) this.output.append(line);
    });
  }

  // all configured repos (the addons-path used for listing + install)
  _allRepos() {
    return this.config.config.repos.map((r) => ({ id: r.id, path: r.path })).filter((r) => r.path);
  }

  async load() {
    const db = this.selectedDb();
    if (!db) {
      this.modules.set([]);
      this.loadedDb.set("");
      return;
    }
    this.loading.set(true);
    this.error.set("");
    try {
      const data = await postJSON("/api/addons", { repos: this._allRepos(), db });
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
    const installedOnly = this.installedOnly();
    const matched = this.modules().filter(
      (mod) =>
        (!installedOnly || mod.state === "installed") &&
        (!q ||
          mod.name.toLowerCase().includes(q) ||
          mod.summary.toLowerCase().includes(q) ||
          mod.category.toLowerCase().includes(q)),
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
    const db = this.selectedDb();
    if (!db) return;
    if (!confirm(`${op === "upgrade" ? "Upgrade" : "Install"} "${name}" on ${db}?`)) return;
    const cfg = {
      ...this.config.config,
      target: null,
      start: { repos: this._allRepos().map((r) => r.id), db, [op]: name },
    };
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
