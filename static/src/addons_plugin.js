// Browse a target's modules and install/upgrade one (via the shared process).

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
  targetId = signal("");
  modules = signal([]);
  loadedFor = signal("");
  loading = signal(false);
  error = signal("");
  filter = signal("");
  status = signal("");
  runActive = signal(false);
  sawRun = signal(false);
  // filtered + sorted modules — recomputed only when modules/filter change
  filtered = computed(() => this._filtered());

  setup() {
    effect(() => this._onStatus(this.server.status()));
    this.server.onLine((line) => {
      if (this.runActive()) this.output.append(line);
    });
  }

  _target(id) {
    return this.config.config.targets.find((t) => t.id === id);
  }
  _repoPaths(target) {
    const paths = Object.fromEntries(this.config.config.repos.map((r) => [r.id, r.path]));
    return target.repos.map((id) => ({ id, path: paths[id] })).filter((r) => r.path);
  }

  async load(targetId) {
    const target = this._target(targetId);
    if (!target) return;
    this.loading.set(true);
    this.error.set("");
    try {
      const data = await postJSON("/api/addons", { repos: this._repoPaths(target), db: target.db });
      this.modules.set(data.modules);
      this.loadedFor.set(targetId);
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
      this.load(this.targetId()); // refresh install states
    }
  }
  get running() {
    const s = this.server.status();
    return (
      (s.state === "starting" || s.state === "running") &&
      (s.mode === "install" || s.mode === "upgrade")
    );
  }
  async run(op, name, targetId) {
    const cfg = this.server.buildStartConfig(targetId);
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
