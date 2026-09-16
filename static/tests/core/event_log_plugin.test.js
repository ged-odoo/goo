import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventLogPlugin } from "../../src/core/event_log_plugin.js";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })),
  );
});

describe("EventLogPlugin", () => {
  it("starts empty when localStorage has nothing", () => {
    const plugin = new EventLogPlugin({});
    expect(plugin.entries()).toEqual([]);
    expect(plugin.lastReadId()).toBe(0);
  });

  it("restores persisted entries, converting a stuck 'pending' row back to a plain line", () => {
    localStorage.setItem(
      "oo-event-log",
      JSON.stringify({
        entries: [{ id: 1, at: 1, text: "starting…", status: "pending", eid: "x" }],
        lastReadId: 1,
      }),
    );
    const plugin = new EventLogPlugin({});
    expect(plugin.entries()).toEqual([{ id: 1, at: 1, text: "starting…", status: "", eid: "" }]);
    expect(plugin.lastReadId()).toBe(1);
  });

  it("drops malformed entries (missing id/text) on restore", () => {
    localStorage.setItem(
      "oo-event-log",
      JSON.stringify({
        entries: [{ id: 1, text: "ok" }, { text: "no id" }, { id: "not-a-number" }],
      }),
    );
    const plugin = new EventLogPlugin({});
    expect(plugin.entries()).toEqual([{ id: 1, text: "ok" }]);
  });

  it("starts fresh on corrupt localStorage JSON", () => {
    localStorage.setItem("oo-event-log", "{not json");
    const plugin = new EventLogPlugin({});
    expect(plugin.entries()).toEqual([]);
  });

  it("add() appends an entry, assigns an incrementing id, and best-effort mirrors to the server", () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    const plugin = new EventLogPlugin({});
    plugin.add("hello", "anchor1", "error");
    expect(plugin.entries()).toEqual([
      expect.objectContaining({ id: 1, text: "hello", anchor: "anchor1", level: "error" }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/event",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("add() persists to localStorage and caps at MAX (1000) entries", () => {
    const plugin = new EventLogPlugin({});
    for (let i = 0; i < 1005; i++) plugin.add(`line ${i}`);
    expect(plugin.entries().length).toBe(1000);
    expect(plugin.entries()[0].text).toBe("line 5"); // oldest 5 dropped
    const persisted = JSON.parse(localStorage.getItem("oo-event-log"));
    expect(persisted.entries.length).toBe(1000);
  });

  it("start()/finish() resolve a pending row by its correlation id", () => {
    const plugin = new EventLogPlugin({});
    plugin.start("eid1", "doing thing…");
    expect(plugin.entries()).toEqual([expect.objectContaining({ status: "pending", eid: "eid1" })]);
    plugin.finish("eid1", "done");
    expect(plugin.entries()).toEqual([expect.objectContaining({ status: "done", eid: "eid1" })]);
  });

  it("finish() with no matching start() falls back to appending a finished row when text is given", () => {
    const plugin = new EventLogPlugin({});
    plugin.finish("missing-eid", "error", "it happened anyway");
    expect(plugin.entries()).toEqual([
      expect.objectContaining({ eid: "missing-eid", status: "error", text: "it happened anyway" }),
    ]);
  });

  it("finish() with no matching start() and no text is silently dropped", () => {
    const plugin = new EventLogPlugin({});
    plugin.finish("missing-eid", "error");
    expect(plugin.entries()).toEqual([]);
  });

  it("begin() mints a local- id, starts a pending row, and mirrors to the server", () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    const plugin = new EventLogPlugin({});
    const eid = plugin.begin("doing a thing");
    expect(eid).toBe("local-1");
    expect(plugin.entries()).toEqual([
      expect.objectContaining({ eid: "local-1", status: "pending" }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drop() removes a pending row by its correlation id", () => {
    const plugin = new EventLogPlugin({});
    const eid = plugin.begin("cancel me");
    plugin.drop(eid);
    expect(plugin.entries()).toEqual([]);
  });

  it("toggle() flips `open` and marks everything read", () => {
    const plugin = new EventLogPlugin({});
    plugin.add("a");
    plugin.add("b");
    expect(plugin.unread()).toBe(2);
    plugin.toggle();
    expect(plugin.open()).toBe(true);
    expect(plugin.unread()).toBe(0); // 0 while open, regardless of lastReadId
    plugin.toggle();
    expect(plugin.open()).toBe(false);
    expect(plugin.unread()).toBe(0); // marked read on close too
  });

  it("unread() counts only entries newer than lastReadId while closed", () => {
    const plugin = new EventLogPlugin({});
    plugin.add("a");
    plugin.markRead();
    plugin.add("b");
    plugin.add("c");
    expect(plugin.unread()).toBe(2);
  });

  it("clear() empties the log and persists the empty state", () => {
    const plugin = new EventLogPlugin({});
    plugin.add("a");
    plugin.clear();
    expect(plugin.entries()).toEqual([]);
    expect(JSON.parse(localStorage.getItem("oo-event-log")).entries).toEqual([]);
  });
});
