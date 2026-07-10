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

import { Plugin, plugin, signal, computed } from "@odoo/owl";

const PRS_CACHE_KEY = "oo-prs-cache";

export class CodePlugin extends Plugin {
  static sequence = 3;

  config = plugin(ConfigPlugin);
  store = plugin(StorePlugin); // the shared observed store (branches/PRs/runbot/mergebot)
  eventLog = plugin(EventLogPlugin);
  dialogs = plugin(DialogPlugin);
  // observed state lives in the store, normalized by identity; these expose it in the
  // shapes the components already read — array views over the keyed maps, and the
  // shared runbot/mergebot signals (the same maps the Reviews screen reads).
  branchRepos = computed(() => this.store.repoStatusList());
  prRepos = computed(() => this.store.prReposList());
  mergebot = this.store.mergebot; // "github#number" -> mergebot state (one shared copy)
  mbDetails = this.store.mbDetails; // "github#number" -> blocked-reason detail
  runbot = this.store.runbot; // branch name -> runbot status
  at = signal((this._cache() || {}).at || 0);
  loading = signal(false);
  error = signal("");
  busy = signal(false);
  // repo id -> count of slow git operations in flight (branch create incl. its
  // remote fetch, checkout, rebase) — drives the Code tab's per-card "working…"
  // chip so a long fetch doesn't read as a silent failure. Session-local: it
  // tracks the ops THIS browser started.
  working = signal({});
  // one-shot refresh flags, armed by a forced load(): the next mergebot / runbot
  // fetch re-asks EVERYTHING it's given (server cache bypassed) instead of only the
  // unknown keys, updating the held records in place — stale-while-revalidate, so
  // the badges never blink out during a refresh. Consumed by the fetch that acts on
  // them, so the have-based dedup (the loop guard) resumes right after.
  _mbRefresh = false;
  _rbRefresh = false;
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
  // refresh widens the batch to every given PR (held ones included) and asks the
  // server to re-scrape; the held badges stay visible and update in place.
  async loadMergebot(prs) {
    const refresh = this._mbRefresh;
    const have = this.mergebot();
    const todo = prs.filter((p) => {
      const k = `${p.github}#${p.number}`;
      return (refresh || !(k in have)) && !this.store.mbPending.has(k);
    });
    if (!todo.length) return;
    this._mbRefresh = false; // consumed by this batch — dedup resumes when it lands
    const keys = todo.map((p) => `${p.github}#${p.number}`);
    keys.forEach((k) => this.store.mbPending.add(k));
    try {
      const res = await postJSON("/api/mergebot", { prs: todo, refresh });
      // don't pin blanks: a state the scrape couldn't produce (fresh PR not yet
      // indexed, transient mergebot failure) must stay re-askable — a stored ""
      // satisfies the `k in have` dedup forever and permanently blanks the badge
      // for the session (the server likewise doesn't cache 404/transient blanks)
      const states = Object.fromEntries(Object.entries(res.states || {}).filter(([, v]) => v));
      const details = Object.fromEntries(
        Object.entries(res.details || {}).filter(([k]) => k in states),
      );
      this.store.mergeMergebot(states, details);
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
    const have = this.runbot();
    const todo = branches.filter((b) => (refresh || !(b in have)) && !this.store.rbPending.has(b));
    if (!todo.length) return;
    this._rbRefresh = false; // consumed by this batch
    todo.forEach((b) => this.store.rbPending.add(b));
    try {
      const res = await postJSON("/api/runbot", { branches: todo, refresh });
      this.store.mergeRunbot(res.states);
    } catch {
      /* leave status blank on failure */
    } finally {
      todo.forEach((b) => this.store.rbPending.delete(b));
    }
  }

  // force-refresh the given runbot branches + mergebot PRs: arms the one-shot
  // flags so both loaders re-ask everything (server cache bypassed) and update
  // the held records in place — the badges stay visible throughout. Resolves
  // when both re-scrapes have landed (drives the list's refresh spinner).
  async refreshStatuses(branches, prs) {
    this._mbRefresh = this._rbRefresh = true;
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
  async load(force = false, prRepoIds = null, branchRepoIds = null) {
    this.loading.set(true);
    this.error.set("");
    // stale-while-revalidate: the held runbot/mergebot badges stay on screen; the
    // armed one-shot flags make the next fetches re-ask everything and update in place
    if (force) this._mbRefresh = this._rbRefresh = true;
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
    const prIndex = {};
    for (const repo of this.prRepos()) {
      for (const pr of repo.prs) prIndex[branchKey(repo.id, pr.branch)] = pr;
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
  prCreateUrl(github, branch) {
    return this.config.repoByGithub(github)?.compareUrl(branch) ?? repoUrls.compare(github, branch);
  }

  forkBranchUrl(github, branch) {
    return this.config.repoByGithub(github)?.forkBranchUrl(branch) ?? repoUrls.fork(github, branch);
  }

  remoteBranchUrl(github, branch) {
    return (
      this.config.repoByGithub(github)?.remoteBranchUrl(branch) ?? repoUrls.remote(github, branch)
    );
  }

  mergebotUrl(github, number) {
    return (
      this.config.repoByGithub(github)?.mergebotUrl(number) ?? repoUrls.mergebot(github, number)
    );
  }

  async remoteExists(path, branch) {
    const res = await postJSON("/api/code/branch/remote", { path, branch });
    return res.exists;
  }

  // last commits on a branch (ref; defaults to the repo's current branch)
  async commits(path, ref = "") {
    const res = await postJSON("/api/code/log", { path, ref });
    if (!res.ok) throw new Error(res.error || "git log failed");
    return res.commits;
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
    const scope = deleteRemote ? "locally and on the odoo-dev remote" : "locally";
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
          github: repo.github,
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
        await postJSON("/api/code/branch/push", { path, branch, force });
        // a push only flips this repo's remote-tracking/synced state — refresh just
        // that branch row, not every repo's PRs/runbot/mergebot
        if (reload && repo) await this.refreshBranches(new Set([repo.id]));
      },
      false, // never the _mutate full reload — refreshBranches above is enough
    );
  }
}
