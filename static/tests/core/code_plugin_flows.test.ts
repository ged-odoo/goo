// CodePlugin's action flows against a fake backend: what each action asks the
// backend for, and what the user then observes — the store's branch/PR state, the
// error dialogs, the event log, the instant-paint cache.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { CodePlugin } from "../../src/core/code_plugin.ts";
import { ConfigPlugin } from "../../src/core/config_plugin.ts";
import { EventLogPlugin } from "../../src/core/event_log_plugin.ts";
import { DialogPlugin } from "../../src/core/dialog_plugin.ts";
import { StorePlugin } from "../../src/core/store_plugin.ts";
import { PullRequest } from "../../src/core/models.ts";
import type { RepoConfig } from "../../src/core/config.ts";
import type { BranchInfo, RepoStatusWire } from "../../src/core/observed_models.ts";
import type { PullRequestWire } from "../../src/core/models.ts";
import { createPluginHarness } from "../helpers/plugin_harness.ts";
import { NO_MANAGER } from "../helpers/plugin.ts";

const PRS_CACHE_KEY = "oo-prs-cache";

// ── a tiny fake backend: path -> reply (or a function of the body) ─────────────
type Body = Record<string, unknown>;
interface Call {
  path: string;
  body: Record<string, unknown>;
}
type Reply = unknown;
type Route = Reply | ((body: Record<string, unknown>) => Reply);

// a non-2xx reply (postJSON rejects with its `error`)
class Fail {
  constructor(
    public error: string,
    public data: Record<string, unknown> = {},
  ) {}
}

function backend(routes: Record<string, Route>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ path, body });
      const route = routes[path];
      const reply = typeof route === "function" ? route(body) : (route ?? {});
      if (reply instanceof Fail)
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: reply.error, ...reply.data }),
        };
      return { ok: true, status: 200, json: async () => reply };
    }),
  );
  return { calls, to: (path: string) => calls.filter((c) => c.path === path) };
}

// resolves once every pending promise chain + macrotask has drained
const tick = () => new Promise((r) => setTimeout(r, 0));

const REPOS: Partial<RepoConfig>[] = [
  {
    id: "community",
    github: "odoo/odoo",
    path: "/src/community",
    pull_remote: "origin",
    push_remote: "dev",
  },
  {
    id: "enterprise",
    github: "odoo/enterprise",
    path: "/src/enterprise",
    pull_remote: "upstream",
    push_remote: "dev-ent",
  },
];

const br = (name: string, extra: Partial<BranchInfo> = {}): BranchInfo => ({
  name,
  date: "2024-01-01T00:00:00Z",
  subject: "s",
  sha: "abc",
  remote: true,
  synced: true,
  ...extra,
});

const prWire = (p: Partial<PullRequestWire>) => p as PullRequestWire;

function makePlugin(opts: { confirm?: unknown; editor?: string } = {}) {
  const store = new StorePlugin(NO_MANAGER);
  const log: string[] = [];
  const eventLog = { add: vi.fn((msg: string) => log.push(msg)) };
  const errors: [string, string][] = [];
  const dialogs = {
    open: vi.fn(async () => opts.confirm ?? true),
    error: vi.fn((title: string, msg: string) => errors.push([title, msg])),
  };
  const config = {
    config: { repos: REPOS, editor: opts.editor },
    repoByGithub: () => undefined,
  };
  const harness = createPluginHarness([
    [ConfigPlugin, config],
    [StorePlugin, store],
    [EventLogPlugin, eventLog],
    [DialogPlugin, dialogs],
  ]);
  const plugin = harness.start(CodePlugin);
  return { plugin, store, log, errors, dialogs };
}

const branchNames = (store: StorePlugin, id: string) =>
  store
    .repoStatusList()
    .find((r) => r.id === id)
    ?.branches.map((b) => b.name);

beforeEach(() => localStorage.clear());

