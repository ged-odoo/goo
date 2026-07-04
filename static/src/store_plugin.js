// The shared state store — all of it now owl-orm records (observed_models.js +
// runtime_models.js), one ORM. The plugins around it are action layers, and
// StorePlugin keeps stable accessors so they're unchanged.
//
//   observed — read-only snapshots of external systems (git branches, GitHub PRs,
//     runbot, mergebot) the backend fetches + caches. Writers preserve the step-4
//     rule: latest fetchedAt wins per id; a full/authoritative fetch drops ids that
//     vanished from its scope. Accessors rebuild the Map-shaped views CodePlugin/
//     ReviewPlugin read (one mergebot map both screens share).
//   runtime — live odoo processes/runs the backend owns and mirrors over SSE:
//     OdooServer ("main" | target id) + Run records, each a `data` json snapshot.
//     ServerPlugin/WorktreePlugin/Tests/Addons are action layers; `targetView` is the
//     derived join. (Real fields + the OdooServer→Target twin ride a later pass — the
//     config models live in ConfigPlugin's ORM, this runtime state in StorePlugin's.)

import { ORM, RepoStatus, PrRepo, MergebotStatus, RunbotStatus } from "./observed_models.js";
import { OdooServer, Run } from "./runtime_models.js";

const { Plugin, computed } = owl;

export class StorePlugin extends Plugin {
  static sequence = 0; // the shared store — set up before every plugin that reads it

  // one owl-orm ORM for all of StorePlugin's state — observed (RepoStatus / PrRepo /
  // MergebotStatus / RunbotStatus) and runtime (OdooServer / Run)
  orm = new ORM();

  // in-flight keys, shared across the Code + Reviews screens so they never double-fetch
  mbPending = new Set();
  rbPending = new Set();

  // ── observed accessors — computeds that rebuild the shapes consumers already read ─
  _repoList = computed(() =>
    this.orm.records(RepoStatus).map((r) => ({
      id: r.id,
      current: r.current(),
      dirty: r.dirty(),
      error: r.error(),
      branches: r.branches(),
      fetchedAt: r.fetchedAt(),
    })),
  );

  _prList = computed(() =>
    this.orm.records(PrRepo).map((r) => ({
      id: r.id,
      github: r.github(),
      error: r.error(),
      prs: r.prs(),
      fetchedAt: r.fetchedAt(),
    })),
  );

  // one shared mergebot map both the Code and Reviews screens read (aliased there)
  mergebot = computed(() =>
    Object.fromEntries(this.orm.records(MergebotStatus).map((m) => [m.id, m.state()])),
  );

  mbDetails = computed(() =>
    Object.fromEntries(
      this.orm
        .records(MergebotStatus)
        .filter((m) => m.detail() != null)
        .map((m) => [m.id, m.detail()]),
    ),
  );

  runbot = computed(() =>
    Object.fromEntries(this.orm.records(RunbotStatus).map((r) => [r.id, r.status()])),
  );

  repoStatusList() {
    return this._repoList();
  }

  prReposList() {
    return this._prList();
  }

  // ── observed writers — preserve the step-4 semantics over records ─────────────

  // fold a branch-state fetch into RepoStatus records. `at` is the request-start
  // timestamp: stamping when the read was *requested* makes "latest wins" order a full
  // scan behind a targeted refresh that raced it. A full fetch (authoritative) drops
  // repos that vanished from config.
  mergeRepoStatus(repos, at, { authoritative } = {}) {
    for (const raw of repos) {
      const fetchedAt = raw.fetchedAt ?? at;
      const rec = this.orm.getById(RepoStatus, raw.id);
      if (!rec) {
        this.orm.create(RepoStatus, {
          id: raw.id,
          current: raw.current ?? "",
          dirty: !!raw.dirty,
          error: raw.error ?? null,
          branches: raw.branches ?? [],
          fetchedAt,
        });
      } else if (rec.fetchedAt() <= fetchedAt) {
        // latest wins — a stale response can't clobber a fresher one
        rec.current.set(raw.current ?? "");
        rec.dirty.set(!!raw.dirty);
        rec.error.set(raw.error ?? null);
        rec.branches.set(raw.branches ?? []);
        rec.fetchedAt.set(fetchedAt);
      }
    }
    if (authoritative) {
      const seen = new Set(repos.map((r) => r.id));
      for (const rec of this.orm.records(RepoStatus)) if (!seen.has(rec.id)) this.orm.delete(rec);
    }
  }

  // fold a PR fetch into PrRepo records. Authoritative only over the repos it requested
  // (scopeIds), so a narrowed dashboard/target load merges into — rather than replaces
  // — the full list, while a full load still drops repos that left the config.
  mergePrRepos(repos, at, scopeIds) {
    for (const raw of repos) {
      const fetchedAt = raw.fetchedAt ?? at;
      const rec = this.orm.getById(PrRepo, raw.id);
      if (!rec) {
        this.orm.create(PrRepo, {
          id: raw.id,
          github: raw.github ?? "",
          error: raw.error ?? null,
          prs: raw.prs ?? [],
          fetchedAt,
        });
      } else if (rec.fetchedAt() <= fetchedAt) {
        rec.github.set(raw.github ?? "");
        rec.error.set(raw.error ?? null);
        rec.prs.set(raw.prs ?? []);
        rec.fetchedAt.set(fetchedAt);
      }
    }
    const seen = new Set(repos.map((r) => r.id));
    for (const rec of this.orm.records(PrRepo)) {
      if (scopeIds.has(rec.id) && !seen.has(rec.id)) this.orm.delete(rec);
    }
  }

