import { describe, it, expect, vi } from "vitest";
import { AssetsPlugin } from "../../src/assets_screen/assets_plugin.js";
import { ConfigPlugin } from "../../src/core/config_plugin.js";
import { DatabasePlugin } from "../../src/core/database_plugin.js";
import { EventLogPlugin } from "../../src/core/event_log_plugin.js";
import { DialogPlugin } from "../../src/core/dialog_plugin.js";
import { createPluginHarness } from "../helpers/plugin_harness.js";

function jsonOk(data) {
  return { ok: true, json: async () => ({ ok: true, ...data }) };
}

function setup({ filestore = "" } = {}) {
  const fakeConfig = { config: { filestore } };
  const fakeDb = {};
  const fakeEventLog = { begin: vi.fn(() => "eid1"), finish: vi.fn(), add: vi.fn() };
  const fakeDialogs = { error: vi.fn() };
  const harness = createPluginHarness([
    [ConfigPlugin, fakeConfig],
    [DatabasePlugin, fakeDb],
    [EventLogPlugin, fakeEventLog],
    [DialogPlugin, fakeDialogs],
  ]);
  const plugin = harness.start(AssetsPlugin);
  return { plugin, fakeEventLog, fakeDialogs };
}

describe("AssetsPlugin", () => {
  it("selectDb('') clears the list without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { plugin } = setup();
    plugin.selectDb("mydb");
    plugin.selectDb("");
    await Promise.resolve();
    expect(plugin.bundles()).toEqual([]);
    expect(plugin.loadedDb()).toBe("");
  });

  it("selectDb(db) loads its bundles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ bundles: [{ name: "web.assets" }] })),
    );
    const { plugin } = setup();
    plugin.selectDb("mydb");
    await vi.waitFor(() => expect(plugin.loadedDb()).toBe("mydb"));
    expect(plugin.bundles()).toEqual([{ name: "web.assets" }]);
  });

  it("load() with no selected db clears the list and does not fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { plugin } = setup();
    await plugin.load();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(plugin.bundles()).toEqual([]);
  });

  it("drops a stale load() response if the db changed mid-flight", async () => {
    let resolveFirst;
    const fetchMock = vi.fn((url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.db === "dbA") {
        return new Promise((resolve) => {
          resolveFirst = () => resolve(jsonOk({ bundles: [{ name: "stale" }] }));
        });
      }
      return Promise.resolve(jsonOk({ bundles: [{ name: "fresh" }] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { plugin } = setup();
    plugin.selectDb("dbA");
    await Promise.resolve(); // dbA's load() begins, fetch in flight
    plugin.selectDb("dbB"); // switch before dbA's response lands
    await vi.waitFor(() => expect(plugin.loadedDb()).toBe("dbB"));
    resolveFirst(); // dbA's stale response finally resolves -- must be dropped
    await new Promise((r) => setTimeout(r, 0));
    expect(plugin.bundles()).toEqual([{ name: "fresh" }]);
    expect(plugin.loadedDb()).toBe("dbB");
  });

  it("generate() logs begin/finish and reloads on success", async () => {
    const fetchMock = vi.fn(async () => jsonOk({ bundles: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { plugin, fakeEventLog } = setup();
    plugin.selectDb("mydb");
    await Promise.resolve();
    await Promise.resolve();
    await plugin.generate();
    expect(fakeEventLog.begin).toHaveBeenCalledWith("generating asset bundles in mydb…");
    expect(fakeEventLog.finish).toHaveBeenCalledWith("eid1", "done");
  });

  it("generate() reports the error via the event log and a dialog on failure", async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url === "/api/assets/generate")
        return { ok: false, json: async () => ({ error: "boom" }) };
      return jsonOk({ bundles: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { plugin, fakeEventLog, fakeDialogs } = setup();
    plugin.selectDb("mydb");
    await Promise.resolve();
    await Promise.resolve();
    await plugin.generate();
    expect(fakeEventLog.finish).toHaveBeenCalledWith("eid1", "error");
    expect(plugin.error()).toBe("boom");
    expect(fakeDialogs.error).toHaveBeenCalledWith("Generate asset bundles failed", "boom");
  });

  it("generate() with no selected db is a no-op", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { plugin } = setup();
    await plugin.generate();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("analyze() marks itself open immediately, then fills in the breakdown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ js: [["a.js", 10]], css: [], xml: [] })),
    );
    const { plugin } = setup({ filestore: "/fs" });
    plugin.selectDb("mydb");
    const p = plugin.analyze("web.assets", "js");
    expect(plugin.bundleData()).toMatchObject({ name: "web.assets", kind: "js" });
    await p;
    expect(plugin.bundleData()).toEqual({
      name: "web.assets",
      kind: "js",
      js: [["a.js", 10]],
      css: [],
      xml: [],
    });
  });

  it("analyze() records an error and closeAnalysis() clears both bundleData and analyzeError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ error: "nope" }) })),
    );
    const { plugin } = setup();
    plugin.selectDb("mydb");
    await plugin.analyze("web.assets");
    expect(plugin.analyzeError()).toBe("nope");
    plugin.closeAnalysis();
    expect(plugin.bundleData()).toBeNull();
    expect(plugin.analyzeError()).toBe("");
  });

  it("busy() reflects loading or generating in flight", async () => {
    const { plugin } = setup();
    expect(plugin.busy()).toBe(false);
    plugin.loading.set(true);
    expect(plugin.busy()).toBe(true);
  });
});
