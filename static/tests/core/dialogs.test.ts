import { afterEach, describe, expect, it } from "vitest";
import { CodePlugin } from "../../src/core/code_plugin.ts";
import { DialogPlugin } from "../../src/core/dialog_plugin.ts";
import {
  CommitsDialog,
  RemoteBranchDialog,
  pushBranchesDialog,
  type RemoteBranchPick,
} from "../../src/core/dialogs.ts";
import type { Route } from "../helpers/app.ts";
import {
  button,
  mountCore,
  typeInto,
  waitFor,
  type MountedCore,
} from "../helpers/core_ui_fixtures.ts";

let core: MountedCore;
afterEach(() => core?.destroy());

const branch = (name: string) => ({ name, date: "2026-01-01T00:00:00Z", subject: "s", sha: "a" });

// both default repos have a local "master-feat"; only community has "master-local"
const BRANCHES = {
  ok: true,
  repos: [
    {
      id: "community",
      current: "master",
      branches: [branch("master"), branch("master-feat"), branch("master-local")],
    },
    { id: "enterprise", current: "master", branches: [branch("master"), branch("master-feat")] },
  ],
};

async function openSearch(routes: Record<string, Route>, repoIds?: string[]) {
  core = await mountCore(null, { routes: { "/api/code/branches": BRANCHES, ...routes } });
  await core.plugin(CodePlugin).loadBranches();
  const result = core
    .plugin(DialogPlugin)
    .openComponent<RemoteBranchPick | null>(RemoteBranchDialog, repoIds ? { repoIds } : {});
  await core.settle();
  return { result, input: core.el.querySelector<HTMLInputElement>(".rbd-input")! };
}

const rows = () =>
  [...core.el.querySelectorAll(".rbd-row")].map(
    (r) =>
      `${r.querySelector(".rbd-branch")!.textContent}:` +
      [...r.querySelectorAll(".rbd-repo-tag")]
        .map((t) => `${t.textContent}/${t.className.split(" ")[1]}`)
        .join(","),
  );

describe("RemoteBranchDialog", () => {
  it("merges instant local hits with the debounced remote search, and picks a branch", async () => {
    const { result, input } = await openSearch({
      "/api/code/remote-branches/search": {
        ok: true,
        results: [
          { repo: "community", branch: "master-feat", remote: "origin" }, // also local
          { repo: "enterprise", branch: "master-remote", remote: "dev" },
        ],
      },
    });
    expect(document.activeElement).toBe(input);
    typeInto(input, "master-");
    await core.settle();
    // local results show before the remote round-trip lands
    expect(rows()).toEqual([
      "master-feat:community/local,enterprise/local",
      "master-local:community/local",
    ]);
    expect(core.el.querySelector(".rbd-status")!.textContent).toBe("Searching remote…");
    await waitFor(core.settle, () => rows().length === 3);
    expect(rows()[2]).toBe("master-remote:enterprise/remote");
    expect(core.el.querySelector(".rbd-status")).toBeNull();
    const search = core.callsTo("/api/code/remote-branches/search");
    expect(search.length).toBe(1);
    expect(search[0].body).toMatchObject({ query: "master-" });

    const cont = button(core.el, "Continue");
    expect(cont.disabled).toBe(true);
    core.el.querySelectorAll<HTMLElement>(".rbd-row")[2].click();
    await core.settle();
    expect(core.el.querySelector(".rbd-row.selected .rbd-branch")!.textContent).toBe(
      "master-remote",
    );
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(await result).toEqual({
      branch: "master-remote",
      repos: ["enterprise"],
      remoteByRepo: { enterprise: "dev" },
    });
  });

  it("scopes both searches to the given repos and reports no match", async () => {
    const { input } = await openSearch(
      { "/api/code/remote-branches/search": { ok: true, results: [] } },
      ["enterprise"],
    );
    typeInto(input, "local");
    await waitFor(core.settle, () => core.callsTo("/api/code/remote-branches/search").length > 0);
    await waitFor(
      core.settle,
      () => !core.el.querySelector(".rbd-status")?.textContent?.includes("Searching"),
    );
    expect(core.el.querySelector(".rbd-status")!.textContent).toBe("No matching branches found.");
    const body = core.callsTo("/api/code/remote-branches/search")[0].body as {
      repos: { id: string }[];
    };
    expect(body.repos.map((r) => r.id)).toEqual(["enterprise"]);
  });

  it("clearing the input clears the results; Cancel and Escape resolve null", async () => {
    const { result, input } = await openSearch({});
    typeInto(input, "feat");
    await core.settle();
    expect(rows().length).toBe(1);
    typeInto(input, "  ");
    await core.settle();
    expect(rows()).toEqual([]);
    expect(core.el.querySelector(".rbd-status")).toBeNull();
    button(core.el, "Cancel").click();
    expect(await result).toBeNull();
    await core.settle();
    expect(core.el.querySelector(".rbd")).toBeNull();
    const again = core.plugin(DialogPlugin).openComponent(RemoteBranchDialog, {});
    await core.settle();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(await again).toBeNull();
  });
});

