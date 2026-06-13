"use strict";

// ---------------------------------------------------------------------------
// Sidebar navigation (hash-based)
// ---------------------------------------------------------------------------

const SECTIONS = ["server", "code", "tests", "databases", "config"];

function showSection(name) {
  if (!SECTIONS.includes(name)) name = "server";
  for (const section of SECTIONS) {
    document.getElementById(`section-${section}`).classList.toggle("hidden", section !== name);
  }
  for (const btn of document.querySelectorAll(".nav-item")) {
    btn.classList.toggle("active", btn.dataset.section === name);
  }
  if (name === "server") populateTargetSelect(); // pick up config edits
  if (name === "databases") loadDatabases();
  if (name === "code") loadPrs();
  if (name === "config") renderConfigEditors();
}

function onHashChange() {
  showSection(window.location.hash.replace("#", "") || "server");
}

for (const btn of document.querySelectorAll(".nav-item")) {
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

const CACHE_TTL = 10 * 60 * 1000; // tab data (databases, branches/PRs)

function updateStoredConfig(patch) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...storedConfig(), ...patch }));
}

// ---------------------------------------------------------------------------
// Server section: status, controls, env card, uptime, command bar
// ---------------------------------------------------------------------------

const statusPill = document.getElementById("status-pill");
const statusPillText = document.getElementById("status-pill-text");
const serverDot = document.getElementById("server-dot");
const consoleDot = document.getElementById("console-dot");
const serverInfo = document.getElementById("server-info");
const serverHint = document.getElementById("server-hint");
const targetSelect = document.getElementById("target-select");
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const btnRestart = document.getElementById("btn-restart");
const envCard = document.getElementById("env-card");
const uptimeBox = document.getElementById("uptime");
const uptimeVal = document.getElementById("uptime-val");
const cmdBar = document.getElementById("server-cmd");
const cmdCode = document.getElementById("cmd-code");
const logPane = document.getElementById("log-pane");
let lastStatus = null;
let startedAt = null;

const LAST_TARGET_KEY = "oo-last-target";
const PILL_STATES = { starting: "STARTING", stopping: "STOPPING", disconnected: "DISCONNECTED" };

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

function setStatus(status) {
  lastStatus = status;
  const state = status.state;
  const active = state === "starting" || state === "running";

  statusPill.hidden = !PILL_STATES[state];
  if (PILL_STATES[state]) {
    statusPill.className = `status-pill ${state}`;
    statusPillText.textContent = PILL_STATES[state];
  }

  btnStart.disabled = state !== "stopped";
  btnStop.disabled = !active;
  btnRestart.disabled = !active;
  if (state === "stopped") populateTargetSelect();
  targetSelect.hidden = state !== "stopped";

  serverDot.hidden = state !== "running";
  consoleDot.classList.toggle("on", state === "running");
  document.getElementById("favicon").href =
    state === "running" ? "/static/favicon-on.svg" : "/static/favicon.svg";

  if (status.db) {
    let html = `database: <b>${escapeHtml(status.db)}</b>`;
    if (status.odoo_version) {
      html += `<span class="sep">·</span>odoo <b>${escapeHtml(status.odoo_version)}</b>`;
      if (status.enterprise) html += `<span class="sep">·</span>enterprise`;
    }
    serverInfo.innerHTML = html;
  }
  serverInfo.hidden = !status.db;

  const hints = [];
  if (status.exited_unexpectedly) {
    hints.push(`odoo exited unexpectedly (code ${status.returncode})`);
  }
  if (state === "stopped" && status.odoo_port_busy) {
    hints.push("port 8069 is busy (external odoo?) — Stop will kill it");
    btnStop.disabled = false;
  }
  serverHint.textContent = hints.join(" — ");
  serverHint.hidden = !hints.length;

  envCard.hidden = !active;
  if (active) {
    document.getElementById("env-target").textContent = status.target || "—";
    document.getElementById("env-db").textContent = status.db || "—";
    document.getElementById("env-pid").textContent = status.pid || "—";
  }

  startedAt = active ? status.started_at : null;
  uptimeBox.hidden = !startedAt;
  renderUptime();

  cmdBar.hidden = !status.cmd;
  if (status.cmd) cmdCode.innerHTML = tintCmd(status.cmd);

  const newActiveDb = status.db || null;
  if (newActiveDb !== activeDb) {
    activeDb = newActiveDb;
    if (lastDbs) renderDatabases(lastDbs);
  }
}

