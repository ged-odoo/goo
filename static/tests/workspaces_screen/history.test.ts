// The commit-history editor (Code tab → a checkout's "See commits"), mounted in the
// whole app: browsing commits + diffs, and rewriting the branch's own commits
// (squash / reorder / drop / reword) as one rebase plan, plus conflict recovery.
import { afterEach, describe, expect, it, vi } from "vitest";
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
afterEach(() => {
  app?.destroy();
  vi.unstubAllGlobals();
});

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
  "--- a dashed line",
  " same",
  "diff --git a/g.py b/g.py",
  "new file mode 100644",
  "index 0..3",
  "--- /dev/null",
  "+++ b/g.py",
  "@@ -0,0 +1 @@",
  "+added",
  "diff --git a/old/h.py b/new/h.py",
  "similarity index 100%",
  "rename from old/h.py",
  "rename to new/h.py",
  "diff --git a/run.sh b/run.sh",
  "old mode 100644",
  "new mode 100755",
  "", // git's output ends with a newline
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
    // the diff, one block per file headed by its path (old → new for a rename),
    // minus git's path-only header lines, each line classed by kind
    const files = [...history().querySelectorAll(".ws-history-diff-file")];
    expect(files.map((f) => f.querySelector(".ws-history-diff-file-path")!.textContent)).toEqual([
      "f.py",
      "g.py",
      "old/h.py → new/h.py",
      "run.sh",
    ]);
    const code = (f: Element) =>
      [...f.querySelectorAll(".ws-history-diff-code")].map((c) => c.textContent);
    expect(files.map(code)).toEqual([
      // f.py ends on its closing row (the expander down to the end of the file);
      // the new g.py is whole, it has none
      ["@@ -1,2 +1,2 @@", "old", "new", "more", "-- a dashed line", "same", ""],
      ["new file mode 100644", "@@ -0,0 +1 @@", "added"],
      ["similarity index 100%"],
      ["old mode 100644", "new mode 100755"],
    ]);
    // the margin: old + new line numbers (counted from the hunk header) and the sign,
    // none of it selectable, so a copied selection holds only the code
    const lines = [...files[0].querySelectorAll(".ws-history-diff-line")].slice(0, -1);
    const margin = (l: Element) =>
      [...l.querySelectorAll(".ws-history-diff-num, .ws-history-diff-sign")].map(
        (c) => c.textContent,
      );
    expect(lines.map(margin)).toEqual([
      ["", "", ""],
      ["1", "", "-"],
      ["", "1", "+"],
      ["", "2", "+"],
      ["2", "", "-"],
      ["3", "3", ""],
    ]);
    expect(margin(files[1].querySelectorAll(".ws-history-diff-line")[2])).toEqual(["", "1", "+"]);
    expect(lines.map((l) => l.className.replace("ws-history-diff-line", "").trim())).toEqual([
      "hunk",
      "del",
      "add",
      "add",
      "del",
      "",
    ]);
    expect(history().querySelector(".ws-history-diffstats")!.textContent).toBe("+3-2");
    // the branch's own commits are editable
    expect(titleInput()!.value).toBe("third");
    expect(history().querySelector(".ws-history-hash")!.textContent).toBe("sha-community");
  });

  it("each file header counts its own changes and copies its path", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await mountHistory();
    const files = () => [...history().querySelectorAll(".ws-history-diff-file")];
    expect(files().map((f) => f.querySelector(".ws-history-diffstats")!.textContent)).toEqual([
      "+2-2",
      "+1-0",
      "+0-0",
      "+0-0",
    ]);
    const copy = (i: number) => files()[i].querySelector<HTMLButtonElement>(".ws-sec-copy")!;
    await click(copy(2));
    // a rename copies its new path
    expect(writeText).toHaveBeenCalledWith("new/h.py");
    expect(copy(2).textContent).toBe("copied");
    expect(copy(0).textContent).toBe("");
    await click(copy(0));
    expect(writeText).toHaveBeenLastCalledWith("f.py");
    expect(copy(0).textContent).toBe("copied");
    expect(copy(2).textContent).toBe("");
  });

  it("reveals the unchanged lines around the hunks, 15 at a time", async () => {
    const diff = [
      "diff --git a/big.py b/big.py",
      "--- a/big.py",
      "+++ b/big.py",
      "@@ -1,2 +1,2 @@",
      "-a",
      "+l1",
      " l2",
      "@@ -38,2 +38,3 @@ def tail():",
      " l38",
      "+new",
      " l39",
    ].join("\n");
    // the file as of the commit: l1..l38, new, then l39..l44 (lines 40..45)
    const fileLines = Array.from({ length: 45 }, (_, i) =>
      i < 38 ? `l${i + 1}` : i === 38 ? "new" : `l${i}`,
    );
    await mountHistory({
      "/api/code/commit/diff": { ok: true, diff },
      "/api/code/commit/file": { ok: true, content: fileLines.join("\n") + "\n" },
    });
    const lines = () => [...history().querySelectorAll(".ws-history-diff-line")];
    const code = () => lines().map((l) => l.querySelector(".ws-history-diff-code")!.textContent);
    const nums = (text: string) => {
      const line = lines().find(
        (l) => l.querySelector(".ws-history-diff-code")!.textContent === text,
      )!;
      return [...line.querySelectorAll(".ws-history-diff-num")].map((n) => n.textContent).join("/");
    };
    const buttons = (row: Element) =>
      [...row.querySelectorAll<HTMLElement>(".ws-history-diff-expand")].map((b) =>
        b.className.split(" ").pop(),
      );
    const header = () => lines().find((l) => l.textContent!.includes("@@ -38"))!;
    const button = (row: Element, dir: string) =>
      row.querySelector<HTMLElement>(`.ws-history-diff-expand.${dir}`)!;
    const closing = () => lines()[lines().length - 1];
    // the first hunk starts at line 1: nothing to reveal; the second can go both ways,
    // the file's closing row only down
    expect(buttons(lines()[0])).toEqual([]);
    expect(buttons(header())).toEqual(["down", "up"]);
    expect(buttons(closing())).toEqual(["down"]);

    await click(button(header(), "up"));
    expect(app.callsTo("/api/code/commit/file").map((c) => c.body)).toEqual([
      { path: "/home/odoo/work/community", sha: "sha-community", file: "big.py" },
    ]);
    // up: lines 23..37 slide in between the header and its hunk
    const range = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => `l${from + i}`);
    expect(code().slice(4, 21)).toEqual(["@@ -38,2 +38,3 @@ def tail():", ...range(23, 37), "l38"]);
    expect(nums("l23")).toBe("23/23");
    // down: lines 3..17 follow the first hunk, above the header
    await click(button(header(), "down"));
    expect(code().slice(3, 20)).toEqual(["l2", ...range(3, 17), "@@ -38,2 +38,3 @@ def tail():"]);
    // the remaining 18..22 close the gap: the header goes
    await click(button(header(), "up"));
    expect(code().slice(0, 42)).toEqual([
      "@@ -1,2 +1,2 @@",
      "a",
      "l1",
      ...range(2, 38),
      "new",
      "l39",
    ]);

    // after the last hunk: down to the end of the file, old numbers one behind
    await click(button(closing(), "down"));
    expect(code().slice(42)).toEqual(range(40, 44));
    expect(nums("l40")).toBe("40/41");
    expect(lines().some((l) => l.querySelector(".ws-history-diff-expand"))).toBe(false);
    expect(app.callsTo("/api/code/commit/file")).toHaveLength(1);
  });

  it("filters the files by path; Collapse all only touches the shown ones", async () => {
    await mountHistory();
    const paths = () =>
      [...history().querySelectorAll(".ws-history-diff-file-path")].map((p) => p.textContent);
    const filter = async (text: string) => {
      const input = history().querySelector<HTMLInputElement>(".ws-history-diff-tools input")!;
      input.value = text;
      input.dispatchEvent(new Event("input"));
      await app.settle();
    };
    expect(
      history().querySelector(".ws-history-diff-tools input")!.getAttribute("placeholder"),
    ).toBe("Filter files…");
    // case-insensitive, either side of a rename
    await filter("OLD/");
    expect(paths()).toEqual(["old/h.py → new/h.py"]);
    await filter(".py");
    expect(paths()).toEqual(["f.py", "g.py", "old/h.py → new/h.py"]);
    const tool = (label: string) =>
      [...history().querySelectorAll<HTMLButtonElement>(".ws-history-diff-tools button")].find(
        (b) => b.textContent === label,
      )!;
    await click(tool("Collapse all"));
    expect(tool("Collapse all").disabled).toBe(true);
    await filter("zzz");
    expect(paths()).toEqual([]);
    expect(history().querySelector(".ws-history-diff-state")!.textContent).toBe(
      "No file matches this filter.",
    );
    // clearing it: run.sh was outside the filter, so it is still open
    await click(history().querySelector<HTMLElement>(".ws-history-diff-tools .search-clear")!);
    expect(paths()).toEqual(["f.py", "g.py", "old/h.py → new/h.py", "run.sh"]);
    const open = [...history().querySelectorAll(".ws-history-diff-file")].map(
      (f) => !!f.querySelector(".ws-history-diff-line"),
    );
    expect(open).toEqual([false, false, false, true]);
  });

  it("unescapes git's C-quoted paths", async () => {
    const diff = [
      'diff --git "a/caf\\303\\251.py" "b/caf\\303\\251.py"',
      '--- "a/caf\\303\\251.py"',
      '+++ "b/caf\\303\\251.py"',
      "@@ -1 +1 @@",
      "-x",
      "+y",
      'diff --git "a/we\\"ird\\tname.bin" "b/we\\"ird\\tname.bin"',
      "Binary files differ",
      "",
    ].join("\n");
    await mountHistory({ "/api/code/commit/diff": { ok: true, diff } });
    const paths = [...history().querySelectorAll(".ws-history-diff-file-path")].map(
      (p) => p.textContent,
    );
    expect(paths).toEqual(["café.py", 'we"ird\tname.bin']);
  });

  it("a file the commit empties has nothing after its hunk to reveal", async () => {
    const diff = [
      "diff --git a/e.py b/e.py",
      "--- a/e.py",
      "+++ b/e.py",
      "@@ -1,2 +0,0 @@",
      "-a",
      "-b",
      "",
    ].join("\n");
    await mountHistory({
      "/api/code/commit/diff": { ok: true, diff },
      "/api/code/commit/file": { ok: true, content: "" },
    });
    const code = () =>
      [...history().querySelectorAll(".ws-history-diff-code")].map((c) => c.textContent);
    await click(history().querySelector<HTMLElement>(".ws-history-diff-expand.down")!);
    expect(code()).toEqual(["@@ -1,2 +0,0 @@", "a", "b"]);
    expect(history().querySelector(".ws-history-diff-expand")).toBeNull();
  });

  it("a file that can't be read for the expansion opens an error dialog", async () => {
    const diff = [
      "diff --git a/f.py b/f.py",
      "--- a/f.py",
      "+++ b/f.py",
      "@@ -5 +5 @@",
      "-x",
      "+y",
      "",
    ].join("\n");
    await mountHistory({
      "/api/code/commit/diff": { ok: true, diff },
      "/api/code/commit/file": () =>
        failure(400, { ok: false, error: "fatal: path 'f.py' does not exist in 'sha-community'" }),
    });
    const up = () => history().querySelector<HTMLButtonElement>(".ws-history-diff-expand.up")!;
    await click(up());
    expect(dialogTitle()).toBe("Could not load the file");
    expect(mustDialog().textContent).toContain("does not exist");
    // nothing revealed, and the button can be tried again
    expect(up().disabled).toBe(false);
    expect(history().querySelectorAll(".ws-history-diff-line")).toHaveLength(4);
  });

  it("collapses a file block, and all of them at once", async () => {
    await mountHistory();
    const files = () => [...history().querySelectorAll(".ws-history-diff-file")];
    const shown = () => files().map((f) => f.querySelectorAll(".ws-history-diff-line").length > 0);
    const tool = (label: string) =>
      [...history().querySelectorAll<HTMLButtonElement>(".ws-history-diff-tools button")].find(
        (b) => b.textContent === label,
      )!;
    expect(shown()).toEqual([true, true, true, true]);
    expect(tool("Expand all").disabled).toBe(true);
    // the header toggles its own block only, and stays visible
    await click(files()[1].querySelector<HTMLElement>(".ws-history-diff-file-toggle")!);
    expect(shown()).toEqual([true, false, true, true]);
    expect(files()[1].querySelector(".ws-history-diff-file-path")!.textContent).toBe("g.py");
    await click(tool("Collapse all"));
    expect(shown()).toEqual([false, false, false, false]);
    expect(tool("Collapse all").disabled).toBe(true);
    await click(tool("Expand all"));
    expect(shown()).toEqual([true, true, true, true]);
    await click(files()[0].querySelector<HTMLElement>(".ws-history-diff-file-toggle")!);
    await click(files()[0].querySelector<HTMLElement>(".ws-history-diff-file-toggle")!);
    expect(shown()).toEqual([true, true, true, true]);
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
