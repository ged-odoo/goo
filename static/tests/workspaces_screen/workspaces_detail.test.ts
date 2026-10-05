// The Workspaces screen's detail: the lifecycle slot (Activate / Start / Stop for
// main-located and worktree workspaces, the Start-options menu), the header ⋮ menu
// (edit, archive, drop db, remove), checkout drift + its reconciliation, the
// per-tab gating hints, the server-log pane, the Details tab, and launch_mode
// "external".
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountApp, type MountedApp, type MountAppOptions } from "../helpers/app.ts";
import {
  byText,
  captureSse,
  dialog,
  gitBackend,
  heldResponse,
  lastSavedConfig,
  mustText,
  prsRoute,
  repo,
  texts,
  waitFor,
  ws,
  type Sse,
} from "../helpers/workspaces_fixtures.ts";
import type { WorkspaceConfig } from "../../src/core/config.ts";
import type { RepoStatusWire } from "../../src/core/observed_models.ts";

let app: MountedApp;
let sse: Sse;
let git: ReturnType<typeof gitBackend>; // the mounted app's git state
afterEach(() => {
  app?.destroy();
  vi.restoreAllMocks();
});

const ALPHA = ws({ id: "alpha" }); // community:master-alpha, enterprise:master
const BETA = ws({ id: "beta" });
const WT = ws({
  id: "wt1",
  name: "feature-wt",
  location: "worktree",
  worktree: { dir: "/home/odoo/work-trees/wt1" },
  port: 8075,
});

const GIT = (): RepoStatusWire[] => [
  repo("community", "master-alpha", ["master", "master-alpha", "master-beta", "master-wt1"]),
  repo("enterprise", "master", ["master"]),
];

interface Opts extends MountAppOptions {
  git?: RepoStatusWire[];
  active?: string;
}

async function mount(workspaces: WorkspaceConfig[], opts: Opts = {}) {
  sse = captureSse();
  git = gitBackend(opts.git ?? GIT());
  app = await mountApp({
    section: "workspaces",
    ...opts,
    config: { targets: [], workspaces, ...opts.config },
    state: { active_workspace: opts.active ?? "alpha", ...opts.state },
    routes: {
      ...git.routes,
      "/api/prs": prsRoute(),
      "/api/runbot": { states: {} },
      "/api/mergebot": { states: {} },
      "/api/status": { id: "main", state: "stopped" },
      "/api/databases": { ok: true, databases: [{ name: "alpha" }, { name: "wt1" }] },
      "/api/workspace/list": { servers: {} },
      "/api/workspace/logs": { lines: [] },
      ...opts.routes,
    },
  });
  return app;
}

// alpha as the app last saved it (the debounced config POST), if it saved yet
function savedAlpha(): WorkspaceConfig | undefined {
  if (!app.callsTo("/api/config").some((c) => c.method === "POST")) return undefined;
  return lastSavedConfig(app).workspaces.find((w) => w.id === "alpha");
}

async function select(name: string) {
  const item = [...app.root.querySelectorAll<HTMLButtonElement>(".wt-item")].find(
    (el) => el.querySelector(".wt-item-name")?.textContent === name,
  )!;
  item.click();
  await app.settle();
}

async function tab(label: string) {
  mustText(app.root, ".wt-tab", label).click();
  await app.settle();
}

const lifecycle = () => app.root.querySelector<HTMLButtonElement>(".wt-lifecycle-btn")!;
const paneHint = () => app.root.querySelector(".ws-pane-hint")?.textContent?.trim();

async function kebab(label: string) {
  app.root.querySelector<HTMLButtonElement>(".dash-kebab")!.click();
  await app.settle();
  const item = mustText(app.root, ".dash-kebab-wrap .dash-menu-item", label);
  return item;
}

async function dialogButton(label: string) {
  mustText(dialog()!, ".dialog-foot button", label).click();
  await app.settle();
}

