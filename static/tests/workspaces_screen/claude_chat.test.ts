// The Workspaces screen's Claude tab (ClaudeChat + the ClaudePlugin wire it
// drives): the transcript primed from the backend, sending a task, the live
// assistant/tool/result stream, Stop, the model choice, and a refused send.
import { afterEach, describe, expect, it } from "vitest";
import { mountApp, type MountedApp, type MountAppOptions } from "../helpers/app.ts";
import {
  captureSse,
  gitBackend,
  mustText,
  prsRoute,
  repo,
  texts,
  waitFor,
  ws,
  type Sse,
} from "../helpers/workspaces_fixtures.ts";
import type { WorkspaceConfig } from "../../src/core/config.ts";

let app: MountedApp;
let sse: Sse;
afterEach(() => app?.destroy());

const ALPHA = ws({ id: "alpha" }); // main-located, loaded
const WT = ws({
  id: "wt1",
  name: "feature-wt",
  location: "worktree",
  worktree: { dir: "/home/odoo/work-trees/wt1" },
});

async function mount(workspaces: WorkspaceConfig[], opts: MountAppOptions = {}) {
  sse = captureSse();
  const git = gitBackend([
    repo("community", "master-alpha", ["master", "master-alpha", "master-wt1"]),
    repo("enterprise", "master", ["master"]),
  ]);
  app = await mountApp({
    section: "workspaces",
    ...opts,
    config: { targets: [], workspaces, ...opts.config },
    state: { active_workspace: "alpha", ...opts.state },
    routes: {
      ...git.routes,
      "/api/prs": prsRoute(),
      "/api/runbot": { states: {} },
      "/api/mergebot": { states: {} },
      "/api/workspace/claude/history": { items: [], state: "idle" },
      ...opts.routes,
    },
  });
  mustText(app.root, ".wt-tab", "Claude").click();
  await app.settle();
  return app;
}

const chat = () => app.root.querySelector<HTMLElement>(".cchat")!;
const textarea = () => chat().querySelector<HTMLTextAreaElement>(".cchat-ta")!;
const messages = () =>
  [...chat().querySelectorAll(".cchat-msgs > div:not(.cchat-hint):not(.cchat-working)")].map(
    (el) => `${el.className}: ${el.textContent?.trim()}`,
  );

function press(key: string, shiftKey = false) {
  textarea().dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
}

