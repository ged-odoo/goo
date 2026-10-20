// The description and chatter of an Odoo task, as one HTML document for a sandboxed
// iframe. Their bodies are HTML written by other people: the frame has no scripts, no
// forms and no origin (no `allow-scripts` / `allow-same-origin`, see TASK_FRAME_SANDBOX),
// the document's own policy allows no script, request or frame either except https
// images, and links open in a new tab — so they can only be read, never run.

import { escapeHtml } from "./utils.ts";
import type { TaskDetail } from "./tasks_plugin.ts";

export const TASK_FRAME_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

const STYLE = `
  body { font: 13px/1.5 system-ui, sans-serif; color: #26262c; margin: 0; padding: 4px 2px 16px; }
  h2 { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: #777; margin: 18px 0 8px; }
  a { color: #6d3fc0; }
  img { max-width: 100%; height: auto; }
  pre, code { font-family: ui-monospace, monospace; font-size: 12px; background: #f3f1f6; border-radius: 4px; }
  pre { padding: 8px; overflow-x: auto; }
  blockquote { margin: 6px 0; padding-left: 10px; border-left: 3px solid #ddd; color: #555; }
  table { border-collapse: collapse; } td, th { border: 1px solid #ddd; padding: 2px 6px; }
  article { border: 1px solid #e6e3ea; border-radius: 8px; padding: 8px 12px; margin: 0 0 10px; }
  article > header { font-size: 12px; color: #777; margin-bottom: 4px; }
  article > header b { color: #26262c; }
  article > header i { margin-left: 6px; padding: 0 6px; border-radius: 4px; background: #f3f1f6; font-style: normal; }
  .dim { color: #888; }
`;

// Odoo's naive UTC "2026-10-02 08:00:00" in the reader's time zone
export function odooDate(ts: string): string {
  if (!ts) return "";
  const date = new Date(ts.replace(" ", "T") + "Z");
  return isNaN(date.getTime()) ? ts : date.toLocaleString();
}

export function taskDocument(task: TaskDetail): string {
  const messages = task.messages
    .map(
      (m) =>
        `<article><header><b>${escapeHtml(m.author)}</b> · ${escapeHtml(odooDate(m.date))}` +
        `${m.kind ? `<i>${escapeHtml(m.kind)}</i>` : ""}</header>${m.body}</article>`,
    )
    .join("");
  return (
    `<!doctype html><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'">` +
    `<base href="https://www.odoo.com/" target="_blank"><style>${STYLE}</style>` +
    `<h2>Description</h2>${task.description || '<p class="dim">No description.</p>'}` +
    `<h2>Chatter</h2>${messages || '<p class="dim">No message yet.</p>'}`
  );
}
