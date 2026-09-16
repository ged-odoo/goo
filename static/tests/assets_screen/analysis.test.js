import { describe, expect, it } from "vitest";
import { bundleBase } from "../../src/assets_screen/analysis.js";

describe("bundleBase", () => {
  it("strips a minified js suffix", () => {
    expect(bundleBase("web.assets_web.min.js")).toBe("web.assets_web");
  });

  it("strips a plain js suffix", () => {
    expect(bundleBase("web.assets_web.js")).toBe("web.assets_web");
  });

  it("strips a css suffix", () => {
    expect(bundleBase("web.assets_web.css")).toBe("web.assets_web");
  });

  it("strips a .map suffix layered on top of the extension", () => {
    expect(bundleBase("web.assets_web.css.map")).toBe("web.assets_web");
    expect(bundleBase("web.assets_web.min.js.map")).toBe("web.assets_web");
  });

  it("strips an xml suffix", () => {
    expect(bundleBase("web.assets_web.xml")).toBe("web.assets_web");
  });

  it("leaves a name with no recognized extension unchanged", () => {
    expect(bundleBase("web.assets_web")).toBe("web.assets_web");
  });
});