describe("load(): branches + PRs + head-ref lookups", () => {
  it("fills the grouped view, writes the instant-paint cache, and resolves forward-port PRs by head ref", async () => {
    const be = backend({
      "/api/code/branches": {
        repos: [
          {
            id: "community",
            current: "master",
            branches: [
              br("master"),
              br("17.0-feat-jpp"),
              br("17.0-fw-jpp"),
              br("local-only", { remote: false }),
            ],
            push_github: "jpp/odoo",
          },
          { id: "enterprise", current: "master", branches: [br("master")] },
        ],
      },
      "/api/prs": {
        repos: [
          {
            id: "community",
            github: "odoo/odoo",
            prs: [
              prWire({ github: "odoo/odoo", number: 7, branch: "17.0-feat-jpp", state: "open" }),
            ],
          },
          { id: "enterprise", github: "odoo/enterprise", prs: [] },
        ],
      },
      "/api/prs/for-branches": {
        prs: [prWire({ github: "odoo/odoo", number: 9, branch: "17.0-fw-jpp", state: "open" })],
      },
    });
    const { plugin, store } = makePlugin();
    await plugin.load();
    await tick();

    expect(plugin.loading()).toBe(false);
    expect(plugin.error()).toBe("");
    // the branch list the screen renders, base branches last
    expect(
      plugin
        .groups()
        .list.map((g) => g.branch)
        .at(-1),
    ).toBe("master");
    expect(plugin.groups().prIndex["community:17.0-feat-jpp"].number).toBe(7);
    // only the remote, non-base branch without an authored PR was looked up by head ref
    expect(be.to("/api/prs/for-branches")[0].body.branches).toEqual([
      { github: "odoo/odoo", branch: "17.0-fw-jpp" },
    ]);
    expect(plugin.groups().prIndex["community:17.0-fw-jpp"].number).toBe(9);
    // the cache paints the same branches on the next reload
    const cached = JSON.parse(localStorage.getItem(PRS_CACHE_KEY)!);
    expect(cached.branchRepos.map((r: { id: string }) => r.id).sort()).toEqual([
      "community",
      "enterprise",
    ]);
    const reloaded = makePlugin();
    expect(branchNames(reloaded.store, "community")).toContain("17.0-fw-jpp");
    expect(branchNames(store, "community")).toContain("local-only");
    // the PR-create link targets the push remote's resolved fork
    expect(plugin.prCreateUrl("community", "odoo/odoo", "17.0-fw-jpp")).toContain(
      "jpp:odoo:17.0-fw-jpp",
    );
    expect(plugin.forkBranchUrl("community", "odoo/odoo", "17.0-fw-jpp")).toBe(
      "https://github.com/jpp/odoo/tree/17.0-fw-jpp",
    );
    expect(plugin.remoteBranchUrl("community", "odoo/odoo", "master")).toBe(
      "https://github.com/odoo/odoo/tree/master",
    );
    expect(plugin.pullRequestUrl("odoo/odoo", 7)).toBe("https://github.com/odoo/odoo/pull/7");
    expect(plugin.mergebotUrl("odoo/odoo", 7)).toContain("odoo/odoo/pull/7");

    // a branch looked up with no PR found is remembered: not re-asked on the next load
    be.calls.length = 0;
    await plugin.loadHeadPrs();
    expect(be.to("/api/prs/for-branches")).toHaveLength(0);
    // ... unless forced
    await plugin.loadHeadPrs(true);
    expect(be.to("/api/prs/for-branches")[0].body.refresh).toBe(true);
  });

  it("a forced load bypasses the PR cache and re-asks runbot/mergebot for held badges", async () => {
    const be = backend({
      "/api/code/branches": { repos: [{ id: "community", branches: [br("master")] }] },
      "/api/prs": { repos: [] },
      "/api/runbot": { states: { master: { result: "ok", running: false, url: "" } } },
      "/api/mergebot": { states: { "odoo/odoo#1": "ready" } },
    });
    const { plugin } = makePlugin();
    await plugin.loadRunbot(["master"]);
    await plugin.loadMergebot([{ github: "odoo/odoo", number: 1 }]);
    expect(be.to("/api/runbot")[0].body.refresh).toBe(false);
    // held: a plain re-ask is deduped
    await plugin.loadRunbot(["master"]);
    expect(be.to("/api/runbot")).toHaveLength(1);

    await plugin.load(true);
    expect(be.to("/api/prs")[0].body.refresh).toBe(true);
    await plugin.loadRunbot(["master"]);
    await plugin.loadMergebot([{ github: "odoo/odoo", number: 1 }]);
    expect(be.to("/api/runbot")[1].body).toEqual({ branches: ["master"], refresh: true });
    expect(be.to("/api/mergebot")[1].body.refresh).toBe(true);
    // an old backend without forward_ports still counts as hydrated (no loop)
    await plugin.loadMergebot([{ github: "odoo/odoo", number: 1 }]);
    expect(be.to("/api/mergebot")).toHaveLength(2);
    expect(plugin.mergebot()["odoo/odoo#1"]).toBe("ready");
  });

  it("refreshStatuses re-scrapes exactly the given branches and PRs", async () => {
    const be = backend({
      "/api/runbot": { states: { feat: { result: "ko", running: false, url: "" } } },
      "/api/mergebot": {
        states: { "odoo/odoo#2": "blocked" },
        forward_ports: { "odoo/odoo#2": [] },
      },
    });
    const { plugin } = makePlugin();
    await plugin.refreshStatuses(["feat"], [{ github: "odoo/odoo", number: 2 }]);
    expect(be.to("/api/runbot")[0].body).toEqual({ branches: ["feat"], refresh: true });
    expect(be.to("/api/mergebot")[0].body.refresh).toBe(true);
    expect(plugin.runbot().feat.result).toBe("ko");
    await plugin.refreshStatuses(null, null);
    expect(be.calls).toHaveLength(2);
  });

  it("a failed runbot / mergebot scrape leaves the badge blank and re-askable", async () => {
    const be = backend({ "/api/runbot": new Fail("down"), "/api/mergebot": new Fail("down") });
    const { plugin } = makePlugin();
    await plugin.loadRunbot(["feat"]);
    await plugin.loadMergebot([{ github: "odoo/odoo", number: 3 }]);
    expect(plugin.runbot()).toEqual({});
    expect(plugin.mergebot()).toEqual({});
    await plugin.loadRunbot(["feat"]);
    await plugin.loadMergebot([{ github: "odoo/odoo", number: 3 }]);
    expect(be.to("/api/runbot")).toHaveLength(2);
    expect(be.to("/api/mergebot")).toHaveLength(2);
  });

  it("surfaces a failed branch / PR fetch as the screen's error, without caching", async () => {
    backend({ "/api/code/branches": new Fail("git exploded"), "/api/prs": new Fail("gh down") });
    const { plugin } = makePlugin();
    await plugin.load();
    expect(plugin.error()).toMatch(/git exploded|gh down/);
    expect(plugin.loading()).toBe(false);
    expect(localStorage.getItem(PRS_CACHE_KEY)).toBeNull();
  });

  it("a failed head-ref lookup is reported as the screen's error", async () => {
    backend({
      "/api/code/branches": { repos: [{ id: "community", branches: [br("feat")] }] },
      "/api/prs": { repos: [] },
      "/api/prs/for-branches": new Fail("rate limited"),
    });
    const { plugin } = makePlugin();
    await plugin.load();
    await tick();
    expect(plugin.error()).toBe("rate limited");
  });

  it("a scoped load only asks for (and only merges) those repos", async () => {
    const be = backend({
      "/api/code/branches": (b: Body) => ({
        repos: (b.repos as { id: string }[]).map((r) => ({
          id: r.id,
          branches: [br(`${r.id}-b`)],
        })),
      }),
      "/api/prs": { repos: [] },
    });
    const { plugin, store } = makePlugin();
    await plugin.load();
    await plugin.load(false, new Set(["enterprise"]), new Set(["enterprise"]));
    expect(be.to("/api/prs")[1].body.repos).toEqual([
      expect.objectContaining({ id: "enterprise" }),
    ]);
    expect(
      store
        .repoStatusList()
        .map((r) => r.id)
        .sort(),
    ).toEqual(["community", "enterprise"]);
  });
});

