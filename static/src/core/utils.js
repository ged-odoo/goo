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

// POST JSON; returns parsed body. Throws Error(message) on non-ok.
export async function postJSON(path, body) {
  const resp = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || resp.status);
  return data;
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
