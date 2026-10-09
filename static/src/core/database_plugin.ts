// Database listing + drop. Caching lives server-side now (see DatabaseService);
// this plugin just requests, and the backend returns cached-or-fresh.

import { ServerPlugin } from "./server_plugin.ts";
import { EventLogPlugin } from "./event_log_plugin.ts";
import { ConfigPlugin } from "./config_plugin.ts";
import { errorMessage, formatBytes, postJSON } from "./utils.ts";
import type { ServerStatus } from "./runtime_models.ts";

import { Plugin, usePlugin, signal, useEffect } from "@odoo/owl";

// one database of the list (backend DatabaseService.list)
export interface DatabaseInfo {
  name: string;
  odoo_version: string | null; // null = not an odoo database
  enterprise: boolean;
  demo_data: boolean;
  last_update: string | null;
  created: string | null; // naive UTC ISO, when readable
  size: number | null; // bytes, when readable
}

// one database dump a runbot batch left behind (backend RunbotService dumps)
export interface RunbotDump {
  build?: string;
  slot: string; // the build's name, e.g. "Enterprise Run"
  db: string; // "all" | "base" | …
  url: string;
  size?: number;
}

// "Enterprise Run — all (51 MB)": how a dump is offered for restoring
export function dumpLabel(d: RunbotDump): string {
  return `${d.slot} — ${d.db}${d.size ? ` (${formatBytes(d.size)})` : ""}`;
}

export class DatabasePlugin extends Plugin {
  static sequence = 3;

  server = usePlugin(ServerPlugin);
  eventLog = usePlugin(EventLogPlugin);
  config = usePlugin(ConfigPlugin);
  databases = signal<DatabaseInfo[]>([]); // view state; freshness is the server's job now
  at = signal(0);
  loading = signal(false);
  error = signal("");
  dropping = signal("");
  _wasRunning = false; // last-seen server-running state, to detect the start edge

  setup(): void {
    // refresh the list whenever the server reaches "running": odoo creates its
    // database on launch, so a start/restart may have added one. Without this the
    // list only updates on a visit to the Databases screen (or its 60s cache TTL),
    // leaving stale views elsewhere — e.g. a workspace's "Drop database" item.
    useEffect(() => this._onStatus(this.server.status()));
  }

  // reload (bypassing the cache) on the rising edge into "running" — the freshly
  // created db may not be in the cached list yet
  _onStatus(status: ServerStatus): void {
    const running = status.state === "running";
    if (running && !this._wasRunning) this.load(true);
    this._wasRunning = running;
  }

  get activeDb(): string | null {
    return this.server.status().db || null;
  }

