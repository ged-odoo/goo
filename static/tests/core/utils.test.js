import { describe, expect, it, vi, afterEach } from "vitest";
import {
  timeAgo,
  formatBytes,
  escapeHtml,
  parseReviewScore,
  reviewScoreClass,
  mdToHtml,
  tintCmd,
  ansiToHtml,
  worktreeSlug,
  worktreeDirFor,
  descendantWorkspaces,
  nestByParent,
  repoBranchList,
} from "../../src/core/utils.js";

describe("timeAgo", () => {
  const NOW = "2026-06-11T12:00:00Z";

  afterEach(() => vi.useRealTimers());

  it("formats seconds/minutes/hours/days ago, ISO8601 input", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    expect(timeAgo("2026-06-11T11:59:40Z")).toBe("just now"); // 20s
    expect(timeAgo("2026-06-11T11:55:00Z")).toBe("5m ago");
    expect(timeAgo("2026-06-11T10:00:00Z")).toBe("2h ago");
    expect(timeAgo("2026-06-09T12:00:00Z")).toBe("2d ago");
  });

  it("treats a naive 'YYYY-MM-DD HH:MM:SS' timestamp (no T) as UTC", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    expect(timeAgo("2026-06-11 11:55:00")).toBe("5m ago");
  });

  it("returns the input unchanged for an unparseable timestamp", () => {
    expect(timeAgo("not-a-date")).toBe("not-a-date");
  });
});

describe("formatBytes", () => {
  it("returns '' for null/undefined/NaN", () => {
    expect(formatBytes(null)).toBe("");
    expect(formatBytes(undefined)).toBe("");
    expect(formatBytes(NaN)).toBe("");
  });

  it("formats sub-1024 as bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("formats kB with one decimal when not integer and under 10", () => {
    expect(formatBytes(1536)).toBe("1.5 kB");
  });

  it("rounds to an integer once >= 10 units, or when already whole", () => {
    expect(formatBytes(1024)).toBe("1 kB");
    expect(formatBytes(21000000)).toBe("20 MB");
  });

  it("caps at TB and keeps rounding rather than inventing new units", () => {
    expect(formatBytes(1024 ** 5)).toBe("1024 TB");
  });
});

describe("escapeHtml", () => {
  it("escapes & < > but leaves quotes alone", () => {
    expect(escapeHtml(`<a href="x">&</a>`)).toBe(`&lt;a href="x"&gt;&amp;&lt;/a&gt;`);
  });
});

describe("parseReviewScore", () => {
  it("parses 'Score: N/100', case-insensitively and with flexible spacing", () => {
    expect(parseReviewScore("Score: 85/100")).toBe(85);
    expect(parseReviewScore("score:76/100")).toBe(76);
  });

  it("returns the LAST match when there are several", () => {
    expect(parseReviewScore("Score: 10/100 ... later Score: 90/100")).toBe(90);
  });

  it("clamps an out-of-range value into 0-100", () => {
    expect(parseReviewScore("Score: 150/100")).toBe(100);
  });

  it("returns null when there's no match, or no text", () => {
    expect(parseReviewScore("no score here")).toBeNull();
    expect(parseReviewScore(null)).toBeNull();
    expect(parseReviewScore(undefined)).toBeNull();
  });
});

describe("reviewScoreClass", () => {
  it("buckets into high/mid/low", () => {
    expect(reviewScoreClass(100)).toBe("high");
    expect(reviewScoreClass(70)).toBe("high");
    expect(reviewScoreClass(69)).toBe("mid");
    expect(reviewScoreClass(40)).toBe("mid");
    expect(reviewScoreClass(39)).toBe("low");
    expect(reviewScoreClass(0)).toBe("low");
  });
});

