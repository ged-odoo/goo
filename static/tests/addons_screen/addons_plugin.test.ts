import { describe, it, expect, vi } from "vitest";
import { signal } from "@odoo/owl";
import { AddonsPlugin } from "../../src/addons_screen/addons_plugin.ts";
import type { AddonModule } from "../../src/addons_screen/addons_plugin.ts";
import type { RunSnapshot } from "../../src/core/runtime_models.ts";
import type { WorktreeRepo } from "../../src/core/workspace_plugin.ts";
import { ConfigPlugin } from "../../src/core/config_plugin.ts";
import { StorePlugin } from "../../src/core/store_plugin.ts";
import { ServerPlugin } from "../../src/core/server_plugin.ts";
import { EventLogPlugin } from "../../src/core/event_log_plugin.ts";
import { DialogPlugin } from "../../src/core/dialog_plugin.ts";
import { WorkspacePlugin } from "../../src/core/workspace_plugin.ts";
import { createPluginHarness } from "../helpers/plugin_harness.ts";

function jsonOk(data: object) {
  return { ok: true, json: async () => ({ ok: true, ...data }) };
}

function mod(fields: Partial<AddonModule> & { name: string }): AddonModule {
  return {
    repo: "community",
    category: "",
    summary: "",
    application: false,
    installable: true,
    state: null,
    ...fields,
  };
}

function setup({
  dialogAnswer = true,
  runs = [] as RunSnapshot[],
}: { dialogAnswer?: boolean; runs?: RunSnapshot[] } = {}) {
  const fakeConfig = {
    config: { repos: [{ id: "community", path: "/main/community" }] },
    workspace: vi.fn(() => ({ touchActivity: vi.fn() })),
  };
  const fakeStore = {
    runs: signal(runs),
    latestRunOfKind: (kind: string, slot: string) =>
      runs.find((r) => r.kind === kind && (r.server ?? "main") === slot) || null,
  };
  const fakeServer = { onLog: vi.fn() };
  const fakeEventLog = { add: vi.fn() };
  const fakeDialogs = { open: vi.fn(async () => dialogAnswer) };
  const fakeWorktree = { wtRepos: vi.fn((): Partial<WorktreeRepo>[] => []) };
  const harness = createPluginHarness([
    [ConfigPlugin, fakeConfig],
    [StorePlugin, fakeStore],
    [ServerPlugin, fakeServer],
    [EventLogPlugin, fakeEventLog],
    [DialogPlugin, fakeDialogs],
    [WorkspacePlugin, fakeWorktree],
  ]);
  const plugin = harness.start(AddonsPlugin);
  return { plugin, fakeStore, fakeServer, fakeEventLog, fakeDialogs, fakeWorktree };
}

