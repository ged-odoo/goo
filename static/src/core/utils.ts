// Pure helpers: time formatting, command tinting, and odoo-log -> DOM parsing.
// The log parser builds detached DOM nodes (appended manually by the console
// component) — re-rendering thousands of lines through the framework is too slow.

export function timeAgo(ts) {
  // either ISO8601 with timezone (git) or naive UTC "2026-06-11 12:34:56" (odoo)
  const date = ts.includes("T") ? new Date(ts) : new Date(ts.replace(" ", "T") + "Z");
  if (isNaN(date)) return ts;
  const secs = Math.max(0, Math.floor((Date.now() - date) / 1000));
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// a byte count as a compact human size (e.g. 0 -> "0 B", 1536 -> "1.5 kB",
// 21000000 -> "20 MB"). Returns "" for null/undefined (size unknown).
export function formatBytes(n) {
  if (n == null || isNaN(n)) return "";
  if (n < 1024) return `${n} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Claude's own merge-readiness guess (0-100) reported at the end of a review
// turn, if any. A review run always ends its prompt with a fixed, non-editable
// instruction to report one as "Score: N/100" (see REVIEW_SCORE_INSTRUCTION,
// workspaces_screen/dialogs.ts), so this needs no dedicated backend field.
// Returns the LAST one found in `text` (a later re-review after changes wins
// when the caller feeds it the whole conversation), or null if none was ever
// reported (an older review, a non-review chat, or Claude just didn't comply).
export function parseReviewScore(text) {
  const re = /score\s*:\s*(\d{1,3})\s*\/\s*100/gi;
  let score = null;
  let m;
  while ((m = re.exec(text || ""))) score = Math.max(0, Math.min(100, Number(m[1])));
  return score;
}

// the little colored badge's variant for a review score — shared by the Reviews
// screen's group-header button and ReviewPanel's header.
export function reviewScoreClass(score) {
  if (score >= 70) return "high";
  if (score >= 40) return "mid";
  return "low";
}

// inline markdown spans (code/links/bold/italic) within one line of text — order
// matters: code AND link spans are pulled out FIRST, before the bold/italic
// passes run, and swapped back in verbatim at the very end. A regex has no
// notion of "inside a tag": running the bold/italic passes over already-emitted
// <code>/<a> HTML (as this used to) means any two underscores anywhere within —
// or even across — those spans (e.g. `base_import/models/base_import.py`, two
// separate `load`/`load_records` code spans, or a link URL like
// https://x.com/a_b_c) get misread as an italic delimiter pair and silently
// eaten. Pulling both out into opaque placeholders first means the bold/italic
// regexes genuinely never see that content — the trade-off is that markdown
// emphasis inside a link's label isn't recognized either, which this renderer
// never documented as supported anyway.
function inlineMd(text) {
  const spans = []; // pre-rendered <code>/<a> HTML, restored verbatim at the end
  const stash = (html) => {
    spans.push(html);
    // \0 can't occur in real text (nor survive escapeHtml, which only touches
    // &/</>) — a placeholder built from ordinary characters (digits, letters)
    // could collide with the text around it (e.g. "line 51" containing "51").
    return `\0${spans.length - 1}\0`;
  };
  let s = text.replace(/`([^`]+?)`/g, (_, code) => stash(`<code>${escapeHtml(code)}</code>`));
  s = escapeHtml(s);
  // the URL itself excludes quotes (on top of whitespace/")" already excluded to find
  // the link's closing paren) — escapeHtml only strips &/</>, not ' or ", so a raw
  // quote reaching here would otherwise close the href="..." attribute early and let
  // the rest of the "URL" inject arbitrary attributes (e.g. onmouseover=...). The
  // .replace is defense in depth for any quote that slips through some other way.
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)"']+)\)/g, (_, label, url) =>
    stash(`<a href="${url.replace(/"/g, "&quot;")}" target="_blank" rel="noopener">${label}</a>`),
  );
  s = s.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+?)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_])_([^_\s][^_]*?)_(?!_)/g, "$1<em>$2</em>");
  s = s.replace(/\0(\d+)\0/g, (_, i) => spans[i]);
  return s;
}

