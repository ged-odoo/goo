// List a database's asset-bundle attachments (ir_attachment under /web/assets/…)
// and force a fresh pregeneration of them. The database is chosen explicitly in the
// Assets screen; it defaults to the active target's db but isn't tied to it.

import { ConfigPlugin } from "./config_plugin.js";
import { ServerPlugin } from "./server_plugin.js";
import { DatabasePlugin } from "./database_plugin.js";
import { EventLogPlugin } from "./event_log_plugin.js";
import { DialogPlugin } from "./dialog_plugin.js";
import { postJSON } from "./utils.js";

const { Plugin, plugin, signal } = owl;

export class AssetsPlugin extends Plugin {
  static sequence = 6;

  config = plugin(ConfigPlugin);
  server = plugin(ServerPlugin);
  db = plugin(DatabasePlugin);
  eventLog = plugin(EventLogPlugin);
  dialogs = plugin(DialogPlugin);

  bundles = signal([]);
  selectedDb = signal("");
  loadedDb = signal("");
  at = signal(0);
  loading = signal(false);
  generating = signal(false);
  error = signal("");
  // analysis of one bundle: { name, js:[[path,bytes]], css, xml } | null
  bundleData = signal(null);
  analyzing = signal(false);
  analyzeError = signal("");

  // disable actions while a load or a generation is in flight
  busy() {
    return this.loading() || this.generating();
  }

  // the db to inspect by default: the running server's db, else the active target's
  defaultDb() {
    const id = this.server.status().target || this.server.lastTarget();
    const target = this.config.config.targets.find((t) => t.id === id);
    return this.server.status().db || target?.db || "";
  }

  // pick a database and (re)load its bundles; "" clears the list
  selectDb(db) {
    this.selectedDb.set(db);
    if (db) this.load(true);
    else {
      this.bundles.set([]);
      this.loadedDb.set("");
    }
  }

  async load(force = false) {
    const db = this.selectedDb();
    if (!db) {
      this.bundles.set([]);
      this.loadedDb.set("");
      return;
    }
    this.loading.set(true);
    this.error.set("");
    try {
      const data = await postJSON("/api/assets", { db, refresh: force });
      // latest wins: if the user switched databases while this was in flight, its
      // result is stale — drop it rather than show db A's bundles under db B.
      if (this.selectedDb() !== db) return;
      this.bundles.set(data.bundles);
      this.loadedDb.set(db);
      this.at.set(Date.now());
    } catch (e) {
      if (this.selectedDb() === db) this.error.set(e.message);
    } finally {
      this.loading.set(false);
    }
  }

  // force a pregeneration of the bundles (odoo-bin shell), then reload the list.
  // The server builds the addons-path + venv prefix from its own config — just the db.
  async generate() {
    const db = this.selectedDb();
    if (!db) return;
    this.generating.set(true);
    this.error.set("");
    const eid = this.eventLog.begin(`generating asset bundles in ${db}…`);
    try {
      await postJSON("/api/assets/generate", { db });
      this.eventLog.finish(eid, "done");
      await this.load(true);
    } catch (e) {
      this.eventLog.finish(eid, "error");
      this.error.set(e.message);
      this.dialogs.open({
        title: "Generate asset bundles failed",
        message: e.message,
        cls: "dialog-error",
        okLabel: "OK",
        cancelLabel: null,
      });
    } finally {
      this.generating.set(false);
    }
  }

  // analyze a bundle's contents: ask the backend for the per-file minified-size
  // breakdown (read from the stored bundle), and open the view. kind scopes it to the
  // clicked asset — "js" → the .min.js (code + XML templates), "css" → the .min.css —
  // so the total matches that attachment's row size instead of summing js+css.
  async analyze(bundle, kind = "js") {
    const db = this.selectedDb();
    if (!db || !bundle) return;
    this.analyzing.set(true);
    this.analyzeError.set("");
    this.bundleData.set({ name: bundle, kind, js: [], css: [], xml: [] }); // marks "open" while loading
    try {
      const filestore = this.config.config.filestore || "";
      const data = await postJSON("/api/assets/breakdown", { db, bundle, filestore, kind });
      this.bundleData.set({ name: bundle, kind, js: data.js, css: data.css, xml: data.xml });
    } catch (e) {
      this.analyzeError.set(e.message);
    } finally {
      this.analyzing.set(false);
    }
  }

  closeAnalysis() {
    this.bundleData.set(null);
    this.analyzeError.set("");
  }
}
