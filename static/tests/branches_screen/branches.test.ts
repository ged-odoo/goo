import { afterEach, describe, expect, it, vi } from "vitest";
import { mountApp, type MountedApp, type Route } from "../helpers/app.ts";

const DAY = 24 * 3600 * 1000;
const iso = (daysAgo: number): string => new Date(Date.now() - daysAgo * DAY).toISOString();

const branch = (name: string, daysAgo: number, extra: Record<string, unknown> = {}) => ({
  name,
  date: iso(daysAgo),
  subject: `[IMP] ${name}`,
  sha: "abc",
  remote: true,
  synced: true,
  ...extra,
});

// community: master (checked out, base) + feat-a (pushed, open PR) + local-only (not pushed)
// enterprise: feat-a (pushed, no PR) + stale (pushed, merged PR)
const BRANCHES = {
  repos: [
    {
      id: "community",
      current: "master",
      dirty: false,
      branches: [
        branch("master", 0),
        branch("feat-a", 1),
        branch("local-only", 2, { remote: false }),
      ],
    },
    {
      id: "enterprise",
      current: "master",
      dirty: true,
      branches: [branch("feat-a", 1), branch("stale", 30)],
    },
  ],
};

const pr = (github: string, number: number, branchName: string, extra = {}) => ({
  github,
  number,
  title: `PR ${branchName}`,
  url: `https://github.com/${github}/pull/${number}`,
  state: "OPEN",
  draft: false,
  branch: branchName,
  relation: "authored",
  created_at: iso(3),
  updated_at: iso(1),
  ...extra,
});

const PRS = {
  repos: [
    {
      id: "community",
      github: "odoo/odoo",
      prs: [
        pr("odoo/odoo", 101, "feat-a"),
        // an authored PR whose branch exists nowhere locally → a PR-only row
        pr("odoo/odoo", 202, "remote-only", { draft: true }),
      ],
    },
    {
      id: "enterprise",
      github: "odoo/enterprise",
      prs: [pr("odoo/enterprise", 303, "stale", { state: "MERGED" })],
    },
  ],
};

const MERGEBOT = {
  states: { "odoo/odoo#101": "blocked", "odoo/odoo#202": "error" },
  details: { "odoo/odoo#101": "Review, CI" },
  forward_ports: {},
};

const ROUTES: Record<string, Route> = {
  "/api/code/branches": BRANCHES,
  "/api/prs": PRS,
  "/api/mergebot": MERGEBOT,
  "/api/prs/for-branches": { prs: [] },
  "/api/runbot": { states: {} },
};

let app: MountedApp;
afterEach(() => app?.destroy());

const mount = (routes: Record<string, Route> = {}, config = {}) =>
  mountApp({
    section: "branches",
    // the running server occupies workspace w3 (a cascaded delete must keep it)
    routes: {
      "/api/status": { id: "main", state: "running", workspace: "w3" },
      ...ROUTES,
      ...routes,
    },
    config,
  });

const groupNames = (): string[] =>
  [...app.root.querySelectorAll(".rl-group-head .br-branch")].map((e) => e.textContent ?? "");

const groupRows = (name: string): HTMLElement[] => {
  const head = [...app.root.querySelectorAll(".rl-group-head")].find(
    (h) => h.querySelector(".br-branch")?.textContent === name,
  )!;
  return [...head.closest("tbody")!.querySelectorAll<HTMLElement>("tr.rl-row")];
};

const buttons = (root: ParentNode, label: string): HTMLButtonElement[] =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].filter((b) =>
    b.textContent?.trim().startsWith(label),
  );

const dialog = (): HTMLElement | null => document.querySelector(".dialog");

async function clickDialog(label: string): Promise<void> {
  buttons(dialog()!, label)[0].click();
  await app.settle();
}

async function setSelect(sel: HTMLSelectElement, value: string): Promise<void> {
  sel.value = value;
  sel.dispatchEvent(new Event("change"));
  await app.settle();
}

