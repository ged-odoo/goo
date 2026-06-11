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
  if (name === "server") populateTargetSelect(); // pick up config edits
  if (name === "databases") loadDatabases();
  if (name === "config") renderConfigEditors();
}

function onHashChange() {
  showSection(window.location.hash.replace("#", "") || "server");
}

for (const btn of document.querySelectorAll(".nav-btn")) {
  btn.addEventListener("click", () => { window.location.hash = btn.dataset.section; });
}
window.addEventListener("hashchange", onHashChange);

// ---------------------------------------------------------------------------
// Config store: localStorage overrides on top of DEFAULT_CONFIG (config.js)
// ---------------------------------------------------------------------------

const STORAGE_KEY = "oo-config";

function storedConfig() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function getConfig() {
  return { ...DEFAULT_CONFIG, ...storedConfig() };
}

function updateStoredConfig(patch) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...storedConfig(), ...patch }));
}

// ---------------------------------------------------------------------------
// Server section: status + controls
// ---------------------------------------------------------------------------

const badge = document.getElementById("status-badge");
const serverDot = document.getElementById("server-dot");
const serverInfo = document.getElementById("server-info");
const targetBadge = document.getElementById("target-badge");
const targetSelect = document.getElementById("target-select");
let lastStatus = null;

const LAST_TARGET_KEY = "oo-last-target";

function populateTargetSelect() {
  const current = targetSelect.value || localStorage.getItem(LAST_TARGET_KEY);
  targetSelect.replaceChildren();
  for (const t of getConfig().targets) {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.id;
    opt.title = `${t.repos.join(",")} → ${t.db}`;
    targetSelect.appendChild(opt);
  }
  if ([...targetSelect.options].some((o) => o.value === current)) {
    targetSelect.value = current;
  }
}

function buildStartConfig(targetId) {
  const cfg = getConfig();
  const target = cfg.targets.find((t) => t.id === targetId);
  if (!target) return null;
  return {
    ...cfg,
    target: target.id,
    start: {
      repos: target.repos,
      db: target.db,
      on_create_args: target.on_create_args || "",
      other_args: cfg.start.other_args,
    },
  };
}
const hint = document.getElementById("server-hint");
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const btnRestart = document.getElementById("btn-restart");
const logPane = document.getElementById("log-pane");

