import { afterEach, describe, expect, it, vi } from "vitest";
import { signal } from "@odoo/owl";
import { appBus, DirtyBadge, DirtyMenu, LogConsole, SearchBox } from "../../src/core/common.ts";
import { CodePlugin } from "../../src/core/code_plugin.ts";
import { LogBuffer } from "../../src/core/log_buffer.ts";
import { mountApp, type MountedApp, type Route } from "../helpers/app.ts";
import {
  button,
  mountCore,
  typeInto,
  waitFor,
  type MountedCore,
} from "../helpers/core_ui_fixtures.ts";

let app: MountedApp | null = null;
let core: MountedCore | null = null;
afterEach(() => {
  app?.destroy();
  core?.destroy();
  app = core = null;
});

const rect = { top: 100, bottom: 120, left: 50, right: 90 } as DOMRect;
const open = (name: string, detail: object) =>
  appBus.dispatchEvent(new CustomEvent(name, { detail: { rect, ...detail } }));

async function boot(routes: Record<string, Route> = {}) {
  app = await mountApp({
    section: "databases",
    routes: { "/api/databases": { ok: true, databases: [] }, ...routes },
  });
  return app;
}

describe("ActionMenu", () => {
  it("lists the actions under the anchor; clicking one runs it and closes the menu", async () => {
    const a = await boot();
    const ran: string[] = [];
    const menu = a.root.querySelector<HTMLElement>(".action-menu")!;
    expect(menu.classList.contains("hidden")).toBe(true);
    open("action-menu", {
      actions: [
        { label: "Rename", onClick: () => ran.push("rename") },
        { label: "Delete", danger: true, onClick: () => ran.push("delete") },
        {
          label: "Push",
          disabled: true,
          title: "nothing to push",
          onClick: () => ran.push("push"),
        },
      ],
    });
    await a.settle();
    expect(menu.classList.contains("hidden")).toBe(false);
    expect(menu.style.top).toBe("124px"); // just below the anchor
    const items = [...menu.querySelectorAll<HTMLButtonElement>(".dash-menu-item")];
    expect(items.map((b) => b.textContent)).toEqual(["Rename", "Delete", "Push"]);
    expect(items[1].classList.contains("danger")).toBe(true);
    expect(items[2].disabled).toBe(true);
    expect(items[2].title).toBe("nothing to push");
    items[0].click();
    await a.settle();
    expect(ran).toEqual(["rename"]);
    expect(menu.classList.contains("hidden")).toBe(true);
  });

  it("flips above an anchor near the viewport bottom; outside click and Escape close it", async () => {
    const a = await boot();
    const menu = a.root.querySelector<HTMLElement>(".action-menu")!;
    const low = { top: innerHeight - 10, bottom: innerHeight - 2, left: 0, right: 40 } as DOMRect;
    vi.spyOn(menu, "offsetHeight", "get").mockReturnValue(100);
    vi.spyOn(menu, "offsetWidth", "get").mockReturnValue(100);
    appBus.dispatchEvent(
      new CustomEvent("action-menu", { detail: { rect: low, actions: [{ label: "x" }] } }),
    );
    await a.settle();
    expect(menu.style.top).toBe(`${innerHeight - 10 - 100 - 4}px`);
    expect(menu.style.left).toBe("12px"); // clamped to the viewport
    document.body.click();
    await a.settle();
    expect(menu.classList.contains("hidden")).toBe(true);
    open("action-menu", { actions: [{ label: "x" }] });
    await a.settle();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await a.settle();
    expect(menu.classList.contains("hidden")).toBe(true);
  });
});

