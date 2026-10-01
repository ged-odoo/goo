// The Workspaces screen's Code tab, mounted in the whole app against a fake backend:
// the per-checkout cards (branch, sync health, PR pills), the toolbar (editor,
// fetch & rebase all, push all) and each card's actions menu.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountApp, type MountedApp, type Route } from "../helpers/app.ts";
import type { Config } from "../../src/core/config.ts";
import type { WorkspaceConfig } from "../../src/core/config.ts";
import {
  branch,
  card,
  dialogButton,
  dialogTitle,
  forwardPortRow,
  featRepos,
  gitBackend,
  menuItems,
  mustDialog,
  mustText,
  prWire,
  prsReply,
  typeInto,
  workspace,
  type FakeRepo,
} from "../helpers/code_fixtures.ts";
import type { PullRequestWire } from "../../src/core/models.ts";

let app: MountedApp;
afterEach(() => app?.destroy());

interface Setup {
  repos?: Record<string, FakeRepo>;
  prs?: Record<string, PullRequestWire[]>;
  ws?: WorkspaceConfig;
  workspaces?: WorkspaceConfig[];
  config?: Partial<Config>;
  routes?: Record<string, Route>;
}

async function mountCode(s: Setup = {}) {
  const git = gitBackend(s.repos ?? featRepos());
  app = await mountApp({
    section: "workspaces",
    config: { workspaces: s.workspaces ?? [s.ws ?? workspace()], ...s.config },
    routes: {
      "/api/code/branches": (body: unknown) => git.route(body),
      "/api/prs": prsReply(s.prs ?? {}),
      "/api/prs/for-branches": { prs: [] },
      "/api/databases": { ok: true, databases: [] },
      ...s.routes,
    },
  });
  return git;
}

async function click(el: HTMLElement) {
  el.click();
  await app.settle();
}

async function openMenu(repo: string) {
  await click(card(app.root, repo).querySelector<HTMLElement>(".ws-co-menu .dash-kebab")!);
}

async function menuAction(repo: string, label: string) {
  await openMenu(repo);
  await click(mustText(card(app.root, repo), label));
}

const toolbar = (label: string) => mustText(app.root.querySelector(".ws-sec")!, label);

