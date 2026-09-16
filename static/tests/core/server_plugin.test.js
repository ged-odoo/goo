import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ServerPlugin } from "../../src/core/server_plugin.js";
import { ConfigPlugin } from "../../src/core/config_plugin.js";
import { StorePlugin } from "../../src/core/store_plugin.js";
import { EventLogPlugin } from "../../src/core/event_log_plugin.js";
import { CodePlugin } from "../../src/core/code_plugin.js";
import { DialogPlugin } from "../../src/core/dialog_plugin.js";
import { createPluginHarness } from "../helpers/plugin_harness.js";

// setup() starts a real setInterval(..., 1000) and opens a (faked) EventSource —
// fake timers keep the interval from leaking a live timer past the test, and the
// FakeEventSource stubbed globally in static/tests/setup.js keeps _connect() from
// throwing. Real SSE event delivery/wiring is out of scope (see the plan's Context
// section) — only the pure dispatch/state methods below are under test.
function makePlugin(workspaces = []) {
  const store = new StorePlugin({});
  const config = {
    config: { workspaces },
    getState: () => "",
    setState: vi.fn(),
  };
  const eventLog = { begin: vi.fn(), drop: vi.fn(), finish: vi.fn(), add: vi.fn(), start: vi.fn() };
  const code = {};
  const dialogs = { error: vi.fn(), open: vi.fn() };
  const harness = createPluginHarness([
    [ConfigPlugin, config],
    [StorePlugin, store],
    [EventLogPlugin, eventLog],
    [CodePlugin, code],
    [DialogPlugin, dialogs],
  ]);
  const plugin = harness.start(ServerPlugin);
  return { plugin, store, eventLog, config };
}

describe("ServerPlugin pure dispatch/state logic", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  describe("displayState", () => {
    it("reads as 'starting' the instant Start is clicked, before the backend confirms", () => {
      const { plugin } = makePlugin();
      plugin.pending.set("start");
      expect(plugin.displayState()).toBe("starting");
    });

    it("otherwise reflects the real server state", () => {
      const { plugin, store } = makePlugin();
      store.mergeServer({ id: "main", state: "running" });
      expect(plugin.displayState()).toBe("running");
    });
  });

  describe("loadedWorkspaceId", () => {
    it("is the running server's own workspace while one is up", () => {
      const { plugin, store } = makePlugin();
      store.mergeServer({ id: "main", state: "running", workspace: "w1" });
      plugin.setLastWorkspace("w2"); // stale — must be ignored while w1 is live
      expect(plugin.loadedWorkspaceId()).toBe("w1");
    });

    it("is also honored while merely 'starting' (not just fully 'running')", () => {
      const { plugin, store } = makePlugin();
      store.mergeServer({ id: "main", state: "starting", workspace: "w1" });
      expect(plugin.loadedWorkspaceId()).toBe("w1");
    });

    it("falls back to the last activated workspace once the server is stopped", () => {
      const { plugin, store } = makePlugin();
      plugin.setLastWorkspace("w2");
      store.mergeServer({ id: "main", state: "stopped" });
      expect(plugin.loadedWorkspaceId()).toBe("w2");
    });
  });

  describe("_resolveStartEvent", () => {
    it("does nothing when no start event is pending", () => {
      const { plugin, eventLog } = makePlugin();
      plugin._resolveStartEvent({ state: "stopped" }, { state: "running" });
      expect(eventLog.finish).not.toHaveBeenCalled();
    });

    it("resolves the pending start event 'done' on the rising edge into running", () => {
      const { plugin, eventLog } = makePlugin();
      plugin._startEid = "eid1";
      plugin._resolveStartEvent({ state: "starting" }, { state: "running" });
      expect(eventLog.finish).toHaveBeenCalledWith("eid1", "done");
      expect(plugin._startEid).toBeNull();
    });

    it("does not re-resolve an already-running->running transition", () => {
      const { plugin, eventLog } = makePlugin();
      plugin._startEid = "eid1";
      plugin._resolveStartEvent({ state: "running" }, { state: "running" });
      expect(eventLog.finish).not.toHaveBeenCalled();
      expect(plugin._startEid).toBe("eid1");
    });

    it("fails the pending start event if the process exits before reaching running", () => {
      const { plugin, eventLog } = makePlugin();
      plugin._startEid = "eid1";
      plugin._resolveStartEvent(
        { state: "starting" },
        { state: "stopped", exited_unexpectedly: true },
      );
      expect(eventLog.finish).toHaveBeenCalledWith("eid1", "error");
      expect(plugin._startEid).toBeNull();
    });

    it("a clean stop (no crash flag) leaves a pending start event untouched", () => {
      const { plugin, eventLog } = makePlugin();
      plugin._startEid = "eid1";
      plugin._resolveStartEvent({ state: "starting" }, { state: "stopped" });
      expect(eventLog.finish).not.toHaveBeenCalled();
      expect(plugin._startEid).toBe("eid1");
    });
  });

  describe("setLastWorkspace / lastWorkspace", () => {
    it("persists the id both in the reactive signal and via config state", () => {
      const { plugin, config } = makePlugin();
      plugin.setLastWorkspace("w9");
      expect(plugin.lastWorkspace()).toBe("w9");
      expect(config.setState).toHaveBeenCalledWith("active_workspace", "w9");
    });
  });

  describe("_hasTarget / _targetName", () => {
    it("resolves a configured workspace's name, and falls back to its id otherwise", () => {
      const { plugin } = makePlugin([{ id: "w1", name: "Feature X" }]);
      expect(plugin._hasTarget("w1")).toBe(true);
      expect(plugin._hasTarget("missing")).toBe(false);
      expect(plugin._targetName("w1")).toBe("Feature X");
      expect(plugin._targetName("missing")).toBe("missing");
    });
  });
});