describe("CI and mergebot popovers", () => {
  it("the CI popover lists each check with its state and build link, lingering on leave", async () => {
    const a = await boot();
    const menu = a.root.querySelector<HTMLElement>(".ci-menu")!;
    open("ci-menu", {
      checks: [
        { context: "ci/runbot", state: "success", url: "https://runbot/1" },
        { context: "ci/style", state: "failure" },
        { context: "ci/l10n", state: "pending" },
        { context: "ci/other" },
      ],
    });
    await a.settle();
    const items = [...menu.querySelectorAll<HTMLAnchorElement>(".ci-menu-item")];
    expect(items.map((i) => i.textContent)).toEqual([
      "ci/runbotok",
      "ci/styleko",
      "ci/l10nrunning",
      "ci/other—",
    ]);
    expect(items[0].getAttribute("href")).toBe("https://runbot/1");
    expect(items[0].target).toBe("_blank");
    expect(items[1].hasAttribute("href")).toBe(false);
    expect(items[3].classList.contains("unknown")).toBe(true);

    // leaving the badge schedules a close; entering the popover cancels it
    vi.useFakeTimers();
    appBus.dispatchEvent(new CustomEvent("ci-menu-hide"));
    menu.dispatchEvent(new MouseEvent("mouseenter"));
    menu.dispatchEvent(new MouseEvent("mouseleave"));
    menu.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(1000); // well past the linger
    vi.useRealTimers();
    await a.settle();
    expect(menu.classList.contains("hidden")).toBe(false);
    menu.dispatchEvent(new MouseEvent("mouseleave"));
    await waitFor(a.settle, () => menu.classList.contains("hidden"));
    open("ci-menu", { checks: [] });
    await a.settle();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await a.settle();
    expect(menu.classList.contains("hidden")).toBe(true);
  });

  it("the mergebot popover shows each repo's state plus its unmet requirements", async () => {
    const a = await boot();
    const menu = a.root.querySelector<HTMLElement>(".mb-menu")!;
    open("mb-menu", {
      rows: [
        {
          repo: "odoo",
          state: "blocked",
          detail: "Review, CI",
          cls: "blocked",
          url: "https://mb/1",
        },
        { repo: "enterprise", state: "ready", cls: "ready" },
      ],
    });
    await a.settle();
    const items = [...menu.querySelectorAll<HTMLAnchorElement>(".mb-menu-item")];
    expect(items.map((i) => i.textContent)).toEqual([
      "odooblocked · Review, CI",
      "enterpriseready",
    ]);
    expect(items[0].classList.contains("blocked")).toBe(true);
    expect(items[0].getAttribute("href")).toBe("https://mb/1");
    vi.useFakeTimers();
    appBus.dispatchEvent(new CustomEvent("mb-menu-hide"));
    menu.dispatchEvent(new MouseEvent("mouseenter")); // cancels the pending close
    vi.advanceTimersByTime(1000);
    vi.useRealTimers();
    await a.settle();
    expect(menu.classList.contains("hidden")).toBe(false);
    menu.dispatchEvent(new MouseEvent("mouseleave"));
    await waitFor(a.settle, () => menu.classList.contains("hidden"));
    open("mb-menu", { rows: [] });
    await a.settle();
    expect(menu.classList.contains("hidden")).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await a.settle();
    expect(menu.classList.contains("hidden")).toBe(true);
  });
});

describe("DirtyBadge + DirtyMenu", () => {
  const BRANCHES = {
    repos: [
      {
        id: "community",
        current: "master-feat",
        dirty: true,
        branches: [{ name: "master-feat", date: "", subject: "wip: half done", sha: "a" }],
      },
    ],
  };
  const mountMenu = async (over: Record<string, Route> = {}) => {
    core = await mountCore(DirtyMenu, {
      routes: {
        "/api/code/branches": BRANCHES,
        "/api/code/commit": { ok: true },
        "/api/code/amend": { ok: true },
        "/api/code/wip-commit": { ok: true },
        "/api/code/discard": { ok: true },
        ...over,
      },
    });
    await core.plugin(CodePlugin).loadBranches(); // the checkout state the menu reads
    return core;
  };
  const openDirty = async (c: MountedCore, workspaceId = "") => {
    open("dirty-menu", { path: "/src/community", repo: "community", workspaceId });
    await c.settle();
    return c.el.querySelector<HTMLElement>(".dirty-menu")!;
  };

  it("the badge opens the menu for its own checkout", async () => {
    core = await mountCore(DirtyBadge, { props: { path: "/wt/community", repo: "community" } });
    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail);
    appBus.addEventListener("dirty-menu", listener);
    core.el.querySelector<HTMLElement>(".dirty-badge")!.click();
    appBus.removeEventListener("dirty-menu", listener);
    expect(seen).toMatchObject([{ path: "/wt/community", repo: "community", workspaceId: "" }]);
  });

  it("Commit asks for a message, then commits it and refreshes the repo", async () => {
    const c = await mountMenu();
    const menu = await openDirty(c);
    expect(menu.classList.contains("hidden")).toBe(false);
    const loads = c.callsTo("/api/code/branches").length;
    button(menu, "Commit").click();
    await c.settle();
    expect(menu.classList.contains("hidden")).toBe(true);
    const dialog = c.el.querySelector<HTMLElement>(".commit-msg-dialog")!;
    expect(dialog.querySelector(".dialog-title")!.textContent).toBe("Commit — community");
    expect(button(dialog, "Commit").disabled).toBe(true); // a message is required
    typeInto(dialog.querySelector("textarea")!, "  feat: done  ");
    await c.settle();
    button(dialog, "Commit").click();
    await c.settle();
    expect(c.callsTo("/api/code/commit")[0].body).toEqual({
      path: "/src/community",
      message: "feat: done",
    });
    expect(c.callsTo("/api/code/branches").length).toBe(loads + 1);
  });

  it("cancelling the commit dialog commits nothing", async () => {
    const c = await mountMenu();
    button(await openDirty(c), "Commit").click();
    await c.settle();
    button(c.el.querySelector(".commit-msg-dialog")!, "Discard").click();
    await c.settle();
    expect(c.callsTo("/api/code/commit")).toEqual([]);
  });

  it("Amend prefills HEAD's full message and amends with the edited one", async () => {
    const c = await mountMenu({
      "/api/code/log": {
        ok: true,
        commits: [{ sha: "a", subject: "feat: x", body: "details", date: "", author: "me" }],
      },
    });
    button(await openDirty(c), "Amend commit").click();
    await c.settle();
    const textarea = c.el.querySelector<HTMLTextAreaElement>(".commit-msg-dialog textarea")!;
    expect(textarea.value).toBe("feat: x\n\ndetails");
    typeInto(textarea, "feat: y");
    await c.settle();
    button(c.el.querySelector(".commit-msg-dialog")!, "Amend").click();
    await c.settle();
    expect(c.callsTo("/api/code/amend")[0].body).toEqual({
      path: "/src/community",
      message: "feat: y",
    });
  });

  it("Amend falls back to the HEAD subject when the full message can't be read", async () => {
    const c = await mountMenu({ "/api/code/log": { ok: false, error: "boom" } });
    button(await openDirty(c), "Amend commit").click();
    await c.settle();
    const textarea = c.el.querySelector<HTMLTextAreaElement>(".commit-msg-dialog textarea")!;
    expect(textarea.value).toBe("wip: half done");
    button(c.el.querySelector(".commit-msg-dialog")!, "Discard").click();
    await c.settle();
    expect(c.callsTo("/api/code/amend")).toEqual([]);
  });

  it("WIP commit and Discard act on the opened checkout", async () => {
    const c = await mountMenu();
    button(await openDirty(c, "w1"), "WIP commit").click();
    await c.settle();
    expect(c.callsTo("/api/code/wip-commit")[0].body).toEqual({ path: "/src/community" });
    // a worktree checkout refreshes its own composite row, not the main one
    const wt = c.callsTo("/api/code/branches").at(-1)!.body as { repos: { id: string }[] };
    expect(wt.repos.map((r) => r.id)).toEqual(["w1:community"]);

    button(await openDirty(c), "Discard changes").click();
    await c.settle();
    button(c.el.querySelector(".dialog")!, "Discard changes").click();
    await c.settle();
    expect(c.callsTo("/api/code/discard")[0].body).toEqual({ path: "/src/community" });
  });

  it("outside click and Escape close the menu", async () => {
    const c = await mountMenu();
    let menu = await openDirty(c);
    document.body.click();
    await c.settle();
    expect(menu.classList.contains("hidden")).toBe(true);
    menu = await openDirty(c);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await c.settle();
    expect(menu.classList.contains("hidden")).toBe(true);
  });
});