function renderUptime() {
  if (!startedAt) return;
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - startedAt));
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  uptimeVal.textContent = h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

setInterval(renderUptime, 1000);

function tintCmd(cmd) {
  const tokens = cmd.split(" ").map((tok) => {
    const esc = escapeHtml(tok);
    if (tok.startsWith("-")) return `<span class="flag">${esc}</span>`;
    if (tok.includes("/")) return `<span class="path">${esc}</span>`;
    return esc;
  });
  return `<span class="prompt">$</span>${tokens.join(" ")}`;
}

document.getElementById("copy-btn").addEventListener("click", () => {
  if (!lastStatus?.cmd) return;
  navigator.clipboard?.writeText(lastStatus.cmd);
  const lbl = document.getElementById("copy-lbl");
  lbl.textContent = "Copied";
  setTimeout(() => { lbl.textContent = "Copy"; }, 1400);
});

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
const dbStamp = document.getElementById("db-stamp");
const DB_CACHE_KEY = "oo-db-cache";
let activeDb = null;  // db of the starting/running server, bolded + undroppable
let lastDbs = null;

document.getElementById("btn-db-refresh").addEventListener("click", () => loadDatabases(true));

function readDbCache() {
  try {
    const cache = JSON.parse(localStorage.getItem(DB_CACHE_KEY));
    return cache && cache.at && cache.databases ? cache : null;
  } catch {
    return null;
  }
}

function setDbStamp(at) {
  dbStamp.textContent = at ? `updated ${timeAgo(new Date(at).toISOString())}` : "";
}

async function fetchDatabases() {
  // fetch fresh data, cache it, render once; throws on failure
  const resp = await fetch("/api/databases");
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || resp.status);
  const at = Date.now();
  localStorage.setItem(DB_CACHE_KEY, JSON.stringify({ at, databases: data.databases }));
  lastDbs = data.databases;
  renderDatabases(lastDbs);
  setDbStamp(at);
}