describe("Code tab — checkout cards", () => {
  it("shows one card per checkout with its branch, last commit and sync health", async () => {
    await mountCode();
    const c = card(app.root, "community");
    expect(c.querySelector(".ws-co-branch")!.textContent).toBe("master-feat");
    expect(c.textContent).toContain("checked out");
    expect(c.querySelector(".ws-commit")!.textContent).toContain("feat community");
    const sync = c.querySelector<HTMLElement>(".ws-sync")!;
    expect(sync.textContent).toContain("2 behind");
    expect(sync.title).toBe("2 commits behind master · 1 ahead");
    expect(c.textContent).toContain("no pull request");
    expect(c.querySelector<HTMLAnchorElement>(".ws-pr-create")!.href).toContain("odoo/odoo");
    expect(card(app.root, "enterprise")).toBeTruthy();
  });

  it("says when the workspace has no checkouts", async () => {
    await mountCode({ ws: workspace({ checkouts: [] }) });
    expect(app.root.querySelector(".ws-empty-note")!.textContent).toContain("no checkouts");
  });

  it("shows up-to-date sync and no inline Rebase when nothing is behind", async () => {
    await mountCode({ repos: featRepos({ behind: 0, ahead: 0 }) });
    const c = card(app.root, "community");
    expect(c.querySelector<HTMLElement>(".ws-sync")!.title).toBe("up to date with master");
    expect(c.querySelector(".ws-sync")!.textContent).toContain("up to date");
    expect(c.querySelector(".ws-rebase-inline")).toBeNull();
  });

  it("flags a checkout whose branch doesn't exist locally, and can't push it", async () => {
    const repos = featRepos();
    repos.enterprise = { ...repos.enterprise, branches: [branch("other")] };
    await mountCode({ repos });
    const c = card(app.root, "enterprise");
    expect(c.textContent).toContain("not found locally");
    await openMenu("enterprise");
    const push = mustText(c, "Push");
    expect(push.disabled).toBe(true);
    expect(push.title).toBe("the branch does not exist locally");
  });

  it("a base-branch checkout shows no PR affordances and refuses to push", async () => {
    const repos: Record<string, FakeRepo> = {
      community: { current: "master", ahead: 0, behind: 0, branches: [branch("master")] },
    };
    await mountCode({
      repos,
      ws: workspace({ checkouts: [{ repo: "community", branch: "master" }] }),
    });
    const c = card(app.root, "community");
    expect(c.textContent).not.toContain("no pull request");
    await openMenu("community");
    const push = mustText(c, "Push");
    expect(push.disabled).toBe(true);
    expect(push.title).toBe("base branches cannot be pushed");
    expect(toolbar("Push all").disabled).toBe(true);
    expect(toolbar("Push all").title).toContain("no local work branches");
  });

  it("a workspace that isn't checked out can't fetch & rebase all", async () => {
    const repos = featRepos();
    repos.community = {
      ...repos.community,
      current: "master",
      branches: [branch("master"), branch("master-feat")],
    };
    await mountCode({ repos });
    expect(card(app.root, "community").textContent).not.toContain("checked out");
    const all = toolbar("Fetch & rebase all");
    expect(all.disabled).toBe(true);
    expect(all.title).toContain("this workspace is not active");
  });

  it("a repo with a git error explains it on the rebase action", async () => {
    await mountCode({ repos: featRepos({ error: "fatal: not a git repository" }) });
    await openMenu("community");
    const rebase = mustText(card(app.root, "community"), "Fetch & rebase");
    expect(rebase.disabled).toBe(true);
    expect(rebase.title).toBe("fatal: not a git repository");
    expect(toolbar("Fetch & rebase all").title).toContain("nothing to rebase");
  });
});

describe("Code tab — fetch & rebase", () => {
  it("the inline Rebase rebases that repo and the card picks up the new state", async () => {
    const git = await mountCode({
      routes: {
        "/api/code/rebase": (body: unknown) => {
          git.repos.community = { ...git.repos.community, behind: 0 };
          return {
            results: (body as { repos: { repo: string }[] }).repos.map((r) => ({
              repo: r.repo,
              ok: true,
            })),
          };
        },
      },
    });
    const c = card(app.root, "community");
    const btn = c.querySelector<HTMLButtonElement>(".ws-rebase-inline")!;
    expect(btn.title).toBe("fetch and rebase master-feat onto origin/master");
    await click(btn);
    const [call] = app.callsTo("/api/code/rebase");
    expect(call.body).toEqual({
      repos: [
        {
          repo: "community",
          base: "master",
          github: "odoo/odoo",
          path: "/home/odoo/work/community",
          pull_remote: "origin",
        },
      ],
    });
    expect(card(app.root, "community").querySelector(".ws-sync")!.textContent).toContain(
      "up to date",
    );
  });

  it("Fetch & rebase all rebases every repo in one call", async () => {
    await mountCode({ routes: { "/api/code/rebase": { results: [] } } });
    const all = toolbar("Fetch & rebase all");
    expect(all.title).toBe(
      "fetch and rebase master-feat (community) onto origin/master, master-feat (enterprise) onto origin/master",
    );
    await click(all);
    const [call] = app.callsTo("/api/code/rebase");
    expect((call.body as { repos: { repo: string }[] }).repos.map((r) => r.repo)).toEqual([
      "community",
      "enterprise",
    ]);
  });

  it("a failed rebase opens an error dialog naming the repo", async () => {
    await mountCode({
      routes: {
        "/api/code/rebase": {
          results: [{ repo: "community", ok: false, error: "conflict in foo.py" }],
        },
      },
    });
    await menuAction("community", "Fetch & rebase");
    expect(dialogTitle()).toBe("Fetch & rebase failed");
    expect(mustDialog().textContent).toContain("community: conflict in foo.py");
  });
});

