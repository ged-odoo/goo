import { afterEach, describe, expect, it, vi } from "vitest";
import { mountApp, type MountedApp, type Route } from "../helpers/app.ts";
import { answer, byText, check, dialog, type, until } from "../helpers/screen_fixtures.ts";
import type { DatabaseInfo, RunbotDump } from "../../src/core/database_plugin.ts";

const db = (name: string): DatabaseInfo => ({
  name,
  odoo_version: "18.0",
  enterprise: false,
  demo_data: false,
  last_update: null,
  created: null,
  size: null,
});

const dump = (slot: string, dbName: string, build: string): RunbotDump => ({
  build,
  slot,
  db: dbName,
  url: `https://runbot9.odoo.com/runbot/static/build/${build}-x/logs/${build}-x-${dbName}.zip`,
  size: 1 << 20,
});

// each bundle's dumps, as /api/runbot/dumps answers them
const DUMPS: Record<string, RunbotDump[]> = {
  master: [
    dump("Community Run", "all", "11"),
    dump("Community Run", "base", "11"),
    dump("Enterprise Run", "all", "12"),
    dump("Enterprise Run", "base", "12"),
  ],
  "19.0": [dump("Enterprise Run", "all", "21")],
  "17.0-fix-thing": [dump("Community Run", "base", "31")],
};

let app: MountedApp;
afterEach(() => app?.destroy());

// a backend whose database list really grows with each restore
function importBackend(overrides: Record<string, Route> = {}) {
  let list = [db("existing")];
  const added = (name: string) => {
    list = [...list, db(name)];
    return { ok: true, error: null };
  };
  return {
    "/api/databases": () => ({ ok: true, databases: list }),
    "/api/runbot/sticky": { ok: true, versions: ["master", "19.0"] },
    "/api/runbot/dumps": (body: unknown) => ({
      ok: true,
      dumps: DUMPS[(body as { branch: string }).branch] || [],
    }),
    "/api/runbot/search": { ok: true, bundles: ["17.0-fix-thing", "18.0-fix-thing"] },
    "/api/databases/restore-dump": (body: unknown) => added((body as { name: string }).name),
    "/api/databases/upload-dump": (_body: unknown, call: { url: string }) =>
      added(new URL(call.url, "http://x").searchParams.get("name")!),
    ...overrides,
  };
}

const rowNames = () =>
  [...app.root.querySelectorAll(".br-table tbody tr .br-branch")].map((s) => s.textContent);
const field = <T extends HTMLElement>(cls: string) => dialog()!.querySelector<T>(cls)!;
const select = async (cls: string, value: string) => {
  const el = field<HTMLSelectElement>(cls);
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  await app.settle();
};

async function openImport(routes = importBackend()): Promise<void> {
  app = await mountApp({ section: "databases", routes, config: { filestore: "/fs" } });
  byText(app.root, "Import database").click();
  await app.settle();
}

