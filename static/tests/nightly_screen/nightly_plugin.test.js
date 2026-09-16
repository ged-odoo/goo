import { describe, it, expect, vi } from "vitest";
import { NightlyPlugin } from "../../src/nightly_screen/nightly_plugin.js";

function jsonOk(data) {
  return { ok: true, json: async () => ({ ok: true, ...data }) };
}

describe("NightlyPlugin", () => {
  it("load() populates versions/nights/at on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ versions: ["18.0"], nights: [{ date: "2026-01-01" }] })),
    );
    const plugin = new NightlyPlugin({});
    await plugin.load();
    expect(plugin.versions()).toEqual(["18.0"]);
    expect(plugin.nights()).toEqual([{ date: "2026-01-01" }]);
    expect(plugin.at()).toBeGreaterThan(0);
  });

  it("load() sets an error on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ error: "down" }) })),
    );
    const plugin = new NightlyPlugin({});
    await plugin.load();
    expect(plugin.error()).toBe("down");
  });

  it("skips a second concurrent load()", async () => {
    let resolveFirst;
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFirst = () => resolve(jsonOk({ versions: [], nights: [] }));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const plugin = new NightlyPlugin({});
    const p1 = plugin.load();
    const p2 = plugin.load();
    resolveFirst();
    await Promise.all([p1, p2]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips re-fetching a narrower or equal window that's already covered this session", async () => {
    const fetchMock = vi.fn(async () => jsonOk({ versions: [], nights: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const plugin = new NightlyPlugin({});
    await plugin.load(false, 14);
    await plugin.load(false, 7);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-fetches when force=true or a wider window is requested", async () => {
    const fetchMock = vi.fn(async () => jsonOk({ versions: [], nights: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const plugin = new NightlyPlugin({});
    await plugin.load(false, 7);
    await plugin.load(true, 7);
    await plugin.load(false, 14);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fetchErrors() memoizes per URL for the session, never re-fetching", async () => {
    const fetchMock = vi.fn(async () =>
      jsonOk({ errors: [{ message: "boom" }], metrics: { peak: 1 } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const plugin = new NightlyPlugin({});
    const r1 = await plugin.fetchErrors("http://build/1");
    const r2 = await plugin.fetchErrors("http://build/1");
    expect(r1).toBe(r2); // same cached object, not just equal
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r1).toEqual({ errors: [{ message: "boom" }], metrics: { peak: 1 } });
  });

  it("fetchErrors() defaults errors/metrics to empty when the backend omits them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({})),
    );
    const plugin = new NightlyPlugin({});
    const result = await plugin.fetchErrors("http://build/2");
    expect(result).toEqual({ errors: [], metrics: {} });
  });

  it("fetchErrors() records a timeout URL when any error is flagged timeout:true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ errors: [{ message: "x", timeout: true }] })),
    );
    const plugin = new NightlyPlugin({});
    await plugin.fetchErrors("http://build/3");
    expect(plugin.timeoutUrls().has("http://build/3")).toBe(true);
  });

  it("fetchErrors() does not flag a URL with no timeout errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ errors: [{ message: "x" }] })),
    );
    const plugin = new NightlyPlugin({});
    await plugin.fetchErrors("http://build/4");
    expect(plugin.timeoutUrls().has("http://build/4")).toBe(false);
  });
});
