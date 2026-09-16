import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConfigPlugin,
  migrateConfigState,
  migrateToWorkspaces,
} from "../../src/core/config_plugin.js";

describe("migrateConfigState", () => {
  it("renames active_target to active_workspace and drops the old key", () => {
    const { state } = migrateConfigState({}, { active_target: "feature-x" });
    expect(state.active_workspace).toBe("feature-x");
    expect(state).not.toHaveProperty("active_target");
  });

  it("does not clobber an already-present active_workspace with a stray active_target", () => {
    const { state } = migrateConfigState(
      {},
      { active_workspace: "feature-y", active_target: "feature-x" },
    );
    expect(state.active_workspace).toBe("feature-y");
  });

  it("backfills id/checkouts/kind for a stale plain target", () => {
    const { config } = migrateConfigState(
      { targets: [{ name: "My Feature", config: [{ repo: "community", branch: "master" }] }] },
      {},
    );
    expect(config.targets).toEqual([
      {
        name: "My Feature",
        id: "my-feature",
        checkouts: [{ repo: "community", branch: "master" }],
        kind: "plain",
      },
    ]);
  });

  it("backfills kind 'worktree' and freezes worktree.dir when a worktree is present", () => {
    const { config } = migrateConfigState(
      {
        worktree_dir: "/wt",
        targets: [{ name: "Feature", worktree: {}, checkouts: [] }],
      },
      {},
    );
    expect(config.targets[0].kind).toBe("worktree");
    expect(config.targets[0].worktree.dir).toBeTruthy();
    expect(config.targets[0].worktree.dir.startsWith("/wt")).toBe(true);
  });

  it("is a no-op on an already-migrated target list", () => {
    const target = {
      id: "my-feature",
      name: "My Feature",
      checkouts: [{ repo: "community", branch: "master" }],
      kind: "plain",
    };
    const { config } = migrateConfigState({ targets: [target] }, {});
    expect(config.targets).toEqual([target]);
  });

  it("dedupes slug ids across multiple stale targets with the same name", () => {
    const { config } = migrateConfigState(
      {
        targets: [
          { name: "Feature", config: [] },
          { name: "Feature", config: [] },
        ],
      },
      {},
    );
    expect(config.targets.map((t) => t.id)).toEqual(["feature", "feature-2"]);
  });

  it("remaps a name-based active_workspace to the matching target's id", () => {
    const { state } = migrateConfigState(
      { targets: [{ id: "my-feature", name: "My Feature", checkouts: [], kind: "plain" }] },
      { active_workspace: "My Feature" },
    );
    expect(state.active_workspace).toBe("my-feature");
  });

  it("leaves active_workspace alone when it already matches a target id", () => {
    const { state } = migrateConfigState(
      { targets: [{ id: "my-feature", name: "My Feature", checkouts: [], kind: "plain" }] },
      { active_workspace: "my-feature" },
    );
    expect(state.active_workspace).toBe("my-feature");
  });

  it("renames a retired tab id to its successor", () => {
    const { config } = migrateConfigState({ tabs: [{ id: "worktree" }] }, {});
    expect(config.tabs).toEqual([{ id: "workspaces" }]);
  });

  it("drops unknown tab ids and dedupes", () => {
    const { config } = migrateConfigState(
      { tabs: [{ id: "config" }, { id: "retired-thing" }, { id: "config" }] },
      {},
    );
    expect(config.tabs).toEqual([{ id: "config" }]);
  });

  it("tolerates missing config/state entirely", () => {
    const { config, state } = migrateConfigState(undefined, undefined);
    expect(config).toEqual({});
    expect(state).toEqual({});
  });
});

describe("migrateToWorkspaces", () => {
  it("is a no-op (changed: false) when workspaces already exist and nothing else needs migrating", () => {
    const config = {
      workspaces: [
        { id: "w1", name: "w1", created_at: "2024-01-01T00:00:00.000Z", last_activity: "x" },
      ],
    };
    const result = migrateToWorkspaces(config, {});
    expect(result.changed).toBe(false);
    expect(result.config.workspaces).toEqual(config.workspaces);
  });

  it("returns changed: false when there are no targets and no workspaces", () => {
    const result = migrateToWorkspaces({}, {});
    expect(result.changed).toBe(false);
    expect(result.config.workspaces).toBeUndefined();
  });

  it("marks changed: true purely for the active_target rename, even with no targets", () => {
    const result = migrateToWorkspaces({}, { active_target: "x" });
    expect(result.changed).toBe(true);
    expect(result.state.active_workspace).toBe("x");
  });

  it("backfills created_at/last_activity on existing workspaces missing them, oldest-first", () => {
    const config = {
      workspaces: [
        { id: "w1", name: "w1" },
        { id: "w2", name: "w2" },
      ],
    };
    const result = migrateToWorkspaces(config, {});
    expect(result.changed).toBe(true);
    const [w1, w2] = result.config.workspaces;
    expect(w1.created_at).toBeTruthy();
    expect(w1.last_activity).toBe(w1.created_at);
    expect(new Date(w1.created_at).getTime()).toBeLessThan(new Date(w2.created_at).getTime());
  });

  it("converts plain targets into main-location workspaces with no port", () => {
    const config = {
      targets: [{ id: "t1", name: "Feature", checkouts: [], kind: "plain" }],
    };
    const result = migrateToWorkspaces(config, {});
    expect(result.changed).toBe(true);
    expect(result.config.workspaces).toHaveLength(1);
    const w = result.config.workspaces[0];
    expect(w.location).toBe("main");
    expect(w.port).toBeNull();
    expect(result.config.targets).toBeUndefined(); // legacy list dropped from the persisted blob
  });

  it("deals ascending stable ports to worktree targets, skipping reserved ports", () => {
    const config = {
      targets: [
        { id: "t1", name: "One", worktree: {}, checkouts: [], kind: "worktree" },
        { id: "t2", name: "Two", worktree: {}, checkouts: [], kind: "worktree" },
      ],
    };
    const result = migrateToWorkspaces(config, {});
    const ports = result.config.workspaces.map((w) => w.port);
    expect(ports).toEqual([8070, 8071]);
    expect(ports.some((p) => [8069, 8072].includes(p))).toBe(false);
  });

  it("seeds templates only from targets whose checkouts are all base branches, deduped by name", () => {
    const config = {
      targets: [
        {
          id: "t1",
          name: "Base",
          checkouts: [{ repo: "community", branch: "master" }],
          kind: "plain",
        },
        {
          id: "t2",
          name: "Base", // duplicate name — should not produce a second template
          checkouts: [{ repo: "community", branch: "master" }],
          kind: "plain",
        },
        {
          id: "t3",
          name: "Feature branch",
          checkouts: [{ repo: "community", branch: "master-something-jpp" }],
          kind: "plain",
        },
        {
          id: "t4",
          name: "No checkouts",
          checkouts: [],
          kind: "plain",
        },
      ],
    };
    const result = migrateToWorkspaces(config, {});
    expect(result.config.templates.map((t) => t.name)).toEqual(["Base"]);
  });
});

