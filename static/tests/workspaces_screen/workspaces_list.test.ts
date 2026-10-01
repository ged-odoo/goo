// The Workspaces screen's list: empty state, search, ordering, category groups
// (incl. the always-last archived group), parent nesting, selection, and the
// per-row CI / mergebot / PR pills + their hover breakdowns.
import { afterEach, describe, expect, it } from "vitest";
import { mountApp, type MountedApp, type MountAppOptions } from "../helpers/app.ts";
import {
  branch as branchOf,
  branchesRoute,
  mergebotRoute,
  runbotRoute,
  mustText,
  repo,
  texts,
  ws,
} from "../helpers/workspaces_fixtures.ts";
import type { WorkspaceConfig } from "../../src/core/config.ts";

let app: MountedApp;
afterEach(() => app?.destroy());

const REPOS = [
  repo("community", "master", ["master", "master-alpha", "master-beta", "master-gamma"]),
  repo("enterprise", "master", ["master"]),
];

function mount(workspaces: WorkspaceConfig[], opts: MountAppOptions = {}) {
  return mountApp({
    section: "workspaces",
    ...opts,
    config: { targets: [], workspaces, ...opts.config },
    routes: {
      "/api/code/branches": branchesRoute(REPOS),
      "/api/prs": { repos: [] },
      "/api/runbot": { states: {} },
      "/api/mergebot": { states: {} },
      "/api/databases": { ok: true, databases: [] },
      ...opts.routes,
    },
  });
}

const names = () => texts(app.root, ".wt-item .wt-item-name");
const selectedName = () => app.root.querySelector(".wt-item.selected .wt-item-name")?.textContent;
const detailName = () => app.root.querySelector(".wt-detail-name")?.textContent;

describe("Workspaces list — empty", () => {
  it("offers to adopt the current checkout or create one when there are no workspaces", async () => {
    app = await mount([]);
    const empty = app.root.querySelector(".wt-empty")!;
    expect(empty.textContent).toContain("No workspaces yet.");
    expect(texts(empty, "button")).toEqual(["Adopt current checkout", "New workspace…"]);
    expect(app.root.querySelector(".wt-detail-empty")?.textContent).toContain(
      "Select a workspace on the left",
    );
  });
});

