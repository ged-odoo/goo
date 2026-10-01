import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityBar, EventLog } from "../../src/core/event_log.ts";
import { EventLogPlugin } from "../../src/core/event_log_plugin.ts";
import { TestsPlugin } from "../../src/core/tests_plugin.ts";
import { WorkspacePlugin } from "../../src/core/workspace_plugin.ts";
import { button, mountCore, waitFor, type MountedCore } from "../helpers/core_ui_fixtures.ts";

let core: MountedCore | null = null;
afterEach(() => {
  core?.destroy();
  core = null;
  location.hash = "";
});

async function mountLog(config = {}) {
  core = await mountCore(EventLog, { config, routes: { "/api/event": { ok: true } } });
  const log = core.plugin(EventLogPlugin);
  return { c: core, log };
}

const rows = (el: HTMLElement) =>
  [...el.querySelectorAll(".event-log-row")].map(
    (r) => r.querySelector(".event-log-text")!.textContent,
  );

describe("EventLog panel", () => {
  it("is hidden until toggled, then lists events oldest first with their status", async () => {
    const { c, log } = await mountLog();
    expect(c.el.querySelector(".event-log")).toBeNull();
    log.toggle();
    await c.settle();
    expect(c.el.querySelector(".event-log-empty")!.textContent).toBe("No events yet.");
    log.add("fetched PRs");
    log.add("push failed", "", "error");
    log.start("e1", "checking out master");
    log.start("e2", "creating worktree");
    log.finish("e2", "error");
    await c.settle();
    expect(rows(c.el)).toEqual([
      "fetched PRs",
      "push failed",
      "checking out master",
      "creating worktree",
    ]);
    const all = [...c.el.querySelectorAll(".event-log-row")];
    expect(all[1].classList.contains("error")).toBe(true);
    expect(all[3].classList.contains("error")).toBe(true); // a failed timed event
    expect(all[2].querySelector(".ev-status")!.className).toBe("ev-status ev-pending");
    expect(all[2].querySelector<HTMLElement>(".ev-status")!.title).toBe("in progress…");
    expect(all[0].querySelector(".ev-status")).toBeNull();
    // the hover title carries the full date
    expect(all[0].querySelector<HTMLElement>(".event-log-time")!.title).toMatch(/\d/);
    // the sent-to-server copy of plain events
    expect(c.callsTo("/api/event").map((x) => x.body)).toEqual([
      { text: "fetched PRs" },
      { text: "push failed" },
    ]);
  });

  it("Clear empties it, ✕ closes it", async () => {
    const { c, log } = await mountLog();
    log.add("a");
    log.toggle();
    await c.settle();
    button(c.el, "Clear").click();
    await c.settle();
    expect(c.el.querySelector(".event-log-empty")).not.toBeNull();
    c.el.querySelector<HTMLElement>(".event-log-x")!.click();
    await c.settle();
    expect(c.el.querySelector(".event-log")).toBeNull();
    expect(log.open()).toBe(false);
  });

  it("follows the tail while Autoscroll is on", async () => {
    const { c, log } = await mountLog();
    log.toggle();
    await c.settle();
    const body = c.el.querySelector<HTMLElement>(".event-log-body")!;
    vi.spyOn(body, "scrollHeight", "get").mockReturnValue(500);
    log.add("one");
    await c.settle();
    expect(body.scrollTop).toBe(500);
    const auto = c.el.querySelectorAll<HTMLElement>(".toggle")[0];
    auto.click();
    await c.settle();
    expect(auto.classList.contains("on")).toBe(false);
    body.scrollTop = 10;
    log.add("two");
    await c.settle();
    expect(body.scrollTop).toBe(10); // stays where the user is
  });

  it("Auto-open saves the setting and then opens the panel on a new event", async () => {
    const { c, log } = await mountLog();
    log.add("old"); // while auto-open is off: stays closed
    await c.settle();
    expect(c.el.querySelector(".event-log")).toBeNull();
    log.toggle();
    await c.settle();
    const autoOpen = c.el.querySelectorAll<HTMLElement>(".toggle")[1];
    expect(autoOpen.classList.contains("on")).toBe(false);
    autoOpen.click();
    await c.settle();
    expect(autoOpen.classList.contains("on")).toBe(true);
    const posts = () => c.callsTo("/api/config").filter((x) => x.method === "POST");
    const before = posts().length; // the boot-time config migration also writes back
    await waitFor(c.settle, () => posts().length > before);
    const saved = posts().at(-1)!.body as {
      config: { auto_open_event_log: boolean };
    };
    expect(saved.config.auto_open_event_log).toBe(true);
    log.toggle(); // close it
    await c.settle();
    log.add("new");
    await c.settle();
    expect(c.el.querySelector(".event-log")).not.toBeNull();
  });

  it("[jump] lands on the loaded workspace's Tests pane and reveals the anchored line", async () => {
    const { c, log } = await mountLog();
    const line = document.createElement("div");
    line.id = "test-line-7";
    document.body.appendChild(line);
    const scrolled = vi.fn();
    line.scrollIntoView = scrolled;
    log.add("3 tests failed", "test-line-7");
    log.toggle();
    await c.settle();
    const jump = c.el.querySelector<HTMLElement>(".event-log-jump")!;
    // jsdom (unlike browsers) "follows" an href-less <a>, resetting the hash a task later
    jump.addEventListener("click", (e) => e.preventDefault());
    jump.click();
    await c.settle();
    expect(location.hash).toBe("#workspaces");
    expect(c.plugin(WorkspacePlugin).requestedPane()).toBe("tests");
    // the console re-hosts the row a few frames later: once it's laid out, reveal it
    vi.spyOn(line, "offsetParent", "get").mockReturnValue(document.body);
    await waitFor(c.settle, () => scrolled.mock.calls.length > 0);
    expect(scrolled).toHaveBeenCalledWith({ block: "center" });
    expect(line.classList.contains("log-jump-flash")).toBe(true);
    expect(c.plugin(TestsPlugin).output.autoScroll()).toBe(false); // stay on the line
    line.remove();
  });

  it("drags by its header and resizes from its corner", async () => {
    const { c, log } = await mountLog();
    log.toggle();
    await c.settle();
    const panel = c.el.querySelector<HTMLElement>(".event-log")!;
    // placed bottom-right by default
    expect(panel.style.width).toBe("540px");
    expect(panel.style.left).toBe(`${Math.max(0, innerWidth - 540 - 16)}px`);
    const head = panel.querySelector<HTMLElement>(".event-log-head")!;
    const left0 = parseInt(panel.style.left);
    const top0 = parseInt(panel.style.top);
    head.dispatchEvent(new MouseEvent("mousedown", { button: 2, clientX: 0, clientY: 0 }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 50, clientY: 50 }));
    expect(panel.style.left).toBe(`${left0}px`); // not the primary button: ignored
    head.dispatchEvent(
      new MouseEvent("mousedown", { button: 0, clientX: left0 + 10, clientY: top0 + 10 }),
    );
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: left0 + 5, clientY: top0 + 30 }));
    expect(panel.style.left).toBe(`${left0 - 5}px`);
    expect(panel.style.top).toBe(`${top0 + 20}px`);
    document.dispatchEvent(new MouseEvent("mouseup"));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 0, clientY: 0 }));
    expect(panel.style.left).toBe(`${left0 - 5}px`); // released

    const corner = panel.querySelector<HTMLElement>(".term-panel-resize")!;
    corner.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 100, clientY: 100 }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 160, clientY: 40 }));
    expect(panel.style.width).toBe("600px");
    expect(panel.style.height).toBe("320px");
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: -1000, clientY: -1000 }));
    expect(panel.style.width).toBe("300px"); // minimum size
    expect(panel.style.height).toBe("200px");
    document.dispatchEvent(new MouseEvent("mouseup"));
    corner.dispatchEvent(new MouseEvent("mousedown", { button: 1 }));
  });
});

describe("ActivityBar", () => {
  it("shows the latest pending step with a count, and opens the log on click", async () => {
    core = await mountCore(ActivityBar);
    const log = core.plugin(EventLogPlugin);
    expect(core.el.querySelector(".activity-bar")).toBeNull();
    log.start("a", "creating worktree");
    log.start("b", "installing venv");
    await core.settle();
    expect(core.el.querySelector(".activity-bar-text")!.textContent).toBe("installing venv");
    expect(core.el.querySelector(".activity-bar-count")!.textContent).toBe("+1");
    log.finish("b", "done");
    await core.settle();
    expect(core.el.querySelector(".activity-bar-text")!.textContent).toBe("creating worktree");
    expect(core.el.querySelector(".activity-bar-count")).toBeNull();
    core.el.querySelector<HTMLElement>(".activity-bar")!.click();
    expect(log.open()).toBe(true);
    log.finish("a", "done");
    await core.settle();
    expect(core.el.querySelector(".activity-bar")).toBeNull();
  });
});