describe("Code tab — push", () => {
  it("Push asks first, then pushes the branch to the push remote", async () => {
    await mountCode({ routes: { "/api/code/branch/push": { ok: true } } });
    await menuAction("community", "Push");
    expect(dialogTitle()).toBe('Push "master-feat"?');
    expect(mustDialog().textContent).toContain("Push master-feat (community) to the dev remote?");
    await click(dialogButton("Push"));
    expect(app.callsTo("/api/code/branch/push").map((c) => c.body)).toEqual([
      {
        path: "/home/odoo/work/community",
        branch: "master-feat",
        force: false,
        push_remote: "dev",
      },
    ]);
  });

  it("cancelling the push confirmation pushes nothing", async () => {
    await mountCode();
    await menuAction("community", "Push (force)");
    expect(dialogTitle()).toBe('Force-push "master-feat"?');
    await click(dialogButton("Discard"));
    expect(app.callsTo("/api/code/branch/push")).toEqual([]);
    expect(dialogTitle()).toBe("");
  });

  it("Push (force) pushes with force", async () => {
    await mountCode({ routes: { "/api/code/branch/push": { ok: true } } });
    await menuAction("enterprise", "Push (force)");
    await click(dialogButton("Force push"));
    const [call] = app.callsTo("/api/code/branch/push");
    expect(call.body).toMatchObject({
      branch: "master-feat",
      force: true,
      path: "/home/odoo/work/enterprise",
    });
  });

  it("Push all pushes every unsynced work branch after one confirmation", async () => {
    await mountCode({ routes: { "/api/code/branch/push": { ok: true } } });
    const all = toolbar("Push all");
    expect(all.title).toBe("push master-feat (community) to dev, master-feat (enterprise) to dev");
    await click(all);
    expect(dialogTitle()).toBe("Push 2 branches?");
    await click(dialogButton("Push"));
    expect(
      app.callsTo("/api/code/branch/push").map((c) => (c.body as { path: string }).path),
    ).toEqual(["/home/odoo/work/community", "/home/odoo/work/enterprise"]);
  });

  it("Push all (force) force-pushes the batch", async () => {
    await mountCode({ routes: { "/api/code/branch/push": { ok: true } } });
    const all = toolbar("Push all (force)");
    expect(all.title).toContain("with --force-with-lease");
    await click(all);
    expect(dialogTitle()).toBe("Force-push 2 branches?");
    await click(dialogButton("Force push"));
    const pushes = app.callsTo("/api/code/branch/push");
    expect(pushes).toHaveLength(2);
    expect(pushes.every((c) => (c.body as { force: boolean }).force)).toBe(true);
  });

  it("Push all is disabled once every work branch is in sync with its remote", async () => {
    await mountCode({
      repos: featRepos({ branches: [branch("master-feat", { synced: true })] }),
    });
    expect(toolbar("Push all").disabled).toBe(true);
    expect(toolbar("Push all").title).toContain("already in sync");
    expect(toolbar("Push all (force)").title).toContain("already in sync");
  });

  it("a failed push opens an error dialog", async () => {
    await mountCode({
      routes: {
        "/api/code/branch/push": new Response(JSON.stringify({ error: "rejected" }), {
          status: 500,
        }),
      },
    });
    await menuAction("community", "Push");
    await click(dialogButton("Push"));
    expect(dialogTitle()).toBe("Push failed");
    expect(mustDialog().textContent).toContain("rejected");
  });
});

