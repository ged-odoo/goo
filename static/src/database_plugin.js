// Database listing + drop. Caching lives server-side now (see DatabaseService);
// this plugin just requests, and the backend returns cached-or-fresh.

import { ServerPlugin } from "./server_plugin.js";
import { EventLogPlugin } from "./event_log_plugin.js";
import { ConfigPlugin } from "./config_plugin.js";
import { postJSON } from "./utils.js";

const { Plugin, plugin, signal } = owl;

export class DatabasePlugin extends Plugin {
  static sequence = 3;

  server = plugin(ServerPlugin);
  eventLog = plugin(EventLogPlugin);
  config = plugin(ConfigPlugin);
  databases = signal([]); // view state; freshness is the server's job now
  at = signal(0);
  loading = signal(false);
  error = signal("");
  dropping = signal("");

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
        target,
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