const COMMITS = [
  {
    sha: "c2",
    date: "2026-01-02T10:00:00Z",
    subject: "feat: b",
    author: "me",
    body: "why b",
    ahead: true,
  },
  { sha: "c1", date: "not a date", subject: "base commit", author: "someone" },
];

async function openCommits(routes: Record<string, Route>, props: object = {}) {
  core = await mountCore(null, { routes });
  const result = core.plugin(DialogPlugin).openComponent(CommitsDialog, {
    path: "/src/community",
    label: "community",
    ref: "master-feat",
    base: "master",
    pullRemote: "origin",
    ...props,
  });
  await core.settle();
  return { result }; // not the bare promise: an async function would wait on it
}

describe("CommitsDialog", () => {
  it("lists the branch's commits and expands one to its full message + GitHub link", async () => {
    await openCommits({ "/api/code/log": { ok: true, commits: COMMITS } }, { github: "odoo/odoo" });
    expect(core.callsTo("/api/code/log")[0].body).toMatchObject({
      path: "/src/community",
      ref: "master-feat",
      base: "master",
      pull_remote: "origin",
    });
    const subjects = [...core.el.querySelectorAll(".commit-subject")].map((s) => s.textContent);
    expect(subjects).toEqual(["feat: b", "base commit"]);
    const [own, base] = [...core.el.querySelectorAll<HTMLElement>(".commit-row")];
    own.click();
    base.click();
    await core.settle();
    const details = core.el.querySelectorAll(".commit-detail");
    expect(details[0].querySelector(".commit-body")!.textContent).toBe("feat: b\n\nwhy b");
    expect(details[0].querySelector("a")!.getAttribute("href")).toBe(
      "https://github.com/odoo/odoo/commit/c2",
    );
    // only the branch's own commits can be reworded
    expect(details[0].querySelector(".commit-edit-btn")).not.toBeNull();
    expect(details[1].querySelector(".commit-edit-btn")).toBeNull();
    expect(details[1].querySelector(".commit-detail-date")!.textContent).toBe("not a date");
    own.click(); // collapse again
    await core.settle();
    expect(core.el.querySelectorAll(".commit-detail").length).toBe(1);
  });

  it("shows the empty and error states; ✕ closes", async () => {
    let { result } = await openCommits({ "/api/code/log": { ok: true, commits: [] } });
    expect(core.el.querySelector(".commits-empty")!.textContent).toBe("no commits");
    core.el.querySelector<HTMLElement>(".commits-panel .event-log-x")!.click();
    expect(await result).toBeNull();
    core.destroy();

    ({ result } = await openCommits({ "/api/code/log": { ok: false, error: "not a git repo" } }));
    expect(core.el.querySelector(".commits-empty")!.textContent).toBe("not a git repo");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(await result).toBeNull();
  });

  it("rewords an own commit and reloads the list; a failed reword shows an error", async () => {
    let commits: object[] = COMMITS;
    let reword: unknown = { ok: true };
    await openCommits({
      "/api/code/log": () => ({ ok: true, commits }),
      "/api/code/reword": () => reword,
    });
    core.el.querySelector<HTMLElement>(".commit-row")!.click();
    await core.settle();
    core.el.querySelector<HTMLElement>(".commit-edit-btn")!.click();
    await core.settle();
    const textarea = core.el.querySelector<HTMLTextAreaElement>(".commit-msg-dialog textarea")!;
    expect(textarea.value).toBe("feat: b\n\nwhy b");
    typeInto(textarea, "feat: better b\n");
    commits = [{ ...COMMITS[0], subject: "feat: better b", body: "" }, COMMITS[1]];
    await core.settle();
    button(core.el.querySelector(".commit-msg-dialog")!, "Save").click();
    await core.settle();
    expect(core.callsTo("/api/code/reword")[0].body).toMatchObject({
      path: "/src/community",
      sha: "c2",
      message: "feat: better b",
      base: "master",
    });
    expect(core.el.querySelector(".commit-subject")!.textContent).toBe("feat: better b");

    reword = { ok: false, error: "c2 is not ahead of master" };
    // the reworded row stays expanded across the reload
    core.el.querySelector<HTMLElement>(".commit-edit-btn")!.click();
    await core.settle();
    button(core.el.querySelector(".commit-msg-dialog")!, "Save").click();
    await core.settle();
    const err = core.el.querySelector(".dialog-error")!;
    expect(err.textContent).toContain("Edit commit message failed");
    expect(err.textContent).toContain("c2 is not ahead of master");
  });

  it("cancelling the reword editor changes nothing", async () => {
    await openCommits({ "/api/code/log": { ok: true, commits: COMMITS } });
    core.el.querySelector<HTMLElement>(".commit-row")!.click();
    await core.settle();
    core.el.querySelector<HTMLElement>(".commit-edit-btn")!.click();
    await core.settle();
    button(core.el.querySelector(".commit-msg-dialog")!, "Discard").click();
    await core.settle();
    expect(core.callsTo("/api/code/reword")).toEqual([]);
    expect(core.callsTo("/api/code/log").length).toBe(1);
  });
});

