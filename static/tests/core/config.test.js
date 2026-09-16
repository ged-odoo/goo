import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, SECTIONS, baseBranchOf, defaultDemoData } from "../../src/core/config.js";

describe("baseBranchOf", () => {
  it("extracts the series prefix from a work branch", () => {
    expect(baseBranchOf("16.0-owl-fix")).toBe("16.0");
    expect(baseBranchOf("saas-19.4-x")).toBe("saas-19.4");
    expect(baseBranchOf("18.0")).toBe("18.0");
  });

  it("matches a bare 'master' prefix", () => {
    expect(baseBranchOf("master-something")).toBe("master");
    expect(baseBranchOf("master")).toBe("master");
  });

  it("falls back to master for anything unrecognized", () => {
    expect(baseBranchOf("some-random-branch")).toBe("master");
  });
});

describe("defaultDemoData", () => {
  it("is on for series before 19.0", () => {
    expect(defaultDemoData("16.0-owl-fix")).toBe(true);
    expect(defaultDemoData("18.0")).toBe(true);
  });

  it("is off for master and 19.0+", () => {
    expect(defaultDemoData("master")).toBe(false);
    expect(defaultDemoData("19.0-fix")).toBe(false);
    expect(defaultDemoData("saas-19.4-x")).toBe(false);
  });
});

describe("DEFAULT_CONFIG / SECTIONS shape", () => {
  it("SECTIONS lists every screen id, including the merged branches screen", () => {
    expect(SECTIONS).toContain("workspaces");
    expect(SECTIONS).toContain("branches");
    expect(SECTIONS).toContain("config");
  });

  it("DEFAULT_CONFIG has the expected top-level shape", () => {
    expect(typeof DEFAULT_CONFIG.main_repo_id).toBe("string");
    expect(Array.isArray(DEFAULT_CONFIG.repos)).toBe(true);
    expect(DEFAULT_CONFIG.repos.length).toBeGreaterThan(0);
    expect(Array.isArray(DEFAULT_CONFIG.targets)).toBe(true);
    expect(DEFAULT_CONFIG.workspaces).toEqual([]);
    expect(DEFAULT_CONFIG.templates).toEqual([]);
    expect(DEFAULT_CONFIG.start).toHaveProperty("repos");
  });

  it("every repo entry has an id and a path", () => {
    for (const r of DEFAULT_CONFIG.repos) {
      expect(typeof r.id).toBe("string");
      expect(typeof r.path).toBe("string");
    }
  });
});
