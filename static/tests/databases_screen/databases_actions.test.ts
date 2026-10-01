import { afterEach, describe, expect, it } from "vitest";
import { mountApp, type MountedApp, type Route } from "../helpers/app.ts";
import { answer, byText, check, dialog, type } from "../helpers/screen_fixtures.ts";
import type { DatabaseInfo } from "../../src/core/database_plugin.ts";
import type { WorkspaceConfig } from "../../src/core/config.ts";

const db = (name: string, extra: Partial<DatabaseInfo> = {}): DatabaseInfo => ({
  name,
  odoo_version: "18.0",
  enterprise: false,
  demo_data: false,
  last_update: null,
  created: null,
  size: null,
  ...extra,
});

// the backend answers a failed action with an HTTP error carrying {ok: false, error}
const fail = (error: string) => () =>
  new Response(JSON.stringify({ ok: false, error }), { status: 500 });

let app: MountedApp;
afterEach(() => app?.destroy());

// a fake backend whose database list really changes with drop/clone/rename
function dbBackend(initial: DatabaseInfo[], overrides: Record<string, Route> = {}) {
  let list = [...initial];
  const routes: Record<string, Route> = {
    "/api/databases": () => ({ ok: true, databases: list }),
    "/api/databases/drop": (body: unknown) => {
      const { name } = body as { name: string };
      list = list.filter((d) => d.name !== name);
      return { ok: true };
    },
    "/api/databases/clone": (body: unknown) => {
      const { source, dest } = body as { source: string; dest: string };
      list = [...list, { ...list.find((d) => d.name === source)!, name: dest }];
      return { ok: true };
    },
    "/api/databases/rename": (body: unknown) => {
      const { name, new_name } = body as { name: string; new_name: string };
      list = list.map((d) => (d.name === name ? { ...d, name: new_name } : d));
      return { ok: true };
    },
    ...overrides,
  };
  return routes;
}

const rowNames = () =>
  [...app.root.querySelectorAll(".br-table tbody tr .br-branch")].map((s) => s.textContent);
const row = (name: string) =>
  [...app.root.querySelectorAll<HTMLElement>(".br-table tbody tr")].find(
    (tr) => tr.querySelector(".br-branch")?.textContent === name,
  )!;
// open a row's kebab menu → the action-menu buttons
async function openMenu(name: string): Promise<HTMLButtonElement[]> {
  row(name).querySelector<HTMLButtonElement>(".dash-kebab")!.click();
  await app.settle();
  return [...document.querySelectorAll<HTMLButtonElement>(".action-menu .dash-menu-item")];
}
async function menuAction(name: string, label: string): Promise<void> {
  const item = (await openMenu(name)).find((b) => b.textContent === label)!;
  item.click();
  await app.settle();
}

describe("Databases screen — states", () => {
  it("shows the backend's load error", async () => {
    app = await mountApp({
      section: "databases",
      routes: { "/api/databases": { ok: false, error: "psql: not found" } },
    });
    expect(app.root.textContent).toContain("Failed to load: psql: not found");
    expect(app.root.querySelector(".br-table")).toBeNull();
  });

  it("shows an empty state and a zero count", async () => {
    app = await mountApp({ section: "databases", routes: dbBackend([]) });
    expect(app.root.textContent).toContain("No databases.");
    expect(app.root.textContent).toContain("0 databases");
  });

  it("sorts by last activity, formats the columns and marks the active database", async () => {
    app = await mountApp({
      section: "databases",
      routes: {
        ...dbBackend([
          db("old", { last_update: "2020-01-01T00:00:00" }),
          db("live", {
            enterprise: true,
            demo_data: true,
            size: 3 * 1024 * 1024,
            last_update: "2026-01-01T00:00:00",
            created: "2025-12-01T00:00:00",
          }),
          db("plain", { odoo_version: null }),
        ]),
        "/api/status": { id: "main", state: "running", db: "live" },
      },
    });
    expect(rowNames()).toEqual(["live", "old", "plain"]);
    expect(app.root.textContent).toContain("3 databases");
    const live = row("live");
    expect(live.classList).toContain("active");
    expect(live.textContent).toContain("Active");
    expect(live.textContent).toContain("18.0 (ent)");
    expect(live.textContent).toContain("✓"); // demo data
    expect(live.textContent).toContain("3 MB");
    expect(live.querySelector("td[title='2025-12-01T00:00:00 (UTC)']")).not.toBeNull();
    // the active db can't be ticked for a batch drop; the others can
    expect(live.querySelector("input.br-select")).toBeNull();
    expect(row("old").querySelector("input.br-select")).not.toBeNull();
    expect(row("old").textContent).toContain("✕"); // no demo data
    expect(row("plain").textContent).toContain("—"); // not an odoo database
  });
});

