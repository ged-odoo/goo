// The review workspaces dialogs.ts creates and syncs for the Reviews screen, driven
// from that screen in the whole app: a task's "Review" creates (or reuses) its
// worktree review workspace, and "Review again" syncs it to the PRs' current heads.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountApp, type MountedApp, type Route } from "../helpers/app.ts";
import type { Config, ReviewEntry, WorkspaceConfig } from "../../src/core/config.ts";
import { dialogTitle, mustDialog, mustText, prWire, workspace } from "../helpers/code_fixtures.ts";

let app: MountedApp;
afterEach(() => app?.destroy());

const BRANCH = "18.0-task-x";
const TRACKED: ReviewEntry[] = [
  { id: "odoo/odoo#1", github: "odoo/odoo", number: 1 },
  { id: "odoo/enterprise#2", github: "odoo/enterprise", number: 2 },
];
const PRS = [
  prWire({ github: "odoo/odoo", number: 1, branch: BRANCH }),
  prWire({ github: "odoo/enterprise", number: 2, branch: BRANCH }),
];

const failure = (status: number, body: object) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Asked = { prs?: { github: string; number: number }[] };

async function mountReviews(
  s: {
    reviews?: ReviewEntry[];
    workspaces?: WorkspaceConfig[];
    routes?: Record<string, Route>;
  } = {},
) {
  app = await mountApp({
    section: "review-queue",
    config: { targets: [], reviews: s.reviews ?? TRACKED, workspaces: s.workspaces ?? [] },
    routes: {
      "/api/prs/info": (body: unknown) => {
        const asked = new Set(((body as Asked).prs || []).map((p) => `${p.github}#${p.number}`));
        return { prs: PRS.filter((p) => asked.has(`${p.github}#${p.number}`)) };
      },
      "/api/prs/review-status": { statuses: {} },
      "/api/mergebot": { states: {}, details: {}, forward_ports: {} },
      "/api/runbot": { states: {} },
      "/api/code/branches": { repos: [] },
      "/api/workspace/claude/history": { items: [], state: "idle" },
      "/api/review-prompt": { content: "Review {{branch}}." },
      "/api/workspace/claude": { ok: true },
      "/api/prs/head": { branch: BRANCH },
      "/api/code/remote-branch/fetch-pr": { ok: true },
      "/api/workspace/create": { ok: true, results: [] },
      ...s.routes,
    },
  });
}

async function click(el: HTMLElement) {
  el.click();
  await app.settle();
}

const groupHead = () =>
  [...app.root.querySelectorAll<HTMLElement>(".rl-group-head")].find(
    (h) => h.querySelector(".rl-group-label")?.textContent?.trim() === BRANCH,
  )!;

async function review() {
  await click(groupHead().querySelector<HTMLElement>(".dash-kebab")!);
  await click(mustText(document.querySelector(".action-menu")!, "Review"));
}

// the config the app last saved (the save is debounced — wait, bounded, for it)
async function savedConfig(check: (c: Config) => void): Promise<void> {
  await vi.waitFor(
    () => {
      const posts = app.callsTo("/api/config").filter((c) => c.method === "POST");
      check((posts.at(-1)?.body as { config: Config }).config);
    },
    { timeout: 5000 },
  );
}

