import { describe, expect, it } from "vitest";
import {
  categoryOptions,
  templatePrefill,
  findSubWorkspace,
} from "../../src/workspaces_screen/dialogs.js";
import { ARCHIVED_CATEGORY } from "../../src/core/config.js";

describe("categoryOptions", () => {
  it("maps configured categories to {value, label} and appends archived", () => {
    const config = { config: { workspace_categories: [{ id: "dev" }, { id: "base" }] } };
    expect(categoryOptions(config)).toEqual([
      { value: "dev", label: "dev" },
      { value: "base", label: "base" },
      { value: ARCHIVED_CATEGORY, label: ARCHIVED_CATEGORY },
    ]);
  });

  it("doesn't duplicate archived if it's already configured", () => {
    const config = { config: { workspace_categories: [{ id: ARCHIVED_CATEGORY }] } };
    expect(categoryOptions(config)).toEqual([
      { value: ARCHIVED_CATEGORY, label: ARCHIVED_CATEGORY },
    ]);
  });

  it("handles no configured categories at all", () => {
    const config = { config: {} };
    expect(categoryOptions(config)).toEqual([
      { value: ARCHIVED_CATEGORY, label: ARCHIVED_CATEGORY },
    ]);
  });
});

describe("templatePrefill", () => {
  it("returns an empty object for no template", () => {
    expect(templatePrefill(null)).toEqual({});
    expect(templatePrefill(undefined)).toEqual({});
  });

  it("prefers enterprise's branch over community's for the name", () => {
    const tpl = {
      id: "t1",
      checkouts: [
        { repo: "community", branch: "master-x" },
        { repo: "enterprise", branch: "master-x-ent" },
      ],
      db: "mydb",
      on_create_args: "-i sale",
      demo_data: false,
      category: "dev",
    };
    const result = templatePrefill(tpl);
    expect(result.template).toBe("t1");
    expect(result.name).toBe("master-x-ent");
    expect(result.db).toBe("mydb");
    expect(result.args).toBe("-i sale");
    expect(result.demoData).toBe(false);
    expect(result.category).toBe("dev");
  });

  it("falls back to community's branch when there's no enterprise checkout", () => {
    const tpl = { id: "t1", checkouts: [{ repo: "community", branch: "master-x" }] };
    expect(templatePrefill(tpl).name).toBe("master-x");
  });

  it("defaults name to empty, demoData to true, db/args/category to empty when unset", () => {
    const tpl = { id: "t1", checkouts: [] };
    const result = templatePrefill(tpl);
    expect(result.name).toBe("");
    expect(result.demoData).toBe(true);
    expect(result.db).toBe("");
    expect(result.args).toBe("");
    expect(result.category).toBe("");
  });
});

describe("findSubWorkspace", () => {
  const parentWs = { id: "parent1" };
  const row = { branch: "master-feature" };

  it("finds a child workspace whose checkout is a forward-port of row.branch", () => {
    const config = {
      config: {
        workspaces: [
          {
            id: "child1",
            parent: "parent1",
            checkouts: [{ repo: "community", branch: "master-feature-18.0-fw" }],
          },
        ],
      },
    };
    expect(findSubWorkspace(config, parentWs, row)).toBe(config.config.workspaces[0]);
  });

  it("returns null when no child matches the parent id", () => {
    const config = {
      config: {
        workspaces: [
          {
            id: "child1",
            parent: "other-parent",
            checkouts: [{ repo: "community", branch: "master-feature-18.0-fw" }],
          },
        ],
      },
    };
    expect(findSubWorkspace(config, parentWs, row)).toBeNull();
  });

  it("returns null when a matching child has no forward-port-shaped checkout", () => {
    const config = {
      config: {
        workspaces: [
          {
            id: "child1",
            parent: "parent1",
            checkouts: [{ repo: "community", branch: "unrelated" }],
          },
        ],
      },
    };
    expect(findSubWorkspace(config, parentWs, row)).toBeNull();
  });

  it("returns null when there are no workspaces at all", () => {
    expect(findSubWorkspace({ config: {} }, parentWs, row)).toBeNull();
  });

  it("requires the branch to both start with row.branch- and end with -fw", () => {
    const config = {
      config: {
        workspaces: [
          {
            id: "child1",
            parent: "parent1",
            checkouts: [{ repo: "community", branch: "master-feature-18.0" }], // no -fw suffix
          },
        ],
      },
    };
    expect(findSubWorkspace(config, parentWs, row)).toBeNull();
  });
});
