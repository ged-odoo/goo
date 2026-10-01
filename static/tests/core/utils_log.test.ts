// The odoo-log → DOM row parser (buildLogRow), the ANSI color handling it relies on,
// the multi-paragraph markdown path, and the JSON POST / review-prompt helpers.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ansiToHtml,
  buildLogRow,
  fetchReviewPrompt,
  mdToHtml,
  postJSON,
  saveReviewPrompt,
  type PostJSONError,
} from "../../src/core/utils.ts";

const LOG = "2026-06-11 12:34:56,789 4242";

describe("buildLogRow", () => {
  it("splits a structured odoo line into ts / pid / level / logger / message", () => {
    const row = buildLogRow(`${LOG} INFO db odoo.modules.loading: loading 42 modules`);
    expect(row.className).toBe("row");
    expect(row.querySelector(".ts")?.textContent).toBe("12:34:56,789");
    expect(row.querySelector(".pid")?.textContent).toBe("4242");
    expect(row.querySelector(".lvl")?.textContent).toBe("INFO");
    expect(row.querySelector(".lvl")?.className).toBe("lvl info");
    expect(row.querySelector(".logger")?.textContent).toBe("odoo.modules.loading:");
    expect(row.querySelector(".msg")?.textContent).toBe("loading 42 modules");
  });

  it("flags error / warning / cron rows and abbreviates the long levels", () => {
    const err = buildLogRow(`${LOG} ERROR db odoo.sql_db: bad query <x>`);
    expect(err.className).toBe("row err-row");
    expect(err.querySelector(".msg")?.innerHTML).toContain("bad query &lt;x&gt;");
    const crit = buildLogRow(`${LOG} CRITICAL db odoo.service: boom`);
    expect(crit.className).toBe("row err-row");
    expect(crit.querySelector(".lvl")?.textContent).toBe("CRIT");
    const warn = buildLogRow(`${LOG} WARNING db odoo.models: careful`);
    expect(warn.className).toBe("row warn-row");
    expect(warn.querySelector(".lvl")?.textContent).toBe("WARN");
    const cron = buildLogRow(`${LOG} INFO db odoo.addons.base.models.ir_cron: job ran`);
    expect(cron.className).toBe("row warn-row");
  });

  it("tints an HTTP request line: method, path, query, status chip, timing", () => {
    const row = buildLogRow(
      `${LOG} INFO db werkzeug: 127.0.0.1 - - "GET /web/action?id=3 HTTP/1.1" 200 - 12 0.004 0.020`,
    );
    expect(row.className).toBe("row");
    expect(row.querySelector(".method")?.textContent).toBe("GET");
    expect(row.querySelector(".urlpath")?.textContent).toBe("/web/action");
    expect(row.querySelector(".query")?.textContent).toBe("?id=3");
    expect(row.querySelector(".code-chip")?.className).toBe("code-chip c2");
    // only the last float is the timing; the rest is meta
    const timing = row.querySelectorAll(".timing");
    expect(timing).toHaveLength(1);
    expect(timing[0].textContent).toBe("0.020");
    expect(timing[0].className).toBe("timing");
  });

  it("marks failing / redirect / informational statuses and slow requests", () => {
    const notFound = buildLogRow(`${LOG} INFO db werkzeug: x "POST /nope HTTP/1.1" 404 - 1 2.5`);
    expect(notFound.className).toBe("row err-row");
    expect(notFound.querySelector(".code-chip")?.className).toBe("code-chip c4");
    expect(notFound.querySelector(".query")?.textContent).toBe("");
    expect(notFound.querySelector(".timing")?.className).toBe("timing slow");
    const redirect = buildLogRow(`${LOG} INFO db werkzeug: x "GET /a HTTP/1.1" 303 - 1 150.0`);
    expect(redirect.querySelector(".code-chip")?.className).toBe("code-chip c3");
    expect(redirect.querySelector(".timing")?.className).toBe("timing vslow");
    const info = buildLogRow(`${LOG} INFO db werkzeug: x "GET /ws HTTP/1.1" 101 -`);
    expect(info.querySelector(".code-chip")?.className).toBe("code-chip c1");
  });

  it("keeps an unstructured line raw, and gives goo's own notes their own style", () => {
    const raw = buildLogRow("\x1b[31mTraceback (most recent call last):\x1b[0m");
    expect(raw.className).toBe("row raw");
    expect(raw.querySelector(".ansi-31")?.textContent).toBe("Traceback (most recent call last):");
    expect(buildLogRow("[goo] starting odoo: odoo-bin").className).toBe("row raw goo-line");
  });

  it("links a HOOT 'Running test' line to that single test in HOOT, via autologin", () => {
    const row = buildLogRow(`${LOG} INFO db odoo.tests: [HOOT] Running test "web > my test"`);
    const a = row.querySelector<HTMLAnchorElement>("a.hoot-link")!;
    expect(a.textContent).toBe("[open in hoot]");
    const url = new URL(a.href);
    expect(url.pathname).toBe("/dev/autologin");
    const to = new URL(url.searchParams.get("to")!, "http://x");
    expect(to.pathname).toBe("/web/tests");
    expect(to.searchParams.get("id")).toMatch(/^[0-9a-f]{8}$/);
    // the id is deterministic per test name, distinct across names
    const again = buildLogRow(`[HOOT] Running test "web > my test"`).querySelector("a")!;
    const other = buildLogRow(`[HOOT] Running test "web > other"`).querySelector("a")!;
    expect(again.href).toBe(a.href);
    expect(other.href).not.toBe(a.href);
  });

  it("hands a plain left-click on the HOOT link to the app; modified clicks pass through", () => {
    const a = buildLogRow(`[HOOT] Running test "t"`).querySelector("a")!;
    const opened: string[] = [];
    const onOpen = (e: Event) => opened.push((e as CustomEvent<{ url: string }>).detail.url);
    document.addEventListener("goo:open-hoot", onOpen);
    try {
      const plain = new MouseEvent("click", { button: 0, cancelable: true });
      a.dispatchEvent(plain);
      expect(plain.defaultPrevented).toBe(true);
      expect(opened).toEqual([a.href]);
      const ctrl = new MouseEvent("click", { button: 0, ctrlKey: true, cancelable: true });
      a.dispatchEvent(ctrl);
      expect(ctrl.defaultPrevented).toBe(false);
      expect(opened).toHaveLength(1);
    } finally {
      document.removeEventListener("goo:open-hoot", onOpen);
    }
  });
});