// a small, dependency-free markdown → HTML renderer for Claude's review replies
// (headings, bold/italic/inline-code, fenced code blocks, bullet/numbered lists,
// blockquotes, hr, links, paragraphs) — goo stays free of runtime npm packages
// (see package.json: everything there is a devDependency), so this covers the
// common subset rather than pulling in a full markdown library. The result is
// only ever passed through owl's `markup()` by the caller, never inserted as
// raw HTML on its own — every text run goes through escapeHtml first (in
// inlineMd, or directly for code-fence bodies).
export function mdToHtml(text) {
  const lines = (text || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let para = [];
  let list = null; // { type: "ul"|"ol", items: [...] }
  const flushPara = () => {
    if (para.length) out.push(`<p>${inlineMd(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it) => `<li>${inlineMd(it)}</li>`).join("");
    out.push(`<${list.type}>${items}</${list.type}>`);
    list = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushPara();
      flushList();
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // skip the closing fence
      out.push(`<pre class="md-code"><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      out.push(`<h${heading[1].length}>${inlineMd(heading[2].trim())}</h${heading[1].length}>`);
      i++;
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      flushList();
      out.push("<hr/>");
      i++;
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const type = ul ? "ul" : "ol";
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push((ul || ol)[1]);
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      flushList();
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i]))
        quote.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote><p>${inlineMd(quote.join(" "))}</p></blockquote>`);
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      flushList();
      i++;
      continue;
    }
    flushList();
    para.push(line.trim());
    i++;
  }
  flushPara();
  flushList();
  return out.join("\n");
}

export function tintCmd(cmd) {
  const tokens = cmd.split(" ").map((tok) => {
    const esc = escapeHtml(tok);
    if (tok.startsWith("-")) return `<span class="flag">${esc}</span>`;
    if (tok.includes("/")) return `<span class="path">${esc}</span>`;
    return esc;
  });
  return `<span class="prompt">$</span>${tokens.join(" ")}`;
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const LOG_RE =
  /^(?:\d{4}-\d{2}-\d{2} )?(\d{2}:\d{2}:\d{2},\d+) (\d+) (DEBUG|INFO|WARNING|ERROR|CRITICAL) (\S+) ([\w.]+): (.*)$/;
const HTTP_RE =
  /^(.*?)"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) ([^"]*) (HTTP\/[\d.]+)" (\d{3}) ?(.*)$/;
const LVL_CLASS = { DEBUG: "info", INFO: "info", WARNING: "warn", ERROR: "err", CRITICAL: "err" };

function tintHttpMeta(rest) {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  const floatIdx = tokens.flatMap((t, i) => (/^\d+\.\d+$/.test(t) ? [i] : []));
  const last = floatIdx[floatIdx.length - 1];
  return tokens
    .map((t, i) => {
      if (i === last) {
        const v = parseFloat(t);
        const cls = v >= 100 ? "timing vslow" : v >= 1 ? "timing slow" : "timing";
        return `<span class="${cls}">${escapeHtml(t)}</span>`;
      }
      return ` <span class="meta">${escapeHtml(t)}</span>`;
    })
    .join("");
}

export function ansiToHtml(line) {
  line = line.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
  let html = "";
  let fg = null;
  let bold = false;
  const parts = line.split(/\x1b\[([0-9;]*)m/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      const text = parts[i].replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
      if (!text) continue;
      const classes = [];
      if (fg !== null) classes.push(`ansi-${fg}`);
      if (bold) classes.push("ansi-bold");
      html += classes.length
        ? `<span class="${classes.join(" ")}">${escapeHtml(text)}</span>`
        : escapeHtml(text);
    } else {
      const params = parts[i] === "" ? [0] : parts[i].split(";").map(Number);
      for (let j = 0; j < params.length; j++) {
        const p = params[j];
        if (p === 0) {
          fg = null;
          bold = false;
        } else if (p === 1) bold = true;
        else if (p === 22) bold = false;
        else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) fg = p;
        else if (p === 39) fg = null;
        else if (p === 38 || p === 48) j += params[j + 1] === 2 ? 4 : 2;
      }
    }
  }
  return html;
}

// HOOT's own test id: Java-style String.hashCode of the test's full name, as an
// 8-char hex string. Mirrors generateHash() in web/static/lib/hoot/hoot_utils.js
// (the id is generateHash(fullName) in core/job.js).
function hootTestId(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  return (hash + 16 ** 8).toString(16).slice(-8);
}

function hootTestUrl(name) {
  // go through the autologin addon (?to=<url-encoded target>) so no manual login
  // is needed — same as the navbar /odoo and /web/tests links
  const to = `/web/tests?debug=assets&timeout=500000&id=${hootTestId(name)}`;
  return `http://localhost:8069/dev/autologin?to=${encodeURIComponent(to)}`;
}

