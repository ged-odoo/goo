// Global state lives in plugins (Owl 3 plugin system). Each plugin owns a
// proxy state slice plus the API calls for its domain. Components read
// `plugin(SomePlugin).state().x` (auto-tracked) and call its methods. Plugins
// depend on each other via `plugin(Other)` in setup().

import { DEFAULT_CONFIG, SECTIONS, RUNBOT, BASE_BRANCH_RE, CACHE_TTL } from "./config.js";
import { postJSON } from "./utils.js";

const { Plugin, plugin, effect, signal } = owl;

const STORAGE_KEY = "oo-config";
const LAST_TARGET_KEY = "oo-last-target";
const DATA_FILE_KEY = "oo-data-file";
const FAVORITES_KEY = "oo-prs-favorites";
const DB_CACHE_KEY = "oo-db-cache";
const PRS_CACHE_KEY = "oo-prs-cache";
const PERSISTENT_KEYS = [STORAGE_KEY, FAVORITES_KEY, LAST_TARGET_KEY];

// ─────────────────────────── Config / persistence ───────────────────────────

export class ConfigPlugin extends Plugin {
  static sequence = 1;  // everything else may depend on config

  setup() {
    this.state = signal.Object({ config: this._merged(), dataFile: this.getDataFile() });
    this._timer = null;
  }

  _stored() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { return {}; }
  }
  _merged() { return { ...DEFAULT_CONFIG, ...this._stored() }; }
  get config() { return this.state().config; }

  updateConfig(patch) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...this._stored(), ...patch }));
    this.state().config = this._merged();
    this.persist();
  }
  resetKey(key) {
    const stored = this._stored();
    delete stored[key];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    this.state().config = this._merged();
    this.persist();
  }

  // generic persistent key/value (favorites, last target)
  read(key) { return localStorage.getItem(key); }
  write(key, value) { localStorage.setItem(key, value); this.persist(); }

  // ── server-side data file ──
  getDataFile() { return localStorage.getItem(DATA_FILE_KEY) || ""; }
  _collect() {
    const data = {};
    for (const k of PERSISTENT_KEYS) {
      const v = localStorage.getItem(k);
      if (v !== null) data[k] = v;
    }
    return data;
  }
  persist() {
    const path = this.getDataFile();
    if (!path) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this.flush(path).catch((e) => console.error(`[oo] data file save failed: ${e.message}`));
    }, 300);
  }
  async flush(path) { await postJSON("/api/data", { path, data: this._collect() }); }
  async useFile(path) {
    path = path.trim();
    if (!path) { this.clearFile(); return "Using browser storage."; }
    const hydrated = await loadDataFile(path);
    localStorage.setItem(DATA_FILE_KEY, path);
    this.state().dataFile = path;
    if (!hydrated) await this.flush(path);
    return hydrated ? "Linked to existing file, reloading…" : "Linked — file created from current data. Reloading…";
  }
  clearFile() { localStorage.removeItem(DATA_FILE_KEY); this.state().dataFile = ""; }
}

// load a data file into localStorage (used at bootstrap and by useFile/import)
export async function loadDataFile(path) {
  const resp = await fetch(`/api/data?path=${encodeURIComponent(path)}`);
  const res = await resp.json();
  if (!res.ok) throw new Error(res.error || resp.status);
  if (res.data && typeof res.data === "object") {
    for (const k of PERSISTENT_KEYS) {
      if (typeof res.data[k] === "string") localStorage.setItem(k, res.data[k]);
    }
    return true;
  }
  return false;
}
export function dataFilePath() { return localStorage.getItem(DATA_FILE_KEY) || ""; }
export { PERSISTENT_KEYS, DATA_FILE_KEY };

// ─────────────────────────── Router ───────────────────────────

export class RouterPlugin extends Plugin {
  static sequence = 1;
  setup() {
    this.state = signal.Object({ section: this._fromHash() });
    window.addEventListener("hashchange", () => { this.state().section = this._fromHash(); });
  }
  _fromHash() {
    const s = location.hash.replace("#", "");
    return SECTIONS.includes(s) ? s : "server";
  }
  go(section) { location.hash = section; }
}

// ─────────────────────────── Server (process + SSE log) ───────────────────────────

export class ServerPlugin extends Plugin {
  static sequence = 2;

