// WorkspacePlugin's worktree-workspace flows against a fake backend: create, the
// server lifecycle, the live SSE relays, removal (+ its cascade), external-server
// detection and the autologin URLs — asserting what the user observes (the config
// the workspace list renders from, the shared server state, logs, dialogs, the
// event log) and what was asked of the backend.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigPlugin } from "../../src/core/config_plugin.ts";
import { StorePlugin } from "../../src/core/store_plugin.ts";
import { ServerPlugin } from "../../src/core/server_plugin.ts";
import { CodePlugin } from "../../src/core/code_plugin.ts";
import { EventLogPlugin } from "../../src/core/event_log_plugin.ts";
import { DialogPlugin } from "../../src/core/dialog_plugin.ts";
import { WorkspacePlugin } from "../../src/core/workspace_plugin.ts";
import type { WorkspaceConfig } from "../../src/core/config.ts";
import type { ServerSnapshot } from "../../src/core/runtime_models.ts";
import { createPluginHarness } from "../helpers/plugin_harness.ts";
import { NO_MANAGER } from "../helpers/plugin.ts";

// ── fake backend ───────────────────────────────────────────────────────────────
interface Call {
  path: string;
  body: Record<string, unknown>;
}
type Route = unknown | ((body: Record<string, unknown>) => unknown);

class Fail {
  constructor(public error: string) {}
}

