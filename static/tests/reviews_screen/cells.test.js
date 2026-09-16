import { describe, expect, it } from "vitest";
import {
  isMerged,
  statusKey,
  worstStatusKey,
  taskFullyMerged,
} from "../../src/reviews_screen/cells.js";

describe("isMerged", () => {
  it("is true when mergebot's own scraped state says merged, even if GitHub state doesn't", () => {
    // mergebot pushes+closes rather than using GitHub's merge button, so GitHub's
    // row.state stays "closed" for an actually-merged PR — mbState is authoritative
    expect(isMerged({ state: "closed" }, "merged")).toBe(true);
  });

  it("is true when GitHub's own state says merged (rare hand-merge fallback)", () => {
    expect(isMerged({ state: "merged" }, "")).toBe(true);
  });

  it("is false otherwise", () => {
    expect(isMerged({ state: "open" }, "")).toBe(false);
    expect(isMerged({ state: "closed" }, "")).toBe(false);
  });
});

describe("statusKey", () => {
  it("merged outranks everything, including an r+'d mbState", () => {
    // mbIsRPlus(mbState="merged", ...) is also true, so merged must be checked first
    expect(statusKey({ state: "open" }, "merged", "")).toBe("merged");
  });

  it("rplus when mbState is r+'d and not itself a review request", () => {
    expect(statusKey({ state: "open" }, "approved", "")).toBe("rplus");
  });

  it("not rplus when mbDetail mentions a review request", () => {
    expect(statusKey({ state: "open" }, "approved", "review requested from @bob")).toBe(
      "to_review",
    );
  });

  it("reviewed when reviewStatus says reviewed and not merged/rplus", () => {
    expect(statusKey({ state: "open", reviewStatus: "reviewed" }, "", "")).toBe("reviewed");
  });

  it("falls back to to_review", () => {
    expect(statusKey({ state: "open", reviewStatus: "to_review" }, "", "")).toBe("to_review");
  });
});

describe("worstStatusKey", () => {
  it("picks the least-done key across a set", () => {
    expect(worstStatusKey(["merged", "rplus", "to_review"])).toBe("to_review");
    // precedence order is to_review < reviewed < rplus < merged, so "reviewed"
    // is worse (less done) than "rplus" here, not the other way around
    expect(worstStatusKey(["merged", "rplus", "reviewed"])).toBe("reviewed");
    expect(worstStatusKey(["merged", "merged"])).toBe("merged");
  });

  it("defaults to merged (best) for an empty set", () => {
    expect(worstStatusKey([])).toBe("merged");
  });
});

describe("taskFullyMerged", () => {
  function fakeCode(mergebot, mbForwardPorts) {
    return { mergebot: () => mergebot, mbForwardPorts: () => mbForwardPorts };
  }

  it("false if any row itself isn't merged", () => {
    const rows = [{ github: "odoo/odoo", number: 1, state: "open" }];
    expect(taskFullyMerged(rows, fakeCode({}, {}))).toBe(false);
  });

  it("true if merged with no forward ports", () => {
    const rows = [{ github: "odoo/odoo", number: 1, state: "merged" }];
    expect(taskFullyMerged(rows, fakeCode({}, {}))).toBe(true);
  });

  it("false if a forward port has no pull opened yet", () => {
    const rows = [{ github: "odoo/odoo", number: 1, state: "merged" }];
    const mbForwardPorts = { "odoo/odoo#1": [{ branch: "18.0", cells: [] }] };
    expect(taskFullyMerged(rows, fakeCode({}, mbForwardPorts))).toBe(false);
  });

  it("false if a forward port's pull isn't itself merged", () => {
    const rows = [{ github: "odoo/odoo", number: 1, state: "merged" }];
    const mbForwardPorts = {
      "odoo/odoo#1": [{ branch: "18.0", cells: [{ pulls: [{ github: "odoo/odoo", number: 2 }] }] }],
    };
    const mergebot = { "odoo/odoo#2": "open" };
    expect(taskFullyMerged(rows, fakeCode(mergebot, mbForwardPorts))).toBe(false);
  });

  it("true when every row and every forward-port pull is merged", () => {
    const rows = [{ github: "odoo/odoo", number: 1, state: "merged" }];
    const mbForwardPorts = {
      "odoo/odoo#1": [{ branch: "18.0", cells: [{ pulls: [{ github: "odoo/odoo", number: 2 }] }] }],
    };
    const mergebot = { "odoo/odoo#2": "merged" };
    expect(taskFullyMerged(rows, fakeCode(mergebot, mbForwardPorts))).toBe(true);
  });
});
