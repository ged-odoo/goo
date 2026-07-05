// Nightly build status: fetches Multi Qunit Community/Enterprise results from
// runbot for every Odoo version, grouped by night. All the actual scraping +
// caching happens server-side (NightlyService, backed by a single TTLCache) —
// this plugin just holds the current view + an in-memory (session-only) memo
// of per-build errors/metrics so re-opening a popover doesn't need to await.

import { postJSON } from "../utils.js";

import { Plugin, signal } from "@odoo/owl";

export class NightlyPlugin extends Plugin {
  static sequence = 4;

  versions = signal([]);
  nights = signal([]);
  loading = signal(false);
  error = signal("");
  at = signal(0);
  _maxNights = 0; // how many nights the backend last fetched, this session

  _errorsCache = new Map(); // build url -> { errors, metrics } (session-only memo)
  timeoutUrls = signal(new Set()); // URLs whose builds contain a timeout error

  async fetchErrors(url) {
    if (this._errorsCache.has(url)) return this._errorsCache.get(url);
    const res = await postJSON("/api/nightly/errors", { url });
    const result = { errors: res.errors || [], metrics: res.metrics || {} };
    this._errorsCache.set(url, result);
    if (result.errors.some((e) => e.timeout)) {
      const s = new Set(this.timeoutUrls());
      s.add(url);
      this.timeoutUrls.set(s);
    }
    return result;
  }

  async load(force = false, maxNights = 7) {
    if (this.loading()) return;

    // already have enough for this session, and not an explicit refresh
    if (!force && this.at() && this._maxNights >= maxNights) return;

    this.loading.set(true);
    this.error.set("");
    try {
      const res = await postJSON("/api/nightly", { refresh: !!force, max_nights: maxNights });
      this.versions.set(res.versions || []);
      this.nights.set(res.nights || []);
      this._maxNights = maxNights;
      this.at.set(Date.now());
    } catch (e) {
      this.error.set(e.message);
    } finally {
      this.loading.set(false);
    }
  }
}
