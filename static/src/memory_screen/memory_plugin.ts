// Memory panel: fetch Odoo hoot build log URLs, parse [MEMINFO] lines, and
// draw a per-suite memory consumption graph. Not server-cached (see
// MemoryService) — the user picks specific builds to compare and re-fetches
// them explicitly; the build-row/batch-url fields below are just persisted
// form input, not a data cache.

import { errorMessage, postJSON } from "../core/utils.ts";

import { Plugin, signal } from "@odoo/owl";

const STORAGE_KEY = "oo-memory-builds";
const STORAGE_KEY_BATCH_URL = "oo-memory-batch-url";

// one build row of the form: a log URL, or a log file uploaded from disk (its
// `content` is transient — never persisted; `fileName` alone survives a reload)
export interface MemoryBuild {
  label: string;
  url: string;
  fileName?: string;
  content?: string;
}

// one graph row (POST /api/memory/fetch): a suite + one used-bytes column per build label
export interface MemoryRow {
  suite: string;
  [label: string]: string | number;
}

interface BatchReply {
  builds?: MemoryBuild[];
}

interface FetchReply {
  data?: MemoryRow[];
}

export class MemoryPlugin extends Plugin {
  static sequence = 4;

  builds = signal<MemoryBuild[]>(this._loadBuilds());
  data = signal<MemoryRow[]>([]);
  loading = signal(false);
  error = signal("");
  withMobile = signal(false);

  batchUrl = signal(localStorage.getItem(STORAGE_KEY_BATCH_URL) || "");
  batchLoading = signal(false);
  batchError = signal("");

  _loadBuilds(): MemoryBuild[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) && parsed.length ? parsed : [{ label: "", url: "" }];
    } catch {
      return [{ label: "", url: "" }];
    }
  }

  _saveBuilds(builds: MemoryBuild[]): void {
    try {
      const persisted = builds.map(({ content: _content, ...rest }) => rest);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    } catch {
      // storage full or unavailable
    }
  }

  setBuilds(builds: MemoryBuild[]): void {
    this.builds.set(builds);
    this._saveBuilds(builds);
  }

  addBuild(): void {
    this.setBuilds([...this.builds(), { label: "", url: "" }]);
  }

  removeBuild(idx: number): void {
    const next = this.builds().filter((_, i) => i !== idx);
    this.setBuilds(next.length ? next : [{ label: "", url: "" }]);
    this.data.set([]);
  }

  updateBuild(idx: number, key: "label" | "url", value: string): void {
    const next = this.builds().map((b, i) => {
      if (i !== idx) return b;
      const updated: MemoryBuild = { ...b, [key]: value };
      if (key === "url") {
        delete updated.fileName;
        delete updated.content;
      }
      return updated;
    });
    this.setBuilds(next);
  }

  // uploaded file content is transient (never written to localStorage — logs
  // can be many MB, and a fresh upload is needed after reload anyway); typing
  // a URL and picking a file are mutually exclusive for a given row.
  setBuildFile(idx: number, fileName: string, content: string): void {
    const next = this.builds().map((b, i) =>
      i === idx ? { ...b, url: "", fileName, content } : b,
    );
    this.setBuilds(next);
  }

  clearBuildFile(idx: number): void {
    const next = this.builds().map((b, i) => {
      if (i !== idx) return b;
      const { fileName: _fileName, content: _content, ...rest } = b;
      return rest;
    });
    this.setBuilds(next);
  }

  setBatchUrl(url: string): void {
    this.batchUrl.set(url);
    try {
      localStorage.setItem(STORAGE_KEY_BATCH_URL, url);
    } catch {
      // ignore
    }
  }

  async fetchBatch(): Promise<void> {
    const url = this.batchUrl().trim();
    if (!url || this.batchLoading()) return;
    this.batchLoading.set(true);
    this.batchError.set("");
    try {
      const res = await postJSON<BatchReply>("/api/memory/batch", { url });
      if (!res.builds || !res.builds.length) {
        this.batchError.set("No builds found at that URL.");
      } else {
        // drop the trailing empty placeholder row if present, then append
        const existing = this.builds().filter((b) => b.label.trim() || b.url.trim() || b.content);
        this.setBuilds([...existing, ...res.builds]);
      }
    } catch (e) {
      this.batchError.set(errorMessage(e) || "failed to fetch batch builds");
    } finally {
      this.batchLoading.set(false);
    }
  }

  async load(): Promise<void> {
    const builds = this.builds().filter((b) => b.url.trim() || b.content);
    if (!builds.length || this.loading()) return;

    this.loading.set(true);
    this.error.set("");
    try {
      const res = await postJSON<FetchReply>("/api/memory/fetch", {
        builds,
        with_mobile: this.withMobile(),
      });
      this.data.set(res.data || []);
    } catch (e) {
      this.error.set(errorMessage(e) || "failed to load memory data");
    } finally {
      this.loading.set(false);
    }
  }
}