describe("Databases screen — drop", () => {
  it("drops after confirmation, and does nothing when cancelled", async () => {
    app = await mountApp({
      section: "databases",
      routes: dbBackend([db("keep"), db("gone")]),
      config: { filestore: "/srv/filestore" },
    });
    await menuAction("gone", "Drop");
    expect(dialog()?.textContent).toContain('Drop "gone"?');
    await answer(app, false);
    expect(dialog()).toBeNull();
    expect(app.callsTo("/api/databases/drop")).toHaveLength(0);
    expect(rowNames()).toContain("gone");

    await menuAction("gone", "Drop");
    await answer(app, true);
    expect(app.callsTo("/api/databases/drop").map((c) => c.body)).toEqual([
      { name: "gone", filestore: "/srv/filestore" },
    ]);
    expect(rowNames()).toEqual(["keep"]);
  });

  it("reports a failed drop in a dialog and keeps the row", async () => {
    app = await mountApp({
      section: "databases",
      routes: dbBackend([db("busy")], {
        "/api/databases/drop": fail("database is being accessed by other users"),
      }),
    });
    await menuAction("busy", "Drop");
    await answer(app, true);
    expect(dialog()?.textContent).toContain("Drop failed");
    expect(dialog()?.textContent).toContain("database is being accessed by other users");
    await answer(app, true);
    expect(rowNames()).toEqual(["busy"]);
  });

  it("disables Rename and Drop on the active database, but allows Clone", async () => {
    app = await mountApp({
      section: "databases",
      routes: {
        ...dbBackend([db("live")]),
        "/api/status": { id: "main", state: "running", db: "live" },
      },
    });
    const items = await openMenu("live");
    const state = Object.fromEntries(items.map((b) => [b.textContent, b.disabled]));
    expect(state).toEqual({ Clone: false, Rename: true, Drop: true });
  });

  it("batch-drops the ticked databases after one confirmation", async () => {
    app = await mountApp({ section: "databases", routes: dbBackend([db("a"), db("b"), db("c")]) });
    expect(app.root.textContent).not.toContain("Drop 1");
    check(row("a").querySelector<HTMLInputElement>("input.br-select")!);
    await app.settle();
    // clicking a name cell toggles the selection too
    row("c").querySelector<HTMLElement>(".select-toggle")!.click();
    await app.settle();
    expect(row("a").classList).toContain("row-sel");
    const dropBtn = byText(app.root, "Drop 2");

    dropBtn.click();
    await app.settle();
    expect(dialog()?.textContent).toContain("Drop 2 databases?");
    await answer(app, false);
    expect(app.callsTo("/api/databases/drop")).toHaveLength(0);

    byText(app.root, "Drop 2").click();
    await app.settle();
    await answer(app, true);
    expect(
      app.callsTo("/api/databases/drop").map((c) => (c.body as { name: string }).name),
    ).toEqual(["a", "c"]);
    expect(rowNames()).toEqual(["b"]);
    expect(app.root.textContent).not.toContain("Drop 1"); // selection cleared
  });

  it("select-all ticks every non-active database, and toggles back off", async () => {
    app = await mountApp({
      section: "databases",
      routes: {
        ...dbBackend([db("live"), db("x"), db("y")]),
        "/api/status": { id: "main", state: "running", db: "live" },
      },
    });
    const all = app.root.querySelector<HTMLInputElement>("thead input.br-select")!;
    check(all);
    await app.settle();
    expect(byText(app.root, "Drop 2")).toBeTruthy(); // the active db isn't included
    expect(all.checked).toBe(true);
    check(all, false);
    await app.settle();
    expect(app.root.textContent).not.toContain("Drop 2");
  });

  it("warns about an external server using the database (external launch mode)", async () => {
    app = await mountApp({
      section: "databases",
      config: { launch_mode: "external" },
      routes: dbBackend([db("ext")], {
        "/api/workspace/external_status": { ok: true, running: true, url: "http://x" },
      }),
    });
    await menuAction("ext", "Drop");
    expect(app.callsTo("/api/workspace/external_status")[0].body).toEqual({ name: "ext" });
    expect(dialog()?.textContent).toContain(
      'An external server appears to be running against "ext"',
    );
    await answer(app, false);

    check(row("ext").querySelector<HTMLInputElement>("input.br-select")!);
    await app.settle();
    byText(app.root, "Drop 1").click();
    await app.settle();
    expect(dialog()?.textContent).toContain("Drop 1 database?");
    expect(dialog()?.textContent).toContain('against "ext"');
    await answer(app, false);
  });
});