describe("pushBranchesDialog", () => {
  it("confirms, then pushes every branch to its repo's push remote", async () => {
    core = await mountCore(null, { routes: { "/api/code/branch/push": { ok: true } } });
    const code = core.plugin(CodePlugin);
    const dialogs = core.plugin(DialogPlugin);
    const branches = [
      { path: "/src/community", branch: "master-feat", repo: "community" },
      { path: "/wt/enterprise", branch: "master-feat", repo: "enterprise", workspaceId: "w1" },
    ];
    const pushed = pushBranchesDialog(code, dialogs, branches, { title: "Push?", force: true });
    await core.settle();
    button(core.el, "Force push").click();
    expect(await pushed).toBe(true);
    const bodies = core.callsTo("/api/code/branch/push").map((c) => c.body);
    expect(bodies).toEqual([
      { path: "/src/community", branch: "master-feat", force: true, push_remote: "dev" },
      { path: "/wt/enterprise", branch: "master-feat", force: true, push_remote: "dev" },
    ]);
  });

  it("pushes nothing when cancelled or given no branches", async () => {
    core = await mountCore(null);
    const code = core.plugin(CodePlugin);
    const dialogs = core.plugin(DialogPlugin);
    expect(await pushBranchesDialog(code, dialogs, [], { title: "Push?" })).toBe(false);
    const pushed = pushBranchesDialog(
      code,
      dialogs,
      [{ path: "/p", branch: "b", repo: "community" }],
      { title: "Push?" },
    );
    await core.settle();
    expect(button(core.el, "Push")).toBeTruthy();
    button(core.el, "Discard").click();
    expect(await pushed).toBe(false);
    expect(core.callsTo("/api/code/branch/push")).toEqual([]);
  });
});
