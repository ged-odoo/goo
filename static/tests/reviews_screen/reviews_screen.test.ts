import { afterEach, describe, expect, it, vi } from "vitest";
import { mountApp, type MountedApp, type Route } from "../helpers/app.ts";
import {
  MERGEBOT,
  REVIEWS,
  REVIEW_ROUTES,
  mergebotRoute,
  prWire,
} from "../helpers/reviews_fixtures.ts";
import type { Config } from "../../src/core/config.ts";

let app: MountedApp;
afterEach(() => app?.destroy());

const mount = (routes: Record<string, Route> = {}, config: Partial<Config> = {}) =>
  mountApp({
    section: "review-queue",
    routes: { ...REVIEW_ROUTES, ...routes },
    config: { reviews: REVIEWS, ...config },
  });

const text = (el: Element | null | undefined): string => el?.textContent?.trim() ?? "";
const groupHead = (branch: string): HTMLElement =>
  [...app.root.querySelectorAll<HTMLElement>(".rl-group-head")].find(
    (h) => text(h.querySelector(".rl-group-label")) === branch,
  )!;
const groupRows = (branch: string): HTMLElement[] => [
  ...groupHead(branch).closest("tbody")!.querySelectorAll<HTMLElement>("tr.rl-row"),
];
const groupNames = (): string[] =>
  [...app.root.querySelectorAll(".rl-group-head .rl-group-label")].map(text);
const button = (root: ParentNode, label: string): HTMLButtonElement =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => text(b) === label)!;
const dialog = (): HTMLElement | null => document.querySelector(".dialog");
const menuItems = (): string[] =>
  [...document.querySelectorAll(".action-menu .dash-menu-item")].map(text);

async function click(el: HTMLElement): Promise<void> {
  el.click();
  await app.settle();
}
const clickMenu = (label: string) => click(button(document.querySelector(".action-menu")!, label));
const clickDialog = (label: string) => click(button(dialog()!, label));

async function addPr(value: string): Promise<void> {
  const input = app.root.querySelector<HTMLInputElement>(".rev-add input")!;
  input.value = value;
  input.dispatchEvent(new Event("input"));
  app.root.querySelector<HTMLFormElement>(".rev-add")!.dispatchEvent(new Event("submit"));
  await app.settle();
}

// the latest config the app persisted (the save is debounced — wait, bounded, for it)
async function savedConfig(check: (c: Config) => void): Promise<void> {
  await vi.waitFor(() => {
    const posts = app.callsTo("/api/config").filter((c) => c.method === "POST");
    check((posts.at(-1)?.body as { config: Config }).config);
  });
}

// a review workspace already tracking the 18.0-task-x task
const REVIEW_WS = {
  id: "rw1",
  name: "18.0-task-x",
  category: "review",
  checkouts: [
    { repo: "community", branch: "18.0-task-x" },
    { repo: "enterprise", branch: "18.0-task-x" },
  ],
};
const WITH_WS = { workspaces: [REVIEW_WS] } as unknown as Partial<Config>;