async function openMenu(group: string, repo: string): Promise<HTMLElement> {
  const row = groupRows(group).find((r) => r.querySelector(".brg-repo")?.textContent === repo)!;
  row.querySelector<HTMLButtonElement>(".dash-kebab")!.click();
  await app.settle();
  return document.querySelector<HTMLElement>(".action-menu")!;
}

const menuItems = (menu: HTMLElement): string[] =>
  [...menu.querySelectorAll(".dash-menu-item")].map((b) => b.textContent ?? "");

describe("Branches & PRs screen — listing", () => {
  it("groups local branches and PR-only rows by branch name, newest first", async () => {
    app = await mount();
    expect(app.root.querySelector("h1")?.textContent).toContain("Branches & PRs");
    // default filter hides fully merged groups ("stale" only has a merged PR); groups
    // sort by their rows' summed update times, so the two-repo feat-a leads
    expect(groupNames()).toEqual(["feat-a", "master", "local-only", "remote-only"]);
    expect(app.root.textContent).toContain("4 branches · 2 PRs");

    // feat-a: community (with its PR) then enterprise — config repo order
    const featA = groupRows("feat-a");
    expect(featA.map((r) => r.querySelector(".brg-repo")?.textContent)).toEqual([
      "community",
      "enterprise",
    ]);
    // pushed branch → GitHub link
    expect(featA[0].querySelector<HTMLAnchorElement>(".br-repo-link")?.href).toContain(
      "github.com",
    );
    expect(featA[0].querySelector(".pr-link")?.textContent).toBe("#101");
    expect(featA[0].querySelector(".pr-state")?.textContent).toBe("open");
    expect(featA[1].querySelector(".brg-pr")?.textContent).toContain("—");

    // mergebot state badge with the missing requirements in its tooltip
    const mb = featA[0].querySelector<HTMLAnchorElement>(".dash-pr-state")!;
    expect(mb.textContent).toBe("blocked");
    expect(mb.title).toBe("mergebot: blocked — missing: Review, CI");
    expect(app.callsTo("/api/mergebot")[0].body).toEqual({
      prs: [
        { github: "odoo/odoo", number: 101 },
        { github: "odoo/odoo", number: 202 },
      ],
      refresh: false,
    });

    // PR-only row: dim repo label, draft badge, PR title as the commit column
    const [only] = groupRows("remote-only");
    expect(only.querySelector(".brg-repo .dim")?.textContent).toBe("community");
    expect(only.querySelector(".pr-state")?.textContent).toBe("draft");
    expect(only.querySelector(".brg-commit")?.textContent).toBe("PR remote-only");

    // the checked-out branch row is highlighted; the dirty enterprise master isn't listed
    // as a branch in enterprise, but the active community master is
    expect(groupRows("master")[0].classList.contains("active")).toBe(true);
    // local-only (not pushed): plain label, no link
    expect(groupRows("local-only")[0].querySelector(".br-repo-link")).toBeNull();
  });

  it("shows the empty state, and per-repo PR errors / a branch load failure", async () => {
    app = await mount({
      "/api/code/branches": { repos: [] },
      "/api/prs": { repos: [{ id: "community", github: "odoo/odoo", error: "gh not authed" }] },
    });
    expect(app.root.textContent).toContain("No branches or pull requests.");
    expect(app.root.textContent).toContain("community: gh not authed");
    app.destroy();

    app = await mount({
      "/api/code/branches": new Response(JSON.stringify({ ok: false, error: "git exploded" }), {
        status: 500,
      }),
    });
    expect(app.root.textContent).toContain("Failed to load:");
    expect(app.root.textContent).toContain("git exploded");
  });

  it("filters by search text, repository and merge status", async () => {
    app = await mount();
    const [repoSel, statusSel] = app.root.querySelectorAll<HTMLSelectElement>("select");
    expect([...repoSel.options].map((o) => o.value)).toEqual(["", "community", "enterprise"]);

    await setSelect(repoSel, "enterprise");
    expect(groupNames()).toEqual(["feat-a"]);
    await setSelect(statusSel, "");
    expect(groupNames()).toEqual(["feat-a", "stale"]);
    await setSelect(statusSel, "merged");
    expect(groupNames()).toEqual(["stale"]);
    await setSelect(repoSel, "");
    await setSelect(statusSel, "error");
    expect(groupNames()).toEqual(["remote-only"]);
    await setSelect(statusSel, "blocked");
    expect(groupNames()).toEqual(["feat-a"]);

    await setSelect(statusSel, "");
    const search = app.root.querySelector<HTMLInputElement>(".search-box input")!;
    search.value = "#101";
    search.dispatchEvent(new Event("input"));
    await app.settle();
    expect(groupNames()).toEqual(["feat-a"]);
    expect(groupRows("feat-a")).toHaveLength(1);
  });

  it("toggles the group sort direction from the Last update header", async () => {
    app = await mount();
    const header = [...app.root.querySelectorAll<HTMLElement>("th")].find((th) =>
      th.textContent?.includes("Last update"),
    )!;
    header.click();
    await app.settle();
    expect(groupNames()).toEqual(["remote-only", "local-only", "master", "feat-a"]);
  });

  it("Refresh reloads with the cache bypassed", async () => {
    app = await mount();
    buttons(app.root, "Refresh")[0].click();
    await app.settle();
    const prsCalls = app.callsTo("/api/prs");
    expect(prsCalls.at(-1)?.body).toMatchObject({ refresh: true });
    expect(app.root.textContent).toMatch(/updated /);
  });
});

