import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryPlugin } from "../../src/memory_screen/memory_plugin.js";

function jsonOk(data) {
  return { ok: true, json: async () => ({ ok: true, ...data }) };
}

beforeEach(() => localStorage.clear());

describe("MemoryPlugin", () => {
  it("starts with a single blank build row when localStorage is empty", () => {
    const plugin = new MemoryPlugin({});
    expect(plugin.builds()).toEqual([{ label: "", url: "" }]);
  });

  it("restores persisted builds from localStorage", () => {
    localStorage.setItem("oo-memory-builds", JSON.stringify([{ label: "a", url: "http://x" }]));
    const plugin = new MemoryPlugin({});
    expect(plugin.builds()).toEqual([{ label: "a", url: "http://x" }]);
  });

  it("falls back to a blank row on corrupt localStorage JSON", () => {
    localStorage.setItem("oo-memory-builds", "{not json");
    const plugin = new MemoryPlugin({});
    expect(plugin.builds()).toEqual([{ label: "", url: "" }]);
  });

  it("restores a persisted batch URL", () => {
    localStorage.setItem("oo-memory-batch-url", "http://runbot/batch/1");
    const plugin = new MemoryPlugin({});
    expect(plugin.batchUrl()).toBe("http://runbot/batch/1");
  });

  it("addBuild()/removeBuild() persist to localStorage, never leaving zero rows", () => {
    const plugin = new MemoryPlugin({});
    plugin.addBuild();
    expect(plugin.builds().length).toBe(2);
    expect(JSON.parse(localStorage.getItem("oo-memory-builds")).length).toBe(2);
    plugin.removeBuild(0);
    plugin.removeBuild(0);
    expect(plugin.builds()).toEqual([{ label: "", url: "" }]); // never empty
  });

  it("updateBuild(url) clears a previously-set fileName/content (mutually exclusive with a file)", () => {
    const plugin = new MemoryPlugin({});
    plugin.setBuildFile(0, "log.txt", "big content");
    plugin.updateBuild(0, "url", "http://x");
    expect(plugin.builds()[0]).toEqual({ label: "", url: "http://x" });
  });

  it("setBuildFile() clears any typed URL; only `content` is excluded from localStorage (can be huge)", () => {
    const plugin = new MemoryPlugin({});
    plugin.updateBuild(0, "url", "http://x");
    plugin.setBuildFile(0, "log.txt", "big content");
    expect(plugin.builds()[0]).toEqual({
      label: "",
      url: "",
      fileName: "log.txt",
      content: "big content",
    });
    const persisted = JSON.parse(localStorage.getItem("oo-memory-builds"));
    expect(persisted[0]).toEqual({ label: "", url: "", fileName: "log.txt" }); // content stripped, fileName kept
  });

  it("clearBuildFile() removes fileName/content but keeps the rest", () => {
    const plugin = new MemoryPlugin({});
    plugin.setBuildFile(0, "log.txt", "big content");
    plugin.clearBuildFile(0);
    expect(plugin.builds()[0]).toEqual({ label: "", url: "" });
  });

  it("setBatchUrl() persists to localStorage", () => {
    const plugin = new MemoryPlugin({});
    plugin.setBatchUrl("http://runbot/batch/2");
    expect(localStorage.getItem("oo-memory-batch-url")).toBe("http://runbot/batch/2");
  });

  it("fetchBatch() appends the fetched builds, dropping a trailing blank placeholder", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ builds: [{ label: "b1", url: "http://1" }] })),
    );
    const plugin = new MemoryPlugin({});
    plugin.setBatchUrl("http://runbot/batch/1");
    await plugin.fetchBatch();
    expect(plugin.builds()).toEqual([{ label: "b1", url: "http://1" }]);
  });

  it("fetchBatch() keeps existing non-blank rows and appends after them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ builds: [{ label: "b2", url: "http://2" }] })),
    );
    const plugin = new MemoryPlugin({});
    plugin.updateBuild(0, "url", "http://1");
    plugin.setBatchUrl("http://runbot/batch/1");
    await plugin.fetchBatch();
    expect(plugin.builds()).toEqual([
      { label: "", url: "http://1" },
      { label: "b2", url: "http://2" },
    ]);
  });

  it("fetchBatch() reports 'no builds found' without mutating the list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ builds: [] })),
    );
    const plugin = new MemoryPlugin({});
    plugin.setBatchUrl("http://runbot/batch/1");
    await plugin.fetchBatch();
    expect(plugin.batchError()).toBe("No builds found at that URL.");
    expect(plugin.builds()).toEqual([{ label: "", url: "" }]);
  });

  it("fetchBatch() with a blank URL is a no-op", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const plugin = new MemoryPlugin({});
    await plugin.fetchBatch();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("load() posts with_mobile and stores the returned data", async () => {
    const fetchMock = vi.fn(async () => jsonOk({ data: [{ suite: "web", points: [] }] }));
    vi.stubGlobal("fetch", fetchMock);
    const plugin = new MemoryPlugin({});
    plugin.updateBuild(0, "url", "http://x");
    plugin.withMobile.set(true);
    await plugin.load();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ with_mobile: true });
    expect(plugin.data()).toEqual([{ suite: "web", points: [] }]);
  });

  it("load() with no usable build rows (no url, no content) is a no-op", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const plugin = new MemoryPlugin({});
    await plugin.load();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("load() surfaces a failure message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ error: "bad log" }) })),
    );
    const plugin = new MemoryPlugin({});
    plugin.updateBuild(0, "url", "http://x");
    await plugin.load();
    expect(plugin.error()).toBe("bad log");
  });
});