describe("Reviews screen — the queue", () => {
  it("groups tracked PRs by branch with their PR, status and forward-port cells", async () => {
    app = await mount();
    expect(text(app.root.querySelector("h1"))).toBe("Reviews");
    expect(text(app.root.querySelector(".panel-inline-actions .sub"))).toBe("4 PRs");
    expect(groupNames()).toEqual(["18.0-task-x", "17.0-fix-y", "ext-branch"]);

    // a multi-repo task: one row per repo, with a worst-of status rollup
    const head = groupHead("18.0-task-x");
    expect(text(head.querySelector(".dash-pr-state"))).toBe("To review");
    expect(text(head.querySelector(".rl-group-count"))).toBe("(2)");
    const [c, e] = groupRows("18.0-task-x");
    expect(text(c.querySelector("td"))).toBe("community");
    expect(c.querySelector<HTMLAnchorElement>(".pr-link")?.href).toBe(
      "https://github.com/odoo/odoo/pull/1",
    );
    expect(text(c.querySelector(".rev-pr-title"))).toBe("Title 1");
    expect(text(e.querySelector(".pr-state"))).toBe("draft");
    expect(text(e.querySelector("td:nth-child(3)"))).toBe("Reviewed");

    // merged by mergebot (GitHub says closed): badge "merged", forward ports listed
    const [merged] = groupRows("17.0-fix-y");
    expect(text(merged.querySelector(".pr-state"))).toBe("merged");
    expect(text(merged.querySelector("td:nth-child(3)"))).toBe("Merged");
    const fp = merged.querySelector<HTMLButtonElement>(".rev-fwports button")!;
    expect(text(fp)).toBe("18.0");
    expect(fp.title).toBe("odoo/odoo#30: To review");
    expect(merged.querySelector(".rev-fwports span.other")?.getAttribute("title")).toBe(
      "saas-18.1: not opened yet",
    );
    expect(groupHead("17.0-fix-y").querySelector(".rev-important.on")).not.toBeNull();

    // a repo that isn't configured shows its github slug; mergebot "ready" = r+'d
    const [ext] = groupRows("ext-branch");
    expect(text(ext.querySelector("td"))).toBe("other/lib");
    expect(text(ext.querySelector("td:nth-child(3)"))).toBe("R+'d");

    // the forward port's own status was fetched as well
    const asked = app
      .callsTo("/api/mergebot")
      .flatMap((c) => (c.body as { prs: { number: number }[] }).prs.map((p) => p.number));
    expect(asked).toContain(30);
    expect(text(app.root.querySelector(".panel-top-right .meta"))).toBe("updated just now");
  });

  it("shows placeholders while a tracked PR's info hasn't loaded", async () => {
    app = await mount({ "/api/prs/info": { prs: [] } });
    // unloaded rows group alone, by their own id
    expect(groupNames()).toContain("odoo/odoo#1");
    const [row] = groupRows("odoo/odoo#1");
    expect(text(row.querySelector(".rev-pr"))).toBe("#1…");
    expect(text(row.querySelector("td:nth-child(3)"))).toBe("—");
    // a PR GitHub doesn't return is re-asked only when other state lands, not in a loop
    expect(app.callsTo("/api/prs/info").length).toBeLessThan(5);
  });

  it("filters tasks by status (a task stays when any of its PRs matches)", async () => {
    app = await mount();
    const sel = app.root.querySelector<HTMLSelectElement>(".panel-filters select")!;
    const pick = async (v: string): Promise<void> => {
      sel.value = v;
      sel.dispatchEvent(new Event("change"));
      await app.settle();
    };
    await pick("merged");
    expect(groupNames()).toEqual(["17.0-fix-y"]);
    await pick("rplus");
    expect(groupNames()).toEqual(["ext-branch"]);
    await pick("reviewed");
    expect(groupNames()).toEqual(["18.0-task-x"]);
    await pick("to_review");
    expect(groupNames()).toEqual(["18.0-task-x"]);
    await pick("");
    expect(groupNames()).toHaveLength(3);
  });

  it("shows the empty state and a load failure", async () => {
    app = await mount({}, { reviews: [] });
    expect(text(app.root.querySelector(".br-empty"))).toBe("No PRs tracked yet — paste one above.");
    expect(app.callsTo("/api/prs/info")).toHaveLength(0);
    app.destroy();

    app = await mount({
      "/api/prs/info": () =>
        new Response(JSON.stringify({ ok: false, error: "gh: rate limited" }), { status: 500 }),
    });
    expect(text(app.root.querySelector(".br-empty"))).toContain("Failed to load:");
    expect(text(app.root.querySelector(".br-empty"))).toContain("rate limited");
  });

  it("Refresh re-asks PR info, review status and mergebot bypassing the caches", async () => {
    app = await mount();
    await click(button(app.root, "Refresh"));
    expect(app.callsTo("/api/prs/info").at(-1)?.body).toMatchObject({ refresh: true });
    expect(app.callsTo("/api/prs/review-status").at(-1)?.body).toMatchObject({ refresh: true });
    const forced = app
      .callsTo("/api/mergebot")
      .filter((c) => (c.body as { refresh: boolean }).refresh);
    expect(forced).toHaveLength(1);
  });

  it("flags a whole task as important, and unflags it", async () => {
    app = await mount();
    const flag = (): HTMLButtonElement =>
      groupHead("18.0-task-x").querySelector<HTMLButtonElement>(".rev-important")!;
    await click(flag());
    expect(flag().classList.contains("on")).toBe(true);
    expect(flag().title).toBe("unflag as important");
    await savedConfig((c) => {
      const flagged = c.reviews.filter((r) => r.important).map((r) => r.id);
      expect(flagged.sort()).toEqual(["odoo/enterprise#2", "odoo/odoo#1", "odoo/odoo#3"]);
    });
    await click(flag());
    expect(flag().classList.contains("on")).toBe(false);
  });
});

