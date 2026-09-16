import { describe, expect, it, vi, beforeEach } from "vitest";
import { ReviewsPlugin } from "../../src/reviews_screen/reviews_plugin.js";

// ReviewsPlugin has no usePlugin() dependencies at all — constructible directly,
// no harness needed (see static/tests/helpers/plugin_harness.js's header).
function makePlugin() {
  return new ReviewsPlugin({});
}

function fakeConfig(reviews = []) {
  return { config: { reviews }, updateConfig: vi.fn() };
}

describe("ReviewsPlugin.loadPrInfo", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("skips a pair already held unless force is set", async () => {
    const plugin = makePlugin();
    plugin.prInfo.set({ "odoo/odoo#1": { github: "odoo/odoo", number: 1 } });
    await plugin.loadPrInfo([{ github: "odoo/odoo", number: 1 }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("force=true re-asks an already-held pair", async () => {
    const plugin = makePlugin();
    plugin.prInfo.set({ "odoo/odoo#1": { github: "odoo/odoo", number: 1, title: "old" } });
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ prs: [{ github: "odoo/odoo", number: 1, title: "new" }] }),
    });
    await plugin.loadPrInfo([{ github: "odoo/odoo", number: 1 }], true);
    expect(plugin.prInfo()["odoo/odoo#1"].title).toBe("new");
  });

  it("records the fetch error and clears loading on failure", async () => {
    const plugin = makePlugin();
    fetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: "boom" }) });
    await plugin.loadPrInfo([{ github: "odoo/odoo", number: 1 }]);
    expect(plugin.error()).toBe("boom");
    expect(plugin.loading()).toBe(false);
  });
});

describe("ReviewsPlugin.fetchOne", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("fetches and returns a not-yet-held pair", async () => {
    const plugin = makePlugin();
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ prs: [{ github: "odoo/odoo", number: 1, title: "t" }] }),
    });
    const pr = await plugin.fetchOne({ github: "odoo/odoo", number: 1 });
    expect(pr.title).toBe("t");
  });

  it("returns null if the fetch never populated that key", async () => {
    const plugin = makePlugin();
    fetch.mockResolvedValue({ ok: true, json: async () => ({ prs: [] }) });
    expect(await plugin.fetchOne({ github: "odoo/odoo", number: 1 })).toBeNull();
  });
});

describe("ReviewsPlugin.findSiblings", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("returns [] immediately for an empty branch list, without fetching", async () => {
    const plugin = makePlugin();
    expect(await plugin.findSiblings([])).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns [] on failure rather than throwing", async () => {
    const plugin = makePlugin();
    fetch.mockRejectedValue(new Error("network down"));
    expect(await plugin.findSiblings(["master-x"])).toEqual([]);
  });

  it("seeds prInfo with the found PRs as a side effect", async () => {
    const plugin = makePlugin();
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ prs: [{ github: "odoo/odoo", number: 1 }] }),
    });
    const prs = await plugin.findSiblings(["master-x"]);
    expect(prs).toHaveLength(1);
    expect(plugin.prInfo()["odoo/odoo#1"]).toEqual({ github: "odoo/odoo", number: 1 });
  });
});

describe("ReviewsPlugin.track/untrack", () => {
  it("track adds a new pair to the front and returns true", () => {
    const plugin = makePlugin();
    const config = fakeConfig([{ id: "odoo/odoo#1", github: "odoo/odoo", number: 1 }]);
    const ok = plugin.track(config, "odoo/odoo", 2);
    expect(ok).toBe(true);
    expect(config.updateConfig).toHaveBeenCalledWith({
      reviews: [
        { id: "odoo/odoo#2", github: "odoo/odoo", number: 2 },
        { id: "odoo/odoo#1", github: "odoo/odoo", number: 1 },
      ],
    });
  });

  it("track is a no-op (returns false) for an already-tracked pair", () => {
    const plugin = makePlugin();
    const config = fakeConfig([{ id: "odoo/odoo#1", github: "odoo/odoo", number: 1 }]);
    expect(plugin.track(config, "odoo/odoo", 1)).toBe(false);
    expect(config.updateConfig).not.toHaveBeenCalled();
  });

  it("untrack removes exactly the given id", () => {
    const plugin = makePlugin();
    const config = fakeConfig([{ id: "a" }, { id: "b" }]);
    plugin.untrack(config, "a");
    expect(config.updateConfig).toHaveBeenCalledWith({ reviews: [{ id: "b" }] });
  });

  it("untrackMany removes every id in the set in one write", () => {
    const plugin = makePlugin();
    const config = fakeConfig([{ id: "a" }, { id: "b" }, { id: "c" }]);
    plugin.untrackMany(config, ["a", "c"]);
    expect(config.updateConfig).toHaveBeenCalledWith({ reviews: [{ id: "b" }] });
  });
});

describe("ReviewsPlugin.toggleImportant", () => {
  it("flags every id in the group when none are currently flagged", () => {
    const plugin = makePlugin();
    const config = fakeConfig([
      { id: "a", important: false },
      { id: "b", important: false },
    ]);
    plugin.toggleImportant(config, ["a", "b"]);
    expect(config.updateConfig).toHaveBeenCalledWith({
      reviews: [
        { id: "a", important: true },
        { id: "b", important: true },
      ],
    });
  });

  it("clears every id in the group when at least one is already flagged", () => {
    const plugin = makePlugin();
    const config = fakeConfig([
      { id: "a", important: true },
      { id: "b", important: false },
    ]);
    plugin.toggleImportant(config, ["a", "b"]);
    expect(config.updateConfig).toHaveBeenCalledWith({
      reviews: [
        { id: "a", important: false },
        { id: "b", important: false },
      ],
    });
  });
});
