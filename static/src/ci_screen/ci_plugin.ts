// CI dashboard: per-day mergebot merge-queue stats (batches merged / failed /
// killed + PRs merged), scraped + cached server-side (CiService). This plugin
// just holds the current view and drives the fetch.

import { errorMessage, postJSON } from "../core/utils.ts";

import { Plugin, signal } from "@odoo/owl";

// one day of merge-queue stats, as /api/ci/merge-stats reports it (UTC day)
export interface CiDay {
  date: string; // ISO "YYYY-MM-DD"
  batches: number;
  merged: number;
  failed: number;
  killed: number;
  pending: number;
  prs_merged: number;
}

interface MergeStatsReply {
  days?: CiDay[];
  awaiting?: number | null;
}

export class CiPlugin extends Plugin {
  static sequence = 4;

  days = signal<CiDay[]>([]);
  awaiting = signal<number | null>(null); // PRs approved but not yet staged (null = unknown)
  loading = signal(false);
  error = signal("");
  at = signal(0);
  _window = 0; // how many days the backend last fetched, this session

  async load(force = false, days = 14): Promise<void> {
    if (this.loading()) return;
    // already have enough for this session, and not an explicit refresh
    if (!force && this.at() && this._window >= days) return;

    this.loading.set(true);
    this.error.set("");
    try {
      const res = await postJSON<MergeStatsReply>("/api/ci/merge-stats", {
        refresh: !!force,
        days,
      });
      this.days.set(res.days || []);
      this.awaiting.set(res.awaiting ?? null);
      this._window = days;
      this.at.set(Date.now());
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }
}