describe("Reviews screen — adding a PR", () => {
  it("rejects text that isn't a PR reference, and an already-tracked PR", async () => {
    app = await mount();
    await addPr("not a pr");
    expect(text(app.root.querySelector(".rev-add-note"))).toBe(
      "paste a GitHub PR URL or owner/repo#123",
    );
    await addPr("odoo/odoo#1");
    expect(text(app.root.querySelector(".rev-add-note"))).toBe("already tracked");
    expect(app.root.querySelector<HTMLInputElement>(".rev-add input")!.value).toBe("");
    await addPr("   "); // blank: nothing happens
    expect(text(app.root.querySelector(".panel-inline-actions .sub"))).toBe("4 PRs");
  });

  it("tracks a pasted PR URL and picks up its sibling PR in the other repo", async () => {
    app = await mount(
      {
        "/api/prs/info": (body: unknown) => ({
          prs: (body as { prs: { number: number }[] }).prs.some((p) => p.number === 5)
            ? [prWire("odoo/odoo", 5, "19.0-new")]
            : [],
        }),
        "/api/prs/for-branches": { prs: [prWire("odoo/enterprise", 6, "19.0-new")] },
      },
      { reviews: [] },
    );
    await addPr("https://github.com/odoo/odoo/pull/5");
    expect(app.callsTo("/api/prs/for-branches")[0].body).toEqual({
      branches: [{ github: "odoo/enterprise", branch: "19.0-new" }],
    });
    expect(text(app.root.querySelector(".rev-add-note"))).toBe('+1 related PR found on "19.0-new"');
    expect(groupNames()).toEqual(["19.0-new"]);
    expect(groupRows("19.0-new").map((r) => text(r.querySelector(".pr-link")))).toEqual([
      "#6",
      "#5",
    ]);
    expect(text(app.root.querySelector(".panel-inline-actions .sub"))).toBe("2 PRs");
    await savedConfig((c) =>
      expect(c.reviews.map((r) => r.id)).toEqual(["odoo/enterprise#6", "odoo/odoo#5"]),
    );
  });

  it("auto-starts a Claude review in the task's existing review workspace", async () => {
    app = await mount(
      {
        "/api/prs/info": { prs: [prWire("odoo/enterprise", 2, "18.0-task-x")] },
        "/api/prs/for-branches": { prs: [] },
        "/api/review-prompt": { content: "Review {{branch}} in {{repos}}." },
        "/api/workspace/claude": { ok: true },
      },
      {
        reviews: [],
        auto_workspace_on_review: true,
        auto_claude_review: true,
        ...WITH_WS,
      },
    );
    await addPr("odoo/enterprise#2");
    const [send] = app.callsTo("/api/workspace/claude");
    const body = send.body as { workspace: string; prompt: string; review: boolean; cwd: string };
    expect(body.workspace).toBe("rw1");
    expect(body.review).toBe(true);
    expect(body.cwd).toBe("/home/odoo/work/community");
    expect(body.prompt).toContain("Review 18.0-task-x in community, enterprise.");
    expect(body.prompt).toContain("Score: N/100");
    // the task's review icon now spins
    expect(groupHead("18.0-task-x").querySelector(".rev-review.running")).not.toBeNull();
  });
});