// append an "[open in hoot]" link that opens the single test in HOOT's web UI.
// HOOT is served by the odoo server, so left-click is intercepted and handed to
// the app (via a DOM event) which starts the server first if it isn't running.
function appendHootLink(div, name) {
  const a = document.createElement("a");
  const url = hootTestUrl(name);
  a.className = "hoot-link";
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = "[open in hoot]";
  a.addEventListener("click", (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return; // let real new-tab clicks through
    e.preventDefault();
    document.dispatchEvent(new CustomEvent("goo:open-hoot", { detail: { url } }));
  });
  div.appendChild(a);
}

// Build a detached <div class="row"> for one odoo log line.
export function buildLogRow(line) {
  const div = document.createElement("div");
  const text = line.replace(ANSI_RE, "");
  // a HOOT "Running test" line gets a link to open that test in the HOOT web UI
  const hoot = text.match(/\[HOOT\] Running test "(.+?)"/);
  const m = LOG_RE.exec(text);
  if (!m) {
    // goo's own events ("[goo] …") get a gray background to stand out from odoo logs
    div.className = text.startsWith("[goo]") ? "row raw goo-line" : "row raw";
    div.innerHTML = `<span class="msg">${ansiToHtml(line)}</span>`;
    if (hoot) appendHootLink(div, hoot[1]);
    return div;
  }
  const [, ts, pid, lvl, , logger, msg] = m;
  let rowCls = "row";
  if (lvl === "ERROR" || lvl === "CRITICAL") rowCls += " err-row";
  else if (lvl === "WARNING" || logger.includes("ir_cron")) rowCls += " warn-row";

  let msgHtml;
  const h = HTTP_RE.exec(msg);
  if (h) {
    const [, prefix, method, url, proto, status, rest] = h;
    const qi = url.indexOf("?");
    const path = qi === -1 ? url : url.slice(0, qi);
    const query = qi === -1 ? "" : url.slice(qi);
    const code = Number(status);
    if (code >= 400) rowCls = "row err-row";
    const cc = code < 200 ? "c1" : code < 300 ? "c2" : code < 400 ? "c3" : "c4";
    msgHtml =
      `<span class="meta">${escapeHtml(prefix)}</span>` +
      `<span class="quote">"</span><span class="method">${method}</span>` +
      `<span class="urlpath">${escapeHtml(path)}</span><span class="query">${escapeHtml(query)}</span>` +
      `<span class="proto">${proto}</span><span class="quote">"</span>` +
      `<span class="code-chip ${cc}">${status}</span>${tintHttpMeta(rest)}`;
  } else {
    msgHtml = `<span class="plain">${escapeHtml(msg)}</span>`;
  }

  div.className = rowCls;
  div.innerHTML =
    `<span class="ts">${ts}</span><span class="pid">${pid}</span>` +
    `<span class="lvl ${LVL_CLASS[lvl]}">${lvl === "WARNING" ? "WARN" : lvl === "CRITICAL" ? "CRIT" : lvl}</span>` +
    `<span class="logger">${escapeHtml(logger)}:</span>` +
    `<span class="msg">${msgHtml}</span>`;
  if (hoot) appendHootLink(div, hoot[1]);
  return div;
}

// POST JSON; returns parsed body. Throws Error(message) on non-ok — the parsed
// body is attached as `.data`, so a caller that needs more than the message
// (e.g. rewriteHistory's `in_progress` flag) can still get at it: the backend
// sends a non-2xx status for any `{ok: false}` reply, so a plain `if (!res.ok)`
// check AFTER a postJSON call is unreachable — postJSON already threw.
export async function postJSON(path, body) {
  const resp = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(data.error || resp.status);
    err.data = data;
    throw err;
  }
  return data;
}

