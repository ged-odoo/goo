// Branches & PRs across repos: grouped view model and the per-branch actions
// (delete, close PR, push).

import { DEFAULT_CONFIG, BASE_BRANCH_RE } from "./config.js";
import { repoUrls } from "./config_models.js";
import { ConfigPlugin } from "./config_plugin.js";
import { StorePlugin } from "./store_plugin.js";
import { EventLogPlugin } from "./event_log_plugin.js";
import { DialogPlugin } from "./dialog_plugin.js";
import { postJSON } from "./utils.js";
import { PullRequest, branchKey } from "./models.js";

import { Plugin, usePlugin, signal, computed } from "@odoo/owl";

const PRS_CACHE_KEY = "oo-prs-cache";
const WORKSPACE_REFRESH_TTL = 10 * 60 * 1000;

export class CodePlugin extends Plugin {
  static sequence = 3;

  config = usePlugin(ConfigPlugin);
  store = usePlugin(StorePlugin); // the shared observed store (branches/PRs/runbot/mergebot)
  eventLog = usePlugin(EventLogPlugin);
  dialogs = usePlugin(DialogPlugin);
  // observed state lives in the store, normalized by identity; these expose it in the
  // shapes the components already read — array views over the keyed maps, and the
  // shared runbot/mergebot signals (the same maps the Reviews screen reads).
  branchRepos = computed(() => this.store.repoStatusList());
  prRepos = computed(() => this.store.prReposList());
  mergebot = this.store.mergebot; // "github#number" -> mergebot state (one shared copy)
  mbDetails = this.store.mbDetails; // "github#number" -> blocked-reason detail
  mbForwardPorts = this.store.mbForwardPorts; // "github#number" -> subsequent branch rows
  runbot = this.store.runbot; // branch name -> runbot status
  at = signal((this._cache() || {}).at || 0);
  // branchKey -> a PR resolved by head ref (forward ports / colleagues' PRs the
  // authored `prs()` fetch misses), or null once looked up and none was found (so
  // we don't re-ask). Overlaid onto the authored prIndex in `_groups()`.
  headPrs = signal({});
  loading = signal(false);
  error = signal("");
  busy = signal(false);
  // repo id -> count of slow git operations in flight (branch create incl. its
  // remote fetch, checkout, rebase) — drives the Code tab's per-card "working…"
  // chip so a long fetch doesn't read as a silent failure. Session-local: it
  // tracks the ops THIS browser started.
  working = signal({});
  // one-shot refresh scopes, armed by a forced load(): the next mergebot / runbot
  // fetch re-asks the given keys IN SCOPE (server cache bypassed) instead of only
  // the unknown keys, updating the held records in place — stale-while-revalidate,
  // so the badges never blink out during a refresh. `true` = everything (a
  // full-list refresh); a Set = just those keys (one workspace's refresh must not
  // re-scrape every other workspace's badges). Consumed by the fetch that acts on
  // them, so the have-based dedup (the loop guard) resumes right after.
  _mbRefresh = null; // null | true | Set<"github#number">
  _rbRefresh = null; // null | true | Set<branch name>
  // workspace + repo scope -> its current automatic load. Switching away and back
  // while a request is still running should join it, not start another scan.
  _workspaceLoads = new Map();
  // grouped, sorted view model — recomputed only when its inputs change
  groups = computed(() => this._groups());

  // hydrate the store from the instant-paint cache once, so a reload doesn't flash
  // empty until the branch fetch lands (branches are local git — uncached server-side).
  // The cached snapshots carry an old stamp, so the fresh fetch's later `at` wins.
  setup() {
    const c = this._cache();
    if (c && c.branchRepos) {
      this.store.mergeRepoStatus(c.branchRepos, c.at || 0, { authoritative: false });
    }
  }