describe("Code tab — local changes", () => {
  const dirty = () => featRepos({ dirty: true });

  it("a dirty checkout offers commit / WIP / amend / discard", async () => {
    await mountCode({ repos: dirty() });
    await openMenu("community");
    expect(menuItems(card(app.root, "community"))).toEqual(
      expect.arrayContaining(["Commit", "WIP commit", "Amend commit", "Discard changes"]),
    );
  });

  it("a clean checkout offers none of them", async () => {
    await mountCode();
    await openMenu("community");
    expect(menuItems(card(app.root, "community"))).not.toContain("Commit");
  });

  it("Commit asks for a message, then commits with it", async () => {
    await mountCode({ repos: dirty(), routes: { "/api/code/commit": { ok: true } } });
    await menuAction("community", "Commit");
    expect(dialogTitle()).toBe("Commit — community");
    const ok = dialogButton("Commit");
    expect(ok.disabled).toBe(true); // a message is required
    typeInto(mustDialog().querySelector("textarea")!, "  [FIX] web: a fix  ");
    await app.settle();
    await click(dialogButton("Commit"));
    expect(app.callsTo("/api/code/commit").map((c) => c.body)).toEqual([
      { path: "/home/odoo/work/community", message: "[FIX] web: a fix" },
    ]);
  });

  it("discarding the commit dialog commits nothing", async () => {
    await mountCode({ repos: dirty() });
    await menuAction("community", "Commit");
    await click(dialogButton("Discard"));
    expect(app.callsTo("/api/code/commit")).toEqual([]);
  });

  it("WIP commit commits straight away and refreshes the repo", async () => {
    const git = await mountCode({
      repos: dirty(),
      routes: {
        "/api/code/wip-commit": () => {
          git.repos.community = { ...git.repos.community, dirty: false };
          return { ok: true };
        },
      },
    });
    expect(card(app.root, "community").querySelector(".ws-co-badges")!.innerHTML).toContain(
      "dirty",
    );
    await menuAction("community", "WIP commit");
    expect(app.callsTo("/api/code/wip-commit").map((c) => c.body)).toEqual([
      { path: "/home/odoo/work/community" },
    ]);
    await openMenu("community");
    expect(menuItems(card(app.root, "community"))).not.toContain("WIP commit");
  });

  it("Amend prefills the full HEAD message and amends with the edit", async () => {
    await mountCode({
      repos: dirty(),
      routes: {
        "/api/code/log": {
          ok: true,
          commits: [
            {
              sha: "sha-community",
              subject: "feat community",
              body: "details here",
              author: "me",
              date: "",
            },
          ],
        },
        "/api/code/amend": { ok: true },
      },
    });
    await menuAction("community", "Amend commit");
    expect(dialogTitle()).toBe("Amend commit — community");
    const ta = mustDialog().querySelector("textarea")!;
    expect(ta.value).toBe("feat community\n\ndetails here");
    typeInto(ta, "feat community v2");
    await app.settle();
    await click(dialogButton("Amend"));
    expect(app.callsTo("/api/code/amend").map((c) => c.body)).toEqual([
      { path: "/home/odoo/work/community", message: "feat community v2" },
    ]);
  });

  it("Amend falls back to the subject when the full message can't be read", async () => {
    await mountCode({
      repos: dirty(),
      routes: { "/api/code/log": new Response("{}", { status: 500 }) },
    });
    await menuAction("community", "Amend commit");
    expect(mustDialog().querySelector("textarea")!.value).toBe("feat community");
  });

  it("Discard changes asks first; confirming discards", async () => {
    await mountCode({ repos: dirty(), routes: { "/api/code/discard": { ok: true } } });
    await menuAction("community", "Discard changes");
    expect(dialogTitle()).toBe("Discard changes in community?");
    await click(dialogButton("Discard changes"));
    expect(app.callsTo("/api/code/discard").map((c) => c.body)).toEqual([
      { path: "/home/odoo/work/community" },
    ]);
  });

  it("cancelling the discard confirmation keeps the changes", async () => {
    await mountCode({ repos: dirty() });
    await menuAction("community", "Discard changes");
    await click(dialogButton("Discard"));
    expect(app.callsTo("/api/code/discard")).toEqual([]);
  });

  it("a failed commit shows an error dialog", async () => {
    await mountCode({
      repos: dirty(),
      routes: {
        "/api/code/wip-commit": new Response(JSON.stringify({ error: "hook failed" }), {
          status: 500,
        }),
      },
    });
    await menuAction("community", "WIP commit");
    expect(dialogTitle()).toBe("WIP commit failed");
    expect(mustDialog().textContent).toContain("hook failed");
  });
});

