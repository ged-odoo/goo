import { describe, expect, it } from "vitest";
import { parsePrRef } from "../../src/reviews_screen/reviews.js";

describe("parsePrRef", () => {
  it("parses a full GitHub PR URL", () => {
    expect(parsePrRef("https://github.com/odoo/odoo/pull/12345")).toEqual({
      github: "odoo/odoo",
      number: 12345,
    });
  });

  it("parses the owner/repo#123 shorthand", () => {
    expect(parsePrRef("odoo/odoo#12345")).toEqual({ github: "odoo/odoo", number: 12345 });
  });

  it("trims surrounding whitespace for the shorthand form", () => {
    expect(parsePrRef("  odoo/odoo#12345  ")).toEqual({ github: "odoo/odoo", number: 12345 });
  });

  it("returns null for unrecognized text", () => {
    expect(parsePrRef("not a pr reference")).toBeNull();
    expect(parsePrRef("")).toBeNull();
  });

  it("returns null for a URL missing the pull number", () => {
    expect(parsePrRef("https://github.com/odoo/odoo")).toBeNull();
  });
});