  mergeMergebot(states, details) {
    for (const [k, v] of Object.entries(states || {})) {
      const rec = this.orm.getById(MergebotStatus, k);
      if (rec) rec.state.set(v);
      else this.orm.create(MergebotStatus, { id: k, state: v, detail: (details || {})[k] ?? null });
    }
    for (const [k, v] of Object.entries(details || {})) {
      const rec = this.orm.getById(MergebotStatus, k);
      if (rec) rec.detail.set(v);
      else this.orm.create(MergebotStatus, { id: k, state: (states || {})[k] ?? "", detail: v });
    }
  }

  mergeRunbot(states) {
    for (const [k, v] of Object.entries(states || {})) {
      const rec = this.orm.getById(RunbotStatus, k);
      if (rec) rec.status.set(v);
      else this.orm.create(RunbotStatus, { id: k, status: v });
    }
  }

  // clear the mergebot / runbot records so a forced refresh re-displays fresh badges
  clearExternal() {
    for (const m of this.orm.records(MergebotStatus)) this.orm.delete(m);
    for (const r of this.orm.records(RunbotStatus)) this.orm.delete(r);
  }

  // ── optimistic local edits (no server round-trip) ─────────────────────────────

  // drop a branch from a repo's snapshot after a local delete, without a refetch
  dropBranch(repoId, name) {
    const rec = this.orm.getById(RepoStatus, repoId);
    if (rec) rec.branches.set((rec.branches() || []).filter((b) => b.name !== name));
  }

  // mark a PR closed in the view after closing it, without a refetch
  closePr(github, number) {
    for (const rec of this.orm.records(PrRepo)) {
      if (rec.github() !== github) continue;
      rec.prs.set(
        (rec.prs() || []).map((p) => (p.number === number ? { ...p, state: "closed" } : p)),
      );
    }
  }

  // ── runtime: OdooServer / Run records + the derived TargetView join ───────────────

  // fold one server snapshot into its OdooServer record, keyed by id. Spread-merge into
  // the `data` json so a partial SSE update (a worktree carrying only state/port)
  // preserves the fields it omits — notably a worktree's client-only `exists`. The
  // "main" snapshot carries every field.
  mergeServer(snap) {
    if (!snap || !snap.id) return;
    const rec = this.orm.getById(OdooServer, snap.id);
    if (rec) rec.data.set({ ...rec.data(), ...snap });
    else this.orm.create(OdooServer, { id: snap.id, data: { ...snap } });
  }

  // forget a server record (a worktree removed from config)
  dropServer(id) {
    const rec = this.orm.getById(OdooServer, id);
    if (rec) this.orm.delete(rec);
  }

  server(id) {
    const rec = this.orm.getById(OdooServer, id);
    return rec ? rec.data() : null;
  }

  // the server backing a target: the main process when it's running this target,
  // otherwise the target's own worktree server (or null)
  serverFor(tgt) {
    const main = this.server("main");
    if (main && main.target === tgt.id && (main.state === "running" || main.state === "starting")) {
      return main;
    }
    return this.server(tgt.id);
  }

  // fold one run snapshot into its Run record, keyed by run id (SSE "run": running → done/failed)
  mergeRun(snap) {
    if (!snap || !snap.id) return;
    const rec = this.orm.getById(Run, snap.id);
    if (rec) rec.data.set({ ...rec.data(), ...snap });
    else this.orm.create(Run, { id: snap.id, data: { ...snap } });
  }

  // the currently-running one-shot (there's one shared slot), or null
  activeRun() {
    for (const r of this.orm.records(Run)) {
      const d = r.data();
      if (d.state === "running") return d;
    }
    return null;
  }

  // the most recent run of a kind (test | install | upgrade), running or finished — so
  // a screen still shows its last result after a run of another kind occupied the slot
  latestRunOfKind(kind) {
    let best = null;
    for (const r of this.orm.records(Run)) {
      const d = r.data();
      if (d.kind !== kind) continue;
      if (!best || (d.started_at || 0) >= (best.started_at || 0)) best = d;
    }
    return best;
  }

  // the aggregate the UI orbits: a target joined with its checkouts' live git state
  // (current branch, does it match, dirty), its server, and the one-shot run holding
  // its slot. db/claude are filled in a later step.
  targetView(tgt) {
    const checkouts = (tgt.checkouts || []).map(({ repo, branch }) => {
      const rec = this.orm.getById(RepoStatus, repo);
      const current = rec ? rec.current() : undefined;
      return { repo, branch, current, matches: current === branch, dirty: !!(rec && rec.dirty()) };
    });
    const active = this.activeRun();
    const run = active && active.target === tgt.id ? active : null;
    return {
      target: tgt,
      checkouts,
      server: this.serverFor(tgt),
      db: null,
      run,
      claude: null,
    };
  }
}