  setup() {
    this.config = plugin(ConfigPlugin);
    this.state = signal.Object({ status: { state: "stopped" }, now: Date.now() });
    this.logListeners = new Set();
    this.buffer = [];  // recent lines, replayed to late subscribers (consoles)
    setInterval(() => { this.state().now = Date.now(); }, 1000);
    this._connect();
  }

  get status() { return this.state().status; }

  // log fan-out: console components subscribe; cb({type:'reset'} | {type:'line',line})
  // a new subscriber gets the current buffer replayed so it never misses backlog.
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
    es.onerror = () => { this.state().status = { ...this.state().status, state: "disconnected" }; };
    es.addEventListener("status", (e) => { this.state().status = JSON.parse(e.data); });
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

// ─────────────────────────── Databases ───────────────────────────

export class DatabasePlugin extends Plugin {
  static sequence = 3;

  setup() {
    this.server = plugin(ServerPlugin);
    this.state = signal.Object({ databases: [], at: 0, loading: false, error: "", dropping: "" });
    const cache = this._cache();
    if (cache) { this.state().databases = cache.databases; this.state().at = cache.at; }
  }

  get activeDb() { return this.server.status.db || null; }
  _cache() {
    try {
      const c = JSON.parse(localStorage.getItem(DB_CACHE_KEY));
      return c && c.at && c.databases ? c : null;
    } catch { return null; }
  }

  async load(force = false) {
    const cache = this._cache();
    if (!force && cache && Date.now() - cache.at < CACHE_TTL) {
      this.state().databases = cache.databases; this.state().at = cache.at; return;
    }
    this.state().loading = true; this.state().error = "";
    try {
      const data = await (await fetch("/api/databases")).json();
      if (!data.ok) throw new Error(data.error || "failed");
      const at = Date.now();
      localStorage.setItem(DB_CACHE_KEY, JSON.stringify({ at, databases: data.databases }));
      this.state().databases = data.databases; this.state().at = at;
    } catch (e) { this.state().error = e.message; }
    finally { this.state().loading = false; }
  }

  async drop(name) {
    if (!confirm(`Drop database "${name}"? This cannot be undone.`)) return;
    this.state().dropping = name;
    try {
      await postJSON("/api/databases/drop", { name });
      await this.load(true);
    } catch (e) { alert(`Drop failed: ${e.message}`); }
    finally { this.state().dropping = ""; }
  }
}

// ─────────────────────────── Code (branches & PRs) ───────────────────────────

export class CodePlugin extends Plugin {
  static sequence = 3;

  setup() {
    this.config = plugin(ConfigPlugin);
    this.state = signal.Object({
      branchRepos: [], prRepos: [], at: 0, loading: false, error: "",
      favorites: this._readFavorites(), busy: false,
    });
    const cache = this._cache();
    if (cache) { this.state().branchRepos = cache.branchRepos; this.state().prRepos = cache.prRepos; this.state().at = cache.at; }
  }

  reposWithGithub() {
    return this.config.config.repos.map((r) => ({
      ...r, github: r.github ?? DEFAULT_CONFIG.repos.find((d) => d.id === r.id)?.github,
    }));
  }
  _cache() {
    try {
      const c = JSON.parse(localStorage.getItem(PRS_CACHE_KEY));
      return c && c.at && c.branchRepos && c.prRepos ? c : null;
    } catch { return null; }
  }
  _readFavorites() {
    try { const f = JSON.parse(this.config.read(FAVORITES_KEY)); return Array.isArray(f) ? f : []; }
    catch { return []; }
  }
  isFavorite(branch) { return this.state().favorites.includes(branch); }
  toggleFavorite(branch) {
    const favs = new Set(this.state().favorites);
    favs.has(branch) ? favs.delete(branch) : favs.add(branch);
    this.state().favorites = [...favs];
    this.config.write(FAVORITES_KEY, JSON.stringify(this.state().favorites));
  }