  // mergebot state for the given PRs. Only fetch what we don't already hold and
  // isn't already in flight — that `have`-based dedup is what stops the screens'
  // load effects (which re-run when the signal updates) from looping. An armed one-shot
  // refresh widens the batch to the given PRs in scope (held ones included) and asks
  // the server to re-scrape; the held badges stay visible and update in place.
  async loadMergebot(prs) {
    const refresh = this._mbRefresh;
    const inScope = (k) => refresh === true || (refresh instanceof Set && refresh.has(k));
    const have = this.mergebot();
    const forwardPorts = this.mbForwardPorts();
    const todo = prs.filter((p) => {
      const k = `${p.github}#${p.number}`;
      return (inScope(k) || !(k in have) || !(k in forwardPorts)) && !this.store.mbPending.has(k);
    });
    if (!todo.length) return;
    this._mbRefresh = null; // consumed by this batch — dedup resumes when it lands
    const keys = todo.map((p) => `${p.github}#${p.number}`);
    keys.forEach((k) => this.store.mbPending.add(k));
    try {
      const res = await postJSON("/api/mergebot", { prs: todo, refresh: keys.some(inScope) });
      // don't pin blanks: a state the scrape couldn't produce (fresh PR not yet
      // indexed, transient mergebot failure) must stay re-askable — a stored ""
      // satisfies the `k in have` dedup forever and permanently blanks the badge
      // for the session (the server likewise doesn't cache 404/transient blanks)
      const states = Object.fromEntries(Object.entries(res.states || {}).filter(([, v]) => v));
      const details = Object.fromEntries(
        Object.entries(res.details || {}).filter(([k]) => k in states),
      );
      // During a hot frontend reload an already-running older Goo backend may not
      // expose forward_ports yet. Mark those states as hydrated-with-no-rows so the
      // effect does not repeatedly call that old endpoint until Goo is restarted.
      const rawForwardPorts =
        res.forward_ports ?? Object.fromEntries(Object.keys(states).map((k) => [k, []]));
      const forwardPorts = Object.fromEntries(
        Object.entries(rawForwardPorts).filter(([k]) => k in states),
      );
      this.store.mergeMergebot(states, details, forwardPorts);
    } catch {
      /* leave states blank on failure */
    } finally {
      keys.forEach((k) => this.store.mbPending.delete(k));
    }
  }

  // runbot status for the given branches — same dedup + one-shot refresh as
  // loadMergebot
  async loadRunbot(branches) {
    const refresh = this._rbRefresh;
    const inScope = (b) => refresh === true || (refresh instanceof Set && refresh.has(b));
    const have = this.runbot();
    const todo = branches.filter(
      (b) => (inScope(b) || !(b in have)) && !this.store.rbPending.has(b),
    );
    if (!todo.length) return;
    this._rbRefresh = null; // consumed by this batch
    todo.forEach((b) => this.store.rbPending.add(b));
    try {
      const res = await postJSON("/api/runbot", { branches: todo, refresh: todo.some(inScope) });
      this.store.mergeRunbot(res.states);
    } catch {
      /* leave status blank on failure */
    } finally {
      todo.forEach((b) => this.store.rbPending.delete(b));
    }
  }

  // widen a one-shot refresh scope with another: `true` (everything) absorbs
  // sets, sets union — an armed scope is never narrowed by a later, smaller one
  _widenScope(cur, next) {
    if (cur === true || next === true) return true;
    if (!cur || !next) return cur || next;
    return new Set([...cur, ...next]);
  }

  // force-refresh the given runbot branches + mergebot PRs: arms the one-shot
  // scopes so both loaders re-ask exactly those keys (server cache bypassed) and
  // update the held records in place — the badges stay visible throughout. Resolves
  // when both re-scrapes have landed (drives the list's refresh spinner).
  async refreshStatuses(branches, prs) {
    this._rbRefresh = this._widenScope(this._rbRefresh, new Set(branches || []));
    this._mbRefresh = this._widenScope(
      this._mbRefresh,
      new Set((prs || []).map((p) => `${p.github}#${p.number}`)),
    );
    await Promise.all([this.loadRunbot(branches || []), this.loadMergebot(prs || [])]);
  }

  reposWithGithub() {
    return this.config.config.repos.map((r) => ({
      ...r,
      github: r.github ?? DEFAULT_CONFIG.repos.find((d) => d.id === r.id)?.github,
    }));
  }

  // a repo added for convenience but outside the odoo CI ecosystem (e.g. odoo/owl):
  // flagged `external` in config, so we skip its mergebot + runbot scrapes (they'd
  // only 404 — those services don't index it). Keyed by the github slug PRs carry.
  isExternalRepo(github) {
    return !!github && !!this.config.config.repos.find((r) => r.github === github)?.external;
  }

  // last-known branches, kept only for an instant first paint on reload (PRs are
  // now server-cached and always fetched fresh, so they're no longer stored here)
  _cache() {
    try {
      const c = JSON.parse(localStorage.getItem(PRS_CACHE_KEY));
      return c && c.at && c.branchRepos ? c : null;
    } catch {
      return null;
    }
  }