describe("loadWorkspace(): ten-minute freshness + in-flight sharing", () => {
  const routes = () => ({
    "/api/code/branches": { repos: [{ id: "community", branches: [br("master")] }] },
    "/api/prs": { repos: [{ id: "community", github: "odoo/odoo", prs: [] }] },
  });

  it("skips a workspace refreshed moments ago, but a forced refresh always loads", async () => {
    const be = backend(routes());
    const { plugin } = makePlugin();
    expect(await plugin.loadWorkspace("w1", ["community"])).toBe(true);
    expect(await plugin.loadWorkspace("w1", new Set(["community"]))).toBe(false);
    expect(be.to("/api/code/branches")).toHaveLength(1);
    expect(await plugin.loadWorkspace("w1", ["community"], true)).toBe(true);
    expect(be.to("/api/code/branches")).toHaveLength(2);
  });

  it("joins a pending load, and a manual refresh during it loads again afterwards", async () => {
    const be = backend(routes());
    const { plugin } = makePlugin();
    const a = plugin.loadWorkspace("w1", ["community"]);
    const b = plugin.loadWorkspace("w1", ["community"]);
    expect(b).toBe(a);
    const forced = plugin.loadWorkspace("w1", ["community"], true);
    await Promise.all([a, forced]);
    expect(be.to("/api/code/branches")).toHaveLength(2);
    expect(be.to("/api/prs")[1].body.refresh).toBe(true);
  });
});

