// The shared state store, normalized by identity — each store is a Map keyed by the
// entity's canonical id, and the plugins around it are action layers.
//
//   observed — read-only snapshots of external systems (git branches, GitHub PRs,
//     runbot, mergebot) the backend fetches + caches. Every write goes through the
//     one mergeEntities rule (full/narrowed loads, targeted refreshes, stale
//     responses). CodePlugin and ReviewPlugin share these (one mergebot map both
//     screens read and write).
//   runtime — live odoo processes the backend owns and mirrors over SSE. One
//     `servers` map keyed by "main" | target id (the main OdooManager process and
//     each worktree server, unified — see backend ServerSnapshot); ServerPlugin and
//     WorktreePlugin are action layers over it. `targetView` is the derived join.

const { Plugin, signal } = owl;

// The one merge rule (design doc §"Observed: normalized snapshot stores"). Fold
// `entities` into the map signal keyed by keyOf, keeping the entity with the latest
// fetchedAt per key — a stale response can't clobber a fresher one, so "latest wins"
// is a comparison, not a guard flag threaded through callbacks. When a fetch is
// authoritative for a scope (a full load of every repo, not a narrowed subset),
// entities that vanished from that scope are removed, so a repo dropped from config
// (or a branch that's gone) doesn't linger.
export function mergeEntities(mapSignal, entities, keyOf, authoritativeScope = null) {
  const next = new Map(mapSignal());
  for (const e of entities) {
    const k = keyOf(e);
    const cur = next.get(k);
    if (!cur || cur.fetchedAt <= e.fetchedAt) next.set(k, e); // latest wins, per entity
  }
  if (authoritativeScope) {
    const seen = new Set(entities.map(keyOf));
    for (const k of [...next.keys()]) if (authoritativeScope(k) && !seen.has(k)) next.delete(k);
  }
  mapSignal.set(next);
}

export class StorePlugin extends Plugin {
  static sequence = 0; // the shared store — set up before every plugin that reads it

  // ── observed: keyed snapshot maps (every entity carries fetchedAt) ────────────
  repoStatus = signal(new Map()); // repoId → { id, current, dirty, error, branches:[…], fetchedAt }
  prByRepo = signal(new Map()); // repoId → { id, github, error, prs:[PullRequest], fetchedAt }

  // mergebot / runbot are already plain key→value maps; kept as objects so the many
  // `store.mergebot()[key]` reads across the components stay unchanged. One shared copy.
  mergebot = signal({}); // "github#number" → state ("" | "merged" | reason)
  mbDetails = signal({}); // "github#number" → blocked-reason detail (e.g. "Review, CI")
  runbot = signal({}); // branch name → runbot status

  // in-flight keys, shared across the Code + Reviews screens so they never double-fetch
  mbPending = new Set();
  rbPending = new Set();

  // ── runtime: one servers map (main + worktree odoos), fed by the "server" SSE ──
  servers = signal(new Map()); // "main" | targetId → OdooServer (ServerSnapshot)

  // ── writers — every store write goes through here ─────────────────────────────

  // fold a branch-state fetch into repoStatus. `at` is the request-start timestamp:
  // stamping the snapshot when the read was *requested* (not when it returned) makes
  // "latest wins" order a full scan behind a targeted refresh that raced it — the
  // targeted read reflects fresher on-disk state, so it must win for its repos while
  // the full scan still updates every other repo. A full fetch (authoritative) drops
  // repos that vanished from config.
  mergeRepoStatus(repos, at, { authoritative } = {}) {
    const stamped = repos.map((r) => ({ ...r, fetchedAt: r.fetchedAt ?? at }));
    mergeEntities(this.repoStatus, stamped, (r) => r.id, authoritative ? () => true : null);
  }