  // Branches come from local git (fast, volatile) and PRs/runbot/mergebot are now
  // cached server-side, so we simply request everything and let the backend decide
  // freshness. `force` (the manual Refresh) passes refresh:true to bypass the cache.
  // `prRepoIds` / `branchRepoIds` (Sets) narrow the PR / branch fetches to those repo
  // ids — a screen often only shows a subset of the repos, so there's
  // no point reading the rest: PR fetches hit GitHub, and each branch read is ~8 git
  // subprocesses. null = every repo (the Branches/PRs tabs, which show all).
  // `statusScope` ({branches: Set, prs: Set}) narrows a forced load's runbot/mergebot
  // re-scrape the same way; null = re-ask everything (the full-list refreshers).
  async load(force = false, prRepoIds = null, branchRepoIds = null, statusScope = null) {
    this.loading.set(true);
    this.error.set("");
    // stale-while-revalidate: the held runbot/mergebot badges stay on screen; the
    // armed one-shot scopes make the next fetches re-ask them and update in place
    if (force) {
      this._rbRefresh = this._widenScope(
        this._rbRefresh,
        statusScope ? statusScope.branches : true,
      );
      this._mbRefresh = this._widenScope(this._mbRefresh, statusScope ? statusScope.prs : true);
    }
    const at = Date.now(); // request-start stamp — the freshness of these snapshots
    const repos = this.reposWithGithub();
    const branchReq = branchRepoIds ? repos.filter((r) => branchRepoIds.has(r.id)) : repos;
    const branchesP = postJSON("/api/code/branches", { repos: branchReq })
      .then((b) => {
        // One merge rule: a full scan is authoritative for its scope (repos gone from
        // config are dropped); a narrowed load only merges. A targeted refresh that
        // raced this scan carries a later `at`, so mergeEntities keeps it per-repo
        // while this scan still updates every other repo — no race counter needed.
        this.store.mergeRepoStatus(b.repos, at, { authoritative: !branchRepoIds });
        return true;
      })
      .catch((e) => {
        this.error.set(e.message);
        return false;
      });
    const prReq = repos.filter((r) => r.github && (!prRepoIds || prRepoIds.has(r.id)));
    const scopeIds = new Set(prReq.map((r) => r.id));
    const prsP = postJSON("/api/prs", { repos: prReq, refresh: force })
      .then((p) => {
        // normalize each PR into the canonical shape on ingest (see models.js)
        const normalized = p.repos.map((r) => ({ ...r, prs: (r.prs || []).map(PullRequest.from) }));
        this.store.mergePrRepos(normalized, at, scopeIds);
      })
      .catch((e) => {
        this.error.set(e.message);
      });
    const [ok] = await Promise.all([branchesP, prsP]);
    this.loading.set(false);
    this.at.set(at);
    // keep the instant-paint cache in step with the store's current branch snapshots
    if (ok) {
      const branchRepos = this.store.repoStatusList();
      localStorage.setItem(PRS_CACHE_KEY, JSON.stringify({ at, branchRepos }));
    }
    // branches + authored PRs have landed; resolve the leftover branches (remote,
    // non-base, no authored PR) by head ref so forward-port PRs still show — in the
    // same repo scope as the branch fetch (each lookup is a `gh` call; a one-workspace
    // load must not re-ask every other repo's branches). Fire and forget — they
    // stream into the view as they resolve.
    this.loadHeadPrs(force, branchRepoIds);
  }

  // Look up PRs by head ref for branches an authored `prs()` fetch left without one
  // — forward ports (fw-bot authored) and colleagues' PRs. Only remote, non-base
  // branches with no authored PR are asked, and only once each (null is cached as
  // "looked up, none found") unless force re-asks. `repoIds` (a Set) limits the walk
  // to those repos; null = all. Never triggered from an effect that reads groups(),
  // so updating headPrs can't re-drive a load.
  async loadHeadPrs(force = false, repoIds = null) {
    const prIndex = {};
    for (const repo of this.prRepos()) {
      for (const pr of repo.prs) prIndex[branchKey(repo.id, pr.branch)] = pr;
    }
    const githubByRepo = Object.fromEntries(this.reposWithGithub().map((r) => [r.id, r.github]));
    const have = this.headPrs();
    const seen = new Set();
    const pairs = [];
    for (const repo of this.branchRepos()) {
      if (repoIds && !repoIds.has(repo.id)) continue;
      const github = githubByRepo[repo.id];
      if (!github) continue;
      for (const b of repo.branches) {
        if (!b.remote || BASE_BRANCH_RE.test(b.name)) continue;
        const key = branchKey(repo.id, b.name);
        if (prIndex[key] || (!force && key in have)) continue;
        const ghKey = `${github}#${b.name}`;
        if (seen.has(ghKey)) continue;
        seen.add(ghKey);
        pairs.push({ id: repo.id, github, branch: b.name });
      }
    }
    if (!pairs.length) return;
    try {
      const data = await postJSON("/api/prs/for-branches", {
        branches: pairs.map((p) => ({ github: p.github, branch: p.branch })),
        refresh: force,
      });
      const byGhBranch = {};
      for (const raw of data.prs || [])
        byGhBranch[`${raw.github}#${raw.branch}`] = PullRequest.from(raw);
      const next = { ...this.headPrs() };
      for (const p of pairs) {
        // null marks "looked up, none found" so the dedup guard won't re-ask
        next[branchKey(p.id, p.branch)] = byGhBranch[`${p.github}#${p.branch}`] || null;
      }
      this.headPrs.set(next);
    } catch (e) {
      this.error.set(e.message);
    }
  }

