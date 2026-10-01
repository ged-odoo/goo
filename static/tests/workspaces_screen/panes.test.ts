// The Workspaces screen's Tests / Addons / Assets / Terminal tab panes, driven
// through the real app: what each pane renders from the backend, the runs it
// starts, and how live run/log events update it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountApp, type MountedApp, type MountAppOptions } from "../helpers/app.ts";
import {
  captureSse,
  dialog,
  gitBackend,
  mustText,
  prsRoute,
  repo,
  texts,
  ws,
  type Sse,
} from "../helpers/workspaces_fixtures.ts";
import type { WorkspaceConfig } from "../../src/core/config.ts";

// xterm + WebSocket + ResizeObserver are out of unit-test reach (CLAUDE.md
// Gotchas); the pane's own job is attaching to the right PTY and detaching
const xterm = vi.hoisted(() => ({ attach: vi.fn(), dispose: vi.fn() }));
vi.mock("../../src/core/terminal.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/terminal.ts")>()),
  attachXterm: async (el: HTMLElement, url: string, focus: boolean) => {
    xterm.attach(el, url, focus);
    return xterm.dispose;
  },
}));

let app: MountedApp;
let sse: Sse;
afterEach(() => {
  app?.destroy();
  vi.restoreAllMocks();
  xterm.attach.mockReset();
  xterm.dispose.mockReset();
});

const ALPHA = ws({ id: "alpha" }); // main-located, loaded
const WT = ws({
  id: "wt1",
  name: "feature-wt",
  location: "worktree",
  worktree: { dir: "/home/odoo/work-trees/wt1" },
  port: 8075,
});

async function mount(workspaces: WorkspaceConfig[], opts: MountAppOptions = {}) {
  sse = captureSse();
  const git = gitBackend([
    repo("community", "master-alpha", ["master", "master-alpha", "master-wt1"]),
    repo("enterprise", "master", ["master"]),
  ]);
  app = await mountApp({
    section: "workspaces",
    ...opts,
    config: { targets: [], workspaces, ...opts.config },
    state: { active_workspace: "alpha", ...opts.state },
    routes: {
      ...git.routes,
      "/api/prs": prsRoute(),
      "/api/runbot": { states: {} },
      "/api/mergebot": { states: {} },
      "/api/status": { id: "main", state: "stopped" },
      "/api/databases": { ok: true, databases: [] },
      "/api/workspace/list": { servers: {} },
      "/api/workspace/logs": { lines: [] },
      ...opts.routes,
    },
  });
  return app;
}

async function tab(label: string) {
  mustText(app.root, ".wt-tab", label).click();
  await app.settle();
}

const pane = () => app.root.querySelector<HTMLElement>(".wt-pane")!;

function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

