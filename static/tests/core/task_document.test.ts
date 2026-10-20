import { describe, expect, it } from "vitest";
import { TASK_FRAME_SANDBOX, odooDate, taskDocument } from "../../src/core/task_document.ts";
import type { TaskDetail } from "../../src/core/tasks_plugin.ts";

const TASK: TaskDetail = {
  id: 7,
  name: "Fix it",
  project: "Support",
  stage: "RD Dev",
  assignees: [],
  tags: [],
  customer: "",
  deadline: "",
  priority: "",
  parent: "",
  created: "",
  updated: "",
  created_by: "",
  description: "<p>Steps to <b>reproduce</b></p>",
  messages: [
    {
      id: 2,
      date: "2026-10-02 08:00:00",
      author: "<img src=x onerror=alert(1)>",
      kind: "Discussions",
      body: "<p>Second</p>",
    },
    { id: 1, date: "", author: "Bob", kind: "", body: "<p>First</p>" },
  ],
};

describe("taskDocument", () => {
  it("shows the description and the chatter, newest first as given", () => {
    const doc = taskDocument(TASK);
    expect(doc).toContain("<h2>Description</h2><p>Steps to <b>reproduce</b></p>");
    expect(doc.indexOf("Second")).toBeLessThan(doc.indexOf("First"));
    expect(doc).toContain("<i>Discussions</i>");
  });

  it("escapes what goo writes around the bodies (author, subtype), never the bodies", () => {
    const doc = taskDocument(TASK);
    expect(doc).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(doc).not.toContain("<img src=x onerror");
  });

  it("is locked down: no script, no request but https images, links in a new tab", () => {
    const doc = taskDocument(TASK);
    expect(doc).toContain("default-src 'none'; img-src https: data:; style-src 'unsafe-inline'");
    expect(doc).toContain('<base href="https://www.odoo.com/" target="_blank">');
    // the frame itself can run nothing and has no origin of its own
    expect(TASK_FRAME_SANDBOX).not.toContain("allow-scripts");
    expect(TASK_FRAME_SANDBOX).not.toContain("allow-same-origin");
    expect(TASK_FRAME_SANDBOX).toContain("allow-popups");
  });

  it("says so when there is nothing to show", () => {
    const doc = taskDocument({ ...TASK, description: "", messages: [] });
    expect(doc).toContain("No description.");
    expect(doc).toContain("No message yet.");
  });
});

describe("odooDate", () => {
  it("reads Odoo's naive UTC timestamps, and tolerates the empty and the odd", () => {
    expect(odooDate("2026-10-02 08:00:00")).toBe(new Date("2026-10-02T08:00:00Z").toLocaleString());
    expect(odooDate("")).toBe("");
    expect(odooDate("soon")).toBe("soon");
  });
});
