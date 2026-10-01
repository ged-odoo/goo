// Browse a workspace's modules and install/upgrade one on its server slot.
// State is PER SLOT ("main" | a worktree workspace id): each slot has its own
// module list, console and status, so the Addons pane can browse a worktree
// workspace's checkout (its own addons paths + db) while another slot runs.

import { ConfigPlugin } from "../core/config_plugin.ts";
import { StorePlugin } from "../core/store_plugin.ts";
import { ServerPlugin } from "../core/server_plugin.ts";
import { EventLogPlugin } from "../core/event_log_plugin.ts";
import { DialogPlugin } from "../core/dialog_plugin.ts";
import { WorkspacePlugin } from "../core/workspace_plugin.ts";
import { LogBuffer } from "../core/log_buffer.ts";
import { errorMessage, postJSON } from "../core/utils.ts";
import { slotFor } from "../core/tests_plugin.ts";
import type { WorkspaceLike } from "../core/workspace_plugin.ts";
import type { RunSnapshot } from "../core/runtime_models.ts";

import { Plugin, usePlugin, useEffect, signal, computed } from "@odoo/owl";
import type { ReactiveValue, Signal } from "@odoo/owl";

// one module of a workspace's addons paths (POST /api/addons)
export interface AddonModule {
  name: string;
  repo: string;
  category: string;
  summary: string;
  application: boolean;
  installable: boolean;
  state: string | null; // the module's ir_module_module state in the db (null = not there)
}

interface AddonsReply {
  modules: AddonModule[];
}

export interface FilteredModules {
  total: number;
  shown: AddonModule[];
}

// a repo's {id, path} as /api/addons scans it
interface RepoPathSpec {
  id: string;
  path: string;
}

export type ModuleOp = "install" | "upgrade";

// one server slot's module/run/console state (AddonsPlugin.slot())
export interface AddonSlot {
  output: LogBuffer;
  modules: Signal<AddonModule[]>;
  loadedDb: Signal<string>;
  erroredDb: Signal<string>;
  loading: Signal<boolean>;
  error: Signal<string>;
  status: Signal<string>;
  pending: Signal<boolean>;
  announced: string | null;
  finishedRun: string | null;
  lastWs: WorkspaceLike | null;
  filtered: ReactiveValue<FilteredModules>;
}

export class AddonsPlugin extends Plugin {
  static sequence = 4;
  static MAX_ROWS = 200;

  config = usePlugin(ConfigPlugin);
  store = usePlugin(StorePlugin); // install/upgrade runs live in the shared store's runs map
  server = usePlugin(ServerPlugin);
  eventLog = usePlugin(EventLogPlugin);
  dialogs = usePlugin(DialogPlugin);
  worktree = usePlugin(WorkspacePlugin); // a worktree slot's addons paths come from its checkout
  // the text/state filters are global — shared between the standalone screen and
  // the Workspaces pane (acceptable: one user, one focus at a time)
  filter = signal("");
  stateFilter = signal(""); // "" | "installed" | "uninstalled"
  appOnly = signal(true); // only modules flagged as an application (on by default)
  _slots = new Map<string, AddonSlot>(); // slotId -> per-slot module/run/console state

  slot(id = "main"): AddonSlot {
    if (!this._slots.has(id)) {
      const rec: AddonSlot = {
        output: new LogBuffer(),
        modules: signal<AddonModule[]>([]),
        loadedDb: signal(""),
        erroredDb: signal(""), // db whose last auto-load failed — don't auto-retry (hot loop)
        loading: signal(false),
        error: signal(""),
        status: signal(""),
        pending: signal(false), // optimistic "run starting", until the "run" event lands
        announced: null, // run id we've seen running this session
        finishedRun: null, // run id we've finalized (once per run)
        lastWs: null, // the workspace last loaded into this slot (for the post-run refresh)
        // filtered + sorted modules — recomputed only when the slot's modules/filters change
        // (computed is lazy: `rec` is initialized by the time the getter first runs)
        filtered: computed(() => this._filtered(rec)),
      };
      this._slots.set(id, rec);
    }
    return this._slots.get(id)!; // inserted just above when missing
  }

  runningFor(slotId: string): boolean {
    return this.currentRun(slotId)?.state === "running";
  }

  setup(): void {
    // per-slot run dispatch on the LATEST install/upgrade run of every slot
    useEffect(() => {
      const slots = new Set(
        this.store
          .runs()
          .filter((d) => d.kind === "install" || d.kind === "upgrade")
          .map((d) => d.server ?? "main"),
      );
      for (const s of slots) this._onRun(s, this.currentRun(s));
    });
    // the unified log stream, routed by server slot
    this.server.onLog(({ server, line }) => {
      if (
        server === "main"
          ? this.runActive("main")
          : this._slots.has(server) && this.runActive(server)
      )
        this.slot(server).output.append(line);
    });
  }