  async load(force = false) {
    const cache = this._cache();
    if (!force && cache && Date.now() - cache.at < CACHE_TTL) {
      this.state().branchRepos = cache.branchRepos; this.state().prRepos = cache.prRepos; this.state().at = cache.at; return;
    }
    this.state().loading = true; this.state().error = "";
    const repos = this.reposWithGithub();
    try {
      const [b, p] = await Promise.all([
        postJSON("/api/code/branches", { repos }),
        postJSON("/api/prs", { repos: repos.filter((r) => r.github) }),
      ]);
      const at = Date.now();
      localStorage.setItem(PRS_CACHE_KEY, JSON.stringify({ at, branchRepos: b.repos, prRepos: p.repos }));
      this.state().branchRepos = b.repos; this.state().prRepos = p.repos; this.state().at = at;
    } catch (e) { this.state().error = e.message; }
    finally { this.state().loading = false; }
  }

  // grouped, sorted view model for the table
  groups() {
    const repos = this.reposWithGithub();
    const githubByRepo = Object.fromEntries(repos.map((r) => [r.id, r.github]));
    const pathByRepo = Object.fromEntries(repos.map((r) => [r.id, r.path]));
    const prIndex = {};
    for (const repo of this.state().prRepos) {
      for (const pr of repo.prs) prIndex[`${repo.id}:${pr.headRefName}`] = pr;
    }
    const map = new Map();
    for (const repo of this.state().branchRepos) {
      for (const b of repo.branches) {
        if (!map.has(b.name)) map.set(b.name, []);
        map.get(b.name).push({
          repo: repo.id, date: b.date, runbot: b.runbot, remote: b.remote,
          checkedOut: b.name === repo.current,
        });
      }
    }
    const favs = this.state().favorites;
    return {
      githubByRepo, pathByRepo, prIndex,
      errors: this.state().prRepos.filter((r) => r.error),
      list: [...map.entries()].map(([branch, rows]) => {
        let activity = 0;
        for (const r of rows) {
          activity = Math.max(activity, Date.parse(r.date) || 0);
          const pr = prIndex[`${r.repo}:${branch}`];
          if (pr) activity = Math.max(activity, Date.parse(pr.updatedAt) || 0);
        }
        return {
          branch, rows, activity,
          base: BASE_BRANCH_RE.test(branch),
          favorite: favs.includes(branch),
          runbot: rows.map((r) => r.runbot).find(Boolean) || "",
        };
      }).sort((a, b) => (b.favorite - a.favorite) || (a.base - b.base) || (b.activity - a.activity)),
    };
  }

  prCreateUrl(github, branch) {
    const base = (/^(saas-\d+\.\d+|\d+\.\d+|master)/.exec(branch) || [, "master"])[1];
    const name = github.split("/")[1];
    return `https://github.com/${github}/compare/${base}...odoo-dev:${name}:${branch}?expand=1`;
  }
  forkBranchUrl(github, branch) {
    const name = github.split("/")[1];
    return `https://github.com/odoo-dev/${name}/tree/${encodeURIComponent(branch)}`;
  }
  bundleUrl(branch) { return `${RUNBOT}/runbot/bundle/${encodeURIComponent(branch)}`; }

  async remoteExists(path, branch) {
    const res = await postJSON("/api/code/branch/remote", { path, branch });
    return res.exists;
  }
  async _mutate(label, fn) {
    this.state().busy = true;
    try { await fn(); await this.load(true); }
    catch (e) { alert(`${label} failed: ${e.message}`); }
    finally { this.state().busy = false; }
  }
  deleteBranch(branch, repo, path) {
    if (!confirm(`Force-delete branch "${branch}" in ${repo}? This cannot be undone.`)) return;
    return this._mutate("Delete", () => postJSON("/api/code/branches/delete", { path, branch }));
  }
  closePr(github, number) {
    if (!confirm(`Close PR #${number} in ${github}?`)) return;
    return this._mutate("Close PR", () => postJSON("/api/prs/close", { repo: github, number }));
  }
  pushBranch(path, branch) {
    if (!confirm(`Push "${branch}" to the dev remote (odoo-dev)?`)) return;
    return this._mutate("Push", () => postJSON("/api/code/branch/push", { path, branch }));
  }
}

// ─────────────────────────── Tests ───────────────────────────

export class TestsPlugin extends Plugin {
  static sequence = 3;

  setup() {
    this.server = plugin(ServerPlugin);
    this.state = signal.Object({ status: "", runActive: false, sawRun: false });
    effect(() => this._onStatus(this.server.status));
  }