describe("Reviews screen — untracking", () => {
  // every forward port merged too → the 17.0-fix-y task is fully merged
  const ALL_MERGED = mergebotRoute({
    ...MERGEBOT,
    states: { ...MERGEBOT.states, "odoo/odoo#30": "merged" },
    forward_ports: { "odoo/odoo#3": [MERGEBOT.forward_ports["odoo/odoo#3"][0]] },
  });

  it("asks before untracking an unmerged PR (cancel keeps it, confirm drops it)", async () => {
    app = await mount();
    const kebab = () => groupRows("ext-branch")[0].querySelector<HTMLButtonElement>(".dash-kebab")!;
    await click(kebab());
    expect(menuItems()).toEqual([
      "Create workspace",
      "Open on GitHub",
      "Open on mergebot",
      "Untrack",
    ]);
    await clickMenu("Untrack");
    expect(text(dialog()?.querySelector(".dialog-title"))).toBe("Untrack unmerged PR?");
    await clickDialog("Discard");
    expect(groupNames()).toContain("ext-branch");

    await click(kebab());
    await clickMenu("Untrack");
    await clickDialog("Untrack anyway");
    expect(groupNames()).not.toContain("ext-branch");
    expect(text(app.root.querySelector(".panel-inline-actions .sub"))).toBe("3 PRs");
  });

  it("untracks a fully merged task without asking, removing its review workspace", async () => {
    app = await mount({ "/api/mergebot": ALL_MERGED, "/api/workspace/remove": { ok: true } }, {
      workspaces: [{ ...REVIEW_WS, id: "rw2", name: "17.0-fix-y", location: "worktree" }],
    } as unknown as Partial<Config>);
    await click(groupHead("17.0-fix-y").querySelector<HTMLButtonElement>(".dash-kebab")!);
    expect(menuItems()).toEqual([
      "Create workspace",
      "Review",
      "Open on GitHub",
      "Open on mergebot",
      "Untrack",
    ]);
    await clickMenu("Untrack");
    expect(dialog()).toBeNull();
    expect(groupNames()).not.toContain("17.0-fix-y");
    expect(app.callsTo("/api/workspace/remove")[0].body).toMatchObject({ workspace: "rw2" });
  });

  it("Untrack all merged drops every fully merged task after confirmation", async () => {
    app = await mount({ "/api/mergebot": ALL_MERGED });
    const btn = (): HTMLButtonElement => button(app.root, "Untrack all merged (1)");
    expect(btn().disabled).toBe(false);
    await click(btn());
    expect(text(dialog()?.querySelector(".dialog-title"))).toBe("Untrack 1 fully-merged task?");
    await clickDialog("Discard");
    expect(groupNames()).toContain("17.0-fix-y");
    await click(btn());
    await clickDialog("Untrack");
    expect(groupNames()).toEqual(["18.0-task-x", "ext-branch"]);
    expect(button(app.root, "Untrack all merged (0)").disabled).toBe(true);
  });

  it("untracking one PR of a multi-repo task asks for that task's group", async () => {
    app = await mount();
    await click(groupHead("18.0-task-x").querySelector<HTMLButtonElement>(".dash-kebab")!);
    // ambiguous which PR to open for a multi-PR task: no Open on GitHub/mergebot
    expect(menuItems()).toEqual(["Create workspace", "Review", "Untrack"]);
    await clickMenu("Untrack");
    expect(text(dialog()?.querySelector(".dialog-title"))).toBe("Untrack unmerged PRs?");
    await clickDialog("Untrack anyway");
    expect(groupNames()).toEqual(["17.0-fix-y", "ext-branch"]);
  });
});