describe("Code tab — pull requests", () => {
  it("shows the checkout's PR pills with their state", async () => {
    await mountCode({
      prs: {
        community: [prWire({ number: 101 })],
        enterprise: [
          prWire({
            github: "odoo/enterprise",
            number: 202,
            draft: true,
            url: "https://github.com/odoo/enterprise/pull/202",
          }),
        ],
      },
    });
    const pill = card(app.root, "community").querySelector(".pr-pill")!;
    expect(pill.querySelector("a")!.textContent).toBe("#101");
    expect(pill.querySelector(".pr-state")!.textContent).toBe("open");
    expect(card(app.root, "enterprise").querySelector(".pr-state")!.textContent).toBe("draft");
    expect(card(app.root, "community").textContent).not.toContain("no pull request");
  });

  it("the heading copies every checkout's PR link at once", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await mountCode({
      prs: {
        community: [prWire({ number: 101 })],
        enterprise: [
          prWire({
            github: "odoo/enterprise",
            number: 202,
            url: "https://github.com/odoo/enterprise/pull/202",
          }),
        ],
      },
    });
    const copy = app.root.querySelector<HTMLButtonElement>(".ws-sec-copy")!;
    expect(copy.textContent).toContain("2 prs");
    await click(copy);
    expect(writeText).toHaveBeenCalledWith(
      "https://github.com/odoo/odoo/pull/101 https://github.com/odoo/enterprise/pull/202",
    );
    expect(copy.textContent).toContain("copied");
  });

  it("Set PR to ready marks the draft ready and the pill turns open", async () => {
    await mountCode({
      prs: { community: [prWire({ draft: true })] },
      routes: { "/api/prs/ready": { ok: true } },
    });
    await menuAction("community", "Set PR to ready");
    expect(app.callsTo("/api/prs/ready").map((c) => c.body)).toEqual([
      { repo: "odoo/odoo", number: 101 },
    ]);
    expect(card(app.root, "community").querySelector(".pr-state")!.textContent).toBe("open");
  });

  it("Post r+ posts robodoo r+ on the checkout's PR", async () => {
    await mountCode({
      prs: { community: [prWire()] },
      routes: { "/api/prs/r-plus": { ok: true } },
    });
    await menuAction("community", "Post r+");
    expect(app.callsTo("/api/prs/r-plus").map((c) => c.body)).toEqual([
      { repo: "odoo/odoo", number: 101 },
    ]);
  });

  it("a failed r+ shows an error dialog", async () => {
    await mountCode({
      prs: { community: [prWire()] },
      routes: {
        "/api/prs/r-plus": new Response(JSON.stringify({ error: "no rights" }), { status: 403 }),
      },
    });
    await menuAction("community", "Post r+");
    expect(dialogTitle()).toBe("Post r+ failed");
  });

  it("Open PR opens GitHub's compare page for a pushed, PR-less branch", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    await mountCode();
    await menuAction("community", "Open PR");
    expect(open).toHaveBeenCalledTimes(1);
    const [url, target] = open.mock.calls[0] as unknown as [string, string];
    expect(url).toContain("github.com/odoo/odoo/compare");
    expect(url).toContain("master-feat");
    expect(target).toBe("_blank");
  });
});