describe("LogConsole", () => {
  it("hosts the plugin-owned buffer, with live dot, autoscroll toggle and Clear", async () => {
    const buffer = new LogBuffer();
    buffer.append("first line");
    core = await mountCore(LogConsole, { props: { title: "Server", buffer, extraClass: "big" } });
    const section = core.el.querySelector<HTMLElement>("section.console")!;
    expect(section.className).toBe("console big");
    expect(section.querySelector(".console-title")!.textContent).toBe("Server");
    expect(section.querySelector(".cdot")!.classList.contains("on")).toBe(false);
    expect(section.querySelector(".log-host")!.contains(buffer.el)).toBe(true);
    expect(buffer.el.textContent).toContain("first line");
    const auto = section.querySelector<HTMLElement>(".toggle")!;
    expect(auto.classList.contains("on")).toBe(true);
    auto.click();
    await core.settle();
    expect(buffer.autoScroll()).toBe(false);
    expect(auto.classList.contains("on")).toBe(false);
    auto.click();
    await core.settle();
    expect(buffer.autoScroll()).toBe(true);
    button(section, "Clear").click();
    expect(buffer.el.childElementCount).toBe(0);
    buffer.el.scrollTop = 0;
    core.destroy();
    core = null;
    // the buffer (rows + scroll position) outlives the console
    expect(buffer.savedScroll).toBe(0);
  });

  it("a bare console has no toolbar", async () => {
    core = await mountCore(LogConsole, {
      props: { title: "x", buffer: new LogBuffer(), bare: true },
    });
    expect(core.el.querySelector(".log-toolbar")).toBeNull();
    expect(core.el.querySelector("section")!.className).toBe("console bare");
  });
});

describe("SearchBox", () => {
  it("edits the bound signal and clears it with ✕", async () => {
    const value = signal("");
    core = await mountCore(SearchBox, { props: { value } });
    expect(core.el.querySelector(".search-clear")).toBeNull();
    typeInto(core.el.querySelector("input")!, "feat");
    await core.settle();
    expect(value()).toBe("feat");
    core.el.querySelector<HTMLButtonElement>(".search-clear")!.click();
    await core.settle();
    expect(value()).toBe("");
    expect(core.el.querySelector("input")!.value).toBe("");
  });
});
