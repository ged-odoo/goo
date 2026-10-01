// The runtime family as owl-orm models — live processes the backend owns and mirrors
// over SSE. Fourth state conversion of the ORM rewrite: StorePlugin holds servers +
// runs as records instead of plain Maps, keeping its accessors (server / serverFor /
// mergeServer / dropServer / mergeRun / activeRun / latestRunOfKind) so ServerPlugin,
// WorkspacePlugin, Tests/Addons are unchanged.
//
// Each snapshot is carried as a single `data` json field (the exact ServerSnapshot /
// RunSnapshot object). Spread-merge into it preserves the fields a partial SSE update
// omits — notably a worktree's client-only `exists` — and keeps null/absent semantics
// exactly as the backend sends them (no per-field coercion). The twin m2o
// (OdooServer → Target) is deferred: Target lives in ConfigPlugin's ORM, and this
// runtime ORM is StorePlugin's own; unifying them + real fields rides a later pass.

import { Model, fields } from "../../../vendor/owl-orm/index.ts";
import type { Signal } from "@odoo/owl";

// one odoo server (backend ServerSnapshot): the main process (id "main") or a
// worktree workspace's own. Every field but id/state is optional: an SSE update may
// be partial (spread-merged into the record), and the client mints a bare
// {id, state: "disconnected"} itself.
export interface ServerSnapshot {
  id: string; // "main" | workspace id
  state: string; // stopped | starting | running | stopping | disconnected (client-only)
  terminal?: boolean; // only "main" has the PTY/xterm channel
  workspace?: string | null; // the workspace this server runs (== id for non-main)
  db?: string | null;
  port?: number | null;
  mode?: string | null; // server | test | install | upgrade (main only)
  pid?: number | null;
  cmd?: string | null;
  started_at?: number | null;
  exited_unexpectedly?: boolean;
  returncode?: number | null;
  odoo_port_busy?: boolean;
  odoo_version?: string | null;
  enterprise?: boolean | null;
  exists?: boolean | null; // worktree-only: checkout present on disk
  docker_container?: string | null; // launch_mode "docker": the live container slot
}

// ServerPlugin.status(): the main server's snapshot, or a bare {state: "stopped"}
// before the first one lands
export type ServerStatus = Omit<ServerSnapshot, "id"> & { id?: string };

// a one-shot run (backend RunSnapshot): a test / install / upgrade occupying a slot
export interface RunSnapshot {
  id: string; // backend-minted (e.g. "run-3")
  kind: string; // test | install | upgrade
  state: string; // running | done | failed
  server?: string; // the slot it occupies ("main" when absent)
  workspace?: string | null;
  db?: string | null;
  spec?: { tags?: string; module?: string };
  returncode?: number | null;
  ok?: boolean | null; // null while running / when manually stopped
  resume?: boolean;
  started_at?: number | null;
}

export class OdooServer extends Model {
  static id = "odooserver"; // id = "main" | target id
  data: Signal<ServerSnapshot> = fields.json(); // the ServerSnapshot object (spread-merged)
}

export class Run extends Model {
  static id = "run"; // id = backend-minted run id
  data: Signal<RunSnapshot> = fields.json(); // the RunSnapshot object
}
