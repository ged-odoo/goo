// ConfigPlugin's server sync: the first-boot adoption of a browser's legacy
// localStorage, the one-time targets→workspaces write-back (and its 409 race with
// another tab), and the immediate reset / import / preset pushes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigPlugin, loadServerConfig, newWorkspaceId } from "../../src/core/config_plugin.ts";
import { DEFAULT_CONFIG } from "../../src/core/config.ts";
import { NO_MANAGER } from "../helpers/plugin.ts";
import { workspace } from "../helpers/core_fixtures.ts";

interface Post {
  rev: number;
  config?: Record<string, unknown> & { workspaces?: { name: string }[] };
  state?: Record<string, unknown>;
}

// GET /api/config answers `get`; each POST is recorded and answered by `post`
function backend(get: unknown, post: (body: Post, n: number) => Response | Promise<never>) {
  const posts: Post[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") {
        return get instanceof Error ? Promise.reject(get) : new Response(JSON.stringify(get));
      }
      const body: Post = JSON.parse(String(init.body));
      posts.push(body);
      return post(body, posts.length);
    }),
  );
  return posts;
}

const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const echo = (b: Post) => reply({ ok: true, rev: b.rev + 1, config: b.config, state: b.state });
const legacyTarget = { name: "Legacy", config: [{ repo: "community", branch: "master" }] };

afterEach(() => vi.useRealTimers());

describe("first boot (no server config yet)", () => {
  it("adopts this browser's legacy localStorage and seeds the server with it", async () => {
    localStorage.setItem("oo-config", JSON.stringify({ db_user: "legacy-user" }));
    localStorage.setItem("oo-test-history", JSON.stringify(["/web:A"]));
    localStorage.setItem("oo-claude-model", "opus"); // a plain string, not JSON
    const posts = backend({ ok: true, rev: 0, config: null }, echo);
    await loadServerConfig();
    expect(posts[0].config?.db_user).toBe("legacy-user");
    expect(posts[0].state).toMatchObject({ test_history: ["/web:A"], claude_model: "opus" });
    const plugin = new ConfigPlugin(NO_MANAGER);
    expect(plugin.config.db_user).toBe("legacy-user");
    expect(plugin.getState("claude_model")).toBe("opus");
    expect(plugin.rev()).toBe(1);
  });

  it("a corrupt legacy config falls back to the defaults", async () => {
    localStorage.setItem("oo-config", "{not json");
    const posts = backend({ ok: true, rev: 0, config: null }, echo);
    await loadServerConfig();
    expect(posts[0].config?.db_user).toBe(DEFAULT_CONFIG.db_user);
  });

  it("another tab seeding first wins: adopt theirs (409)", async () => {
    const theirs = { ...DEFAULT_CONFIG, db_user: "theirs" };
    backend({ ok: true, rev: 0, config: null }, () =>
      reply({ ok: false, rev: 4, config: theirs, state: {} }, 409),
    );
    await loadServerConfig();
    const plugin = new ConfigPlugin(NO_MANAGER);
    expect(plugin.config.db_user).toBe("theirs");
    expect(plugin.rev()).toBe(4);
  });

  it("boots from the defaults when the server is unreachable", async () => {
    backend(new Error("offline"), () => Promise.reject(new Error("offline")));
    await loadServerConfig();
    const plugin = new ConfigPlugin(NO_MANAGER);
    expect(plugin.config.db_user).toBe(DEFAULT_CONFIG.db_user);
    expect(plugin.rev()).toBe(0);
  });
});

describe("one-time targets → workspaces write-back", () => {
  const stored = { ok: true, rev: 3, config: { ...DEFAULT_CONFIG, targets: [legacyTarget] } };

  it("persists the migrated blob, rev-checked, and boots from it", async () => {
    const posts = backend(stored, (b) => reply({ ok: true, rev: b.rev + 1 }));
    await loadServerConfig();
    expect(posts).toHaveLength(1);
    expect(posts[0].rev).toBe(3);
    expect(posts[0].config?.workspaces?.map((w) => w.name)).toEqual(["Legacy"]);
    const plugin = new ConfigPlugin(NO_MANAGER);
    expect(plugin.rev()).toBe(4);
    expect(plugin.config.workspaces.map((w) => w.name)).toEqual(["Legacy"]);
  });

  it("on a 409, adopts the other tab's copy when it is already migrated", async () => {
    const migrated = { ...DEFAULT_CONFIG, workspaces: [workspace("x", "Theirs")] };
    const posts = backend(stored, () => reply({ rev: 7, config: migrated, state: {} }, 409));
    await loadServerConfig();
    expect(posts).toHaveLength(1);
    const plugin = new ConfigPlugin(NO_MANAGER);
    expect(plugin.rev()).toBe(7);
    expect(plugin.config.workspaces.map((w) => w.name)).toEqual(["Theirs"]);
  });

  it("on a 409 with an unmigrated copy, migrates theirs and retries once", async () => {
    const theirs = { ...DEFAULT_CONFIG, targets: [{ ...legacyTarget, name: "Other" }] };
    const posts = backend(stored, (b, n) =>
      n === 1 ? reply({ rev: 8, config: theirs, state: {} }, 409) : reply({ rev: b.rev + 1 }),
    );
    await loadServerConfig();
    expect(posts.map((p) => p.rev)).toEqual([3, 8]);
    expect(posts[1].config?.workspaces?.map((w) => w.name)).toEqual(["Other"]);
    expect(new ConfigPlugin(NO_MANAGER).rev()).toBe(9);
  });

  it("a failed write-back still boots from the migrated blob in memory", async () => {
    backend(stored, () => Promise.reject(new Error("offline")));
    await loadServerConfig();
    const plugin = new ConfigPlugin(NO_MANAGER);
    expect(plugin.rev()).toBe(3);
    expect(plugin.config.workspaces.map((w) => w.name)).toEqual(["Legacy"]);
  });
});

