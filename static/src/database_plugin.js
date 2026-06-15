// Database listing (cached) + drop.

import { CACHE_TTL } from "./config.js";
import { ServerPlugin } from "./server_plugin.js";
import { postJSON } from "./utils.js";

const { Plugin, plugin, signal } = owl;

const DB_CACHE_KEY = "oo-db-cache";

export class DatabasePlugin extends Plugin {
  static sequence = 3;

  server = plugin(ServerPlugin);
  databases = signal((this._cache() || {}).databases || []);
  at = signal((this._cache() || {}).at || 0);
  loading = signal(false);
  error = signal("");
  dropping = signal("");

  get activeDb() {
    return this.server.status().db || null;
  }
  _cache() {
    try {
      const c = JSON.parse(localStorage.getItem(DB_CACHE_KEY));
      return c && c.at && c.databases ? c : null;
    } catch {
      return null;
    }
  }

  async load(force = false) {
    const cache = this._cache();
    if (!force && cache && Date.now() - cache.at < CACHE_TTL) {
      this.databases.set(cache.databases);
      this.at.set(cache.at);
      return;
    }
    this.loading.set(true);
    this.error.set("");
    try {
      const data = await (await fetch("/api/databases")).json();
      if (!data.ok) throw new Error(data.error || "failed");
      const at = Date.now();
      localStorage.setItem(DB_CACHE_KEY, JSON.stringify({ at, databases: data.databases }));
      this.databases.set(data.databases);
      this.at.set(at);
    } catch (e) {
      this.error.set(e.message);
    } finally {
      this.loading.set(false);
    }
  }

  async drop(name) {
    if (!confirm(`Drop database "${name}"? This cannot be undone.`)) return;
    this.dropping.set(name);
    try {
      await postJSON("/api/databases/drop", { name });
      await this.load(true);
    } catch (e) {
      alert(`Drop failed: ${e.message}`);
    } finally {
      this.dropping.set("");
    }
  }
}