describe("branch-state reads", () => {
  it("loadBranches: a full read drops repos gone from config; a scoped one merges", async () => {
    const be = backend({
      "/api/code/branches": (b: Body) => ({
        repos: (b.repos as { id: string }[]).map((r) => ({ id: r.id, branches: [br("x")] })),
      }),
    });
    const { plugin, store } = makePlugin();
    store.mergeRepoStatus([{ id: "gone", branches: [] }], 1, { authoritative: false });
    await plugin.loadBranches(new Set(["community"]));
    expect(be.to("/api/code/branches")[0].body.repos).toEqual([
      expect.objectContaining({ id: "community" }),
    ]);
    expect(
      store
        .repoStatusList()
        .map((r) => r.id)
        .sort(),
    ).toEqual(["community", "gone"]);
    await plugin.loadBranches();
    expect(
      store
        .repoStatusList()
        .map((r) => r.id)
        .sort(),
    ).toEqual(["community", "enterprise"]);
    // no PR fetch: loadBranches is local git only
    expect(be.to("/api/prs")).toHaveLength(0);
  });

  it("loadBranches / refreshBranches report a failed read", async () => {
    backend({ "/api/code/branches": new Fail("nope") });
    const { plugin } = makePlugin();
    await plugin.loadBranches();
    expect(plugin.error()).toBe("nope");
    plugin.error.set("");
    await plugin.refreshBranches(new Set(["community"]));
    expect(plugin.error()).toBe("nope");
  });

  it("refreshBranches keeps the instant-paint cache in step; nothing to refresh asks nothing", async () => {
    localStorage.setItem(PRS_CACHE_KEY, JSON.stringify({ at: 1, branchRepos: [] }));
    const be = backend({
      "/api/code/branches": {
        repos: [{ id: "community", current: "feat", branches: [br("feat")] }],
      },
    });
    const { plugin } = makePlugin();
    await plugin.refreshBranches(new Set(["unknown-repo"]));
    expect(be.calls).toHaveLength(0);
    await plugin.refreshBranches(new Set(["community"]));
    const cached = JSON.parse(localStorage.getItem(PRS_CACHE_KEY)!);
    expect(cached.branchRepos[0]).toMatchObject({ id: "community", current: "feat" });
  });

  it("loadWorktreeBranches reads a worktree's own checkouts into its own rows, sharing an in-flight read", async () => {
    const be = backend({
      "/api/code/branches": (b: Body) => ({
        repos: (b.repos as { id: string }[]).map((r) => ({
          id: r.id,
          current: "wt-feat",
          branches: [],
        })),
      }),
    });
    const { plugin, store } = makePlugin();
    expect(await plugin.loadWorktreeBranches("w1", [])).toBeUndefined();
    const a = plugin.loadWorktreeBranches("w1", [{ id: "enterprise", path: "/wt/w1/enterprise" }]);
    const b = plugin.loadWorktreeBranches("w1", [{ id: "enterprise", path: "/wt/w1/enterprise" }]);
    await Promise.all([a, b]);
    expect(be.to("/api/code/branches")).toHaveLength(1);
    expect(be.to("/api/code/branches")[0].body.repos).toEqual([
      {
        id: "w1:enterprise",
        path: "/wt/w1/enterprise",
        pull_remote: "upstream",
        push_remote: "dev-ent",
      },
    ]);
    expect(store.worktreeRepoStatus("w1", "enterprise")?.current).toBe("wt-feat");
    // the main checkout's row is untouched
    expect(store.repoStatusList()).toEqual([]);
  });

  it("loadWorktreeBranches reports a failed read", async () => {
    backend({ "/api/code/branches": new Fail("no such dir") });
    const { plugin } = makePlugin();
    await plugin.loadWorktreeBranches("w1", [{ id: "community", path: "/wt" }]);
    expect(plugin.error()).toBe("no such dir");
  });
});

