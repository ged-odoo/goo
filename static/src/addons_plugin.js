// Browse the active target's modules and install/upgrade one (via the shared
// process). The view follows the active target — the running server's target, or
// the last one used — using its database and its set of repositories.

import { ConfigPlugin } from "./config_plugin.js";
import { StorePlugin } from "./store_plugin.js";
import { ServerPlugin } from "./server_plugin.js";
import { EventLogPlugin } from "./event_log_plugin.js";
import { DialogPlugin } from "./dialog_plugin.js";
import { LogBuffer } from "./log_buffer.js";
import { postJSON } from "./utils.js";

import { Plugin, plugin, useEffect, signal, computed } from "@odoo/owl";

export class AddonsPlugin extends Plugin {
  static sequence = 4;
  static MAX_ROWS = 200;

  config = plugin(ConfigPlugin);
  store = plugin(StorePlugin); // install/upgrade runs live in the shared store's runs map
  server = plugin(ServerPlugin);
  eventLog = plugin(EventLogPlugin);
  dialogs = plugin(DialogPlugin);
  output = new LogBuffer();
  modules = signal([]);
  loadedDb = signal("");
  erroredDb = signal(""); // db whose last auto-load failed — don't auto-retry it (avoids a hot loop)
  loading = signal(false);
  error = signal("");
  filter = signal("");
  stateFilter = signal(""); // "" | "installed" | "uninstalled"
  appOnly = signal(true); // only modules flagged as an application (on by default)
  status = signal("");
  _pending = signal(false); // optimistic "run starting", until the backend's "run" event lands
  _announced = null; // run id we've seen running this session
  _finishedRun = null; // run id we've finalized (once per run)
  // filtered + sorted modules — recomputed only when modules/filter change
  filtered = computed(() => this._filtered());

  setup() {
    useEffect(() => this._onRun(this.currentRun()));
    this.server.onLine((line) => {
      if (this.runActive()) this.output.append(line);
    });
  }

  // the current/last install-or-upgrade run (backend-minted, from the shared store)
  currentRun() {
    const i = this.store.latestRunOfKind("install");
    const u = this.store.latestRunOfKind("upgrade");
    return (
      [i, u].filter(Boolean).sort((a, b) => (b.started_at || 0) - (a.started_at || 0))[0] || null
    );
  }

  // a run is active — optimistic between clicking Install/Upgrade and the backend's
  // first "run" event, then driven by the run's state (a method: components call it)
  runActive() {
    return this._pending() || this.currentRun()?.state === "running";
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
    return (target.checkouts || [])
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
    this.erroredDb.set("");
    try {
      const data = await postJSON("/api/addons", { repos: this._repos(), db });
      // latest wins: if the active target's db changed mid-flight, this result is
      // stale — drop it rather than show one db's modules under another's header.
      if (this.targetDb() !== db) return;
      this.modules.set(data.modules);
      this.loadedDb.set(db);
    } catch (e) {
      if (this.targetDb() !== db) return;
      this.error.set(e.message);
      this.erroredDb.set(db); // remember the failure so the effect doesn't re-fire forever
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

  // react to the backend-minted install/upgrade Run moving running → done/failed.
  // Resume-after is backend-owned now; this just drives the status + reloads module
  // states when the run ends. Finalize once per run id.
  _onRun(run) {
    if (!run) return;
    if (run.state === "running") {
      this._pending.set(false); // the real run is in — drop the optimistic override
      this._announced = run.id;
      this.status.set(`${run.kind === "upgrade" ? "upgrading" : "installing"}…`);
    } else if (this._finishedRun !== run.id) {
      this._finishedRun = run.id;
      // finished before we saw it run this session (e.g. a reload) — skip the reload
      if (this._announced !== run.id) return;
      const stopped = run.returncode === null; // manually stopped mid-run
      this.status.set(
        stopped ? "stopped" : run.returncode ? `failed — exit ${run.returncode}` : "done",
      );
      this.load(); // refresh install states (psql reads the db even while stopped)
    }
  }

  get running() {
    return this.currentRun()?.state === "running";
  }

  async run(op, name) {
    const target = this._activeTarget();
    const db = this.targetDb();
    if (!target || !db) return;
    const verb = op === "upgrade" ? "Upgrade" : "Install";
    const ok = await this.dialogs.open({
      title: `${verb} "${name}" on ${db}?`,
      okLabel: verb,
    });
    if (!ok) return;
    // if a real server is up the backend stops it for the one-shot run and resumes it
    // when the run ends (resume-after is backend-owned now — no client flag)
    this.output.clear();
    this._pending.set(true);
    this.status.set(`${op === "upgrade" ? "upgrading" : "installing"} ${name}…`);
    this.eventLog.add(`${op === "upgrade" ? "upgrading" : "installing"} ${name} in ${db}`);
    try {
      // the server resolves the target's repos + db; overrides carry the module op
      await postJSON("/api/addons/run", { target: target.id, overrides: { [op]: name } });
    } catch (e) {
      this._pending.set(false);
      this.status.set(`failed to start: ${e.message}`);
    }
  }
}