describe("ConfigPlugin saves and pushes", () => {
  async function bootPlugin(postReply: (b: Post, n: number) => Response | Promise<never>) {
    const posts = backend(
      { ok: true, rev: 1, config: { ...DEFAULT_CONFIG, workspaces: [workspace("w1", "One")] } },
      postReply,
    );
    await loadServerConfig();
    return { plugin: new ConfigPlugin(NO_MANAGER), posts };
  }

  it("a server-side save error keeps the edit dirty and logs it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { plugin, posts } = await bootPlugin(() => reply({ error: "disk full" }, 500));
    vi.useFakeTimers();
    plugin.updateConfig({ db_user: "x" });
    await vi.advanceTimersByTimeAsync(250);
    expect(error).toHaveBeenCalledWith("[goo] config save failed: disk full");
    expect(plugin._dirty.config).toBe(true);
    expect(posts).toHaveLength(1);
    error.mockRestore();
  });

  it("gives up after three 409 retries instead of looping", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { plugin, posts } = await bootPlugin((b) => reply({ rev: b.rev + 1 }, 409));
    vi.useFakeTimers();
    plugin.setState("claude_model", "sonnet");
    await vi.advanceTimersByTimeAsync(250);
    expect(posts).toHaveLength(4);
    expect(posts.at(-1)?.state?.claude_model).toBe("sonnet");
    error.mockRestore();
  });

  it("resetConfig() replaces everything with the defaults, immediately", async () => {
    const { plugin, posts } = await bootPlugin((b) => reply({ rev: b.rev + 1 }));
    plugin.updateConfig({ db_user: "edited" });
    await plugin.resetConfig();
    const names = plugin.config.workspaces.map((w) => w.name);
    expect(names).not.toContain("One");
    expect(plugin.config.db_user).toBe(DEFAULT_CONFIG.db_user);
    expect(posts).toHaveLength(1); // the pending debounced edit was superseded
    expect(posts[0].config?.workspaces?.map((w) => w.name)).toEqual(names);
    expect(plugin.rev()).toBe(2);
  });

  it("snapshot() → importSnapshot() round-trips config and state", async () => {
    const { plugin, posts } = await bootPlugin((b) => reply({ rev: b.rev + 1 }));
    plugin.setState("claude_model", "haiku");
    const snap = plugin.snapshot();
    await plugin.resetConfig();
    expect(plugin.getState("claude_model")).not.toBe("haiku");
    await plugin.importSnapshot(snap);
    expect(plugin.getState("claude_model")).toBe("haiku");
    expect(plugin.config.workspaces.map((w) => w.name)).toEqual(["One"]);
    expect(posts.at(-1)?.state?.claude_model).toBe("haiku");
  });

  it("applyPreset() loads a preset's config + state; an unknown one is refused", async () => {
    const { plugin, posts } = await bootPlugin((b) => reply({ rev: b.rev + 1 }));
    expect(await plugin.applyPreset("nope")).toBe(false);
    expect(posts).toHaveLength(0);
    expect(await plugin.applyPreset("ged")).toBe(true);
    expect(plugin.config.venv_activate).toContain("env20");
    expect(plugin.getState("test_history", [])[0]).toBe("/web:WebSuite[@web/core/checkbox]");
    expect(plugin.config.workspaces.length).toBeGreaterThan(0);
    expect(plugin.repoByGithub("odoo/enterprise")?.id).toBe("enterprise");
    expect(plugin.repoByGithub("nobody/nothing")).toBeNull();
  });

  it("a failed push is logged, the local reset still applies", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { plugin } = await bootPlugin(() => Promise.reject(new Error("offline")));
    await plugin.resetConfig();
    expect(plugin.config.workspaces.map((w) => w.name)).not.toContain("One");
    expect(error).toHaveBeenCalledWith("[goo] config save failed: offline");
    error.mockRestore();
  });

  it("ignores a malformed broadcast", async () => {
    const { plugin } = await bootPlugin(echo);
    plugin.applyBroadcast(null);
    plugin.applyBroadcast({ config: {} });
    expect(plugin.config.workspaces.map((w) => w.name)).toEqual(["One"]);
  });
});

describe("newWorkspaceId", () => {
  it("is unique, with a fallback where crypto.randomUUID is missing", () => {
    expect(newWorkspaceId()).not.toBe(newWorkspaceId());
    vi.stubGlobal("crypto", {});
    expect(newWorkspaceId()).toMatch(/^t-[a-z0-9]+-[a-z0-9]+$/);
  });
});
