import { describe, expect, it } from "vitest";
import { ORM } from "../../../vendor/owl-orm/index.ts";
import {
  Repository,
  Workspace,
  Checkout,
  repoUrls,
  nextFreePort,
  RESERVED_PORTS,
  workspaceFromTarget,
  toModels,
  toConfig,
  toState,
  applyPatch,
} from "../../src/core/config_models.js";

function baseConfig(over = {}) {
  return {
    repos: [{ id: "community", path: "/main/community", github: "odoo/odoo", favorite: true }],
    workspaces: [
      {
        id: "w1",
        name: "feature",
        location: "main",
        checkouts: [{ repo: "community", branch: "17.0-feature-jpp" }],
      },
    ],
    templates: [],
    ...over,
  };
}

describe("toModels / toConfig round trip", () => {
  it("repos, workspaces (with checkouts) and settings survive a round trip unchanged", () => {
    const orm = new ORM();
    toModels(orm, baseConfig({ db_user: "odoo", auto_open_event_log: true }));
    const out = toConfig(orm);

    expect(out.db_user).toBe("odoo");
    expect(out.auto_open_event_log).toBe(true);
    expect(out.repos).toEqual([
      expect.objectContaining({
        id: "community",
        path: "/main/community",
        github: "odoo/odoo",
        favorite: true,
      }),
    ]);
    expect(out.workspaces).toEqual([
      expect.objectContaining({
        id: "w1",
        name: "feature",
        location: "main",
        checkouts: [{ repo: "community", branch: "17.0-feature-jpp" }],
      }),
    ]);
  });

  it("repo pull_remote/push_remote default to origin/dev when blank (pre-existing configs)", () => {
    const orm = new ORM();
    toModels(orm, baseConfig());
    const rec = orm.records(Repository)[0];
    expect(rec.pullRemote()).toBe("origin");
    expect(rec.pushRemote()).toBe("dev");
    expect(toConfig(orm).repos[0].pull_remote).toBe("origin");
  });

  it("hide_start_controls migrates once into launch_mode when launch_mode is unset", () => {
    const orm = new ORM();
    toModels(orm, baseConfig({ hide_start_controls: true }));
    expect(toConfig(orm).launch_mode).toBe("external");
  });

  it("toState round-trips the app-state blob", () => {
    const orm = new ORM();
    toModels(orm, baseConfig(), { active_workspace: "w1", test_history: [{ ok: true }] });
    expect(toState(orm)).toEqual({
      active_workspace: "w1",
      claude_model: "",
      test_history: [{ ok: true }],
    });
  });
});

describe("applyPatch", () => {
  it("patches settings fields present in the patch, leaves the rest untouched", () => {
    const orm = new ORM();
    toModels(orm, baseConfig({ db_user: "odoo" }));
    applyPatch(orm, { db_user: "other" });
    const out = toConfig(orm);
    expect(out.db_user).toBe("other");
    expect(out.repos).toHaveLength(1); // untouched
  });

  it("reconciles repos: updates existing, creates new, deletes removed", () => {
    const orm = new ORM();
    toModels(orm, baseConfig());
    applyPatch(orm, {
      repos: [
        { id: "community", path: "/main/community", favorite: false },
        { id: "enterprise", path: "/main/enterprise" },
      ],
    });
    const out = toConfig(orm);
    expect(out.repos.map((r) => r.id).sort()).toEqual(["community", "enterprise"]);
    expect(out.repos.find((r) => r.id === "community").favorite).toBe(false);
  });

  it("reconciles workspace checkouts (o2m) when a workspace is patched", () => {
    const orm = new ORM();
    toModels(orm, baseConfig());
    applyPatch(orm, {
      workspaces: [
        {
          id: "w1",
          name: "feature",
          location: "main",
          checkouts: [{ repo: "community", branch: "renamed-branch" }],
        },
      ],
    });
    expect(toConfig(orm).workspaces[0].checkouts).toEqual([
      { repo: "community", branch: "renamed-branch" },
    ]);
  });

  it("deleting a workspace also deletes its checkouts (o2m is unlinked, not cascaded automatically)", () => {
    const orm = new ORM();
    toModels(orm, baseConfig());
    expect(orm.records(Checkout)).toHaveLength(1);
    applyPatch(orm, { workspaces: [] });
    expect(orm.records(Workspace)).toHaveLength(0);
    expect(orm.records(Checkout)).toHaveLength(0);
  });

  it("a dangling parent (referenced workspace removed) is healed by demoting the child to root", () => {
    const orm = new ORM();
    toModels(
      orm,
      baseConfig({
        workspaces: [
          { id: "w1", name: "parent", location: "main", checkouts: [] },
          { id: "w2", name: "child", location: "main", parent: "w1", checkouts: [] },
        ],
      }),
    );
    applyPatch(orm, { workspaces: [{ id: "w2", name: "child", location: "main", checkouts: [] }] });
    expect(orm.getById(Workspace, "w2").parent()).toBe("");
  });

  it("reordering workspaces in a patch persists the new order in toConfig (regression: order used to not survive)", () => {
    const orm = new ORM();
    toModels(
      orm,
      baseConfig({
        workspaces: [
          { id: "a", name: "a", location: "main", checkouts: [] },
          { id: "b", name: "b", location: "main", checkouts: [] },
        ],
      }),
    );
    applyPatch(orm, {
      workspaces: [
        { id: "b", name: "b", location: "main", checkouts: [] },
        { id: "a", name: "a", location: "main", checkouts: [] },
      ],
    });
    expect(toConfig(orm).workspaces.map((w) => w.id)).toEqual(["b", "a"]);
  });

  it("reordering preserves each workspace's port/created_at across the rebuild", () => {
    const orm = new ORM();
    toModels(
      orm,
      baseConfig({
        workspaces: [
          { id: "a", name: "a", location: "worktree", port: 8071, created_at: "t1", checkouts: [] },
          { id: "b", name: "b", location: "worktree", port: 8072, created_at: "t2", checkouts: [] },
        ],
      }),
    );
    applyPatch(orm, {
      workspaces: [
        { id: "b", name: "b", location: "worktree", checkouts: [] },
        { id: "a", name: "a", location: "worktree", checkouts: [] },
      ],
    });
    const out = toConfig(orm);
    expect(out.workspaces.find((w) => w.id === "a").port).toBe(8071);
    expect(out.workspaces.find((w) => w.id === "b").port).toBe(8072);
  });

  it("reconciles templates, including order-only patches", () => {
    const orm = new ORM();
    toModels(orm, baseConfig());
    applyPatch(orm, {
      templates: [
        { id: "t1", name: "one", checkouts: [] },
        { id: "t2", name: "two", checkouts: [] },
      ],
    });
    expect(toConfig(orm).templates.map((t) => t.id)).toEqual(["t1", "t2"]);
    applyPatch(orm, {
      templates: [
        { id: "t2", name: "two", checkouts: [] },
        { id: "t1", name: "one", checkouts: [] },
      ],
    });
    expect(toConfig(orm).templates.map((t) => t.id)).toEqual(["t2", "t1"]);
  });
});