function backend(routes: Record<string, Route>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ path, body });
      const route = routes[path];
      const reply = typeof route === "function" ? route(body) : (route ?? {});
      if (reply instanceof Fail)
        return { ok: false, status: 500, json: async () => ({ error: reply.error }) };
      return { ok: true, status: 200, json: async () => reply };
    }),
  );
  return { calls, to: (path: string) => calls.filter((c) => c.path === path) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// a workspace fixture carrying only the fields a test is about
const ws = (w: Partial<WorkspaceConfig> & { id: string }) => w as WorkspaceConfig;

const WT = (id: string, extra: Partial<WorkspaceConfig> = {}) =>
  ws({
    id,
    name: id.toUpperCase(),
    db: `${id}-db`,
    location: "worktree",
    checkouts: [
      { repo: "community", branch: `${id}-feat` },
      { repo: "enterprise", branch: `${id}-feat` },
    ],
    worktree: { base: "", dir: `/wt/${id}` },
    ...extra,
  });

function build(
  opts: {
    workspaces?: WorkspaceConfig[];
    settings?: Record<string, unknown>;
    confirm?: unknown;
    loaded?: string;
  } = {},
) {
  const cfg: Record<string, unknown> & { workspaces: WorkspaceConfig[] } = {
    workspaces: opts.workspaces ?? [],
    main_repo_id: "community",
    worktree_dir: "/wt",
    filestore: true,
    ...opts.settings,
  };
  // the config Workspace record, as far as the plugin reads it
  const record = (w: WorkspaceConfig) => ({
    isWorktree: () => w.location === "worktree",
    dirPath: () => w.worktree?.dir || "",
    hasMainRepo: () => (w.checkouts || []).some((c) => c.repo === "community"),
    touchActivity: () => {},
    setParent: (p: string) => {
      w.parent = p;
    },
  });
  const config = {
    config: cfg,
    workspace: (id: string) => {
      const w = cfg.workspaces.find((x) => x.id === id);
      return w ? record(w) : null;
    },
    updateConfig: (patch: Record<string, unknown>) => Object.assign(cfg, patch),
  };
  const store = new StorePlugin(NO_MANAGER);
  const worktreeCbs: ((d: ServerSnapshot) => void)[] = [];
  const logCbs: ((d: { server: string; line: string }) => void)[] = [];
  const server = {
    onWorktree: (cb: (d: ServerSnapshot) => void) => worktreeCbs.push(cb),
    onLog: (cb: (d: { server: string; line: string }) => void) => logCbs.push(cb),
    loadedWorkspaceId: () => opts.loaded ?? "",
  };
  const code = {
    groups: () => ({
      pathByRepo: { community: "/src/community", enterprise: "/src/enterprise" },
      pullRemoteByRepo: { community: "origin", enterprise: "upstream" },
      githubByRepo: { community: "odoo/odoo", enterprise: "odoo/enterprise" },
    }),
    openEditorPaths: vi.fn(),
  };
  // the event log as the user sees it: timed rows that finish done/error
  const events: { msg: string; status?: string }[] = [];
  const eventLog = {
    begin: (msg: string) => String(events.push({ msg }) - 1),
    finish: (eid: string, status: string) => (events[Number(eid)].status = status),
    add: (msg: string) => events.push({ msg }),
  };
  const errors: [string, string][] = [];
  const dialogs = {
    open: vi.fn(async (_spec: Record<string, unknown>) => opts.confirm ?? true),
    error: (title: string, msg: string) => errors.push([title, msg]),
  };
  const harness = createPluginHarness([
    [ConfigPlugin, config],
    [StorePlugin, store],
    [ServerPlugin, server],
    [CodePlugin, code],
    [EventLogPlugin, eventLog],
    [DialogPlugin, dialogs],
  ]);
  const plugin = harness.start(WorkspacePlugin);
  const sse = {
    server: (d: ServerSnapshot) => {
      store.mergeServer(d); // what ServerPlugin's "server" handler does before relaying
      worktreeCbs.forEach((cb) => cb(d));
    },
    log: (server: string, line: string) => logCbs.forEach((cb) => cb({ server, line })),
  };
  return { plugin, cfg, store, sse, code, events, errors, dialogs };
}

const snap = (s: Partial<ServerSnapshot> & { id: string }) => s as ServerSnapshot;

beforeEach(() => backend({}));

describe("hydration + live SSE relays", () => {
  it("hydrates every worktree workspace's server state on start", async () => {
    const be = backend({
      "/api/workspace/list": {
        servers: { w1: { id: "w1", exists: true, state: "running", port: 8070 } },
      },
    });
    const { plugin } = build({ workspaces: [WT("w1"), ws({ id: "m", location: "main" })] });
    await tick();
    expect(be.to("/api/workspace/list")[0].body).toEqual({
      workspaces: [{ id: "w1", dirPath: "/wt/w1" }],
    });
    expect(plugin.running({ id: "w1" })).toBe(true);
    expect(plugin.port({ id: "w1" })).toBe(8070);
    expect(plugin.exists({ id: "w1" })).toBe(true);
  });

  it("a failed hydration leaves the servers stopped; no worktrees asks nothing", async () => {
    let be = backend({ "/api/workspace/list": new Fail("down") });
    const { plugin } = build({ workspaces: [WT("w1")] });
    await tick();
    expect(plugin.serverState({ id: "w1" })).toBe("stopped");
    be = backend({});
    build();
    await tick();
    expect(be.calls).toHaveLength(0);
  });

  it("routes each worktree server's log lines to its own buffer (main's stay out)", () => {
    const { plugin, sse } = build();
    sse.log("w1", "INFO started");
    sse.log("main", "INFO main line");
    expect(plugin.logBuffer("w1").el.textContent).toContain("INFO started");
    expect(plugin.logBuffer("main").count()).toBe(0);
  });

  it("start: 'starting' then the port; the SSE 'running' snapshot finishes the start event", async () => {
    const be = backend({ "/api/workspace/start": { port: 8071 } });
    const w1 = WT("w1");
    const { plugin, sse, events } = build({ workspaces: [w1] });
    const p = plugin.startServer(w1);
    expect(plugin.serverState(w1)).toBe("starting");
    await p;
    expect(be.to("/api/workspace/start")[0].body).toEqual({ workspace: "w1" });
    expect(plugin.port(w1)).toBe(8071);
    expect(events.at(-1)).toEqual({ msg: "starting server (W1)" });
    sse.server(snap({ id: "w1", state: "running" }));
    expect(events.at(-1)?.status).toBe("done");
    // a later snapshot has no pending start to finish
    sse.server(snap({ id: "w1", state: "stopped" }));
    expect(events.at(-1)?.status).toBe("done");
  });

  it("a start that dies before running finishes its event as an error", async () => {
    backend({ "/api/workspace/start": { port: 8071 } });
    const w1 = WT("w1");
    const { plugin, sse, events } = build({ workspaces: [w1] });
    await plugin.startServer(w1);
    sse.server(snap({ id: "w1", state: "starting" }));
    expect(events.at(-1)?.status).toBeUndefined();
    sse.server(snap({ id: "w1", state: "stopped" }));
    expect(events.at(-1)?.status).toBe("error");
    expect(plugin.running(w1)).toBe(false);
  });

  it("restart stops, then starts again", async () => {
    const be = backend({
      "/api/workspace/stop": {},
      "/api/workspace/start": { port: 8072 },
    });
    const w1 = WT("w1");
    const { plugin } = build({ workspaces: [w1] });
    await tick();
    be.calls.length = 0;
    await plugin.restartServer(w1);
    expect(be.calls.map((c) => c.path)).toEqual(["/api/workspace/stop", "/api/workspace/start"]);
    expect(plugin.port(w1)).toBe(8072);
  });
});

describe("selection + logs", () => {
  it("selectOnOpen requests the selection; selecting primes the log tail once", async () => {
    const be = backend({ "/api/workspace/logs": { lines: ["a", "b"] } });
    const { plugin } = build({ workspaces: [WT("w1")] });
    plugin.selectOnOpen("w1");
    await tick();
    expect(plugin.requestedSelection()).toBe("w1");
    expect(plugin.selected()?.id).toBe("w1");
    expect(plugin.logBuffer("w1").count()).toBe(2);
    plugin.select("w1");
    await tick();
    expect(be.to("/api/workspace/logs")).toHaveLength(1);
  });

  it("a failed tail fetch leaves the buffer empty", async () => {
    backend({ "/api/workspace/logs": new Fail("gone") });
    const { plugin } = build({ workspaces: [WT("w1")] });
    plugin.select("w1");
    await tick();
    expect(plugin.logBuffer("w1").count()).toBe(0);
  });

  it("worktree branches carry the 'wt' badge", () => {
    const { plugin } = build({
      workspaces: [
        WT("w1"),
        ws({ id: "m", location: "main", checkouts: [{ repo: "community", branch: "main-b" }] }),
      ],
    });
    expect([...plugin.worktreeBranches()]).toEqual(["w1-feat"]);
    expect(plugin.isWorktreeBranch("w1-feat")).toBe(true);
    expect(plugin.isWorktreeBranch("main-b")).toBe(false);
    expect(plugin.isWorktreeBranch(null)).toBe(false);
  });

  it("openEditor opens the worktree's own checkouts; none configured opens nothing", () => {
    const { plugin, code } = build({ workspaces: [WT("w1")] });
    plugin.openEditor(WT("w1"));
    expect(code.openEditorPaths).toHaveBeenCalledWith(
      ["/wt/w1/community", "/wt/w1/enterprise"],
      "worktree W1",
    );
    plugin.openEditor(ws({ id: "x", checkouts: [{ repo: "nope", branch: "b" }] }));
    expect(code.openEditorPaths).toHaveBeenCalledTimes(1);
  });
});

describe("createWorktree", () => {
  const spec = {
    name: "My Feature",
    dbName: "feat-db",
    checkouts: [
      { repo: "community", branch: "master-feat-jpp" },
      { repo: "enterprise", branch: "existing-branch" },
    ],
    startPointByRepo: { community: "origin/master" },
    forkRepos: new Set(["community"]),
  };

  it("clones the db, forks/attaches each repo, builds the venv, then persists + selects it", async () => {
    const be = backend({
      "/api/databases/clone": {},
      "/api/workspace/create": { ok: true },
      "/api/workspace/venv/create": {},
      "/api/workspace/logs": { lines: [] },
    });
    const { plugin, cfg, events } = build({ workspaces: [WT("wt-my-feature")] });
    const id = await plugin.createWorktree({ ...spec, cloneSource: "template", createVenv: true });
    expect(id).toBe("wt-my-feature-2"); // deduped against the existing id
    expect(be.to("/api/databases/clone")[0].body).toEqual({
      source: "template",
      dest: "feat-db",
      filestore: true,
    });
    expect(be.to("/api/workspace/create")[0].body).toEqual({
      workspace: "wt-my-feature-2",
      repos: [
        {
          repo: "community",
          newBranch: "master-feat-jpp",
          startPoint: "origin/master",
          mainPath: "/src/community",
          pull_remote: "origin",
          worktreePath: "/wt/My-Feature/community",
        },
        {
          repo: "enterprise",
          branch: "existing-branch",
          mainPath: "/src/enterprise",
          pull_remote: "upstream",
          worktreePath: "/wt/My-Feature/enterprise",
        },
      ],
    });
    expect(be.to("/api/workspace/venv/create")[0].body).toEqual({
      venvPath: "/wt/My-Feature/.venv",
      requirementsPath: "/wt/My-Feature/community/requirements.txt",
    });
    const created = cfg.workspaces.find((w) => w.id === id)!;
    expect(created).toMatchObject({
      name: "My Feature",
      db: "feat-db",
      location: "worktree",
      worktree: { base: "", dir: "/wt/My-Feature", venv: true },
    });
    expect(plugin.exists({ id: id as string })).toBe(true);
    expect(plugin.selectedId()).toBe(id);
    expect(events.map((e) => e.status)).toEqual(["done", "done"]);
  });

  it("refuses a workspace with no checkouts, or none in a local repo, without asking the backend", async () => {
    const be = backend({});
    const { plugin, errors } = build();
    expect(await plugin.createWorktree({ ...spec, checkouts: [] })).toBe(false);
    expect(
      await plugin.createWorktree({ ...spec, checkouts: [{ repo: "nope", branch: "b" }] }),
    ).toBe(false);
    expect(errors).toEqual([
      ["Create workspace", "the workspace has no checkouts"],
      ["Create workspace", "no local repos for the checkouts"],
    ]);
    expect(be.calls).toHaveLength(0);
  });

  it("a failed git worktree add reports each failing repo and persists nothing", async () => {
    backend({
      "/api/workspace/create": {
        ok: false,
        results: [
          { ok: true, repo: "community" },
          { ok: false, repo: "enterprise", error: "branch is checked out elsewhere" },
        ],
      },
    });
    const { plugin, cfg, errors, events } = build();
    expect(await plugin.createWorktree(spec)).toBe(false);
    expect(errors).toEqual([
      ["Workspace creation failed", "enterprise: branch is checked out elsewhere"],
    ]);
    expect(cfg.workspaces).toEqual([]);
    expect(events[0].status).toBe("error");
  });

  it("a failure with no per-repo detail still says what failed", async () => {
    backend({ "/api/workspace/create": { ok: false } });
    const { plugin, errors } = build();
    await plugin.createWorktree(spec);
    expect(errors).toEqual([["Workspace creation failed", "git worktree add failed"]]);
  });

  it("a failed clone aborts the creation", async () => {
    const be = backend({ "/api/databases/clone": new Fail("source busy") });
    const { plugin, cfg, errors } = build();
    expect(await plugin.createWorktree({ ...spec, cloneSource: "template" })).toBe(false);
    expect(be.to("/api/workspace/create")).toHaveLength(0);
    expect(errors).toEqual([["Workspace creation failed", "source busy"]]);
    expect(cfg.workspaces).toEqual([]);
  });

  it("a failed venv build still creates the workspace, on the global venv", async () => {
    backend({
      "/api/workspace/create": { ok: true },
      "/api/workspace/venv/create": new Fail("pip failed"),
    });
    const { plugin, cfg, errors } = build();
    const id = await plugin.createWorktree({ ...spec, createVenv: true, select: false });
    expect(errors).toEqual([["Venv creation failed", "pip failed"]]);
    expect(cfg.workspaces.find((w) => w.id === id)?.worktree?.venv).toBeUndefined();
    expect(plugin.selectedId()).toBe("");
  });
});

describe("remove", () => {
  it("confirm with 'drop db': removes the worktree, drops the db, forgets the workspace", async () => {
    const be = backend({ "/api/workspace/remove": {}, "/api/databases/drop": {} });
    const w1 = WT("w1");
    const { plugin, cfg, store, dialogs } = build({
      workspaces: [w1, WT("w2", { parent: "w1" })],
      confirm: { dropDb: true },
    });
    store.mergeServer({ id: "w1", exists: true, state: "stopped" });
    plugin.logBuffer("w1").append("old");
    plugin.select("w1");
    await plugin.remove(w1);
    expect(dialogs.open.mock.calls[0][0].message).toContain(
      "This also removes 1 sub-workspace spawned from it.",
    );
    expect(be.to("/api/workspace/remove").find((c) => c.body.workspace === "w1")?.body).toEqual({
      workspace: "w1",
      dirPath: "/wt/w1",
      repos: [
        { repo: "community", mainPath: "/src/community", worktreePath: "/wt/w1/community" },
        { repo: "enterprise", mainPath: "/src/enterprise", worktreePath: "/wt/w1/enterprise" },
      ],
    });
    expect(be.to("/api/databases/drop")).toEqual([
      { path: "/api/databases/drop", body: { name: "w1-db", filestore: true } },
    ]);
    // the cascaded child went too (its db left alone)
    expect(be.to("/api/workspace/remove").map((c) => c.body.workspace)).toEqual(["w1", "w2"]);
    expect(cfg.workspaces).toEqual([]);
    expect(store.server("w1")).toBeNull();
    expect(plugin.logBuffer("w1").count()).toBe(0);
    expect(plugin.selectedId()).toBe("");
  });

  it("a failed worktree removal keeps the workspace as a handle to retry", async () => {
    backend({ "/api/workspace/remove": new Fail("locked") });
    const w1 = WT("w1");
    const { plugin, cfg, errors } = build({ workspaces: [w1] });
    await plugin.remove(w1);
    expect(errors).toEqual([["Worktree removal failed", "locked"]]);
    expect(cfg.workspaces).toEqual([w1]);
  });

  it("a failed db drop is reported, but the (already removed) workspace still goes", async () => {
    backend({ "/api/workspace/remove": {}, "/api/databases/drop": new Fail("in use") });
    const w1 = WT("w1");
    const { plugin, cfg, errors } = build({ workspaces: [w1], confirm: { dropDb: true } });
    await plugin.remove(w1);
    expect(errors).toEqual([["Database drop failed", "in use"]]);
    expect(cfg.workspaces).toEqual([]);
  });

  it("keeps a busy child (running server), demoted to root, and tells the user", async () => {
    backend({ "/api/workspace/remove": {} });
    const w1 = WT("w1");
    const { plugin, cfg, store, dialogs } = build({
      workspaces: [w1, WT("w2", { parent: "w1" }), WT("w3", { parent: "w1" })],
    });
    store.mergeServer({ id: "w2", state: "running" });
    await plugin.remove(w1);
    expect(cfg.workspaces.map((w) => [w.id, w.parent])).toEqual([["w2", ""]]);
    const kept = dialogs.open.mock.calls[1][0];
    expect(kept.title).toBe("Some sub-workspaces were kept");
    expect(kept.message).toContain('"W2" is still busy');
    expect(dialogs.open.mock.calls[0][0].message).toContain("2 sub-workspaces");
  });
});

describe("external servers + autologin URLs", () => {
  it("selecting a workspace in 'external' mode checks for its container", async () => {
    const be = backend({
      "/api/workspace/external_status": { running: true, url: "http://ext.localhost/" },
      "/api/workspace/logs": { lines: [] },
    });
    const w1 = WT("w1");
    const { plugin } = build({ workspaces: [w1], settings: { launch_mode: "external" } });
    plugin.select("w1");
    expect(plugin.externalStatus(w1)).toEqual({ checking: true });
    await tick();
    expect(be.to("/api/workspace/external_status")[0].body).toEqual({ name: "w1-db" });
    expect(plugin.externalStatus(w1)).toEqual({
      checking: false,
      running: true,
      url: "http://ext.localhost/",
    });
    expect(plugin.odooUrl(w1)).toBe(
      "http://ext.localhost/dev/autologin?to=%2Fodoo%3Fdebug%3Dassets",
    );
  });

  it("a failed check shows its error; no db checks nothing", async () => {
    const be = backend({ "/api/workspace/external_status": new Fail("docker not running") });
    const { plugin } = build();
    await plugin.refreshExternalStatus(ws({ id: "x" }));
    expect(be.calls).toHaveLength(0);
    expect(plugin.externalStatus({ id: "x" })).toBeNull();
    await plugin.refreshExternalStatus(ws({ id: "x", db: "d" }));
    expect(plugin.externalStatus({ id: "x" })).toEqual({
      checking: false,
      error: "docker not running",
    });
    expect(plugin.odooUrl({ id: "x" })).toBe("");
  });

  it("checkDbInUse answers for a bare db name, and never blocks on a failed check", async () => {
    backend({ "/api/workspace/external_status": {} });
    const { plugin } = build();
    expect(await plugin.checkDbInUse("")).toBeNull();
    expect(await plugin.checkDbInUse("d")).toEqual({ running: false, url: "" });
    backend({ "/api/workspace/external_status": { running: true, url: "u" } });
    expect(await plugin.checkDbInUse("d")).toEqual({ running: true, url: "u" });
    backend({ "/api/workspace/external_status": new Fail("x") });
    expect(await plugin.checkDbInUse("d")).toBeNull();
  });

  it("local mode links to the goo-managed port; plain links when autologin is off", () => {
    const w1 = WT("w1");
    const on = build({ workspaces: [w1] });
    on.store.mergeServer({ id: "w1", state: "running", port: 8070 });
    expect(on.plugin.testsUrl(w1)).toBe(
      "http://localhost:8070/dev/autologin?to=" +
        encodeURIComponent("/web/tests?debug=assets&timeout=500000&manual=true"),
    );
    const off = build({ workspaces: [w1], settings: { autologin_links: false } });
    off.store.mergeServer({ id: "w1", state: "running", port: 8070 });
    expect(off.plugin.odooUrl(w1)).toBe("http://localhost:8070/odoo?debug=assets");
  });

  it("docker mode links through nginx to the live container slot, only while running", () => {
    const w1 = WT("w1");
    const { plugin, store } = build({
      workspaces: [w1],
      settings: { launch_mode: "docker", docker_nginx_port: "8080" },
    });
    store.mergeServer({ id: "w1", state: "stopped", docker_container: "dev1" });
    expect(plugin.odooUrl(w1)).toBe("");
    store.mergeServer({ id: "w1", state: "running" });
    expect(plugin.odooUrl(w1)).toMatch(/^http:\/\/dev1\.localhost:8080\/dev\/autologin/);
    store.mergeServer({ id: "w1", docker_container: "" });
    expect(plugin.dockerUrl(w1)).toBe("");
    const p80 = build({ settings: { launch_mode: "docker", docker_nginx_port: "80" } });
    p80.store.mergeServer({ id: "w9", state: "running", docker_container: "dev" });
    expect(p80.plugin.dockerUrl({ id: "w9" })).toBe("http://dev.localhost/");
  });
});