  // The last time every piece of a workspace's code view was refreshed. A workspace
  // is only as fresh as its oldest requested repo snapshot; repos with a GitHub slug
  // need both their local branch state and PR state. Deriving this from the normalized
  // store also lets a list-wide or another screen's load satisfy the workspace cache.
  workspaceRefreshedAt(repoIds) {
    const ids = repoIds instanceof Set ? repoIds : new Set(repoIds || []);
    if (!ids.size) return 0;
    const branches = new Map(this.branchRepos().map((r) => [r.id, r.fetchedAt || 0]));
    const prs = new Map(this.prRepos().map((r) => [r.id, r.fetchedAt || 0]));
    const githubIds = new Set(
      this.reposWithGithub()
        .filter((r) => ids.has(r.id) && r.github)
        .map((r) => r.id),
    );
    const stamps = [];
    for (const id of ids) {
      const branchAt = branches.get(id);
      if (!branchAt) return 0;
      stamps.push(branchAt);
      if (githubIds.has(id)) {
        const prAt = prs.get(id);
        if (!prAt) return 0;
        stamps.push(prAt);
      }
    }
    return Math.min(...stamps);
  }

  // Selection-driven workspace loads are cache-aware for ten minutes. Manual
  // Refresh passes force=true and always bypasses this frontend freshness guard
  // (and the backend's PR cache through load()).
  loadWorkspace(workspaceId, repoIds, force = false, statusScope = null) {
    const ids = repoIds instanceof Set ? repoIds : new Set(repoIds || []);
    const refreshedAt = this.workspaceRefreshedAt(ids);
    if (!force && refreshedAt && Date.now() - refreshedAt < WORKSPACE_REFRESH_TTL) {
      return Promise.resolve(false);
    }
    const key = `${workspaceId}:${JSON.stringify([...ids].sort())}`;
    const pending = this._workspaceLoads.get(key);
    // A manual refresh made during an automatic request must still force a second
    // load after it; ordinary selection changes can simply share the pending one.
    if (pending)
      return force
        ? pending.then(() => this.loadWorkspace(workspaceId, ids, true, statusScope))
        : pending;
    const request = this.load(force, ids, ids, statusScope)
      .then(() => true)
      .finally(() => {
        if (this._workspaceLoads.get(key) === request) {
          this._workspaceLoads.delete(key);
        }
      });
    this._workspaceLoads.set(key, request);
    return request;
  }

  // fetch just the local branch/checkout state (no PRs, runbot or mergebot),
  // optionally scoped to a set of repo ids. For a screen that needs checkout/dirty
  // state on demand but never shows PRs — the Targets kebab. Leaves the PR/runbot/
  // mergebot signals untouched (unlike load(), which also refetches those).
  async loadBranches(branchRepoIds = null) {
    const repos = this.reposWithGithub();
    const req = branchRepoIds ? repos.filter((r) => branchRepoIds.has(r.id)) : repos;
    const at = Date.now();
    try {
      const b = await postJSON("/api/code/branches", { repos: req });
      // merge when narrowed (a scoped load reads a single workspace's repos): must
      // not clobber the other repos' branch state that the workspaces/branches rely on
      this.store.mergeRepoStatus(b.repos, at, { authoritative: !branchRepoIds });
    } catch (e) {
      this.error.set(e.message);
    }
  }

  // re-read branch state for just the given repo ids (a Set) and MERGE it into the
  // current view, leaving every other repo's still-valid data in place. For ops that
  // only touch a subset of repos — a target's checkout, a (per-repo or "all") rebase
  // — so we don't re-scan every clone. Like loadBranches it leaves PR/runbot/mergebot
  // untouched: a local checkout/rebase changes the working tree, not the PRs.
  async refreshBranches(repoIds) {
    const repos = this.reposWithGithub().filter((r) => repoIds.has(r.id));
    if (!repos.length) return;
    const at = Date.now();
    try {
      const b = await postJSON("/api/code/branches", { repos });
      this.store.mergeRepoStatus(b.repos, at, { authoritative: false }); // only these changed
      // keep the instant-paint cache in step, so a reload right after doesn't flash
      // the pre-checkout branch for the repos we just refreshed
      const cache = this._cache();
      if (cache) {
        const branchRepos = this.store.repoStatusList();
        localStorage.setItem(PRS_CACHE_KEY, JSON.stringify({ ...cache, branchRepos }));
      }
    } catch (e) {
      this.error.set(e.message);
    }
  }