describe("Workspace pure derivations", () => {
  it("isWorktree() reads the explicit location, falling back to worktree metadata presence", () => {
    const orm = new ORM();
    toModels(orm, baseConfig());
    expect(orm.getById(Workspace, "w1").isWorktree()).toBe(false);
  });

  it("hasMainRepo() checks against Settings.main_repo_id, defaulting to 'community'", () => {
    const orm = new ORM();
    toModels(orm, baseConfig(), {});
    expect(orm.getById(Workspace, "w1").hasMainRepo()).toBe(true);

    const orm2 = new ORM();
    toModels(orm2, baseConfig({ main_repo_id: "odoo" }));
    // "community" repo id doesn't match main_repo_id "odoo" — no main repo
    expect(orm2.getById(Workspace, "w1").hasMainRepo()).toBe(false);
  });

  it("descendants() walks the parent chain breadth-first and guards against cycles", () => {
    const orm = new ORM();
    toModels(
      orm,
      baseConfig({
        workspaces: [
          { id: "root", name: "root", location: "main", checkouts: [] },
          { id: "child1", name: "c1", location: "main", parent: "root", checkouts: [] },
          { id: "grandchild", name: "gc", location: "main", parent: "child1", checkouts: [] },
        ],
      }),
    );
    const ids = orm
      .getById(Workspace, "root")
      .descendants()
      .map((w) => w.id);
    expect(ids).toEqual(["child1", "grandchild"]);
  });
});

describe("Repository pure URL builders", () => {
  it("githubOrDefault falls back to the built-in default when unset", () => {
    const orm = new ORM();
    toModels(orm, baseConfig({ repos: [{ id: "community", path: "/x", github: "" }] }));
    expect(orm.getById(Repository, "community").githubOrDefault()).toBe("odoo/odoo");
  });

  it("compareUrl uses the resolved push slug when given, else falls back to odoo-dev", () => {
    expect(repoUrls.compare("odoo/odoo", "17.0-x-jpp", "myfork/odoo")).toBe(
      "https://github.com/odoo/odoo/compare/17.0...myfork:odoo:17.0-x-jpp?expand=1",
    );
    expect(repoUrls.compare("odoo/odoo", "17.0-x-jpp")).toContain("odoo-dev:odoo");
  });

  it("remote() sends a base branch to the canonical repo, a work branch to the fork", () => {
    expect(repoUrls.remote("odoo/odoo", "17.0")).toBe("https://github.com/odoo/odoo/tree/17.0");
    expect(repoUrls.remote("odoo/odoo", "17.0-x-jpp")).toContain("odoo-dev/odoo/tree/");
  });
});

describe("nextFreePort / workspaceFromTarget / RESERVED_PORTS", () => {
  it("nextFreePort skips reserved ports and ports already claimed by a workspace", () => {
    const orm = new ORM();
    orm.create(Workspace, { id: "w1", port: 8070 });
    expect(nextFreePort(orm)).toBe(8071);
    expect(RESERVED_PORTS).toEqual([8069, 8072]);
  });

  it("workspaceFromTarget maps a legacy target's kind/worktree into location", () => {
    expect(workspaceFromTarget({ id: "t1", worktree: { dir: "/x" } }).location).toBe("worktree");
    expect(workspaceFromTarget({ id: "t1" }).location).toBe("main");
    expect(workspaceFromTarget({ id: "t1", kind: "worktree" }).location).toBe("worktree");
  });
});