describe("Reviews screen — row and forward-port menus", () => {
  it("opens the PR and its mergebot page in a new tab", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    app = await mount();
    await click(groupRows("ext-branch")[0].querySelector<HTMLButtonElement>(".dash-kebab")!);
    await clickMenu("Open on GitHub");
    expect(open).toHaveBeenLastCalledWith("https://github.com/other/lib/pull/4", "_blank");
    await click(groupRows("ext-branch")[0].querySelector<HTMLButtonElement>(".dash-kebab")!);
    await clickMenu("Open on mergebot");
    expect(String(open.mock.lastCall?.[0])).toContain("4");
    expect(String(open.mock.lastCall?.[0])).toContain("mergebot");
  });

  it("Create workspace explains when the PR's repo has no local checkout", async () => {
    app = await mount();
    await click(groupRows("ext-branch")[0].querySelector<HTMLButtonElement>(".dash-kebab")!);
    await clickMenu("Create workspace");
    expect(text(dialog()?.querySelector(".dialog-msg"))).toBe(
      "other/lib isn't a configured repo with a local checkout.",
    );
    await clickDialog("OK");
    expect(dialog()).toBeNull();
  });

  it("Create workspace for a task resolves every repo's PR head (and reports failures)", async () => {
    app = await mount({
      "/api/prs/head": () =>
        new Response(JSON.stringify({ ok: false, error: "no such PR" }), { status: 404 }),
    });
    await click(groupHead("18.0-task-x").querySelector<HTMLButtonElement>(".dash-kebab")!);
    await clickMenu("Create workspace");
    expect(
      app
        .callsTo("/api/prs/head")
        .map((c) => c.body)
        .sort((a, b) => (a as { number: number }).number - (b as { number: number }).number),
    ).toEqual([
      { repo: "odoo/odoo", number: 1 },
      { repo: "odoo/enterprise", number: 2 },
    ]);
    expect(text(dialog()?.querySelector(".dialog-title"))).toBe("Fetching PR branch failed");
    expect(text(dialog()?.querySelector(".dialog-msg"))).toContain("community: ");
  });

  it("a forward-port badge opens its menu; Send r+ posts the approval", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    app = await mount({ "/api/prs/r-plus": { ok: true } });
    const badge = () =>
      groupRows("17.0-fix-y")[0].querySelector<HTMLButtonElement>(".rev-fwports button")!;
    await click(badge());
    expect(menuItems()).toEqual([
      "Create workspace",
      "Open on GitHub",
      "Open on mergebot",
      "Send r+",
    ]);
    await clickMenu("Send r+");
    expect(app.callsTo("/api/prs/r-plus")[0].body).toEqual({ repo: "odoo/odoo", number: 30 });
    await click(badge());
    await clickMenu("Open on GitHub");
    expect(open).toHaveBeenLastCalledWith("https://github.com/odoo/odoo/pull/30", "_blank");
    await click(badge());
    await clickMenu("Open on mergebot");
    expect(String(open.mock.lastCall?.[0])).toContain("30");
  });
});

