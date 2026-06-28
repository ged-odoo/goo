// Browse the active target's modules and install/upgrade one (via the shared
// process). The view follows the active target — the running server's target, or
// the last one used — using its database and its set of repositories.

import { ConfigPlugin } from "./config_plugin.js";
import { ServerPlugin } from "./server_plugin.js";
import { EventLogPlugin } from "./event_log_plugin.js";
import { DialogPlugin } from "./dialog_plugin.js";
import { LogBuffer } from "./log_buffer.js";
import { postJSON } from "./utils.js";

const { Plugin, plugin, useEffect, signal, computed } = owl;

export class AddonsPlugin extends Plugin {
  static sequence = 4;
  static MAX_ROWS = 200;

  config = plugin(ConfigPlugin);
  server = plugin(ServerPlugin);
  eventLog = plugin(EventLogPlugin);
  dialogs = plugin(DialogPlugin);
  output = new LogBuffer();
  modules = signal([]);
  loadedDb = signal("");
  loading = signal(false);
  error = signal("");
  filter = signal("");
  stateFilter = signal(""); // "" | "installed" | "uninstalled"
  appOnly = signal(true); // only modules flagged as an application (on by default)
  status = signal("");
  runActive = signal(false);
  sawRun = signal(false);
  _resumeAfter = false; // a real server was running and got stopped to install
  // filtered + sorted modules — recomputed only when modules/filter change
  filtered = computed(() => this._filtered());

  setup() {
    useEffect(() => this._onStatus(this.server.status()));
    this.server.onLine((line) => {
      if (this.runActive()) this.output.append(line);
    });
  }

  // the active target: the running server's target, else the last one used
  // (both reference a target id)
  _activeTarget() {
    const id = this.server.status().target || this.server.lastTarget();
    return this.config.config.targets.find((t) => t.id === id) || null;
  }

  targetName() {
    return this._activeTarget()?.name || "";
  }

  targetDb() {
    return this._activeTarget()?.db || "";
  }

  // the active target's repos as {id, path} — the addons-path used to list +
  // install, so only modules from the target's repos are ever shown
  _repos() {
    const target = this._activeTarget();
    if (!target) return [];
    const pathById = Object.fromEntries(this.config.config.repos.map((r) => [r.id, r.path]));
    return (target.config || [])
      .map((c) => ({ id: c.repo, path: pathById[c.repo] }))
      .filter((r) => r.path);
  }

  async load() {
    const db = this.targetDb();
    if (!db) {
      this.modules.set([]);
      this.loadedDb.set("");
      return;
    }
    this.loading.set(true);
    this.error.set("");
    try {
      const data = await postJSON("/api/addons", { repos: this._repos(), db });
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
    const sf = this.stateFilter();
    const appOnly = this.appOnly();
    const matched = this.modules().filter((mod) => {
      const installed = mod.state === "installed";
      if (sf === "installed" && !installed) return false;
      if (sf === "uninstalled" && installed) return false;
      if (appOnly && !mod.application) return false;
      return (
        !q ||
        mod.name.toLowerCase().includes(q) ||
        mod.summary.toLowerCase().includes(q) ||
        mod.category.toLowerCase().includes(q)
      );
    });
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
      if (this._resumeAfter) {
        this._resumeAfter = false;
        this.server.resume(); // bring back the server that was stopped to install
      }
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
    const db = this.targetDb();
    if (!db) return;
    const verb = op === "upgrade" ? "Upgrade" : "Install";
    const ok = await this.dialogs.open({
      title: `${verb} "${name}" on ${db}?`,
      okLabel: verb,
    });
    if (!ok) return;
    // if a real server is up, it will be stopped for the one-shot run — resume it after
    const s = this.server.status();
    this._resumeAfter = (s.state === "running" || s.state === "starting") && s.mode === "server";
    const cfg = {
      ...this.config.config,
      target: null,
      start: { repos: this._repos().map((r) => r.id), db, [op]: name },
    };
    this.output.clear();
    this.runActive.set(true);
    this.sawRun.set(false);
    this.status.set(`${op === "upgrade" ? "upgrading" : "installing"} ${name}…`);
    this.eventLog.add(`${op === "upgrade" ? "upgrading" : "installing"} ${name} in ${db}`);
    try {
      await postJSON("/api/addons/run", cfg);
    } catch (e) {
      this.runActive.set(false);
      this.status.set(`failed to start: ${e.message}`);
    }
  }
}
