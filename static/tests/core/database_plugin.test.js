import { describe, it, expect, vi } from "vitest";
import { signal } from "@odoo/owl";
import { DatabasePlugin } from "../../src/core/database_plugin.js";
import { ServerPlugin } from "../../src/core/server_plugin.js";
import { EventLogPlugin } from "../../src/core/event_log_plugin.js";
import { ConfigPlugin } from "../../src/core/config_plugin.js";
import { createPluginHarness } from "../helpers/plugin_harness.js";

function jsonOk(data) {
  return { ok: true, json: async () => ({ ok: true, ...data }) };
}

function setup({ status = "stopped", filestore = "" } = {}) {
  const fakeServer = {
    status: signal({ state: status, db: "foo" }),
    stop: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
  };
  const fakeEventLog = { add: vi.fn() };
  const fakeConfig = { config: { filestore } };
  const harness = createPluginHarness([
    [ServerPlugin, fakeServer],
    [EventLogPlugin, fakeEventLog],
    [ConfigPlugin, fakeConfig],
  ]);
  const plugin = harness.start(DatabasePlugin);
  return { plugin, fakeServer, fakeEventLog };
}

describe("DatabasePlugin", () => {
  it("initial mount's rising-edge effect loads the list when the server starts running", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ databases: [{ name: "foo" }] })),
    );
    const { plugin } = setup({ status: "running" });
    await Promise.resolve();
    await Promise.resolve();
    expect(plugin.databases()).toEqual([{ name: "foo" }]);
  });

  it("does not auto-load when the server starts already stopped", async () => {
    const fetchMock = vi.fn(async () => jsonOk({ databases: [] }));
    vi.stubGlobal("fetch", fetchMock);
    setup({ status: "stopped" });
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("_onStatus only loads on the stopped->running rising edge, not on repeats", async () => {
    const fetchMock = vi.fn(async () => jsonOk({ databases: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { plugin } = setup({ status: "stopped" });
    await Promise.resolve();
    await Promise.resolve();
    fetchMock.mockClear();
    plugin._onStatus({ state: "running" });
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();
    plugin._onStatus({ state: "running" }); // already running -- not a new rising edge
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("load(force) requests the ?refresh=1 URL and load() without force does not", async () => {
    const fetchMock = vi.fn(async () => jsonOk({ databases: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { plugin } = setup();
    await plugin.load(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/databases?refresh=1");
    await plugin.load();
    expect(fetchMock).toHaveBeenCalledWith("/api/databases");
  });

  it("load() records the fetched databases and timestamp", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ databases: [{ name: "a" }] })),
    );
    const { plugin } = setup();
    await plugin.load();
    expect(plugin.databases()).toEqual([{ name: "a" }]);
    expect(plugin.error()).toBe("");
    expect(plugin.loading()).toBe(false);
  });

  it("load() surfaces a data.ok=false error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ ok: false, error: "boom" }) })),
    );
    const { plugin } = setup();
    await plugin.load();
    expect(plugin.error()).toBe("boom");
    expect(plugin.loading()).toBe(false);
  });

  it("drop() posts and reloads on success, clearing `dropping` in all cases", async () => {
    const fetchMock = vi.fn(async (url, opts) => {
      if (opts?.method === "POST") return jsonOk({});
      return jsonOk({ databases: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { plugin, fakeEventLog } = setup();
    const result = await plugin.drop("mydb");
    expect(result).toBeNull();
    expect(plugin.dropping()).toBe("");
    expect(fakeEventLog.add).toHaveBeenCalledWith("dropping database mydb");
  });

  it("drop() returns the error message and logs failure on rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ error: "cannot drop" }) })),
    );
    const { plugin, fakeEventLog } = setup();
    const result = await plugin.drop("mydb");
    expect(result).toBe("cannot drop");
    expect(plugin.dropping()).toBe("");
    expect(fakeEventLog.add).toHaveBeenCalledWith("failed to drop database mydb: cannot drop");
  });

  it("clone() sends source/dest/filestore and reloads on success", async () => {
    const fetchMock = vi.fn(async (url, opts) => {
      if (opts?.method === "POST") {
        expect(JSON.parse(opts.body)).toEqual({ source: "a", dest: "b", filestore: "/fs" });
        return jsonOk({});
      }
      return jsonOk({ databases: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { plugin } = setup({ filestore: "/fs" });
    const result = await plugin.clone("a", "b");
    expect(result).toBeNull();
  });

  it("rename() returns the error message on failure without reloading", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, json: async () => ({ error: "taken" }) }));
    vi.stubGlobal("fetch", fetchMock);
    const { plugin } = setup();
    const result = await plugin.rename("a", "b");
    expect(result).toBe("taken");
    expect(fetchMock).toHaveBeenCalledTimes(1); // no reload after a failed rename
  });

  it("cloneStoppingServer() stops and resumes the server only when cloning the active db", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ databases: [] })),
    );
    const { plugin, fakeServer } = setup({ status: "running" });
    await plugin.cloneStoppingServer("foo", "bar"); // "foo" is the active db per setup()
    expect(fakeServer.stop).toHaveBeenCalledTimes(1);
    expect(fakeServer.resume).toHaveBeenCalledTimes(1);
  });

  it("cloneStoppingServer() does not touch the server when cloning a non-active db", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ databases: [] })),
    );
    const { plugin, fakeServer } = setup({ status: "running" });
    await plugin.cloneStoppingServer("other", "bar");
    expect(fakeServer.stop).not.toHaveBeenCalled();
    expect(fakeServer.resume).not.toHaveBeenCalled();
  });

  it("dropStoppingServer() stops (but never resumes) the server when dropping the active db", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ databases: [] })),
    );
    const { plugin, fakeServer } = setup({ status: "running" });
    await plugin.dropStoppingServer("foo");
    expect(fakeServer.stop).toHaveBeenCalledTimes(1);
    expect(fakeServer.resume).not.toHaveBeenCalled();
  });
});