describe("Reviews screen — Claude reviews", () => {
  const REVIEW_TEXT = "## Looks fine\n\nMinor nits.\n\nScore: 82/100";

  it("the task menu's Review starts a review and lands on the workspace's Claude tab", async () => {
    app = await mount(
      { "/api/review-prompt": { content: "Go." }, "/api/workspace/claude": { ok: true } },
      WITH_WS,
    );
    await click(groupHead("18.0-task-x").querySelector<HTMLButtonElement>(".dash-kebab")!);
    await clickMenu("Review");
    expect(app.callsTo("/api/workspace/claude/history")[0].body).toEqual({ workspace: "rw1" });
    expect(app.callsTo("/api/workspace/claude")[0].body).toMatchObject({
      workspace: "rw1",
      review: true,
    });
    expect(location.hash).toBe("#workspaces");
  });

  it("the review icon starts a review in place, and is a no-op while it runs", async () => {
    app = await mount(
      { "/api/review-prompt": { content: "Go." }, "/api/workspace/claude": { ok: true } },
      WITH_WS,
    );
    const icon = () => groupHead("18.0-task-x").querySelector<HTMLButtonElement>(".rev-review")!;
    expect(icon().title).toBe("Run a Claude review for this task");
    await click(icon());
    expect(app.callsTo("/api/workspace/claude")).toHaveLength(1);
    expect(location.hash).toBe("#review-queue");
    expect(icon().classList.contains("running")).toBe(true);
    expect(icon().title).toBe("Claude is reviewing this task…");
    await click(icon());
    expect(app.callsTo("/api/workspace/claude")).toHaveLength(1);
  });

  it("a task without a configured-repo PR can't start a review", async () => {
    app = await mount();
    await click(groupHead("ext-branch").querySelector<HTMLButtonElement>(".rev-review")!);
    expect(app.callsTo("/api/prs/head")).toHaveLength(0);
    expect(app.callsTo("/api/workspace/claude")).toHaveLength(0);
  });

  it("a finished review shows its score and opens the review panel with its versions", async () => {
    app = await mount(
      {
        "/api/workspace/claude/history": {
          items: [{ role: "assistant", text: REVIEW_TEXT }],
          state: "idle",
        },
        "/api/workspace/claude/review": (body: unknown) => {
          const v = (body as { version?: number }).version ?? 2;
          return {
            text: v === 2 ? REVIEW_TEXT : "Old review.\n\nScore: 40/100",
            version: v,
            versions: [1, 2],
            created: 1_700_000_000,
          };
        },
        "/api/review-prompt": { ok: true, content: "Go again." },
        "/api/workspace/claude": { ok: true, state: "running" },
        "/api/code/remote-branch/sync-pr": { ok: true, error: null },
      },
      WITH_WS,
    );
    const icon = groupHead("18.0-task-x").querySelector<HTMLButtonElement>(".rev-review")!;
    expect(icon.classList.contains("done")).toBe(true);
    expect(text(icon.querySelector(".rev-score"))).toBe("82");
    expect(icon.title).toBe(
      "Claude review available — merge-readiness guess: 82/100 — click to read it",
    );

    await click(icon);
    const panel = (): HTMLElement => document.querySelector<HTMLElement>(".review-panel")!;
    expect(text(panel().querySelector(".term-panel-title"))).toBe("Review · 18.0-task-x");
    expect(panel().querySelector(".review-panel-text h2")?.textContent).toBe("Looks fine");
    expect(text(panel().querySelector(".rev-score"))).toBe("82");
    expect(text(panel().querySelector(".review-panel-meta"))).toMatch(/^Reviewed /);
    expect(text(panel().querySelector(".review-panel-pager-label"))).toBe("2/2");
    expect(panel().querySelector<HTMLButtonElement>(".rp-pager-next")!.disabled).toBe(true);

    // browse to the older version and back
    await click(panel().querySelector<HTMLButtonElement>(".rp-pager-prev")!);
    expect(app.callsTo("/api/workspace/claude/review").at(-1)?.body).toEqual({
      workspace: "rw1",
      version: 1,
    });
    expect(text(panel().querySelector(".review-panel-pager-label"))).toBe("1/2");
    expect(text(panel().querySelector(".rev-score"))).toBe("40");
    expect(panel().querySelector<HTMLButtonElement>(".rp-pager-prev")!.disabled).toBe(true);
    await click(panel().querySelector<HTMLButtonElement>(".rp-pager-next")!);
    expect(text(panel().querySelector(".review-panel-pager-label"))).toBe("2/2");

    // Review again: a fresh review turn, the panel shows it's running
    await click(button(panel(), "Review again"));
    // the checkouts are first synced to their tracked PRs' current heads
    expect(
      app
        .callsTo("/api/code/remote-branch/sync-pr")
        .map((c) => c.body as { repo: string; github: string; number: number })
        .map(({ repo, github, number }) => ({ repo, github, number }))
        .sort((a, b) => a.number - b.number),
    ).toEqual([
      { repo: "community", github: "odoo/odoo", number: 1 },
      { repo: "enterprise", github: "odoo/enterprise", number: 2 },
    ]);
    expect(app.callsTo("/api/workspace/claude")[0].body).toMatchObject({
      workspace: "rw1",
      review: true,
    });
    expect(text(panel().querySelector(".review-panel-working"))).toContain(
      "Claude is reviewing again…",
    );
    expect(button(panel(), "Reviewing…").disabled).toBe(true);

    // Continue to chat: closes the panel and opens the workspace's Claude tab
    await click(button(panel(), "Continue to chat with claude"));
    expect(document.querySelector(".review-panel")).toBeNull();
    expect(location.hash).toBe("#workspaces");
  });

  it("the review panel says when nothing is saved, and closes on Escape", async () => {
    app = await mount(
      {
        "/api/workspace/claude/history": { items: [{ role: "assistant", text: "hi" }] },
        "/api/workspace/claude/review": {},
      },
      WITH_WS,
    );
    const icon = groupHead("18.0-task-x").querySelector<HTMLButtonElement>(".rev-review")!;
    expect(icon.title).toBe("Claude review available — click to read it");
    await click(icon);
    expect(text(document.querySelector(".review-panel-body"))).toBe(
      "no review saved for this task yet",
    );
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await app.settle();
    expect(document.querySelector(".review-panel")).toBeNull();
  });
});
