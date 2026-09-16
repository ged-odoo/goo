import { describe, expect, it } from "vitest";
import { StorePlugin } from "../../src/core/store_plugin.js";
import { newPlugin } from "../helpers/plugin.js";

function repo(id, over = {}) {
  return { id, current: "master", dirty: false, branches: [], ahead: 0, behind: 0, ...over };
}

describe("StorePlugin", () => {
  it("mergeRepoStatus creates then updates a repo, latest fetchedAt wins", () => {
    const store = newPlugin(StorePlugin);
    store.mergeRepoStatus([repo("community", { current: "master" })], 1);
    expect(store.repoStatusList()).toEqual([
      expect.objectContaining({ id: "community", current: "master", fetchedAt: 1 }),
    ]);

    // a stale response (older fetchedAt) can't clobber a fresher one
    store.mergeRepoStatus([repo("community", { current: "stale" })], 0);
    expect(store.repoStatusList()[0].current).toBe("master");

    store.mergeRepoStatus([repo("community", { current: "feature-x" })], 2);
    expect(store.repoStatusList()[0]).toEqual(
      expect.objectContaining({ current: "feature-x", fetchedAt: 2 }),
    );
  });

  it("mergeRepoStatus authoritative fetch drops repos that vanished from scope", () => {
    const store = newPlugin(StorePlugin);
    store.mergeRepoStatus([repo("community"), repo("enterprise")], 1, { authoritative: true });
    expect(
      store
        .repoStatusList()
        .map((r) => r.id)
        .sort(),
    ).toEqual(["community", "enterprise"]);

    store.mergeRepoStatus([repo("community")], 2, { authoritative: true });
    expect(store.repoStatusList().map((r) => r.id)).toEqual(["community"]);
  });

  it("mergeRepoStatus non-authoritative never drops repos", () => {
    const store = newPlugin(StorePlugin);
    store.mergeRepoStatus([repo("community"), repo("enterprise")], 1, { authoritative: true });
    store.mergeRepoStatus([repo("community")], 2); // no authoritative flag
    expect(
      store
        .repoStatusList()
        .map((r) => r.id)
        .sort(),
    ).toEqual(["community", "enterprise"]);
  });

  it("dropBranch removes a branch from a repo's snapshot without a refetch", () => {
    const store = newPlugin(StorePlugin);
    store.mergeRepoStatus([repo("community", { branches: [{ name: "a" }, { name: "b" }] })], 1);
    store.dropBranch("community", "a");
    expect(store.repoStatusList()[0].branches).toEqual([{ name: "b" }]);
  });

  it("mergeMergebot creates a record from state/detail/forwardPorts arriving separately", () => {
    const store = newPlugin(StorePlugin);
    store.mergeMergebot({ "odoo/odoo#1": "merged" }, {}, {});
    expect(store.mergebot()).toEqual({ "odoo/odoo#1": "merged" });

    store.mergeMergebot({}, { "odoo/odoo#1": "some detail" }, {});
    expect(store.mbDetails()).toEqual({ "odoo/odoo#1": "some detail" });
    // state from the first call is preserved — merge, not replace
    expect(store.mergebot()).toEqual({ "odoo/odoo#1": "merged" });
  });

  it("closePr marks a PR closed in place, readyPr clears draft", () => {
    const store = newPlugin(StorePlugin);
    store.mergePrRepos(
      [{ id: "community", github: "odoo/odoo", prs: [{ number: 1, state: "open", draft: true }] }],
      1,
      new Set(["community"]),
    );
    store.closePr("odoo/odoo", 1);
    expect(store.prReposList()[0].prs[0].state).toBe("closed");
    store.readyPr("odoo/odoo", 1);
    expect(store.prReposList()[0].prs[0].draft).toBe(false);
  });

  it("mergePrRepos is authoritative only within scopeIds (a narrowed fetch doesn't drop repos outside its scope)", () => {
    const store = newPlugin(StorePlugin);
    store.mergePrRepos(
      [
        { id: "community", github: "odoo/odoo", prs: [] },
        { id: "enterprise", github: "odoo/enterprise", prs: [] },
      ],
      1,
      new Set(["community", "enterprise"]),
    );
    // a later fetch scoped only to "community" must not drop "enterprise"
    store.mergePrRepos(
      [{ id: "community", github: "odoo/odoo", prs: [] }],
      2,
      new Set(["community"]),
    );
    expect(
      store
        .prReposList()
        .map((r) => r.id)
        .sort(),
    ).toEqual(["community", "enterprise"]);
  });

  it("mergeServer spread-merges a partial snapshot, preserving fields the update omits", () => {
    const store = newPlugin(StorePlugin);
    store.mergeServer({ id: "main", state: "running", db: "foo", exists: true });
    store.mergeServer({ id: "main", state: "stopped" }); // partial: no db/exists
    expect(store.server("main")).toEqual({ id: "main", state: "stopped", db: "foo", exists: true });
  });

  it("dropServer forgets a server record", () => {
    const store = newPlugin(StorePlugin);
    store.mergeServer({ id: "wt1", state: "running" });
    store.dropServer("wt1");
    expect(store.server("wt1")).toBeNull();
  });

  it("serverFor returns the main process only when it's actually running this target", () => {
    const store = newPlugin(StorePlugin);
    store.mergeServer({ id: "main", state: "running", workspace: "wt1" });
    store.mergeServer({ id: "wt1", state: "stopped" });
    expect(store.serverFor({ id: "wt1" })).toEqual(
      expect.objectContaining({ id: "main", state: "running" }),
    );

    store.mergeServer({ id: "main", state: "stopped", workspace: "wt1" });
    expect(store.serverFor({ id: "wt1" })).toEqual(expect.objectContaining({ id: "wt1" }));
  });

  it("activeRun/latestRunOfKind scope by slot and pick the most recent finished run", () => {
    const store = newPlugin(StorePlugin);
    store.mergeRun({ id: "r1", state: "done", kind: "test", server: "main", started_at: 1 });
    store.mergeRun({ id: "r2", state: "running", kind: "test", server: "main", started_at: 2 });
    expect(store.activeRun("main").id).toBe("r2");
    expect(store.activeRun("wt1")).toBeNull();

    store.mergeRun({ id: "r2", state: "done", kind: "test", server: "main", started_at: 2 });
    expect(store.activeRun("main")).toBeNull();
    expect(store.latestRunOfKind("test", "main").id).toBe("r2");
  });

  it("workspaceView joins checkouts' live branch state, server and active run", () => {
    const store = newPlugin(StorePlugin);
    store.mergeRepoStatus([repo("community", { current: "master", dirty: false })], 1);
    store.mergeServer({ id: "main", state: "running", workspace: "w1" });
    store.mergeRun({ id: "r1", state: "running", kind: "test", server: "main", workspace: "w1" });
    const tgt = {
      id: "w1",
      location: "main",
      checkouts: [{ repo: "community", branch: "master" }],
    };
    const view = store.workspaceView(tgt);
    expect(view.checkouts).toEqual([
      { repo: "community", branch: "master", current: "master", matches: true, dirty: false },
    ]);
    expect(view.server).toEqual(expect.objectContaining({ id: "main" }));
    expect(view.run.id).toBe("r1");
  });

  it("workspaceView uses the worktree-scoped row (not the main RepoStatus) for a worktree workspace", () => {
    const store = newPlugin(StorePlugin);
    store.mergeRepoStatus([repo("community", { current: "master" })], 1); // main checkout state
    store.mergeWorktreeRepoStatus([{ id: "w1:community", current: "feature-x", dirty: true }], 1);
    const tgt = {
      id: "w1",
      location: "worktree",
      checkouts: [{ repo: "community", branch: "feature-x" }],
    };
    const view = store.workspaceView(tgt);
    expect(view.checkouts[0]).toEqual(
      expect.objectContaining({ current: "feature-x", matches: true, dirty: true }),
    );
  });

  it("drift finds main-located checkouts whose configured branch isn't actually checked out, ignores worktrees and not-yet-loaded repos", () => {
    const store = newPlugin(StorePlugin);
    store.mergeRepoStatus([repo("community", { current: "master" })], 1);
    const mismatched = {
      id: "w1",
      location: "main",
      checkouts: [
        { repo: "community", branch: "feature-x" }, // configured feature-x, actually on master
        { repo: "enterprise", branch: "feature-x" }, // enterprise never fetched — unknown, not drift
      ],
    };
    expect(store.drift(mismatched)).toEqual([
      expect.objectContaining({ repo: "community", matches: false }),
    ]);

    const wt = { ...mismatched, location: "worktree" };
    expect(store.drift(wt)).toEqual([]); // worktrees are immune by construction
  });

  it("dropWorktreeRepoStatusFor removes every composite row for a removed workspace, leaving others", () => {
    const store = newPlugin(StorePlugin);
    store.mergeWorktreeRepoStatus(
      [
        { id: "w1:community", current: "a" },
        { id: "w1:enterprise", current: "b" },
        { id: "w2:community", current: "c" },
      ],
      1,
    );
    store.dropWorktreeRepoStatusFor("w1");
    expect(store.worktreeRepoStatus("w1", "community")).toBeNull();
    expect(store.worktreeRepoStatus("w1", "enterprise")).toBeNull();
    expect(store.worktreeRepoStatus("w2", "community")).not.toBeNull();
  });

  it("mergeRunbot creates then updates a status by branch key", () => {
    const store = newPlugin(StorePlugin);
    store.mergeRunbot({ "master-x": "success" });
    expect(store.runbot()).toEqual({ "master-x": "success" });
    store.mergeRunbot({ "master-x": "failure" });
    expect(store.runbot()).toEqual({ "master-x": "failure" });
  });
});
