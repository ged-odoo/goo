import { describe, expect, it } from "vitest";
import { dropIndex } from "../../src/core/drag.js";

// dropIndex against fake DOMRect-shaped fixtures — no real DOM layout needed.
// startRowDrag itself (real pointer/DOM mechanics) is out of scope; see the
// plan's documented frontend exclusions.
function fakeRow(top, height) {
  return { getBoundingClientRect: () => ({ top, height }) };
}

describe("dropIndex", () => {
  const rows = [fakeRow(0, 20), fakeRow(20, 20), fakeRow(40, 20)];

  it("returns the index of the first row whose midline is below the pointer", () => {
    expect(dropIndex({ clientY: 5 }, rows)).toBe(0); // above row 0's midline (10)
    expect(dropIndex({ clientY: 15 }, rows)).toBe(1); // past row 0's midline, before row 1's (30)
    expect(dropIndex({ clientY: 35 }, rows)).toBe(2); // past row 1's midline, before row 2's (50)
  });

  it("returns rows.length when the pointer is past every row", () => {
    expect(dropIndex({ clientY: 1000 }, rows)).toBe(3);
  });

  it("returns 0 for an empty row list", () => {
    expect(dropIndex({ clientY: 5 }, [])).toBe(0);
  });
});
