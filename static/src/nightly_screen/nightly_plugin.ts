// Nightly build status: fetches Multi Qunit Community/Enterprise results from
// runbot for every Odoo version, grouped by night. All the actual scraping +
// caching happens server-side (NightlyService, backed by a single TTLCache) —
// this plugin just holds the current view + an in-memory (session-only) memo
// of per-build errors/metrics so re-opening a popover doesn't need to await.

import { errorMessage, postJSON } from "../core/utils.ts";

import { Plugin, signal } from "@odoo/owl";

// ── wire shapes (backend/services/runbot.py NightlyService) ───────────────

export interface BuildCounts {
  total: number;
  ok: number;
  warning: number;
  failed: number;
}

// one Multi Qunit build; `counts` is missing until runbot has the build detail
export interface NightlyBuild {
  status: string; // runbot badge status: success | warning | danger | info
  url: string; // runbot path, e.g. /runbot/build/123
  counts?: BuildCounts;
}

export interface NightlyVersionBuilds {
  community?: NightlyBuild;
  enterprise?: NightlyBuild;
}

export interface Night {
  date: string; // YYYY-MM-DD
  versions: Record<string, NightlyVersionBuilds>; // version -> its builds that night
}

interface NightlyReply {
  versions?: string[];
  nights?: Night[];
}

export interface BuildError {
  test_name: string;
  status: string; // danger | warning
  timeout: boolean;
  known: boolean;
  assignee: string;
  url: string; // runbot path of the child build it came from
}

// per-suite performance metrics, averaged over the build's children
export interface SuiteMetric {
  avg_mem: number;
  max_mem: number;
  time: number;
  count: number;
  tests: number | null;
  assertions: number | null;
}

export interface BuildErrors {
  errors: BuildError[];
  metrics: Record<string, SuiteMetric>; // suite name -> metrics
}

export class NightlyPlugin extends Plugin {
  static sequence = 4;

  versions = signal<string[]>([]);
  nights = signal<Night[]>([]);
  loading = signal(false);
  error = signal("");
  at = signal(0);
  _maxNights = 0; // how many nights the backend last fetched, this session

  _errorsCache = new Map<string, BuildErrors>(); // build url -> { errors, metrics } (session-only memo)
  timeoutUrls = signal(new Set<string>()); // URLs whose builds contain a timeout error

  async fetchErrors(url: string): Promise<BuildErrors> {
    const cached = this._errorsCache.get(url);
    if (cached) return cached;
    const res = await postJSON<Partial<BuildErrors>>("/api/nightly/errors", { url });
    const result: BuildErrors = { errors: res.errors || [], metrics: res.metrics || {} };
    this._errorsCache.set(url, result);
    if (result.errors.some((e) => e.timeout)) {
      const s = new Set(this.timeoutUrls());
      s.add(url);
      this.timeoutUrls.set(s);
    }
    return result;
  }

  async load(force = false, maxNights = 7): Promise<void> {
    if (this.loading()) return;

    // already have enough for this session, and not an explicit refresh
    if (!force && this.at() && this._maxNights >= maxNights) return;

    this.loading.set(true);
    this.error.set("");
    try {
      const res = await postJSON<NightlyReply>("/api/nightly", {
        refresh: !!force,
        max_nights: maxNights,
      });
      this.versions.set(res.versions || []);
      this.nights.set(res.nights || []);
      this._maxNights = maxNights;
      this.at.set(Date.now());
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }
}