describe("checkout / rebase", () => {
  const refreshed: RepoStatusWire = { id: "community", current: "feat", branches: [br("feat")] };

  it("checkout refreshes just the touched repo, and reports per-branch failures", async () => {
    const be = backend({
      "/api/code/checkout": {
        results: [
          { ok: true, branch: "feat" },
          { ok: false, branch: "other", error: "dirty tree" },
        ],
      },
      "/api/code/branches": { repos: [refreshed] },
    });
    const { plugin, store, errors } = makePlugin();
    const p = plugin.checkout([{ repo: "community", path: "/src/community", branch: "feat" }]);
    expect(plugin.busy()).toBe(true);
    expect(plugin.repoWorking("community")).toBe(true);
    await p;
    expect(plugin.busy()).toBe(false);
    expect(plugin.repoWorking("community")).toBe(false);
    expect(errors).toEqual([["Checkout failed", "other: dirty tree"]]);
    expect(be.to("/api/code/branches")[0].body.repos).toEqual([
      expect.objectContaining({ id: "community" }),
    ]);
    expect(store.repoStatusList()[0].current).toBe("feat");
  });

  it("checkout in a worktree refreshes the worktree's own row", async () => {
    const be = backend({
      "/api/code/checkout": { results: [{ ok: true, branch: "feat" }] },
      "/api/code/branches": { repos: [{ ...refreshed, id: "w1:community" }] },
    });
    const { plugin, store } = makePlugin();
    await plugin.checkout([{ repo: "community", path: "/wt/w1/community", branch: "feat" }], "w1");
    expect(be.to("/api/code/branches")[0].body.repos).toEqual([
      expect.objectContaining({ id: "w1:community", path: "/wt/w1/community" }),
    ]);
    expect(store.worktreeRepoStatus("w1", "community")?.current).toBe("feat");
  });

  it("checkout with no repos falls back to a full load; a thrown request is reported", async () => {
    const be = backend({
      "/api/code/checkout": {},
      "/api/code/branches": { repos: [] },
      "/api/prs": { repos: [] },
    });
    const { plugin, errors } = makePlugin();
    await plugin.checkout([]);
    expect(be.to("/api/prs")).toHaveLength(1);
    backend({ "/api/code/checkout": new Fail("boom") });
    await plugin.checkout([{ repo: "community", path: "/src/community", branch: "x" }]);
    expect(errors).toEqual([["Checkout failed", "boom"]]);
    expect(plugin.busy()).toBe(false);
  });

  it("rebase sends each repo's pull remote, logs and reports per-repo failures", async () => {
    const be = backend({
      "/api/code/rebase": { results: [{ ok: false, repo: "enterprise", error: "conflict" }] },
      "/api/code/branches": { repos: [] },
    });
    const { plugin, errors, log } = makePlugin();
    await plugin.rebase([{ repo: "enterprise", path: "/src/enterprise", base: "master" }]);
    expect(be.to("/api/code/rebase")[0].body.repos).toEqual([
      expect.objectContaining({ repo: "enterprise", base: "master", pull_remote: "upstream" }),
    ]);
    expect(log).toContain("fetch & rebase failed: enterprise — conflict");
    expect(errors).toEqual([["Fetch & rebase failed", "enterprise: conflict"]]);
    expect(be.to("/api/code/branches")).toHaveLength(1);
  });

  it("rebase in a worktree / with no repos / on a failed request", async () => {
    let be = backend({ "/api/code/rebase": { results: [] }, "/api/code/branches": { repos: [] } });
    const { plugin, errors, log } = makePlugin();
    await plugin.rebase([{ repo: "community", path: "/wt/w1/community", base: "17.0" }], "w1");
    expect(be.to("/api/code/branches")[0].body.repos).toEqual([
      expect.objectContaining({ id: "w1:community" }),
    ]);
    be = backend({
      "/api/code/rebase": {},
      "/api/code/branches": { repos: [] },
      "/api/prs": { repos: [] },
    });
    await plugin.rebase([]);
    expect(be.to("/api/prs")[0].body.refresh).toBe(true);
    backend({ "/api/code/rebase": new Fail("offline") });
    await plugin.rebase([{ repo: "community", path: "/src/community", base: "master" }]);
    expect(log).toContain("fetch & rebase failed: offline");
    expect(errors).toEqual([["Fetch & rebase failed", "offline"]]);
  });
});