describe("Branches & PRs screen — batch actions", () => {
  async function select(name: string): Promise<void> {
    const head = [...app.root.querySelectorAll(".rl-group-head")].find(
      (h) => h.querySelector(".br-branch")?.textContent === name,
    )!;
    head.querySelector<HTMLElement>(".br-branch")!.click();
    await app.settle();
  }

  it("select-all ticks every group and toggles back off", async () => {
    app = await mount();
    const all = app.root.querySelector<HTMLInputElement>(".panel-inline-actions .br-select")!;
    all.dispatchEvent(new Event("change"));
    await app.settle();
    expect(app.root.querySelectorAll("tr.row-sel").length).toBe(5);
    expect(all.checked).toBe(true);
    all.dispatchEvent(new Event("change"));
    await app.settle();
    expect(app.root.querySelectorAll("tr.row-sel").length).toBe(0);
  });

  it("deletes the selected branches, closing their open PRs and the remote copies", async () => {
    app = await mount({
      "/api/code/branches/delete": { ok: true },
      "/api/prs/close": { ok: true },
    });
    await select("feat-a");
    await select("master"); // checked out in community → skipped
    expect(buttons(app.root, "Delete 3")).toHaveLength(1);
    expect(buttons(app.root, "Close 1 PR")).toHaveLength(1);

    buttons(app.root, "Delete 3")[0].click();
    await app.settle();
    expect(dialog()?.textContent).toContain(
      "Delete 2 branches in 2 repos locally? 1 skipped (checked out).",
    );
    const checks = [...dialog()!.querySelectorAll<HTMLLabelElement>("label.edit-check")];
    expect(checks.map((l) => l.textContent?.trim())).toEqual([
      "Also delete them on the push remote",
      "Close its open pull request",
    ]);
    checks[0].querySelector("input")!.click();
    await app.settle();
    await clickDialog("Delete");

    expect(app.callsTo("/api/prs/close").map((c) => c.body)).toEqual([
      { repo: "odoo/odoo", number: 101 },
    ]);
    const deletes = app.callsTo("/api/code/branches/delete").map((c) => c.body);
    expect(deletes).toEqual([
      expect.objectContaining({ branch: "feat-a", delete_remote: true }),
      expect.objectContaining({ branch: "feat-a", delete_remote: true }),
    ]);
    // the deleted rows are gone; master stays; the selection is cleared
    expect(groupNames()).not.toContain("feat-a");
    expect(groupNames()).toContain("master");
    expect(app.root.querySelectorAll("tr.row-sel").length).toBe(0);
  });

  it("cancelling the batch delete leaves everything in place", async () => {
    app = await mount();
    await select("local-only");
    buttons(app.root, "Delete 1")[0].click();
    await app.settle();
    expect(dialog()?.textContent).toContain('Delete branch "local-only" in 1 repo locally?');
    await clickDialog("Discard");
    expect(dialog()).toBeNull();
    expect(app.callsTo("/api/code/branches/delete")).toHaveLength(0);
    expect(groupNames()).toContain("local-only");
  });

  it("closes the selected open PRs (PR-only rows included) after confirmation", async () => {
    app = await mount({ "/api/prs/close": { ok: true } });
    await select("feat-a");
    await select("remote-only");
    buttons(app.root, "Close 2 PRs")[0].click();
    await app.settle();
    expect(dialog()?.textContent).toContain("Close 2 pull requests?");
    await clickDialog("Close");
    expect(
      app
        .callsTo("/api/prs/close")
        .map((c) => (c.body as { number: number }).number)
        .sort(),
    ).toEqual([101, 202]);
    expect(groupRows("feat-a")[0].querySelector(".pr-state")?.textContent).toBe("closed");
    expect(buttons(app.root, "Close")).toHaveLength(0);
  });

  it("cancelling the batch close sends nothing", async () => {
    app = await mount();
    await select("remote-only");
    buttons(app.root, "Close 1 PR")[0].click();
    await app.settle();
    await clickDialog("Discard");
    expect(app.callsTo("/api/prs/close")).toHaveLength(0);
  });
});

