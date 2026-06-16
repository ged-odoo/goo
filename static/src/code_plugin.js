// Branches & PRs across repos: grouped view model, favorites, and the
// per-branch actions (delete, close PR, push).

import { DEFAULT_CONFIG, BASE_BRANCH_RE, RUNBOT, MERGEBOT, CACHE_TTL } from "./config.js";
import { ConfigPlugin, FAVORITES_KEY } from "./config_plugin.js";
import { postJSON } from "./utils.js";

const { Plugin, plugin, signal, computed } = owl;

const PRS_CACHE_KEY = "oo-prs-cache";

export class CodePlugin extends Plugin {
  static sequence = 3;

  config = plugin(ConfigPlugin);
  branchRepos = signal((this._cache() || {}).branchRepos || []);
  prRepos = signal((this._cache() || {}).prRepos || []);
  at = signal((this._cache() || {}).at || 0);
  loading = signal(false);
  error = signal("");
  busy = signal(false);
  favorites = signal(this._readFavorites());
  // grouped, sorted view model — recomputed only when its inputs change
  groups = computed(() => this._groups());

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

  _readFavorites() {
    try {
      const f = JSON.parse(this.config.read(FAVORITES_KEY));
      return Array.isArray(f) ? f : [];
    } catch {
      return [];
    }
  }

  toggleFavorite(branch) {
    const favs = new Set(this.favorites());
    favs.has(branch) ? favs.delete(branch) : favs.add(branch);
    this.favorites.set([...favs]);
    this.config.write(FAVORITES_KEY, JSON.stringify(this.favorites()));
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
    const favs = this.favorites();
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
            favorite: favs.includes(branch),
            runbot: rows.map((r) => r.runbot).find(Boolean) || "",
          };
        })
        .sort((a, b) => b.favorite - a.favorite || a.base - b.base || b.activity - a.activity),
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

  deleteBranch(branch, repo, path) {
    if (!confirm(`Force-delete branch "${branch}" in ${repo}? This cannot be undone.`)) return;
    return this._mutate(
      "Delete",
      async () => {
        await postJSON("/api/code/branches/delete", { path, branch });
        this._dropBranch(repo, branch);
      },
      false,
    );
  }

  closePr(github, number) {
    if (!confirm(`Close PR #${number} in ${github}?`)) return;
    return this._mutate("Close PR", () => postJSON("/api/prs/close", { repo: github, number }));
  }

  pushBranch(path, branch) {
    if (!confirm(`Push "${branch}" to the dev remote (odoo-dev)?`)) return;
    return this._mutate("Push", () => postJSON("/api/code/branch/push", { path, branch }));
  }
}