describe("main-located workspace lifecycle", () => {
  it("Activate is blocked while a branch is missing locally", async () => {
    const git = GIT();
    git[0].branches = git[0].branches!.filter((b) => b.name !== "master-beta");
    await mount([ALPHA, BETA], { git });
    await select("beta");
    expect(lifecycle().textContent).toBe("Activate");
    expect(lifecycle().disabled).toBe(true);
    expect(lifecycle().title).toBe("some of this workspace's branches are missing locally");
  });

  it("Activate is blocked while a working tree is dirty", async () => {
    const dirty = GIT();
    dirty[1].dirty = true;
    await mount([ALPHA, BETA], { git: dirty });
    await select("beta");
    expect(lifecycle().disabled).toBe(true);
    expect(lifecycle().title).toBe("commit or stash changes first — the working tree is dirty");
  });

  it("Activate checks out the workspace's branches and makes it the loaded one", async () => {
    // hold the checkout in flight to observe the blocking overlay meanwhile
    const held = heldResponse({ results: [{ ok: true, branch: "master-beta" }] });
    await mount([ALPHA, BETA], {
      routes: {
        "/api/code/checkout": (body: unknown) => {
          git.routes["/api/code/checkout"](body);
          return held.response;
        },
      },
    });
    await select("beta");
    lifecycle().click();
    await app.settle();
    expect(app.root.querySelector(".ws-activating-title")?.textContent).toBe("Activating beta…");
    expect(lifecycle().disabled).toBe(true);
    expect(app.callsTo("/api/code/checkout")[0].body).toEqual({
      repos: [
        { repo: "community", path: "/home/odoo/work/community", branch: "master-beta" },
        { repo: "enterprise", path: "/home/odoo/work/enterprise", branch: "master" },
      ],
    });
    held.release();
    await app.settle();
    expect(app.root.querySelector(".ws-activating")).toBeNull();
    // beta now occupies the main checkout: its slot turns into Start
    expect(lifecycle().textContent).toBe("Start");
    expect(lifecycle().title).toBe("start the main server");
    // and alpha, no longer loaded, offers Activate again
    await select("alpha");
    expect(lifecycle().textContent).toBe("Activate");
  });

  it("Start runs the main server; the live status flips it to Stop, Stop stops it", async () => {
    await mount([ALPHA, BETA], {
      routes: {
        "/api/start": { ok: true, state: "starting", cmd: "odoo-bin -d alpha" },
        "/api/stop": { ok: true, state: "stopped" },
      },
    });
    expect(lifecycle().textContent).toBe("Start");
    lifecycle().click();
    await app.settle();
    expect(app.callsTo("/api/start")[0].body).toEqual({ workspace: "alpha", overrides: {} });

    sse.emit("server", { id: "main", state: "running", workspace: "alpha", port: 8069 });
    await app.settle();
    expect(lifecycle().textContent).toBe("Stop");
    expect(app.root.querySelector(".wt-state")?.textContent).toBe("running");
    expect(app.root.querySelector(".wt-head-port")?.textContent).toBe("port 8069");
    expect(app.root.querySelector(".wt-item.selected .wt-dot")?.className).toContain(
      "wt-dot-running",
    );

    // the server log pane shows the main server's live output
    await tab("Server logs");
    sse.emit("log", { server: "main", line: "odoo.modules.loading: 42 modules loaded" });
    await app.settle();
    expect(app.root.querySelector(".wt-pane")?.textContent).toContain("42 modules loaded");

    lifecycle().click();
    await app.settle();
    expect(app.callsTo("/api/stop")).toHaveLength(1);
  });

  it("Start on a workspace that isn't loaded loads it first, then starts it", async () => {
    await mount([ALPHA, BETA], { active: "" });
    await select("beta");
    expect(lifecycle().textContent).toBe("Activate");
    // not loaded: logs / tests / terminal panes explain why they're empty
    await tab("Server logs");
    expect(paneHint()).toContain("This workspace isn't loaded");
    await tab("Tests");
    expect(paneHint()).toContain("Start it first to run tests");
    await tab("Addons");
    expect(paneHint()).toContain("Start it first to browse and install");
    await tab("Claude");
    expect(paneHint()).toContain("load it first, or use a worktree workspace");
    await tab("Terminal");
    expect(paneHint()).toContain("the main terminal belongs to the loaded workspace");
  });

  it("the Start options menu: Drop database & start confirms, drops, then starts", async () => {
    await mount([ALPHA, BETA], {
      routes: {
        "/api/databases/drop": { ok: true },
        "/api/start": { ok: true, state: "starting", cmd: "odoo-bin -d alpha" },
      },
    });
    app.root.querySelector<HTMLButtonElement>(".wt-start-caret")!.click();
    await app.settle();
    const menu = document.querySelector(".action-menu:not(.hidden)")!;
    expect(texts(menu, "button")).toEqual(["Open shell", "Drop database & start"]);
    const dropStart = mustText(menu, "button", "Drop database & start");
    expect(dropStart.disabled).toBe(false);
    expect(dropStart.title).toBe('drop "alpha" then start fresh');

    // cancel: nothing dropped, nothing started
    dropStart.click();
    await app.settle();
    expect(dialog()?.querySelector(".dialog-title")?.textContent).toBe('Drop "alpha" and start?');
    await dialogButton("Discard");
    expect(app.callsTo("/api/databases/drop")).toHaveLength(0);

    app.root.querySelector<HTMLButtonElement>(".wt-start-caret")!.click();
    await app.settle();
    mustText(document.querySelector(".action-menu")!, "button", "Drop database & start").click();
    await app.settle();
    await dialogButton("Drop & start");
    expect(app.callsTo("/api/databases/drop")[0].body).toMatchObject({ name: "alpha" });
    expect(app.callsTo("/api/start")[0].body).toMatchObject({ workspace: "alpha" });
  });

  it("Drop database & start reports a failed drop and doesn't start", async () => {
    await mount([ALPHA], {
      routes: {
        "/api/databases/drop": new Response(JSON.stringify({ error: "database is in use" }), {
          status: 500,
        }),
      },
    });
    app.root.querySelector<HTMLButtonElement>(".wt-start-caret")!.click();
    await app.settle();
    mustText(document.querySelector(".action-menu")!, "button", "Drop database & start").click();
    await app.settle();
    await dialogButton("Drop & start");
    expect(dialog()?.querySelector(".dialog-title")?.textContent).toBe("Drop failed");
    expect(dialog()?.querySelector(".dialog-msg")?.textContent).toBe("database is in use");
    expect(texts(dialog()!, ".dialog-foot button")).toEqual(["OK"]);
    await dialogButton("OK");
    expect(app.callsTo("/api/start")).toHaveLength(0);
  });

  it("the Start options menu's Open shell opens an odoo-bin shell for the workspace", async () => {
    await mount([ALPHA]);
    app.root.querySelector<HTMLButtonElement>(".wt-start-caret")!.click();
    await app.settle();
    mustText(document.querySelector(".action-menu")!, "button", "Open shell").click();
    await app.settle();
    expect(app.root.querySelector(".term-panel-title")?.textContent).toBe("alpha shell");
    expect(app.callsTo("/api/start")).toHaveLength(0); // the server itself isn't started
  });

  it("offers no drop when the workspace's database doesn't exist", async () => {
    const git = GIT();
    git[0].current = "master-beta";
    await mount([BETA], { active: "beta", git });
    app.root.querySelector<HTMLButtonElement>(".wt-start-caret")!.click();
    await app.settle();
    const dropStart = mustText(
      document.querySelector(".action-menu")!,
      "button",
      "Drop database & start",
    );
    expect(dropStart.disabled).toBe(true);
    expect(dropStart.title).toBe('no database "beta" to drop');
    // and the header menu's Drop database agrees
    const drop = await kebab("Drop database");
    expect(drop.disabled).toBe(true);
    expect(drop.title).toBe('database "beta" does not exist');
  });

  it("Refresh force-reloads the workspace's repositories", async () => {
    await mount([ALPHA]);
    const refresh = app.root.querySelector<HTMLButtonElement>(".ws-refresh")!;
    expect(refresh.title).toBe("refresh branches + pull requests · last refreshed just now");
    const before = app.callsTo("/api/prs").length;
    refresh.click();
    await app.settle();
    const prs = app.callsTo("/api/prs").at(-1)!.body as {
      refresh: boolean;
      repos: { id: string }[];
    };
    expect(prs.refresh).toBe(true);
    expect(prs.repos.map((r) => r.id)).toEqual(["community", "enterprise"]);
    expect(app.callsTo("/api/prs")).toHaveLength(before + 1);
  });
});

