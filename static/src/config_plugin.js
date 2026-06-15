// Config store + persistence (localStorage, with optional mirroring to a
// server-side JSON file). Owns the localStorage keys other plugins persist
// through (favorites, last target).

import { DEFAULT_CONFIG } from "./config.js";
import { postJSON } from "./utils.js";

const { Plugin, signal, effect } = owl;

const STORAGE_KEY = "oo-config";
export const LAST_TARGET_KEY = "oo-last-target";
const DATA_FILE_KEY = "oo-data-file";
export const FAVORITES_KEY = "oo-prs-favorites";
const PERSISTENT_KEYS = [STORAGE_KEY, FAVORITES_KEY, LAST_TARGET_KEY];

export class ConfigPlugin extends Plugin {
  static sequence = 1; // everything else may depend on config

  cfg = signal(this._merged()); // the merged config object (replaced wholesale)
  dataFileSig = signal(this.getDataFile());
  _timer = null;

  setup() {
    // keep the backend's auto-reload set in sync with the config (it runs the
    // 4h `git fetch master` timer server-side, independent of the frontend)
    effect(() => {
      const repos = (this.config.repos || [])
        .filter((r) => r.autoreload && r.path)
        .map((r) => ({ id: r.id, path: r.path, github: r.github }));
      postJSON("/api/autoreload", { repos }).catch(() => {});
    });
  }

  _stored() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch {
      return {};
    }
  }

  _merged() {
    return { ...DEFAULT_CONFIG, ...this._stored() };
  }

  get config() {
    return this.cfg();
  } // read in render -> tracked

  updateConfig(patch) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...this._stored(), ...patch }));
    this.cfg.set(this._merged());
    this.persist();
  }

  resetKey(key) {
    const stored = this._stored();
    delete stored[key];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    this.cfg.set(this._merged());
    this.persist();
  }

  // generic persistent key/value (favorites, last target)
  read(key) {
    return localStorage.getItem(key);
  }

  write(key, value) {
    localStorage.setItem(key, value);
    this.persist();
  }

  // ── server-side data file ──
  getDataFile() {
    return localStorage.getItem(DATA_FILE_KEY) || "";
  }

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

  async flush(path) {
    await postJSON("/api/data", { path, data: this._collect() });
  }

  async useFile(path) {
    path = path.trim();
    if (!path) {
      this.clearFile();
      return "Using browser storage.";
    }
    const hydrated = await loadDataFile(path);
    localStorage.setItem(DATA_FILE_KEY, path);
    this.dataFileSig.set(path);
    if (!hydrated) await this.flush(path);
    return hydrated
      ? "Linked to existing file, reloading…"
      : "Linked — file created from current data. Reloading…";
  }

  clearFile() {
    localStorage.removeItem(DATA_FILE_KEY);
    this.dataFileSig.set("");
  }
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
export function dataFilePath() {
  return localStorage.getItem(DATA_FILE_KEY) || "";
}
