// ServerPlugin end to end over its real siblings (config, store, event log, dialogs):
// the SSE stream the backend pushes, and the start/stop/restart/resume actions.
// Only CodePlugin is faked — its loadBranches stands in for the git read by merging
// the given branch state into the real store, as the real one does.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerPlugin, type ClaudeEvent, type LogLine } from "../../src/core/server_plugin.ts";
import { ConfigPlugin, loadServerConfig } from "../../src/core/config_plugin.ts";
import { StorePlugin } from "../../src/core/store_plugin.ts";
import { EventLogPlugin } from "../../src/core/event_log_plugin.ts";
import { CodePlugin } from "../../src/core/code_plugin.ts";
import { DialogPlugin } from "../../src/core/dialog_plugin.ts";
import { DEFAULT_CONFIG } from "../../src/core/config.ts";
import type { RepoStatusWire } from "../../src/core/observed_models.ts";
import type { UpdateInfo } from "../../src/core/update_plugin.ts";
import { createPluginHarness } from "../helpers/plugin_harness.ts";
import { NO_MANAGER } from "../helpers/plugin.ts";
import { RecordingEventSource, stubBackend, workspace } from "../helpers/core_fixtures.ts";

let branchState: RepoStatusWire[] = [];

async function boot(replies: Record<string, unknown> = {}) {
  const calls = stubBackend({
    "/api/config": {
      ok: true,
      rev: 1,
      config: { ...DEFAULT_CONFIG, workspaces: [workspace("w1", "Feature X", "feat-x")] },
      state: { active_workspace: "w1" },
    },
    ...replies,
  });
  await loadServerConfig();
  vi.stubGlobal("EventSource", RecordingEventSource);
  const store = new StorePlugin(NO_MANAGER);
  store.setup();
  const code = {
    loadBranches: vi.fn(async () => store.mergeRepoStatus(branchState, Date.now())),
  };
  const harness = createPluginHarness([
    [StorePlugin, store],
    [CodePlugin, code],
  ]);
  const plugin = harness.start(ServerPlugin);
  const eventLog = plugin.eventLog as EventLogPlugin;
  const dialogs = plugin.dialogs as DialogPlugin;
  const config = plugin.config as ConfigPlugin;
  return { plugin, store, eventLog, dialogs, config, calls, es: RecordingEventSource.last };
}

const texts = (log: EventLogPlugin) => log.entries().map((e) => `${e.text}|${e.status ?? ""}`);

