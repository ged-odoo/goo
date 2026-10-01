// The commit-history editor (Code tab → a checkout's "See commits"), mounted in the
// whole app: browsing commits + diffs, and rewriting the branch's own commits
// (squash / reorder / drop / reword) as one rebase plan, plus conflict recovery.
import { afterEach, describe, expect, it } from "vitest";
import { mountApp, type MountedApp, type Route } from "../helpers/app.ts";
import type { Commit } from "../../src/core/code_plugin.ts";
import {
  card,
  dialogButton,
  dialogTitle,
  featRepos,
  gitBackend,
  mustDialog,
  mustText,
  typeInto,
  workspace,
} from "../helpers/code_fixtures.ts";

let app: MountedApp;
afterEach(() => app?.destroy());

const commit = (sha: string, subject: string, over: Partial<Commit> = {}): Commit => ({
  sha,
  subject,
  body: "",
  author: "Jane",
  date: "2026-01-01T00:00:00Z",
  ahead: true,
  ...over,
});

// newest first, as /api/code/log returns them; the head is the card's branch tip
const COMMITS = [
  commit("sha-community", "third"),
  commit("c2", "second", { body: "second body" }),
  commit("c1", "first"),
  commit("b0", "base commit", { ahead: false, author: "Bob", body: "inherited body" }),
];

const DIFF = [
  "diff --git a/f.py b/f.py",
  "index 1..2 100644",
  "--- a/f.py",
  "+++ b/f.py",
  "@@ -1,2 +1,2 @@",
  "-old",
  "+new",
  "+more",
  " same",
].join("\n");

const failure = (status: number, body: object) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function mountHistory(routes: Record<string, Route> = {}, commits: Commit[] = COMMITS) {
  const git = gitBackend(featRepos());
  app = await mountApp({
    section: "workspaces",
    config: {
      workspaces: [workspace({ checkouts: [{ repo: "community", branch: "master-feat" }] })],
    },
    routes: {
      "/api/code/branches": (body: unknown) => git.route(body),
      "/api/prs": { repos: [] },
      "/api/prs/for-branches": { prs: [] },
      "/api/databases": { ok: true, databases: [] },
      "/api/code/log": { ok: true, commits },
      "/api/code/rebase-status": { ok: true, in_progress: false },
      "/api/code/commit/diff": (body: unknown) => ({
        ok: true,
        diff: (body as { sha: string }).sha === "sha-community" ? DIFF : "",
      }),
      ...routes,
    },
  });
  await openHistory();
}

async function click(el: HTMLElement) {
  el.click();
  await app.settle();
}

async function openHistory() {
  await click(card(app.root, "community").querySelector<HTMLElement>(".ws-co-id")!);
}

const history = () => app.root.querySelector<HTMLElement>(".ws-history")!;
const rowTitles = () =>
  [...history().querySelectorAll(".ws-history-commit-title")].map((e) => e.textContent);
const row = (subject: string) =>
  [...history().querySelectorAll<HTMLElement>(".ws-history-row")].find(
    (r) => r.querySelector(".ws-history-commit-title")!.textContent === subject,
  )!;
const titleInput = () => history().querySelector<HTMLInputElement>(".ws-history-title-input");
const foot = () => history().querySelector<HTMLElement>(".commits-foot");
const plans = () =>
  app.callsTo("/api/code/rebase-plan").map((c) => c.body as { plan: object[]; base: string });

async function selectCommit(subject: string) {
  await click(row(subject).querySelector<HTMLElement>(".ws-history-commit")!);
}

