// LogBuffer: the detached, capped, tail-following log element.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogBuffer } from "../../src/core/log_buffer.ts";

// jsdom does no layout: give the element a scroll geometry the test controls
function geometry(el: HTMLElement, g: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => g.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => g.clientHeight });
}

function scrollTo(buf: LogBuffer, top: number) {
  buf.el.scrollTop = top;
  buf.el.dispatchEvent(new Event("scroll"));
}

describe("LogBuffer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("appends parsed rows (optionally anchored) and counts them", () => {
    const buf = new LogBuffer();
    buf.append("first");
    buf.append("second", "anchor-1");
    expect(buf.count()).toBe(2);
    expect(buf.el.children[1].id).toBe("anchor-1");
    expect(buf.el.textContent).toBe("firstsecond");
    buf.clear();
    expect(buf.count()).toBe(0);
    expect(buf.el.childElementCount).toBe(0);
  });

  it("keeps only the most recent 2000 lines", () => {
    const buf = new LogBuffer();
    for (let i = 0; i < 2005; i++) buf.append(`line ${i}`);
    expect(buf.count()).toBe(2000);
    expect(buf.el.firstElementChild?.textContent).toBe("line 5");
  });

  it("follows the tail with one scroll per frame for a burst of lines", () => {
    const buf = new LogBuffer();
    const g = { scrollHeight: 1000, clientHeight: 100 };
    geometry(buf.el, g);
    buf.append("a");
    buf.append("b");
    expect(buf.el.scrollTop).toBe(0); // not yet — batched to the next frame
    vi.runOnlyPendingTimers();
    expect(buf.el.scrollTop).toBe(1000);
  });

  it("stops following on a user scroll-up, and resumes back at the bottom", () => {
    const buf = new LogBuffer();
    const g = { scrollHeight: 1000, clientHeight: 100 };
    geometry(buf.el, g);
    buf.toBottom();
    scrollTo(buf, 500); // the user scrolled up
    expect(buf.autoScroll()).toBe(false);
    buf.append("new line");
    vi.runOnlyPendingTimers();
    expect(buf.el.scrollTop).toBe(500); // left where the user is reading
    scrollTo(buf, 900); // back at the bottom
    expect(buf.autoScroll()).toBe(true);
  });

  it("content growing past the viewport (no user scroll) keeps following", () => {
    const buf = new LogBuffer();
    const g = { scrollHeight: 1000, clientHeight: 100 };
    geometry(buf.el, g);
    buf.toBottom();
    g.scrollHeight = 2000; // grew; scrollTop unchanged
    scrollTo(buf, 1000);
    expect(buf.autoScroll()).toBe(true);
  });

  it("restore(): back to the tail when following, else the saved position", () => {
    const buf = new LogBuffer();
    geometry(buf.el, { scrollHeight: 1000, clientHeight: 100 });
    buf.restore();
    expect(buf.el.scrollTop).toBe(1000);
    buf.autoScroll.set(false);
    buf.savedScroll = 300;
    buf.restore();
    expect(buf.el.scrollTop).toBe(300);
  });
});