describe("Workspaces list — search & order", () => {
  const LIST = [
    ws({
      id: "b",
      name: "beta",
      created_at: "2026-09-03T10:00:00Z",
      last_activity: "2026-09-03T10:00:00Z",
    }),
    ws({
      id: "a",
      name: "alpha",
      db: "alpha-db",
      created_at: "2026-09-01T10:00:00Z",
      last_activity: "2026-09-29T10:00:00Z",
    }),
    ws({
      id: "g",
      name: "gamma",
      created_at: "2026-09-02T10:00:00Z",
      last_activity: "2026-09-02T10:00:00Z",
    }),
  ];

  it("lists in configured order, selects the first, and filters by name / branch / db", async () => {
    app = await mount(LIST);
    expect(names()).toEqual(["beta", "alpha", "gamma"]);
    expect(selectedName()).toBe("beta");
    expect(detailName()).toBe("beta");

    const input = app.root.querySelector<HTMLInputElement>(".search-box input")!;
    input.value = "alpha-db";
    input.dispatchEvent(new Event("input"));
    await app.settle();
    expect(names()).toEqual(["alpha"]);

    input.value = "master-g"; // a branch name
    input.dispatchEvent(new Event("input"));
    await app.settle();
    expect(names()).toEqual(["gamma"]);

    input.value = "nothing-like-it";
    input.dispatchEvent(new Event("input"));
    await app.settle();
    expect(names()).toEqual([]);
    expect(app.root.querySelector(".wt-empty")?.textContent?.trim()).toBe("No workspace matches.");
  });

  it("re-orders from the order menu, selects the new first, and remembers the choice", async () => {
    app = await mount(LIST);
    const pick = async (label: string) => {
      app.root.querySelector<HTMLButtonElement>(".wt-order")!.click();
      await app.settle();
      mustText(app.root, ".wt-order-menu .dash-menu-item", label).click();
      await app.settle();
    };
    await pick("Name (A–Z)");
    expect(names()).toEqual(["alpha", "beta", "gamma"]);
    expect(selectedName()).toBe("alpha");
    expect(app.root.querySelector(".wt-order")?.getAttribute("title")).toBe(
      "order workspaces: Name",
    );
    expect(app.root.querySelector(".wt-order-menu")).toBeNull(); // closed on pick

    await pick("Creation date (newest)");
    expect(names()).toEqual(["beta", "gamma", "alpha"]);

    await pick("Most recent activity");
    expect(names()).toEqual(["alpha", "beta", "gamma"]);
    expect(localStorage.getItem("goo-workspace-order")).toBe("recent");

    // a remount starts on the remembered order
    app.destroy();
    localStorage.setItem("goo-workspace-order", "name");
    app = await mount(LIST);
    expect(names()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("falls back to the configured order on an unknown stored order", async () => {
    localStorage.setItem("goo-workspace-order", "bogus");
    app = await mount(LIST);
    expect(names()).toEqual(["beta", "alpha", "gamma"]);
  });

  it("an outside click closes the order menu", async () => {
    app = await mount(LIST);
    app.root.querySelector<HTMLButtonElement>(".wt-order")!.click();
    await app.settle();
    expect(app.root.querySelector(".wt-order-menu")).not.toBeNull();
    document.body.click();
    await app.settle();
    expect(app.root.querySelector(".wt-order-menu")).toBeNull();
  });

  it("orders by mergebot state, blocked first, PR-less last", async () => {
    const pr = (n: number, b: string) => ({
      number: n,
      branch: b,
      state: "open",
      github: "odoo/odoo",
    });
    app = await mount(LIST, {
      routes: {
        "/api/prs": {
          repos: [
            {
              id: "community",
              github: "odoo/odoo",
              prs: [pr(1, "master-a"), pr(2, "master-g")],
            },
          ],
        },
        "/api/mergebot": mergebotRoute({ "odoo/odoo#1": "ready", "odoo/odoo#2": "blocked" }),
      },
    });
    app.root.querySelector<HTMLButtonElement>(".wt-order")!.click();
    await app.settle();
    mustText(app.root, ".wt-order-menu .dash-menu-item", "Mergebot (blocked first)").click();
    await app.settle();
    expect(names()).toEqual(["gamma", "alpha", "beta"]);
  });
});

describe("Workspaces list — groups, nesting, selection", () => {
  it("groups by category in config order, uncategorized then archived last; collapsing persists", async () => {
    app = await mount(
      [
        ws({ id: "u", name: "loose" }),
        ws({ id: "x", name: "old", category: "archived" }),
        ws({ id: "d", name: "devwork", category: "dev" }),
        ws({ id: "gone", name: "stale-cat", category: "removed-cat" }),
      ],
      { config: { workspace_categories_enabled: true } },
    );
    expect(texts(app.root, ".wt-group-head .wt-group-name")).toEqual([
      "dev",
      "uncategorized",
      "archived",
    ]); // "base" is empty → no header
    expect(texts(app.root, ".wt-group-head .wt-group-count")).toEqual(["1", "2", "1"]);

    const head = mustText(app.root, ".wt-group-head", "uncategorized2");
    expect(head.title).toBe("collapse uncategorized");
    head.click();
    await app.settle();
    expect(names()).toEqual(["devwork", "old"]);
    expect(JSON.parse(localStorage.getItem("goo-workspace-collapsed-categories")!)).toEqual([
      "\0none",
    ]);
    expect(mustText(app.root, ".wt-group-head", "uncategorized2").title).toBe(
      "expand uncategorized",
    );

    // the collapse survives a remount; a second click expands again
    app.destroy();
    app = await mount(
      [ws({ id: "u", name: "loose" }), ws({ id: "d", name: "devwork", category: "dev" })],
      { config: { workspace_categories_enabled: true } },
    );
    expect(names()).toEqual(["devwork"]);
    mustText(app.root, ".wt-group-head", "uncategorized1").click();
    await app.settle();
    expect(names()).toEqual(["devwork", "loose"]);
  });

  it("still splits off the archived group when categories are disabled", async () => {
    app = await mount([
      ws({ id: "x", name: "old", category: "archived" }),
      ws({ id: "d", name: "devwork", category: "dev" }),
    ]);
    expect(texts(app.root, ".wt-group-head .wt-group-name")).toEqual(["archived"]);
    expect(names()).toEqual(["devwork", "old"]);
  });

  it("nests a sub-workspace right under its parent, indented", async () => {
    app = await mount([
      ws({ id: "p", name: "parent" }),
      ws({ id: "o", name: "other" }),
      ws({ id: "c", name: "child", parent: "p" }),
    ]);
    expect(names()).toEqual(["parent", "child", "other"]);
    const child = [...app.root.querySelectorAll<HTMLElement>(".wt-item")][1];
    expect(child.getAttribute("style")).toContain("margin-left: 26px");
  });

  it("clicking a row selects it; the selection is resumed on the next visit", async () => {
    const list = [ws({ id: "a", name: "alpha" }), ws({ id: "b", name: "beta" })];
    app = await mount(list);
    expect(selectedName()).toBe("alpha");
    [...app.root.querySelectorAll<HTMLButtonElement>(".wt-item")][1].click();
    await app.settle();
    expect(selectedName()).toBe("beta");
    expect(detailName()).toBe("beta");

    app.destroy();
    app = await mount(list);
    expect(selectedName()).toBe("beta");
  });
});

describe("Workspaces list — status pills", () => {
  const check = (context: string, state: string) => ({
    context,
    state,
    url: `https://runbot.example/${context}`,
  });

  it("shows CI / mergebot / PR / no-PR pills from the loaded PRs, mergebot and runbot", async () => {
    app = await mount(
      [
        ws({ id: "alpha", name: "alpha" }),
        ws({ id: "beta", name: "beta" }),
        ws({ id: "gamma", name: "gamma" }),
        ws({ id: "delta", name: "delta", checkouts: [{ repo: "community", branch: "master" }] }),
      ],
      {
        routes: {
          "/api/code/branches": branchesRoute([
            repo("community", "master", ["master", "master-alpha", "master-beta", "master-gamma"]),
            repo("enterprise", "master", ["master"]),
          ]),
          "/api/prs": {
            repos: [
              {
                id: "community",
                github: "odoo/odoo",
                prs: [
                  {
                    number: 11,
                    branch: "master-alpha",
                    state: "open",
                    ci: {
                      overall: "failure",
                      runbot: "failure",
                      checks: [
                        check("ci/runbot", "failure"),
                        check("ci/style", "failure"),
                        check("ci/legal", "success"),
                      ],
                    },
                  },
                  { number: 12, branch: "master-beta", state: "open" },
                ],
              },
            ],
          },
          "/api/mergebot": mergebotRoute({ "odoo/odoo#11": "blocked" }),
          "/api/runbot": runbotRoute({
            master: { result: "success", running: false, url: "https://rb/master" },
          }),
        },
      },
    );
    const pills = (name: string) => {
      const item = [...app.root.querySelectorAll(".wt-item")].find(
        (el) => el.querySelector(".wt-item-name")?.textContent === name,
      )!;
      return [...item.querySelectorAll(".wt-pill")].map((p) => `${p.className}:${p.textContent}`);
    };
    expect(pills("alpha")).toEqual(["wt-pill fail:✗CI 2", "wt-pill blocked:✗merge"]);
    expect(pills("beta")).toEqual(["wt-pill none:#12"]);
    expect(pills("gamma")).toEqual(["wt-pill none:no PR"]);
    // delta sits on the base branch only: the scraped runbot bundle drives its pill
    expect(pills("delta")).toEqual(["wt-pill pass:✓CI"]);
  });
});

describe("Workspaces detail header — CI / mergebot badges", () => {
  const check = (context: string, state: string) => ({
    context,
    state,
    url: `https://runbot.example/${context}`,
  });
  // a two-repo workspace with a PR in each repo
  const PRS = {
    repos: [
      {
        id: "community",
        github: "odoo/odoo",
        prs: [
          {
            number: 21,
            branch: "master-alpha",
            state: "open",
            ci: {
              overall: "pending",
              runbot: "pending",
              checks: [check("ci/runbot", "pending")],
            },
          },
        ],
      },
      {
        id: "enterprise",
        github: "odoo/enterprise",
        prs: [
          {
            number: 31,
            branch: "master-alpha",
            state: "open",
            ci: { overall: "success", runbot: "success", checks: [check("ci/runbot", "success")] },
          },
        ],
      },
    ],
  };
  const ALPHA = ws({
    id: "alpha",
    checkouts: [
      { repo: "community", branch: "master-alpha" },
      { repo: "enterprise", branch: "master-alpha" },
    ],
  });
  const BRANCHES = branchesRoute([
    repo("community", "master", ["master", "master-alpha"]),
    repo("enterprise", "master", ["master", "master-alpha"]),
  ]);

  it("rolls CI up over every PR (worst wins) and lists each repo's checks on hover", async () => {
    app = await mount([ALPHA], {
      routes: {
        "/api/code/branches": BRANCHES,
        "/api/prs": PRS,
        "/api/mergebot": mergebotRoute(
          { "odoo/odoo#21": "ready", "odoo/enterprise#31": "blocked" },
          { "odoo/enterprise#31": "Review" },
        ),
      },
    });
    const ci = app.root.querySelector<HTMLAnchorElement>(".wt-detail a.dash-ci:not(.dash-mb)")!;
    expect(ci.className).toContain("run");
    expect(ci.textContent).toContain("running");
    // the runbot link comes from the PR's ci/runbot check
    expect(ci.getAttribute("href")).toBe("https://runbot.example/ci/runbot");
    ci.dispatchEvent(new MouseEvent("mouseenter"));
    await app.settle();
    const menu = document.querySelector(".ci-menu:not(.hidden)")!;
    expect(texts(menu, ".ci-menu-ctx")).toEqual(["community: ci/runbot", "enterprise: ci/runbot"]);
    expect(texts(menu, ".ci-menu-state")).toEqual(["running", "ok"]);

    // the mergebot badge reads the most blocking state; hover breaks it down per repo
    const mb = app.root.querySelector<HTMLAnchorElement>(".wt-detail .dash-mb")!;
    expect(mb.className).toContain("blocked");
    expect(mb.textContent).toBe("blocked");
    mb.dispatchEvent(new MouseEvent("mouseenter"));
    await app.settle();
    const mbMenu = document.querySelector(".mb-menu:not(.hidden)")!;
    expect(texts(mbMenu, ".ci-menu-ctx")).toEqual(["community", "enterprise"]);

    // the list pills agree
    expect(texts(app.root, ".wt-item .wt-pill")).toEqual(["CI", "✗merge"]);
  });

  it("a merged PR's lingering pending check doesn't count as running", async () => {
    const merged = structuredClone(PRS);
    merged.repos[0].prs[0].state = "closed";
    app = await mount([ALPHA], {
      routes: {
        "/api/code/branches": BRANCHES,
        "/api/prs": merged,
        "/api/mergebot": mergebotRoute({ "odoo/odoo#21": "merged" }),
      },
    });
    const ci = app.root.querySelector(".wt-detail .dash-ci:not(.dash-mb)")!;
    expect(ci.className).toContain("pass");
    expect(ci.querySelector(".dash-ci-run")).toBeNull();
  });

  it("the list's refresh button re-scrapes runbot + mergebot, bypassing their caches", async () => {
    app = await mount([ALPHA], {
      routes: {
        "/api/code/branches": branchesRoute([
          repo("community", "master", [
            "master",
            { ...branchOf("master-alpha"), synced: true, remote: true },
          ]),
          repo("enterprise", "master", ["master", "master-alpha"]),
        ]),
        "/api/prs": {
          repos: [
            {
              id: "community",
              github: "odoo/odoo",
              prs: [{ number: 21, branch: "master-alpha", state: "open" }],
            },
          ],
        },
        "/api/mergebot": mergebotRoute({ "odoo/odoo#21": "staged" }),
        "/api/runbot": runbotRoute({
          "master-alpha": { result: "", running: true, url: "https://rb/alpha" },
        }),
      },
    });
    const ci = app.root.querySelector<HTMLAnchorElement>(".wt-detail a.dash-ci:not(.dash-mb)")!;
    expect(ci.textContent).toContain("running");
    expect(ci.getAttribute("href")).toBe("https://rb/alpha");
    expect(app.callsTo("/api/runbot").at(-1)?.body).toMatchObject({ refresh: false });

    app.root.querySelector<HTMLButtonElement>(".wt-new")!.click();
    await app.settle();
    expect(app.callsTo("/api/runbot").at(-1)?.body).toEqual({
      branches: ["master-alpha"],
      refresh: true,
    });
    expect(app.callsTo("/api/mergebot").at(-1)?.body).toEqual({
      prs: [{ github: "odoo/odoo", number: 21 }],
      refresh: true,
    });
    expect(app.root.querySelector<HTMLButtonElement>(".wt-new")!.disabled).toBe(false);
  });
});
