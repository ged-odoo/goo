import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigPlugin } from "../../src/core/config_plugin.js";
import { StorePlugin } from "../../src/core/store_plugin.js";
import { ServerPlugin } from "../../src/core/server_plugin.js";
import { CodePlugin } from "../../src/core/code_plugin.js";
import { EventLogPlugin } from "../../src/core/event_log_plugin.js";
import { DialogPlugin } from "../../src/core/dialog_plugin.js";
import { WorkspacePlugin, cascadeRemoveDescendants } from "../../src/core/workspace_plugin.js";
import { createPluginHarness } from "../helpers/plugin_harness.js";

function fakeConfig(overrides = {}) {
  return {
    config: { workspaces: [], main_repo_id: "", ...overrides.config },
    workspace: overrides.workspace || (() => null),
    updateConfig: vi.fn(),
  };
}

function fakeStore(overrides = {}) {
  return {
    server: overrides.server || (() => null),
    mergeServer: vi.fn(),
    dropServer: vi.fn(),
    dropWorktreeRepoStatusFor: vi.fn(),
  };
}

function fakeServerPlugin(overrides = {}) {
  return {
    onWorktree: vi.fn(),
    onLog: vi.fn(),
    loadedWorkspaceId: overrides.loadedWorkspaceId || (() => ""),
    ...overrides,
  };
}

function fakeCode(overrides = {}) {
  return {
    groups: () => ({ pathByRepo: {}, pullRemoteByRepo: {}, githubByRepo: {}, ...overrides.groups }),
    openEditorPaths: vi.fn(),
  };
}

function fakeEventLog() {
  return { begin: vi.fn(() => "eid"), finish: vi.fn(), add: vi.fn() };
}

function fakeDialogs(overrides = {}) {
  return { open: overrides.open || vi.fn(), error: vi.fn() };
}

// builds a WorkspacePlugin with every usePlugin() sibling faked as a plain object
function buildPlugin(fakes = {}) {
  const config = fakes.config || fakeConfig();
  const store = fakes.store || fakeStore();
  const server = fakes.server || fakeServerPlugin();
  const code = fakes.code || fakeCode();
  const eventLog = fakes.eventLog || fakeEventLog();
  const dialogs = fakes.dialogs || fakeDialogs();
  const harness = createPluginHarness([
    [ConfigPlugin, config],
    [StorePlugin, store],
    [ServerPlugin, server],
    [CodePlugin, code],
    [EventLogPlugin, eventLog],
    [DialogPlugin, dialogs],
  ]);
  const plugin = harness.start(WorkspacePlugin);
  return { plugin, config, store, server, code, eventLog, dialogs };
}

beforeEach(() => {
  // setup()'s load() calls postJSON only when there are worktree workspaces to
  // hydrate; default to an inert response so tests that don't care don't need
  // their own stub.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ servers: {} }) })),
  );
});

describe("WorkspacePlugin.isWorktree", () => {
  it("uses the config record's isWorktree() when one exists", () => {
    const record = { isWorktree: () => true };
    const { plugin } = buildPlugin({ config: fakeConfig({ workspace: () => record }) });
    expect(plugin.isWorktree({ id: "w1" })).toBe(true);
  });

  it("falls back to location/worktree on a transient (not-yet-persisted) spec", () => {
    const { plugin } = buildPlugin();
    expect(plugin.isWorktree(null)).toBe(false);
    expect(plugin.isWorktree({ location: "worktree" })).toBe(true);
    expect(plugin.isWorktree({ worktree: { dir: "/x" } })).toBe(true);
    expect(plugin.isWorktree({})).toBe(false);
  });
});

