import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceConfig } from "../../src/core/config.ts";
import { mountApp, type MountedApp, type Route } from "../helpers/app.ts";
import { button, RecordingEventSource, waitFor } from "../helpers/core_ui_fixtures.ts";

let app: MountedApp;
afterEach(() => {
  app?.destroy();
  document.getElementById("favicon")?.remove();
  document.documentElement.classList.remove("sidebar-collapsed");
});

const ws = (over: Partial<WorkspaceConfig> & { id: string }): WorkspaceConfig => ({
  name: over.id,
  created_at: "",
  last_activity: "",
  favorite: false,
  category: "",
  parent: "",
  notes: "",
  db: over.id,
  on_create_args: "",
  demo_data: false,
  location: "main",
  worktree: null,
  port: null,
  checkouts: [{ repo: "community", branch: over.id }],
  ...over,
});

const WORKSPACES = [
  ws({ id: "master", name: "Master" }),
  ws({ id: "feat", name: "Feature" }),
  ws({ id: "wt1", name: "Worktree one", location: "worktree", port: 8070 }),
];

const branchInfo = (name: string) => ({ name, date: "", subject: "", sha: "a" });

// boot on the light Databases screen; the shell is what's under test
async function boot({
  status = { id: "main", state: "stopped" },
  state = { active_workspace: "master" },
  routes = {},
  config = {},
}: {
  status?: object;
  state?: Record<string, unknown>;
  routes?: Record<string, Route>;
  config?: object;
} = {}) {
  vi.stubGlobal("EventSource", RecordingEventSource);
  RecordingEventSource.instances = [];
  app = await mountApp({
    section: "databases",
    config: { workspaces: WORKSPACES, targets: [], ...config },
    state,
    routes: {
      "/api/databases": { ok: true, databases: [] },
      "/api/status": status,
      "/api/start": { ok: true },
      "/api/stop": { ok: true },
      "/api/code/branches": {
        repos: [
          { id: "community", current: "master", branches: ["master", "feat"].map(branchInfo) },
        ],
      },
      "/api/code/checkout": { results: [{ ok: true, branch: "feat" }] },
      ...routes,
    },
  });
  return RecordingEventSource.instances[0];
}

const toggle = () => app.root.querySelector<HTMLButtonElement>(".nt-toggle")!;