  // fetch the database list (the server caches it). `force` (manual Refresh) adds
  // ?refresh=1 so the backend re-queries instead of serving its cache.
  async load(force = false): Promise<void> {
    this.loading.set(true);
    this.error.set("");
    try {
      const resp = await fetch(force ? "/api/databases?refresh=1" : "/api/databases");
      const data: { ok?: boolean; error?: string; databases: DatabaseInfo[] } = await resp.json();
      if (!data.ok) throw new Error(data.error || "failed");
      this.databases.set(data.databases);
      this.at.set(Date.now());
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }

  // drop a database; returns null on success or an error message on failure
  // (the caller handles confirmation + error reporting via the dialog)
  async drop(name: string): Promise<string | null> {
    this.dropping.set(name);
    this.eventLog.add(`dropping database ${name}`);
    try {
      await postJSON("/api/databases/drop", { name, filestore: this._filestore() });
      await this.load(true); // drop invalidated the server cache; pull the fresh list
      return null;
    } catch (e) {
      this.eventLog.add(`failed to drop database ${name}: ${errorMessage(e)}`);
      return errorMessage(e);
    } finally {
      this.dropping.set("");
    }
  }

  // clone `name` into a new database `target`; returns null on success or an error
  async clone(name: string, target: string): Promise<string | null> {
    this.eventLog.add(`cloning database ${name} → ${target}`);
    try {
      await postJSON("/api/databases/clone", {
        source: name,
        dest: target,
        filestore: this._filestore(),
      });
      await this.load(true); // server cache was invalidated; pull the fresh list
      return null;
    } catch (e) {
      this.eventLog.add(`failed to clone database ${name}: ${errorMessage(e)}`);
      return errorMessage(e);
    }
  }

  // restore a runbot build's database dump (see RunbotService.bundle_dumps) into a
  // NEW database `target`, then run the `cleanup` steps (backend RESTORE_CLEANUPS)
  // on it; returns null on success or an error message.
  async restoreRunbotDump(
    url: string,
    target: string,
    cleanup: string[] = [],
  ): Promise<string | null> {
    return this._restore(target, "runbot database", () =>
      postJSON("/api/databases/restore-dump", {
        name: target,
        url,
        filestore: this._filestore(),
        cleanup,
      }),
    );
  }

  // restore a local dump file (an odoo .zip, or a .sql.gz) into a NEW database
  // `target`: the file is uploaded as the raw request body, the rest rides in the
  // query string. Returns null on success or an error message.
  async restoreFile(file: File, target: string, cleanup: string[] = []): Promise<string | null> {
    const query = new URLSearchParams({
      name: target,
      filename: file.name,
      filestore: this._filestore(),
      cleanup: cleanup.join(","),
    });
    return this._restore(target, file.name, async () => {
      const resp = await fetch(`/api/databases/upload-dump?${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      const data: { ok?: boolean; error?: string } = await resp.json().catch(() => ({}));
      if (!data.ok) throw new Error(data.error || String(resp.status));
    });
  }

  // the shared restore envelope. Unlike the other db actions a restore is slow
  // enough to need a *timed* row — tens/hundreds of MB, replayed through psql — so
  // it logs begin/finish rather than a single line, and the row keeps its animated
  // "..." for as long as the restore really runs.
  async _restore(
    target: string,
    what: string,
    run: () => Promise<unknown>,
  ): Promise<string | null> {
    const eid = this.eventLog.begin(`restoring ${what} into ${target}`);
    try {
      await run();
      await this.load(true); // server cache was invalidated; pull the fresh list
      this.eventLog.finish(eid, "done");
      return null;
    } catch (e) {
      this.eventLog.finish(eid, "error");
      return errorMessage(e);
    }
  }

  // clone `source` into `target`, transparently stopping + resuming the server when
  // `source` is the active db (postgres createdb -T needs exclusive access). Returns
  // null on success or an error message; the server is resumed even if the clone fails.
  async cloneStoppingServer(source: string, target: string): Promise<string | null> {
    const resume = this.activeDb === source && this.server.status().state !== "stopped";
    if (resume) await this.server.stop();
    const error = await this.clone(source, target);
    if (resume) await this.server.resume();
    return error;
  }

  // drop `name`, stopping the server first when it's the active db (the server
  // holds a connection to it). Unlike clone, we don't resume — the database is
  // gone, so the server stays stopped. Returns null on success or an error message.
  async dropStoppingServer(name: string): Promise<string | null> {
    if (this.activeDb === name && this.server.status().state !== "stopped") {
      await this.server.stop();
    }
    return this.drop(name);
  }

  // rename `name` to `newName`; returns null on success or an error message
  async rename(name: string, newName: string): Promise<string | null> {
    this.eventLog.add(`renaming database ${name} → ${newName}`);
    try {
      await postJSON("/api/databases/rename", {
        name,
        new_name: newName,
        filestore: this._filestore(),
      });
      await this.load(true);
      return null;
    } catch (e) {
      this.eventLog.add(`failed to rename database ${name}: ${errorMessage(e)}`);
      return errorMessage(e);
    }
  }

  // the configured filestore root, sent with drop/clone/rename so the backend keeps
  // each db's <filestore>/<db> directory in lockstep (empty = leave the disk alone)
  _filestore(): string {
    return this.config.config.filestore || "";
  }
}