describe("Code tab — editor & terminal", () => {
  it("Editor opens every repo folder in the configured editor in one call", async () => {
    await mountCode({ config: { editor: "nvim" }, routes: { "/api/open-editor": { ok: true } } });
    const editor = toolbar("Editor");
    expect(editor.title).toBe("open 2 repositories in nvim");
    await click(editor);
    expect(app.callsTo("/api/open-editor").map((c) => c.body)).toEqual([
      { editor: "nvim", paths: ["/home/odoo/work/community", "/home/odoo/work/enterprise"] },
    ]);
  });

  it("Open with editor opens just that repo; a failure shows a dialog", async () => {
    await mountCode({
      routes: {
        "/api/open-editor": new Response(JSON.stringify({ error: "no such editor" }), {
          status: 500,
        }),
      },
    });
    await menuAction("enterprise", "Open with editor");
    expect(app.callsTo("/api/open-editor").map((c) => c.body)).toEqual([
      { editor: "code", paths: ["/home/odoo/work/enterprise"] },
    ]);
    expect(dialogTitle()).toBe("Could not open the editor");
  });

  it("Open in terminal opens a terminal panel in the repo", async () => {
    await mountCode();
    await menuAction("community", "Open in terminal");
    expect(app.root.querySelector(".term-panel-title")!.textContent).toBe("community");
  });

  it("the actions menu closes on an outside click", async () => {
    await mountCode();
    await openMenu("community");
    expect(card(app.root, "community").querySelector(".dash-menu")).not.toBeNull();
    await click(document.body);
    expect(card(app.root, "community").querySelector(".dash-menu")).toBeNull();
  });
});