describe("AddonsPlugin", () => {
  it("slot() memoizes per-slot state", () => {
    const { plugin } = setup();
    const a = plugin.slot("main");
    const b = plugin.slot("main");
    expect(a).toBe(b);
    expect(plugin.slot("wt-1")).not.toBe(a);
  });

  it("load() populates a slot's modules for a main-checkout workspace", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ modules: [{ name: "sale" }] })),
    );
    const { plugin } = setup();
    const ws = {
      id: "main",
      db: "mydb",
      location: "main",
      checkouts: [{ repo: "community", branch: "master" }],
    };
    await plugin.load(ws);
    expect(plugin.slot("main").modules()).toEqual([{ name: "sale" }]);
    expect(plugin.slot("main").loadedDb()).toBe("mydb");
  });

  it("load() with no workspace is a no-op", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { plugin } = setup();
    await plugin.load(null);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("load() with no db clears the slot without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { plugin } = setup();
    await plugin.load({ id: "main", db: "", location: "main", checkouts: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(plugin.slot("main").modules()).toEqual([]);
  });

  it("load() failure records the error and remembers the failed db (erroredDb)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ error: "boom" }) })),
    );
    const { plugin } = setup();
    const ws = { id: "main", db: "mydb", location: "main", checkouts: [] };
    await plugin.load(ws);
    const s = plugin.slot("main");
    expect(s.error()).toBe("boom");
    expect(s.erroredDb()).toBe("mydb");
  });

  it("a worktree workspace's slot is keyed by its id, using its own checkout repos", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ modules: [] })),
    );
    const { plugin, fakeWorktree } = setup();
    fakeWorktree.wtRepos.mockReturnValue([{ repo: "community", worktreePath: "/wt/f/community" }]);
    const ws = { id: "wt-1", db: "mydb", location: "worktree" };
    await plugin.load(ws);
    expect(plugin.slot("wt-1").loadedDb()).toBe("mydb");
    expect(fakeWorktree.wtRepos).toHaveBeenCalledWith(ws);
  });

  it("_filtered applies text/state/appOnly filters and caps at MAX_ROWS", () => {
    const { plugin } = setup();
    const s = plugin.slot("main");
    s.modules.set([
      mod({ name: "sale", state: "installed", application: true }),
      mod({ name: "sale_stock", state: "uninstalled", application: true }),
      mod({ name: "base", state: "installed", application: false }),
    ]);
    plugin.appOnly.set(true);
    expect(s.filtered().shown.map((m) => m.name)).toEqual(["sale", "sale_stock"]);
    plugin.stateFilter.set("installed");
    expect(s.filtered().shown.map((m) => m.name)).toEqual(["sale"]);
    plugin.filter.set("stock");
    plugin.stateFilter.set("");
    expect(s.filtered().shown.map((m) => m.name)).toEqual(["sale_stock"]);
  });

  it("run() does nothing without confirming the dialog first", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { plugin } = setup({ dialogAnswer: false });
    await plugin.run("install", "sale", { id: "main", db: "mydb" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("run() posts the op and sets pending/status optimistically", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({})),
    );
    const { plugin, fakeEventLog } = setup();
    const ws = { id: "main", db: "mydb", touchActivity: () => {} };
    await plugin.run("install", "sale", ws);
    expect(fakeEventLog.add).toHaveBeenCalledWith("installing sale in mydb");
  });

  it("run() records a failure to start", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ error: "busy" }) })),
    );
    const { plugin } = setup();
    const ws = { id: "main", db: "mydb", touchActivity: () => {} };
    await plugin.run("upgrade", "sale", ws);
    const s = plugin.slot("main");
    expect(s.pending()).toBe(false);
    expect(s.status()).toBe("failed to start: busy");
  });

  it("run() with no db is a no-op", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { plugin } = setup();
    await plugin.run("install", "sale", { id: "main", db: "" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("_onRun transitions pending->running->done and triggers a reload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ modules: [] })),
    );
    const { plugin } = setup();
    const s = plugin.slot("main");
    s.pending.set(true);
    s.lastWs = { id: "main", db: "mydb", location: "main", checkouts: [] };
    plugin._onRun("main", { id: "1", kind: "install", state: "running" });
    expect(s.pending()).toBe(false);
    expect(s.status()).toBe("installing…");
    plugin._onRun("main", { id: "1", kind: "install", state: "done", returncode: 0 });
    expect(s.status()).toBe("done");
  });

  it("_onRun ignores a finished run it never saw start (e.g. after a page reload)", () => {
    const { plugin } = setup();
    const s = plugin.slot("main");
    plugin._onRun("main", { id: "99", kind: "install", state: "done", returncode: 0 });
    expect(s.status()).toBe(""); // untouched -- announced never matched
  });

  it("runningFor() reflects a currently-running run for that slot", () => {
    const runs = [{ id: "1", kind: "install", server: "main", state: "running" }];
    const { plugin } = setup({ runs });
    expect(plugin.runningFor("main")).toBe(true);
    expect(plugin.runningFor("wt-1")).toBe(false);
  });

  it("setup()'s log routing appends only to the currently-active slot", () => {
    const { plugin, fakeServer } = setup();
    plugin.slot("main").pending.set(true); // runActive("main") -> true
    const onLog = fakeServer.onLog.mock.calls[0][0];
    onLog({ server: "main", line: "hello" });
    expect(plugin.slot("main").output.el.textContent).toContain("hello");
  });
});