describe("Topbar — the loaded workspace badge", () => {
  it("names the loaded workspace and starts it from the toggle", async () => {
    const es = await boot();
    expect(app.root.querySelector(".t-name")!.textContent).toBe("Master");
    expect(app.root.querySelector(".nav-target")!.classList.contains("idle")).toBe(true);
    expect(toggle().textContent).toBe("Start");
    expect(toggle().disabled).toBe(false);
    toggle().click();
    await app.settle();
    // optimistic: "Starting…" right away, until the backend reports running
    expect(toggle().textContent).toBe("Starting…");
    expect(app.callsTo("/api/start")[0].body).toMatchObject({ workspace: "master" });
    es.emit("server", { id: "main", state: "running", workspace: "master" });
    await app.settle();
    expect(toggle().textContent).toBe("Stop");
    expect(app.root.querySelector(".nav-target")!.classList.contains("live")).toBe(true);
    expect(app.root.querySelector(".nav-target")!.getAttribute("title")).toBe(
      "loaded workspace (running)",
    );
    toggle().click();
    await app.settle();
    expect(app.callsTo("/api/stop").length).toBe(1);
    expect(toggle().textContent).toBe("Stopping…");
    expect(toggle().disabled).toBe(true);
  });

  it("reflects a running server from the first render, and the backend's stopping/disconnected states", async () => {
    const es = await boot({ status: { id: "main", state: "running", workspace: "feat" } });
    // the running server's workspace wins over the last-activated one
    expect(app.root.querySelector(".t-name")!.textContent).toBe("Feature");
    expect(toggle().textContent).toBe("Stop");
    es.emit("server", { id: "main", state: "starting", workspace: "feat" });
    await app.settle();
    expect(toggle().textContent).toBe("Starting…");
    expect(app.root.querySelector(".nav-target")!.classList.contains("starting")).toBe(true);
    es.emit("server", { id: "main", state: "stopping", workspace: "feat" });
    await app.settle();
    expect(toggle().textContent).toBe("Stopping…");
    es.fail(); // the SSE connection dropped
    await app.settle();
    expect(toggle().textContent).toBe("Start");
    expect(toggle().disabled).toBe(true);
    expect(toggle().title).toBe("server unreachable");
    expect(app.root.querySelector(".nav-target")!.getAttribute("title")).toBe(
      "loaded workspace — server stopped",
    );
  });

  it("hides the Start/Stop toggle for externally launched servers, and the badge without a workspace", async () => {
    await boot({ config: { launch_mode: "external" } });
    expect(app.root.querySelector(".nav-target")).not.toBeNull();
    expect(app.root.querySelector(".nt-toggle")).toBeNull();
    app.destroy();
    await boot({ state: { active_workspace: "" } });
    expect(app.root.querySelector(".nav-target")).toBeNull();
  });

  it("the switcher lists main workspaces + running worktrees and activates another workspace", async () => {
    const es = await boot();
    const items = () =>
      [...app.root.querySelectorAll(".nt-item")].map((b) => b.textContent!.trim());
    expect(items()).toEqual(["Master", "Feature", "All workspaces →"]);
    es.emit("server", { id: "wt1", state: "running", workspace: "wt1", port: 8071 });
    await app.settle();
    expect(items()).toEqual(["Master", "Feature", "Worktree one:8071", "All workspaces →"]);

    // the active one is a no-op; another one checks its branches out and becomes current
    button(app.root, "Master").click();
    await app.settle();
    expect(app.callsTo("/api/code/checkout")).toEqual([]);
    button(app.root, "Feature").click();
    await waitFor(app.settle, () => app.root.querySelector(".t-name")!.textContent === "Feature");
    expect(app.callsTo("/api/code/checkout")[0].body).toMatchObject({
      repos: [{ repo: "community", branch: "feat" }],
    });
  });

  it("jumps to the Workspaces screen from the switcher", async () => {
    const es = await boot({
      routes: { "/api/workspaces/status": { ok: true, workspaces: [] } },
    });
    es.emit("server", { id: "wt1", state: "starting", workspace: "wt1" });
    await app.settle();
    const wt = [...app.root.querySelectorAll<HTMLElement>(".nt-item")].find((b) =>
      b.textContent!.includes("Worktree one"),
    )!;
    expect(wt.textContent).toContain(":8070"); // the configured port until the server reports one
    wt.click();
    await app.settle();
    expect(location.hash).toBe("#workspaces");
    expect(app.root.querySelector(".nav-item.active")!.textContent).toContain("Workspaces");
    location.hash = "#databases";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await app.settle();
    button(app.root, "All workspaces →").click();
    await app.settle();
    expect(location.hash).toBe("#workspaces");
  });

  it("renders the configured links, menus as dropdowns", async () => {
    await boot({
      config: {
        links: [
          { label: "Odoo", href: "http://localhost:8069/odoo" },
          { label: "Docs", children: [{ label: "Dev", href: "https://odoo.com/dev" }] },
          { label: "Empty", children: [] },
        ],
      },
    });
    const top = app.root.querySelector(".top-right")!;
    expect(top.querySelector<HTMLAnchorElement>("a.route")!.href).toBe(
      "http://localhost:8069/odoo",
    );
    expect(top.querySelector(".route-menu-label")!.textContent).toBe("Docs▾");
    expect(top.querySelector<HTMLAnchorElement>(".route-menu-item")!.href).toBe(
      "https://odoo.com/dev",
    );
    expect(top.querySelectorAll(".route-menu").length).toBe(1); // an empty menu is dropped
  });
});