// the backend removes each repo's worktree and reports per-repo results
const removeRoute = (body: unknown) => {
  const { repos } = body as { repos: { repo: string }[] };
  return { ok: true, results: repos.map(({ repo }) => ({ repo, ok: true, error: null })) };
};

describe("worktree workspace lifecycle", () => {
  it("starts on its own port, streams its log, then stops", async () => {
    await mount([ALPHA, WT], {
      routes: {
        "/api/workspace/start": { ok: true, port: 8075 },
        "/api/workspace/stop": { ok: true, error: null },
        "/api/workspace/logs": { lines: ["earlier line from the tail"] },
      },
    });
    await select("feature-wt");
    expect(app.root.querySelector(".wt-item.selected .wt-chip.wt")).not.toBeNull();
    expect(lifecycle().textContent).toBe("Start");
    expect(lifecycle().title).toBe("start this workspace's server on its own port");
    expect(app.root.querySelector(".wt-head-port")?.textContent).toBe("port 8075");

    // stopped: no terminal to attach to yet
    await tab("Terminal");
    expect(paneHint()).toBe("Start this workspace's server to attach a terminal.");

    lifecycle().click();
    await app.settle();
    expect(app.callsTo("/api/workspace/start")[0].body).toEqual({ workspace: "wt1" });
    expect(app.root.querySelector(".wt-state")?.textContent).toBe("starting");
    expect(lifecycle().textContent).toBe("Stop"); // a starting server can be stopped

    sse.emit("server", { id: "wt1", state: "running", workspace: "wt1", port: 8075 });
    await app.settle();
    expect(lifecycle().textContent).toBe("Stop");

    await tab("Server logs");
    sse.emit("log", { server: "wt1", line: "worktree server ready" });
    await app.settle();
    const pane = app.root.querySelector(".wt-pane")!.textContent!;
    expect(pane).toContain("earlier line from the tail");
    expect(pane).toContain("worktree server ready");

    // the running server can't be removed
    const remove = await kebab("Remove workspace");
    expect(remove.disabled).toBe(true);
    expect(remove.title).toBe("stop the server first");
    document.body.click(); // outside click closes the menu
    await app.settle();
    expect(app.root.querySelector(".dash-kebab-wrap .dash-menu")).toBeNull();

    lifecycle().click();
    await app.settle();
    expect(app.callsTo("/api/workspace/stop")[0].body).toEqual({ workspace: "wt1" });
  });

  it("/odoo and /web/tests open the worktree's own port", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await mount([WT], {
      active: "",
      routes: {
        "/api/workspace/list": { servers: { wt1: { id: "wt1", state: "running", port: 8075 } } },
      },
    });
    mustText(app.root, ".wt-detail-name-row button", "/odoo").click();
    mustText(app.root, ".wt-detail-name-row button", "/web/tests").click();
    expect(open.mock.calls.map((c) => c[0])).toEqual([
      expect.stringContaining("localhost:8075"),
      expect.stringContaining("localhost:8075"),
    ]);
    expect(open.mock.calls[1][0]).toContain(encodeURIComponent("/web/tests"));
  });

  it("the main workspace has /odoo and /web/tests too, enabled once its server runs", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await mount([ALPHA], { active: "alpha" });
    const button = (label: string) =>
      mustText(app.root, ".wt-detail-name-row button", label) as HTMLButtonElement;
    expect(button("/odoo").disabled).toBe(true);
    expect(button("/web/tests").disabled).toBe(true);

    sse.emit("server", { id: "main", state: "running", workspace: "alpha", port: 8069 });
    await app.settle();
    button("/odoo").click();
    button("/web/tests").click();
    expect(open.mock.calls.map((c) => c[0])).toEqual([
      `http://localhost:8069/dev/autologin?to=${encodeURIComponent("/odoo?debug=assets")}`,
      expect.stringContaining(encodeURIComponent("/web/tests")),
    ]);
  });

  it("in docker mode the main workspace's links go through its container's nginx host", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await mount([ALPHA], { active: "alpha", config: { launch_mode: "docker" } });
    sse.emit("server", {
      id: "main",
      state: "running",
      workspace: "alpha",
      docker_container: "dev",
    });
    await app.settle();
    mustText(app.root, ".wt-detail-name-row button", "/odoo").click();
    expect(open.mock.calls[0][0]).toBe(
      `http://dev.localhost/dev/autologin?to=${encodeURIComponent("/odoo?debug=assets")}`,
    );
  });

  it("external mode has no /odoo or /web/tests for the main workspace", async () => {
    await mount([ALPHA], { active: "alpha", config: { launch_mode: "external" } });
    const labels = [...app.root.querySelectorAll(".wt-detail-name-row button")].map(
      (b) => b.textContent,
    );
    expect(labels.some((l) => l?.includes("/odoo"))).toBe(false);
  });

  it("Remove confirms, removes the worktree and drops it from the list", async () => {
    await mount([ALPHA, WT], { routes: { "/api/workspace/remove": removeRoute } });
    await select("feature-wt");
    const remove = await kebab("Remove workspace");
    expect(remove.title).toBe("remove the worktree + workspace");
    remove.click();
    await app.settle();
    expect(dialog()?.querySelector(".dialog-title")?.textContent).toBe(
      'Remove workspace "feature-wt"?',
    );
    await dialogButton("Discard");
    expect(app.callsTo("/api/workspace/remove")).toHaveLength(0);

    (await kebab("Remove workspace")).click();
    await app.settle();
    await dialogButton(dialog()!.querySelector(".dialog-foot .primary")!.textContent!);
    expect(app.callsTo("/api/workspace/remove")[0].body).toMatchObject({
      workspace: "wt1",
      dirPath: "/home/odoo/work-trees/wt1",
    });
    expect(texts(app.root, ".wt-item-name")).toEqual(["alpha"]);
  });

  it("Remove also removes the worktree's sub-workspaces", async () => {
    const child = ws({
      id: "wt2",
      name: "feature-wt-fp",
      location: "worktree",
      worktree: { dir: "/home/odoo/work-trees/wt2" },
      parent: "wt1",
    });
    await mount([ALPHA, WT, child], { routes: { "/api/workspace/remove": removeRoute } });
    await select("feature-wt");
    (await kebab("Remove workspace")).click();
    await app.settle();
    expect(dialog()?.textContent).toContain("This also removes 1 sub-workspace spawned from it.");
    await dialogButton(dialog()!.querySelector(".dialog-foot .primary")!.textContent!);
    await waitFor(app, () => app.callsTo("/api/workspace/remove").length === 2);
    expect(
      app.callsTo("/api/workspace/remove").map((c) => (c.body as { workspace: string }).workspace),
    ).toEqual(["wt1", "wt2"]);
    expect(texts(app.root, ".wt-item-name")).toEqual(["alpha"]);
  });

  it("a failed worktree removal keeps the workspace and its sub-workspaces", async () => {
    const child = ws({
      id: "wt2",
      name: "feature-wt-fp",
      location: "worktree",
      worktree: { dir: "/home/odoo/work-trees/wt2" },
      parent: "wt1",
    });
    await mount([ALPHA, WT, child], {
      routes: {
        // what the backend answers when git refuses (it replies 200, ok:false)
        "/api/workspace/remove": {
          ok: false,
          results: [
            { repo: "community", ok: false, error: "worktree locked" },
            { repo: "enterprise", ok: true, error: null },
          ],
        },
      },
    });
    await select("feature-wt");
    (await kebab("Remove workspace")).click();
    await app.settle();
    await dialogButton(dialog()!.querySelector(".dialog-foot .primary")!.textContent!);
    await waitFor(app, () => !!dialog()?.textContent?.includes("community: worktree locked"));
    expect(dialog()?.textContent).toContain("Worktree removal failed");
    // only the parent was attempted; nothing was removed
    expect(
      app.callsTo("/api/workspace/remove").map((c) => (c.body as { workspace: string }).workspace),
    ).toEqual(["wt1"]);
    expect(texts(app.root, ".wt-item-name")).toEqual(
      expect.arrayContaining(["feature-wt", "feature-wt-fp"]),
    );
  });

  it("Details shows the worktree's location, path and checkouts", async () => {
    await mount([WT], { active: "" });
    await tab("Details");
    const grid = texts(app.root, ".ws-details-grid > span");
    expect(grid.slice(0, 6)).toEqual([
      "Location",
      "Own worktree · port 8075",
      "Path",
      "/home/odoo/work-trees/wt1",
      "Checkouts",
      "community:master-wt1,enterprise:master",
    ]);
    expect(grid[7]).toMatch(/Sep 1, 2026.* · \d+d ago/);
  });
});

