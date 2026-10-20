import { describe, expect, it } from "vitest";
import { stageClass } from "../../src/core/task_button.ts";

describe("stageClass", () => {
  it("colours the pill by what the stage's name says", () => {
    expect(stageClass("Done")).toBe("ready");
    expect(stageClass("Closed")).toBe("ready");
    expect(stageClass("Cancelled")).toBe("merged");
    expect(stageClass("In Progress")).toBe("progress");
    expect(stageClass("RD Dev")).toBe("progress");
    expect(stageClass("RD Testing BE")).toBe("progress");
    expect(stageClass("Waiting for customer")).toBe("blocked");
  });

  it("leaves a stage it does not recognise plain", () => {
    expect(stageClass("Bug Fixes")).toBe("other");
    expect(stageClass("")).toBe("other");
  });
});