describe("Commit history — browsing", () => {
  it("opens on the branch's commits with the head commit and its diff", async () => {
    await mountHistory();
    const [log] = app.callsTo("/api/code/log");
    expect(log.body).toEqual({
      path: "/home/odoo/work/community",
      ref: "master-feat",
      base: "master",
      pull_remote: "origin",
      count: 100,
    });
    expect(history().querySelector(".ws-history-head")!.textContent).toContain("community");
    expect(history().querySelector(".ws-history-head")!.textContent).toContain("master-feat");
    expect(rowTitles()).toEqual(["third", "second", "first", "base commit"]);
    expect(row("third").classList.contains("selected")).toBe(true);
    // the diff, minus git's header lines, each line classed by kind
    const lines = [...history().querySelectorAll(".ws-history-diff-line")];
    expect(lines.map((l) => l.textContent)).toEqual([
      "--- a/f.py",
      "+++ b/f.py",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      "+more",
      " same",
    ]);
    expect(lines.map((l) => l.className.replace("ws-history-diff-line", "").trim())).toEqual([
      "meta",
      "meta",
      "hunk",
      "del",
      "add",
      "add",
      "",
    ]);
    expect(history().querySelector(".ws-history-diffstats")!.textContent).toBe("+2-1");
    // the branch's own commits are editable
    expect(titleInput()!.value).toBe("third");
    expect(history().querySelector(".ws-history-hash")!.textContent).toBe("sha-community");
  });

  it("selecting another commit loads its diff; an inherited commit is read-only", async () => {
    await mountHistory();
    await selectCommit("base commit");
    const diffs = app.callsTo("/api/code/commit/diff").map((c) => (c.body as { sha: string }).sha);
    expect(diffs.at(-1)).toBe("b0");
    expect(row("base commit").classList.contains("selected")).toBe(true);
    expect(titleInput()).toBeNull();
    expect(history().querySelector("h2.ws-history-title")!.textContent).toBe("base commit");
    expect(history().querySelector("pre.ws-history-body")!.textContent).toBe("inherited body");
    expect(history().querySelector(".ws-history-diff-state")!.textContent).toContain(
      "no file changes",
    );
  });

  it("a diff that fails to load shows the error in place", async () => {
    await mountHistory({
      "/api/code/commit/diff": (body: unknown) =>
        (body as { sha: string }).sha === "c2"
          ? { ok: false, error: "bad object c2" }
          : { ok: true, diff: DIFF },
    });
    await selectCommit("second");
    expect(history().querySelector(".ws-history-diff-state.form-error")!.textContent).toBe(
      "bad object c2",
    );
  });

  it("loads the returned head's diff when the branch moved since the card was drawn", async () => {
    await mountHistory({}, [commit("newer", "newer head"), ...COMMITS]);
    const shas = app.callsTo("/api/code/commit/diff").map((c) => (c.body as { sha: string }).sha);
    expect(shas).toEqual(["sha-community", "newer"]);
    expect(row("newer head").classList.contains("selected")).toBe(true);
  });

  it("the back button and Escape return to the checkout cards", async () => {
    await mountHistory();
    await click(history().querySelector<HTMLElement>(".ws-history-back")!);
    expect(app.root.querySelector(".ws-history")).toBeNull();
    expect(card(app.root, "community")).toBeTruthy();
    await openHistory();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await app.settle();
    expect(app.root.querySelector(".ws-history")).toBeNull();
  });

  it("the actions menu's See commits opens the same view", async () => {
    await mountHistory();
    await click(history().querySelector<HTMLElement>(".ws-history-back")!);
    await click(card(app.root, "community").querySelector<HTMLElement>(".ws-co-menu .dash-kebab")!);
    await click(mustText(card(app.root, "community"), "See commits"));
    expect(rowTitles()).toHaveLength(4);
  });

  it("an unreadable history opens an error dialog and stays on the cards", async () => {
    await mountHistory({ "/api/code/log": { ok: false, error: "unknown revision" } });
    expect(app.root.querySelector(".ws-history")).toBeNull();
    expect(dialogTitle()).toBe("Could not load commit history");
    expect(mustDialog().textContent).toContain("unknown revision");
  });

  it("a branch with no commits is reported", async () => {
    await mountHistory({}, []);
    expect(dialogTitle()).toBe("Could not load commit history");
    expect(mustDialog().textContent).toContain("No commits found for master-feat.");
  });
});

