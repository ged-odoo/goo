"use strict";

// ---------------------------------------------------------------------------
// Sidebar navigation (hash-based)
// ---------------------------------------------------------------------------

const SECTIONS = ["server", "databases", "git", "tasks", "runbot", "config"];

function showSection(name) {
  if (!SECTIONS.includes(name)) name = "server";
  for (const section of SECTIONS) {
    document.getElementById(`section-${section}`).classList.toggle("hidden", section !== name);
  }
  for (const btn of document.querySelectorAll(".nav-btn")) {
    btn.classList.toggle("active", btn.dataset.section === name);
  }
  if (name === "databases") loadDatabases();
}

function onHashChange() {
  showSection(window.location.hash.replace("#", "") || "server");
}

for (const btn of document.querySelectorAll(".nav-btn")) {
  btn.addEventListener("click", () => { window.location.hash = btn.dataset.section; });
}
window.addEventListener("hashchange", onHashChange);

// ---------------------------------------------------------------------------
// Server section: status + controls
// ---------------------------------------------------------------------------

const badge = document.getElementById("status-badge");
const serverDot = document.getElementById("server-dot");
const hint = document.getElementById("server-hint");
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const btnRestart = document.getElementById("btn-restart");
const logPane = document.getElementById("log-pane");

function setStatus(status) {
  const state = status.state;
  badge.textContent = state;
  badge.className = `badge ${state}`;
  serverDot.classList.toggle("on", state === "running");
  document.getElementById("favicon").href =
    state === "running" ? "/static/favicon-on.svg" : "/static/favicon.svg";

  const active = state === "starting" || state === "running";
  btnStart.disabled = state !== "stopped";
  btnStop.disabled = !active;
  btnRestart.disabled = !active;

  const hints = [];
  if (status.exited_unexpectedly) {
    hints.push(`odoo exited unexpectedly (code ${status.returncode})`);
  }
  if (state === "stopped" && status.odoo_port_busy) {
    hints.push("port 8069 is busy (external odoo?) — Stop will kill it");
    btnStop.disabled = false;
  }
  hint.textContent = hints.join(" — ");
}

async function post(path, body) {
  try {
    const resp = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await resp.json();
    if (!resp.ok) {
      appendLog(`[oo] ${path} failed: ${data.error || resp.status}`);
    }
  } catch (err) {
    appendLog(`[oo] ${path} failed: ${err}`);
  }
}

btnStart.addEventListener("click", () => post("/api/start", CONFIG));
btnStop.addEventListener("click", () => post("/api/stop"));
btnRestart.addEventListener("click", () => post("/api/restart", CONFIG));

// ---------------------------------------------------------------------------
// Databases section
// ---------------------------------------------------------------------------

const dbList = document.getElementById("db-list");

document.getElementById("btn-db-refresh").addEventListener("click", loadDatabases);

async function loadDatabases() {
  dbList.textContent = "Loading…";
  try {
    const resp = await fetch("/api/databases");
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || resp.status);
    renderDatabases(data.databases);
  } catch (err) {
    dbList.textContent = `Failed to load databases: ${err.message}`;
  }
}

function renderDatabases(dbs) {
  dbList.replaceChildren();
  if (!dbs.length) {
    dbList.textContent = "No databases.";
    return;
  }
  const table = document.createElement("table");
  table.className = "db-table";
  table.innerHTML = "<thead><tr><th>Name</th><th>Odoo version</th><th></th></tr></thead>";
  const tbody = document.createElement("tbody");
  for (const db of dbs) {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = db.name;
    const version = document.createElement("td");
    version.textContent = db.odoo_version
      ? db.odoo_version + (db.enterprise ? " (ent)" : "")
      : "—";
    if (!db.odoo_version) version.className = "dim";
    const actions = document.createElement("td");
    actions.className = "db-actions";
    const btn = document.createElement("button");
    btn.textContent = "Drop";
    btn.className = "drop-btn";
    btn.addEventListener("click", () => dropDatabase(db.name, btn));
    actions.appendChild(btn);
    tr.append(name, version, actions);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  dbList.appendChild(table);
}

async function dropDatabase(name, btn) {
  if (!confirm(`Drop database "${name}"? This cannot be undone.`)) return;
  btn.disabled = true;
  try {
    const resp = await fetch("/api/databases/drop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || resp.status);
  } catch (err) {
    alert(`Drop failed: ${err.message}`);
    btn.disabled = false;
    return;
  }
  loadDatabases();
}

// ---------------------------------------------------------------------------
// Live events (SSE)
// ---------------------------------------------------------------------------

function connect() {
  const es = new EventSource("/api/events");
  // the server replays its full log buffer on connect, so start clean
  es.onopen = () => logPane.replaceChildren();
  es.onerror = () => setStatus({ state: "disconnected" });
  es.addEventListener("status", (e) => setStatus(JSON.parse(e.data)));
  es.addEventListener("log", (e) => appendLog(JSON.parse(e.data).line));
}

connect();

// ---------------------------------------------------------------------------
// Log pane: batched appends, auto-scroll unless scrolled up
// ---------------------------------------------------------------------------

const MAX_LOG_LINES = 2000;
let pendingLines = [];
let flushScheduled = false;

function appendLog(line) {
  pendingLines.push(line);
  if (!flushScheduled) {
    flushScheduled = true;
    requestAnimationFrame(flushLog);
  }
}

function flushLog() {
  flushScheduled = false;
  const lines = pendingLines;
  pendingLines = [];
  const atBottom = logPane.scrollTop + logPane.clientHeight >= logPane.scrollHeight - 4;
  const frag = document.createDocumentFragment();
  for (const line of lines) {
    const div = document.createElement("div");
    div.className = "log-line";
    div.innerHTML = ansiToHtml(line);
    frag.appendChild(div);
  }
  logPane.appendChild(frag);
  while (logPane.childElementCount > MAX_LOG_LINES) {
    logPane.firstElementChild.remove();
  }
  if (atBottom) logPane.scrollTop = logPane.scrollHeight;
}

// ---------------------------------------------------------------------------
// Minimal ANSI -> HTML (SGR colors only; everything else is stripped)
// ---------------------------------------------------------------------------

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function ansiToHtml(line) {
  // OSC sequences (terminal title etc.)
  line = line.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
  let html = "";
  let fg = null;
  let bold = false;
  const parts = line.split(/\x1b\[([0-9;]*)m/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      // non-SGR CSI sequences (cursor movement, clears)
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
        if (p === 0) { fg = null; bold = false; }
        else if (p === 1) bold = true;
        else if (p === 22) bold = false;
        else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) fg = p;
        else if (p === 39) fg = null;
        else if (p === 38 || p === 48) j += params[j + 1] === 2 ? 4 : 2; // skip 256/truecolor args
      }
    }
  }
  return html;
}

// ---------------------------------------------------------------------------
// Initial render (last: section handlers above must be set up first)
// ---------------------------------------------------------------------------

onHashChange();