async function loadDatabases(force = false) {
  const cache = readDbCache();

  if (!force && cache && Date.now() - cache.at < CACHE_TTL) {
    lastDbs = cache.databases;
    renderDatabases(lastDbs);
    setDbStamp(cache.at);
    return;
  }

  // keep showing cached data while refreshing
  if (cache) {
    lastDbs = cache.databases;
    renderDatabases(lastDbs);
    dbStamp.textContent = "refreshing…";
  } else {
    dbList.textContent = "Loading…";
  }

  try {
    await fetchDatabases();
  } catch (err) {
    if (cache) {
      setDbStamp(cache.at);
      dbStamp.textContent += ` — refresh failed: ${err.message}`;
    } else {
      dbList.textContent = `Failed to load databases: ${err.message}`;
    }
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
    if (isActive) name.className = "active-name";
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
  // either ISO8601 with timezone (git) or naive UTC "2026-06-11 12:34:56" (odoo)
  const date = ts.includes("T") ? new Date(ts) : new Date(ts.replace(" ", "T") + "Z");
  if (isNaN(date)) return ts;
  const secs = Math.max(0, Math.floor((Date.now() - date) / 1000));
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

async function dropDatabase(name, btn) {
  if (!confirm(`Drop database "${name}"? This cannot be undone.`)) return;
  // keep the table on screen, just frozen, until the new list is ready
  btn.disabled = true;
  dbList.classList.add("busy");
  dbStamp.textContent = `dropping ${name}…`;
  try {
    const resp = await fetch("/api/databases/drop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || resp.status);
    await fetchDatabases(); // single re-render with the final list
  } catch (err) {
    alert(`Drop failed: ${err.message}`);
    btn.disabled = false;
    setDbStamp(readDbCache()?.at);
  } finally {
    dbList.classList.remove("busy");
  }
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
    { key: "github", name: "github repo", placeholder: "github (e.g. odoo/odoo)",
      className: "w-name", optional: true },
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
// Code section: branches & PRs
// ---------------------------------------------------------------------------

const prsList = document.getElementById("prs-list");
const prsStamp = document.getElementById("prs-stamp");
const BASE_BRANCH_RE = /^(master|\d+\.\d+|saas-\d+\.\d+)$/;
const RUNBOT = "https://runbot.odoo.com";
const PRS_CACHE_KEY = "oo-prs-cache";
const FAVORITES_KEY = "oo-prs-favorites";

document.getElementById("btn-prs-refresh").addEventListener("click", () => loadPrs(true));

function readFavorites() {
  try {
    const favs = JSON.parse(localStorage.getItem(FAVORITES_KEY));
    return new Set(Array.isArray(favs) ? favs : []);
  } catch {
    return new Set();
  }
}

function toggleFavorite(branch) {
  const favs = readFavorites();
  favs.has(branch) ? favs.delete(branch) : favs.add(branch);
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favs]));
}

// re-render from cache without refetching (used after toggling a favorite)
function rerenderPrs() {
  const cache = readPrsCache();
  if (cache) renderPrTable(cache.branchRepos, cache.prRepos, reposWithGithub());
}

function readPrsCache() {
  try {
    const cache = JSON.parse(localStorage.getItem(PRS_CACHE_KEY));
    return cache && cache.at && cache.branchRepos && cache.prRepos ? cache : null;
  } catch {
    return null;
  }
}

function setPrsStamp(at) {
  prsStamp.textContent = at ? `updated ${timeAgo(new Date(at).toISOString())}` : "";
}

// repos saved before the github field existed fall back to the default mapping
function reposWithGithub() {
  return getConfig().repos.map((r) => ({
    ...r,
    github: r.github ?? DEFAULT_CONFIG.repos.find((d) => d.id === r.id)?.github,
  }));
}

function baseBranchOf(branch) {
  const m = /^(saas-\d+\.\d+|\d+\.\d+|master)/.exec(branch);
  return m ? m[1] : "master";
}

function createPrUrl(github, branch) {
  // odoo dev branches live on the odoo-dev fork
  const name = github.split("/")[1];
  return `https://github.com/${github}/compare/${baseBranchOf(branch)}...odoo-dev:${name}:${branch}?expand=1`;
}

async function loadPrs(force = false) {
  const repos = reposWithGithub();
  const cache = readPrsCache();

  if (!force && cache && Date.now() - cache.at < CACHE_TTL) {
    renderPrTable(cache.branchRepos, cache.prRepos, repos);
    setPrsStamp(cache.at);
    return;
  }

  // keep showing cached data while refreshing
  if (cache) {
    renderPrTable(cache.branchRepos, cache.prRepos, repos);
    prsStamp.textContent = "refreshing…";
  } else {
    prsList.textContent = "Loading…";
  }

  try {
    await fetchPrs(repos);
  } catch (err) {
    if (cache) {
      setPrsStamp(cache.at);
      prsStamp.textContent += ` — refresh failed: ${err.message}`;
    } else {
      prsList.textContent = `Failed to load: ${err.message}`;
    }
  }
}

async function fetchPrs(repos) {
  // fetch fresh data, cache it, render once; throws on failure
  const post = (path, body) => fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const [bResp, pResp] = await Promise.all([
    post("/api/code/branches", { repos }),
    post("/api/prs", { repos: repos.filter((r) => r.github) }),
  ]);
  const bData = await bResp.json();
  const pData = await pResp.json();
  if (!bResp.ok) throw new Error(bData.error || bResp.status);
  if (!pResp.ok) throw new Error(pData.error || pResp.status);
  const at = Date.now();
  localStorage.setItem(PRS_CACHE_KEY,
    JSON.stringify({ at, branchRepos: bData.repos, prRepos: pData.repos }));
  renderPrTable(bData.repos, pData.repos, repos);
  setPrsStamp(at);
}

function renderPrTable(branchRepos, prRepos, repos) {
  const githubByRepo = Object.fromEntries(repos.map((r) => [r.id, r.github]));
  const prIndex = {};
  for (const repo of prRepos) {
    for (const pr of repo.prs) {
      prIndex[`${repo.id}:${pr.headRefName}`] = pr;
    }
  }

  const pathByRepo = Object.fromEntries(repos.map((r) => [r.id, r.path]));

  // group branches by name across repos
  const groups = new Map();
  for (const repo of branchRepos) {
    for (const b of repo.branches) {
      if (!groups.has(b.name)) groups.set(b.name, []);
      groups.get(b.name).push({
        repo: repo.id, date: b.date, runbot: b.runbot,
        checkedOut: b.name === repo.current,
      });
    }
  }

  const favorites = readFavorites();
  const sorted = [...groups.entries()].map(([branch, rows]) => {
    let activity = 0;
    for (const r of rows) {
      activity = Math.max(activity, Date.parse(r.date) || 0);
      const pr = prIndex[`${r.repo}:${branch}`];
      if (pr) activity = Math.max(activity, Date.parse(pr.updatedAt) || 0);
    }
    return {
      branch, rows, activity,
      base: BASE_BRANCH_RE.test(branch),
      favorite: favorites.has(branch),
    };
  }).sort((a, b) =>
    (b.favorite - a.favorite) || (a.base - b.base) || (b.activity - a.activity));

  prsList.replaceChildren();
  for (const repo of prRepos.filter((r) => r.error)) {
    const div = document.createElement("div");
    div.className = "dim";
    div.textContent = `${repo.id}: ${repo.error}`;
    prsList.appendChild(div);
  }
  if (!sorted.length) {
    prsList.appendChild(Object.assign(document.createElement("div"),
      { className: "dim", textContent: "No work branches." }));
    return;
  }

  const table = document.createElement("table");
  table.className = "db-table pr-table";
  table.innerHTML =
    "<thead><tr><th>Branch</th><th>Repo</th><th>Last update</th><th>PR</th><th></th></tr></thead>";
  const tbody = document.createElement("tbody");

  for (const group of sorted) {
    group.rows.forEach((row, i) => {
      const tr = document.createElement("tr");
      if (i === 0) {
        tr.className = "group-start";
        const name = document.createElement("td");
        name.rowSpan = group.rows.length;
        name.className = "pr-branch";

        const star = document.createElement("button");
        star.className = `fav-star${group.favorite ? " is-fav" : ""}`;
        star.title = group.favorite ? "unfavorite" : "favorite";
        star.innerHTML =
          '<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z"/></svg>';
        star.addEventListener("click", () => {
          toggleFavorite(group.branch);
          rerenderPrs();
        });
        name.appendChild(star);

        const branchName = document.createElement("span");
        branchName.textContent = group.branch;
        name.appendChild(branchName);

        if (!group.base) {
          const status = group.rows.map((r) => r.runbot).find(Boolean) || "";
          const runbot = document.createElement("span");
          runbot.className = "runbot-inline";
          const open = document.createElement("span");
          open.className = "runbot-paren";
          open.textContent = "(";
          const a = document.createElement("a");
          a.href = `${RUNBOT}/runbot/bundle/${encodeURIComponent(group.branch)}`;
          a.target = "_blank";
          a.className = "runbot-link";
          a.textContent = "runbot";
          const dot = document.createElement("span");
          dot.className = `runbot-dot ${status || "unknown"}`;
          dot.title = `runbot: ${status || "unknown"}`;
          const close = document.createElement("span");
          close.className = "runbot-paren";
          close.textContent = ")";
          runbot.append(open, a, dot, close);
          name.appendChild(runbot);
        }
        tr.appendChild(name);
      }

      const repoTd = document.createElement("td");
      repoTd.textContent = row.repo;
      repoTd.className = "dim";
      tr.appendChild(repoTd);

      const dateTd = document.createElement("td");
      dateTd.textContent = row.date ? timeAgo(row.date) : "—";
      if (row.date) dateTd.title = row.date;
      tr.appendChild(dateTd);

      const prTd = document.createElement("td");
      const pr = prIndex[`${row.repo}:${group.branch}`];
      const github = githubByRepo[row.repo];
      if (pr) {
        const a = document.createElement("a");
        a.href = pr.url;
        a.target = "_blank";
        a.className = "pr-link";
        a.textContent = `#${pr.number}`;
        const state = document.createElement("span");
        const st = pr.isDraft && pr.state === "OPEN" ? "DRAFT" : pr.state;
        state.className = `pr-state ${st.toLowerCase()}`;
        state.textContent = st.toLowerCase();
        prTd.append(a, state);
      } else if (github && !group.base) {
        const a = document.createElement("a");
        a.href = createPrUrl(github, group.branch);
        a.target = "_blank";
        a.className = "pr-create";
        a.textContent = "create PR";
        prTd.appendChild(a);
      } else {
        prTd.textContent = "—";
        prTd.className = "dim";
      }
      tr.appendChild(prTd);

      const delTd = document.createElement("td");
      delTd.className = "db-actions";
      if (!group.base) {
        const delBtn = document.createElement("button");
        delBtn.textContent = "Delete";
        delBtn.className = "drop-btn";
        if (row.checkedOut) {
          delBtn.disabled = true;
          delBtn.title = "currently checked out";
        }
        delBtn.addEventListener("click", () => deleteBranch(
          { branch: group.branch, repo: row.repo, path: pathByRepo[row.repo] }, delBtn));
        delTd.appendChild(delBtn);
      }
      tr.appendChild(delTd);

      tbody.appendChild(tr);
    });
  }
  table.appendChild(tbody);
  prsList.appendChild(table);
}

async function deleteBranch(row, btn) {
  if (!confirm(`Force-delete branch "${row.branch}" in ${row.repo}? This cannot be undone.`)) return;
  // keep the table on screen, just frozen, until the new list is ready
  btn.disabled = true;
  prsList.classList.add("busy");
  prsStamp.textContent = `deleting ${row.branch}…`;
  try {
    const resp = await fetch("/api/code/branches/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: row.path, branch: row.branch }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || resp.status);
    await fetchPrs(reposWithGithub()); // single re-render with the final list
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
    btn.disabled = false;
    setPrsStamp(readPrsCache()?.at);
  } finally {
    prsList.classList.remove("busy");
  }
}

// ---------------------------------------------------------------------------
// Live events (SSE)
// ---------------------------------------------------------------------------

function connect() {
  const es = new EventSource("/api/events");
  // the server replays its full log buffer on connect, so start clean
  es.onopen = () => { logPane.replaceChildren(); updateLineCount(); };
  es.onerror = () => setStatus({ state: "disconnected" });
  es.addEventListener("status", (e) => setStatus(JSON.parse(e.data)));
  es.addEventListener("log", (e) => appendLog(JSON.parse(e.data).line));
}

connect();

// ---------------------------------------------------------------------------
// Log console: structured rows, autoscroll toggle, clear, line count
// ---------------------------------------------------------------------------

const MAX_LOG_LINES = 2000;
const autoToggle = document.getElementById("autoscroll");
let autoScroll = true;
let pendingLines = [];
let flushScheduled = false;

autoToggle.addEventListener("click", () => {
  setAutoScroll(!autoScroll);
  if (autoScroll) logPane.scrollTop = logPane.scrollHeight;
});

function setAutoScroll(on) {
  autoScroll = on;
  autoToggle.classList.toggle("on", on);
}

// scrolling away from the bottom pauses following; scrolling back resumes it
logPane.addEventListener("scroll", () => {
  const atBottom = logPane.scrollTop + logPane.clientHeight >= logPane.scrollHeight - 4;
  if (atBottom !== autoScroll) setAutoScroll(atBottom);
});

document.getElementById("clear-btn").addEventListener("click", () => {
  logPane.replaceChildren();
  updateLineCount();
});

function updateLineCount() {
  document.getElementById("linecount").textContent = `${logPane.childElementCount} lines`;
}

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
  const frag = document.createDocumentFragment();
  for (const line of lines) {
    frag.appendChild(buildLogRow(line));
  }
  logPane.appendChild(frag);
  while (logPane.childElementCount > MAX_LOG_LINES) {
    logPane.firstElementChild.remove();
  }
  updateLineCount();
  if (autoScroll) logPane.scrollTop = logPane.scrollHeight;
}

// ── odoo log line parsing ──

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const LOG_RE = /^(?:\d{4}-\d{2}-\d{2} )?(\d{2}:\d{2}:\d{2},\d+) (\d+) (DEBUG|INFO|WARNING|ERROR|CRITICAL) (\S+) ([\w.]+): (.*)$/;
const HTTP_RE = /^(.*?)"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) ([^"]*) (HTTP\/[\d.]+)" (\d{3}) ?(.*)$/;

const LVL_CLASS = { DEBUG: "info", INFO: "info", WARNING: "warn", ERROR: "err", CRITICAL: "err" };

function buildLogRow(line) {
  const div = document.createElement("div");
  const text = line.replace(ANSI_RE, "");
  const m = LOG_RE.exec(text);
  if (!m) {
    // tracebacks, [oo] messages, continuation lines
    div.className = "row raw";
    div.innerHTML = `<span class="msg">${ansiToHtml(line)}</span>`;
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
    msgHtml = `<span class="meta">${escapeHtml(prefix)}</span>` +
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
  return div;
}

function tintHttpMeta(rest) {
  // trailing numbers: sizes then timings — highlight the last (total) timing
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  const floatIdx = tokens.flatMap((t, i) => (/^\d+\.\d+$/.test(t) ? [i] : []));
  const last = floatIdx[floatIdx.length - 1];
  return tokens.map((t, i) => {
    if (i === last) {
      const v = parseFloat(t);
      const cls = v >= 100 ? "timing vslow" : v >= 1 ? "timing slow" : "timing";
      return `<span class="${cls}">${escapeHtml(t)}</span>`;
    }
    return ` <span class="meta">${escapeHtml(t)}</span>`;
  }).join("");
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