describe("Review workspace — creation", () => {
  it("creates a worktree review workspace on the task's PR heads and starts the review", async () => {
    await mountReviews();
    await review();
    expect(app.callsTo("/api/code/remote-branch/fetch-pr").map((c) => c.body)).toEqual([
      {
        path: "/home/odoo/work/community",
        github: "odoo/odoo",
        number: 1,
        branch: BRANCH,
        force: false,
      },
      {
        path: "/home/odoo/work/enterprise",
        github: "odoo/enterprise",
        number: 2,
        branch: BRANCH,
        force: false,
      },
    ]);
    const [create] = app.callsTo("/api/workspace/create");
    const { repos, workspace: id } = create.body as {
      workspace: string;
      repos: { repo: string; branch?: string; newBranch?: string }[];
    };
    // both PR branches are attached as they are, nothing forked
    expect(repos.map((r) => [r.repo, r.branch, r.newBranch])).toEqual([
      ["community", BRANCH, undefined],
      ["enterprise", BRANCH, undefined],
    ]);
    expect(app.callsTo("/api/workspace/claude")[0].body).toMatchObject({
      workspace: id,
      review: true,
    });
    await savedConfig((c) => {
      expect(c.workspaces.find((w) => w.id === id)).toMatchObject({
        name: BRANCH,
        db: BRANCH,
        category: "review",
        location: "worktree",
      });
      expect(c.workspace_categories.map((cat) => cat.id)).toContain("review");
    });
  });

  it("an enterprise-only task still gets a community checkout to run Claude in", async () => {
    await mountReviews({ reviews: [TRACKED[1]] });
    await review();
    const [create] = app.callsTo("/api/workspace/create");
    const repos = (
      create.body as {
        repos: { repo: string; branch?: string; newBranch?: string; startPoint?: string }[];
      }
    ).repos;
    expect(repos.map((r) => [r.repo, r.branch ?? r.newBranch, r.startPoint])).toEqual([
      ["enterprise", BRANCH, undefined],
      ["community", BRANCH, "18.0"], // forked off the task's base
    ]);
  });

  it("reuses a workspace already on the task's branch, filing it under review", async () => {
    await mountReviews({
      workspaces: [
        workspace({
          id: "mine",
          name: BRANCH,
          category: "dev",
          checkouts: [{ repo: "community", branch: BRANCH }],
        }),
      ],
    });
    await review();
    expect(app.callsTo("/api/workspace/create")).toEqual([]);
    expect(app.callsTo("/api/workspace/claude")[0].body).toMatchObject({ workspace: "mine" });
    await savedConfig((c) =>
      expect(c.workspaces.find((w) => w.id === "mine")!.category).toBe("review"),
    );
  });

  it("a PR head that can't be fetched is reported and no workspace is created", async () => {
    await mountReviews({
      routes: {
        "/api/code/remote-branch/fetch-pr": () =>
          failure(500, { error: "couldn't find remote ref" }),
      },
    });
    await review();
    expect(dialogTitle()).toBe("Fetching PR branch failed");
    expect(mustDialog().textContent).toContain("community: couldn't find remote ref");
    expect(mustDialog().textContent).toContain("enterprise: couldn't find remote ref");
    expect(app.callsTo("/api/workspace/create")).toEqual([]);
    expect(app.callsTo("/api/workspace/claude")).toEqual([]);
  });
});

describe("Review workspace — Review again", () => {
  const REVIEW_WS = workspace({
    id: "rw1",
    name: BRANCH,
    category: "review",
    location: "worktree",
    worktree: { dir: "/wt/18.0-task-x" },
    checkouts: [
      { repo: "community", branch: BRANCH },
      { repo: "enterprise", branch: BRANCH },
    ],
  });

  async function reviewAgain(syncPr: Route) {
    await mountReviews({
      workspaces: [REVIEW_WS],
      routes: {
        "/api/workspace/claude/history": {
          items: [{ role: "assistant", text: "Fine.\n\nScore: 80/100" }],
          state: "idle",
        },
        "/api/workspace/claude/review": {
          text: "Fine.\n\nScore: 80/100",
          version: 1,
          versions: [1],
        },
        "/api/code/remote-branch/sync-pr": syncPr,
      },
    });
    await click(groupHead().querySelector<HTMLElement>(".rev-review")!);
    await click(mustText(document.querySelector(".review-panel")!, "Review again"));
  }

  it("syncs each worktree checkout to its PR's current head before reviewing", async () => {
    await reviewAgain({ ok: true });
    expect(app.callsTo("/api/code/remote-branch/sync-pr").map((c) => c.body)).toEqual([
      { path: "/wt/18.0-task-x/community", github: "odoo/odoo", number: 1, repo: "community" },
      {
        path: "/wt/18.0-task-x/enterprise",
        github: "odoo/enterprise",
        number: 2,
        repo: "enterprise",
      },
    ]);
    expect(app.callsTo("/api/workspace/claude")[0].body).toMatchObject({
      workspace: "rw1",
      review: true,
    });
  });

  it("reports the repos that failed to sync, and still reviews", async () => {
    await reviewAgain((body: unknown) =>
      (body as { repo: string }).repo === "community"
        ? { ok: false, error: "dirty worktree" }
        : failure(500, { error: "network down" }),
    );
    expect(dialogTitle()).toBe("Syncing PR update failed");
    expect(mustDialog().textContent).toContain("community: dirty worktree");
    expect(mustDialog().textContent).toContain("enterprise: network down");
    expect(app.callsTo("/api/workspace/claude")).toHaveLength(1);
  });
});