describe("ConfigPlugin", () => {
  // ConfigPlugin has no usePlugin() dependencies (sequence = 1, "everything else may
  // depend on config") — it can be constructed directly without the plugin harness.
  let plugin;

  beforeEach(() => {
    plugin = new ConfigPlugin({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("boots from DEFAULT_CONFIG merged with the empty {} boot payload (no server config loaded)", () => {
    expect(plugin.config.worktree_dir).toBeTruthy(); // DEFAULT_CONFIG value survived the merge
    expect(plugin.rev()).toBe(0);
  });

  it("updateConfig() applies the patch immediately (optimistic) and schedules a flush", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ rev: 1 }),
      })),
    );
    plugin.updateConfig({ db_user: "someone" });
    expect(plugin.config.db_user).toBe("someone"); // optimistic update, before any flush
    expect(fetch).not.toHaveBeenCalled(); // debounced — nothing sent yet

    await vi.advanceTimersByTimeAsync(250);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe("/api/config");
    const body = JSON.parse(opts.body);
    expect(body.rev).toBe(0);
    expect(body.config.db_user).toBe("someone");
    expect(plugin.rev()).toBe(1); // adopted the server's new rev after a successful flush
  });

  it("coalesces multiple updateConfig() calls within the debounce window into one flush", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ rev: 1 }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    plugin.updateConfig({ db_user: "a" });
    await vi.advanceTimersByTimeAsync(100);
    plugin.updateConfig({ db_password: "b" });
    await vi.advanceTimersByTimeAsync(250);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.config.db_user).toBe("a");
    expect(body.config.db_password).toBe("b");
  });

  it("retries once on a 409 conflict, adopting the server's rev before resending", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ rev: 5 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ rev: 6 }) });
    vi.stubGlobal("fetch", fetchMock);
    plugin.updateConfig({ db_user: "someone" });
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(0); // let the recursive _flush's microtasks settle
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).rev).toBe(5);
    expect(plugin.rev()).toBe(6);
  });

  it("re-marks the change dirty on a network failure, so a later flush can retry", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    plugin.updateConfig({ db_user: "someone" });
    await vi.advanceTimersByTimeAsync(250);
    expect(plugin.rev()).toBe(0); // failed flush never adopted a new rev
    expect(errSpy).toHaveBeenCalled();
    // the failed write's dirty flag was restored — a later touch() finds work still pending
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ rev: 2 }) })),
    );
    plugin.touch();
    await vi.advanceTimersByTimeAsync(250);
    expect(plugin.rev()).toBe(2);
    errSpy.mockRestore();
  });

  it("getState/setState round-trip through the AppState record and schedule a flush", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ rev: 1 }) })),
    );
    // AppState's char fields default to "" (not undefined) — see toModels'
    // `state[k] ?? ""` seeding — so an unset field reads back as "", not the
    // fallback (getState only falls back on undefined/null).
    expect(plugin.getState("claude_model", "fallback")).toBe("");
    plugin.setState("claude_model", "opus");
    expect(plugin.getState("claude_model", "fallback")).toBe("opus");
    await vi.advanceTimersByTimeAsync(250);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.state.claude_model).toBe("opus");
  });

  it("applyBroadcast ignores a stale/equal rev and a broadcast while a local edit is pending", () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ rev: 1 }) })),
    );
    plugin.applyBroadcast({ rev: 0, config: { db_user: "ignored" }, state: {} });
    expect(plugin.config.db_user).not.toBe("ignored"); // rev 0 is not newer than ours (0)

    plugin.updateConfig({ db_user: "local-edit" }); // now dirty
    plugin.applyBroadcast({ rev: 5, config: { db_user: "remote" }, state: {} });
    expect(plugin.config.db_user).toBe("local-edit"); // dropped: a local edit is pending
  });

  it("applyBroadcast reloads from a newer rev when nothing local is pending", () => {
    plugin.applyBroadcast({ rev: 5, config: { db_user: "remote" }, state: {} });
    expect(plugin.rev()).toBe(5);
    expect(plugin.config.db_user).toBe("remote");
  });
});
