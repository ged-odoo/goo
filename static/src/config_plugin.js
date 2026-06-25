// Config store + persistence (localStorage, with optional mirroring to a
// server-side JSON file). Owns the localStorage keys other plugins persist
// through (favorites, last target).

import { DEFAULT_CONFIG } from "./config.js";
import { postJSON } from "./utils.js";

const { Plugin, signal, useEffect } = owl;

const STORAGE_KEY = "oo-config";
export const LAST_TARGET_KEY = "oo-last-target";
const DATA_FILE_KEY = "oo-data-file";
export const FAVORITES_KEY = "oo-prs-favorites";
export const TEST_HISTORY_KEY = "oo-test-history";
// Reviews tab: PRs known merged (terminal — never re-fetched) and repos with no
// mergebot support (skipped). Persisted so the work survives reloads/restarts.
export const REVIEWS_MERGED_KEY = "oo-reviews-merged";
export const REVIEWS_NO_MERGEBOT_KEY = "oo-reviews-no-mergebot";
const PERSISTENT_KEYS = [
  STORAGE_KEY,
  FAVORITES_KEY,
  LAST_TARGET_KEY,
  TEST_HISTORY_KEY,
  REVIEWS_MERGED_KEY,
  REVIEWS_NO_MERGEBOT_KEY,
];

// a stable, unique id for a new target (referenced internally so renaming is safe)
export function newTargetId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// a deterministic id derived from a name (used when migrating old configs, so
// re-running the migration — e.g. for data-file users — yields the same ids)
function slugId(name, used) {
  const base =
    (name || "target")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "target";
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
  return id;
}

export class ConfigPlugin extends Plugin {
  static sequence = 1; // everything else may depend on config

  _migrated = this._migrate(); // runs before cfg is read (backfills target ids)
  cfg = signal(this._merged()); // the merged config object (replaced wholesale)
  dataFileSig = signal(this.getDataFile());
  _timer = null;

  // one-time migration: give every stored target a stable id, and convert the
  // persisted active target from a name (old format) to its id.
  _migrate() {
    const stored = this._stored();
    if (Array.isArray(stored.targets) && stored.targets.some((t) => !t.id)) {
      const used = new Set(stored.targets.map((t) => t.id).filter(Boolean));
      const targets = stored.targets.map((t) => {
        if (t.id) return t;
        const id = slugId(t.name, used);
        used.add(id);
        return { ...t, id };
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...stored, targets }));
    }
    const last = localStorage.getItem(LAST_TARGET_KEY);
    if (last) {
      const targets = this._merged().targets || [];
      if (!targets.some((t) => t.id === last)) {
        const byName = targets.find((t) => t.name === last);
        if (byName) localStorage.setItem(LAST_TARGET_KEY, byName.id);
      }
    }
  }

  setup() {
    // keep the backend's auto-reload set in sync with the config (it runs the
    // 4h `git fetch master` timer server-side, independent of the frontend)
    useEffect(() => {
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

  // Nuke the complete current config: drop every goo-owned localStorage key
  // (config, favorites, last target, history, caches…) so everything reverts to
  // the initial data (DEFAULT_CONFIG). The data-file link is kept; the wiped
  // state is flushed to it synchronously so a reload can't rehydrate stale data.
  async resetConfig() {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith("oo-") && k !== DATA_FILE_KEY) localStorage.removeItem(k);
    }
    this.cfg.set(this._merged());
    const path = this.getDataFile();
    if (path) await this.flush(path);
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
      this.flush(path).catch((e) => console.error(`[goo] data file save failed: ${e.message}`));
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
