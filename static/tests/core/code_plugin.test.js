import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { CodePlugin } from "../../src/core/code_plugin.js";
import { ConfigPlugin } from "../../src/core/config_plugin.js";
import { EventLogPlugin } from "../../src/core/event_log_plugin.js";
import { DialogPlugin } from "../../src/core/dialog_plugin.js";
import { StorePlugin } from "../../src/core/store_plugin.js";
import { PullRequest } from "../../src/core/models.js";
import { createPluginHarness } from "../helpers/plugin_harness.js";

const PRS_CACHE_KEY = "oo-prs-cache";

function makeConfig(repos) {
  return { config: { repos }, repoByGithub: () => undefined };
}

// CodePlugin has real, non-trivial state-machine logic of its own (dedup,
// grouping/sorting, cache read/write); its siblings (StorePlugin excepted — used
// for real, it's cheap and pure in-memory state) are faked to isolate that logic
// from GitHubService/MergebotService/RunbotService, which already have their own
// backend-side test coverage.
function makePlugin(repos = [{ id: "community", github: "odoo/odoo" }]) {
  const store = new StorePlugin({});
  const eventLog = { add: vi.fn() };
  const dialogs = { open: vi.fn(), error: vi.fn() };
  const config = makeConfig(repos);
  const harness = createPluginHarness([
    [ConfigPlugin, config],
    [StorePlugin, store],
    [EventLogPlugin, eventLog],
    [DialogPlugin, dialogs],
  ]);
  const plugin = harness.start(CodePlugin);
  return { plugin, store, eventLog, dialogs, config };
}

describe("CodePlugin._groups", () => {
  it("sorts base branches last, then by most-recent activity", () => {
    const { plugin, store } = makePlugin();
    store.mergeRepoStatus(
      [
        {
          id: "community",
          current: "master",
          branches: [
            { name: "master", date: "2020-01-01T00:00:00Z", remote: true },
            { name: "feature-old", date: "2020-01-01T00:00:00Z", remote: true },
            { name: "feature-new", date: "2024-01-01T00:00:00Z", remote: true },
          ],
        },
      ],
      1,
      { authoritative: true },
    );
    const branches = plugin.groups().list.map((g) => g.branch);
    expect(branches).toEqual(["feature-new", "feature-old", "master"]);
  });

  it("picks the open PR over a closed one, and the most recently updated among opens", () => {
    const { plugin, store } = makePlugin();
    store.mergeRepoStatus(
      [{ id: "community", branches: [{ name: "feature", date: "2024-01-01T00:00:00Z" }] }],
      1,
      { authoritative: true },
    );
    store.mergePrRepos(
      [
        {
          id: "community",
          prs: [
            PullRequest.from({
              github: "odoo/odoo",
              number: 1,
              branch: "feature",
              state: "closed",
              updated_at: "2024-06-01T00:00:00Z",
            }),
            PullRequest.from({
              github: "odoo/odoo",
              number: 2,
              branch: "feature",
              state: "open",
              updated_at: "2024-01-01T00:00:00Z",
            }),
          ],
        },
      ],
      1,
      new Set(["community"]),
    );
    const pr = plugin.groups().prIndex["community:feature"];
    expect(pr.number).toBe(2);
    expect(plugin.groups().prsIndex["community:feature"]).toHaveLength(2);
  });

  it("a head-ref PR lookup never shadows an authored PR on the same branch", () => {
    const { plugin, store } = makePlugin();
    store.mergeRepoStatus(
      [{ id: "community", branches: [{ name: "feature", date: "2024-01-01T00:00:00Z" }] }],
      1,
      { authoritative: true },
    );
    store.mergePrRepos(
      [
        {
          id: "community",
          prs: [
            PullRequest.from({
              github: "odoo/odoo",
              number: 1,
              branch: "feature",
              state: "open",
            }),
          ],
        },
      ],
      1,
      new Set(["community"]),
    );
    plugin.headPrs.set({
      "community:feature": PullRequest.from({
        github: "odoo/odoo",
        number: 99,
        branch: "feature",
      }),
    });
    expect(plugin.groups().prIndex["community:feature"].number).toBe(1);
  });
});

describe("CodePlugin._cache / instant-paint localStorage cache", () => {
  afterEach(() => localStorage.clear());

  it("returns null when nothing is cached", () => {
    const { plugin } = makePlugin();
    expect(plugin._cache()).toBeNull();
  });

  it("returns null for malformed JSON instead of throwing", () => {
    localStorage.setItem(PRS_CACHE_KEY, "{not json");
    const { plugin } = makePlugin();
    expect(plugin._cache()).toBeNull();
  });

  it("returns null when the cached shape is incomplete (missing at/branchRepos)", () => {
    localStorage.setItem(PRS_CACHE_KEY, JSON.stringify({ at: 0 }));
    const { plugin } = makePlugin();
    expect(plugin._cache()).toBeNull();
  });

  it("returns a well-formed cache entry as-is", () => {
    const cached = { at: 123, branchRepos: [{ id: "community", branches: [] }] };
    localStorage.setItem(PRS_CACHE_KEY, JSON.stringify(cached));
    const { plugin } = makePlugin();
    expect(plugin._cache()).toEqual(cached);
  });
});

describe("CodePlugin._widenScope", () => {
  it("true absorbs anything", () => {
    const { plugin } = makePlugin();
    expect(plugin._widenScope(true, new Set(["a"]))).toBe(true);
    expect(plugin._widenScope(new Set(["a"]), true)).toBe(true);
  });

  it("null/undefined falls back to the other side", () => {
    const { plugin } = makePlugin();
    const s = new Set(["a"]);
    expect(plugin._widenScope(null, s)).toBe(s);
    expect(plugin._widenScope(s, null)).toBe(s);
  });

  it("two sets union rather than replace", () => {
    const { plugin } = makePlugin();
    const widened = plugin._widenScope(new Set(["a"]), new Set(["b"]));
    expect([...widened].sort()).toEqual(["a", "b"]);
  });
});

