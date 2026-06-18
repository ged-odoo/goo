// Branches & PRs across repos: grouped view model and the per-branch actions
// (delete, close PR, push).

import { DEFAULT_CONFIG, BASE_BRANCH_RE, RUNBOT, MERGEBOT, CACHE_TTL } from "./config.js";
import { ConfigPlugin } from "./config_plugin.js";
import { EventLogPlugin } from "./event_log_plugin.js";
import { postJSON } from "./utils.js";

const { Plugin, plugin, signal, computed } = owl;

const PRS_CACHE_KEY = "oo-prs-cache";

export class CodePlugin extends Plugin {
  static sequence = 3;

  config = plugin(ConfigPlugin);
  eventLog = plugin(EventLogPlugin);
  branchRepos = signal((this._cache() || {}).branchRepos || []);
  prRepos = signal((this._cache() || {}).prRepos || []);
  at = signal((this._cache() || {}).at || 0);
  loading = signal(false);
  error = signal("");
  busy = signal(false);
  mergebot = signal({}); // "github#number" -> mergebot state (scraped lazily)
  runbot = signal({}); // branch name -> runbot status (fetched lazily)
  _mbPending = new Set(); // keys currently being scraped (avoid duplicate fetches)
  _rbPending = new Set();
  // grouped, sorted view model — recomputed only when its inputs change
  groups = computed(() => this._groups());

  // scrape the mergebot state for PRs not already known or in flight; the
  // dashboard effect can fire several times before a scrape resolves, so the
  // pending guard keeps us from re-fetching the same PR each time.
  async loadMergebot(prs) {
    const have = this.mergebot();
    const todo = prs.filter((p) => {
      const k = `${p.github}#${p.number}`;
      return !(k in have) && !this._mbPending.has(k);
    });
    if (!todo.length) return;
    const keys = todo.map((p) => `${p.github}#${p.number}`);
    keys.forEach((k) => this._mbPending.add(k));
    try {
      const res = await postJSON("/api/mergebot", { prs: todo });
      this.mergebot.set({ ...this.mergebot(), ...res.states });
    } catch {
      /* leave states blank on failure */
    } finally {
      keys.forEach((k) => this._mbPending.delete(k));
    }
  }

  // fetch the runbot status for branches not already known or in flight
  async loadRunbot(branches) {
    const have = this.runbot();
    const todo = branches.filter((b) => !(b in have) && !this._rbPending.has(b));
    if (!todo.length) return;
    todo.forEach((b) => this._rbPending.add(b));
    try {
      const res = await postJSON("/api/runbot", { branches: todo });
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

  _cache() {
    try {
      const c = JSON.parse(localStorage.getItem(PRS_CACHE_KEY));
      return c && c.at && c.branchRepos && c.prRepos ? c : null;
    } catch {
      return null;
    }
  }

  async load(force = false) {
    const cache = this._cache();
    if (!force && cache && Date.now() - cache.at < CACHE_TTL) {
      this.branchRepos.set(cache.branchRepos);
      this.prRepos.set(cache.prRepos);
      this.at.set(cache.at);
      return;
    }
    this.loading.set(true);
    this.error.set("");
    this.mergebot.set({}); // re-scrape mergebot/runbot states after a real refresh
    this.runbot.set({});
    const repos = this.reposWithGithub();
    try {
      const [b, p] = await Promise.all([
        postJSON("/api/code/branches", { repos }),
        postJSON("/api/prs", { repos: repos.filter((r) => r.github) }),
      ]);
      const at = Date.now();
      localStorage.setItem(
        PRS_CACHE_KEY,
        JSON.stringify({ at, branchRepos: b.repos, prRepos: p.repos }),
      );
      this.branchRepos.set(b.repos);
      this.prRepos.set(p.repos);
      this.at.set(at);
    } catch (e) {
      this.error.set(e.message);
    } finally {
      this.loading.set(false);
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

  // a commit URL on the repo that hosts the branch (canonical for base branches,
  // the odoo-dev fork for work branches) — mirrors remoteBranchUrl
  remoteCommitUrl(github, branch, sha) {
    const owner = BASE_BRANCH_RE.test(branch) ? github : `odoo-dev/${github.split("/")[1]}`;
    return `https://github.com/${owner}/commit/${sha}`;
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

  // checkout the given {path, branch} in each repo, then reload branch state
  async checkout(repos) {
    this.busy.set(true);
    try {
      const res = await postJSON("/api/code/checkout", { repos });
      const failed = (res.results || []).filter((r) => !r.ok);
      if (failed.length)
        alert("Checkout failed:\n" + failed.map((r) => `${r.branch}: ${r.error}`).join("\n"));
      await this.load(true);
    } catch (e) {
      alert(`Checkout failed: ${e.message}`);
    } finally {
      this.busy.set(false);
    }
  }

  // fetch each repo's base branch from its canonical repo and rebase onto it,
  // then reload branch state
  async rebase(repos) {
    this.busy.set(true);
    try {
      const res = await postJSON("/api/code/rebase", { repos });
      const failed = (res.results || []).filter((r) => !r.ok);
      if (failed.length)
        alert("Rebase failed:\n" + failed.map((r) => `${r.repo}: ${r.error}`).join("\n"));
      await this.load(true);
    } catch (e) {
      alert(`Rebase failed: ${e.message}`);
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
        const res = await postJSON("/api/code/branches/delete", {
          path,
          branch,
          delete_remote: deleteRemote,
        });
        if (res.remote_error)
          alert(`Local branch deleted, but the remote branch could not be removed:\n${res.remote_error}`);
        this._dropBranch(repo, branch);
        this.eventLog.add(`deleted branch ${branch} (${repo})`);
      },
      false,
    );
  }

  // create a new branch at <startPoint> without checking it out, then reload
  createBranch(path, name, startPoint) {
    const repo = this.config.config.repos.find((r) => r.path === path);
    return this._mutate("Create branch", async () => {
      await postJSON("/api/code/branch/create", { path, name, start_point: startPoint });
      this.eventLog.add(`created branch ${name}${repo ? ` (${repo.id})` : ""}`);
    });
  }

  // mark a PR closed in the view + cache, no reload (which would re-fetch every
  // branch's runbot badge just to flip one PR's state)
  _closePrLocally(github, number) {
    const prRepos = this.prRepos().map((r) =>
      r.github === github
        ? { ...r, prs: r.prs.map((p) => (p.number === number ? { ...p, state: "CLOSED" } : p)) }
        : r,
    );
    this.prRepos.set(prRepos);
    const cache = this._cache();
    if (cache) localStorage.setItem(PRS_CACHE_KEY, JSON.stringify({ ...cache, prRepos }));
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
        await postJSON("/api/prs/close", { repo: github, number });
        this._closePrLocally(github, number);
        this.eventLog.add(`closed PR #${number} (${github})`);
      },
      false,
    );
  }

  pushBranch(path, branch) {
    if (!confirm(`Push "${branch}" to the dev remote (odoo-dev)?`)) return;
    return this._mutate("Push", () => postJSON("/api/code/branch/push", { path, branch }));
  }
}
