// List a database's asset-bundle attachments (ir_attachment under /web/assets/…)
// and force a fresh pregeneration of them. The database is chosen explicitly in the
// Assets pane; the pane forces it to its workspace's db.

import { ConfigPlugin } from "../core/config_plugin.ts";
import { DatabasePlugin } from "../core/database_plugin.ts";
import { EventLogPlugin } from "../core/event_log_plugin.ts";
import { DialogPlugin } from "../core/dialog_plugin.ts";
import { errorMessage, postJSON } from "../core/utils.ts";
import type { WorkspaceLike } from "../core/workspace_plugin.ts";

import { Plugin, usePlugin, signal } from "@odoo/owl";

// one asset-bundle attachment of a db (POST /api/assets)
export interface AssetBundle {
  id: number | string; // the ir_attachment id (a string only if psql returned a non-digit)
  name: string; // e.g. "web.assets_web.min.js"
  url: string; // its /web/assets/… path
  size: number;
  created: string;
}

// one bundle file's [path, minified bytes]
export type BundleFile = [string, number];

export type BundleKind = "js" | "css";

// the analysis of one bundle (POST /api/assets/breakdown), scoped to `kind`
export interface BundleData {
  name: string;
  kind: BundleKind;
  js: BundleFile[];
  css: BundleFile[];
  xml: BundleFile[];
}

interface AssetsReply {
  bundles: AssetBundle[];
}

type BreakdownReply = Pick<BundleData, "js" | "css" | "xml">;

export class AssetsPlugin extends Plugin {
  static sequence = 6;

  config = usePlugin(ConfigPlugin);
  db = usePlugin(DatabasePlugin);
  eventLog = usePlugin(EventLogPlugin);
  dialogs = usePlugin(DialogPlugin);

  bundles = signal<AssetBundle[]>([]);
  selectedDb = signal("");
  loadedDb = signal("");
  at = signal(0);
  loading = signal(false);
  generating = signal(false);
  error = signal("");
  // analysis of one bundle: { name, js:[[path,bytes]], css, xml } | null
  bundleData = signal<BundleData | null>(null);
  analyzing = signal(false);
  analyzeError = signal("");

  // disable actions while a load or a generation is in flight
  busy(): boolean {
    return this.loading() || this.generating();
  }

  // pick a database and (re)load its bundles; "" clears the list
  selectDb(db: string): void {
    this.selectedDb.set(db);
    if (db) this.load(true);
    else {
      this.bundles.set([]);
      this.loadedDb.set("");
    }
  }

  async load(force = false): Promise<void> {
    const db = this.selectedDb();
    if (!db) {
      this.bundles.set([]);
      this.loadedDb.set("");
      return;
    }
    this.loading.set(true);
    this.error.set("");
    try {
      const data = await postJSON<AssetsReply>("/api/assets", { db, refresh: force });
      // latest wins: if the user switched databases while this was in flight, its
      // result is stale — drop it rather than show db A's bundles under db B.
      if (this.selectedDb() !== db) return;
      this.bundles.set(data.bundles);
      this.loadedDb.set(db);
      this.at.set(Date.now());
    } catch (e) {
      if (this.selectedDb() === db) this.error.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }

  // force a pregeneration of the bundles (odoo-bin shell), then reload the list.
  // The server builds the addons-path + venv prefix from its own config — just the
  // db, plus an optional workspace so a worktree workspace's bundles are generated
  // with ITS checkout's code (the Workspaces pane passes it).
  async generate(ws: WorkspaceLike | null = null): Promise<void> {
    const db = this.selectedDb();
    if (!db) return;
    this.generating.set(true);
    this.error.set("");
    const eid = this.eventLog.begin(`generating asset bundles in ${db}…`);
    try {
      await postJSON("/api/assets/generate", { db, ...(ws ? { workspace: ws.id } : {}) });
      this.eventLog.finish(eid, "done");
      await this.load(true);
    } catch (e) {
      this.eventLog.finish(eid, "error");
      this.error.set(errorMessage(e));
      this.dialogs.error("Generate asset bundles failed", errorMessage(e));
    } finally {
      this.generating.set(false);
    }
  }

  // analyze a bundle's contents: ask the backend for the per-file minified-size
  // breakdown (read from the stored bundle), and open the view. kind scopes it to the
  // clicked asset — "js" → the .min.js (code + XML templates), "css" → the .min.css —
  // so the total matches that attachment's row size instead of summing js+css.
  async analyze(bundle: string, kind: BundleKind = "js"): Promise<void> {
    const db = this.selectedDb();
    if (!db || !bundle) return;
    this.analyzing.set(true);
    this.analyzeError.set("");
    this.bundleData.set({ name: bundle, kind, js: [], css: [], xml: [] }); // marks "open" while loading
    try {
      const filestore = this.config.config.filestore || "";
      const data = await postJSON<BreakdownReply>("/api/assets/breakdown", {
        db,
        bundle,
        filestore,
        kind,
      });
      this.bundleData.set({ name: bundle, kind, js: data.js, css: data.css, xml: data.xml });
    } catch (e) {
      this.analyzeError.set(errorMessage(e));
    } finally {
      this.analyzing.set(false);
    }
  }

  closeAnalysis(): void {
    this.bundleData.set(null);
    this.analyzeError.set("");
  }
}