describe("Tests pane", () => {
  it("runs the typed tags on the workspace's slot and follows the run to its verdict", async () => {
    await mount([WT], {
      config: { test_presets: [{ tags: "/sale" }, { tags: " " }] },
      state: { test_history: ["/account"] },
    });
    await tab("Tests");
    expect(pane().textContent).toContain("No test output yet");
    // presets (blank ones skipped) + recent tags
    expect(texts(pane(), "optgroup[label=Presets] option")).toEqual(["/sale"]);
    expect(texts(pane(), "optgroup[label=Recent] option")).toEqual(["/account"]);
    // the copy-as-CLI button is main-slot only
    expect(pane().querySelector(".test-form .tool-btn[title^=Copy]")).toBeNull();

    const run = mustText(pane(), "button[type=submit]", "Run");
    expect(run.disabled).toBe(true); // no tags yet
    const select = pane().querySelector<HTMLSelectElement>(".preset-select")!;
    select.value = "/sale";
    select.dispatchEvent(new Event("change"));
    await app.settle();
    expect(pane().querySelector<HTMLInputElement>(".test-form input[type=text]")!.value).toBe(
      "/sale",
    );

    mustText(pane(), "label.toggle", "Memory check").click();
    await app.settle();
    run.click();
    await app.settle();
    expect(app.callsTo("/api/tests/run")[0].body).toEqual({
      workspace: "wt1",
      slot: "wt1",
      overrides: { test_tags: "/sale", memcheck: true },
    });
    expect(pane().querySelector(".test-badge")?.textContent).toBe("running");
    expect(run.disabled).toBe(true); // one run at a time
    expect(texts(pane(), "optgroup[label=Recent] option")).toEqual(["/sale", "/account"]);

    sse.emit("run", { id: "run-1", kind: "test", state: "running", server: "wt1" });
    sse.emit("log", { server: "wt1", line: "[goo] starting odoo: odoo-bin --test-tags /sale" });
    sse.emit("log", { server: "wt1", line: "test_sale_order ... ok" });
    await app.settle();
    expect(pane().textContent).toContain("test_sale_order ... ok");
    expect(pane().textContent).not.toContain("No test output yet");

    // Stop stops the worktree's server (the backend finalizes the run)
    const stop = mustText(pane(), "button.stop", "Stop");
    expect(stop.disabled).toBe(false);
    stop.click();
    await app.settle();
    expect(app.callsTo("/api/workspace/stop")[0].body).toEqual({ workspace: "wt1" });

    sse.emit("run", { id: "run-1", kind: "test", state: "done", server: "wt1", returncode: 0 });
    await app.settle();
    expect(pane().querySelector(".test-badge")?.textContent).toBe("success");
    expect(pane().querySelector(".test-badge")?.className).toContain("ok");

    // a failing exit reads as "fail"
    type(pane().querySelector<HTMLInputElement>(".test-form input[type=text]")!, "/stock");
    await app.settle();
    mustText(pane(), "button[type=submit]", "Run").click();
    await app.settle();
    sse.emit("run", { id: "run-2", kind: "test", state: "running", server: "wt1" });
    await app.settle();
    sse.emit("run", { id: "run-2", kind: "test", state: "failed", server: "wt1", returncode: 1 });
    await app.settle();
    expect(pane().querySelector(".test-badge")?.textContent).toBe("fail");

    // Clear empties the console
    mustText(pane(), ".log-controls button", "Clear").click();
    await app.settle();
    expect(pane().textContent).not.toContain("test_sale_order");
  });

  it("main slot: copies a quoted goo CLI command, and Stop stops the main server", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await mount([ALPHA], {
      routes: { "/api/status": { id: "main", state: "running", workspace: "alpha" } },
    });
    await tab("Tests");
    const copy = pane().querySelector<HTMLButtonElement>(".test-form .tool-btn[title^=Copy]")!;
    expect(copy.disabled).toBe(true);
    type(pane().querySelector<HTMLInputElement>(".test-form input[type=text]")!, "it's/tag");
    await app.settle();
    copy.click();
    expect(writeText).toHaveBeenCalledWith("goo --test-tags 'it'\\''s/tag'");

    mustText(pane(), "button[type=submit]", "Run").click();
    await app.settle();
    expect(app.callsTo("/api/tests/run")[0].body).toMatchObject({
      workspace: "alpha",
      slot: "main",
    });
    sse.emit("run", { id: "run-9", kind: "test", state: "running" });
    await app.settle();
    mustText(pane(), "button.stop", "Stop").click();
    await app.settle();
    expect(app.callsTo("/api/stop")).toHaveLength(1);
  });

  it("a run the backend refuses shows the failure instead of a running badge", async () => {
    await mount([WT], {
      routes: {
        "/api/tests/run": new Response(JSON.stringify({ error: "no odoo-bin" }), { status: 500 }),
      },
    });
    await tab("Tests");
    type(pane().querySelector<HTMLInputElement>(".test-form input[type=text]")!, "/sale");
    await app.settle();
    mustText(pane(), "button[type=submit]", "Run").click();
    await app.settle();
    expect(pane().querySelector(".test-badge")?.textContent).toBe("fail");
    expect(mustText(pane(), "button[type=submit]", "Run").disabled).toBe(false);
  });
});

