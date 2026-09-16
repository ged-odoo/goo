import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { UpdatePlugin } from "../../src/core/update_plugin.js";
import { ServerPlugin } from "../../src/core/server_plugin.js";
import { DialogPlugin } from "../../src/core/dialog_plugin.js";
import { createPluginHarness } from "../helpers/plugin_harness.js";

function jsonOk(data) {
  return { ok: true, json: async () => data };
}

function setup({ serverState = "stopped" } = {}) {
  const fakeServer = {
    status: () => ({ state: serverState }),
    onGooUpdate: vi.fn(),
  };
  const fakeDialogs = { open: vi.fn(async () => true), error: vi.fn() };
  const harness = createPluginHarness([
    [ServerPlugin, fakeServer],
    [DialogPlugin, fakeDialogs],
  ]);
  const plugin = harness.start(UpdatePlugin);
  return { plugin, fakeServer, fakeDialogs };
}

// Flushes pending real Promise microtasks (fetch/json resolution) WITHOUT firing
// any fake timer -- setup() also registers a 30-minute setInterval, and
// vi.runOnlyPendingTimersAsync() would count that as "pending" and fire it once,
// consuming a second mocked fetch response before the test's first assertion.
async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("UpdatePlugin", () => {
  it("setup() loads the initial status and subscribes to the SSE push", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ checked: true, behind: 0 })),
    );
    const { plugin, fakeServer } = setup();
    await flushMicrotasks();
    expect(plugin.info()).toEqual({ checked: true, behind: 0 });
    expect(fakeServer.onGooUpdate).toHaveBeenCalledTimes(1);
    fakeServer.onGooUpdate.mock.calls[0][0]({ checked: true, behind: 2 });
    expect(plugin.info()).toEqual({ checked: true, behind: 2 });
  });

  it("_load() retries once shortly after if the backend hadn't finished its startup fetch yet", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonOk({ checked: false }))
      .mockResolvedValueOnce(jsonOk({ checked: true, behind: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const { plugin } = setup();
    await flushMicrotasks();
    expect(plugin.info()).toEqual({ checked: false });
    await vi.advanceTimersByTimeAsync(3000);
    expect(plugin.info()).toEqual({ checked: true, behind: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("_load() silently leaves info unset when the endpoint is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const { plugin } = setup();
    await flushMicrotasks();
    expect(plugin.info()).toBeNull();
  });

  it("check() re-fetches on demand and updates `info`", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ checked: true })),
    );
    const { plugin } = setup();
    await flushMicrotasks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ ok: true })),
    );
    const result = await plugin.check();
    expect(result).toEqual({ ok: true });
    expect(plugin.info()).toEqual({ ok: true });
  });

  it("check() returns {ok:false, error} on failure without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({})),
    );
    const { plugin } = setup();
    await flushMicrotasks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ error: "down" }) })),
    );
    const result = await plugin.check();
    expect(result).toEqual({ ok: false, error: "down" });
  });

  it("promptUpdate() with behind=0 does nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ behind: 0 })),
    );
    const { plugin, fakeDialogs } = setup();
    await flushMicrotasks();
    await plugin.promptUpdate();
    expect(fakeDialogs.open).not.toHaveBeenCalled();
  });

  it("promptUpdate() explains manual update when a fast-forward isn't possible", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ behind: 3, ahead: 1, dirty: true, can_fast_forward: false })),
    );
    const { plugin, fakeDialogs } = setup();
    await flushMicrotasks();
    await plugin.promptUpdate();
    expect(fakeDialogs.open).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "goo update available",
        message: expect.stringContaining("3 commits behind"),
        cancelLabel: null,
      }),
    );
    expect(fakeDialogs.open.mock.calls[0][0].message).toContain("1 local commit");
    expect(fakeDialogs.open.mock.calls[0][0].message).toContain("uncommitted changes");
  });

  it("promptUpdate() offers update+restart when a clean fast-forward is possible, and runs it on confirm", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ behind: 2, can_fast_forward: true, boot: "b1" })),
    );
    const { plugin } = setup({ serverState: "running" });
    await flushMicrotasks();
    let updateCalled = false;
    vi.stubGlobal("fetch", (url) => {
      if (url === "/api/goo/update") {
        updateCalled = true;
        return Promise.resolve(jsonOk({ boot: "b2" }));
      }
      return Promise.resolve(jsonOk({}));
    });
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    const promise = plugin.promptUpdate();
    await vi.advanceTimersByTimeAsync(1000); // _waitUntilRestarted's initial 600ms delay
    await promise;
    expect(updateCalled).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("promptUpdate() declined (cancelLabel) does not call applyAndRestart", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ behind: 2, can_fast_forward: true })),
    );
    const { plugin, fakeDialogs } = setup();
    await flushMicrotasks();
    fakeDialogs.open.mockResolvedValueOnce(false);
    const postSpy = vi.fn();
    vi.stubGlobal("fetch", postSpy);
    await plugin.promptUpdate();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("applyAndRestart() reports failure without reloading if the server never comes back", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ boot: "b1" })),
    );
    const { plugin } = setup();
    await flushMicrotasks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("still down");
      }),
    );
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    const promise = plugin.applyAndRestart();
    await vi.advanceTimersByTimeAsync(31000);
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(plugin.applying()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
