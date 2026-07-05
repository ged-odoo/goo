// Memory panel: fetch Odoo hoot build log URLs, parse [MEMINFO] lines, and
// draw a per-suite memory consumption graph. Not server-cached (see
// MemoryService) — the user picks specific builds to compare and re-fetches
// them explicitly; the build-row/batch-url fields below are just persisted
// form input, not a data cache.

import { postJSON } from "./utils.js";

import { Plugin, signal } from "@odoo/owl";

const STORAGE_KEY = "oo-memory-builds";
const STORAGE_KEY_BATCH_URL = "oo-memory-batch-url";

export class MemoryPlugin extends Plugin {
  static sequence = 4;

  builds = signal(this._loadBuilds());
  data = signal([]);
  loading = signal(false);
  error = signal("");
  withMobile = signal(false);

  batchUrl = signal(localStorage.getItem(STORAGE_KEY_BATCH_URL) || "");
  batchLoading = signal(false);
  batchError = signal("");

  _loadBuilds() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) && parsed.length ? parsed : [{ label: "", url: "" }];
    } catch {
      return [{ label: "", url: "" }];
    }
  }

  _saveBuilds(builds) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(builds));
    } catch {
      // storage full or unavailable
    }
  }

  setBuilds(builds) {
    this.builds.set(builds);
    this._saveBuilds(builds);
  }

  addBuild() {
    this.setBuilds([...this.builds(), { label: "", url: "" }]);
  }

  removeBuild(idx) {
    const next = this.builds().filter((_, i) => i !== idx);
    this.setBuilds(next.length ? next : [{ label: "", url: "" }]);
    this.data.set([]);
  }

  updateBuild(idx, key, value) {
    const next = this.builds().map((b, i) => (i === idx ? { ...b, [key]: value } : b));
    this.setBuilds(next);
  }

  setBatchUrl(url) {
    this.batchUrl.set(url);
    try {
      localStorage.setItem(STORAGE_KEY_BATCH_URL, url);
    } catch {
      // ignore
    }
  }

  async fetchBatch() {
    const url = this.batchUrl().trim();
    if (!url || this.batchLoading()) return;
    this.batchLoading.set(true);
    this.batchError.set("");
    try {
      const res = await postJSON("/api/memory/batch", { url });
      if (!res.builds || !res.builds.length) {
        this.batchError.set("No builds found at that URL.");
      } else {
        // drop the trailing empty placeholder row if present, then append
        const existing = this.builds().filter((b) => b.label.trim() || b.url.trim());
        this.setBuilds([...existing, ...res.builds]);
      }
    } catch (e) {
      this.batchError.set(e.message || "failed to fetch batch builds");
    } finally {
      this.batchLoading.set(false);
    }
  }

  async load() {
    const builds = this.builds().filter((b) => b.url.trim());
    if (!builds.length || this.loading()) return;

    this.loading.set(true);
    this.error.set("");
    try {
      const res = await postJSON("/api/memory/fetch", {
        builds,
        with_mobile: this.withMobile(),
      });
      this.data.set(res.data || []);
    } catch (e) {
      this.error.set(e.message || "failed to load memory data");
    } finally {
      this.loading.set(false);
    }
  }
}
