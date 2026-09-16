import { describe, expect, it } from "vitest";
import { PRESETS } from "../../src/core/presets.js";

describe("PRESETS", () => {
  it("has the normal and ged presets", () => {
    const ids = PRESETS.map((p) => p.id);
    expect(ids).toEqual(["normal", "ged"]);
  });

  it("normal is a pure DEFAULT_CONFIG reset (empty data, clears the data file)", () => {
    const normal = PRESETS.find((p) => p.id === "normal");
    expect(normal.data).toEqual({});
    expect(normal.clearDataFile).toBe(true);
  });

  it("ged carries a full config override as a JSON-stringified localStorage blob", () => {
    const ged = PRESETS.find((p) => p.id === "ged");
    expect(typeof ged.data["oo-config"]).toBe("string");
    const config = JSON.parse(ged.data["oo-config"]);
    expect(Array.isArray(config.repos)).toBe(true);
    expect(config.repos.map((r) => r.id)).toEqual(
      expect.arrayContaining(["community", "enterprise", "owl"]),
    );
    expect(typeof ged.data["oo-last-target"]).toBe("string");
    expect(() => JSON.parse(ged.data["oo-test-history"])).not.toThrow();
  });
});