describe("Commit history — rewriting", () => {
  it("squash marks the plan, Apply sends it oldest-first and reloads", async () => {
    await mountHistory({ "/api/code/rebase-plan": { ok: true } });
    // the oldest own commit has nothing of its own below it to squash into
    expect(row("first").querySelector(".commit-squash-btn")).toBeNull();
    expect(row("base commit").querySelector(".commit-squash-btn")).toBeNull();
    await click(row("third").querySelector<HTMLElement>(".commit-squash-btn")!);
    expect(row("third").querySelector(".commit-squash-btn")!.classList.contains("on")).toBe(true);
    expect(foot()!.textContent).toContain("3 commits → 2");
    const logsBefore = app.callsTo("/api/code/log").length;
    await click(mustText(foot()!, "Apply"));
    expect(plans()).toEqual([
      {
        path: "/home/odoo/work/community",
        base: "master",
        pull_remote: "origin",
        plan: [
          { sha: "c1", squash: false, drop: false },
          { sha: "c2", squash: false, drop: false },
          { sha: "sha-community", squash: true, drop: false },
        ],
      },
    ]);
    // reloaded: history re-fetched and the pending plan is gone
    expect(app.callsTo("/api/code/log").length).toBe(logsBefore + 1);
    expect(foot()).toBeNull();
  });

  it("Reset drops the pending plan without touching git", async () => {
    await mountHistory();
    await click(row("second").querySelector<HTMLElement>(".commit-squash-btn")!);
    await click(mustText(foot()!, "Reset"));
    expect(foot()).toBeNull();
    expect(plans()).toEqual([]);
  });

  it("toggling a squash twice undoes it", async () => {
    await mountHistory();
    const btn = () => row("second").querySelector<HTMLElement>(".commit-squash-btn")!;
    await click(btn());
    await click(btn());
    expect(foot()).toBeNull();
  });

  it("dragging a commit reorders the plan", async () => {
    await mountHistory({ "/api/code/rebase-plan": { ok: true } });
    const handle = row("first").querySelector<HTMLElement>(".row-handle")!;
    handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientY: 0 }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientY: -10 }));
    window.dispatchEvent(new MouseEvent("pointerup"));
    await app.settle();
    expect(rowTitles()).toEqual(["first", "third", "second", "base commit"]);
    expect(foot()!.textContent).toContain("reordered");
    await click(mustText(foot()!, "Apply"));
    expect(plans()[0].plan.map((s) => (s as { sha: string }).sha)).toEqual([
      "c2",
      "sha-community",
      "c1",
    ]);
  });

  it("Escape during a drag puts the commit back", async () => {
    await mountHistory();
    const handle = row("first").querySelector<HTMLElement>(".row-handle")!;
    handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientY: 0 }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientY: -10 }));
    await app.settle();
    expect(rowTitles()[0]).toBe("first");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await app.settle();
    expect(rowTitles()).toEqual(["third", "second", "first", "base commit"]);
    expect(foot()).toBeNull();
  });

  it("editing a message applies it when focus leaves the message fields", async () => {
    await mountHistory({ "/api/code/rebase-plan": { ok: true } });
    await selectCommit("second");
    expect(history().querySelector<HTMLTextAreaElement>(".ws-history-body-input")!.value).toBe(
      "second body",
    );
    typeInto(titleInput()!, "  second, reworded ");
    await app.settle();
    // moving between title and body is one editing zone — nothing applied yet
    titleInput()!.dispatchEvent(
      new FocusEvent("focusout", {
        bubbles: true,
        relatedTarget: history().querySelector(".ws-history-body-input"),
      }),
    );
    await app.settle();
    expect(plans()).toEqual([]);
    titleInput()!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await app.settle();
    expect(plans()[0].plan).toEqual([
      { sha: "c1", squash: false, drop: false },
      { sha: "c2", squash: false, drop: false, message: "second, reworded\n\nsecond body" },
      { sha: "sha-community", squash: false, drop: false },
    ]);
  });

  it("an empty title is flagged and never applied", async () => {
    await mountHistory();
    typeInto(titleInput()!, "   ");
    await app.settle();
    expect(titleInput()!.classList.contains("invalid")).toBe(true);
    titleInput()!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await app.settle();
    expect(plans()).toEqual([]);
  });

  it("editing a message back to the original leaves nothing pending", async () => {
    await mountHistory();
    typeInto(titleInput()!, "changed");
    await app.settle();
    typeInto(titleInput()!, "third");
    await app.settle();
    titleInput()!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await app.settle();
    expect(plans()).toEqual([]);
  });

  it("Drop commit asks first, then drops it", async () => {
    await mountHistory({ "/api/code/rebase-plan": { ok: true } });
    await selectCommit("second");
    await click(history().querySelector<HTMLElement>(".ws-history-actions .dash-kebab")!);
    await click(mustText(history(), "Drop commit"));
    expect(dialogTitle()).toBe('Drop "second"?');
    await click(dialogButton("Drop"));
    expect(plans()[0].plan).toEqual([
      { sha: "c1", squash: false, drop: false },
      { sha: "c2", squash: false, drop: true },
      { sha: "sha-community", squash: false, drop: false },
    ]);
  });

  it("cancelling the drop confirmation drops nothing", async () => {
    await mountHistory();
    await click(history().querySelector<HTMLElement>(".ws-history-actions .dash-kebab")!);
    await click(mustText(history(), "Drop commit"));
    await click(dialogButton("Discard"));
    expect(plans()).toEqual([]);
  });

  it("Drop is unavailable while a reorder/squash is pending", async () => {
    await mountHistory();
    await click(row("second").querySelector<HTMLElement>(".commit-squash-btn")!);
    await click(history().querySelector<HTMLElement>(".ws-history-actions .dash-kebab")!);
    const drop = mustText(history(), "Drop commit");
    expect(drop.disabled).toBe(true);
    expect(drop.title).toContain("apply or reset");
  });

  it("a failed rewrite that left nothing behind opens an error dialog", async () => {
    await mountHistory({
      "/api/code/rebase-plan": failure(400, { error: "plan does not match the branch" }),
    });
    await click(row("third").querySelector<HTMLElement>(".commit-squash-btn")!);
    await click(mustText(foot()!, "Apply"));
    expect(dialogTitle()).toBe("Edit history failed");
    expect(mustDialog().textContent).toContain("plan does not match the branch");
    expect(history().querySelector(".commits-conflict")).toBeNull();
  });
});