describe("branch / PR mutations", () => {
  function seed(store: StorePlugin) {
    store.mergeRepoStatus([{ id: "community", branches: [br("feat"), br("keep")] }], 1, {
      authoritative: true,
    });
    store.mergePrRepos(
      [
        {
          id: "community",
          github: "odoo/odoo",
          prs: [
            PullRequest.from(
              prWire({
                github: "odoo/odoo",
                number: 5,
                branch: "feat",
                state: "open",
                draft: true,
              }),
            ),
          ],
        },
      ],
      1,
      new Set(["community"]),
    );
  }

  it("deleteBranch: confirm deletes locally + on the push remote, and drops the row", async () => {
    localStorage.setItem(PRS_CACHE_KEY, JSON.stringify({ at: 1, branchRepos: [] }));
    const be = backend({ "/api/code/branches/delete": {} });
    const { plugin, store, dialogs } = makePlugin();
    seed(store);
    await plugin.deleteBranch("feat", "community", "/src/community", true);
    expect(dialogs.open).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("on the dev remote") }),
    );
    expect(be.to("/api/code/branches/delete")[0].body).toEqual({
      path: "/src/community",
      branch: "feat",
      delete_remote: true,
      push_remote: "dev",
    });
    expect(branchNames(store, "community")).toEqual(["keep"]);
    expect(JSON.parse(localStorage.getItem(PRS_CACHE_KEY)!).branchRepos[0].branches).toHaveLength(
      1,
    );
    expect(plugin.busy()).toBe(false);
  });

  it("deleteBranch: cancel sends nothing; a remote failure still drops the local row but says so", async () => {
    const be = backend({ "/api/code/branches/delete": { remote_error: "protected" } });
    const cancelled = makePlugin({ confirm: false });
    await cancelled.plugin.deleteBranch("feat", "community", "/src/unknown");
    expect(be.calls).toHaveLength(0);

    const { plugin, store, errors } = makePlugin();
    seed(store);
    await plugin.deleteBranch("feat", "community", "/src/unknown");
    expect(be.to("/api/code/branches/delete")[0].body.push_remote).toBe("dev"); // default
    expect(errors[0][0]).toBe("Remote branch not deleted");
    expect(errors[0][1]).toContain("protected");
    expect(branchNames(store, "community")).toEqual(["keep"]);
  });

  it("a failed delete keeps the branch and reports it", async () => {
    backend({ "/api/code/branches/delete": new Fail("not merged") });
    const { plugin, store, errors } = makePlugin();
    seed(store);
    await plugin.deleteBranchNoConfirm("feat", "community", "/src/community");
    expect(errors).toEqual([["Delete failed", "not merged"]]);
    expect(branchNames(store, "community")).toEqual(["feat", "keep"]);
  });

  it("closePr: confirm closes it in place; cancel sends nothing", async () => {
    const be = backend({ "/api/prs/close": {} });
    const no = makePlugin({ confirm: false });
    await no.plugin.closePr("odoo/odoo", 5);
    expect(be.calls).toHaveLength(0);

    const { plugin, store } = makePlugin();
    seed(store);
    await plugin.closePr("odoo/odoo", 5);
    expect(be.to("/api/prs/close")[0].body).toEqual({ repo: "odoo/odoo", number: 5 });
    expect(plugin.groups().prIndex["community:feat"].state).toBe("closed");
  });

  it("readyPr flips the draft flag; a failure is reported and keeps it draft", async () => {
    backend({ "/api/prs/ready": {} });
    const { plugin, store, errors } = makePlugin();
    seed(store);
    await plugin.readyPr("odoo/odoo", 5);
    expect(plugin.groups().prIndex["community:feat"].draft).toBe(false);

    backend({ "/api/prs/ready": new Fail("not yours") });
    const other = makePlugin();
    seed(other.store);
    await other.plugin.readyPr("odoo/odoo", 5);
    expect(other.errors).toEqual([["Set PR to ready failed", "not yours"]]);
    expect(other.plugin.groups().prIndex["community:feat"].draft).toBe(true);
    expect(errors).toEqual([]);
  });

  it("postRPlus logs success, or logs + reports a failure", async () => {
    const be = backend({ "/api/prs/r-plus": {} });
    const { plugin, log, errors } = makePlugin();
    expect(await plugin.postRPlus("odoo/odoo", 5)).toBe(true);
    expect(be.to("/api/prs/r-plus")[0].body).toEqual({ repo: "odoo/odoo", number: 5 });
    expect(log).toContain("posted robodoo r+ on PR #5 (odoo/odoo)");
    backend({ "/api/prs/r-plus": new Fail("forbidden") });
    expect(await plugin.postRPlus("odoo/odoo", 5)).toBe(false);
    expect(log).toContain("posting r+ failed: odoo/odoo#5 — forbidden");
    expect(errors).toEqual([["Post r+ failed", "forbidden"]]);
  });

  it("createBranches creates only branches of configured repos, then refreshes those repos", async () => {
    const be = backend({
      "/api/code/branches/create": {
        results: [
          { ok: true, name: "a" },
          { ok: false, name: "b", error: "exists" },
        ],
      },
      "/api/code/branches": { repos: [] },
    });
    const { plugin, errors, log } = makePlugin();
    await plugin.createBranches(null);
    await plugin.createBranches([{ path: "/nowhere", name: "x", startPoint: "master" }]);
    expect(be.calls).toHaveLength(0);
    await plugin.createBranches([
      { path: "/src/enterprise", name: "a", startPoint: "master", freshStart: true },
      { path: "/src/enterprise", name: "b", startPoint: "master" },
      { path: "/nowhere", name: "c", startPoint: "master" },
    ]);
    expect(be.to("/api/code/branches/create")[0].body.branches).toEqual([
      {
        path: "/src/enterprise",
        name: "a",
        start_point: "master",
        fresh_start: true,
        pull_remote: "upstream",
        repo: "enterprise",
      },
      {
        path: "/src/enterprise",
        name: "b",
        start_point: "master",
        fresh_start: false,
        pull_remote: "upstream",
        repo: "enterprise",
      },
    ]);
    expect(log).toContain("creating branch a (enterprise)");
    expect(errors).toEqual([["Create branch failed", "b: exists"]]);
    expect(be.to("/api/code/branches")[0].body.repos).toEqual([
      expect.objectContaining({ id: "enterprise" }),
    ]);
    expect(plugin.repoWorking("enterprise")).toBe(false);
  });

  it("createBranch reports a failed request", async () => {
    backend({ "/api/code/branches/create": new Fail("bad start point") });
    const { plugin, errors } = makePlugin();
    await plugin.createBranch("/src/community", "x", "nope");
    expect(errors).toEqual([["Create branch failed", "bad start point"]]);
    expect(plugin.busy()).toBe(false);
  });

  it("pushBranchNoConfirm pushes to the repo's own push remote, then refreshes that repo", async () => {
    const be = backend({ "/api/code/branch/push": {}, "/api/code/branches": { repos: [] } });
    const { plugin, log } = makePlugin();
    await plugin.pushBranchNoConfirm("/wt/w1/enterprise", "feat", "enterprise", true, true, "w1");
    expect(be.to("/api/code/branch/push")[0].body).toEqual({
      path: "/wt/w1/enterprise",
      branch: "feat",
      force: true,
      push_remote: "dev-ent",
    });
    expect(log).toContain("force-pushing feat (enterprise) to GitHub");
    expect(be.to("/api/code/branches")[0].body.repos).toEqual([
      expect.objectContaining({ id: "w1:enterprise" }),
    ]);
    // no reload, unknown repo: the default remote, no refresh
    await plugin.pushBranchNoConfirm("/x", "feat", "", false);
    expect(be.to("/api/code/branch/push")[1].body.push_remote).toBe("dev");
    expect(be.to("/api/code/branches")).toHaveLength(1);
  });

  it("a rejected push is reported under its verb", async () => {
    backend({ "/api/code/branch/push": new Fail("non-fast-forward") });
    const { plugin, errors } = makePlugin();
    await plugin.pushBranchNoConfirm("/src/community", "feat", "community");
    await plugin.pushBranchNoConfirm("/src/community", "feat", "community", true, true);
    expect(errors).toEqual([
      ["Push failed", "non-fast-forward"],
      ["Force push failed", "non-fast-forward"],
    ]);
  });
});