// the plugin's 1s clock and the config's debounced save must not outlive a test
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ServerPlugin — live SSE stream", () => {
  it("connects to /api/events and folds 'server' snapshots into the main status", async () => {
    const { plugin, es } = await boot();
    expect(es.url).toBe("/api/events");
    expect(plugin.status().state).toBe("stopped");
    plugin.pending.set("stop");
    es.emit("server", { id: "main", state: "running", workspace: "w1" });
    expect(plugin.status().state).toBe("running");
    expect(plugin.pending()).toBe(""); // the optimistic override dropped
    expect(plugin.loadedWorkspaceId()).toBe("w1");
  });

  it("relays a worktree's snapshot to the worktree listeners, not the main status", async () => {
    const { plugin, store, es } = await boot();
    const seen: string[] = [];
    const off = plugin.onWorktree((s) => seen.push(`${s.id}:${s.state}`));
    es.emit("server", { id: "w2", state: "starting" });
    off();
    es.emit("server", { id: "w2", state: "running" });
    expect(seen).toEqual(["w2:starting"]);
    expect(store.server("w2")?.state).toBe("running");
    expect(plugin.status().state).toBe("stopped");
  });

  it("marks the server disconnected on an error and clears the log on (re)connect", async () => {
    const { plugin, es } = await boot();
    es.emit("log", { server: "main", line: "hello" });
    expect(plugin.output.el.textContent).toContain("hello");
    es.onopen!();
    expect(plugin.output.count()).toBe(0);
    es.onerror!();
    expect(plugin.status().state).toBe("disconnected");
  });

  it("routes log lines: main ones into the server console, all to subscribers", async () => {
    const { plugin, es } = await boot();
    const got: LogLine[] = [];
    plugin.onLog((d) => got.push(d));
    es.emit("log", { server: "main", line: "main line" });
    es.emit("log", { server: "w2", line: "worktree line" });
    plugin.log("[goo] local note");
    expect(plugin.output.el.textContent).toContain("main line");
    expect(plugin.output.el.textContent).not.toContain("worktree line");
    expect(plugin.output.el.textContent).toContain("[goo] local note");
    expect(got.map((d) => `${d.server}:${d.line}`)).toEqual([
      "main:main line",
      "w2:worktree line",
      "main:[goo] local note",
    ]);
  });

  it("stores one-shot runs from 'run' events", async () => {
    const { store, es } = await boot();
    es.emit("run", { id: "run-1", kind: "test", state: "running" });
    expect(store.latestRunOfKind("test")?.state).toBe("running");
  });

  it("turns backend 'event's into event log rows, timed ones resolving in place", async () => {
    const { eventLog, es } = await boot();
    es.emit("event", { text: "plain note" });
    es.emit("event", { id: "e1", text: "running tests", status: "start" });
    es.emit("event", { id: "e1", text: "running tests", status: "done" });
    es.emit("event", { id: "e2", text: "install", status: "start" });
    es.emit("event", { id: "e2", text: "install", status: "error", level: "error" });
    expect(texts(eventLog)).toEqual(["plain note|", "running tests|done", "install|error"]);
    expect(eventLog.entries()[2].level).toBe("error");
  });

  it("follows another tab's config broadcast, including the active workspace", async () => {
    const { plugin, config, es } = await boot();
    es.emit("config", {
      rev: 5,
      config: { ...DEFAULT_CONFIG, workspaces: [workspace("w1", "Renamed")] },
      state: { active_workspace: "other" },
    });
    expect(config.rev()).toBe(5);
    expect(config.config.workspaces[0].name).toBe("Renamed");
    expect(plugin.lastWorkspace()).toBe("other");
  });

  it("relays goo-update and claude events to their listeners", async () => {
    const { plugin, es } = await boot();
    const updates: UpdateInfo[] = [];
    const chat: ClaudeEvent[] = [];
    plugin.onGooUpdate((d) => updates.push(d));
    const off = plugin.onClaude((d) => chat.push(d));
    es.emit("goo_update", { behind: 3 });
    es.emit("claude", { workspace: "w1", role: "assistant" });
    off();
    es.emit("claude", { workspace: "w1", role: "result" });
    expect(updates).toEqual([{ behind: 3 }]);
    expect(chat).toEqual([{ workspace: "w1", role: "assistant" }]);
  });

  it("ticks `now` every second", async () => {
    const { plugin } = await boot();
    const t0 = plugin.now();
    vi.setSystemTime(t0 + 5000);
    vi.advanceTimersByTime(1000);
    expect(plugin.now()).toBeGreaterThan(t0);
  });
});

describe("ServerPlugin — loadStatus", () => {
  it("fills the main status from /api/status before the stream connects", async () => {
    const { plugin } = await boot({ "/api/status": { id: "main", state: "running" } });
    await plugin.loadStatus();
    expect(plugin.status().state).toBe("running");
  });

  it("is best-effort: an error reply or an unreachable server leaves it stopped", async () => {
    const { plugin } = await boot({ "/api/status": new Response("x", { status: 500 }) });
    await plugin.loadStatus();
    expect(plugin.status().state).toBe("stopped");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await plugin.loadStatus();
    expect(plugin.status().state).toBe("stopped");
  });
});