  _groups() {
    const repos = this.reposWithGithub();
    const githubByRepo = Object.fromEntries(repos.map((r) => [r.id, r.github]));
    const pathByRepo = Object.fromEntries(repos.map((r) => [r.id, r.path]));
    const pullRemoteByRepo = Object.fromEntries(repos.map((r) => [r.id, r.pull_remote]));
    const pushRemoteByRepo = Object.fromEntries(repos.map((r) => [r.id, r.push_remote]));
    // the push remote's actual resolved fork ("owner/repo"), from live git state
    // (see GitService.branches / RepoStatus) — not to be confused with
    // pushRemoteByRepo above, which is just the configured git remote *name*
    const pushGithubByRepo = Object.fromEntries(
      this.branchRepos().map((r) => [r.id, r.pushGithub || null]),
    );
    const prIndex = {};
    for (const repo of this.prRepos()) {
      for (const pr of repo.prs) prIndex[branchKey(repo.id, pr.branch)] = pr;
    }
    // supplement with head-ref lookups, but never shadow an authored PR
    const headPrs = this.headPrs();
    for (const [key, pr] of Object.entries(headPrs)) {
      if (pr && !prIndex[key]) prIndex[key] = pr;
    }
    const map = new Map();
    for (const repo of this.branchRepos()) {
      for (const b of repo.branches) {
        if (!map.has(b.name)) map.set(b.name, []);
        map.get(b.name).push({
          repo: repo.id,
          date: b.date,
          runbot: b.runbot,
          remote: b.remote,
          checkedOut: b.name === repo.current,
        });
      }
    }
    return {
      githubByRepo,
      pathByRepo,
      pullRemoteByRepo,
      pushRemoteByRepo,
      pushGithubByRepo,
      prIndex,
      errors: this.prRepos().filter((r) => r.error),
      list: [...map.entries()]
        .map(([branch, rows]) => {
          let activity = 0;
          for (const r of rows) {
            activity = Math.max(activity, Date.parse(r.date) || 0);
            const pr = prIndex[`${r.repo}:${branch}`];
            if (pr) activity = Math.max(activity, Date.parse(pr.updatedAt) || 0);
          }
          return {
            branch,
            rows,
            activity,
            base: BASE_BRANCH_RE.test(branch),
            runbot: rows.map((r) => r.runbot).find(Boolean) || "",
          };
        })
        .sort((a, b) => a.base - b.base || b.activity - a.activity),
    };
  }

  // GitHub / mergebot URL helpers. The logic lives on the Repository model (via the
  // shared repoUrls builders); these resolve the repo by slug and delegate, falling
  // back to the bare-slug builder for a reviewed PR from a repo that isn't in config.
  // `repoId` resolves the push remote's actual fork (see pushGithubByRepo) — without
  // it (or before that repo's first branches() read completes) these fall back to
  // repoUrls' own hardcoded-org guess.
  prCreateUrl(repoId, github, branch) {
    const pushSlug = this.groups().pushGithubByRepo[repoId];
    return (
      this.config.repoByGithub(github)?.compareUrl(branch, pushSlug) ??
      repoUrls.compare(github, branch, pushSlug)
    );
  }

  forkBranchUrl(repoId, github, branch) {
    const pushSlug = this.groups().pushGithubByRepo[repoId];
    return (
      this.config.repoByGithub(github)?.forkBranchUrl(branch, pushSlug) ??
      repoUrls.fork(github, branch, pushSlug)
    );
  }

  remoteBranchUrl(repoId, github, branch) {
    const pushSlug = this.groups().pushGithubByRepo[repoId];
    return (
      this.config.repoByGithub(github)?.remoteBranchUrl(branch, pushSlug) ??
      repoUrls.remote(github, branch, pushSlug)
    );
  }

  mergebotUrl(github, number) {
    return (
      this.config.repoByGithub(github)?.mergebotUrl(number) ?? repoUrls.mergebot(github, number)
    );
  }

  pullRequestUrl(github, number) {
    return (
      this.config.repoByGithub(github)?.pullRequestUrl(number) ??
      repoUrls.pullRequest(github, number)
    );
  }

  async postRPlus(github, number) {
    this.eventLog.add(`posting robodoo r+ on PR #${number} (${github})`);
    try {
      await postJSON("/api/prs/r-plus", { repo: github, number });
      this.eventLog.add(`posted robodoo r+ on PR #${number} (${github})`);
      return true;
    } catch (e) {
      this.eventLog.add(`posting r+ failed: ${github}#${number} — ${e.message}`, "", "error");
      this._errorDialog("Post r+ failed", e.message);
      return false;
    }
  }

  // the configured remotes for the repo at <path> (never blank — repoData normalizes)
  _pullRemote(path) {
    return this.config.config.repos.find((r) => r.path === path)?.pull_remote || "origin";
  }

  _pushRemote(path) {
    return this.config.config.repos.find((r) => r.path === path)?.push_remote || "dev";
  }

  async remoteExists(path, branch) {
    const res = await postJSON("/api/code/branch/remote", {
      path,
      branch,
      push_remote: this._pushRemote(path),
    });
    return res.exists;
  }

  // last commits on a branch (ref; defaults to the repo's current branch). `base`
  // (the branch's own base, e.g. "master") + `pullRemote` make each commit carry
  // an "ahead" flag — reachable from ref but not the base branch, i.e. unique to
  // this branch and so safe to reword (see rewordCommit).
  async commits(path, ref = "", { base = "", pullRemote = "" } = {}) {
    const res = await postJSON("/api/code/log", { path, ref, base, pull_remote: pullRemote });
    if (!res.ok) throw new Error(res.error || "git log failed");
    return res.commits;
  }