describe("working-tree actions", () => {
  const cases = [
    ["wipCommit", "/api/code/wip-commit", "WIP commit failed"],
    ["commit", "/api/code/commit", "Commit failed"],
    ["amendCommit", "/api/code/amend", "Amend commit failed"],
  ] as const;

  for (const [method, path, failTitle] of cases) {
    it(`${method} posts, then refreshes the repo (or the worktree's row); failures are reported`, async () => {
      const be = backend({ [path]: {}, "/api/code/branches": { repos: [] } });
      const { plugin, errors } = makePlugin();
      const run = (ws = "") =>
        method === "wipCommit"
          ? plugin.wipCommit("/src/community", "community", ws)
          : plugin[method]("/src/community", "community", "msg", ws);
      await run();
      expect(be.to(path)[0].body.path).toBe("/src/community");
      if (method !== "wipCommit") expect(be.to(path)[0].body.message).toBe("msg");
      expect(be.to("/api/code/branches")[0].body.repos).toEqual([
        expect.objectContaining({ id: "community" }),
      ]);
      await run("w1");
      expect(be.to("/api/code/branches")[1].body.repos).toEqual([
        expect.objectContaining({ id: "w1:community" }),
      ]);
      backend({ [path]: new Fail("hook rejected") });
      await run();
      expect(errors).toEqual([[failTitle, "hook rejected"]]);
      expect(plugin.busy()).toBe(false);
    });
  }

  it("discard asks first; cancel keeps the changes, confirm discards and refreshes", async () => {
    const be = backend({ "/api/code/discard": {}, "/api/code/branches": { repos: [] } });
    const no = makePlugin({ confirm: false });
    await no.plugin.discard("/src/community", "community");
    expect(be.calls).toHaveLength(0);
    const { plugin, errors } = makePlugin();
    await plugin.discard("/src/community", "community");
    expect(be.to("/api/code/discard")[0].body).toEqual({ path: "/src/community" });
    expect(be.to("/api/code/branches")).toHaveLength(1);
    backend({ "/api/code/discard": new Fail("locked") });
    await plugin.discard("/src/community", "community");
    expect(errors).toEqual([["Discard changes failed", "locked"]]);
  });

  it("openEditor launches the configured editor; a failure is logged and reported", async () => {
    const be = backend({ "/api/open-editor": {} });
    const { plugin, errors, log } = makePlugin({ editor: " zed " });
    await plugin.openEditor("/src/community", "community");
    expect(be.to("/api/open-editor")[0].body).toEqual({ editor: "zed", paths: ["/src/community"] });
    const dflt = makePlugin();
    await dflt.plugin.openEditorPaths(["/a", "/b"], "two");
    expect(be.to("/api/open-editor")[1].body).toEqual({ editor: "code", paths: ["/a", "/b"] });
    backend({ "/api/open-editor": new Fail("not found") });
    await plugin.openEditor("/src/community", "community");
    expect(log).toContain("open with editor failed (community): not found");
    expect(errors).toEqual([["Could not open the editor", "not found"]]);
  });
});

