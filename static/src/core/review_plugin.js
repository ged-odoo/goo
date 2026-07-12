// PRs the user commented on in the last 14 days — a single global GitHub search
// (commenter:@me), cached server-side (see GitHubService.reviewed). This plugin
// just requests; the backend returns cached-or-fresh.
//
// Mergebot status is loaded lazily on top (one scrape per PR, server-cached 8h).
// Two facts are terminal and persisted in localStorage so we stop asking:
//   - a PR that reached "merged" never changes again (skipped even on Refresh);
//   - a repo with no mergebot page (404) is remembered and skipped on normal loads
//     (re-probed on a manual Refresh so a false positive can recover).

import { postJSON } from "./utils.js";
import { PullRequest } from "./models.js";
import { ConfigPlugin } from "./config_plugin.js";
import { StorePlugin } from "./store_plugin.js";

import { Plugin, usePlugin, signal } from "@odoo/owl";

const mbKey = (p) => `${p.github}#${p.number}`;

export class ReviewPlugin extends Plugin {
  static sequence = 5;

  config = usePlugin(ConfigPlugin);
  store = usePlugin(StorePlugin); // the shared observed store
  prs = signal([]); // view state; freshness is the server's job
  at = signal(0);
  loading = signal(false);
  error = signal("");
  // mergebot state is one shared map: the Code screen reads and writes the same one,
  // so a PR scraped on either screen shows its badge on both (dedup via store.mbPending)
  mergebot = this.store.mergebot; // "github#number" -> mergebot state (or "" / "merged")
  mbDetails = this.store.mbDetails; // "github#number" -> blocked-reason detail
  favorites = signal(this._readArr("reviews_favorites")); // [branch, …] (starred groups, sorted first)
  _merged = new Set(this._readArr("reviews_merged")); // terminal merged PRs
  _noMergebot = new Set(this._readArr("reviews_no_mergebot")); // repos without mergebot

  // fetch the commented-on PRs (the server caches them). `force` (manual Refresh)
  // adds ?refresh=1 so the backend re-queries instead of serving its cache.
  async load(force = false) {
    this.loading.set(true);
    this.error.set("");
    try {
      const resp = await fetch(force ? "/api/reviews?refresh=1" : "/api/reviews");
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || "failed");
      this.prs.set((data.prs || []).map(PullRequest.from));
      this.at.set(Date.now());
    } catch (e) {
      this.error.set(e.message);
    } finally {
      this.loading.set(false);
    }
  }

  // starred branch groups (by branch name), persisted; sorted first in the Reviews screen
  isFavorite(key) {
    return this.favorites().includes(key);
  }

  toggleFavorite(key) {
    const favs = this.favorites();
    const next = favs.includes(key) ? favs.filter((k) => k !== key) : [...favs, key];
    this.favorites.set(next);
    this.config.setState("reviews_favorites", next);
  }

  // load mergebot states for `prs` ([{github, number}]). Skips PRs already known
  // merged and (on normal loads) repos known to lack mergebot, so only the unknown
  // ones hit the network. Pass {refresh:true} to re-probe (bypasses caches; still
  // never re-fetches merged PRs).
  async loadMergebot(prs, { refresh = false } = {}) {
    // show known-merged badges straight from storage, no request
    const seeded = {};
    for (const p of prs) {
      const k = mbKey(p);
      if (this._merged.has(k) && this.mergebot()[k] !== "merged") seeded[k] = "merged";
    }
    if (Object.keys(seeded).length) this.store.mergeMergebot(seeded, null);

    const have = this.mergebot();
    const todo = prs.filter((p) => {
      const k = mbKey(p);
      if (this._merged.has(k)) return false; // terminal — never refetch, even on refresh
      if (this._noMergebot.has(p.github) && !refresh) return false; // skip unsupported repos
      return refresh || (!(k in have) && !this.store.mbPending.has(k));
    });
    if (!todo.length) return;

    const keys = todo.map(mbKey);
    keys.forEach((k) => this.store.mbPending.add(k));
    try {
      const res = await postJSON("/api/mergebot", { prs: todo, refresh });
      this.store.mergeMergebot(res.states, res.details || {});
      this._record(todo, res);
    } catch {
      /* leave states blank on failure */
    } finally {
      keys.forEach((k) => this.store.mbPending.delete(k));
    }
  }

  // fold a /api/mergebot response into the persisted sets: newly-merged PRs become
  // terminal; repos the backend flags unsupported are remembered; repos we re-probed
  // that came back supported recover (dropped from the skip list).
  _record(requested, res) {
    let changed = false;
    for (const [k, state] of Object.entries(res.states || {})) {
      if (state === "merged" && !this._merged.has(k)) {
        this._merged.add(k);
        changed = true;
      }
    }
    const unsupported = new Set(res.unsupported || []);
    for (const repo of new Set(requested.map((p) => p.github))) {
      if (!unsupported.has(repo) && this._noMergebot.delete(repo)) changed = true;
    }
    for (const repo of unsupported) {
      if (!this._noMergebot.has(repo)) {
        this._noMergebot.add(repo);
        changed = true;
      }
    }
    if (changed) this._persist();
  }

  _persist() {
    this.config.setState("reviews_merged", [...this._merged]);
    this.config.setState("reviews_no_mergebot", [...this._noMergebot]);
  }

  _readArr(field) {
    const v = this.config.getState(field, []);
    return Array.isArray(v) ? v : [];
  }
}