// The Claude review prompt template — a real .md file on disk (not part of the
// reactive config blob), edited in the Configuration screen and read fresh at
// review time (workspaces_screen/dialogs.ts's runClaudeReview).
export async function fetchReviewPrompt() {
  const res = await fetch("/api/review-prompt");
  const data = await res.json().catch(() => ({}));
  return data.content || "";
}

export async function saveReviewPrompt(content) {
  return postJSON("/api/review-prompt", { content });
}

// filesystem-safe folder name for a worktree target (case-preserving; falls back
// to the stable id). Kept pure so both WorkspacePlugin.dirPath and the config
// migration derive the same path.
export function worktreeSlug(tgt) {
  const s = (tgt.name || tgt.id || "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || tgt.id;
}

// the derived worktree directory <worktree_dir>/<slug>. A worktree target's
// persisted `worktree.dir` (frozen at creation) should be preferred over this —
// see WorkspacePlugin.dirPath. Deriving from the name is only correct at creation
// time; afterwards a rename would move the derived path off the real checkout.
export function worktreeDirFor(worktreeDir, tgt) {
  return `${(worktreeDir || "/tmp").replace(/\/+$/, "")}/${worktreeSlug(tgt)}`;
}

// every descendant of `id` within a workspaces blob array (plain {id, parent, ...}
// objects — config.config.workspaces shape), flattened recursively (all levels), in
// parent-before-child order. Pure/read-only — used to size a cascade-delete
// confirmation message. The actual cascade executor (cascadeRemoveDescendants,
// workspace_plugin.ts) walks level-by-level instead, so it can stop descending into a
// child that couldn't be removed and leave its own subtree untouched.
export function descendantWorkspaces(list, id) {
  const byParent = new Map();
  for (const w of list) {
    if (!w.parent) continue;
    if (!byParent.has(w.parent)) byParent.set(w.parent, []);
    byParent.get(w.parent).push(w);
  }
  const out = [];
  let frontier = byParent.get(id) || [];
  while (frontier.length) {
    out.push(...frontier);
    frontier = frontier.flatMap((w) => byParent.get(w.id) || []);
  }
  return out;
}

// re-order an already-sorted, already-grouped workspace list so each item directly
// follows its parent, tagging every item with its nesting depth (0 = root). The chosen
// sort order is preserved independently among roots and among each parent's children —
// both simply keep their relative order from `items`. An item whose parent isn't present
// in THIS list (filtered out by search, a different category group, etc.) renders as an
// ordinary top-level (depth 0) entry — never dropped. Returns [{ ws, depth }].
export function nestByParent(items) {
  const byId = new Map(items.map((ws) => [ws.id, ws]));
  const childrenOf = new Map();
  for (const ws of items) {
    const p = ws.parent && byId.has(ws.parent) ? ws.parent : "";
    if (!p) continue;
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p).push(ws);
  }
  const out = [];
  const emitted = new Set();
  const emit = (ws, depth) => {
    if (emitted.has(ws.id)) return; // cycle guard — parent is set once at creation to
    emitted.add(ws.id); // an existing ancestor, never user-edited, so this shouldn't
    out.push({ ws, depth }); // trigger, but stay safe
    for (const child of childrenOf.get(ws.id) || []) emit(child, depth + 1);
  };
  for (const ws of items) {
    const p = ws.parent && byId.has(ws.parent) ? ws.parent : "";
    if (!p) emit(ws, 0);
  }
  for (const ws of items) if (!emitted.has(ws.id)) emit(ws, 0); // never drop an item
  return out;
}

// the "repo:branch,repo:branch" config-string format used by the workspace /
// template create+edit dialogs — one line both ways
export const repoBranchList = {
  format: (v) => (v || []).map((c) => `${c.repo}:${c.branch}`).join(","),
  parse: (s) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((pair) => {
        const [repo, branch = ""] = pair.split(":").map((p) => p.trim());
        return { repo, branch };
      }),
};
