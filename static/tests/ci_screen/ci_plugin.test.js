import { describe, it, expect, vi } from "vitest";
import { CiPlugin } from "../../src/ci_screen/ci_plugin.js";

function jsonOk(data) {
  return { ok: true, json: async () => ({ ok: true, ...data }) };
}

function start() {
  return new CiPlugin({});
}

describe("CiPlugin", () => {
  it("load() populates days/awaiting/at on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ days: [{ date: "2026-01-01", batches: 1 }], awaiting: 3 })),
    );
    const plugin = start();
    await plugin.load();
    expect(plugin.days()).toEqual([{ date: "2026-01-01", batches: 1 }]);
    expect(plugin.awaiting()).toBe(3);
    expect(plugin.at()).toBeGreaterThan(0);
    expect(plugin.loading()).toBe(false);
  });

  it("load() sets error on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ error: "down" }) })),
    );
    const plugin = start();
    await plugin.load();
    expect(plugin.error()).toBe("down");
  });

  it("skips a second concurrent load() while one is in flight", async () => {
    let resolveFirst;
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFirst = () => resolve(jsonOk({ days: [] }));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const plugin = start();
    const p1 = plugin.load();
    const p2 = plugin.load(); // should be a no-op — `loading` is already true
    resolveFirst();
    await Promise.all([p1, p2]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips a re-load when the same or narrower window was already fetched this session", async () => {
    const fetchMock = vi.fn(async () => jsonOk({ days: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const plugin = start();
    await plugin.load(false, 14);
    await plugin.load(false, 7); // narrower window, not forced -- skip
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-fetches when force=true even if the window was already covered", async () => {
    const fetchMock = vi.fn(async () => jsonOk({ days: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const plugin = start();
    await plugin.load(false, 14);
    await plugin.load(true, 14);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("re-fetches when a wider window is requested even without force", async () => {
    const fetchMock = vi.fn(async () => jsonOk({ days: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const plugin = start();
    await plugin.load(false, 7);
    await plugin.load(false, 14);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