describe("Databases screen — Import database", () => {
  it("restores the newest Enterprise full dump of the first starred version by default", async () => {
    await openImport();
    expect(field<HTMLSelectElement>(".imp-version").value).toBe("master");
    expect(field(".imp-dump").textContent).toContain("Enterprise Run — all");
    expect(field<HTMLInputElement>(".imp-name").value).toBe("master-ent-all");
    // every cleanup step is ticked by default
    const checks = [...dialog()!.querySelectorAll<HTMLInputElement>(".edit-check input")];
    expect(checks.map((c) => c.checked)).toEqual([true, true, true]);

    await answer(app, true);
    expect(app.callsTo("/api/databases/restore-dump").map((c) => c.body)).toEqual([
      {
        name: "master-ent-all",
        url: DUMPS.master[2].url,
        filestore: "/fs",
        cleanup: ["crons", "assets", "admin"],
      },
    ]);
    expect(rowNames()).toContain("master-ent-all");
  });

  it("follows the version, edition and data choices, and drops unticked cleanups", async () => {
    await openImport();
    await select(".imp-edition", "community");
    await select(".imp-data", "base");
    expect(field<HTMLInputElement>(".imp-name").value).toBe("master-com-base");
    check(
      byText<HTMLLabelElement>(dialog()!, "admin/admin", "label").querySelector("input")!,
      false,
    );
    await app.settle();

    await answer(app, true);
    const [call] = app.callsTo("/api/databases/restore-dump");
    expect(call.body).toMatchObject({ url: DUMPS.master[1].url, cleanup: ["crons", "assets"] });
  });

  it("says so and refuses to import when the bundle has no such dump", async () => {
    await openImport();
    await select(".imp-version", "19.0");
    await select(".imp-edition", "community");
    expect(field(".imp-dump").textContent).toContain("no community all dump");
    expect(field<HTMLButtonElement>(".dialog-foot .pbtn.primary").disabled).toBe(true);
  });

  it("finds another bundle through runbot's search", async () => {
    await openImport();
    await select(".imp-version", "__other__");
    const input = field<HTMLInputElement>(".imp-bundle");
    type(input, "fix-thing", false);
    await until(app, () => dialog()!.querySelectorAll("#imp-bundles option").length === 2);
    expect(app.callsTo("/api/runbot/search").map((c) => c.body)).toEqual([{ query: "fix-thing" }]);

    type(input, "17.0-fix-thing");
    await app.settle();
    await select(".imp-edition", "community");
    await select(".imp-data", "base");
    await answer(app, true);
    expect(app.callsTo("/api/databases/restore-dump")[0].body).toMatchObject({
      name: "17.0-fix-thing-com-base",
      url: DUMPS["17.0-fix-thing"][0].url,
    });
  });

  it("says why when runbot's versions can't be loaded, and still offers a bundle search", async () => {
    await openImport(
      importBackend({
        "/api/runbot/sticky": new Response(JSON.stringify({ ok: false, error: "not_found" }), {
          status: 404,
        }),
      }),
    );
    expect(field(".imp-versions-error").textContent).toBe(
      "could not load runbot's versions: not_found",
    );
    expect(field<HTMLSelectElement>(".imp-version").value).toBe("__other__");
    expect(field(".imp-bundle")).not.toBeNull();
  });

  it("keeps the typed bundle name while the search results arrive", async () => {
    await openImport();
    await select(".imp-version", "__other__");
    type(field<HTMLInputElement>(".imp-bundle"), "fix-thing", false);
    await until(app, () => dialog()!.querySelectorAll("#imp-bundles option").length === 2);
    expect(field<HTMLInputElement>(".imp-bundle").value).toBe("fix-thing");
  });

  it("shows the picked version again after switching the source back", async () => {
    await openImport();
    await select(".imp-version", "19.0");
    await select(".imp-source", "file");
    await select(".imp-source", "runbot");
    expect(field<HTMLSelectElement>(".imp-version").value).toBe("19.0");
    expect(field<HTMLSelectElement>(".imp-edition").value).toBe("enterprise");
  });

  it("waits for the dumps without showing an error", async () => {
    app = await mountApp({ section: "databases", routes: importBackend() });
    // hold the dumps reply until the test releases it
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const backend = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/runbot/dumps") await held;
      return backend(input, init);
    });
    byText(app.root, "Import database").click();
    await app.settle();
    expect(field(".imp-dump").textContent).toContain("looking up");
    expect(dialog()!.querySelector(".form-error")).toBeNull();
    expect(field<HTMLButtonElement>(".dialog-foot .pbtn.primary").disabled).toBe(true);
    release();
    await until(app, () => !field<HTMLButtonElement>(".dialog-foot .pbtn.primary").disabled);
    expect(field(".imp-dump").textContent).toContain("Enterprise Run — all");
  });

  it("refuses a file that is neither .zip nor .sql.gz", async () => {
    await openImport();
    await select(".imp-source", "file");
    const input = field<HTMLInputElement>(".imp-file");
    Object.defineProperty(input, "files", { value: [new File(["x"], "files.tar.gz")] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await app.settle();
    expect(dialog()!.querySelector(".form-error")!.textContent).toContain(".zip and .sql.gz");
  });

  it("sends nothing when discarded", async () => {
    await openImport();
    await answer(app, false);
    expect(dialog()).toBeNull();
    expect(app.callsTo("/api/databases/restore-dump")).toEqual([]);
  });

  it("refuses a name that already exists", async () => {
    await openImport();
    type(field<HTMLInputElement>(".imp-name"), "existing");
    await app.settle();
    expect(dialog()!.querySelector(".form-error")!.textContent).toContain("already exists");
    expect(field<HTMLButtonElement>(".dialog-foot .pbtn.primary").disabled).toBe(true);
  });

  it("uploads a local dump file into a database named after it", async () => {
    await openImport();
    await select(".imp-source", "file");
    const input = field<HTMLInputElement>(".imp-file");
    const file = new File(["dump bytes"], "prod_2026.sql.gz");
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await app.settle();
    expect(field<HTMLInputElement>(".imp-name").value).toBe("prod_2026");

    await answer(app, true);
    const [call] = app.callsTo("/api/databases/upload-dump");
    const query = new URL(call.url, "http://x").searchParams;
    expect(Object.fromEntries(query)).toEqual({
      name: "prod_2026",
      filename: "prod_2026.sql.gz",
      filestore: "/fs",
      cleanup: "crons,assets,admin",
    });
    expect(rowNames()).toContain("prod_2026");
  });

  it("shows the backend's error when an upload fails", async () => {
    await openImport(
      importBackend({
        "/api/databases/upload-dump": new Response(
          JSON.stringify({ ok: false, error: "could not unpack the dump: bad zip" }),
          { status: 400 },
        ),
      }),
    );
    await select(".imp-source", "file");
    const input = field<HTMLInputElement>(".imp-file");
    Object.defineProperty(input, "files", { value: [new File(["x"], "prod.zip")] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await app.settle();
    await answer(app, true);
    expect(dialog()!.textContent).toContain("Import failed");
    expect(dialog()!.textContent).toContain("bad zip");
    expect(rowNames()).not.toContain("prod");
  });

  it("shows the backend's error when the restore fails", async () => {
    await openImport(
      importBackend({
        "/api/databases/restore-dump": new Response(
          JSON.stringify({ ok: false, error: "psql restore failed" }),
          { status: 400 },
        ),
      }),
    );
    await answer(app, true);
    expect(dialog()!.textContent).toContain("Import failed");
    expect(dialog()!.textContent).toContain("psql restore failed");
  });
});