describe("Code tab — forward ports", () => {
  const merged = (rows: unknown[]) => ({
    "/api/mergebot": {
      states: { "odoo/odoo#101": "merged" },
      details: {},
      forward_ports: { "odoo/odoo#101": rows },
    },
  });

  it("lists a merged PR's forward-port chain with each target's PRs", async () => {
    await mountCode({
      ws: workspace({ checkouts: [{ repo: "community", branch: "master-feat" }] }),
      prs: { community: [prWire({ state: "merged" })] },
      routes: merged([
        forwardPortRow("saas-19.1", [{ repository: "odoo/odoo", number: 150, status: "merged" }]),
        forwardPortRow("saas-19.2", [{ repository: "odoo/odoo" }]),
      ]),
    });
    const chain = app.root.querySelector(".ws-fp-chain")!;
    expect(app.root.textContent).toContain("Forward ports");
    expect(chain.querySelector(".ws-fp-origin .pr-link")!.textContent).toBe("#101");
    const rows = [...chain.querySelectorAll(".ws-fp-row")];
    expect(rows.map((r) => r.querySelector(".ws-fp-branch")!.textContent)).toEqual([
      "saas-19.1",
      "saas-19.2",
    ]);
    // a row with a PR links its branch to mergebot; a row still waiting doesn't
    expect(rows[0].querySelector("a.ws-fp-branch")).not.toBeNull();
    expect(rows[0].querySelector(".ws-fp-pull")!.textContent).toContain("#150");
    expect(rows[1].querySelector("a.ws-fp-branch")).toBeNull();
    expect(rows[1].textContent).toContain("waiting");
    // one repository per cell: no per-cell repo label
    expect(chain.querySelector(".ws-fp-repo")).toBeNull();
    expect(mustText(rows[0] as HTMLElement, "Create sub workspace")).toBeTruthy();
  });

  it("shows nothing for a PR that isn't merged", async () => {
    await mountCode({
      prs: { community: [prWire()] },
      routes: {
        "/api/mergebot": {
          states: { "odoo/odoo#101": "ready" },
          forward_ports: {
            "odoo/odoo#101": [
              forwardPortRow("saas-19.1", [{ repository: "odoo/odoo", number: 150 }]),
            ],
          },
        },
      },
    });
    expect(app.root.querySelector(".ws-fp-chain")).toBeNull();
  });

  it("labels each repository of a multi-repo chain", async () => {
    await mountCode({
      ws: workspace({ checkouts: [{ repo: "community", branch: "master-feat" }] }),
      prs: { community: [prWire({ state: "merged" })] },
      routes: merged([
        forwardPortRow("saas-19.1", [
          { repository: "odoo/odoo", number: 150 },
          { repository: "odoo/enterprise", number: 151 },
        ]),
      ]),
    });
    const repos = [...app.root.querySelectorAll(".ws-fp-repo")].map((e) => e.textContent);
    expect(repos).toEqual(["odoo/odoo", "odoo/enterprise"]);
  });

  it("posts a missing r+ from the chain and marks it posted", async () => {
    await mountCode({
      ws: workspace({ checkouts: [{ repo: "community", branch: "master-feat" }] }),
      prs: { community: [prWire({ state: "merged" })] },
      routes: {
        ...merged([
          forwardPortRow("saas-19.1", [
            { repository: "odoo/odoo", number: 150, status: "ready", detail: "missing r+" },
          ]),
        ]),
        "/api/prs/r-plus": { ok: true },
      },
    });
    const btn = app.root.querySelector<HTMLButtonElement>(".ws-fp-rplus")!;
    expect(btn.textContent).toBe("post r+");
    await click(btn);
    expect(app.callsTo("/api/prs/r-plus").map((c) => c.body)).toEqual([
      { repo: "odoo/odoo", number: 150 },
    ]);
    expect(btn.textContent).toBe("posted");
    expect(btn.disabled).toBe(true);
  });

  it("a failed r+ from the chain re-enables the button", async () => {
    await mountCode({
      ws: workspace({ checkouts: [{ repo: "community", branch: "master-feat" }] }),
      prs: { community: [prWire({ state: "merged" })] },
      routes: {
        ...merged([
          forwardPortRow("saas-19.1", [
            { repository: "odoo/odoo", number: 150, status: "missing r+" },
          ]),
        ]),
        "/api/prs/r-plus": new Response(JSON.stringify({ error: "nope" }), { status: 500 }),
      },
    });
    const btn = app.root.querySelector<HTMLButtonElement>(".ws-fp-rplus")!;
    await click(btn);
    expect(btn.textContent).toBe("post r+");
    expect(btn.disabled).toBe(false);
    expect(dialogTitle()).toBe("Post r+ failed");
  });

  it("offers to open an existing sub workspace instead of creating another", async () => {
    const parent = workspace({ checkouts: [{ repo: "community", branch: "master-feat" }] });
    const child = workspace({
      id: "w2",
      name: "saas-19.1-feat-fw",
      parent: "w1",
      checkouts: [{ repo: "community", branch: "saas-19.1-master-feat-abcd-fw" }],
    });
    await mountCode({
      workspaces: [parent, child],
      prs: { community: [prWire({ state: "merged" })] },
      routes: merged([forwardPortRow("saas-19.1", [{ repository: "odoo/odoo", number: 150 }])]),
    });
    await click(mustText(app.root.querySelector(".ws-fp-row")!, "Open sub workspace"));
    expect(app.root.querySelector(".wt-detail-name")!.textContent).toBe("saas-19.1-feat-fw");
  });
});

describe("Code tab — worktree workspace", () => {
  it("reads and acts on the worktree's own checkout, not the main one", async () => {
    const ws = workspace({
      id: "w9",
      location: "worktree",
      worktree: { dir: "/wt/master-feat" },
      checkouts: [{ repo: "community", branch: "master-feat" }],
    });
    await mountCode({
      ws,
      repos: {
        // the main checkout is elsewhere; the worktree's own row is keyed "<ws>:<repo>"
        community: { current: "master", branches: [branch("master")] },
        "w9:community": {
          current: "master-feat",
          dirty: false,
          ahead: 1,
          behind: 3,
          branches: [branch("master-feat", { subject: "wt commit" })],
        },
      },
      routes: { "/api/code/rebase": { results: [] } },
    });
    const c = card(app.root, "community");
    expect(c.querySelector(".ws-commit")!.textContent).toContain("wt commit");
    expect(c.querySelector(".ws-sync")!.textContent).toContain("3 behind");
    await click(c.querySelector<HTMLElement>(".ws-rebase-inline")!);
    const [call] = app.callsTo("/api/code/rebase");
    expect((call.body as { repos: { path: string }[] }).repos[0].path).toBe(
      "/wt/master-feat/community",
    );
  });
});