describe("Commit history — rebase conflicts", () => {
  it("a conflicting rewrite shows a persistent banner; Abort restores and reloads", async () => {
    await mountHistory({
      "/api/code/rebase-plan": failure(409, { error: "CONFLICT in f.py", in_progress: true }),
      "/api/code/rebase-abort": { ok: true },
    });
    await click(row("second").querySelector<HTMLElement>(".commit-squash-btn")!);
    await click(mustText(foot()!, "Apply"));
    const banner = history().querySelector<HTMLElement>(".commits-conflict")!;
    expect(banner.textContent).toContain("CONFLICT in f.py");
    expect(dialogTitle()).toBe("");
    // the history is frozen while the rebase is mid-flight
    expect(titleInput()!.disabled).toBe(true);
    expect(history().querySelector(".row-handle")).toBeNull();
    const logsBefore = app.callsTo("/api/code/log").length;
    await click(mustText(banner, "Abort rebase"));
    expect(app.callsTo("/api/code/rebase-abort").map((c) => c.body)).toEqual([
      { path: "/home/odoo/work/community" },
    ]);
    expect(app.callsTo("/api/code/log").length).toBe(logsBefore + 1);
    expect(history().querySelector(".commits-conflict")).toBeNull();
  });

  it("a rebase already stuck from earlier is shown as soon as the history opens", async () => {
    await mountHistory({ "/api/code/rebase-status": { ok: true, in_progress: true } });
    expect(history().querySelector(".commits-conflict")!.textContent).toContain(
      "a rebase is already in progress in this repository",
    );
    expect(history().querySelector(".commit-squash-btn")).toBeNull();
  });

  it("a rebase-status check that fails doesn't block the history", async () => {
    await mountHistory({ "/api/code/rebase-status": { ok: false, error: "boom" } });
    expect(rowTitles()).toHaveLength(4);
    expect(history().querySelector(".commits-conflict")).toBeNull();
  });

  it("a failed abort keeps the banner and reports the error", async () => {
    await mountHistory({
      "/api/code/rebase-status": { ok: true, in_progress: true },
      "/api/code/rebase-abort": { ok: false, error: "no rebase in progress?" },
    });
    await click(mustText(history().querySelector(".commits-conflict")!, "Abort rebase"));
    expect(dialogTitle()).toBe("Abort failed");
    expect(mustDialog().textContent).toContain("no rebase in progress?");
  });

  it("Open terminal opens a shell in the repo to resolve it by hand", async () => {
    await mountHistory({ "/api/code/rebase-status": { ok: true, in_progress: true } });
    await click(mustText(history().querySelector(".commits-conflict")!, "Open terminal"));
    expect(app.root.querySelector(".term-panel-title")!.textContent).toBe("community history");
  });
});