describe("Databases screen — clone and rename", () => {
  it("clones under a validated new name", async () => {
    app = await mountApp({
      section: "databases",
      config: { filestore: "" },
      routes: dbBackend([db("src"), db("other")]),
    });
    await menuAction("src", "Clone");
    const input = dialog()!.querySelector<HTMLInputElement>("input[type=text]")!;
    expect(input.value).toBe("src-copy");
    const ok = dialog()!.querySelector<HTMLButtonElement>(".pbtn.primary")!;

    type(input, "other");
    await app.settle();
    expect(dialog()!.textContent).toContain('a database named "other" already exists');
    expect(ok.disabled).toBe(true);
    type(input, "-bad");
    await app.settle();
    expect(dialog()!.textContent).toContain("use letters, digits");
    type(input, "");
    await app.settle();
    expect(dialog()!.textContent).toContain("a name is required");

    type(input, " src-2 ");
    await app.settle();
    expect(ok.disabled).toBe(false);
    await answer(app, true);
    expect(app.callsTo("/api/databases/clone").map((c) => c.body)).toEqual([
      { source: "src", dest: "src-2", filestore: "" },
    ]);
    expect(rowNames()).toContain("src-2");
  });

  it("cancelling the clone dialog sends nothing", async () => {
    app = await mountApp({ section: "databases", routes: dbBackend([db("src")]) });
    await menuAction("src", "Clone");
    await answer(app, false);
    expect(app.callsTo("/api/databases/clone")).toHaveLength(0);
  });

  it("cloning the active database stops the server, clones, then restarts it", async () => {
    const ws = { id: "w1", name: "main ws", checkouts: [] } as unknown as WorkspaceConfig;
    app = await mountApp({
      section: "databases",
      config: { workspaces: [ws] },
      state: { active_workspace: "w1" },
      routes: {
        ...dbBackend([db("live")]),
        "/api/status": { id: "main", state: "running", db: "live", workspace: "w1" },
        "/api/stop": { ok: true, state: "stopped" },
        "/api/start": { ok: true, state: "starting", cmd: "odoo-bin -d live" },
      },
    });
    await menuAction("live", "Clone");
    expect(dialog()!.textContent).toContain("goo will stop the server to clone it");
    await answer(app, true);
    const order = app.calls
      .map((c) => c.path)
      .filter((p) => ["/api/stop", "/api/databases/clone", "/api/start"].includes(p));
    expect(order).toEqual(["/api/stop", "/api/databases/clone", "/api/start"]);
    expect(app.callsTo("/api/start")[0].body).toMatchObject({ workspace: "w1" });
  });

  it("reports a failed clone", async () => {
    app = await mountApp({
      section: "databases",
      routes: dbBackend([db("src")], {
        "/api/databases/clone": fail("disk full"),
      }),
    });
    await menuAction("src", "Clone");
    await answer(app, true);
    expect(dialog()?.textContent).toContain("Clone failed");
    expect(dialog()?.textContent).toContain("disk full");
  });

  it("renames, refusing the unchanged name", async () => {
    app = await mountApp({
      section: "databases",
      config: { filestore: "" },
      routes: dbBackend([db("old")]),
    });
    await menuAction("old", "Rename");
    const input = dialog()!.querySelector<HTMLInputElement>("input[type=text]")!;
    expect(input.value).toBe("old");
    type(input, "old");
    await app.settle();
    expect(dialog()!.textContent).toContain("choose a different name");
    type(input, "new");
    await app.settle();
    await answer(app, true);
    expect(app.callsTo("/api/databases/rename").map((c) => c.body)).toEqual([
      { name: "old", new_name: "new", filestore: "" },
    ]);
    expect(rowNames()).toEqual(["new"]);
  });

  it("cancelled rename sends nothing; a failed rename is reported", async () => {
    app = await mountApp({
      section: "databases",
      routes: dbBackend([db("old")], {
        "/api/databases/rename": fail("name taken"),
      }),
    });
    await menuAction("old", "Rename");
    await answer(app, false);
    expect(app.callsTo("/api/databases/rename")).toHaveLength(0);

    await menuAction("old", "Rename");
    type(dialog()!.querySelector<HTMLInputElement>("input[type=text]")!, "new");
    await app.settle();
    await answer(app, true);
    expect(dialog()?.textContent).toContain("Rename failed");
    expect(dialog()?.textContent).toContain("name taken");
  });
});