  // the current/last install-or-upgrade run on a slot
  currentRun(slotId = "main"): RunSnapshot | null {
    const i = this.store.latestRunOfKind("install", slotId);
    const u = this.store.latestRunOfKind("upgrade", slotId);
    return (
      [i, u]
        .filter((r): r is RunSnapshot => Boolean(r))
        .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))[0] || null
    );
  }

  // a run is active on a slot — optimistic between clicking Install/Upgrade and the
  // backend's first "run" event, then driven by the run's state
  runActive(slotId = "main"): boolean {
    return this.slot(slotId).pending() || this.currentRun(slotId)?.state === "running";
  }

  // a workspace's repos as {id, path}: a worktree workspace's own checkout copies,
  // else the main checkout paths of its checkouts — the addons-path used to list +
  // install, so only its modules are ever shown
  _reposFor(ws: WorkspaceLike): RepoPathSpec[] {
    if (ws.location === "worktree") {
      return this.worktree.wtRepos(ws).map((r) => ({ id: r.repo, path: r.worktreePath }));
    }
    const pathById = Object.fromEntries(this.config.config.repos.map((r) => [r.id, r.path]));
    return (ws.checkouts || [])
      .map((c) => ({ id: c.repo, path: pathById[c.repo] }))
      .filter((r): r is RepoPathSpec => Boolean(r.path));
  }

  // load a workspace's module list (own db + repos) into its slot
  async load(ws: WorkspaceLike | null | undefined): Promise<void> {
    if (!ws) return;
    const slotId = slotFor(ws);
    const s = this.slot(slotId);
    const db = ws.db;
    s.lastWs = ws;
    if (!db) {
      s.modules.set([]);
      s.loadedDb.set("");
      return;
    }
    s.loading.set(true);
    s.error.set("");
    s.erroredDb.set("");
    try {
      const data = await postJSON<AddonsReply>("/api/addons", { repos: this._reposFor(ws), db });
      // latest wins: if the slot's db changed mid-flight, this result is stale —
      // drop it rather than show one db's modules under another's header.
      if (s.lastWs?.db !== db) return;
      s.modules.set(data.modules);
      s.loadedDb.set(db);
    } catch (e) {
      if (s.lastWs?.db !== db) return;
      s.error.set(errorMessage(e));
      s.erroredDb.set(db); // remember the failure so the effect doesn't re-fire forever
    } finally {
      s.loading.set(false);
    }
  }

  _filtered(s: AddonSlot): FilteredModules {
    const q = this.filter().trim().toLowerCase();
    const sf = this.stateFilter();
    const appOnly = this.appOnly();
    const matched = s.modules().filter((mod) => {
      const installed = mod.state === "installed";
      if (sf === "installed" && !installed) return false;
      if (sf === "uninstalled" && installed) return false;
      if (appOnly && !mod.application) return false;
      return (
        !q ||
        mod.name.toLowerCase().includes(q) ||
        mod.summary.toLowerCase().includes(q) ||
        mod.category.toLowerCase().includes(q)
      );
    });
    matched.sort(
      (a, b) =>
        Number(b.state === "installed") - Number(a.state === "installed") ||
        a.name.localeCompare(b.name),
    );
    return { total: matched.length, shown: matched.slice(0, AddonsPlugin.MAX_ROWS) };
  }

  // react to a slot's backend-minted install/upgrade Run moving running →
  // done/failed. Resume-after is backend-owned; this drives the status + reloads
  // module states when the run ends. Finalize once per run id per slot.
  _onRun(slotId: string, run: RunSnapshot | null): void {
    if (!run) return;
    const s = this.slot(slotId);
    if (run.state === "running") {
      s.pending.set(false); // the real run is in — drop the optimistic override
      s.announced = run.id;
      s.status.set(`${run.kind === "upgrade" ? "upgrading" : "installing"}…`);
    } else if (s.finishedRun !== run.id) {
      s.finishedRun = run.id;
      // finished before we saw it run this session (e.g. a reload) — skip the reload
      if (s.announced !== run.id) return;
      const stopped = run.returncode === null; // manually stopped mid-run
      s.status.set(
        stopped ? "stopped" : run.returncode ? `failed — exit ${run.returncode}` : "done",
      );
      this.load(s.lastWs); // refresh install states (psql reads the db even while stopped)
    }
  }

  // install/upgrade a module on a workspace's slot
  async run(op: ModuleOp, name: string, ws: WorkspaceLike | null | undefined): Promise<void> {
    if (!ws) return;
    const slotId = slotFor(ws);
    const target = ws;
    const db = ws.db;
    if (!db) return;
    const s = this.slot(slotId);
    const verb = op === "upgrade" ? "Upgrade" : "Install";
    const ok = await this.dialogs.open({
      title: `${verb} "${name}" on ${db}?`,
      okLabel: verb,
    });
    if (!ok) return;
    this.config.workspace(ws.id)?.touchActivity();
    // if a real server is up on the slot the backend stops it for the one-shot run
    // and resumes it when the run ends (resume-after is backend-owned)
    s.output.clear();
    s.pending.set(true);
    s.status.set(`${op === "upgrade" ? "upgrading" : "installing"} ${name}…`);
    this.eventLog.add(`${op === "upgrade" ? "upgrading" : "installing"} ${name} in ${db}`);
    try {
      // the server resolves the target's repos + db; overrides carry the module op
      await postJSON("/api/addons/run", {
        workspace: target.id,
        slot: slotId,
        overrides: { [op]: name },
      });
    } catch (e) {
      s.pending.set(false);
      s.status.set(`failed to start: ${errorMessage(e)}`);
    }
  }
}
