import { afterEach, describe, expect, it } from "vitest";
import { mountApp, type MountedApp } from "../helpers/app.ts";

const DBS = {
  ok: true,
  databases: [
    {
      name: "master-feat",
      odoo_version: "18.0",
      enterprise: true,
      demo_data: false,
      last_update: null,
      created: null,
      size: 50 * 1024 * 1024,
    },
    {
      name: "scratch",
      odoo_version: null,
      enterprise: false,
      demo_data: false,
      last_update: null,
      created: null,
      size: null,
    },
  ],
};

let app: MountedApp;
afterEach(() => app?.destroy());

describe("Databases screen", () => {
  it("lists the backend's databases", async () => {
    app = await mountApp({ section: "databases", routes: { "/api/databases": DBS } });
    expect(app.root.querySelector("h1")?.textContent).toBe("Databases");
    const names = [...app.root.querySelectorAll(".br-table tbody tr")].map((tr) => tr.textContent);
    expect(names.join("|")).toContain("master-feat");
    expect(names.join("|")).toContain("scratch");
  });
});

describe("Databases screen — refresh", () => {
  it("Refresh re-queries the backend bypassing its cache and shows the new list", async () => {
    let list = DBS.databases;
    app = await mountApp({
      section: "databases",
      routes: { "/api/databases": () => ({ ok: true, databases: list }) },
    });
    list = [...DBS.databases, { ...DBS.databases[1], name: "fresh-db" }];
    const refresh = [...app.root.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes("Refresh"),
    )!;
    refresh.click();
    await app.settle();
    expect(app.calls.some((c) => c.url === "/api/databases?refresh=1")).toBe(true);
    expect(app.root.textContent).toContain("fresh-db");
  });
});