  _onStatus(status) {
    const active = status.state === "starting" || status.state === "running";
    const testing = active && status.mode === "test";
    if (testing) { this.state().sawRun = true; this.state().status = "running…"; }
    else if (this.state().runActive && this.state().sawRun && status.state === "stopped") {
      this.state().runActive = false; this.state().sawRun = false;
      this.state().status = status.exited_unexpectedly
        ? (status.returncode ? `failed — exit ${status.returncode}` : "passed")
        : "stopped";
    }
  }
  get running() {
    const s = this.server.status;
    return (s.state === "starting" || s.state === "running") && s.mode === "test";
  }
  async run(targetId, tags) {
    const cfg = this.server.buildStartConfig(targetId);
    if (!cfg) return this.server.log(`[oo] no such target: "${targetId}"`);
    if (!tags.trim()) return;
    cfg.start.test_tags = tags.trim();
    this.state().runActive = true; this.state().sawRun = false; this.state().status = "starting…";
    try { await postJSON("/api/tests/run", cfg); }
    catch (e) { this.state().runActive = false; this.state().status = `failed to start: ${e.message}`; }
  }
}

// ─────────────────────────── Addons ───────────────────────────

export class AddonsPlugin extends Plugin {
  static sequence = 3;
  static MAX_ROWS = 200;

  setup() {
    this.config = plugin(ConfigPlugin);
    this.server = plugin(ServerPlugin);
    this.state = signal.Object({
      targetId: "", modules: [], loadedFor: "", loading: false, error: "",
      filter: "", status: "", runActive: false, sawRun: false,
    });
    effect(() => this._onStatus(this.server.status));
  }

  _target(id) { return this.config.config.targets.find((t) => t.id === id); }
  _repoPaths(target) {
    const paths = Object.fromEntries(this.config.config.repos.map((r) => [r.id, r.path]));
    return target.repos.map((id) => ({ id, path: paths[id] })).filter((r) => r.path);
  }

  async load(targetId) {
    const target = this._target(targetId);
    if (!target) return;
    this.state().loading = true; this.state().error = "";
    try {
      const data = await postJSON("/api/addons", { repos: this._repoPaths(target), db: target.db });
      this.state().modules = data.modules; this.state().loadedFor = targetId;
    } catch (e) { this.state().error = e.message; }
    finally { this.state().loading = false; }
  }

  filtered() {
    const q = this.state().filter.trim().toLowerCase();
    const matched = this.state().modules.filter((m) => !q
      || m.name.toLowerCase().includes(q)
      || m.summary.toLowerCase().includes(q)
      || m.category.toLowerCase().includes(q));
    matched.sort((a, b) =>
      (b.state === "installed") - (a.state === "installed") || a.name.localeCompare(b.name));
    return { total: matched.length, shown: matched.slice(0, AddonsPlugin.MAX_ROWS) };
  }

  _onStatus(status) {
    const active = status.state === "starting" || status.state === "running";
    const running = active && (status.mode === "install" || status.mode === "upgrade");
    if (running) { this.state().sawRun = true; this.state().status = `${status.mode === "upgrade" ? "upgrading" : "installing"}…`; }
    else if (this.state().runActive && this.state().sawRun && status.state === "stopped") {
      this.state().runActive = false; this.state().sawRun = false;
      this.state().status = status.exited_unexpectedly
        ? (status.returncode ? `failed — exit ${status.returncode}` : "done")
        : "stopped";
      this.load(this.state().targetId);  // refresh install states
    }
  }
  get running() {
    const s = this.server.status;
    return (s.state === "starting" || s.state === "running") && (s.mode === "install" || s.mode === "upgrade");
  }
  async run(op, name, targetId) {
    const cfg = this.server.buildStartConfig(targetId);
    if (!cfg) return;
    if (!confirm(`${op === "upgrade" ? "Upgrade" : "Install"} "${name}" on ${cfg.start.db}?`)) return;
    cfg.start[op] = name;
    this.state().runActive = true; this.state().sawRun = false;
    this.state().status = `${op === "upgrade" ? "upgrading" : "installing"} ${name}…`;
    try { await postJSON("/api/addons/run", cfg); }
    catch (e) { this.state().runActive = false; this.state().status = `failed to start: ${e.message}`; }
  }
}

export const PLUGINS = [
  ConfigPlugin, RouterPlugin, ServerPlugin, DatabasePlugin, CodePlugin, TestsPlugin, AddonsPlugin,
];
