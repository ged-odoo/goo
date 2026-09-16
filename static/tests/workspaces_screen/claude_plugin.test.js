import { describe, expect, it, vi, beforeEach } from "vitest";
import { ClaudePlugin } from "../../src/workspaces_screen/claude_plugin.js";
import { ConfigPlugin } from "../../src/core/config_plugin.js";
import { ServerPlugin } from "../../src/core/server_plugin.js";
import { WorkspacePlugin } from "../../src/core/workspace_plugin.js";
import { EventLogPlugin } from "../../src/core/event_log_plugin.js";
import { DialogPlugin } from "../../src/core/dialog_plugin.js";
import { createPluginHarness } from "../helpers/plugin_harness.js";

function makePlugin() {
  const claudeListeners = new Set();
  const server = {
    onClaude: (cb) => claudeListeners.add(cb),
  };
  const config = {
    getState: () => "",
    setState: vi.fn(),
    config: { main_repo_id: "community", repos: [{ id: "community", path: "/main/community" }] },
    workspace: () => ({ touchActivity: vi.fn() }),
  };
  const worktree = { isWorktree: () => false, wtRepos: () => [] };
  const eventLog = { add: vi.fn() };
  const dialogs = { error: vi.fn() };
  const harness = createPluginHarness([
    [ConfigPlugin, config],
    [ServerPlugin, server],
    [WorkspacePlugin, worktree],
    [EventLogPlugin, eventLog],
    [DialogPlugin, dialogs],
  ]);
  const plugin = harness.start(ClaudePlugin);
  return {
    plugin,
    config,
    worktree,
    dialogs,
    emitClaude: (d) => claudeListeners.forEach((cb) => cb(d)),
  };
}

describe("ClaudePlugin.apply (SSE chat relay)", () => {
  it("ignores an event with no workspace id", () => {
    const { plugin, emitClaude } = makePlugin();
    emitClaude({ role: "assistant", text: "hi" });
    expect(plugin.items("w1")).toEqual([]);
  });

  it("appends a normal chat item to that workspace's conversation", () => {
    const { plugin, emitClaude } = makePlugin();
    emitClaude({ workspace: "w1", role: "assistant", text: "hi" });
    expect(plugin.items("w1")).toEqual([{ workspace: "w1", role: "assistant", text: "hi" }]);
  });

  it("a successful result flips the conversation back to idle without appending", () => {
    const { plugin, emitClaude } = makePlugin();
    emitClaude({ workspace: "w1", role: "assistant", text: "working..." });
    emitClaude({ workspace: "w1", role: "result", ok: true });
    expect(plugin.items("w1")).toHaveLength(1);
    expect(plugin.running("w1")).toBe(false);
  });

  it("a failed result is appended as an item AND flips back to idle", () => {
    const { plugin, emitClaude } = makePlugin();
    emitClaude({ workspace: "w1", role: "result", ok: false, error: "boom" });
    expect(plugin.items("w1")).toEqual([
      { workspace: "w1", role: "result", ok: false, error: "boom" },
    ]);
    expect(plugin.running("w1")).toBe(false);
  });
});

describe("ClaudePlugin.reviewScore", () => {
  it("returns null when no assistant message ever reported a score", () => {
    const { plugin, emitClaude } = makePlugin();
    emitClaude({ workspace: "w1", role: "assistant", text: "just chatting" });
    expect(plugin.reviewScore("w1")).toBeNull();
  });

  it("returns the LAST reported score across the conversation (a re-review wins)", () => {
    const { plugin, emitClaude } = makePlugin();
    emitClaude({ workspace: "w1", role: "assistant", text: "Score: 40/100" });
    emitClaude({ workspace: "w1", role: "assistant", text: "Score: 90/100" });
    expect(plugin.reviewScore("w1")).toBe(90);
  });

  it("ignores non-assistant items and items with no text", () => {
    const { plugin, emitClaude } = makePlugin();
    emitClaude({ workspace: "w1", role: "user", text: "Score: 10/100" });
    emitClaude({ workspace: "w1", role: "assistant" });
    expect(plugin.reviewScore("w1")).toBeNull();
  });
});