describe("WorkspacePlugin.worktreeWorkspaces / selected / select", () => {
  it("filters to worktree-located workspaces only", () => {
    const workspaces = [
      { id: "a", location: "worktree" },
      { id: "b", location: "main" },
    ];
    const { plugin } = buildPlugin({ config: fakeConfig({ config: { workspaces } }) });
    expect(plugin.worktreeWorkspaces().map((w) => w.id)).toEqual(["a"]);
  });

  it("select() persists to localStorage and updates selectedId", () => {
    const { plugin } = buildPlugin();
    plugin.select("wt-1");
    expect(plugin.selectedId()).toBe("wt-1");
    expect(localStorage.getItem("goo-workspace-selected")).toBe("wt-1");
    plugin.select("");
    expect(localStorage.getItem("goo-workspace-selected")).toBeNull();
  });

  it("select() on a worktree workspace primes logs (fetches its tail)", async () => {
    const workspaces = [{ id: "wt-1", location: "worktree" }];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ lines: ["hello"] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { plugin } = buildPlugin({ config: fakeConfig({ config: { workspaces } }) });
    plugin.select("wt-1");
    await new Promise((r) => setTimeout(r, 0)); // flush the fetch -> json -> append chain
    expect(plugin.logBuffer("wt-1").count()).toBe(1);
  });

  it("selected() finds the current selection among worktree workspaces", () => {
    const workspaces = [{ id: "wt-1", location: "worktree" }];
    const { plugin } = buildPlugin({ config: fakeConfig({ config: { workspaces } }) });
    plugin.select("wt-1");
    expect(plugin.selected()).toBe(workspaces[0]);
    plugin.select("missing");
    expect(plugin.selected()).toBeNull();
  });
});

describe("WorkspacePlugin.dirPath / hasMainRepo", () => {
  it("dirPath: uses the record's dirPath() when one exists, else derives from worktree.dir", () => {
    const record = { dirPath: () => "/from/record" };
    const withRecord = buildPlugin({ config: fakeConfig({ workspace: () => record }) });
    expect(withRecord.plugin.dirPath({ id: "w1" })).toBe("/from/record");

    const transient = buildPlugin();
    expect(transient.plugin.dirPath({ worktree: { dir: "/frozen/dir" } })).toBe("/frozen/dir");
  });

  it("hasMainRepo: transient fallback defaults main_repo_id to community", () => {
    const { plugin } = buildPlugin({ config: fakeConfig({ config: { main_repo_id: "" } }) });
    expect(plugin.hasMainRepo({ checkouts: [{ repo: "community" }] })).toBe(true);
    expect(plugin.hasMainRepo({ checkouts: [{ repo: "enterprise" }] })).toBe(false);
  });

  it("hasMainRepo: honors a configured main_repo_id", () => {
    const { plugin } = buildPlugin({ config: fakeConfig({ config: { main_repo_id: "odoo" } }) });
    expect(plugin.hasMainRepo({ checkouts: [{ repo: "odoo" }] })).toBe(true);
    expect(plugin.hasMainRepo({ checkouts: [{ repo: "community" }] })).toBe(false);
  });
});

describe("WorkspacePlugin live-state readers", () => {
  it("state/exists/serverState/running/port read through the store facade", () => {
    const server = () => ({ exists: true, state: "running", port: 8080 });
    const { plugin } = buildPlugin({ store: fakeStore({ server }) });
    const tgt = { id: "wt-1" };
    expect(plugin.exists(tgt)).toBe(true);
    expect(plugin.serverState(tgt)).toBe("running");
    expect(plugin.running(tgt)).toBe(true);
    expect(plugin.port(tgt)).toBe(8080);
  });

  it("defaults to stopped/no-port when the store has nothing for this id", () => {
    const { plugin } = buildPlugin();
    const tgt = { id: "unknown" };
    expect(plugin.exists(tgt)).toBe(false);
    expect(plugin.serverState(tgt)).toBe("stopped");
    expect(plugin.running(tgt)).toBe(false);
    expect(plugin.port(tgt)).toBeNull();
  });

  it("running() is true for both 'running' and 'starting' states", () => {
    let state = "starting";
    const { plugin } = buildPlugin({ store: fakeStore({ server: () => ({ state }) }) });
    expect(plugin.running({ id: "x" })).toBe(true);
  });
});