describe("Claude chat", () => {
  it("warns that a main-located workspace's chat edits the real checkout", async () => {
    await mount([ALPHA]);
    expect(chat().querySelector(".cchat-hint")?.textContent).toContain("MAIN checkout");
    expect(app.callsTo("/api/workspace/claude/history")[0].body).toEqual({ workspace: "alpha" });
  });

  it("re-primes a worktree's transcript from the backend, rendering each kind of item", async () => {
    await mount([WT], {
      routes: {
        "/api/workspace/claude/history": {
          state: "running",
          items: [
            { role: "user", text: "fix the tour" },
            { role: "assistant", text: "Looking at **tour.js**" },
            { role: "tool", tool: "Edit", text: "tour.js" },
            { role: "error", text: "rate limited" },
          ],
        },
      },
    });
    expect(chat().querySelector(".cchat-hint")).toBeNull();
    expect(messages()).toEqual([
      "cmsg cmsg-user: fix the tour",
      "cmsg cmsg-asst: Looking at tour.js",
      "cmsg-tool: Edittour.js",
      "cmsg cmsg-error: rate limited",
    ]);
    // markdown is rendered, not shown raw
    expect(chat().querySelector(".cmsg-asst strong")?.textContent).toBe("tour.js");
    // the backend says a turn is still running
    expect(chat().querySelector(".cchat-working")?.textContent).toContain("Claude is working");
    expect(textarea().disabled).toBe(true);
    expect(mustText(chat(), ".cchat-send", "Stop")).toBeDefined();
  });

  it("Enter sends the task in the worktree's checkout; the live stream ends the turn", async () => {
    await mount([WT]);
    expect(chat().querySelector(".cchat-hint")?.textContent).toContain("this worktree's checkout");

    // blank: nothing sent; Shift+Enter is a newline, not a send
    press("Enter");
    textarea().value = "add a test";
    press("Enter", true);
    await app.settle();
    expect(app.callsTo("/api/workspace/claude")).toHaveLength(0);

    press("Enter");
    await app.settle();
    expect(app.callsTo("/api/workspace/claude")[0].body).toEqual({
      workspace: "wt1",
      prompt: "add a test",
      cwd: "/home/odoo/work-trees/wt1/community",
      addDirs: ["/home/odoo/work-trees/wt1/enterprise"],
      review: false,
    });
    expect(textarea().value).toBe("");
    expect(messages()).toEqual(["cmsg cmsg-user: add a test"]);
    expect(chat().querySelector(".cchat-working")).not.toBeNull();

    sse.emit("claude", { workspace: "wt1", role: "tool", tool: "Bash", text: "pytest" });
    sse.emit("claude", { workspace: "wt1", role: "assistant", text: "Done — 1 test added." });
    sse.emit("claude", { workspace: "other", role: "assistant", text: "not for this chat" });
    await app.settle();
    expect(messages()).toEqual([
      "cmsg cmsg-user: add a test",
      "cmsg-tool: Bashpytest",
      "cmsg cmsg-asst: Done — 1 test added.",
    ]);

    sse.emit("claude", { workspace: "wt1", role: "result", ok: true });
    await app.settle();
    expect(chat().querySelector(".cchat-working")).toBeNull();
    expect(textarea().disabled).toBe(false);
    expect(mustText(chat(), ".cchat-send", "Send")).toBeDefined();
  });

  it("a failed turn's result is shown as an error", async () => {
    await mount([WT]);
    textarea().value = "go";
    mustText(chat(), ".cchat-send", "Send").click();
    await app.settle();
    sse.emit("claude", { workspace: "wt1", role: "result", ok: false, error: "claude exited 1" });
    await app.settle();
    expect(messages()).toEqual(["cmsg cmsg-user: go", "cmsg cmsg-error: claude exited 1"]);
  });

  it("Stop asks the backend to stop the turn and re-enables the input", async () => {
    await mount([ALPHA]);
    textarea().value = "refactor";
    mustText(chat(), ".cchat-send", "Send").click();
    await app.settle();
    // a main-located workspace works in the real main checkout paths
    expect(app.callsTo("/api/workspace/claude")[0].body).toMatchObject({
      cwd: "/home/odoo/work/community",
      addDirs: ["/home/odoo/work/enterprise"],
    });
    mustText(chat(), ".cchat-send", "Stop").click();
    await app.settle();
    expect(app.callsTo("/api/workspace/claude/stop")[0].body).toEqual({ workspace: "alpha" });
    expect(textarea().disabled).toBe(false);
  });

  it("a refused send is reported in the transcript and the chat goes idle", async () => {
    await mount([WT], {
      routes: {
        "/api/workspace/claude": new Response(JSON.stringify({ error: "claude not on PATH" }), {
          status: 500,
        }),
      },
    });
    textarea().value = "hello";
    press("Enter");
    await app.settle();
    expect(messages()).toEqual(["cmsg cmsg-user: hello", "cmsg cmsg-error: claude not on PATH"]);
    expect(chat().querySelector(".cchat-working")).toBeNull();
  });

  it("the chosen model is sent with the task and remembered", async () => {
    await mount([WT], { state: { claude_model: "sonnet" } });
    const select = chat().querySelector<HTMLSelectElement>(".cchat-model")!;
    expect(select.value).toBe("sonnet");
    expect(texts(select, "option")[0]).toBe("Default model");
    select.value = "haiku";
    select.dispatchEvent(new Event("change"));
    await app.settle();
    textarea().value = "quick one";
    press("Enter");
    await app.settle();
    expect(app.callsTo("/api/workspace/claude")[0].body).toMatchObject({ model: "haiku" });
    await waitFor(app, () =>
      app
        .callsTo("/api/config")
        .some(
          (c) =>
            c.method === "POST" &&
            (c.body as { state?: { claude_model?: string } }).state?.claude_model === "haiku",
        ),
    );
  });
});
