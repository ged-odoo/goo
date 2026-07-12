// Database listing + drop. Caching lives server-side now (see DatabaseService);
// this plugin just requests, and the backend returns cached-or-fresh.

import { ServerPlugin } from "./server_plugin.js";
import { EventLogPlugin } from "./event_log_plugin.js";
import { ConfigPlugin } from "./config_plugin.js";
import { postJSON } from "./utils.js";

import { Plugin, usePlugin, signal, useEffect } from "@odoo/owl";

export class DatabasePlugin extends Plugin {
  static sequence = 3;

  server = usePlugin(ServerPlugin);
  eventLog = usePlugin(EventLogPlugin);
  config = usePlugin(ConfigPlugin);
  databases = signal([]); // view state; freshness is the server's job now
  at = signal(0);
  loading = signal(false);
  error = signal("");
  dropping = signal("");
  _wasRunning = false; // last-seen server-running state, to detect the start edge

  setup() {
    // refresh the list whenever the server reaches "running": odoo creates its
    // database on launch, so a start/restart may have added one. Without this the
    // list only updates on a visit to the Databases screen (or its 60s cache TTL),
    // leaving stale views elsewhere — e.g. a workspace's "Drop database" item.
    useEffect(() => this._onStatus(this.server.status()));
  }

  // reload (bypassing the cache) on the rising edge into "running" — the freshly
  // created db may not be in the cached list yet
  _onStatus(status) {
    const running = status.state === "running";
    if (running && !this._wasRunning) this.load(true);
    this._wasRunning = running;
  }

  get activeDb() {
    return this.server.status().db || null;
  }

  // fetch the database list (the server caches it). `force` (manual Refresh) adds
  // ?refresh=1 so the backend re-queries instead of serving its cache.
  async load(force = false) {
    this.loading.set(true);
    this.error.set("");
    try {
      const resp = await fetch(force ? "/api/databases?refresh=1" : "/api/databases");
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || "failed");
      this.databases.set(data.databases);
      this.at.set(Date.now());
    } catch (e) {
      this.error.set(e.message);
    } finally {
      this.loading.set(false);
    }
  }

  // drop a database; returns null on success or an error message on failure
  // (the caller handles confirmation + error reporting via the dialog)
  async drop(name) {
    this.dropping.set(name);
    this.eventLog.add(`dropping database ${name}`);
    try {
      await postJSON("/api/databases/drop", { name, filestore: this._filestore() });
      await this.load(true); // drop invalidated the server cache; pull the fresh list
      return null;
    } catch (e) {
      this.eventLog.add(`failed to drop database ${name}: ${e.message}`);
      return e.message;
    } finally {
      this.dropping.set("");
    }
  }

  // clone `name` into a new database `target`; returns null on success or an error
  async clone(name, target) {
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
      this.eventLog.add(`failed to clone database ${name}: ${e.message}`);
      return e.message;
    }
  }

  // clone `source` into `target`, transparently stopping + resuming the server when
  // `source` is the active db (postgres createdb -T needs exclusive access). Returns
  // null on success or an error message; the server is resumed even if the clone fails.
  async cloneStoppingServer(source, target) {
    const resume = this.activeDb === source && this.server.status().state !== "stopped";
    if (resume) await this.server.stop();
    const error = await this.clone(source, target);
    if (resume) await this.server.resume();
    return error;
  }

  // drop `name`, stopping the server first when it's the active db (the server
  // holds a connection to it). Unlike clone, we don't resume — the database is
  // gone, so the server stays stopped. Returns null on success or an error message.
  async dropStoppingServer(name) {
    if (this.activeDb === name && this.server.status().state !== "stopped") {
      await this.server.stop();
    }
    return this.drop(name);
  }

  // rename `name` to `newName`; returns null on success or an error message
  async rename(name, newName) {
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
      this.eventLog.add(`failed to rename database ${name}: ${e.message}`);
      return e.message;
    }
  }

  // the configured filestore root, sent with drop/clone/rename so the backend keeps
  // each db's <filestore>/<db> directory in lockstep (empty = leave the disk alone)
  _filestore() {
    return this.config.config.filestore || "";
  }
}