describe("header menu", () => {
  it("Edit saves the new name, branches and db; a duplicate name can't be saved", async () => {
    await mount([ALPHA, BETA]);
    (await kebab("Edit workspace…")).click();
    await app.settle();
    const d = dialog()!;
    expect(d.querySelector(".dialog-title")?.textContent).toBe('Edit "alpha"');
    const inputs = [...d.querySelectorAll<HTMLInputElement>("input[type=text]")];
    expect(inputs.map((i) => i.value)).toEqual([
      "alpha",
      "community:master-alpha,enterprise:master",
      "alpha",
      "",
    ]);
    const type = (i: number, v: string) => {
      inputs[i].value = v;
      inputs[i].dispatchEvent(new Event("input"));
    };
    type(0, "beta");
    await app.settle();
    expect(d.querySelector(".form-error")?.textContent).toBe(
      'a workspace named "beta" already exists',
    );
    expect(mustText(d, ".dialog-foot button", "Save").disabled).toBe(true);
    type(1, "");
    type(0, "alpha2");
    await app.settle();
    expect(d.querySelector(".form-error")?.textContent).toBe("a config is required");
    type(1, "community:master-alpha");
    type(2, " alpha2-db ");
    await app.settle();
    await dialogButton("Save");
    expect(app.root.querySelector(".wt-detail-name")?.textContent).toBe("alpha2");
    await waitFor(app, () => savedAlpha()?.name === "alpha2");
    expect(savedAlpha()).toMatchObject({
      name: "alpha2",
      db: "alpha2-db",
      checkouts: [{ repo: "community", branch: "master-alpha" }],
    });
  });

  it("Edit offers the category when categories are on; double-clicking the name opens it too", async () => {
    await mount([ALPHA], { config: { workspace_categories_enabled: true } });
    app.root.querySelector(".wt-detail-name")!.dispatchEvent(new MouseEvent("dblclick"));
    await app.settle();
    const select = dialog()!.querySelector("select")!;
    expect([...select.options].map((o) => o.value)).toEqual(["", "dev", "base", "archived"]);
    select.value = "dev";
    select.dispatchEvent(new Event("change"));
    await dialogButton("Save");
    expect(texts(app.root, ".wt-group-name")).toEqual(["dev"]);
  });

  it("Archive moves a non-loaded workspace to the archived group, with its sub-workspaces", async () => {
    await mount([ALPHA, BETA, ws({ id: "kid", name: "beta-kid", parent: "beta" })]);
    expect((await kebab("Archive workspace")).disabled).toBe(true); // alpha is loaded
    expect(mustText(app.root, ".dash-menu-item", "Archive workspace").title).toBe(
      "the active workspace cannot be archived",
    );
    await select("beta");
    const archive = await kebab("Archive workspace");
    expect(archive.title).toBe(
      "move it to the archived group, with its 1 sub-workspace (keeps branches, db and settings)",
    );
    archive.click();
    await app.settle();
    expect(texts(app.root, ".wt-group-name")).toEqual(["archived"]);
    expect(texts(app.root, ".wt-group-items.with-header .wt-item-name")).toEqual([
      "beta",
      "beta-kid",
    ]);
    const unarchive = await kebab("Unarchive workspace");
    expect(unarchive.title).toBe("move it back to uncategorized, with its 1 sub-workspace");
    unarchive.click();
    await app.settle();
    expect(texts(app.root, ".wt-group-name")).toEqual([]);
  });

  it("Drop database confirms first; cancel keeps it", async () => {
    await mount([ALPHA], { routes: { "/api/databases/drop": { ok: true } } });
    const drop = await kebab("Drop database");
    expect(drop.title).toBe('drop database "alpha"');
    drop.click();
    await app.settle();
    expect(dialog()?.querySelector(".dialog-msg")?.textContent).toBe(
      "This permanently deletes the database. This cannot be undone.",
    );
    await dialogButton("Discard");
    expect(app.callsTo("/api/databases/drop")).toHaveLength(0);
    (await kebab("Drop database")).click();
    await app.settle();
    await dialogButton("Drop");
    expect(app.callsTo("/api/databases/drop")[0].body).toMatchObject({ name: "alpha" });
  });

  it("a running server's database can't be dropped, nor the loaded workspace removed", async () => {
    await mount([ALPHA], {
      routes: { "/api/status": { id: "main", state: "running", workspace: "alpha" } },
    });
    const drop = await kebab("Drop database");
    expect(drop.disabled).toBe(true);
    expect(drop.title).toBe("stop the server first — it is running on this database");
    const remove = mustText(app.root, ".dash-menu-item", "Remove workspace");
    expect(remove.disabled).toBe(true);
    expect(remove.title).toBe("the loaded workspace cannot be removed");
  });

  it("Remove on a main-located workspace opens the delete dialog (the loaded one can't be removed)", async () => {
    await mount([ALPHA, BETA]);
    await select("beta");
    const remove = await kebab("Remove workspace");
    expect(remove.disabled).toBe(false);
    expect(remove.title).toBe("remove the workspace");
    remove.click();
    await app.settle();
    expect(document.querySelector(".dialog-backdrop")).not.toBeNull();
  });

  it("Add opens the new-workspace dialog", async () => {
    await mount([ALPHA]);
    mustText(app.root, ".wt-list-title button", "Add").click();
    await app.settle();
    expect(document.querySelector(".dialog-backdrop")).not.toBeNull();
  });

  it("Details: notes are saved to the workspace", async () => {
    await mount([ALPHA]);
    await tab("Details");
    expect(byText(app.root, ".ws-details-grid span", "Main checkout")).toBeDefined();
    const notes = app.root.querySelector<HTMLTextAreaElement>("#ws-notes")!;
    notes.value = "remember the migration";
    notes.dispatchEvent(new Event("change"));
    await waitFor(app, () => savedAlpha()?.notes === "remember the migration");
  });
});