describe("CodePlugin.workspaceRefreshedAt", () => {
  it("returns 0 for an empty id set", () => {
    const { plugin } = makePlugin();
    expect(plugin.workspaceRefreshedAt(new Set())).toBe(0);
  });

  it("returns 0 when a repo's branch state was never fetched", () => {
    const { plugin } = makePlugin();
    expect(plugin.workspaceRefreshedAt(new Set(["community"]))).toBe(0);
  });

  it("requires both branch AND pr freshness for a github-backed repo", () => {
    const { plugin, store } = makePlugin();
    store.mergeRepoStatus([{ id: "community", branches: [] }], 100, { authoritative: true });
    // branches fetched (at=100) but PRs never fetched -> still 0
    expect(plugin.workspaceRefreshedAt(new Set(["community"]))).toBe(0);
    store.mergePrRepos([{ id: "community", prs: [] }], 200, new Set(["community"]));
    // the OLDER of the two stamps wins (a workspace is as fresh as its oldest piece)
    expect(plugin.workspaceRefreshedAt(new Set(["community"]))).toBe(100);
  });

  it("a repo with no github slug only needs branch freshness", () => {
    const { plugin, store } = makePlugin([{ id: "no-gh" }]);
    store.mergeRepoStatus([{ id: "no-gh", branches: [] }], 50, { authoritative: true });
    expect(plugin.workspaceRefreshedAt(new Set(["no-gh"]))).toBe(50);
  });
});

describe("CodePlugin repo-working bookkeeping", () => {
  it("counts overlapping operations per repo and only clears at zero", () => {
    const { plugin } = makePlugin();
    expect(plugin.repoWorking("community")).toBe(false);
    plugin._beginWork(["community"]);
    plugin._beginWork(["community"]);
    expect(plugin.repoWorking("community")).toBe(true);
    plugin._endWork(["community"]);
    expect(plugin.repoWorking("community")).toBe(true); // one still in flight
    plugin._endWork(["community"]);
    expect(plugin.repoWorking("community")).toBe(false);
  });
});

describe("CodePlugin.reposWithGithub / isExternalRepo", () => {
  it("falls back to DEFAULT_CONFIG's github slug when a repo doesn't set its own", () => {
    const { plugin } = makePlugin([{ id: "community" }]);
    expect(plugin.reposWithGithub()[0].github).toBe("odoo/odoo");
  });

  it("an explicit github slug is never overridden by the default", () => {
    const { plugin } = makePlugin([{ id: "community", github: "mine/fork" }]);
    expect(plugin.reposWithGithub()[0].github).toBe("mine/fork");
  });

  it("flags a repo external only when configured as such", () => {
    const { plugin } = makePlugin([{ id: "owl", github: "odoo/owl", external: true }]);
    expect(plugin.isExternalRepo("odoo/owl")).toBe(true);
    expect(plugin.isExternalRepo("odoo/odoo")).toBe(false);
    expect(plugin.isExternalRepo("")).toBe(false);
  });
});

describe("CodePlugin.loadMergebot dedup", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("doesn't re-fetch a PR whose mergebot state is already held", async () => {
    const { plugin, store } = makePlugin();
    store.mergeMergebot({ "odoo/odoo#1": "approved" }, {}, { "odoo/odoo#1": [] });
    await plugin.loadMergebot([{ github: "odoo/odoo", number: 1 }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches an unknown PR and merges the result into the store", async () => {
    const { plugin } = makePlugin();
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ states: { "odoo/odoo#1": "approved" }, details: {} }),
    });
    await plugin.loadMergebot([{ github: "odoo/odoo", number: 1 }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(plugin.mergebot()["odoo/odoo#1"]).toBe("approved");
  });

  it("never pins a blank state — a scrape that returns nothing stays re-askable", async () => {
    const { plugin } = makePlugin();
    fetch.mockResolvedValue({ ok: true, json: async () => ({ states: { "odoo/odoo#1": "" } }) });
    await plugin.loadMergebot([{ github: "odoo/odoo", number: 1 }]);
    expect("odoo/odoo#1" in plugin.mergebot()).toBe(false);
  });

  it("an armed one-shot refresh re-asks a PR even though it's already held", async () => {
    const { plugin, store } = makePlugin();
    store.mergeMergebot({ "odoo/odoo#1": "approved" }, {}, { "odoo/odoo#1": [] });
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ states: { "odoo/odoo#1": "merged" }, details: {} }),
    });
    plugin._mbRefresh = new Set(["odoo/odoo#1"]);
    await plugin.loadMergebot([{ github: "odoo/odoo", number: 1 }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(plugin.mergebot()["odoo/odoo#1"]).toBe("merged");
    // the scope is consumed by the batch it armed
    expect(plugin._mbRefresh).toBeNull();
  });
});

describe("CodePlugin.loadRunbot dedup", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("doesn't re-fetch a branch whose runbot status is already held", async () => {
    const { plugin, store } = makePlugin();
    store.mergeRunbot({ master: "success" });
    await plugin.loadRunbot(["master"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches an unknown branch and merges the result", async () => {
    const { plugin } = makePlugin();
    fetch.mockResolvedValue({ ok: true, json: async () => ({ states: { master: "success" } }) });
    await plugin.loadRunbot(["master"]);
    expect(plugin.runbot().master).toBe("success");
  });
});