  // the full message (subject + body) of a single commit — ref defaults to HEAD.
  // Checkout rows only ever carry the subject line (branches()/log's summaries never
  // fetch the body up front, since most commits are never opened for editing) — this
  // is the on-demand fetch for the edit/amend dialogs' prefill, so a multi-line
  // message isn't silently truncated to its first line. "" if the commit isn't found.
  async commitMessage(path, ref = "") {
    const [head] = await this.commits(path, ref);
    if (!head) return "";
    return head.body ? `${head.subject}\n\n${head.body}` : head.subject;
  }

  // surface a failure in the app's error dialog (scrollable, styled) rather than a
  // native alert() — git errors like "already checked out at <worktree>" can be long
  _errorDialog(title, message) {
    this.dialogs.open({
      title,
      message,
      cls: "dialog-error",
      okLabel: "OK",
      cancelLabel: null,
    });
  }

  async _mutate(label, fn, reload = true) {
    this.busy.set(true);
    try {
      await fn();
      if (reload) await this.load(true);
    } catch (e) {
      this._errorDialog(`${label} failed`, e.message);
    } finally {
      this.busy.set(false);
    }
  }

  // checkout the given {repo, path, branch} in each repo, then re-read branch state
  // for just those repos. A checkout only changes their local working tree, so we
  // refresh only them (merging into the view) and leave every other repo alone —
  // and PRs (keyed by head branch), runbot (by branch) and mergebot (by PR) are
  // unaffected, so we keep those from the cache (the screens lazily fill any new).
  async checkout(repos) {
    const ids = [...new Set(repos.map((r) => r.repo).filter(Boolean))];
    this.busy.set(true);
    this._beginWork(ids);
    try {
      const res = await postJSON("/api/code/checkout", { repos });
      const failed = (res.results || []).filter((r) => !r.ok);
      if (failed.length)
        this._errorDialog(
          "Checkout failed",
          failed.map((r) => `${r.branch}: ${r.error}`).join("\n"),
        );
      await (ids.length ? this.refreshBranches(new Set(ids)) : this.load(false));
    } catch (e) {
      this._errorDialog("Checkout failed", e.message);
    } finally {
      this._endWork(ids);
      this.busy.set(false);
    }
  }

  // fetch each repo's base branch from its canonical repo and rebase onto it, then
  // re-read branch state for just those repos. A rebase changes only their local
  // commits (head sha, ahead/behind, pushed-state), so we refresh only them; the PR
  // list / runbot / mergebot reflect the pushed branch, which a local rebase hasn't
  // touched, so we leave those as-is rather than re-querying everything.
  async rebase(repos) {
    const ids = [...new Set(repos.map((r) => r.repo).filter(Boolean))];
    const { pullRemoteByRepo } = this.groups();
    repos = repos.map((r) => ({ ...r, pull_remote: pullRemoteByRepo[r.repo] }));
    this.busy.set(true);
    this._beginWork(ids);
    // the backend logs each repo's fetch then rebase phase as it happens (via SSE
    // events), so there's nothing to pre-log here
    try {
      const res = await postJSON("/api/code/rebase", { repos });
      const failed = (res.results || []).filter((r) => !r.ok);
      if (failed.length) {
        for (const f of failed)
          this.eventLog.add(`fetch & rebase failed: ${f.repo} — ${f.error}`, "", "error");
        this._errorDialog(
          "Fetch & rebase failed",
          failed.map((r) => `${r.repo}: ${r.error}`).join("\n"),
        );
      }
      await (ids.length ? this.refreshBranches(new Set(ids)) : this.load(true));
    } catch (e) {
      this.eventLog.add(`fetch & rebase failed: ${e.message}`, "", "error");
      this._errorDialog("Fetch & rebase failed", e.message);
    } finally {
      this._endWork(ids);
      this.busy.set(false);
    }
  }

  // drop a branch from the view + cache without a server round-trip — a full
  // reload would re-fetch every branch's runbot badge, which is pointless here
  _dropBranch(repo, branch) {
    this.store.dropBranch(repo, branch);
    const cache = this._cache();
    if (cache) {
      const branchRepos = this.store.repoStatusList();
      localStorage.setItem(PRS_CACHE_KEY, JSON.stringify({ ...cache, branchRepos }));
    }
  }

  async deleteBranch(branch, repo, path, deleteRemote = false) {
    const scope = deleteRemote ? `locally and on the ${this._pushRemote(path)} remote` : "locally";
    const ok = await this.dialogs.open({
      title: `Force-delete branch "${branch}" in ${repo}?`,
      message: `This deletes the branch ${scope}. This cannot be undone.`,
      okLabel: "Delete branch",
    });
    if (!ok) return;
    return this.deleteBranchNoConfirm(branch, repo, path, deleteRemote);
  }