describe("checkout drift", () => {
  // alpha is loaded, but community was switched to another branch in a terminal
  const drifted = () => {
    const git = GIT();
    git[0].current = "master-other";
    git[0].branches!.push({ ...git[0].branches![0], name: "master-other" });
    return git;
  };

  it("flags the drift, gates the run panes, and Restore checks the branches out again", async () => {
    await mount([ALPHA], { git: drifted() });
    expect(app.root.querySelector(".wt-item .wt-chip.drift")).not.toBeNull();
    expect(app.root.querySelector(".ws-drift-text")?.textContent).toBe(
      "checkout drift: community is on master-other, expected master-alpha",
    );
    expect(mustText(app.root, ".wt-start-btn", "Start").disabled).toBe(true);
    expect(app.root.querySelector<HTMLButtonElement>(".wt-start-btn")!.title).toContain(
      "Restore its branches first",
    );
    await tab("Tests");
    expect(paneHint()).toContain("Restore its branches first");
    await tab("Main");

    mustText(app.root, ".ws-drift-strip button", "Restore branches").click();
    await app.settle();
    expect(app.callsTo("/api/code/checkout")[0].body).toMatchObject({
      repos: [
        { repo: "community", branch: "master-alpha" },
        { repo: "enterprise", branch: "master" },
      ],
    });
    expect(app.root.querySelector(".ws-drift-strip")).toBeNull();
  });

  it("Adopt current branches rewrites the workspace to what is checked out", async () => {
    await mount([ALPHA], { git: drifted() });
    mustText(app.root, ".ws-drift-strip button", "Adopt current branches").click();
    await app.settle();
    expect(app.root.querySelector(".ws-drift-strip")).toBeNull();
    expect(app.root.querySelector(".wt-item")?.getAttribute("title")).toBe("master-other · alpha");
  });

  it("offers to switch to the workspace that matches the current checkout", async () => {
    const other = ws({
      id: "other",
      checkouts: [
        { repo: "community", branch: "master-other" },
        { repo: "enterprise", branch: "master" },
      ],
    });
    await mount([ALPHA, other], { git: drifted() });
    mustText(app.root, ".ws-drift-strip button", "Switch to other").click();
    await app.settle();
    // "other" is now the loaded workspace: alpha is no longer drifted, just unloaded
    expect(app.root.querySelector(".ws-drift-strip")).toBeNull();
    expect(lifecycle().textContent).toBe("Activate");
    await select("other");
    expect(lifecycle().textContent).toBe("Start");
  });

  it("Save as new workspace… opens the create dialog prefilled with the actual branches", async () => {
    await mount([ALPHA], { git: drifted() });
    mustText(app.root, ".ws-drift-strip button", "Save as new workspace…").click();
    await app.settle();
    const values = [...dialog()!.querySelectorAll<HTMLInputElement>("input[type=text]")].map(
      (i) => i.value,
    );
    expect(values).toContain("master-other");
    expect(values).toContain("community:master-other,enterprise:master");
  });
});

describe('launch_mode "external"', () => {
  it("replaces Start/Stop with a read-only status check and hides the server tabs", async () => {
    await mount([ALPHA], {
      config: { launch_mode: "external" },
      routes: {
        "/api/workspace/external_status": { running: true, url: "http://alpha.localhost" },
      },
    });
    expect(texts(app.root, ".wt-tab")).toEqual(["Main", "Assets", "Claude", "Details"]);
    expect(lifecycle().textContent?.trim()).toBe("Check status");
    lifecycle().click();
    await app.settle();
    expect(lifecycle().textContent?.trim()).toBe("Running");
    expect(app.root.querySelector<HTMLAnchorElement>("a.pbtn.ghost")?.href).toBe(
      "http://alpha.localhost/",
    );

    // dropping the db warns about the externally running server
    (await kebab("Drop database")).click();
    await app.settle();
    expect(dialog()?.querySelector(".dialog-msg")?.textContent).toContain(
      'An external server appears to be running against "alpha" right now (http://alpha.localhost)',
    );
  });
});