describe("ClaudePlugin.setModel", () => {
  it("persists the chosen model, defaulting a falsy value to the empty string", () => {
    const { plugin, config } = makePlugin();
    plugin.setModel("opus");
    expect(plugin.model()).toBe("opus");
    expect(config.setState).toHaveBeenCalledWith("claude_model", "opus");
    plugin.setModel(null);
    expect(plugin.model()).toBe("");
    expect(config.setState).toHaveBeenCalledWith("claude_model", "");
  });
});

describe("ClaudePlugin._dirsFor", () => {
  it("a worktree target without a main-repo checkout errors and returns null", () => {
    const { plugin, worktree, dialogs } = makePlugin();
    worktree.isWorktree = () => true;
    worktree.wtRepos = () => [{ repo: "enterprise", worktreePath: "/wt/enterprise" }];
    const result = plugin._dirsFor({ id: "w1" });
    expect(result).toBeNull();
    expect(dialogs.error).toHaveBeenCalledWith(
      "Cannot run Claude",
      "this worktree has no main repo checkout",
    );
  });

  it("a worktree target resolves cwd to the main repo, addDirs to the rest", () => {
    const { plugin, worktree } = makePlugin();
    worktree.isWorktree = () => true;
    worktree.wtRepos = () => [
      { repo: "community", worktreePath: "/wt/community" },
      { repo: "enterprise", worktreePath: "/wt/enterprise" },
    ];
    expect(plugin._dirsFor({ id: "w1" })).toEqual({
      cwd: "/wt/community",
      addDirs: ["/wt/enterprise"],
    });
  });

  it("a main-located target with no main repo configured errors and returns null", () => {
    const { plugin, config, dialogs } = makePlugin();
    config.config.main_repo_id = "missing";
    const result = plugin._dirsFor({ checkouts: [] });
    expect(result).toBeNull();
    expect(dialogs.error).toHaveBeenCalledWith("Cannot run Claude", "no main repo configured");
  });

  it("a main-located target resolves cwd/addDirs from config.repos", () => {
    const { plugin, config } = makePlugin();
    config.config.repos.push({ id: "enterprise", path: "/main/enterprise" });
    const tgt = { checkouts: [{ repo: "enterprise" }] };
    expect(plugin._dirsFor(tgt)).toEqual({
      cwd: "/main/community",
      addDirs: ["/main/enterprise"],
    });
  });
});

describe("ClaudePlugin.send", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("a blank prompt is a no-op", async () => {
    const { plugin } = makePlugin();
    await plugin.send({ id: "w1" }, "   ");
    expect(fetch).not.toHaveBeenCalled();
    expect(plugin.items("w1")).toEqual([]);
  });

  it("sending while already running is a no-op", async () => {
    const { plugin, emitClaude } = makePlugin();
    emitClaude({ workspace: "w1", role: "assistant", text: "..." });
    await plugin.send({ id: "w1" }, "another prompt"); // apply() never set state -> still idle
    // running() is false here since only a result event flips it, so send proceeds;
    // simulate an actually in-flight turn instead
    fetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    await plugin.send({ id: "w1" }, "second prompt"); // starts running
    fetch.mockClear();
    await plugin.send({ id: "w1" }, "third prompt while running");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("optimistically appends the user's message and posts to the backend", async () => {
    const { plugin } = makePlugin();
    fetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    await plugin.send({ id: "w1" }, "do the thing");
    expect(plugin.items("w1")[0]).toEqual({ role: "user", text: "do the thing" });
    expect(fetch).toHaveBeenCalledWith(
      "/api/workspace/claude",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("a failed send appends an error item and returns to idle", async () => {
    const { plugin } = makePlugin();
    fetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: "boom" }) });
    await plugin.send({ id: "w1" }, "do the thing");
    expect(plugin.items("w1").at(-1)).toEqual({ role: "error", text: "boom" });
    expect(plugin.running("w1")).toBe(false);
  });
});
