import { describe, expect, it } from "vitest";
import { prKey, branchKey, PullRequest } from "../../src/core/models.js";

describe("prKey / branchKey", () => {
  it("builds the canonical identities", () => {
    expect(prKey("odoo/odoo", 12345)).toBe("odoo/odoo#12345");
    expect(branchKey("community", "master-x-jpp")).toBe("community:master-x-jpp");
  });
});

describe("PullRequest.from", () => {
  it("normalizes snake_case wire fields to camelCase and lowercases state", () => {
    const pr = PullRequest.from({
      github: "odoo/odoo",
      number: 42,
      title: "fix: thing",
      url: "https://github.com/odoo/odoo/pull/42",
      state: "OPEN",
      draft: true,
      branch: "master-x-jpp",
      relation: "authored",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      ci: { state: "success" },
    });
    expect(pr).toEqual({
      github: "odoo/odoo",
      number: 42,
      title: "fix: thing",
      url: "https://github.com/odoo/odoo/pull/42",
      state: "open",
      draft: true,
      branch: "master-x-jpp",
      relation: "authored",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      ci: { state: "success" },
      key: "odoo/odoo#42",
    });
  });

  it("defaults missing optional fields instead of leaving them undefined", () => {
    const pr = PullRequest.from({ number: 7 });
    expect(pr.github).toBe("");
    expect(pr.title).toBe("");
    expect(pr.url).toBe("");
    expect(pr.state).toBe("");
    expect(pr.draft).toBe(false);
    expect(pr.branch).toBe("");
    expect(pr.relation).toBe("");
    expect(pr.createdAt).toBe("");
    expect(pr.updatedAt).toBe("");
    expect(pr.ci).toBeNull();
    expect(pr.key).toBe("#7");
  });
});
