import { describe, expect, it, vi } from "vitest";
import { TestsPlugin, slotFor } from "../../src/core/tests_plugin.js";
import { ConfigPlugin } from "../../src/core/config_plugin.js";
import { StorePlugin } from "../../src/core/store_plugin.js";
import { ServerPlugin } from "../../src/core/server_plugin.js";
import { EventLogPlugin } from "../../src/core/event_log_plugin.js";
import { createPluginHarness } from "../helpers/plugin_harness.js";

function makePlugin() {
  const store = new StorePlugin({});
  const config = { getState: () => [], setState: vi.fn() };
  const logListeners = new Set();
  const server = {
    status: () => ({ state: "stopped" }),
    onLog: (cb) => logListeners.add(cb),
  };
  const eventLog = { add: vi.fn() };
  const harness = createPluginHarness([
    [ConfigPlugin, config],
    [StorePlugin, store],
    [ServerPlugin, server],
    [EventLogPlugin, eventLog],
  ]);
  const plugin = harness.start(TestsPlugin);
  return { plugin, store, eventLog, config };
}

describe("slotFor", () => {
  it("a worktree workspace occupies its own slot", () => {
    expect(slotFor({ id: "w1", location: "worktree" })).toBe("w1");
  });

  it("a main-located workspace (or none) occupies the shared 'main' slot", () => {
    expect(slotFor({ id: "w1", location: "main" })).toBe("main");
    expect(slotFor(null)).toBe("main");
  });
});

describe("TestsPlugin._capture (HOOT/memlab log-line matching)", () => {
  function activeSlot(plugin, slotId = "main") {
    const s = plugin.slot(slotId);
    // _capture()'s real first check is runActive(), not s.capturing directly —
    // pending(true) satisfies that gate without exercising the run-state machine
    // (covered separately below), then capturing itself is opened explicitly
    s.pending.set(true);
    s.capturing = true;
    return s;
  }

  it("ignores lines on a slot with no active/capturing run", () => {
    const { plugin, eventLog } = makePlugin();
    plugin._capture("main", "[HOOT] Test suite succeeded");
    expect(plugin.slot("main").result).toBe("");
    expect(eventLog.add).not.toHaveBeenCalled();
  });

  it("opens the console window at the launch-command line", () => {
    const { plugin } = makePlugin();
    const s = plugin.slot("main");
    // capturing starts false; runActive() must be true for _capture to even look —
    // simulate an active run via a pending optimistic start
    s.pending.set(true);
    plugin._capture("main", "[goo] starting odoo: ...");
    expect(s.capturing).toBe(true);
  });

  it("records a HOOT test failure with a per-repo-unique anchor on the main slot", () => {
    const { plugin, eventLog } = makePlugin();
    const s = activeSlot(plugin);
    plugin._capture("main", '[HOOT] Test "some.test" failed');
    expect(eventLog.add).toHaveBeenCalledWith("test failed: some.test", "test-fail-1", "error");
    expect(s.output.lines?.length ?? 1).toBeGreaterThan(0);
  });

  it("a HOOT failure on a non-main slot gets no DOM anchor", () => {
    const { plugin, eventLog } = makePlugin();
    activeSlot(plugin, "wt1");
    plugin._capture("wt1", '[HOOT] Test "some.test" failed');
    expect(eventLog.add).toHaveBeenCalledWith("test failed: some.test", "", "error");
  });

  it("marks the suite outcome success/fail from HOOT's own summary lines", () => {
    const { plugin } = makePlugin();
    const s = activeSlot(plugin);
    plugin._capture("main", "[HOOT] Test suite succeeded");
    expect(s.result).toBe("success");
    plugin._capture("main", "Some tests failed");
    expect(s.result).toBe("fail");
  });

  it("memlab's leak count overrides an already-recorded HOOT success", () => {
    const { plugin, eventLog } = makePlugin();
    const s = activeSlot(plugin);
    plugin._capture("main", "[HOOT] Test suite succeeded");
    expect(s.result).toBe("success");
    plugin._capture("main", "MemLab found 3 leak(s)");
    expect(s.result).toBe("fail");
    expect(eventLog.add).toHaveBeenCalledWith("memory check: 3 leak(s) found", "", "error");
  });

  it("memlab reporting zero leaks records success, not an error", () => {
    const { plugin, eventLog } = makePlugin();
    const s = activeSlot(plugin);
    plugin._capture("main", "MemLab found 0 leak(s)");
    expect(s.result).toBe("success");
    expect(eventLog.add).toHaveBeenCalledWith("memory check: no leaks found", "", "");
  });

  it("a browser run's window closes on chrome teardown when cutOnChrome is set", () => {
    const { plugin, eventLog } = makePlugin();
    const s = activeSlot(plugin);
    s.cutOnChrome = true;
    plugin._capture("main", "Terminating chrome headless with pid 1234");
    expect(s.finished).toBe(true);
    expect(eventLog.add).toHaveBeenCalledWith(expect.stringContaining("test run finished"), "", "");
  });
});

describe("TestsPlugin history", () => {
  it("pushes new tags to the front, dedupes, and persists via config state", () => {
    const { plugin, config } = makePlugin();
    plugin._pushHistory("web:WebSuite");
    plugin._pushHistory("mail:MailSuite");
    plugin._pushHistory("web:WebSuite"); // re-run -> moves back to front, no duplicate
    expect(plugin.history()).toEqual(["web:WebSuite", "mail:MailSuite"]);
    expect(config.setState).toHaveBeenLastCalledWith("test_history", [
      "web:WebSuite",
      "mail:MailSuite",
    ]);
  });

  it("ignores a blank tag", () => {
    const { plugin } = makePlugin();
    plugin._pushHistory("   ");
    expect(plugin.history()).toEqual([]);
  });
});

describe("TestsPlugin._onRun", () => {
  it("announces once per run id and flips status to running", () => {
    const { plugin, eventLog } = makePlugin();
    plugin._onRun("main", { id: "r1", state: "running", spec: { tags: "web" } });
    expect(eventLog.add).toHaveBeenCalledWith("running tests (tags: web)");
    expect(plugin.slot("main").status()).toBe("running…");
    eventLog.add.mockClear();
    plugin._onRun("main", { id: "r1", state: "running", spec: { tags: "web" } });
    expect(eventLog.add).not.toHaveBeenCalled(); // already announced this run id
  });

  it("finalizes once per run id, preferring a captured HOOT/memlab result over a clean exit code", () => {
    const { plugin } = makePlugin();
    plugin._onRun("main", { id: "r1", state: "running", spec: { tags: "web" } });
    plugin.slot("main").result = "fail"; // e.g. memlab found leaks despite exit 0
    plugin._onRun("main", { id: "r1", state: "done", returncode: 0 });
    expect(plugin.slot("main").status()).toBe("failed");
  });

  it("a manually stopped run (returncode null) reports 'stopped'", () => {
    const { plugin } = makePlugin();
    plugin._onRun("main", { id: "r1", state: "running", spec: { tags: "web" } });
    plugin._onRun("main", { id: "r1", state: "done", returncode: null });
    expect(plugin.slot("main").status()).toBe("stopped");
  });

  it("a run that finished before this session ever saw it running is not re-announced", () => {
    const { plugin, eventLog } = makePlugin();
    plugin._onRun("main", { id: "r1", state: "done", returncode: 0 });
    expect(eventLog.add).not.toHaveBeenCalled();
  });
});