describe("ansiToHtml SGR handling", () => {
  it("resets bold with 22, color with 39, and skips 256/truecolor parameters", () => {
    expect(ansiToHtml("\x1b[1;32mA\x1b[22mB\x1b[39mC")).toBe(
      '<span class="ansi-32 ansi-bold">A</span><span class="ansi-32">B</span>C',
    );
    // 38;5;N and 38;2;R;G;B are consumed whole — none of their numbers leak as codes
    expect(ansiToHtml("\x1b[38;5;31mX\x1b[38;2;1;2;3mY\x1b[mZ")).toBe("XYZ");
  });
});

describe("mdToHtml paragraphs", () => {
  it("a blank line ends a paragraph or a list", () => {
    expect(mdToHtml("one\ntwo\n\nthree\n- a\n\nfour")).toBe(
      "<p>one two</p>\n<p>three</p>\n<ul><li>a</li></ul>\n<p>four</p>",
    );
  });
});

describe("postJSON / review prompt", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts a JSON body and returns the parsed reply", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, n: 1 })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await postJSON("/api/x", { a: 1 })).toEqual({ ok: true, n: 1 });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/x",
      expect.objectContaining({ method: "POST", body: '{"a":1}' }),
    );
  });

  it("throws the backend's error message, with the reply attached", async () => {
    const reply = { ok: false, error: "nope", in_progress: true };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(reply), { status: 409 })),
    );
    const err = await postJSON("/api/x").then(
      () => null,
      (e: PostJSONError) => e,
    );
    expect(err?.message).toBe("nope");
    expect(err?.data).toEqual(reply);
  });

  it("falls back to the HTTP status when the error reply isn't JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>", { status: 502 })),
    );
    await expect(postJSON("/api/x")).rejects.toThrow("502");
  });

  it("reads and saves the review prompt", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ ok: true }))
        : new Response(JSON.stringify({ content: "Review this." })),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchReviewPrompt()).toBe("Review this.");
    await saveReviewPrompt("New prompt");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/review-prompt",
      expect.objectContaining({ body: JSON.stringify({ content: "New prompt" }) }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json")),
    );
    expect(await fetchReviewPrompt()).toBe("");
  });
});
