// Branches & PRs across repos: grouped view model and the per-branch actions
// (delete, close PR, push).

import { DEFAULT_CONFIG, BASE_BRANCH_RE, RUNBOT, MERGEBOT } from "./config.js";
import { ConfigPlugin } from "./config_plugin.js";
import { EventLogPlugin } from "./event_log_plugin.js";
import { DialogPlugin } from "./dialog_plugin.js";
import { postJSON } from "./utils.js";

const { Plugin, plugin, signal, computed } = owl;

const PRS_CACHE_KEY = "oo-prs-cache";

export class CodePlugin extends Plugin {
  static sequence = 3;

  config = plugin(ConfigPlugin);
  eventLog = plugin(EventLogPlugin);
  dialogs = plugin(DialogPlugin);
  branchRepos = signal((this._cache() || {}).branchRepos || []);
  prRepos = signal([]); // PRs are cached server-side now, fetched fresh each load
  at = signal((this._cache() || {}).at || 0);
  loading = signal(false);
  error = signal("");
  busy = signal(false);
  mergebot = signal({}); // "github#number" -> mergebot state (cached server-side)
  mbDetails = signal({}); // "github#number" -> blocked-reason detail (e.g. "Review, CI")
  runbot = signal({}); // branch name -> runbot status (cached server-side)
  _refreshExternal = false; // true during a forced load: ask the server to bypass its cache
  _mbPending = new Set(); // keys in flight, so the dashboard effect doesn't double-fetch
  _rbPending = new Set();
  // grouped, sorted view model — recomputed only when its inputs change
  groups = computed(() => this._groups());

  // mergebot state for the given PRs. Only fetch what we don't already hold and
  // isn't already in flight — that `have`-based dedup is what stops the dashboard
  // effect (which re-runs when the signal updates) from looping. A forced refresh
  // clears the signal in load() and passes refresh:true so the server re-scrapes.
  async loadMergebot(prs) {
    const refresh = this._refreshExternal;
    const have = this.mergebot();
    const todo = prs.filter((p) => {
      const k = `${p.github}#${p.number}`;
      return !(k in have) && !this._mbPending.has(k);
    });
    if (!todo.length) return;
    const keys = todo.map((p) => `${p.github}#${p.number}`);
    keys.forEach((k) => this._mbPending.add(k));
    try {
      const res = await postJSON("/api/mergebot", { prs: todo, refresh });
      this.mergebot.set({ ...this.mergebot(), ...res.states });
      this.mbDetails.set({ ...this.mbDetails(), ...(res.details || {}) });
    } catch {
      /* leave states blank on failure */
    } finally {
      keys.forEach((k) => this._mbPending.delete(k));
    }
  }

  // runbot status for the given branches — same dedup as loadMergebot
  async loadRunbot(branches) {
    const refresh = this._refreshExternal;
    const have = this.runbot();
    const todo = branches.filter((b) => !(b in have) && !this._rbPending.has(b));
    if (!todo.length) return;
    todo.forEach((b) => this._rbPending.add(b));
    try {
      const res = await postJSON("/api/runbot", { branches: todo, refresh });
      this.runbot.set({ ...this.runbot(), ...res.states });
    } catch {
      /* leave status blank on failure */
    } finally {
      todo.forEach((b) => this._rbPending.delete(b));
    }
  }