describe("ServerPlugin — start/stop/restart/resume", () => {
  beforeEach(() => {
    branchState = [{ id: "community", current: "feat-x" }];
  });

  it("start: shows 'starting' at once, posts the launch, resolves the event on running", async () => {
    const { plugin, eventLog, calls, es } = await boot();
    const p = plugin.start("w1", "--dev=all");
    expect(plugin.displayState()).toBe("starting");
    await p;
    expect(calls.find((c) => c.path === "/api/start")?.body).toEqual({
      workspace: "w1",
      overrides: { other_args: "--dev=all" },
    });
    expect(texts(eventLog)).toEqual(["starting server (workspace: Feature X)|pending"]);
    es.emit("server", { id: "main", state: "starting" });
    es.emit("server", { id: "main", state: "running", workspace: "w1" });
    expect(texts(eventLog)).toEqual(["starting server (workspace: Feature X)|done"]);
    expect(plugin.lastWorkspace()).toBe("w1");
  });

  it("start: a crash before running fails the pending event", async () => {
    const { plugin, eventLog, es } = await boot();
    await plugin.start("w1");
    es.emit("server", { id: "main", state: "stopped", exited_unexpectedly: true });
    expect(texts(eventLog)).toEqual(["starting server (workspace: Feature X)|error"]);
    expect(plugin.displayState()).toBe("stopped");
  });

  it("start on an unknown workspace only logs it", async () => {
    const { plugin, calls } = await boot();
    await plugin.start("nope");
    expect(plugin.output.el.textContent).toContain('no such workspace: "nope"');
    expect(calls.some((c) => c.path === "/api/start")).toBe(false);
  });

  it("a failed launch surfaces everywhere: log, event log and an error dialog", async () => {
    const { plugin, eventLog, dialogs } = await boot({
      "/api/start": new Response(JSON.stringify({ error: "port busy" }), { status: 400 }),
    });
    await plugin.start("w1");
    expect(plugin.output.el.textContent).toContain("[goo] start failed: port busy");
    expect(texts(eventLog)).toEqual([
      "starting server (workspace: Feature X)|error",
      "start failed: port busy|",
    ]);
    expect(dialogs.dialogs()[0].props.spec).toMatchObject({
      title: "Could not start the server",
      message: "port busy",
    });
    expect(plugin.pending()).toBe("");
  });

  describe("branch mismatch confirmation", () => {
    beforeEach(() => {
      branchState = [{ id: "community", current: "master" }];
    });

    it("asks before starting on other branches; Cancel drops the start", async () => {
      const { plugin, dialogs, eventLog, calls } = await boot();
      const p = plugin.start("w1");
      await vi.waitFor(() => expect(dialogs.dialogs()).toHaveLength(1));
      const { spec, done } = dialogs.dialogs()[0].props as {
        spec: { title: string; message: string };
        done: (v: unknown) => void;
      };
      expect(spec.title).toBe("Branches don't match this workspace");
      expect(spec.message).toContain('community: on "master" — the workspace wants "feat-x"');
      done(null);
      await p;
      expect(calls.some((c) => c.path === "/api/start")).toBe(false);
      expect(eventLog.entries()).toEqual([]);
      expect(plugin.displayState()).toBe("stopped");
    });

    it("'Start anyway' restarts on the current branches", async () => {
      const { plugin, dialogs, calls } = await boot();
      const p = plugin.restart("w1");
      expect(plugin.pending()).toBe("restart");
      await vi.waitFor(() => expect(dialogs.dialogs()).toHaveLength(1));
      (dialogs.dialogs()[0].props.done as (v: unknown) => void)({});
      await p;
      expect(calls.find((c) => c.path === "/api/restart")?.body).toEqual({
        workspace: "w1",
        overrides: {},
      });
    });
  });

  it("restart on an unknown workspace does nothing", async () => {
    const { plugin, calls } = await boot();
    await plugin.restart("nope");
    expect(plugin.pending()).toBe("");
    expect(calls.some((c) => c.path === "/api/restart")).toBe(false);
  });

  it("a second start supersedes the first one's pending event", async () => {
    const { plugin, eventLog } = await boot();
    await plugin.start("w1");
    await plugin.restart("w1");
    expect(texts(eventLog)).toEqual(["restarting server (workspace: Feature X)|pending"]);
  });

  it("stop: optimistic 'stop', logs it, posts /api/stop", async () => {
    const { plugin, eventLog, calls } = await boot();
    const p = plugin.stop();
    expect(plugin.pending()).toBe("stop");
    await p;
    expect(calls.some((c) => c.path === "/api/stop")).toBe(true);
    expect(texts(eventLog)).toEqual(["stopping server|"]);
  });

  it("resume: re-starts the last workspace with no overrides", async () => {
    const { plugin, calls, eventLog } = await boot();
    await plugin.resume();
    expect(calls.find((c) => c.path === "/api/start")?.body).toEqual({
      workspace: "w1",
      overrides: {},
    });
    expect(texts(eventLog)).toEqual(["restarting server (workspace: Feature X)|pending"]);
    plugin.setLastWorkspace("gone");
    calls.length = 0;
    await plugin.resume();
    expect(calls.some((c) => c.path === "/api/start")).toBe(false);
  });
});

describe("ServerPlugin — waitUntilRunning", () => {
  it("resolves at once when already running, else once it comes up", async () => {
    const { plugin, es } = await boot();
    es.emit("server", { id: "main", state: "running" });
    expect(await plugin.waitUntilRunning()).toBe(true);
    es.emit("server", { id: "main", state: "stopped" });
    const p = plugin.waitUntilRunning();
    vi.advanceTimersByTime(300);
    es.emit("server", { id: "main", state: "running" });
    vi.advanceTimersByTime(300);
    expect(await p).toBe(true);
  });

  it("gives up after the timeout", async () => {
    const { plugin } = await boot();
    const p = plugin.waitUntilRunning(1000);
    vi.advanceTimersByTime(1500);
    expect(await p).toBe(false);
  });
});