describe("mdToHtml", () => {
  // regression coverage for a95f570 (fix(fe): mdToHtml eating underscores inside
  // code spans and link URLs) — code/link spans must be pulled out BEFORE the
  // bold/italic passes run, so underscores inside them never get read as emphasis
  it("does not eat underscores inside an inline code span", () => {
    expect(mdToHtml("`base_import/models/base_import.py`")).toBe(
      "<p><code>base_import/models/base_import.py</code></p>",
    );
  });

  it("does not eat underscores inside a link URL", () => {
    expect(mdToHtml("[label](https://x.com/a_b_c)")).toBe(
      '<p><a href="https://x.com/a_b_c" target="_blank" rel="noopener">label</a></p>',
    );
  });

  it("still recognizes real emphasis outside code/link spans", () => {
    expect(mdToHtml("**bold** and _italic_")).toBe(
      "<p><strong>bold</strong> and <em>italic</em></p>",
    );
  });

  it("renders headings, lists, code fences, blockquotes and hr", () => {
    expect(mdToHtml("# Title")).toBe("<h1>Title</h1>");
    expect(mdToHtml("- one\n- two")).toBe("<ul><li>one</li><li>two</li></ul>");
    expect(mdToHtml("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>");
    expect(mdToHtml("```\ncode line\n```")).toBe(
      '<pre class="md-code"><code>code line</code></pre>',
    );
    expect(mdToHtml("> quoted")).toBe("<blockquote><p>quoted</p></blockquote>");
    expect(mdToHtml("---")).toBe("<hr/>");
  });

  it("wraps a plain line in a paragraph", () => {
    expect(mdToHtml("hello world")).toBe("<p>hello world</p>");
  });
});

describe("tintCmd", () => {
  it("tags flags and paths, escapes the rest", () => {
    expect(tintCmd("ls -la /tmp")).toBe(
      '<span class="prompt">$</span>ls <span class="flag">-la</span> <span class="path">/tmp</span>',
    );
  });
});

describe("ansiToHtml", () => {
  it("passes plain text through escaped, no spans", () => {
    expect(ansiToHtml("hello")).toBe("hello");
  });

  it("wraps a foreground color code in an ansi-N span", () => {
    expect(ansiToHtml("\x1b[31mred\x1b[0m")).toBe('<span class="ansi-31">red</span>');
  });

  it("wraps bold text in ansi-bold", () => {
    expect(ansiToHtml("\x1b[1mbold\x1b[22m")).toBe('<span class="ansi-bold">bold</span>');
  });

  it("strips OSC sequences entirely", () => {
    expect(ansiToHtml("\x1b]0;title\x07text")).toBe("text");
  });
});

describe("worktreeSlug", () => {
  it("replaces disallowed runs with a dash and trims leading/trailing dashes", () => {
    expect(worktreeSlug({ name: "My Feature!" })).toBe("My-Feature");
  });

  it("falls back to id when name is blank", () => {
    expect(worktreeSlug({ id: "abc123", name: "" })).toBe("abc123");
  });

  it("falls back to id when the sanitized name would be empty", () => {
    expect(worktreeSlug({ id: "xyz", name: "!!!" })).toBe("xyz");
  });
});

describe("worktreeDirFor", () => {
  it("joins the worktree dir (trailing slash stripped) with the slug", () => {
    expect(worktreeDirFor("/home/work/", { id: "x", name: "Foo" })).toBe("/home/work/Foo");
  });

  it("defaults to /tmp when worktreeDir is falsy", () => {
    expect(worktreeDirFor("", { id: "x" })).toBe("/tmp/x");
    expect(worktreeDirFor(null, { id: "x" })).toBe("/tmp/x");
  });
});

describe("descendantWorkspaces", () => {
  it("flattens all descendants, parent-before-child", () => {
    const list = [
      { id: "a" },
      { id: "b", parent: "a" },
      { id: "c", parent: "b" },
      { id: "d", parent: "a" },
    ];
    expect(descendantWorkspaces(list, "a").map((w) => w.id)).toEqual(["b", "d", "c"]);
  });

  it("returns [] for a leaf with no children", () => {
    const list = [{ id: "a" }, { id: "b", parent: "a" }];
    expect(descendantWorkspaces(list, "b")).toEqual([]);
  });
});

describe("nestByParent", () => {
  it("nests children directly after their parent with increasing depth", () => {
    const items = [{ id: "a" }, { id: "b", parent: "a" }, { id: "c", parent: "b" }];
    expect(nestByParent(items)).toEqual([
      { ws: items[0], depth: 0 },
      { ws: items[1], depth: 1 },
      { ws: items[2], depth: 2 },
    ]);
  });

  it("treats a parent missing from the list as depth 0, never dropped", () => {
    const items = [{ id: "x", parent: "missing" }];
    expect(nestByParent(items)).toEqual([{ ws: items[0], depth: 0 }]);
  });

  it("guards against a parent cycle instead of looping forever", () => {
    const items = [
      { id: "a", parent: "b" },
      { id: "b", parent: "a" },
    ];
    const result = nestByParent(items);
    expect(result.map((r) => r.ws.id)).toEqual(["a", "b"]);
  });
});

describe("repoBranchList", () => {
  it("formats repo:branch pairs joined by commas", () => {
    expect(
      repoBranchList.format([
        { repo: "community", branch: "master" },
        { repo: "enterprise", branch: "master" },
      ]),
    ).toBe("community:master,enterprise:master");
  });

  it("formats an empty/undefined list as ''", () => {
    expect(repoBranchList.format([])).toBe("");
    expect(repoBranchList.format(undefined)).toBe("");
  });

  it("parses, trimming whitespace around entries", () => {
    expect(repoBranchList.parse("community:master, enterprise:master")).toEqual([
      { repo: "community", branch: "master" },
      { repo: "enterprise", branch: "master" },
    ]);
  });

  it("defaults branch to '' when a pair has no ':branch'", () => {
    expect(repoBranchList.parse("community")).toEqual([{ repo: "community", branch: "" }]);
  });

  it("parses '' as an empty list", () => {
    expect(repoBranchList.parse("")).toEqual([]);
  });
});