  // fold a PR fetch into prByRepo. Authoritative only over the repos it requested
  // (scopeIds), so a narrowed dashboard/target load merges into — rather than replaces
  // — the full list, while a full load still drops repos that left the config.
  mergePrRepos(repos, at, scopeIds) {
    const stamped = repos.map((r) => ({ ...r, fetchedAt: r.fetchedAt ?? at }));
    mergeEntities(
      this.prByRepo,
      stamped,
      (r) => r.id,
      (id) => scopeIds.has(id),
    );
  }

  mergeMergebot(states, details) {
    if (states) this.mergebot.set({ ...this.mergebot(), ...states });
    if (details) this.mbDetails.set({ ...this.mbDetails(), ...details });
  }

  mergeRunbot(states) {
    if (states) this.runbot.set({ ...this.runbot(), ...states });
  }

  // clear the mergebot / runbot maps so a forced refresh re-displays fresh badges
  clearExternal() {
    this.mergebot.set({});
    this.mbDetails.set({});
    this.runbot.set({});
  }

  // ── optimistic local edits (no server round-trip) ─────────────────────────────

  // drop a branch from a repo's snapshot after a local delete, without a refetch
  // (a full reload would re-fetch every branch's runbot badge — pointless here)
  dropBranch(repoId, name) {
    const cur = this.repoStatus().get(repoId);
    if (!cur) return;
    const next = new Map(this.repoStatus());
    next.set(repoId, { ...cur, branches: (cur.branches || []).filter((b) => b.name !== name) });
    this.repoStatus.set(next);
  }

  // mark a PR closed in the view after closing it, without a refetch (the server has
  // already invalidated its PR cache, so the next load reflects it too)
  closePr(github, number) {
    const next = new Map(this.prByRepo());
    for (const [id, repo] of next) {
      if (repo.github !== github) continue;
      next.set(id, {
        ...repo,
        prs: (repo.prs || []).map((p) => (p.number === number ? { ...p, state: "closed" } : p)),
      });
    }
    this.prByRepo.set(next);
  }

  // ── runtime: server snapshots + the derived TargetView join ───────────────────

  // fold one server snapshot into the map, keyed by id. Spread-merge so a partial
  // SSE update (a worktree carrying only state/port) preserves the fields it omits —
  // notably a worktree's client-only `exists`, set once by the /api/worktree/list
  // bootstrap. The "main" snapshot always carries every field, so this is a full
  // replace for it.
  mergeServer(snap) {
    if (!snap || !snap.id) return;
    const next = new Map(this.servers());
    next.set(snap.id, { ...(next.get(snap.id) || {}), ...snap });
    this.servers.set(next);
  }

  // forget a server entry (a worktree removed from config)
  dropServer(id) {
    if (!this.servers().has(id)) return;
    const next = new Map(this.servers());
    next.delete(id);
    this.servers.set(next);
  }

  server(id) {
    return this.servers().get(id) || null;
  }

  // the server backing a target: the main process when it's running this target,
  // otherwise the target's own worktree server (or null)
  serverFor(tgt) {
    const main = this.servers().get("main");
    if (main && main.target === tgt.id && (main.state === "running" || main.state === "starting")) {
      return main;
    }
    return this.servers().get(tgt.id) || null;
  }

  // the aggregate the UI orbits: a target joined with its checkouts' live git state
  // (current branch, does it match, dirty) and its server. db/run/claude are filled
  // in a later step (they need the observed-databases store and the Run model).
  targetView(tgt) {
    const rs = this.repoStatus();
    const checkouts = (tgt.checkouts || []).map(({ repo, branch }) => {
      const st = rs.get(repo);
      const current = st ? st.current : undefined;
      return { repo, branch, current, matches: current === branch, dirty: !!(st && st.dirty) };
    });
    return {
      target: tgt,
      checkouts,
      server: this.serverFor(tgt),
      db: null,
      run: null,
      claude: null,
    };
  }

  // ── array views for the existing per-repo iterators ───────────────────────────
  repoStatusList() {
    return [...this.repoStatus().values()];
  }

  prReposList() {
    return [...this.prByRepo().values()];
  }
}
