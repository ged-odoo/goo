// Reviews screen: a user-curated watchlist of other people's PRs to review,
// r+, and follow through to merge (config.reviews — see config_models.ts's
// Settings.reviews). r+/forward-port status is NOT duplicated here — it comes
// straight from the shared CodePlugin/mergebot store, same as Branches & PRs.
// This plugin only owns the two things unique to Reviews: full PR metadata for
// explicit {github, number} pairs, and "have I reviewed this" per pair.

import { errorMessage, postJSON } from "../core/utils.ts";
import type { PrRef } from "../core/code_plugin.ts";
import type { Config, ConfigInput } from "../core/config.ts";
import type { PullRequestWire } from "../core/models.ts";

import { Plugin, signal } from "@odoo/owl";

// GitHubService.review_statuses: has the authenticated user reviewed it
export type ReviewStatus = "reviewed" | "to_review";

// a {github, branch} pair for the sibling-PR lookup (GitHubService.prs_for_branches)
export interface BranchRef {
  github: string;
  branch: string;
}

// a /api/prs/for-branches result: GitHubService._fetch_head always sets `github`
export type SiblingPr = PullRequestWire & PrRef;

// the slice of ConfigPlugin the watchlist edits read + write
export interface ReviewsConfig {
  config: Pick<Config, "reviews">;
  updateConfig(patch: ConfigInput): void;
}

export class ReviewsPlugin extends Plugin {
  static sequence = 4;

  prInfo = signal<Record<string, PullRequestWire>>({}); // "github#number" -> PullRequest dict
  reviewStatus = signal<Record<string, ReviewStatus>>({}); // "github#number" -> "reviewed" | "to_review"
  loading = signal(false);
  error = signal("");
  at = signal(0); // last successful prInfo fetch (drives the screen's "updated…" stamp)
  _pending = new Set<string>(); // in-flight keys, so overlapping effects don't double-fetch

  // full PR info (title/url/state/ci/...) for tracked pairs not already held.
  // force=true re-asks everything and bypasses the server cache (manual refresh).
  async loadPrInfo(pairs: readonly PrRef[], force = false): Promise<void> {
    const have = this.prInfo();
    const todo = (pairs || []).filter((p) => {
      const k = `${p.github}#${p.number}`;
      return (force || !(k in have)) && !this._pending.has(k);
    });
    if (!todo.length) return;
    const keys = todo.map((p) => `${p.github}#${p.number}`);
    keys.forEach((k) => this._pending.add(k));
    this.loading.set(true);
    this.error.set("");
    try {
      const res = await postJSON<{ prs?: PullRequestWire[] }>("/api/prs/info", {
        prs: todo,
        refresh: force,
      });
      const byKey = Object.fromEntries(
        (res.prs || []).map((pr) => [`${pr.github}#${pr.number}`, pr]),
      );
      // only write when something arrived: the screen's load effect reads prInfo, so
      // re-setting it for a PR GitHub didn't return (deleted, wrong number) would
      // re-run that effect, re-ask the same PR, and loop forever
      if (Object.keys(byKey).length) this.prInfo.set({ ...have, ...byKey });
      this.at.set(Date.now());
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      keys.forEach((k) => this._pending.delete(k));
      this.loading.set(false);
    }
  }

  // "have I reviewed this" for tracked pairs not already held.
  async loadReviewStatus(pairs: readonly PrRef[], force = false): Promise<void> {
    const have = this.reviewStatus();
    const todo = (pairs || []).filter((p) => {
      const k = `${p.github}#${p.number}`;
      return (force || !(k in have)) && !this._pending.has(`rs:${k}`);
    });
    if (!todo.length) return;
    const keys = todo.map((p) => `${p.github}#${p.number}`);
    keys.forEach((k) => this._pending.add(`rs:${k}`));
    try {
      const res = await postJSON<{ statuses?: Record<string, ReviewStatus> }>(
        "/api/prs/review-status",
        { prs: todo, refresh: force },
      );
      // same guard as loadPrInfo: no write (so no effect re-run) when nothing arrived
      const statuses = res.statuses || {};
      if (Object.keys(statuses).length) this.reviewStatus.set({ ...have, ...statuses });
    } catch {
      /* leave status blank on failure */
    } finally {
      keys.forEach((k) => this._pending.delete(`rs:${k}`));
    }
  }

  // full info for one {github, number} pair, fetching it if not already held
  // (a no-op await if it's already in prInfo). Used right after tracking a new
  // PR, to learn its branch for sibling discovery (findSiblings below).
  async fetchOne(pair: PrRef): Promise<PullRequestWire | null> {
    await this.loadPrInfo([pair]);
    return this.prInfo()[`${pair.github}#${pair.number}`] || null;
  }

  // the PR (if any) whose head is `branch` in each of the given repos, regardless
  // of author — reuses the same GITHUB.prs_for_branches lookup Branches & PRs uses
  // to resolve forward-port/colleagues' PRs. Also seeds prInfo with the full
  // result, so a caller that tracks these doesn't re-fetch them by number right
  // after. Returns [] on failure (never throws).
  async findSiblings(branches: BranchRef[]): Promise<SiblingPr[]> {
    if (!branches.length) return [];
    try {
      const res = await postJSON<{ prs?: SiblingPr[] }>("/api/prs/for-branches", {
        branches,
      });
      const prs = res.prs || [];
      if (prs.length) {
        const byKey = Object.fromEntries(prs.map((pr) => [`${pr.github}#${pr.number}`, pr]));
        this.prInfo.set({ ...this.prInfo(), ...byKey });
      }
      return prs;
    } catch {
      return [];
    }
  }

  // add/remove a {github, number} pair from config.reviews. `track` is a no-op
  // (returns false) if it's already tracked. New entries go to the front, so
  // freshly tracked PRs show up first.
  track(config: ReviewsConfig, github: string, number: number): boolean {
    const id = `${github}#${number}`;
    if (config.config.reviews.some((r) => r.id === id)) return false;
    config.updateConfig({ reviews: [{ id, github, number }, ...config.config.reviews] });
    return true;
  }

  untrack(config: ReviewsConfig, id: string): void {
    config.updateConfig({ reviews: config.config.reviews.filter((r) => r.id !== id) });
  }

  // untrack every id in one write (a group's "Untrack" button) rather than one
  // updateConfig per row.
  untrackMany(config: ReviewsConfig, ids: string[]): void {
    const idSet = new Set(ids);
    config.updateConfig({ reviews: config.config.reviews.filter((r) => !idSet.has(r.id)) });
  }

  // flip "important" for a whole task (every PR sharing its branch) in one write —
  // the warning-flag toggle is a task-level concern, like untrackMany's Untrack.
  // If any PR in the task is already flagged, this clears all of them; otherwise
  // it flags all of them.
  toggleImportant(config: ReviewsConfig, ids: string[]): void {
    const idSet = new Set(ids);
    const flagged = config.config.reviews.some((r) => idSet.has(r.id) && r.important);
    config.updateConfig({
      reviews: config.config.reviews.map((r) =>
        idSet.has(r.id) ? { ...r, important: !flagged } : r,
      ),
    });
  }
}
