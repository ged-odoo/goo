// CI dashboard: per-day mergebot merge-queue stats (batches merged / failed /
// killed + PRs merged), scraped + cached server-side (CiService). This plugin
// just holds the current view and drives the fetch.

import { postJSON } from "../core/utils.js";

import { Plugin, signal } from "@odoo/owl";

export class CiPlugin extends Plugin {
  static sequence = 4;

  days = signal([]); // [{date, batches, merged, failed, killed, pending, prs_merged}]
  loading = signal(false);
  error = signal("");
  at = signal(0);
  _window = 0; // how many days the backend last fetched, this session

  async load(force = false, days = 14) {
    if (this.loading()) return;
    // already have enough for this session, and not an explicit refresh
    if (!force && this.at() && this._window >= days) return;

    this.loading.set(true);
    this.error.set("");
    try {
      const res = await postJSON("/api/ci/merge-stats", { refresh: !!force, days });
      this.days.set(res.days || []);
      this._window = days;
      this.at.set(Date.now());
    } catch (e) {
      this.error.set(e.message);
    } finally {
      this.loading.set(false);
    }
  }
}
