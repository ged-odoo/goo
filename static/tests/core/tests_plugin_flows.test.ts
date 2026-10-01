// TestsPlugin over the real server stream: clicking Run posts the launch, then the
// backend's "run" and "log" SSE events drive the slot's console, status and event log.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestsPlugin } from "../../src/core/tests_plugin.ts";
import { ServerPlugin } from "../../src/core/server_plugin.ts";
import { loadServerConfig } from "../../src/core/config_plugin.ts";
import { CodePlugin } from "../../src/core/code_plugin.ts";
import { EventLogPlugin } from "../../src/core/event_log_plugin.ts";
import { DEFAULT_CONFIG } from "../../src/core/config.ts";
import { createPluginHarness } from "../helpers/plugin_harness.ts";
import { RecordingEventSource, stubBackend, workspace } from "../helpers/core_fixtures.ts";

const MAIN = workspace("w1", "Main ws");
const WT = workspace("w2", "Worktree ws", "master", { location: "worktree" });

async function boot(replies: Record<string, unknown> = {}) {
  const calls = stubBackend({
    "/api/config": {
      ok: true,
      rev: 1,
      config: { ...DEFAULT_CONFIG, workspaces: [MAIN, WT] },
      state: {},
    },
    ...replies,
  });
  await loadServerConfig();
  vi.stubGlobal("EventSource", RecordingEventSource);
  const harness = createPluginHarness([[CodePlugin, {}]]);
  const plugin = harness.start(TestsPlugin);
  const es = RecordingEventSource.last;
  // let the run-dispatch effect react to what an SSE event just stored
  const emit = async (type: string, data: unknown) => {
    es.emit(type, data);
    await Promise.resolve();
  };
  const server = plugin.server as ServerPlugin;
  const eventLog = plugin.eventLog as EventLogPlugin;
  const events = () => eventLog.entries().map((e) => e.text);
  return { plugin, server, calls, emit, events };
}

describe("TestsPlugin run lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("run → running → passed on the main slot, console windowed to the launch", async () => {
    const { plugin, calls, emit, events } = await boot();
    const s = plugin.slot("main");
    await plugin.run("  /web:MyTour ", MAIN);
    expect(calls.find((c) => c.path === "/api/tests/run")?.body).toEqual({
      workspace: "w1",
      slot: "main",
      overrides: { test_tags: "/web:MyTour" },
    });
    expect(s.status()).toBe("starting…");
    expect(plugin.runActive()).toBe(true);
    expect(plugin.history()[0]).toBe("/web:MyTour");

    await emit("log", { server: "main", line: "before the launch" });
    await emit("log", { server: "main", line: "[goo] starting odoo: odoo-bin --test-tags" });
    await emit("run", { id: "run-1", kind: "test", state: "running", spec: { tags: "x" } });
    expect(plugin.runningFor("main")).toBe(true);
    expect(s.status()).toBe("running…");
    await emit("log", { server: "main", line: "[HOOT] Test suite succeeded" });
    await emit("run", { id: "run-1", kind: "test", state: "done", returncode: 0 });

    expect(s.status()).toBe("passed");
    expect(plugin.output.el.textContent).not.toContain("before the launch");
    expect(plugin.output.el.textContent).toContain("Test suite succeeded");
    expect(events()).toEqual(["running tests (tags: x)", "test run finished (success)"]);
    // after the run, lines no longer reach the test console
    await emit("log", { server: "main", line: "shutdown noise" });
    expect(plugin.output.el.textContent).not.toContain("shutdown noise");
  });

  it("a non-zero exit reports the failure, with the exit code", async () => {
    const { plugin, emit, events } = await boot();
    await plugin.run("tag", MAIN);
    await emit("run", { id: "r", kind: "test", state: "running" });
    await emit("run", { id: "r", kind: "test", state: "failed", returncode: 2 });
    expect(plugin.slot().status()).toBe("failed — exit 2");
    expect(events().at(-1)).toBe("test run finished (fail)");
    expect(events()[0]).toBe("running tests (tags: tag)"); // falls back to the run's own tags
  });

  it("a stopped run reports 'stopped' and a bare finish", async () => {
    const { plugin, emit, events } = await boot();
    await plugin.run("tag", MAIN);
    await emit("run", { id: "r", kind: "test", state: "done", returncode: null });
    // never seen running this session: no stale result announced
    expect(events()).toEqual([]);
    await plugin.run("tag", MAIN);
    await emit("run", { id: "r2", kind: "test", state: "running" });
    await emit("run", { id: "r2", kind: "test", state: "done", returncode: null });
    expect(plugin.slot().status()).toBe("stopped");
    expect(events().at(-1)).toBe("test run finished");
  });

  it("a WebSuite run's console window ends at chrome teardown", async () => {
    const { plugin, emit, events } = await boot();
    await plugin.run("/web:WebSuite", MAIN);
    await emit("run", { id: "r", kind: "test", state: "running" });
    await emit("log", { server: "main", line: "Terminating chrome headless with pid 1" });
    await emit("log", { server: "main", line: "thread dump" });
    expect(plugin.output.el.textContent).not.toContain("thread dump");
    expect(events().at(-1)).toBe("test run finished");
  });

  it("memcheck runs ask the backend for the leak check", async () => {
    const { plugin, calls, emit, events } = await boot();
    await plugin.run("/web:Tour", MAIN, true);
    expect(calls.find((c) => c.path === "/api/tests/run")?.body).toMatchObject({
      overrides: { test_tags: "/web:Tour", memcheck: true },
    });
    await emit("run", { id: "r", kind: "test", state: "running" });
    expect(events()[0]).toBe("running tests (tags: memcheck: /web:Tour)");
  });

  it("stopping a running main server is announced before the run", async () => {
    const { plugin, emit, events } = await boot();
    await emit("server", { id: "main", state: "running", mode: "server" });
    await plugin.run("tag", MAIN);
    expect(events()).toEqual(["stopping server to run tests"]);
  });

  it("a worktree workspace runs on its own slot, independently of main", async () => {
    const { plugin, calls, emit, events } = await boot();
    await emit("server", { id: "w2", state: "running" });
    await plugin.run("wt_tag", WT);
    expect(calls.find((c) => c.path === "/api/tests/run")?.body).toMatchObject({
      workspace: "w2",
      slot: "w2",
    });
    expect(events()).toEqual(["stopping server to run tests"]);
    await emit("run", { id: "r", kind: "test", state: "running", server: "w2" });
    await emit("log", { server: "w2", line: "wt output" });
    await emit("log", { server: "main", line: "main output" });
    expect(plugin.slot("w2").output.el.textContent).toBe("wt output");
    expect(plugin.runActive("main")).toBe(false);
  });

  it("a launch the backend refuses shows why, and the slot is idle again", async () => {
    const { plugin } = await boot({
      "/api/tests/run": new Response(JSON.stringify({ error: "no venv" }), { status: 400 }),
    });
    await plugin.run("tag", MAIN);
    expect(plugin.slot().status()).toBe("failed to start: no venv");
    expect(plugin.runActive()).toBe(false);
  });

  it("ignores a blank tag or a missing workspace", async () => {
    const { plugin, calls } = await boot();
    await plugin.run("   ", MAIN);
    await plugin.run("tag", null);
    expect(calls.some((c) => c.path === "/api/tests/run")).toBe(false);
  });
});