function setStatus(status) {
  lastStatus = status;
  const state = status.state;
  badge.textContent = state;
  badge.className = `badge ${state}`;
  serverDot.classList.toggle("on", state === "running");
  targetBadge.hidden = !status.target;
  targetBadge.textContent = status.target || "";
  if (state === "stopped") populateTargetSelect();
  targetSelect.hidden = state !== "stopped";
  document.getElementById("favicon").href =
    state === "running" ? "/static/favicon-on.svg" : "/static/favicon.svg";

  const active = state === "starting" || state === "running";
  btnStart.disabled = state !== "stopped";
  btnStop.disabled = !active;
  btnRestart.disabled = !active;

  const info = [];
  if (status.db) {
    info.push(`database: ${status.db}`);
    if (status.odoo_version) {
      info.push(`odoo ${status.odoo_version}${status.enterprise ? " (ent)" : ""}`);
    }
  }
  serverInfo.textContent = info.join("  ·  ");
  serverInfo.hidden = !info.length;

  const serverCmd = document.getElementById("server-cmd");
  serverCmd.textContent = status.cmd ? `$ ${status.cmd}` : "";
  serverCmd.hidden = !status.cmd;

  const newActiveDb = status.db || null;
  if (newActiveDb !== activeDb) {
    activeDb = newActiveDb;
    if (lastDbs) renderDatabases(lastDbs);
  }

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

function startAction(path, targetId) {
  const config = buildStartConfig(targetId);
  if (!config) return appendLog(`[oo] no such target: "${targetId || ""}" — check the Config tab`);
  localStorage.setItem(LAST_TARGET_KEY, config.target);
  post(path, config);
}

btnStart.addEventListener("click", () => startAction("/api/start", targetSelect.value));
btnStop.addEventListener("click", () => post("/api/stop"));
// restart reuses the target the server was started with, not the selector
btnRestart.addEventListener("click", () =>
  startAction("/api/restart", lastStatus?.target ?? targetSelect.value));

// ---------------------------------------------------------------------------
// Databases section
// ---------------------------------------------------------------------------

const dbList = document.getElementById("db-list");
let activeDb = null;  // db of the starting/running server, bolded + undroppable
let lastDbs = null;

document.getElementById("btn-db-refresh").addEventListener("click", loadDatabases);

async function loadDatabases() {
  dbList.textContent = "Loading…";
  try {
    const resp = await fetch("/api/databases");
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || resp.status);
    lastDbs = data.databases;
    renderDatabases(lastDbs);
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
  table.innerHTML =
    "<thead><tr><th>Name</th><th>Odoo version</th><th>Last update</th><th></th></tr></thead>";
  const tbody = document.createElement("tbody");
  for (const db of dbs) {
    const isActive = db.name === activeDb;
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = db.name;
    if (isActive) name.className = "active-db";
    const version = document.createElement("td");
    version.textContent = db.odoo_version
      ? db.odoo_version + (db.enterprise ? " (ent)" : "")
      : "—";
    if (!db.odoo_version) version.className = "dim";
    const lastUpdate = document.createElement("td");
    lastUpdate.textContent = db.last_update ? timeAgo(db.last_update) : "—";
    if (db.last_update) lastUpdate.title = `${db.last_update} (UTC)`;
    else lastUpdate.className = "dim";
    const actions = document.createElement("td");
    actions.className = "db-actions";
    const btn = document.createElement("button");
    btn.textContent = "Drop";
    btn.className = "drop-btn";
    if (isActive) {
      btn.disabled = true;
      btn.title = "in use by the running server";
    }
    btn.addEventListener("click", () => dropDatabase(db.name, btn));
    actions.appendChild(btn);
    tr.append(name, version, lastUpdate, actions);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  dbList.appendChild(table);
}

function timeAgo(ts) {
  // odoo timestamps are naive UTC: "2026-06-11 12:34:56.789..."
  const date = new Date(ts.replace(" ", "T") + "Z");
  if (isNaN(date)) return ts;
  const secs = Math.max(0, Math.floor((Date.now() - date) / 1000));
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
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
// Config section: list editors (repositories, targets)
// ---------------------------------------------------------------------------

function createListEditor({ prefix, storageKey, itemName, fields, validate }) {
  const rowsEl = document.getElementById(`${prefix}-rows`);
  const msgEl = document.getElementById(`${prefix}-msg`);

  function flash(text, isError) {
    msgEl.textContent = text;
    msgEl.className = isError ? "error" : "ok";
    if (!isError) setTimeout(() => { msgEl.textContent = ""; }, 2000);
  }

  function makeRow(item = {}) {
    const row = document.createElement("div");
    row.className = "edit-row";
    for (const f of fields) {
      const input = document.createElement("input");
      input.placeholder = f.placeholder;
      input.value = f.format ? f.format(item[f.key]) : item[f.key] || "";
      input.className = f.className;
      input.dataset.key = f.key;
      row.appendChild(input);
    }
    const remove = document.createElement("button");
    remove.textContent = "✕";
    remove.title = "remove";
    remove.className = "row-remove";
    remove.addEventListener("click", () => row.remove());
    row.appendChild(remove);
    return row;
  }

  function render() {
    rowsEl.replaceChildren();
    for (const item of getConfig()[storageKey]) {
      rowsEl.appendChild(makeRow(item));
    }
  }

  function save() {
    const items = [];
    const seen = new Set();
    for (const row of rowsEl.children) {
      const raw = {};
      for (const input of row.querySelectorAll("input")) {
        raw[input.dataset.key] = input.value.trim();
      }
      if (fields.every((f) => !raw[f.key])) continue; // ignore empty rows
      for (const f of fields) {
        if (!f.optional && !raw[f.key]) {
          return flash(`every ${itemName} needs a ${f.name}`, true);
        }
      }
      if (seen.has(raw.id)) return flash(`duplicate ${fields[0].name} "${raw.id}"`, true);
      seen.add(raw.id);
      const item = {};
      for (const f of fields) {
        item[f.key] = f.parse ? f.parse(raw[f.key]) : raw[f.key];
      }
      items.push(item);
    }
    const error = validate && validate(items);
    if (error) return flash(error, true);
    updateStoredConfig({ [storageKey]: items });
    render();
    flash("saved");
  }

  document.getElementById(`btn-${prefix}-add`).addEventListener("click", () => {
    rowsEl.appendChild(makeRow());
    rowsEl.lastElementChild.querySelector("input").focus();
  });
  document.getElementById(`btn-${prefix}-save`).addEventListener("click", save);
  document.getElementById(`btn-${prefix}-reset`).addEventListener("click", () => {
    if (!confirm(`Reset ${itemName}s to the built-in defaults?`)) return;
    const stored = storedConfig();
    delete stored[storageKey];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    render();
    flash("reset to defaults");
  });

  return { render };
}

const commaList = {
  format: (v) => (v || []).join(","),
  parse: (s) => s.split(",").map((x) => x.trim()).filter(Boolean),
};

const repoEditor = createListEditor({
  prefix: "repo",
  storageKey: "repos",
  itemName: "repository",
  fields: [
    { key: "id", name: "name", placeholder: "name (e.g. community)", className: "w-name" },
    { key: "path", name: "path", placeholder: "path (e.g. ~/work/community)", className: "w-flex" },
  ],
  validate(repos) {
    if (!repos.find((r) => r.id === "community")) {
      return 'a "community" repository is required (odoo-bin lives there)';
    }
    const ids = new Set(repos.map((r) => r.id));
    for (const t of getConfig().targets) {
      const used = (t.repos || []).find((id) => !ids.has(id));
      if (used) return `repository "${used}" is still used by target "${t.id}"`;
    }
    return null;
  },
});

const targetEditor = createListEditor({
  prefix: "target",
  storageKey: "targets",
  itemName: "target",
  fields: [
    { key: "id", name: "id", placeholder: "id (e.g. enterprise)", className: "w-name" },
    { key: "repos", name: "repos list", placeholder: "repos (e.g. community,enterprise)",
      className: "w-mid", ...commaList },
    { key: "db", name: "db", placeholder: "db (e.g. test_db_e)", className: "w-name" },
    { key: "on_create_args", name: "on-create args",
      placeholder: "on create args (e.g. -i sale_management)", className: "w-flex", optional: true },
  ],
  validate(targets) {
    const repoIds = new Set(getConfig().repos.map((r) => r.id));
    for (const t of targets) {
      const unknown = t.repos.find((id) => !repoIds.has(id));
      if (unknown) return `target "${t.id}": unknown repository "${unknown}"`;
    }
    return null;
  },
});

function renderConfigEditors() {
  repoEditor.render();
  targetEditor.render();
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