  reposWithGithub() {
    return this.config.config.repos.map((r) => ({
      ...r,
      github: r.github ?? DEFAULT_CONFIG.repos.find((d) => d.id === r.id)?.github,
    }));
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
  // ids — the dashboard only shows a subset (its favorite/target repos), so there's
  // no point reading the rest: PR fetches hit GitHub, and each branch read is ~8 git
  // subprocesses. null = every repo (the Branches/PRs/Targets tabs, which show all).
  async load(force = false, prRepoIds = null, branchRepoIds = null) {
    this.loading.set(true);
    this.error.set("");
    this._refreshExternal = force;
    if (force) {
      this.mergebot.set({}); // re-display fresh runbot/mergebot on a real refresh
      this.mbDetails.set({});
      this.runbot.set({});
    }
    const repos = this.reposWithGithub();
    const branchReq = branchRepoIds ? repos.filter((r) => branchRepoIds.has(r.id)) : repos;
    const branchesP = postJSON("/api/code/branches", { repos: branchReq })
      .then((b) => {
        this.branchRepos.set(b.repos);
        return b.repos;
      })
      .catch((e) => {
        this.error.set(e.message);
        return null;
      });
    const prRepos = repos.filter((r) => r.github && (!prRepoIds || prRepoIds.has(r.id)));
    const prsP = postJSON("/api/prs", { repos: prRepos, refresh: force })
      .then((p) => {
        this.prRepos.set(p.repos);
        return p.repos;
      })
      .catch((e) => {
        this.error.set(e.message);
        return null;
      });
    const [b] = await Promise.all([branchesP, prsP]);
    this.loading.set(false);
    const at = Date.now();
    this.at.set(at);
    if (b) localStorage.setItem(PRS_CACHE_KEY, JSON.stringify({ at, branchRepos: b }));
  }

  // fetch just the local branch/checkout state (no PRs, runbot or mergebot),
  // optionally scoped to a set of repo ids. For a screen that needs checkout/dirty
  // state on demand but never shows PRs — the Targets kebab. Leaves the PR/runbot/
  // mergebot signals untouched (unlike load(), which also refetches those).
  async loadBranches(branchRepoIds = null) {
    const repos = this.reposWithGithub();
    const req = branchRepoIds ? repos.filter((r) => branchRepoIds.has(r.id)) : repos;
    try {
      const b = await postJSON("/api/code/branches", { repos: req });
      this.branchRepos.set(b.repos);
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
    try {
      const b = await postJSON("/api/code/branches", { repos });
      const byId = new Map(b.repos.map((r) => [r.id, r]));
      const existing = this.branchRepos();
      const merged = existing.map((r) => byId.get(r.id) || r);
      for (const r of b.repos) if (!existing.some((e) => e.id === r.id)) merged.push(r);
      this.branchRepos.set(merged);
      // keep the instant-paint cache in step, so a reload right after doesn't flash
      // the pre-checkout branch for the repos we just refreshed
      const cache = this._cache();
      if (cache) localStorage.setItem(PRS_CACHE_KEY, JSON.stringify({ ...cache, branchRepos: merged }));
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
      for (const pr of repo.prs) prIndex[`${repo.id}:${pr.headRefName}`] = pr;
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

  prCreateUrl(github, branch) {
    const base = (/^(saas-\d+\.\d+|\d+\.\d+|master)/.exec(branch) || ["", "master"])[1];
    const name = github.split("/")[1];
    return `https://github.com/${github}/compare/${base}...odoo-dev:${name}:${branch}?expand=1`;
  }

  forkBranchUrl(github, branch) {
    const name = github.split("/")[1];
    return `https://github.com/odoo-dev/${name}/tree/${encodeURIComponent(branch)}`;
  }

  // where a local branch lives remotely: base branches (master, 19.0, saas-x.y)
  // are on the canonical repo; work branches are pushed to the odoo-dev fork
  remoteBranchUrl(github, branch) {
    if (BASE_BRANCH_RE.test(branch)) {
      return `https://github.com/${github}/tree/${encodeURIComponent(branch)}`;
    }
    return this.forkBranchUrl(github, branch);
  }

  bundleUrl(branch) {
    return `${RUNBOT}/runbot/bundle/${encodeURIComponent(branch)}`;
  }

  // mergebot page for a PR, e.g. https://mergebot.odoo.com/odoo/odoo/pull/269532
  mergebotUrl(github, number) {
    return `${MERGEBOT}/${github}/pull/${number}`;
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

  async _mutate(label, fn, reload = true) {
    this.busy.set(true);
    try {
      await fn();
      if (reload) await this.load(true);
    } catch (e) {
      alert(`${label} failed: ${e.message}`);
    } finally {
      this.busy.set(false);
    }
  }

  // checkout the given {repo, path, branch} in each repo, then re-read branch state
  // for just those repos. A checkout only changes their local working tree, so we
  // refresh only them (merging into the view) and leave every other repo alone —
  // and PRs (keyed by head branch), runbot (by branch) and mergebot (by PR) are
  // unaffected, so we keep those from the cache (the dashboard lazily fills any new).
  async checkout(repos) {
    this.busy.set(true);
    try {
      const res = await postJSON("/api/code/checkout", { repos });
      const failed = (res.results || []).filter((r) => !r.ok);
      if (failed.length)
        alert("Checkout failed:\n" + failed.map((r) => `${r.branch}: ${r.error}`).join("\n"));
      const ids = new Set(repos.map((r) => r.repo).filter(Boolean));
      await (ids.size ? this.refreshBranches(ids) : this.load(false));
    } catch (e) {
      alert(`Checkout failed: ${e.message}`);
    } finally {
      this.busy.set(false);
    }
  }

  // fetch each repo's base branch from its canonical repo and rebase onto it, then
  // re-read branch state for just those repos. A rebase changes only their local
  // commits (head sha, ahead/behind, pushed-state), so we refresh only them; the PR
  // list / runbot / mergebot reflect the pushed branch, which a local rebase hasn't
  // touched, so we leave those as-is rather than re-querying everything.
  async rebase(repos) {
    this.busy.set(true);
    // the backend logs each repo's fetch then rebase phase as it happens (via SSE
    // events), so there's nothing to pre-log here
    try {
      const res = await postJSON("/api/code/rebase", { repos });
      const failed = (res.results || []).filter((r) => !r.ok);
      if (failed.length) {
        for (const f of failed)
          this.eventLog.add(`fetch & rebase failed: ${f.repo} — ${f.error}`, "", "error");
        alert("Fetch & rebase failed:\n" + failed.map((r) => `${r.repo}: ${r.error}`).join("\n"));
      }
      const ids = new Set(repos.map((r) => r.repo).filter(Boolean));
      await (ids.size ? this.refreshBranches(ids) : this.load(true));
    } catch (e) {
      this.eventLog.add(`fetch & rebase failed: ${e.message}`, "", "error");
      alert(`Fetch & rebase failed: ${e.message}`);
    } finally {
      this.busy.set(false);
    }
  }

  // drop a branch from the view + cache without a server round-trip — a full
  // reload would re-fetch every branch's runbot badge, which is pointless here
  _dropBranch(repo, branch) {
    const branchRepos = this.branchRepos().map((r) =>
      r.id === repo ? { ...r, branches: r.branches.filter((b) => b.name !== branch) } : r,
    );
    this.branchRepos.set(branchRepos);
    const cache = this._cache();
    if (cache) localStorage.setItem(PRS_CACHE_KEY, JSON.stringify({ ...cache, branchRepos }));
  }

  deleteBranch(branch, repo, path, deleteRemote = false) {
    const scope = deleteRemote ? "locally and on the odoo-dev remote" : "locally";
    if (!confirm(`Force-delete branch "${branch}" in ${repo} ${scope}? This cannot be undone.`))
      return;
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

  // create a new branch at <startPoint> without checking it out, then reload
  createBranch(path, name, startPoint) {
    const repo = this.config.config.repos.find((r) => r.path === path);
    return this._mutate("Create branch", async () => {
      this.eventLog.add(`creating branch ${name}${repo ? ` (${repo.id})` : ""}`);
      await postJSON("/api/code/branch/create", { path, name, start_point: startPoint });
    });
  }

  // optimistically mark a PR closed in the view, no reload (which would re-fetch
  // everything just to flip one PR's state). The server already invalidated its PR
  // cache in close_pr, so the next load reflects it too.
  _closePrLocally(github, number) {
    const prRepos = this.prRepos().map((r) =>
      r.github === github
        ? { ...r, prs: r.prs.map((p) => (p.number === number ? { ...p, state: "CLOSED" } : p)) }
        : r,
    );
    this.prRepos.set(prRepos);
  }

  closePr(github, number) {
    if (!confirm(`Close PR #${number} in ${github}?`)) return;
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
  // no git mutation, so no busy/reload — just fire the launch and log it
  openEditor(path, repo) {
    return this.openEditorPaths([path], repo);
  }

  // open one or more repo folders in the configured editor — passing several dirs
  // opens them in a single window (`code repo1 repo2`). `label` names them in logs.
  async openEditorPaths(paths, label) {
    const editor = (this.config.config.editor || "code").trim();
    this.eventLog.add(`opening ${label} in ${editor}`);
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
      await this.load(true);
    } catch (e) {
      this.eventLog.add(`WIP commit failed (${repo})`);
      this.dialogs.open({ title: "WIP commit failed", message: e.message, cls: "dialog-error", okLabel: "OK", cancelLabel: null });
    } finally {
      this.busy.set(false);
    }
  }

  async discard(path, repo) {
    const ok = await this.dialogs.open({
      title: `Discard changes in ${repo}?`,
      message: "This permanently removes all uncommitted changes, including untracked files. This cannot be undone.",
      okLabel: "Discard changes",
    });
    if (!ok) return;
    this.busy.set(true);
    try {
      this.eventLog.add(`discarding changes (${repo})`);
      await postJSON("/api/code/discard", { path });
      await this.load(true);
    } catch (e) {
      this.eventLog.add(`discard failed (${repo})`);
      this.dialogs.open({ title: "Discard changes failed", message: e.message, cls: "dialog-error", okLabel: "OK", cancelLabel: null });
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
      },
      reload,
    );
  }
}