describe("Branches & PRs screen — row menu", () => {
  it("a PR-only row offers just Close PR", async () => {
    app = await mount({ "/api/prs/close": { ok: true } });
    const menu = await openMenu("remote-only", "community");
    expect(menuItems(menu)).toEqual(["Close PR"]);
    buttons(menu, "Close PR")[0].click();
    await app.settle();
    expect(dialog()?.textContent).toContain("Close PR #202 in odoo/odoo?");
    await clickDialog("Close PR");
    expect(app.callsTo("/api/prs/close")[0].body).toEqual({ repo: "odoo/odoo", number: 202 });
  });

  it("a merged PR-only row has no menu", async () => {
    app = await mount({
      "/api/prs": {
        repos: [
          {
            id: "community",
            github: "odoo/odoo",
            prs: [pr("odoo/odoo", 9, "gone", { state: "CLOSED" })],
          },
        ],
      },
      "/api/code/branches": { repos: [] },
    });
    const [statusSel] = [...app.root.querySelectorAll<HTMLSelectElement>("select")].slice(1);
    await setSelect(statusSel, "");
    expect(groupRows("gone")[0].querySelector(".dash-kebab")).toBeNull();
  });

  it("the checked-out base branch can't be checked out, pushed or deleted", async () => {
    app = await mount();
    const menu = await openMenu("master", "community");
    expect(menuItems(menu)).toEqual(["Commits", "Checkout", "Duplicate", "Delete"]);
    const co = buttons(menu, "Checkout")[0];
    expect(co.disabled).toBe(true);
    expect(co.title).toBe("this branch is already checked out");
    expect(buttons(menu, "Delete")[0].disabled).toBe(true);
  });

  it("a dirty repo blocks checkout; a pushed branch without PR offers Open PR", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    app = await mount();
    const menu = await openMenu("feat-a", "enterprise");
    expect(menuItems(menu)).toEqual(["Commits", "Open PR", "Checkout", "Duplicate", "Delete"]);
    expect(buttons(menu, "Checkout")[0].title).toContain("working tree is dirty");
    buttons(menu, "Open PR")[0].click();
    await app.settle();
    expect(open).toHaveBeenCalledWith(expect.stringContaining("github.com"), "_blank");
    expect(String(open.mock.calls[0][0])).toContain("feat-a");
  });

  it("checks out a clean branch", async () => {
    app = await mount({ "/api/code/checkout": { results: [{ ok: true, branch: "feat-a" }] } });
    const menu = await openMenu("feat-a", "community");
    expect(menuItems(menu)).toEqual(["Commits", "Close PR", "Checkout", "Duplicate", "Delete"]);
    buttons(menu, "Checkout")[0].click();
    await app.settle();
    expect(app.callsTo("/api/code/checkout")[0].body).toMatchObject({
      repos: [{ repo: "community", branch: "feat-a", path: "/home/odoo/work/community" }],
    });
  });

  it("pushes a local-only branch after confirming", async () => {
    app = await mount({ "/api/code/branch/push": { ok: true } });
    const menu = await openMenu("local-only", "community");
    expect(menuItems(menu)).toEqual(["Commits", "Push", "Checkout", "Duplicate", "Delete"]);
    buttons(menu, "Push")[0].click();
    await app.settle();
    expect(dialog()?.textContent).toContain("Push local-only (community) to the dev remote?");
    await clickDialog("Push");
    expect(app.callsTo("/api/code/branch/push")[0].body).toMatchObject({
      branch: "local-only",
      path: "/home/odoo/work/community",
    });
  });

  it("duplicates a branch under the typed name (and ignores an empty name)", async () => {
    app = await mount({ "/api/code/branches/create": { results: [{ ok: true, name: "x" }] } });
    let menu = await openMenu("local-only", "community");
    buttons(menu, "Duplicate")[0].click();
    await app.settle();
    const input = dialog()!.querySelector<HTMLInputElement>("input[type=text]")!;
    expect(input.value).toBe("local-only");
    input.value = "  local-only-2 ";
    input.dispatchEvent(new Event("input"));
    await clickDialog("OK");
    expect(app.callsTo("/api/code/branches/create")[0].body).toMatchObject({
      branches: [
        { path: "/home/odoo/work/community", name: "local-only-2", start_point: "local-only" },
      ],
    });

    menu = await openMenu("local-only", "community");
    buttons(menu, "Duplicate")[0].click();
    await app.settle();
    const input2 = dialog()!.querySelector<HTMLInputElement>("input[type=text]")!;
    input2.value = "   ";
    input2.dispatchEvent(new Event("input"));
    await clickDialog("OK");
    expect(app.callsTo("/api/code/branches/create")).toHaveLength(1);
  });

  it("opens the commit history dialog", async () => {
    app = await mount({
      "/api/code/log": {
        ok: true,
        commits: [{ sha: "deadbeef", subject: "[FIX] something", date: iso(1), author: "me" }],
      },
    });
    const menu = await openMenu("feat-a", "community");
    buttons(menu, "Commits")[0].click();
    await app.settle();
    expect(document.body.textContent).toContain("community · feat-a");
    expect(document.body.textContent).toContain("[FIX] something");
    expect(app.callsTo("/api/code/log")[0].body).toMatchObject({
      path: "/home/odoo/work/community",
    });
  });

  it("deletes a single branch, closing its PR and its workspace", async () => {
    app = await mount(
      { "/api/code/branches/delete": { ok: true }, "/api/prs/close": { ok: true } },
      {
        workspaces: [
          {
            id: "w1",
            name: "feat-a ws",
            kind: "dev",
            checkouts: [{ repo: "community", branch: "feat-a" }],
          },
          { id: "w2", name: "idle child", kind: "dev", parent: "w1", checkouts: [] },
          { id: "w3", name: "busy child", kind: "dev", parent: "w1", checkouts: [] },
        ],
      },
    );
    const menu = await openMenu("feat-a", "community");
    buttons(menu, "Delete")[0].click();
    await app.settle();
    expect(dialog()?.textContent).toContain('Force-delete "feat-a" in community locally.');
    const labels = [...dialog()!.querySelectorAll("label.edit-check")].map((l) =>
      l.textContent?.trim(),
    );
    expect(labels).toEqual([
      "Also delete it on the push remote (dev)",
      "Close PR #101",
      'Delete workspace "feat-a ws"',
    ]);
    dialog()!.querySelectorAll<HTMLInputElement>("label.edit-check input")[2].click();
    await app.settle();
    await clickDialog("Delete");
    expect(app.callsTo("/api/prs/close")[0].body).toEqual({ repo: "odoo/odoo", number: 101 });
    expect(app.callsTo("/api/code/branches/delete")[0].body).toMatchObject({
      branch: "feat-a",
      delete_remote: false,
    });
    // the config save is debounced: wait (bounded) for the write that drops both
    // the workspace and its idle child; the busy (running) child is kept, unlinked
    await vi.waitFor(() => {
      const saved = app.callsTo("/api/config").filter((c) => c.method === "POST");
      const ws = (
        saved.at(-1)?.body as { config?: { workspaces?: { id: string; parent?: string }[] } }
      )?.config?.workspaces;
      expect(ws?.map((w) => [w.id, w.parent ?? ""])).toEqual([["w3", ""]]);
    });
    expect(document.body.textContent).toContain('"busy child" is still busy');
    await clickDialog("OK");
    // the local community branch is gone: its (now closed) PR stays as a PR-only row
    const rows = groupRows("feat-a");
    expect(rows.map((r) => r.querySelector(".brg-repo")?.textContent)).toEqual([
      "enterprise",
      "community",
    ]);
    expect(rows[1].querySelector(".brg-repo .dim")).not.toBeNull();
    expect(rows[1].querySelector(".pr-state")?.textContent).toBe("closed");
  });

  it("a busy sub-workspace ticked along with its parent is kept, not deleted", async () => {
    app = await mount(
      { "/api/code/branches/delete": { ok: true }, "/api/prs/close": { ok: true } },
      {
        workspaces: [
          {
            id: "w1",
            name: "feat-a ws",
            kind: "dev",
            checkouts: [{ repo: "community", branch: "feat-a" }],
          },
          // on the same branch (so it's offered for deletion too) and busy: the
          // running server occupies w3
          {
            id: "w3",
            name: "busy child",
            kind: "dev",
            parent: "w1",
            checkouts: [{ repo: "community", branch: "feat-a" }],
          },
        ],
      },
    );
    const menu = await openMenu("feat-a", "community");
    buttons(menu, "Delete")[0].click();
    await app.settle();
    const boxes = [...dialog()!.querySelectorAll<HTMLLabelElement>("label.edit-check")];
    for (const name of ['Delete workspace "feat-a ws"', 'Delete workspace "busy child"'])
      boxes
        .find((l) => l.textContent?.trim() === name)!
        .querySelector("input")!
        .click();
    await app.settle();
    await clickDialog("Delete");
    await vi.waitFor(() => {
      const saved = app.callsTo("/api/config").filter((c) => c.method === "POST");
      const ws = (
        saved.at(-1)?.body as { config?: { workspaces?: { id: string; parent?: string }[] } }
      )?.config?.workspaces;
      expect(ws?.map((w) => [w.id, w.parent ?? ""])).toEqual([["w3", ""]]);
    });
    expect(document.body.textContent).toContain('"busy child" is still busy');
  });

  it("cancelling the single-row delete sends nothing", async () => {
    app = await mount();
    const menu = await openMenu("local-only", "community");
    buttons(menu, "Delete")[0].click();
    await app.settle();
    await clickDialog("Discard");
    expect(app.callsTo("/api/code/branches/delete")).toHaveLength(0);
  });
});