const MODULES = [
  {
    name: "sale",
    repo: "community",
    category: "Sales",
    summary: "Sales orders",
    application: true,
    installable: true,
    state: "installed",
  },
  {
    name: "stock",
    repo: "community",
    category: "Inventory",
    summary: "Warehouses",
    application: true,
    installable: true,
    state: "uninstalled",
  },
  {
    name: "sale_stock",
    repo: "community",
    category: "Hidden",
    summary: "glue",
    application: false,
    installable: true,
    state: null,
  },
  {
    name: "helpdesk",
    repo: "enterprise",
    category: "Services",
    summary: "Tickets",
    application: true,
    installable: false,
    state: null,
  },
];

describe("Addons pane", () => {
  it("lists the db's apps, filters them, and installs one after confirming", async () => {
    await mount([WT], { routes: { "/api/addons": { modules: MODULES } } });
    await tab("Addons");
    const body = app.callsTo("/api/addons")[0].body as {
      db: string;
      repos: { id: string; path: string }[];
    };
    expect(body.db).toBe("wt1");
    expect(body.repos).toContainEqual({
      id: "community",
      path: "/home/odoo/work-trees/wt1/community",
    });

    const rows = () => texts(pane(), "tbody .addon-name");
    expect(rows()).toEqual(["sale", "helpdesk", "stock"]); // apps only, installed first
    expect(pane().querySelector(".ws-pane-count")?.textContent).toBe("3 modules");
    expect(texts(pane(), "tbody .addon-state")).toEqual([
      "installed",
      "not installed",
      "uninstalled",
    ]);
    // a non-installable module can't be installed
    const helpdeskBtn = pane().querySelectorAll<HTMLButtonElement>("tbody .addon-btn")[1];
    expect(helpdeskBtn.disabled).toBe(true);

    mustText(pane(), ".ws-pane-toolbar button", "Apps").click();
    await app.settle();
    expect(rows()).toEqual(["sale", "helpdesk", "sale_stock", "stock"]);
    mustText(pane(), ".ws-pane-toolbar button", "Installed").click();
    await app.settle();
    expect(rows()).toEqual(["sale"]);
    expect(pane().querySelector(".ws-pane-count")?.textContent).toBe("1 module");
    mustText(pane(), ".ws-pane-toolbar button", "Uninstalled").click();
    await app.settle();
    expect(rows()).toEqual(["helpdesk", "sale_stock", "stock"]);
    mustText(pane(), ".ws-pane-toolbar button", "Uninstalled").click(); // toggles off
    await app.settle();
    type(pane().querySelector<HTMLInputElement>(".search-box input")!, "zzz");
    await app.settle();
    expect(pane().textContent).toContain("No modules match");
    type(pane().querySelector<HTMLInputElement>(".search-box input")!, "warehouse");
    await app.settle();
    expect(rows()).toEqual(["stock"]);

    mustText(pane(), "tbody .addon-btn", "Install").click();
    await app.settle();
    expect(dialog()?.querySelector(".dialog-title")?.textContent).toBe('Install "stock" on wt1?');
    mustText(dialog()!, ".dialog-foot button", "Install").click();
    await app.settle();
    expect(app.callsTo("/api/addons/run")[0].body).toEqual({
      workspace: "wt1",
      slot: "wt1",
      overrides: { install: "stock" },
    });
    // the run's console opens and streams the install
    sse.emit("run", { id: "run-5", kind: "install", state: "running", server: "wt1" });
    sse.emit("log", { server: "wt1", line: "loading stock module" });
    await app.settle();
    expect(pane().querySelector(".addons-console")?.textContent).toContain("loading stock module");
    expect(pane().querySelector(".ws-sec-meta")?.textContent).toBe("installing…");
    expect(
      [...pane().querySelectorAll<HTMLButtonElement>("tbody .addon-btn")].every((b) => b.disabled),
    ).toBe(true);

    // when it ends the module list is re-read
    const loads = app.callsTo("/api/addons").length;
    sse.emit("run", { id: "run-5", kind: "install", state: "done", server: "wt1", returncode: 0 });
    await app.settle();
    expect(pane().querySelector(".ws-sec-meta")?.textContent).toBe("done");
    expect(app.callsTo("/api/addons").length).toBe(loads + 1);

    // the reload button re-reads it too
    pane()
      .querySelector<HTMLButtonElement>(".ws-pane-toolbar button[title='reload the module list']")!
      .click();
    await app.settle();
    expect(app.callsTo("/api/addons").length).toBe(loads + 2);
  });

  it("shows the backend's error when the module list can't be read", async () => {
    await mount([WT], {
      routes: {
        "/api/addons": new Response(JSON.stringify({ error: 'database "wt1" does not exist' }), {
          status: 500,
        }),
      },
    });
    await tab("Addons");
    expect(pane().querySelector(".form-error")?.textContent).toBe('database "wt1" does not exist');
    expect(app.callsTo("/api/addons")).toHaveLength(1); // no auto-retry loop
  });
});

