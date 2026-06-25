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
import {
  ConfigPlugin,
  REVIEWS_MERGED_KEY,
  REVIEWS_NO_MERGEBOT_KEY,
  REVIEWS_FAVORITES_KEY,
} from "./config_plugin.js";

const { Plugin, plugin, signal } = owl;

const mbKey = (p) => `${p.github}#${p.number}`;

export class ReviewPlugin extends Plugin {
  static sequence = 5;

  config = plugin(ConfigPlugin);
  prs = signal([]); // view state; freshness is the server's job
  at = signal(0);
  loading = signal(false);
  error = signal("");
  mergebot = signal({}); // "github#number" -> mergebot state (or "" / "merged")
  favorites = signal(this._readArr(REVIEWS_FAVORITES_KEY)); // [branch, …] (starred groups, sorted first)
  _mbPending = new Set(); // in-flight mergebot keys (dedup)
  _merged = new Set(this._readArr(REVIEWS_MERGED_KEY)); // terminal merged PRs
  _noMergebot = new Set(this._readArr(REVIEWS_NO_MERGEBOT_KEY)); // repos without mergebot

  // fetch the commented-on PRs (the server caches them). `force` (manual Refresh)
  // adds ?refresh=1 so the backend re-queries instead of serving its cache.
  async load(force = false) {
    this.loading.set(true);
    this.error.set("");
    try {
      const resp = await fetch(force ? "/api/reviews?refresh=1" : "/api/reviews");
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || "failed");
      this.prs.set(data.prs);
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
    this.config.write(REVIEWS_FAVORITES_KEY, JSON.stringify(next));
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
    if (Object.keys(seeded).length) this.mergebot.set({ ...this.mergebot(), ...seeded });

    const have = this.mergebot();
    const todo = prs.filter((p) => {
      const k = mbKey(p);
      if (this._merged.has(k)) return false; // terminal — never refetch, even on refresh
      if (this._noMergebot.has(p.github) && !refresh) return false; // skip unsupported repos
      return refresh || (!(k in have) && !this._mbPending.has(k));
    });
    if (!todo.length) return;

    const keys = todo.map(mbKey);
    keys.forEach((k) => this._mbPending.add(k));
    try {
      const res = await postJSON("/api/mergebot", { prs: todo, refresh });
      this.mergebot.set({ ...this.mergebot(), ...res.states });
      this._record(todo, res);
    } catch {
      /* leave states blank on failure */
    } finally {
      keys.forEach((k) => this._mbPending.delete(k));
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
    this.config.write(REVIEWS_MERGED_KEY, JSON.stringify([...this._merged]));
    this.config.write(REVIEWS_NO_MERGEBOT_KEY, JSON.stringify([...this._noMergebot]));
  }

  _readArr(key) {
    try {
      return JSON.parse(this.config.read(key) || "[]");
    } catch {
      return [];
    }
  }
}
