// Removing a main-located workspace from the Workspaces screen, mounted in the whole
// app: the confirmation dialog's optional cleanup (branches, remote branches, open
// PRs, database) and the cascade over sub-workspaces spawned from it.
import { afterEach, describe, expect, it } from "vitest";
import { mountApp, type MountedApp, type Route } from "../helpers/app.ts";
import type { WorkspaceConfig } from "../../src/core/config.ts";
import {
  branch,
  checkboxIn,
  dialog,
  dialogButton,
  dialogTitle,
  featRepos,
  gitBackend,
  mustDialog,
  mustText,
  prWire,
  prsReply,
  setChecked,
  workspace,
  type FakeRepo,
} from "../helpers/code_fixtures.ts";
import type { PullRequestWire } from "../../src/core/models.ts";

let app: MountedApp;
afterEach(() => app?.destroy());

interface Setup {
  workspaces?: WorkspaceConfig[];
  repos?: Record<string, FakeRepo>;
  prs?: Record<string, PullRequestWire[]>;
  databases?: string[];
  state?: Record<string, unknown>;
  routes?: Record<string, Route>;
}

const ok = { ok: true };

async function mountScreen(s: Setup = {}) {
  const git = gitBackend(s.repos ?? featRepos());
  app = await mountApp({
    section: "workspaces",
    config: { targets: [], workspaces: s.workspaces ?? [workspace()] },
    state: s.state,
    routes: {
      "/api/code/branches": (body: unknown) => git.route(body),
      "/api/prs": prsReply(s.prs ?? {}),
      "/api/prs/for-branches": { prs: [] },
      "/api/databases": {
        ok: true,
        databases: (s.databases ?? ["master-feat"]).map((name) => ({ name, size: null })),
      },
      "/api/code/branches/delete": ok,
      "/api/prs/close": ok,
      "/api/databases/drop": ok,
      ...s.routes,
    },
  });
}

async function click(el: HTMLElement) {
  el.click();
  await app.settle();
}

const headMenu = () => app.root.querySelector<HTMLElement>(".wt-detail-name-row .dash-kebab-wrap")!;

async function openRemove() {
  await click(headMenu().querySelector<HTMLElement>(".dash-kebab")!);
  await click(mustText(headMenu(), "Remove workspace"));
}

const listNames = () => [...app.root.querySelectorAll(".wt-item-name")].map((e) => e.textContent);
const option = (label: string) => checkboxIn(mustDialog(), label);