const BUNDLES = [
  {
    id: 1,
    name: "web.assets_web.min.js",
    url: "/web/assets/1/web.assets_web.min.js",
    size: 3_000_000,
    created: "",
  },
  {
    id: 2,
    name: "web.assets_web.min.css",
    url: "/web/assets/2/web.assets_web.min.css",
    size: 500_000,
    created: "",
  },
  {
    id: 3,
    name: "web.assets_web.min.js.map",
    url: "/web/assets/3/web.assets_web.min.js.map",
    size: 9_000_000,
    created: "",
  },
  {
    id: 4,
    name: "web.assets_frontend.min.js",
    url: "/web/assets/4/web.assets_frontend.min.js",
    size: 1_000_000,
    created: "",
  },
];

describe("Assets pane", () => {
  it("lists the db's bundles largest first, filters by kind and text, and sorts by column", async () => {
    await mount([WT], { routes: { "/api/assets": { bundles: BUNDLES } } });
    await tab("Assets");
    expect(app.callsTo("/api/assets")[0].body).toEqual({ db: "wt1", refresh: true });
    const names = () => texts(pane(), "tbody .assets-name");
    expect(names()).toEqual([
      "web.assets_web.min.js.map",
      "web.assets_web.min.js",
      "web.assets_frontend.min.js",
      "web.assets_web.min.css",
    ]);
    expect(pane().querySelector(".ws-pane-count")?.textContent).toBe("4 bundles");

    const kind = (label: string) => {
      const box = mustText<HTMLLabelElement>(pane(), "label.assets-chk", label).querySelector(
        "input",
      )!;
      box.dispatchEvent(new Event("change"));
    };
    kind("other");
    kind("css");
    await app.settle();
    expect(names()).toEqual(["web.assets_web.min.js", "web.assets_frontend.min.js"]);
    kind("js");
    await app.settle();
    expect(pane().textContent).toContain("No bundle matches");
    kind("js");
    kind("css");
    kind("other");
    type(pane().querySelector<HTMLInputElement>(".search-box input")!, "frontend");
    await app.settle();
    expect(names()).toEqual(["web.assets_frontend.min.js"]);
    expect(pane().querySelector(".ws-pane-count")?.textContent).toBe("1 bundle");
    type(pane().querySelector<HTMLInputElement>(".search-box input")!, "");
    await app.settle();

    // by name: A→Z, then Z→A on a second click
    const nameHead = pane().querySelector<HTMLElement>("th.br-sort")!;
    nameHead.click();
    await app.settle();
    expect(nameHead.textContent).toBe("Bundle ▲");
    expect(names()[0]).toBe("web.assets_frontend.min.js");
    nameHead.click();
    await app.settle();
    expect(nameHead.textContent).toBe("Bundle ▼");
    expect(names()[0]).toBe("web.assets_web.min.js.map");
    expect(texts(pane(), "tbody .ws-num")[0]).toMatch(/MB/);
  });

  it("copies a bundle's url, flipping its link to 'copied'", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await mount([WT], { routes: { "/api/assets": { bundles: BUNDLES.slice(0, 1) } } });
    await tab("Assets");
    const copy = pane().querySelector<HTMLButtonElement>(".assets-copy")!;
    expect(copy.textContent).toBe("copy url");
    copy.click();
    await app.settle();
    expect(writeText).toHaveBeenCalledWith("/web/assets/1/web.assets_web.min.js");
    expect(copy.textContent).toBe("copied");
  });

  it("opens a bundle's analysis and goes back to the list", async () => {
    await mount([WT], {
      routes: {
        "/api/assets": { bundles: BUNDLES },
        "/api/assets/breakdown": {
          js: [["web/static/src/core/l10n.js", 1200]],
          css: [],
          xml: [],
        },
      },
    });
    await tab("Assets");
    mustText(pane(), ".assets-name", "web.assets_web.min.css").click();
    await app.settle();
    expect(app.callsTo("/api/assets/breakdown")[0].body).toMatchObject({
      db: "wt1",
      bundle: "web.assets_web",
      kind: "css",
    });
    expect(pane().querySelector(".assets-analysis")).not.toBeNull();
    mustText(pane(), ".assets-analysis-bar button", "← Back").click();
    await app.settle();
    expect(pane().querySelector(".assets-analysis")).toBeNull();
    expect(texts(pane(), "tbody .assets-name")).toHaveLength(4);
  });

  it("Generate builds the worktree's bundles then reloads the list; errors are shown", async () => {
    let bundles: typeof BUNDLES = [];
    await mount([WT], {
      routes: {
        "/api/assets": () => ({ bundles }),
        "/api/assets/generate": () => {
          bundles = BUNDLES;
          return {};
        },
      },
    });
    await tab("Assets");
    expect(pane().textContent).toContain("No bundle matches");
    mustText(pane(), ".ws-pane-toolbar button", "Generate").click();
    await app.settle();
    expect(app.callsTo("/api/assets/generate")[0].body).toEqual({ db: "wt1", workspace: "wt1" });
    expect(texts(pane(), "tbody .assets-name")).toHaveLength(4);
    // the reload button force-refreshes
    pane().querySelector<HTMLButtonElement>("button[title='reload the bundle list']")!.click();
    await app.settle();
    expect(app.callsTo("/api/assets").at(-1)?.body).toEqual({ db: "wt1", refresh: true });
  });

  it("shows the backend's error, and the no-database hint for a db-less workspace", async () => {
    await mount([WT, ws({ id: "nodb", db: "" })], {
      routes: {
        "/api/assets": new Response(JSON.stringify({ error: "psql: connection refused" }), {
          status: 500,
        }),
      },
    });
    await tab("Assets");
    expect(pane().querySelector(".form-error")?.textContent).toBe("psql: connection refused");
    [...app.root.querySelectorAll<HTMLButtonElement>(".wt-item")][1].click();
    await app.settle();
    expect(app.root.querySelector(".ws-pane-hint")?.textContent).toBe(
      "This workspace has no database.",
    );
  });
});

describe("Terminal pane", () => {
  it("attaches to the running worktree server's PTY and detaches on leaving the tab", async () => {
    await mount([WT], {
      routes: {
        "/api/workspace/list": { servers: { wt1: { id: "wt1", state: "running", port: 8075 } } },
      },
    });
    await tab("Terminal");
    expect(xterm.attach).toHaveBeenCalledTimes(1);
    const [el, url, focus] = xterm.attach.mock.calls[0];
    expect(el).toBe(app.root.querySelector(".ws-term"));
    expect(url).toBe(`ws://${location.host}/api/terminal?workspace=wt1`);
    expect(focus).toBe(true);
    await tab("Main");
    expect(xterm.dispose).toHaveBeenCalledTimes(1);
  });

  it("the loaded main workspace attaches to the main PTY", async () => {
    await mount([ALPHA]);
    await tab("Terminal");
    expect(xterm.attach.mock.calls[0][1]).toBe(`ws://${location.host}/api/terminal?workspace=main`);
  });
});