describe("WorkspacePlugin._newId", () => {
  it("dedupes against already-taken ids", () => {
    const workspaces = [{ id: "wt-feature" }, { id: "wt-feature-2" }];
    const { plugin } = buildPlugin({ config: fakeConfig({ config: { workspaces } }) });
    expect(plugin._newId("feature")).toBe("wt-feature-3");
  });

  it("slugifies the seed", () => {
    const { plugin } = buildPlugin();
    expect(plugin._newId("My Cool Feature!!")).toBe("wt-my-cool-feature");
  });
});

describe("WorkspacePlugin.startServer / stopServer", () => {
  it("startServer errors out without touching the network when there's no main repo checkout", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const dialogs = fakeDialogs();
    const { plugin } = buildPlugin({
      dialogs,
      config: fakeConfig({ config: { main_repo_id: "community" } }),
    });
    await plugin.startServer({ id: "w1", checkouts: [{ repo: "enterprise" }] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dialogs.error).toHaveBeenCalledWith(
      "Cannot start the server",
      "this workspace has no main repo checkout",
    );
  });

  it("startServer is a no-op if already running", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { plugin } = buildPlugin({ store: fakeStore({ server: () => ({ state: "running" }) }) });
    await plugin.startServer({ id: "w1", checkouts: [{ repo: "community" }] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("startServer merges the returned port on success, without re-asserting 'starting'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ port: 9001 }) })),
    );
    const store = fakeStore();
    const { plugin } = buildPlugin({
      store,
      config: fakeConfig({ config: { main_repo_id: "community" } }),
    });
    await plugin.startServer({ id: "w1", name: "feature", checkouts: [{ repo: "community" }] });
    // once for the optimistic "starting" merge, once for the port-only merge
    expect(store.mergeServer).toHaveBeenNthCalledWith(1, { id: "w1", state: "starting" });
    expect(store.mergeServer).toHaveBeenNthCalledWith(2, { id: "w1", port: 9001 });
  });

  it("startServer resets to stopped and reports the error on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) })),
    );
    const store = fakeStore();
    const dialogs = fakeDialogs();
    const { plugin } = buildPlugin({
      store,
      dialogs,
      config: fakeConfig({ config: { main_repo_id: "community" } }),
    });
    await plugin.startServer({ id: "w1", name: "feature", checkouts: [{ repo: "community" }] });
    expect(store.mergeServer).toHaveBeenLastCalledWith({ id: "w1", state: "stopped" });
    expect(dialogs.error).toHaveBeenCalledWith("Could not start the server", "boom");
  });

  it("stopServer optimistically merges 'stopping' and swallows a backend error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "nope" }) })),
    );
    const store = fakeStore();
    const { plugin } = buildPlugin({ store });
    await expect(plugin.stopServer({ id: "w1", name: "feature" })).resolves.toBeUndefined();
    expect(store.mergeServer).toHaveBeenCalledWith({ id: "w1", state: "stopping" });
  });
});

