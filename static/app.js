"use strict";

// ---------------------------------------------------------------------------
// Sidebar navigation (hash-based)
// ---------------------------------------------------------------------------

const SECTIONS = ["server", "git", "tasks", "runbot", "config"];

function showSection(name) {
  if (!SECTIONS.includes(name)) name = "server";
  for (const section of SECTIONS) {
    document.getElementById(`section-${section}`).classList.toggle("hidden", section !== name);
  }
  for (const btn of document.querySelectorAll(".nav-btn")) {
    btn.classList.toggle("active", btn.dataset.section === name);
  }
}

function onHashChange() {
  showSection(window.location.hash.replace("#", "") || "server");
}

for (const btn of document.querySelectorAll(".nav-btn")) {
  btn.addEventListener("click", () => { window.location.hash = btn.dataset.section; });
}
window.addEventListener("hashchange", onHashChange);
onHashChange();

// ---------------------------------------------------------------------------
// Server section: status + controls
// ---------------------------------------------------------------------------

const badge = document.getElementById("status-badge");
const hint = document.getElementById("server-hint");
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const btnRestart = document.getElementById("btn-restart");
const logPane = document.getElementById("log-pane");

function setStatus(status) {
  const state = status.state;
  badge.textContent = state;
  badge.className = `badge ${state}`;

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