describe("Topbar — event log button", () => {
  it("badges unread events and toggles the event log", async () => {
    const es = await boot();
    const btn = app.root.querySelector<HTMLButtonElement>(".nav-events")!;
    expect(btn.title).toBe("toggle the event log");
    es.emit("event", { text: "fetched PRs" });
    es.emit("event", { text: "pushed" });
    await app.settle();
    expect(btn.querySelector(".nav-events-badge")!.textContent).toBe("2");
    expect(btn.title).toBe("2 new events — toggle the event log");
    btn.click();
    await app.settle();
    expect(btn.classList.contains("active")).toBe(true);
    expect(app.root.querySelector(".event-log")).not.toBeNull();
    expect(btn.querySelector(".nav-events-badge")).toBeNull(); // read
  });
});

describe("Sidebar", () => {
  it("shows the default tabs, navigates, and highlights the current screen", async () => {
    await boot({
      routes: {
        // the Configuration screen loads these on open
        "/api/rust-bundler": {
          ok: true,
          installed: true,
          current: true,
          version: "1.0",
          expected_version: "1.0",
          building: false,
        },
        "/api/review-prompt": { ok: true, content: "" },
      },
    });
    const labels = [...app.root.querySelectorAll(".sidebar .nav-label")].map((l) => l.textContent);
    // opt-in tabs stay hidden until enabled
    expect(labels).toEqual([
      "Workspaces",
      "Branches & PRs",
      "Databases",
      "Configuration",
      "Collapse",
    ]);
    expect(app.root.querySelector(".nav-item.active")!.textContent).toBe("Databases");
    button(app.root, "Configuration").click();
    await app.settle();
    expect(location.hash).toBe("#config");
    expect(app.root.querySelector(".nav-item.active")!.textContent).toBe("Configuration");
  });

  it("follows the configured tab order and visibility; Configuration is always kept", async () => {
    await boot({
      config: {
        tabs: [
          { id: "databases" },
          { id: "nightly", visible: true },
          { id: "workspaces", visible: false },
          { id: "config", visible: false },
          { id: "bogus" },
        ],
      },
    });
    const labels = [...app.root.querySelectorAll(".sidebar .nav-label")].map((l) => l.textContent);
    expect(labels).toEqual(["Databases", "Nightly", "Branches & PRs", "Configuration", "Collapse"]);
  });

  it("collapses, persisting the choice across reloads", async () => {
    await boot();
    const collapse = app.root.querySelector<HTMLButtonElement>(".nav-collapse")!;
    expect(collapse.title).toBe("Collapse sidebar");
    collapse.click();
    await app.settle();
    expect(app.root.querySelector(".sidebar")!.classList.contains("collapsed")).toBe(true);
    expect(document.documentElement.classList.contains("sidebar-collapsed")).toBe(true);
    expect(collapse.title).toBe("Expand sidebar");
    expect(app.root.querySelector<HTMLElement>(".nav-item")!.title).toBe("Workspaces");
    app.destroy();
    expect(document.documentElement.classList.contains("sidebar-collapsed")).toBe(false);
    localStorage.setItem("oo-sidebar-collapsed", "1");
    await boot();
    expect(app.root.querySelector(".sidebar")!.classList.contains("collapsed")).toBe(true);
  });

  it("offers a goo update when behind origin, and explains a non-fast-forward one", async () => {
    await boot({
      routes: {
        "/api/goo/update": { ok: true, checked: true, behind: 3, ahead: 1, dirty: true },
      },
    });
    const upd = app.root.querySelector<HTMLButtonElement>(".nav-update")!;
    expect(upd.title).toBe(
      "3 commits behind origin/master, 1 local commit ahead, working tree dirty — click to update goo",
    );
    upd.click();
    await app.settle();
    const dialog = app.root.querySelector(".dialog")!;
    expect(dialog.textContent).toContain("Update manually to keep your work");
  });

  it("shows no update badge when up to date", async () => {
    await boot({ routes: { "/api/goo/update": { ok: true, checked: true, behind: 0 } } });
    expect(app.root.querySelector(".nav-update")).toBeNull();
  });
});