describe("Remove workspace", () => {
  it("offers to clean up the workspace's branches, PRs and database", async () => {
    await mountScreen({
      prs: {
        community: [prWire()],
        enterprise: [prWire({ github: "odoo/enterprise", number: 202 })],
      },
    });
    await openRemove();
    expect(dialogTitle()).toBe('Delete "master-feat"?');
    expect(option("Also delete its 2 branches").checked).toBe(true);
    expect(option("…also on the push remote").checked).toBe(false);
    expect(option("Close its 2 open pull requests").checked).toBe(false);
    expect(option('Drop database "master-feat"').checked).toBe(true);
  });

  it("with the defaults, deletes the local branches and the database", async () => {
    await mountScreen();
    await openRemove();
    await click(dialogButton("Delete"));
    expect(app.callsTo("/api/code/branches/delete").map((c) => c.body)).toEqual([
      {
        path: "/home/odoo/work/community",
        branch: "master-feat",
        delete_remote: false,
        push_remote: "dev",
      },
      {
        path: "/home/odoo/work/enterprise",
        branch: "master-feat",
        delete_remote: false,
        push_remote: "dev",
      },
    ]);
    expect(
      app.callsTo("/api/databases/drop").map((c) => (c.body as { name: string }).name),
    ).toEqual(["master-feat"]);
    expect(app.callsTo("/api/prs/close")).toEqual([]);
    expect(listNames()).toEqual([]);
  });

  it("can also delete the remote branches and close the open PRs", async () => {
    await mountScreen({
      prs: {
        community: [prWire()],
        enterprise: [prWire({ github: "odoo/enterprise", number: 202, state: "closed" })],
      },
    });
    await openRemove();
    // only the open PR is offered
    setChecked(option("Close its open pull request"), true);
    setChecked(option("…also on the push remote"), true);
    setChecked(option('Drop database "master-feat"'), false);
    await app.settle();
    await click(dialogButton("Delete"));
    expect(app.callsTo("/api/prs/close").map((c) => c.body)).toEqual([
      { repo: "odoo/odoo", number: 101 },
    ]);
    expect(
      app
        .callsTo("/api/code/branches/delete")
        .map((c) => (c.body as { delete_remote: boolean }).delete_remote),
    ).toEqual([true, true]);
    expect(app.callsTo("/api/databases/drop")).toEqual([]);
  });

  it("cancelling keeps the workspace and touches nothing", async () => {
    await mountScreen();
    await openRemove();
    await click(dialogButton("Discard"));
    expect(dialog()).toBeNull();
    expect(listNames()).toEqual(["master-feat"]);
    expect(app.callsTo("/api/code/branches/delete")).toEqual([]);
    expect(app.callsTo("/api/databases/drop")).toEqual([]);
  });

  it("offers nothing to clean up for base branches and a database that was never created", async () => {
    await mountScreen({
      workspaces: [
        workspace({
          name: "master",
          db: "master",
          checkouts: [{ repo: "community", branch: "master" }],
        }),
      ],
      repos: {
        community: { current: "master-feat", branches: [branch("master"), branch("master-feat")] },
      },
      databases: [],
    });
    await openRemove();
    expect(mustDialog().querySelectorAll("input[type=checkbox]")).toHaveLength(0);
    await click(dialogButton("Delete"));
    expect(app.callsTo("/api/code/branches/delete")).toEqual([]);
    expect(listNames()).toEqual([]);
  });

  it("a branch that only exists locally offers no remote cleanup", async () => {
    await mountScreen({
      workspaces: [workspace({ checkouts: [{ repo: "community", branch: "master-feat" }] })],
      repos: featRepos({ branches: [branch("master-feat", { remote: false })] }),
    });
    await openRemove();
    expect(option("Also delete its branch").checked).toBe(true);
    expect(() => option("…also on the push remote")).toThrow();
  });

  it("removes the sub-workspaces spawned from it too", async () => {
    const child = workspace({
      id: "w2",
      name: "saas-19.1-feat-fw",
      db: "",
      parent: "w1",
      checkouts: [{ repo: "community", branch: "saas-19.1-feat-fw" }],
    });
    const grandchild = workspace({ ...child, id: "w3", name: "saas-19.2-feat-fw", parent: "w2" });
    await mountScreen({ workspaces: [workspace(), child, grandchild] });
    await openRemove();
    expect(mustDialog().textContent).toContain(
      "This also removes 2 sub-workspaces spawned from it.",
    );
    await click(dialogButton("Delete"));
    expect(listNames()).toEqual([]);
  });

  it("keeps a busy sub-workspace, unlinked, and says so", async () => {
    const child = workspace({
      id: "w2",
      name: "child-loaded",
      db: "",
      parent: "w1",
      checkouts: [{ repo: "community", branch: "master-feat" }],
    });
    // the child is the loaded workspace (the main checkout's last activation)
    await mountScreen({ workspaces: [workspace(), child], state: { active_workspace: "w2" } });
    await click(app.root.querySelectorAll<HTMLElement>(".wt-item")[0]);
    await openRemove();
    expect(mustDialog().textContent).toContain(
      "This also removes 1 sub-workspace spawned from it.",
    );
    await click(dialogButton("Delete"));
    expect(dialogTitle()).toBe("Some sub-workspaces were kept");
    expect(mustDialog().textContent).toContain('"child-loaded" is still busy');
    await click(dialogButton("OK"));
    expect(listNames()).toEqual(["child-loaded"]);
  });

  it("the loaded workspace can't be removed", async () => {
    await mountScreen({ state: { active_workspace: "w1" } });
    await click(headMenu().querySelector<HTMLElement>(".dash-kebab")!);
    const remove = mustText(headMenu(), "Remove workspace");
    expect(remove.disabled).toBe(true);
    expect(remove.title).toBe("the loaded workspace cannot be removed");
  });
});