describe("history reads + rewrites", () => {
  it("commits / commitMessage / commitDiff return what git said, and throw on a failure", async () => {
    const be = backend({
      "/api/code/log": (b: Body) =>
        b.ref === "empty"
          ? { ok: true, commits: [] }
          : b.ref === "bad"
            ? { ok: false }
            : {
                ok: true,
                commits: [
                  { sha: "1", subject: "[FIX] x", body: b.ref === "multi" ? "details" : "" },
                ],
              },
      "/api/code/commit/diff": (b: Body) =>
        b.sha === "bad" ? { ok: false, error: "no such sha" } : { ok: true },
    });
    const { plugin } = makePlugin();
    const list = await plugin.commits("/src/community", "feat", {
      base: "master",
      pullRemote: "origin",
    });
    expect(list[0].sha).toBe("1");
    expect(be.to("/api/code/log")[0].body).toEqual({
      path: "/src/community",
      ref: "feat",
      base: "master",
      pull_remote: "origin",
      count: 20,
    });
    expect(await plugin.commitMessage("/src/community", "multi")).toBe("[FIX] x\n\ndetails");
    expect(await plugin.commitMessage("/src/community")).toBe("[FIX] x");
    expect(await plugin.commitMessage("/src/community", "empty")).toBe("");
    await expect(plugin.commits("/src/community", "bad")).rejects.toThrow("git log failed");
    expect(await plugin.commitDiff("/src/community", "1")).toBe("");
    await expect(plugin.commitDiff("/src/community", "bad")).rejects.toThrow("no such sha");
  });

  it("remoteExists asks with the repo's push remote", async () => {
    const be = backend({ "/api/code/branch/remote": { exists: true } });
    const { plugin } = makePlugin();
    expect(await plugin.remoteExists("/src/enterprise", "feat")).toBe(true);
    expect(be.to("/api/code/branch/remote")[0].body).toEqual({
      path: "/src/enterprise",
      branch: "feat",
      push_remote: "dev-ent",
    });
  });

  it("rewordCommit / abortRebase / rebaseStatus throw git's error on failure", async () => {
    backend({
      "/api/code/reword": { ok: false, error: "not ahead" },
      "/api/code/rebase-abort": { ok: false },
      "/api/code/rebase-status": { ok: false },
    });
    const { plugin } = makePlugin();
    await expect(plugin.rewordCommit("/p", "1", "m")).rejects.toThrow("not ahead");
    await expect(plugin.abortRebase("/p")).rejects.toThrow("git rebase --abort failed");
    await expect(plugin.rebaseStatus("/p")).rejects.toThrow("couldn't check rebase status");
    const be = backend({
      "/api/code/reword": { ok: true },
      "/api/code/rebase-abort": { ok: true },
      "/api/code/rebase-status": { ok: true, in_progress: true },
    });
    await plugin.rewordCommit("/p", "1", "m", { base: "master", pullRemote: "origin" });
    expect(be.to("/api/code/reword")[0].body).toEqual({
      path: "/p",
      sha: "1",
      message: "m",
      base: "master",
      pull_remote: "origin",
    });
    await plugin.abortRebase("/p");
    expect(await plugin.rebaseStatus("/p")).toBe(true);
  });

  it("rewriteHistory flags a conflict left mid-rebase apart from a validation failure", async () => {
    const plan = [{ sha: "1" }, { sha: "2", squash: true }];
    const be = backend({
      "/api/code/rebase-plan": new Fail("conflict in x.py", { in_progress: true }),
    });
    const { plugin } = makePlugin();
    await expect(plugin.rewriteHistory("/p", "master", plan)).rejects.toMatchObject({
      message: "conflict in x.py",
      inProgress: true,
    });
    expect(be.to("/api/code/rebase-plan")[0].body).toEqual({
      path: "/p",
      base: "master",
      plan,
      pull_remote: "",
    });
    backend({ "/api/code/rebase-plan": new Fail("plan mismatch") });
    await expect(plugin.rewriteHistory("/p", "master", plan)).rejects.toMatchObject({
      inProgress: false,
    });
    backend({ "/api/code/rebase-plan": { ok: true } });
    await expect(plugin.rewriteHistory("/p", "master", plan, "origin")).resolves.toBeUndefined();
  });
});