describe("App", () => {
  it("keeps the favicon in step with the server state", async () => {
    const link = document.createElement("link");
    link.id = "favicon";
    document.head.appendChild(link);
    const es = await boot();
    const icon = () => link.getAttribute("href");
    expect(icon()).toBe("/static/favicon.svg");
    toggle().click(); // amber the instant Start is clicked
    await app.settle();
    expect(icon()).toBe("/static/favicon-starting.svg");
    es.emit("server", { id: "main", state: "running", workspace: "master" });
    await app.settle();
    expect(icon()).toBe("/static/favicon-up.svg");
    es.fail();
    await app.settle();
    expect(icon()).toBe("/static/favicon-down.svg");
  });

  it("an unknown route falls back to the Workspaces screen", async () => {
    await boot();
    await app.navigate("nope");
    expect(app.root.querySelector("main h1")!.textContent).toContain("Workspaces");
  });

  it("[open in hoot] opens straight away while the server runs", async () => {
    await boot({ status: { id: "main", state: "running", workspace: "master" } });
    const open = vi.fn(() => null);
    vi.stubGlobal("open", open);
    document.dispatchEvent(new CustomEvent("goo:open-hoot", { detail: { url: "/web/tests?x" } }));
    await app.settle();
    expect(open).toHaveBeenCalledWith("/web/tests?x", "_blank");
    expect(app.callsTo("/api/start")).toEqual([]);
  });

  it("[open in hoot] starts a stopped server, then points the tab at the test", async () => {
    const es = await boot();
    const win = { closed: false, location: { href: "about:blank" }, close: vi.fn() };
    vi.stubGlobal(
      "open",
      vi.fn(() => win),
    );
    document.dispatchEvent(new CustomEvent("goo:open-hoot", { detail: { url: "/web/tests?y" } }));
    await waitFor(app.settle, () => app.callsTo("/api/start").length === 1);
    expect(app.callsTo("/api/start")[0].body).toMatchObject({ workspace: "master" });
    es.emit("server", { id: "main", state: "running", workspace: "master" });
    await waitFor(app.settle, () => win.location.href === "/web/tests?y");
    expect(win.close).not.toHaveBeenCalled();
  });

  it("shows the updating overlay while goo restarts after an update", async () => {
    let restarted = false;
    await boot({
      routes: {
        "/api/goo/update": (_body: unknown, call: { method: string }) =>
          call.method === "POST"
            ? { ok: true }
            : {
                ok: true,
                checked: true,
                behind: 1,
                can_fast_forward: true,
                boot: restarted ? "b2" : "b1",
              },
        "/api/goo/restart": () => {
          restarted = true;
          return { ok: true };
        },
      },
    });
    app.root.querySelector<HTMLButtonElement>(".nav-update")!.click();
    await app.settle();
    button(app.root, "Update & restart").click();
    await waitFor(app.settle, () => restarted);
    expect(app.root.querySelector(".goo-updating")!.textContent).toContain(
      "Updating goo and restarting…",
    );
    // let the restart wait see the new boot id (it then reloads the page), so no
    // poll outlives the test
    const polls = () => app.callsTo("/api/goo/update").filter((c) => c.method === "GET").length;
    const before = polls();
    await waitFor(app.settle, () => polls() > before);
  });

  it("a failed update drops the overlay and shows the error", async () => {
    await boot({
      routes: {
        "/api/goo/update": (_body: unknown, call: { method: string }) =>
          call.method === "POST"
            ? new Response(JSON.stringify({ error: "not a fast-forward" }), { status: 409 })
            : { ok: true, checked: true, behind: 1, can_fast_forward: true },
      },
    });
    app.root.querySelector<HTMLButtonElement>(".nav-update")!.click();
    await app.settle();
    button(app.root, "Update & restart").click();
    await waitFor(app.settle, () => !!app.root.querySelector(".dialog-error"));
    expect(app.root.querySelector(".goo-updating")).toBeNull();
    expect(app.root.querySelector(".dialog-error")!.textContent).toContain("not a fast-forward");
  });
});