  // delete a branch without prompting — the caller has already confirmed (e.g.
  // a single confirmation dialog covering several branches / PRs at once)
  deleteBranchNoConfirm(branch, repo, path, deleteRemote = false) {
    return this._mutate(
      "Delete",
      async () => {
        this.eventLog.add(`deleting branch ${branch} (${repo})`);
        const res = await postJSON("/api/code/branches/delete", {
          path,
          branch,
          delete_remote: deleteRemote,
          push_remote: this._pushRemote(path),
        });
        if (res.remote_error)
          this.dialogs.open({
            title: "Remote branch not deleted",
            message: `The local branch was deleted, but the remote branch could not be removed:\n\n${res.remote_error}`,
            cls: "dialog-error",
            okLabel: "OK",
            cancelLabel: null,
          });
        this._dropBranch(repo, branch);
      },
      false,
    );
  }

  // create one or more branches in parallel (each at its own start point) without
  // checking any out, then re-read branch state for just the affected repos. Creating
  // a local branch never touches PRs/runbot/mergebot, so we skip that whole refresh
  // (the slow part) and never run the per-branch creates back-to-back.
  // specs: [{ path, name, startPoint, freshStart? }]. freshStart asks the backend
  // to prefer a freshly fetched canonical-remote branch over the local start point.
  // per-repo in-flight bookkeeping for the slow git operations (counted, so
  // overlapping operations on one repo keep the flag up until the last one ends)
  _beginWork(ids) {
    const w = { ...this.working() };
    for (const id of ids) w[id] = (w[id] || 0) + 1;
    this.working.set(w);
  }

  _endWork(ids) {
    const w = { ...this.working() };
    for (const id of ids) {
      if ((w[id] = (w[id] || 1) - 1) <= 0) delete w[id];
    }
    this.working.set(w);
  }

  // is a slow git operation (branch create/fetch, checkout, rebase) running for
  // this repo in this session?
  repoWorking(id) {
    return !!this.working()[id];
  }

  async createBranches(specs) {
    const repoByPath = new Map(this.config.config.repos.map((r) => [r.path, r]));
    const branches = (specs || [])
      .filter((s) => s.path && s.name && repoByPath.has(s.path))
      .map((s) => {
        const repo = repoByPath.get(s.path);
        return {
          path: s.path,
          name: s.name,
          start_point: s.startPoint,
          fresh_start: !!s.freshStart,
          pull_remote: repo.pull_remote,
          repo: repo.id,
        };
      });
    if (!branches.length) return;
    const ids = [...new Set(branches.map((b) => b.repo))];
    this.busy.set(true);
    this._beginWork(ids);
    try {
      for (const b of branches) {
        const repo = repoByPath.get(b.path);
        this.eventLog.add(`creating branch ${b.name}${repo ? ` (${repo.id})` : ""}`);
      }
      const res = await postJSON("/api/code/branches/create", { branches });
      const failed = (res.results || []).filter((r) => !r.ok);
      if (failed.length)
        this._errorDialog(
          "Create branch failed",
          failed.map((r) => `${r.name}: ${r.error}`).join("\n"),
        );
      await this.refreshBranches(new Set(ids));
    } catch (e) {
      this._errorDialog("Create branch failed", e.message);
    } finally {
      this._endWork(ids);
      this.busy.set(false);
    }
  }

  // create a single branch at <startPoint> without checking it out
  createBranch(path, name, startPoint) {
    return this.createBranches([{ path, name, startPoint }]);
  }

  // optimistically mark a PR closed in the view, no reload (which would re-fetch
  // everything just to flip one PR's state). The server already invalidated its PR
  // cache in close_pr, so the next load reflects it too.
  _closePrLocally(github, number) {
    this.store.closePr(github, number);
  }

  async closePr(github, number) {
    const ok = await this.dialogs.open({
      title: `Close PR #${number} in ${github}?`,
      okLabel: "Close PR",
    });
    if (!ok) return;
    return this.closePrNoConfirm(github, number);
  }

  // close a PR without prompting — caller has already confirmed
  closePrNoConfirm(github, number) {
    return this._mutate(
      "Close PR",
      async () => {
        this.eventLog.add(`closing PR #${number} (${github})`);
        await postJSON("/api/prs/close", { repo: github, number });
        this._closePrLocally(github, number);
      },
      false,
    );
  }

  // commit / discard the working tree. On failure the event log records the
  // failure and the error is surfaced in a (scrollable) dialog — opened by the
  // plugin itself via the DialogPlugin, no component involvement needed.
  // open a repo's working directory in the configured editor (default "code");
  // no git mutation, so no busy/reload — just fire the launch (only failures log)
  openEditor(path, repo) {
    return this.openEditorPaths([path], repo);
  }

  // open one or more repo folders in the configured editor — passing several dirs
  // opens them in a single window (`code repo1 repo2`). `label` names them in logs.
  async openEditorPaths(paths, label) {
    const editor = (this.config.config.editor || "code").trim();
    try {
      await postJSON("/api/open-editor", { editor, paths });
    } catch (e) {
      this.eventLog.add(`open with editor failed (${label}): ${e.message}`, "", "error");
      this.dialogs.open({
        title: "Could not open the editor",
        message: e.message,
        cls: "dialog-error",
        okLabel: "OK",
        cancelLabel: null,
      });
    }
  }