describe("WorkspacePlugin.remove / removeSilently", () => {
  it("remove() refuses while the server is running", async () => {
    const dialogs = fakeDialogs();
    const { plugin } = buildPlugin({
      store: fakeStore({ server: () => ({ state: "running" }) }),
      dialogs,
    });
    await plugin.remove({ id: "w1", name: "feature" });
    expect(dialogs.error).toHaveBeenCalledWith(
      "Stop the server first",
      "Stop the workspace's server before removing it.",
    );
    expect(dialogs.open).not.toHaveBeenCalled();
  });

  it("remove() drops the workspace from config on confirm", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    const workspaces = [{ id: "w1", name: "feature", checkouts: [] }];
    const config = fakeConfig({ config: { workspaces } });
    const dialogs = fakeDialogs({ open: vi.fn(async () => ({ dropDb: false })) });
    const { plugin } = buildPlugin({ config, dialogs });
    plugin.select("w1");
    await plugin.remove(workspaces[0]);
    expect(config.updateConfig).toHaveBeenCalledWith({ workspaces: [] });
    // through select(), not just the raw signal, so the remembered selection clears
    expect(plugin.selectedId()).toBe("");
  });

  it("remove() cancelled (dialog dismissed) leaves the workspace in place", async () => {
    const config = fakeConfig({ config: { workspaces: [{ id: "w1", checkouts: [] }] } });
    const dialogs = fakeDialogs({ open: vi.fn(async () => null) });
    const { plugin } = buildPlugin({ config, dialogs });
    await plugin.remove({ id: "w1", checkouts: [] });
    expect(config.updateConfig).not.toHaveBeenCalled();
  });

  it("removeSilently() refuses to touch a running server, matching remove()'s guard", async () => {
    const config = fakeConfig();
    const { plugin } = buildPlugin({
      config,
      store: fakeStore({ server: () => ({ state: "running" }) }),
    });
    expect(await plugin.removeSilently({ id: "w1" })).toBe(false);
    expect(config.updateConfig).not.toHaveBeenCalled();
  });
});

describe("cascadeRemoveDescendants", () => {
  function plugins({ workspaces, running = () => false, loadedWorkspaceId = () => "" }) {
    const config = fakeConfig({ config: { workspaces } });
    const wt = { running, removeSilently: vi.fn(async () => true) };
    const eventLog = fakeEventLog();
    const server = { loadedWorkspaceId };
    return { config, wt, eventLog, server };
  }

  it("removes a worktree child that isn't busy, breadth-first", async () => {
    const workspaces = [
      { id: "child", parent: "root", location: "worktree" },
      { id: "grandchild", parent: "child", location: "worktree" },
    ];
    const p = plugins({ workspaces });
    const { skipped } = await cascadeRemoveDescendants(p, { id: "root", name: "root" });
    expect(skipped).toEqual([]);
    expect(p.wt.removeSilently).toHaveBeenCalledTimes(2);
    expect(p.wt.removeSilently.mock.calls.map(([w]) => w.id)).toEqual(["child", "grandchild"]);
  });

  it("skips a busy worktree child and demotes it to root, leaving its subtree untouched", async () => {
    const workspaces = [
      { id: "busy", parent: "root", location: "worktree" },
      { id: "leaf", parent: "busy", location: "worktree" },
    ];
    const record = { setParent: vi.fn() };
    const config = fakeConfig({ config: { workspaces }, workspace: () => record });
    const wt = { running: (w) => w.id === "busy", removeSilently: vi.fn(async () => true) };
    const eventLog = fakeEventLog();
    const server = { loadedWorkspaceId: () => "" };
    const { skipped } = await cascadeRemoveDescendants(
      { config, wt, eventLog, server },
      { id: "root", name: "root" },
    );
    expect(skipped.map((w) => w.id)).toEqual(["busy"]);
    expect(record.setParent).toHaveBeenCalledWith("");
    expect(wt.removeSilently).not.toHaveBeenCalled(); // "leaf" (busy's child) untouched
  });

  it("skips a busy main-located child (the loaded workspace) via isLoadedMainWorkspace", async () => {
    const workspaces = [{ id: "main-child", parent: "root", location: "main" }];
    const p = plugins({ workspaces, loadedWorkspaceId: () => "main-child" });
    const { skipped } = await cascadeRemoveDescendants(p, { id: "root", name: "root" });
    expect(skipped.map((w) => w.id)).toEqual(["main-child"]);
  });

  it("removes a non-busy main-located child via config.updateConfig, not wt.removeSilently", async () => {
    const workspaces = [{ id: "main-child", parent: "root", location: "main" }];
    const p = plugins({ workspaces });
    await cascadeRemoveDescendants(p, { id: "root", name: "root" });
    expect(p.wt.removeSilently).not.toHaveBeenCalled();
    expect(p.config.updateConfig).toHaveBeenCalledWith({ workspaces: [] });
  });
});
