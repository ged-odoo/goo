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

import { Model, ORM, fields } from "../../../vendor/owl-orm/index.ts";

export { ORM };

export class OdooServer extends Model {
  static id = "odooserver"; // id = "main" | target id
  data = fields.json(); // the ServerSnapshot object (spread-merged)
}

export class Run extends Model {
  static id = "run"; // id = backend-minted run id
  data = fields.json(); // the RunSnapshot object
}

export const RUNTIME_MODELS = [OdooServer, Run];