  async wipCommit(path, repo) {
    this.busy.set(true);
    try {
      this.eventLog.add(`WIP commit (${repo})`);
      await postJSON("/api/code/wip-commit", { path });
      // a WIP commit is local-only (not pushed) — refresh this repo's branch state
      // (dirty flag, ahead count, synced state) and leave PRs/runbot/mergebot as-is
      await this.refreshBranches(new Set([repo]));
    } catch (e) {
      this.eventLog.add(`WIP commit failed (${repo})`);
      this.dialogs.open({
        title: "WIP commit failed",
        message: e.message,
        cls: "dialog-error",
        okLabel: "OK",
        cancelLabel: null,
      });
    } finally {
      this.busy.set(false);
    }
  }

  // stage all changes and commit with a user-supplied message (see
  // dialogs.js's editCommitMessage — the "Commit" menu action's caller)
  async commit(path, repo, message) {
    this.busy.set(true);
    try {
      this.eventLog.add(`commit (${repo})`);
      await postJSON("/api/code/commit", { path, message });
      await this.refreshBranches(new Set([repo]));
    } catch (e) {
      this.eventLog.add(`commit failed (${repo})`);
      this.dialogs.open({
        title: "Commit failed",
        message: e.message,
        cls: "dialog-error",
        okLabel: "OK",
        cancelLabel: null,
      });
    } finally {
      this.busy.set(false);
    }
  }

  // stage all changes and fold them into the HEAD commit with a (possibly
  // edited) message — git commit --amend (see dialogs.js's editCommitMessage —
  // the "Amend commit" menu action's caller)
  async amendCommit(path, repo, message) {
    this.busy.set(true);
    try {
      this.eventLog.add(`amend commit (${repo})`);
      await postJSON("/api/code/amend", { path, message });
      await this.refreshBranches(new Set([repo]));
    } catch (e) {
      this.eventLog.add(`amend commit failed (${repo})`);
      this.dialogs.open({
        title: "Amend commit failed",
        message: e.message,
        cls: "dialog-error",
        okLabel: "OK",
        cancelLabel: null,
      });
    } finally {
      this.busy.set(false);
    }
  }

  // rewrite an existing commit's message (CommitsDialog's edit affordance —
  // only ever offered for commits already flagged "ahead" of the base branch,
  // and the backend re-checks that itself before touching anything). Throws on
  // failure — the caller (CommitsDialog) owns showing that error, since it needs
  // to keep its own dialog open rather than this cutting straight to a generic one.
  async rewordCommit(path, sha, message, { base = "", pullRemote = "" } = {}) {
    const res = await postJSON("/api/code/reword", {
      path,
      sha,
      message,
      base,
      pull_remote: pullRemote,
    });
    if (!res.ok) throw new Error(res.error || "git reword failed");
  }

  async discard(path, repo) {
    const ok = await this.dialogs.open({
      title: `Discard changes in ${repo}?`,
      message:
        "This permanently removes all uncommitted changes, including untracked files. This cannot be undone.",
      okLabel: "Discard changes",
    });
    if (!ok) return;
    this.busy.set(true);
    try {
      this.eventLog.add(`discarding changes (${repo})`);
      await postJSON("/api/code/discard", { path });
      // discard only touches the working tree — refresh this repo's local branch
      // state (clears its dirty flag) and leave PRs/runbot/mergebot as-is
      await this.refreshBranches(new Set([repo]));
    } catch (e) {
      this.eventLog.add(`discard failed (${repo})`);
      this.dialogs.open({
        title: "Discard changes failed",
        message: e.message,
        cls: "dialog-error",
        okLabel: "OK",
        cancelLabel: null,
      });
    } finally {
      this.busy.set(false);
    }
  }

  // push a branch to the dev remote without prompting — caller has confirmed
  // (via the app modal) before calling
  pushBranchNoConfirm(path, branch, reload = true, force = false) {
    const repo = this.config.config.repos.find((r) => r.path === path);
    return this._mutate(
      force ? "Force push" : "Push",
      async () => {
        const verb = force ? "force-pushing" : "pushing";
        this.eventLog.add(`${verb} ${branch}${repo ? ` (${repo.id})` : ""} to GitHub`);
        await postJSON("/api/code/branch/push", {
          path,
          branch,
          force,
          push_remote: repo?.push_remote || "dev",
        });
        // a push only flips this repo's remote-tracking/synced state — refresh just
        // that branch row, not every repo's PRs/runbot/mergebot
        if (reload && repo) await this.refreshBranches(new Set([repo.id]));
      },
      false, // never the _mutate full reload — refreshBranches above is enough
    );
  }
}
