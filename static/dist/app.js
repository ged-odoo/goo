// vendor/owl-orm/owl-global.js
var owl = globalThis.owl;
var getScope = owl.getScope;
var Scope = owl.Scope;
var signal = owl.signal;
var computed = owl.computed;
var Component = owl.Component;
var xml = owl.xml;
var markup = owl.markup;
var props = owl.props;
var t = owl.t;
var mount = owl.mount;
var EventBus = owl.EventBus;
var onMounted = owl.onMounted;
var onPatched = owl.onPatched;
var onWillStart = owl.onWillStart;
var onWillUnmount = owl.onWillUnmount;
var useEffect = owl.useEffect;
var useApp = owl.useApp;
var Plugin = owl.Plugin;
var plugin = owl.plugin;

// static/src/core/config.js
var VERSION = "1.1.0";
var DEFAULT_CONFIG = {
  work_dir: "/home/odoo/work",
  venv_activate: "",
  // optional; when set, prefixed before the start command (source … && odoo-bin)
  // path to the odoo-bin executable; goo cd's into the community checkout and runs
  // it. Empty = use <community-path>/odoo-bin. Worktree servers always run their own.
  server_path: "/home/odoo/work/community/odoo-bin",
  // where per-target git worktrees are created: <worktree_dir>/<slug>/<repo>
  worktree_dir: "/home/odoo/work-trees",
  db_user: "odoo",
  db_password: "odoo",
  // Odoo's filestore root; a db's attachments live in <filestore>/<dbname>. goo
  // keeps it in lockstep with the db on drop/rename/clone. Empty = leave it alone.
  filestore: "/home/odoo/.local/share/Odoo/filestore/",
  editor: "code",
  // command used by the dashboard's "Open with editor" action
  auto_open_event_log: false,
  // open the event log overlay when new events arrive
  // launch odoo with RUST_BUNDLER=1 so the rust_bundler addon bundles JS assets
  // through the odoo_bundler Rust extension (must be built into the venv)
  rust_bundler: false,
  // automatic goo self-update check (git fetch of origin/master at startup +
  // hourly, driving the navbar badge). The manual check button always works.
  update_check: true,
  repos: [
    { id: "community", path: "/home/odoo/work/community", github: "odoo/odoo", favorite: true },
    {
      id: "enterprise",
      path: "/home/odoo/work/enterprise",
      github: "odoo/enterprise",
      favorite: true
    }
  ],
  // First-class targets — what you actually work with. This is just the initial
  // set; each carries a stable `id` (used internally so renaming `name` is safe),
  // its checkout list (repo:branch pairs), a `kind`, database, args and favorite flag.
  targets: [
    {
      id: "master",
      name: "master",
      favorite: true,
      kind: "plain",
      checkouts: [{ repo: "community", branch: "master" }],
      db: "master",
      on_create_args: "-i sale_management"
    },
    {
      id: "master-e",
      name: "master(e)",
      favorite: false,
      kind: "plain",
      checkouts: [
        { repo: "community", branch: "master" },
        { repo: "enterprise", branch: "master" }
      ],
      db: "master-e",
      on_create_args: "-i sale_management"
    },
    {
      id: "19.0",
      name: "19.0",
      favorite: false,
      kind: "plain",
      checkouts: [{ repo: "community", branch: "19.0" }],
      db: "19.0",
      on_create_args: "-i sale_management"
    },
    {
      id: "19.0-e",
      name: "19.0(e)",
      favorite: false,
      kind: "plain",
      checkouts: [
        { repo: "community", branch: "19.0" },
        { repo: "enterprise", branch: "19.0" }
      ],
      db: "19.0-e",
      on_create_args: "-i sale_management"
    }
  ],
  start: {
    repos: ["community"],
    db: "test_db",
    on_create_args: "-i sale_management",
    other_args: "--dev all"
  },
  // test-tag presets offered in the Tests tab's selector (editable in the
  // Configuration tab). Each is { tags: "<--test-tags value>" }.
  test_presets: [{ tags: "/web:WebSuite[@web]" }],
  // navbar links (editable in the Config tab). /odoo + /web/tests go through the
  // autologin addon (?to=<url-encoded target>) and only work while the server is up.
  links: [
    { label: "/odoo", href: "http://localhost:8069/dev/autologin?to=%2Fodoo%3Fdebug%3Dassets" },
    {
      label: "/web/tests",
      href: "http://localhost:8069/dev/autologin?to=%2Fweb%2Ftests%3Fdebug%3Dassets%26timeout%3D500000%26manual%3Dtrue"
    }
  ]
};
var SECTIONS = [
  "dashboard",
  "code",
  "server",
  "worktree",
  "branches",
  "prs",
  "reviews",
  "tests",
  "assets",
  "addons",
  "databases",
  "targets",
  "nightly",
  "memory",
  "config"
];
var MERGEBOT = "https://mergebot.odoo.com";
var BASE_BRANCH_RE = /^(master|\d+\.\d+|saas-\d+\.\d+)$/;

// static/src/core/presets.js
var SIMPLE_TABS = [
  { id: "dashboard", visible: true },
  { id: "targets", visible: true },
  { id: "server", visible: true },
  { id: "tests", visible: false },
  { id: "branches", visible: true },
  { id: "prs", visible: false },
  { id: "reviews", visible: false },
  { id: "assets", visible: false },
  { id: "addons", visible: true },
  { id: "databases", visible: true },
  { id: "config", visible: true }
];
var GED_CONFIG = {
  venv_activate: "source /home/odoo/work/env20/bin/activate",
  auto_open_event_log: true,
  rust_bundler: true,
  // env20 has the odoo_bundler extension built
  repos: [
    {
      id: "community",
      path: "/home/odoo/work/community",
      github: "odoo/odoo",
      autoreload: false,
      favorite: true
    },
    {
      id: "enterprise",
      path: "/home/odoo/work/enterprise",
      github: "odoo/enterprise",
      autoreload: false,
      favorite: true
    },
    {
      id: "tutorials",
      path: "/home/odoo/work/tutorials",
      github: "odoo/tutorials",
      autoreload: false,
      favorite: false
    },
    {
      id: "owl",
      path: "/home/odoo/work/owl",
      github: "odoo/owl",
      autoreload: false,
      external: true,
      // not on mergebot/runbot — skip those scrapes
      favorite: false
    }
  ],
  targets: [
    {
      id: "master-enterprise",
      name: "master (enterprise)",
      favorite: true,
      config: [
        { repo: "community", branch: "master" },
        { repo: "enterprise", branch: "master" }
      ],
      db: "master-enterprise",
      on_create_args: "-i sale_management"
    },
    {
      name: "master",
      favorite: false,
      config: [{ repo: "community", branch: "master" }],
      db: "master",
      on_create_args: "-i sale_management",
      id: "master"
    },
    {
      name: "19.0",
      favorite: false,
      config: [
        { repo: "community", branch: "19.0" },
        { repo: "enterprise", branch: "19.0" }
      ],
      db: "19.0",
      on_create_args: "-i sale_management",
      id: "19-0-e"
    },
    {
      id: "6d97bcd9-87c5-4bef-a397-ada7b6a16d5e",
      name: "master-owl-update-again-ged",
      favorite: true,
      config: [{ repo: "community", branch: "master-owl-update-again-ged" }],
      db: "master-owl-update-again-ged",
      on_create_args: "-i sale_management"
    }
  ],
  links: [
    { label: "/odoo", href: "http://localhost:8069/dev/autologin?to=%2Fodoo%3Fdebug%3Dassets" },
    {
      label: "/web/tests",
      href: "http://localhost:8069/dev/autologin?to=%2Fweb%2Ftests%3Fdebug%3Dassets%26timeout%3D500000%26manual%3Dtrue%26preset%3Ddesktop"
    },
    { label: "\u{1F989} docs", href: "https://odoo.github.io/owl/documentation/v3/owl/" },
    { label: "\u{1F989} playground", href: "https://odoo.github.io/owl/playground/" },
    { label: "\u{1F989} github", href: "https://github.com/odoo/owl" },
    {
      label: "misc",
      children: [
        { label: "myprs", href: "https://github.com/pulls/authored" },
        { label: "runbot", href: "https://runbot.odoo.com" },
        { label: "mergebot", href: "https://mergebot.odoo.com" },
        { label: "odoo/odoo", href: "https://github.com/odoo/odoo/tree/master" },
        { label: "odoo/enterprise", href: "https://github.com/odoo/enterprise/tree/master" },
        { label: "odoo/tutorials", href: "https://github.com/odoo/tutorials/tree/master" },
        { label: "goo", href: "https://github.com/ged-odoo/goo" },
        { label: "documentation", href: "https://www.odoo.com/documentation/master/" }
      ]
    }
  ],
  tabs: [
    { id: "dashboard", visible: true },
    { id: "targets", visible: true },
    { id: "server", visible: true },
    { id: "worktree", visible: true },
    { id: "tests", visible: true },
    { id: "branches", visible: true },
    { id: "prs", visible: true },
    { id: "reviews", visible: true },
    { id: "addons", visible: true },
    { id: "databases", visible: true },
    { id: "config", visible: true }
  ]
};
var PRESETS = [
  {
    id: "normal",
    label: "Normal \u2014 standard Odoo dev setup",
    data: {},
    // empty → pure DEFAULT_CONFIG
    clearDataFile: true
    // back to browser storage (unset the Storage file field)
  },
  {
    id: "simple",
    label: "Simple \u2014 no PRs/Reviews/Tests tabs, no venv",
    data: { "oo-config": JSON.stringify({ tabs: SIMPLE_TABS }) },
    clearDataFile: true
    // back to browser storage (unset the Storage file field)
  },
  {
    id: "ged",
    label: "GED \u2014 G\xE9ry's full config",
    data: {
      "oo-config": JSON.stringify(GED_CONFIG),
      "oo-prs-favorites": JSON.stringify(["master-owl-update"]),
      "oo-last-target": "6d97bcd9-87c5-4bef-a397-ada7b6a16d5e",
      "oo-test-history": JSON.stringify([
        "/web:WebSuite[@web/core/checkbox]",
        "/web:WebSuite[@web_tour/tour_automatic/Step Tour validity]",
        "@web_tour/tour_automatic/Step Tour validity",
        "/account:TestUi.test_add_section_from_product_catalog_on_invoice_tour",
        ":TestUi.test_add_section_from_product_catalog_on_invoice_tour",
        "/web:WebSuite[@web/core/py_js/py_parser]",
        "/web:WebSuite[@web/core/checkbox/indeterminate style attribute renders a visible dash]",
        "/web:WebSuite[@web/core]",
        "/web:WebSuite[@web]",
        "/web:WebSuite[@web/core/py_js/py_parse]"
      ])
    }
  }
];

// static/src/core/utils.js
function timeAgo(ts) {
  const date = ts.includes("T") ? new Date(ts) : /* @__PURE__ */ new Date(ts.replace(" ", "T") + "Z");
  if (isNaN(date)) return ts;
  const secs = Math.max(0, Math.floor((Date.now() - date) / 1e3));
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}
function formatBytes(n) {
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
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function tintCmd(cmd) {
  const tokens = cmd.split(" ").map((tok) => {
    const esc = escapeHtml(tok);
    if (tok.startsWith("-")) return `<span class="flag">${esc}</span>`;
    if (tok.includes("/")) return `<span class="path">${esc}</span>`;
    return esc;
  });
  return `<span class="prompt">$</span>${tokens.join(" ")}`;
}
var ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
var LOG_RE = /^(?:\d{4}-\d{2}-\d{2} )?(\d{2}:\d{2}:\d{2},\d+) (\d+) (DEBUG|INFO|WARNING|ERROR|CRITICAL) (\S+) ([\w.]+): (.*)$/;
var HTTP_RE = /^(.*?)"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) ([^"]*) (HTTP\/[\d.]+)" (\d{3}) ?(.*)$/;
var LVL_CLASS = { DEBUG: "info", INFO: "info", WARNING: "warn", ERROR: "err", CRITICAL: "err" };
function tintHttpMeta(rest) {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  const floatIdx = tokens.flatMap((t2, i) => /^\d+\.\d+$/.test(t2) ? [i] : []);
  const last = floatIdx[floatIdx.length - 1];
  return tokens.map((t2, i) => {
    if (i === last) {
      const v = parseFloat(t2);
      const cls = v >= 100 ? "timing vslow" : v >= 1 ? "timing slow" : "timing";
      return `<span class="${cls}">${escapeHtml(t2)}</span>`;
    }
    return ` <span class="meta">${escapeHtml(t2)}</span>`;
  }).join("");
}
function ansiToHtml(line) {
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
      html += classes.length ? `<span class="${classes.join(" ")}">${escapeHtml(text)}</span>` : escapeHtml(text);
    } else {
      const params = parts[i] === "" ? [0] : parts[i].split(";").map(Number);
      for (let j = 0; j < params.length; j++) {
        const p = params[j];
        if (p === 0) {
          fg = null;
          bold = false;
        } else if (p === 1) bold = true;
        else if (p === 22) bold = false;
        else if (p >= 30 && p <= 37 || p >= 90 && p <= 97) fg = p;
        else if (p === 39) fg = null;
        else if (p === 38 || p === 48) j += params[j + 1] === 2 ? 4 : 2;
      }
    }
  }
  return html;
}
function hootTestId(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  return (hash + 16 ** 8).toString(16).slice(-8);
}
function hootTestUrl(name) {
  const to = `/web/tests?debug=assets&timeout=500000&id=${hootTestId(name)}`;
  return `http://localhost:8069/dev/autologin?to=${encodeURIComponent(to)}`;
}
function appendHootLink(div, name) {
  const a = document.createElement("a");
  const url = hootTestUrl(name);
  a.className = "hoot-link";
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = "[open in hoot]";
  a.addEventListener("click", (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    document.dispatchEvent(new CustomEvent("goo:open-hoot", { detail: { url } }));
  });
  div.appendChild(a);
}
function buildLogRow(line) {
  const div = document.createElement("div");
  const text = line.replace(ANSI_RE, "");
  const hoot = text.match(/\[HOOT\] Running test "(.+?)"/);
  const m2 = LOG_RE.exec(text);
  if (!m2) {
    div.className = text.startsWith("[goo]") ? "row raw goo-line" : "row raw";
    div.innerHTML = `<span class="msg">${ansiToHtml(line)}</span>`;
    if (hoot) appendHootLink(div, hoot[1]);
    return div;
  }
  const [, ts, pid, lvl, , logger, msg] = m2;
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
    msgHtml = `<span class="meta">${escapeHtml(prefix)}</span><span class="quote">"</span><span class="method">${method}</span><span class="urlpath">${escapeHtml(path)}</span><span class="query">${escapeHtml(query)}</span><span class="proto">${proto}</span><span class="quote">"</span><span class="code-chip ${cc}">${status}</span>${tintHttpMeta(rest)}`;
  } else {
    msgHtml = `<span class="plain">${escapeHtml(msg)}</span>`;
  }
  div.className = rowCls;
  div.innerHTML = `<span class="ts">${ts}</span><span class="pid">${pid}</span><span class="lvl ${LVL_CLASS[lvl]}">${lvl === "WARNING" ? "WARN" : lvl === "CRITICAL" ? "CRIT" : lvl}</span><span class="logger">${escapeHtml(logger)}:</span><span class="msg">${msgHtml}</span>`;
  if (hoot) appendHootLink(div, hoot[1]);
  return div;
}
async function postJSON(path, body) {
  const resp = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== void 0 ? JSON.stringify(body) : void 0
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || resp.status);
  return data;
}
function worktreeSlug(tgt) {
  const s = (tgt.name || tgt.id || "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || tgt.id;
}
function worktreeDirFor(worktreeDir, tgt) {
  return `${(worktreeDir || "/tmp").replace(/\/+$/, "")}/${worktreeSlug(tgt)}`;
}

// vendor/owl-orm/orm.ts
var Model = class {
  id;
  orm;
  #dp;
  constructor(id, dp, orm) {
    this.id = id;
    this.orm = orm;
    this.#dp = dp;
  }
  setup() {
  }
  onCreate() {
  }
  delete() {
    this.orm.delete(this);
  }
  isDirty() {
    return this.#dp.table.dirtyRecords().has(this.id);
  }
  toJSON() {
    const obj = { id: this.id };
    const fields2 = this.#dp.table.fields;
    for (let f of fields2) {
      obj[f.name] = f.getRawValue(this.#dp);
    }
    return obj;
  }
};
var _signals = [];
var _index = 0;
var _dp;
var _table;
var Field = class {
  name = "";
  config;
  index = _index;
  table = _table;
  constructor(config) {
    this.config = config;
  }
  setValue(dp, value) {
    if (this.config.onChange) {
      const fn = dp.data[this.name].__onchange;
      fn.call(dp.record, value, (v) => this._setValue(dp, v));
    } else {
      return this._setValue(dp, value);
    }
  }
  _setValue(dp, value) {
    if (!dp.draft && this.config.readonly) {
      throw new Error(`Cannot edit readonly field "${this.name}" on model "${this.table.Model.id}"`);
    }
    if (this.config.selection) {
      if (dp.draft) {
        if (value !== void 0 && !this.config.selection.includes(value)) {
          throw new Error(`Invalid value "${value}" for field "${this.name}" on model "${this.table.Model.id}" (expected one of: ${this.config.selection.join(", ")})`);
        }
      } else {
        if (!this.config.selection.includes(value)) {
          throw new Error(`Invalid value "${value}" for field "${this.name}" on model "${this.table.Model.id}" (expected one of: ${this.config.selection.join(", ")})`);
        }
      }
    }
    dp.changes()[this.index] = value;
    this.table.dirtyRecords().add(dp.record.id);
    signal.trigger(dp.changes);
  }
  getValue(dp) {
    const index = this.index;
    const _change = dp.changes()[index];
    if (_change !== void 0) {
      return _change;
    }
    const _data = dp.rawData();
    let val = _data[index];
    if (typeof _data[index] === "function") {
      val = _data[index]();
    }
    if (val !== void 0) {
      return val;
    }
    const def = this.config.defaultValue;
    return typeof def === "function" ? def() : def;
  }
  getRawValue(dp) {
    return this.getValue(dp);
  }
};
var Many2OneField = class extends Field {
  getValue(dp) {
    let value = super.getValue(dp);
    if (value === null) {
      return value;
    }
    if (typeof value !== "string") {
      value = value.id;
    }
    const M = this.config.comodel();
    return this.table.orm._getTable(M).getDatapointById(value).record;
  }
  getRawValue(dp) {
    return this.getValue(dp)?.id || null;
  }
};
var One2ManyField = class extends Field {
  getValue(dp) {
    let value = super.getValue(dp);
    if (!value.length) {
      return [];
    }
    const M = this.config.comodel();
    const targetTable = this.table.orm._getTable(M);
    const activeIds = new Set(targetTable.activeRecords().map((r) => r.id));
    return value.filter((v) => activeIds.has(v.id || v)).map((v) => targetTable.getDatapointById(v.id || v).record);
  }
  getRawValue(dp) {
    return this.getValue(dp).map((r) => r.id);
  }
};
function createField(FieldClass, config) {
  const dp = _dp;
  const table = _table;
  if (!table.isReady) {
    table.fields.push(new FieldClass(config));
  }
  const field = table.fields[_index++];
  const fieldValue = computed(() => field.getValue(dp), {
    set: field.setValue.bind(field, dp)
  });
  _signals.push(fieldValue);
  return fieldValue;
}
function makeField(FieldClass, defaultValue) {
  return (options = {}) => createField(FieldClass, { defaultValue, ...options });
}
function many2One(options) {
  return createField(Many2OneField, { defaultValue: null, ...options });
}
function one2many(options) {
  return createField(One2ManyField, { defaultValue: [], ...options });
}
var fields = {
  char: makeField(Field, ""),
  number: makeField(Field, 0),
  bool: makeField(Field, false),
  json: makeField(Field, null),
  many2one: many2One,
  one2many
};
var DataPoint = class {
  record;
  table;
  draft;
  // rawValue is: value for scalar fields, id or null for m2o, list of ids for o2m
  rawData;
  // changes: new value for scalar fields, id or null for m2o, list of ids for o2m
  changes;
  // for scalar fields: value, for m2o: null or corresponding record, for o2m: list of records
  data = {};
  constructor(orm, table, id, initialState, draft, ctx) {
    this.table = table;
    this.draft = draft;
    const _rawData = [];
    const _changes = [];
    _signals = [];
    this.rawData = signal.Array(_rawData);
    this.changes = signal.Array(_changes);
    _dp = this;
    _table = table;
    _index = 0;
    let record;
    if (ctx) {
      ctx.run(() => {
        record = new table.Model(id, this, orm);
      });
    } else {
      record = new table.Model(id, this, orm);
    }
    if (!table.isReady) {
      for (let i = 0; i < _signals.length; i++) {
        const s = _signals[i];
        for (let k in record) {
          if (record[k] === s) {
            table.indexToField.push(k);
            table.fieldToIndex[k] = i;
            table.fields[i].name = k;
          }
        }
      }
      table.isReady = true;
    }
    for (let f in initialState) {
      if (f === "id") continue;
      const idx = table.fieldToIndex[f];
      if (idx === void 0) {
        throw new Error(
          `Unknown field "${f}" in initial state for model "${table.Model.id}"`
        );
      }
      let value = initialState[f];
      _rawData[table.fieldToIndex[f]] = value;
    }
    for (let f of table.fields) {
      if (_rawData[f.index] === void 0 && typeof f.config.defaultValue === "function") {
        _rawData[f.index] = f.config.defaultValue();
      }
    }
    for (let f of table.fields) {
      const n = f.name;
      const i = f.index;
      const rawValue = _rawData[i];
      if (!draft && f.config.required && (rawValue === void 0 || rawValue === null || rawValue === "")) {
        throw new Error(`Missing required field "${n}" on model "${table.Model.id}"`);
      }
      if (f.config.selection) {
        if (draft) {
          if (rawValue !== void 0 && !f.config.selection.includes(rawValue)) {
            throw new Error(`Invalid value "${rawValue}" for field "${n}" on model "${table.Model.id}" (expected one of: ${f.config.selection.join(", ")})`);
          }
        } else {
          const effectiveValue = rawValue !== void 0 ? rawValue : f.config.defaultValue;
          if (!f.config.selection.includes(effectiveValue)) {
            throw new Error(`Invalid value "${effectiveValue}" for field "${n}" on model "${table.Model.id}" (expected one of: ${f.config.selection.join(", ")})`);
          }
        }
      }
      const s = _signals[i];
      if (f.config.onChange) {
        s.__onchange = f.config.onChange;
      }
      this.data[n] = s;
    }
    this.record = record;
    table.datapoints[id] = this;
    record.setup();
  }
};
var Table = class {
  parent = null;
  orm;
  Model;
  isReady = false;
  // true when field <-> index map has been done
  indexToField = [];
  // field index => key name in record
  fieldToIndex = {};
  datapoints = {};
  fields = [];
  baseRecords = signal.Array([]);
  recordChanges = signal.Array([]);
  dirtyRecords = signal.Set(/* @__PURE__ */ new Set());
  // updated records
  constructor(orm, M) {
    this.orm = orm;
    this.Model = M;
  }
  activeDatapoints = computed(() => {
    let base = this.baseRecords().slice();
    for (let r of this.recordChanges()) {
      if (r.type === "add") {
        if (!base.includes(r.id)) {
          base.push(r.id);
        }
      } else {
        base = base.filter((id) => id !== r.id);
      }
    }
    return base.map((id) => this.getDatapointById(id));
  });
  activeRecords = computed(
    () => this.activeDatapoints().map((dp) => dp.record)
  );
  getDatapointById(id) {
    const dp = this.datapoints[id];
    if (dp) {
      return dp;
    }
    if (this.orm._parent) {
      const pTable = this.orm._parent._getTable(this.Model);
      const parentDp = pTable.getDatapointById(id);
      const dp2 = new DataPoint(
        this.orm,
        this,
        id,
        parentDp.data,
        true,
        this.orm._ctx
      );
      return dp2;
    }
    throw new Error(`Record "${id}" not found in model "${this.Model.id}"`);
  }
  pendingChanges() {
    const additions = /* @__PURE__ */ new Set();
    const deletions = /* @__PURE__ */ new Set();
    for (let change of this.recordChanges()) {
      if (change.type === "add") {
        additions.add(change.id);
        deletions.delete(change.id);
      } else {
        if (additions.has(change.id)) {
          additions.delete(change.id);
        } else {
          deletions.add(change.id);
        }
      }
    }
    const updates = [];
    for (let id of this.dirtyRecords()) {
      if (!additions.has(id) && !deletions.has(id)) {
        const diff = { id };
        const dp = this.datapoints[id];
        const changes = dp.changes();
        for (let i = 0; i < changes.length; i++) {
          let change = changes[i];
          if (change !== void 0) {
            diff[this.indexToField[i]] = change;
          }
        }
        updates.push(diff);
      }
    }
    if (additions.size || updates.length || deletions.size) {
      const result = {};
      if (additions.size) {
        result.additions = [...additions].map(
          (id) => this.datapoints[id].record.toJSON()
        );
      }
      if (deletions.size) {
        result.deletions = [...deletions];
      }
      if (updates.length) {
        result.updates = updates;
      }
      return result;
    }
    return null;
  }
};
var ORM = class _ORM {
  static uuid() {
    const str = Date.now().toString(36) + "-xxxx-xxxx";
    return str.replace(/[x]/g, () => (Math.random() * 16 | 0).toString(16));
  }
  static fromJSON(obj, models) {
    const orm = new _ORM();
    orm.loadJSON(obj, models);
    return orm;
  }
  _parent;
  _ctx;
  #applyingChanges = false;
  constructor(parent) {
    this._parent = parent || null;
    if (parent) {
      this._ctx = parent._ctx;
      const pdata = parent.#db();
      for (let mId in pdata) {
        const ptable = pdata[mId];
        const table = this._getTable(ptable.Model);
        table.baseRecords = computed(() => {
          return ptable.activeDatapoints().map((dp) => dp.record.id);
        });
      }
    } else {
      this._ctx = getScope();
    }
  }
  toJSON() {
    const store = {};
    const data = this.#db();
    for (let m2 in data) {
      const records = data[m2].activeRecords().map((r) => r.toJSON());
      if (records.length) {
        store[m2] = records;
      }
    }
    return store;
  }
  #db = signal.Object({});
  _getTable(M) {
    const id = M.id;
    const data = this.#db();
    if (!(id in data)) {
      const table = new Table(this, M);
      data[id] = table;
    }
    return data[id];
  }
  loadJSON(json, models) {
    for (let id in json) {
      const M = models.find((m2) => m2.id === id);
      if (!M) {
        throw new Error(`Unknown model "${id}" in JSON (registered models: ${models.map((m2) => m2.id).join(", ")})`);
      }
      const table = this._getTable(M);
      for (let record of json[id]) {
        new DataPoint(
          this,
          table,
          record.id,
          record,
          !!this._parent,
          this._ctx
        );
        table.baseRecords().push(record.id);
      }
    }
  }
  create(M, initialState = {}) {
    const table = this._getTable(M);
    const id = initialState.id || _ORM.uuid();
    const dp = new DataPoint(
      this,
      table,
      id,
      initialState,
      !!this._parent,
      this._ctx
    );
    table.recordChanges().push({ type: "add", id });
    this.#linkRelations(dp);
    if (!this._parent && !this.#applyingChanges) {
      dp.record.onCreate();
    }
    return dp.record;
  }
  #linkRelations(dp) {
    for (let field of dp.table.fields) {
      if (field instanceof Many2OneField) {
        const value = field.getValue(dp);
        if (value) {
          const coTable = this._getTable(value.constructor);
          for (let cf of coTable.fields) {
            if (cf instanceof One2ManyField) {
              const cfg = cf.config;
              if (cfg.comodel() === dp.table.Model && cfg.inverse === field.name) {
                const codp = coTable.getDatapointById(value.id);
                const raw = Field.prototype.getValue.call(cf, codp) || [];
                const ids = raw.map(
                  (v) => typeof v === "string" ? v : v.id
                );
                if (!ids.includes(dp.record.id)) {
                  cf._setValue(codp, [...ids, dp.record.id]);
                }
              }
            }
          }
        }
      }
    }
  }
  pendingChanges = computed(() => {
    const result = {};
    const data = this.#db();
    for (let id in data) {
      const table = data[id];
      const changes = table.pendingChanges();
      if (changes) {
        result[id] = changes;
      }
    }
    return result;
  });
  applyChanges(changes, models = []) {
    this.#applyingChanges = true;
    const data = this.#db();
    for (let modelId in changes) {
      const modelChanges = changes[modelId];
      let table = data[modelId];
      if (!table) {
        const M = models.find((m2) => m2.id === modelId);
        if (!M) {
          throw new Error(`Unknown model "${modelId}" in changeset (registered models: ${models.map((m2) => m2.id).join(", ")})`);
        }
        table = this._getTable(M);
      }
      for (let r of modelChanges.additions || []) {
        this.create(table.Model, r);
      }
      for (let id of modelChanges.deletions || []) {
        const dp = table.datapoints[id];
        this.delete(dp.record);
      }
      for (let update of modelChanges.updates || []) {
        const id = update.id;
        const dp = table.datapoints[id];
        const changes2 = dp.changes();
        for (let k in update) {
          if (k !== "id") {
            changes2[table.fieldToIndex[k]] = update[k];
          }
        }
        signal.trigger(dp.changes);
        table.dirtyRecords().add(id);
      }
    }
    this.#applyingChanges = false;
  }
  draft() {
    return new _ORM(this);
  }
  /**
   * Push draft changes to the parent ORM. Only valid on a draft ORM
   * created via `orm.draft()`. Additions, deletions, and field updates
   * are applied to the parent atomically; `onCreate()` fires on newly
   * added records in the parent after they land. Throws if this ORM
   * has no parent.
   */
  commit() {
    if (!this._parent) {
      throw new Error("commit() is for draft ORMs \u2014 use flush() on a root ORM");
    }
    const data = this.#db();
    const changes = this.pendingChanges();
    const models = Object.values(data).map((s) => s.Model);
    this._parent.applyChanges(changes, models);
    for (let modelId in changes) {
      const parentTable = this._parent._getTable(data[modelId].Model);
      for (let r of changes[modelId].additions || []) {
        parentTable.datapoints[r.id].record.onCreate();
      }
    }
    this.#clearPending();
  }
  /**
   * Acknowledge pending changes on a root ORM: bake current field
   * values into `rawData`, consolidate `baseRecords`, and reset all
   * dirty tracking so that `pendingChanges()` returns `{}`. This does
   * NOT move data anywhere — it just resets the "what changed since
   * last flush" baseline. Throws if called on a draft ORM.
   */
  flush() {
    if (this._parent) {
      throw new Error("flush() is for root ORMs \u2014 use commit() on a draft ORM");
    }
    const data = this.#db();
    for (let modelId in data) {
      const table = data[modelId];
      const datapoints = table.activeDatapoints();
      const updates = table.dirtyRecords();
      table.baseRecords.set(datapoints.map((r) => r.record.id));
      for (let id of updates) {
        const dp = table.datapoints[id];
        const _nextRawData = dp.rawData();
        for (let f of table.fields) {
          _nextRawData[f.index] = f.getRawValue(dp);
        }
      }
    }
    this.#clearPending();
  }
  #clearPending() {
    const data = this.#db();
    for (let modelId in data) {
      const table = data[modelId];
      const dirty = table.dirtyRecords();
      table.dirtyRecords.set(/* @__PURE__ */ new Set());
      table.recordChanges.set([]);
      for (let id of dirty) {
        const dp = table.datapoints[id];
        dp.changes().length = 0;
        signal.trigger(dp.changes);
      }
    }
  }
  discard() {
    const data = this.#db();
    for (let modelId in data) {
      const table = data[modelId];
      table.recordChanges.set([]);
      for (let id of table.dirtyRecords()) {
        const dp = table.datapoints[id];
        dp.changes().length = 0;
        signal.trigger(dp.changes);
      }
      table.dirtyRecords.set(/* @__PURE__ */ new Set());
    }
  }
  records(M) {
    const table = this._getTable(M);
    return table.activeRecords();
  }
  records$(M) {
    const table = this._getTable(M);
    return table.activeRecords;
  }
  getById(M, id) {
    const table = this._getTable(M);
    const dp = table.datapoints[id];
    return dp ? dp.record : null;
  }
  delete(record) {
    const table = this._getTable(record.constructor);
    this.#unlinkRelations(table.datapoints[record.id]);
    table.recordChanges().push({ type: "delete", id: record.id });
  }
  #unlinkRelations(dp) {
    for (let field of dp.table.fields) {
      if (field instanceof Many2OneField) {
        const value = field.getValue(dp);
        if (value) {
          const coTable = this._getTable(value.constructor);
          for (let cf of coTable.fields) {
            if (cf instanceof One2ManyField) {
              const cfg = cf.config;
              if (cfg.comodel() === dp.table.Model && cfg.inverse === field.name) {
                const codp = coTable.getDatapointById(value.id);
                const raw = Field.prototype.getValue.call(cf, codp) || [];
                const ids = raw.map(
                  (v) => typeof v === "string" ? v : v.id
                );
                if (ids.includes(dp.record.id)) {
                  cf._setValue(
                    codp,
                    ids.filter((id) => id !== dp.record.id)
                  );
                }
              }
            }
          }
        }
      }
    }
  }
};

// static/src/core/observed_models.js
var RepoStatus = class extends Model {
  static id = "repostatus";
  // id = repo id ("community")
  current = fields.char();
  // the checked-out branch
  dirty = fields.bool();
  error = fields.json();
  // null | string
  branches = fields.json();
  // [{ name, date, runbot, remote, synced, subject }, …]
  fetchedAt = fields.number();
  // request-start stamp — the step-4 "latest wins" key
};
var PrRepo = class extends Model {
  static id = "prrepo";
  // id = repo id
  github = fields.char();
  error = fields.json();
  prs = fields.json();
  // [PullRequest, …] (normalized, see models.js)
  fetchedAt = fields.number();
};
var MergebotStatus = class extends Model {
  static id = "mergebot";
  // id = "github#number"
  state = fields.char();
  // "" | "merged" | blocked reason
  detail = fields.json();
  // blocked-reason detail (string) | null
};
var RunbotStatus = class extends Model {
  static id = "runbot";
  // id = branch name
  status = fields.json();
  // runbot status value
};

// static/src/core/runtime_models.js
var OdooServer = class extends Model {
  static id = "odooserver";
  // id = "main" | target id
  data = fields.json();
  // the ServerSnapshot object (spread-merged)
};
var Run = class extends Model {
  static id = "run";
  // id = backend-minted run id
  data = fields.json();
  // the RunSnapshot object
};

// static/src/core/store_plugin.js
var StorePlugin = class extends Plugin {
  static sequence = 0;
  // the shared store — set up before every plugin that reads it
  // one owl-orm ORM for all of StorePlugin's state — observed (RepoStatus / PrRepo /
  // MergebotStatus / RunbotStatus) and runtime (OdooServer / Run)
  orm = new ORM();
  // in-flight keys, shared across the Code + Reviews screens so they never double-fetch
  mbPending = /* @__PURE__ */ new Set();
  rbPending = /* @__PURE__ */ new Set();
  // ── observed accessors — computeds that rebuild the shapes consumers already read ─
  _repoList = computed(
    () => this.orm.records(RepoStatus).map((r) => ({
      id: r.id,
      current: r.current(),
      dirty: r.dirty(),
      error: r.error(),
      branches: r.branches(),
      fetchedAt: r.fetchedAt()
    }))
  );
  _prList = computed(
    () => this.orm.records(PrRepo).map((r) => ({
      id: r.id,
      github: r.github(),
      error: r.error(),
      prs: r.prs(),
      fetchedAt: r.fetchedAt()
    }))
  );
  // one shared mergebot map both the Code and Reviews screens read (aliased there)
  mergebot = computed(
    () => Object.fromEntries(this.orm.records(MergebotStatus).map((m2) => [m2.id, m2.state()]))
  );
  mbDetails = computed(
    () => Object.fromEntries(
      this.orm.records(MergebotStatus).filter((m2) => m2.detail() != null).map((m2) => [m2.id, m2.detail()])
    )
  );
  runbot = computed(
    () => Object.fromEntries(this.orm.records(RunbotStatus).map((r) => [r.id, r.status()]))
  );
  repoStatusList() {
    return this._repoList();
  }
  prReposList() {
    return this._prList();
  }
  // ── observed writers — preserve the step-4 semantics over records ─────────────
  // fold a branch-state fetch into RepoStatus records. `at` is the request-start
  // timestamp: stamping when the read was *requested* makes "latest wins" order a full
  // scan behind a targeted refresh that raced it. A full fetch (authoritative) drops
  // repos that vanished from config.
  mergeRepoStatus(repos, at, { authoritative } = {}) {
    for (const raw of repos) {
      const fetchedAt = raw.fetchedAt ?? at;
      const rec = this.orm.getById(RepoStatus, raw.id);
      if (!rec) {
        this.orm.create(RepoStatus, {
          id: raw.id,
          current: raw.current ?? "",
          dirty: !!raw.dirty,
          error: raw.error ?? null,
          branches: raw.branches ?? [],
          fetchedAt
        });
      } else if (rec.fetchedAt() <= fetchedAt) {
        rec.current.set(raw.current ?? "");
        rec.dirty.set(!!raw.dirty);
        rec.error.set(raw.error ?? null);
        rec.branches.set(raw.branches ?? []);
        rec.fetchedAt.set(fetchedAt);
      }
    }
    if (authoritative) {
      const seen = new Set(repos.map((r) => r.id));
      for (const rec of this.orm.records(RepoStatus)) if (!seen.has(rec.id)) this.orm.delete(rec);
    }
  }
  // fold a PR fetch into PrRepo records. Authoritative only over the repos it requested
  // (scopeIds), so a narrowed dashboard/target load merges into — rather than replaces
  // — the full list, while a full load still drops repos that left the config.
  mergePrRepos(repos, at, scopeIds) {
    for (const raw of repos) {
      const fetchedAt = raw.fetchedAt ?? at;
      const rec = this.orm.getById(PrRepo, raw.id);
      if (!rec) {
        this.orm.create(PrRepo, {
          id: raw.id,
          github: raw.github ?? "",
          error: raw.error ?? null,
          prs: raw.prs ?? [],
          fetchedAt
        });
      } else if (rec.fetchedAt() <= fetchedAt) {
        rec.github.set(raw.github ?? "");
        rec.error.set(raw.error ?? null);
        rec.prs.set(raw.prs ?? []);
        rec.fetchedAt.set(fetchedAt);
      }
    }
    const seen = new Set(repos.map((r) => r.id));
    for (const rec of this.orm.records(PrRepo)) {
      if (scopeIds.has(rec.id) && !seen.has(rec.id)) this.orm.delete(rec);
    }
  }
  mergeMergebot(states, details) {
    for (const [k, v] of Object.entries(states || {})) {
      const rec = this.orm.getById(MergebotStatus, k);
      if (rec) rec.state.set(v);
      else this.orm.create(MergebotStatus, { id: k, state: v, detail: (details || {})[k] ?? null });
    }
    for (const [k, v] of Object.entries(details || {})) {
      const rec = this.orm.getById(MergebotStatus, k);
      if (rec) rec.detail.set(v);
      else this.orm.create(MergebotStatus, { id: k, state: (states || {})[k] ?? "", detail: v });
    }
  }
  mergeRunbot(states) {
    for (const [k, v] of Object.entries(states || {})) {
      const rec = this.orm.getById(RunbotStatus, k);
      if (rec) rec.status.set(v);
      else this.orm.create(RunbotStatus, { id: k, status: v });
    }
  }
  // clear the mergebot / runbot records so a forced refresh re-displays fresh badges
  clearExternal() {
    for (const m2 of this.orm.records(MergebotStatus)) this.orm.delete(m2);
    for (const r of this.orm.records(RunbotStatus)) this.orm.delete(r);
  }
  // ── optimistic local edits (no server round-trip) ─────────────────────────────
  // drop a branch from a repo's snapshot after a local delete, without a refetch
  dropBranch(repoId, name) {
    const rec = this.orm.getById(RepoStatus, repoId);
    if (rec) rec.branches.set((rec.branches() || []).filter((b) => b.name !== name));
  }
  // mark a PR closed in the view after closing it, without a refetch
  closePr(github, number) {
    for (const rec of this.orm.records(PrRepo)) {
      if (rec.github() !== github) continue;
      rec.prs.set(
        (rec.prs() || []).map((p) => p.number === number ? { ...p, state: "closed" } : p)
      );
    }
  }
  // ── runtime: OdooServer / Run records + the derived TargetView join ───────────────
  // fold one server snapshot into its OdooServer record, keyed by id. Spread-merge into
  // the `data` json so a partial SSE update (a worktree carrying only state/port)
  // preserves the fields it omits — notably a worktree's client-only `exists`. The
  // "main" snapshot carries every field.
  mergeServer(snap) {
    if (!snap || !snap.id) return;
    const rec = this.orm.getById(OdooServer, snap.id);
    if (rec) rec.data.set({ ...rec.data(), ...snap });
    else this.orm.create(OdooServer, { id: snap.id, data: { ...snap } });
  }
  // forget a server record (a worktree removed from config)
  dropServer(id) {
    const rec = this.orm.getById(OdooServer, id);
    if (rec) this.orm.delete(rec);
  }
  server(id) {
    const rec = this.orm.getById(OdooServer, id);
    return rec ? rec.data() : null;
  }
  // the server backing a target: the main process when it's running this target,
  // otherwise the target's own worktree server (or null)
  serverFor(tgt) {
    const main = this.server("main");
    if (main && main.target === tgt.id && (main.state === "running" || main.state === "starting")) {
      return main;
    }
    return this.server(tgt.id);
  }
  // fold one run snapshot into its Run record, keyed by run id (SSE "run": running → done/failed)
  mergeRun(snap) {
    if (!snap || !snap.id) return;
    const rec = this.orm.getById(Run, snap.id);
    if (rec) rec.data.set({ ...rec.data(), ...snap });
    else this.orm.create(Run, { id: snap.id, data: { ...snap } });
  }
  // the currently-running one-shot (there's one shared slot), or null
  activeRun() {
    for (const r of this.orm.records(Run)) {
      const d = r.data();
      if (d.state === "running") return d;
    }
    return null;
  }
  // the most recent run of a kind (test | install | upgrade), running or finished — so
  // a screen still shows its last result after a run of another kind occupied the slot
  latestRunOfKind(kind) {
    let best = null;
    for (const r of this.orm.records(Run)) {
      const d = r.data();
      if (d.kind !== kind) continue;
      if (!best || (d.started_at || 0) >= (best.started_at || 0)) best = d;
    }
    return best;
  }
  // the aggregate the UI orbits: a target joined with its checkouts' live git state
  // (current branch, does it match, dirty), its server, and the one-shot run holding
  // its slot. db/claude are filled in a later step.
  targetView(tgt) {
    const checkouts = (tgt.checkouts || []).map(({ repo, branch }) => {
      const rec = this.orm.getById(RepoStatus, repo);
      const current = rec ? rec.current() : void 0;
      return { repo, branch, current, matches: current === branch, dirty: !!(rec && rec.dirty()) };
    });
    const active = this.activeRun();
    const run = active && active.target === tgt.id ? active : null;
    return {
      target: tgt,
      checkouts,
      server: this.serverFor(tgt),
      db: null,
      run,
      claude: null
    };
  }
};

// static/src/core/event_log_plugin.js
var MAX = 500;
var EventLogPlugin = class extends Plugin {
  static sequence = 1;
  entries = signal([]);
  // [{ id, at, text }]
  open = signal(false);
  // overlay panel visibility
  lastReadId = signal(0);
  // highest entry id seen the last time the panel was open
  _seq = 0;
  // `anchor` (optional) is a DOM id of a log row the UI can scroll to. It is kept
  // client-side only — the server log still receives just the text. `level`
  // (e.g. "error") flags the entry so the UI can highlight it.
  add(text, anchor = "", level = "") {
    const next = [...this.entries(), { id: ++this._seq, at: Date.now(), text, anchor, level }];
    this.entries.set(next.length > MAX ? next.slice(-MAX) : next);
    postJSON("/api/event", { text }).catch(() => {
    });
  }
  // Begin a long-running event: appends a row with an animated "..." that finish()
  // later resolves to "ok" (or "failed"). `eid` correlates the start and the end —
  // it comes from the server (so the same token tags both SSE messages); the
  // server already logged the line, so this does not POST it back.
  start(eid, text, level = "") {
    const row = {
      id: ++this._seq,
      at: Date.now(),
      text,
      anchor: "",
      level,
      status: "pending",
      eid
    };
    const next = [...this.entries(), row];
    this.entries.set(next.length > MAX ? next.slice(-MAX) : next);
  }
  // Begin a *client-initiated* long-running event (e.g. starting the server): same
  // pending row as start(), but it mints and returns the correlation id so the
  // caller can finish()/drop() it later. Logged on the goo server too (best-effort).
  begin(text, level = "") {
    const eid = `local-${this._seq + 1}`;
    this.start(eid, text, level);
    postJSON("/api/event", { text }).catch(() => {
    });
    return eid;
  }
  // Resolve a long-running event by its id: append "ok" ("done") or "failed"
  // ("error") after its dots, keeping the original text. If the start was missed
  // (e.g. the client connected mid-flight) and a text is given, fall back to
  // appending a finished row.
  finish(eid, status, text = "", level = "") {
    let found = false;
    const entries = this.entries().map((e) => {
      if (e.eid !== eid) return e;
      found = true;
      return { ...e, status, level: level || e.level };
    });
    if (found) this.entries.set(entries);
    else if (text) {
      const row = { id: ++this._seq, at: Date.now(), text, anchor: "", level, status, eid };
      const next = [...entries, row];
      this.entries.set(next.length > MAX ? next.slice(-MAX) : next);
    }
  }
  // Drop a pending event by its id (e.g. the user cancelled before it really began).
  drop(eid) {
    this.entries.set(this.entries().filter((e) => e.eid !== eid));
  }
  toggle() {
    this.open.set(!this.open());
    this.markRead();
  }
  // mark every current entry as read (clears the unread badge)
  markRead() {
    this.lastReadId.set(this._seq);
  }
  // events that arrived since the panel was last open (0 while it's open)
  unread() {
    if (this.open()) return 0;
    return this.entries().filter((e) => e.id > this.lastReadId()).length;
  }
  clear() {
    this.entries.set([]);
  }
};

// static/src/core/dialog_plugin.js
var _seq = 0;
var DialogPlugin = class extends Plugin {
  dialogs = signal.Array([]);
  // the mount location for the dialog container. Owned here; the main app binds
  // it with t-ref (via `plugin(DialogPlugin).root`) to a DOM node, and the
  // effect below mounts the container there once it exists.
  root = signal.ref(HTMLElement);
  setup() {
    const app = useApp();
    useEffect(() => {
      const target = this.root();
      if (!target) return;
      const root = app.createRoot(DialogContainer);
      root.mount(target);
      return () => root.destroy();
    });
  }
  // low-level: mount component `C` with `props`. Returns a handle whose
  // `close()` removes the dialog. Each dialog gets a unique id.
  add(C, props2 = {}) {
    const id = ++_seq;
    const close = () => this.dialogs.set(this.dialogs().filter((d) => d.id !== id));
    this.dialogs.set([...this.dialogs(), { id, Component: C, props: props2 }]);
    return { id, close };
  }
  // promise-based: mount `C`, inject a `done(result)` prop that closes the
  // dialog and resolves the promise with `result`.
  openComponent(C, props2 = {}) {
    return new Promise((resolve) => {
      const handle = this.add(C, {
        ...props2,
        done: (result) => {
          handle.close();
          resolve(result);
        }
      });
    });
  }
  // the common case: a form/message dialog (see Dialog's spec shape below).
  // Resolves to the field values on OK, or null when discarded/escaped.
  open(spec) {
    return this.openComponent(Dialog, { spec });
  }
};
var DialogContainer = class extends Component {
  static template = xml`
    <div>
      <t t-foreach="this.dialogs()" t-as="dialog" t-key="dialog.id">
        <t t-component="dialog.Component" t-props="dialog.props"/>
      </t>
    </div>`;
  dialogs = plugin(DialogPlugin).dialogs;
};
var Dialog = class extends Component {
  static template = xml`
    <div class="dialog-backdrop" t-on-click="() => this.done(null)">
      <div class="dialog" t-att-class="this.spec.cls || ''" t-on-click.stop="() => {}">
        <h2 class="dialog-title" t-out="this.spec.title"/>
        <div class="dialog-body" data-form-type="other">
          <p t-if="this.spec.message" class="dialog-msg" t-out="this.spec.message"/>
          <div t-foreach="this.spec.fields || []" t-as="f" t-key="f.key" class="dialog-field">
            <label t-if="f.type === 'checkbox'" class="edit-check">
              <input type="checkbox" t-att-checked="this.values()[f.key]" t-on-change="(ev) => this.setVal(f.key, ev.target.checked)"/>
              <t t-out="f.label"/>
            </label>
            <t t-elif="f.type === 'select'">
              <label t-out="f.label"/>
              <select t-on-change="(ev) => this.setVal(f.key, ev.target.value)">
                <option value=""><t t-out="f.placeholder || '— none —'"/></option>
                <t t-foreach="f.options || []" t-as="opt" t-key="opt.value">
                  <option t-att-value="opt.value" t-att-selected="this.values()[f.key] === opt.value" t-out="opt.label"/>
                </t>
              </select>
            </t>
            <div t-elif="f.type === 'check-select'" class="dialog-check-select">
              <label class="edit-check">
                <input type="checkbox" t-att-checked="!!this.values()[f.key]" t-on-change="(ev) => this.toggleCheckSelect(f, ev.target.checked)"/>
                <t t-out="f.label"/>
              </label>
              <select t-if="this.values()[f.key]" t-on-change="(ev) => this.setVal(f.key, ev.target.value)">
                <t t-foreach="f.options || []" t-as="opt" t-key="opt.value">
                  <option t-att-value="opt.value" t-att-selected="this.values()[f.key] === opt.value" t-out="opt.label"/>
                </t>
              </select>
            </div>
            <t t-else="">
              <label t-out="f.label"/>
              <input type="text" t-att-value="this.values()[f.key]" t-att-placeholder="f.placeholder || ''" t-on-input="(ev) => this.setVal(f.key, ev.target.value)" t-on-keydown="(ev) => this.onKey(ev)"/>
            </t>
          </div>
        </div>
        <div class="dialog-foot">
          <span t-if="this.touched() and this.liveError" class="form-error" t-out="this.liveError"/>
          <button class="pbtn primary" t-att-disabled="!!this.liveError" t-on-click="() => this.ok()" t-out="this.spec.okLabel || 'OK'"/>
          <button t-if="this.spec.cancelLabel !== null" class="pbtn" t-on-click="() => this.done(null)" t-out="this.spec.cancelLabel || 'Discard'"/>
        </div>
      </div>
    </div>`;
  props = props({ spec: t.any(), done: t.function() });
  values = signal({});
  touched = signal(false);
  // has the user edited a field? (gates the inline error)
  get spec() {
    return this.props.spec;
  }
  // the current form's validation error ("" when valid). Reactive on `values`, so
  // it both disables the primary button and (once edited) shows the message —
  // an invalid form (e.g. a duplicate target name) can't be submitted at all.
  get liveError() {
    return this.spec.validate ? this.spec.validate(this.values()) : "";
  }
  setup() {
    const vals = {};
    for (const f of this.spec.fields || [])
      vals[f.key] = f.value ?? (f.type === "checkbox" ? false : "");
    this.values.set(vals);
    const onKey = (e) => {
      if (e.key === "Escape") this.done(null);
    };
    document.addEventListener("keydown", onKey);
    onWillUnmount(() => document.removeEventListener("keydown", onKey));
    onMounted(() => {
      const inp = document.querySelector(".dialog input[type=text]");
      if (inp) {
        inp.focus();
        inp.select();
      }
    });
  }
  done(result) {
    this.props.done(result);
  }
  setVal(key, v) {
    const oldValues = this.values();
    let values = { ...oldValues, [key]: v };
    const field = this.spec.fields.find((f) => f.key === key);
    if (field && field.onChange) {
      const updates = field.onChange(v, values, oldValues);
      if (updates) values = { ...values, ...updates };
    }
    this.values.set(values);
    this.touched.set(true);
  }
  // a "check-select" field's value is "" (unchecked) or the selected option. Ticking
  // it on seeds a sensible choice — field.default(values), else the first option — so
  // the revealed select isn't empty; unticking clears it back to "".
  toggleCheckSelect(field, checked) {
    if (!checked) return this.setVal(field.key, "");
    const seed = typeof field.default === "function" ? field.default(this.values()) : field.default;
    this.setVal(field.key, seed || field.options?.[0]?.value || "");
  }
  onKey(ev) {
    if (ev.key === "Enter") this.ok();
  }
  ok() {
    if (this.liveError) return this.touched.set(true);
    this.done({ ...this.values() });
  }
};

// static/src/core/models.js
var prKey = (github, number) => `${github}#${number}`;
var branchKey = (repo, name) => `${repo}:${name}`;
var PullRequest = {
  from(raw) {
    return {
      github: raw.github || "",
      number: raw.number,
      title: raw.title || "",
      url: raw.url || "",
      state: (raw.state || "").toLowerCase(),
      // open | closed | merged
      draft: !!raw.draft,
      branch: raw.branch || "",
      relation: raw.relation || "",
      // authored | reviewed
      createdAt: raw.created_at || "",
      updatedAt: raw.updated_at || "",
      ci: raw.ci || null,
      key: prKey(raw.github || "", raw.number)
    };
  }
};

// static/src/core/code_plugin.js
var PRS_CACHE_KEY = "oo-prs-cache";
var CodePlugin = class extends Plugin {
  static sequence = 3;
  config = plugin(ConfigPlugin);
  store = plugin(StorePlugin);
  // the shared observed store (branches/PRs/runbot/mergebot)
  eventLog = plugin(EventLogPlugin);
  dialogs = plugin(DialogPlugin);
  // observed state lives in the store, normalized by identity; these expose it in the
  // shapes the components already read — array views over the keyed maps, and the
  // shared runbot/mergebot signals (the same maps the Reviews screen reads).
  branchRepos = computed(() => this.store.repoStatusList());
  prRepos = computed(() => this.store.prReposList());
  mergebot = this.store.mergebot;
  // "github#number" -> mergebot state (one shared copy)
  mbDetails = this.store.mbDetails;
  // "github#number" -> blocked-reason detail
  runbot = this.store.runbot;
  // branch name -> runbot status
  at = signal((this._cache() || {}).at || 0);
  loading = signal(false);
  error = signal("");
  busy = signal(false);
  _refreshExternal = false;
  // true during a forced load: ask the server to bypass its cache
  // grouped, sorted view model — recomputed only when its inputs change
  groups = computed(() => this._groups());
  // hydrate the store from the instant-paint cache once, so a reload doesn't flash
  // empty until the branch fetch lands (branches are local git — uncached server-side).
  // The cached snapshots carry an old stamp, so the fresh fetch's later `at` wins.
  setup() {
    const c = this._cache();
    if (c && c.branchRepos) {
      this.store.mergeRepoStatus(c.branchRepos, c.at || 0, { authoritative: false });
    }
  }
  // mergebot state for the given PRs. Only fetch what we don't already hold and
  // isn't already in flight — that `have`-based dedup is what stops the dashboard
  // effect (which re-runs when the signal updates) from looping. A forced refresh
  // clears the signal in load() and passes refresh:true so the server re-scrapes.
  async loadMergebot(prs) {
    const refresh = this._refreshExternal;
    const have = this.mergebot();
    const todo = prs.filter((p) => {
      const k = `${p.github}#${p.number}`;
      return !(k in have) && !this.store.mbPending.has(k);
    });
    if (!todo.length) return;
    const keys = todo.map((p) => `${p.github}#${p.number}`);
    keys.forEach((k) => this.store.mbPending.add(k));
    try {
      const res = await postJSON("/api/mergebot", { prs: todo, refresh });
      this.store.mergeMergebot(res.states, res.details || {});
    } catch {
    } finally {
      keys.forEach((k) => this.store.mbPending.delete(k));
    }
  }
  // runbot status for the given branches — same dedup as loadMergebot
  async loadRunbot(branches) {
    const refresh = this._refreshExternal;
    const have = this.runbot();
    const todo = branches.filter((b) => !(b in have) && !this.store.rbPending.has(b));
    if (!todo.length) return;
    todo.forEach((b) => this.store.rbPending.add(b));
    try {
      const res = await postJSON("/api/runbot", { branches: todo, refresh });
      this.store.mergeRunbot(res.states);
    } catch {
    } finally {
      todo.forEach((b) => this.store.rbPending.delete(b));
    }
  }
  reposWithGithub() {
    return this.config.config.repos.map((r) => ({
      ...r,
      github: r.github ?? DEFAULT_CONFIG.repos.find((d) => d.id === r.id)?.github
    }));
  }
  // a repo added for convenience but outside the odoo CI ecosystem (e.g. odoo/owl):
  // flagged `external` in config, so we skip its mergebot + runbot scrapes (they'd
  // only 404 — those services don't index it). Keyed by the github slug PRs carry.
  isExternalRepo(github) {
    return !!github && !!this.config.config.repos.find((r) => r.github === github)?.external;
  }
  // last-known branches, kept only for an instant first paint on reload (PRs are
  // now server-cached and always fetched fresh, so they're no longer stored here)
  _cache() {
    try {
      const c = JSON.parse(localStorage.getItem(PRS_CACHE_KEY));
      return c && c.at && c.branchRepos ? c : null;
    } catch {
      return null;
    }
  }
  // Branches come from local git (fast, volatile) and PRs/runbot/mergebot are now
  // cached server-side, so we simply request everything and let the backend decide
  // freshness. `force` (the manual Refresh) passes refresh:true to bypass the cache.
  // `prRepoIds` / `branchRepoIds` (Sets) narrow the PR / branch fetches to those repo
  // ids — the dashboard only shows a subset (its favorite/target repos), so there's
  // no point reading the rest: PR fetches hit GitHub, and each branch read is ~8 git
  // subprocesses. null = every repo (the Branches/PRs/Targets tabs, which show all).
  async load(force = false, prRepoIds = null, branchRepoIds = null) {
    this.loading.set(true);
    this.error.set("");
    this._refreshExternal = force;
    if (force) this.store.clearExternal();
    const at = Date.now();
    const repos = this.reposWithGithub();
    const branchReq = branchRepoIds ? repos.filter((r) => branchRepoIds.has(r.id)) : repos;
    const branchesP = postJSON("/api/code/branches", { repos: branchReq }).then((b) => {
      this.store.mergeRepoStatus(b.repos, at, { authoritative: !branchRepoIds });
      return true;
    }).catch((e) => {
      this.error.set(e.message);
      return false;
    });
    const prReq = repos.filter((r) => r.github && (!prRepoIds || prRepoIds.has(r.id)));
    const scopeIds = new Set(prReq.map((r) => r.id));
    const prsP = postJSON("/api/prs", { repos: prReq, refresh: force }).then((p) => {
      const normalized = p.repos.map((r) => ({ ...r, prs: (r.prs || []).map(PullRequest.from) }));
      this.store.mergePrRepos(normalized, at, scopeIds);
    }).catch((e) => {
      this.error.set(e.message);
    });
    const [ok] = await Promise.all([branchesP, prsP]);
    this.loading.set(false);
    this.at.set(at);
    if (ok) {
      const branchRepos = this.store.repoStatusList();
      localStorage.setItem(PRS_CACHE_KEY, JSON.stringify({ at, branchRepos }));
    }
  }
  // fetch just the local branch/checkout state (no PRs, runbot or mergebot),
  // optionally scoped to a set of repo ids. For a screen that needs checkout/dirty
  // state on demand but never shows PRs — the Targets kebab. Leaves the PR/runbot/
  // mergebot signals untouched (unlike load(), which also refetches those).
  async loadBranches(branchRepoIds = null) {
    const repos = this.reposWithGithub();
    const req = branchRepoIds ? repos.filter((r) => branchRepoIds.has(r.id)) : repos;
    const at = Date.now();
    try {
      const b = await postJSON("/api/code/branches", { repos: req });
      this.store.mergeRepoStatus(b.repos, at, { authoritative: !branchRepoIds });
    } catch (e) {
      this.error.set(e.message);
    }
  }
  // re-read branch state for just the given repo ids (a Set) and MERGE it into the
  // current view, leaving every other repo's still-valid data in place. For ops that
  // only touch a subset of repos — a target's checkout, a (per-repo or "all") rebase
  // — so we don't re-scan every clone. Like loadBranches it leaves PR/runbot/mergebot
  // untouched: a local checkout/rebase changes the working tree, not the PRs.
  async refreshBranches(repoIds) {
    const repos = this.reposWithGithub().filter((r) => repoIds.has(r.id));
    if (!repos.length) return;
    const at = Date.now();
    try {
      const b = await postJSON("/api/code/branches", { repos });
      this.store.mergeRepoStatus(b.repos, at, { authoritative: false });
      const cache = this._cache();
      if (cache) {
        const branchRepos = this.store.repoStatusList();
        localStorage.setItem(PRS_CACHE_KEY, JSON.stringify({ ...cache, branchRepos }));
      }
    } catch (e) {
      this.error.set(e.message);
    }
  }
  _groups() {
    const repos = this.reposWithGithub();
    const githubByRepo = Object.fromEntries(repos.map((r) => [r.id, r.github]));
    const pathByRepo = Object.fromEntries(repos.map((r) => [r.id, r.path]));
    const prIndex = {};
    for (const repo of this.prRepos()) {
      for (const pr of repo.prs) prIndex[branchKey(repo.id, pr.branch)] = pr;
    }
    const map = /* @__PURE__ */ new Map();
    for (const repo of this.branchRepos()) {
      for (const b of repo.branches) {
        if (!map.has(b.name)) map.set(b.name, []);
        map.get(b.name).push({
          repo: repo.id,
          date: b.date,
          runbot: b.runbot,
          remote: b.remote,
          checkedOut: b.name === repo.current
        });
      }
    }
    return {
      githubByRepo,
      pathByRepo,
      prIndex,
      errors: this.prRepos().filter((r) => r.error),
      list: [...map.entries()].map(([branch, rows]) => {
        let activity = 0;
        for (const r of rows) {
          activity = Math.max(activity, Date.parse(r.date) || 0);
          const pr = prIndex[`${r.repo}:${branch}`];
          if (pr) activity = Math.max(activity, Date.parse(pr.updatedAt) || 0);
        }
        return {
          branch,
          rows,
          activity,
          base: BASE_BRANCH_RE.test(branch),
          runbot: rows.map((r) => r.runbot).find(Boolean) || ""
        };
      }).sort((a, b) => a.base - b.base || b.activity - a.activity)
    };
  }
  // GitHub / mergebot URL helpers. The logic lives on the Repository model (via the
  // shared repoUrls builders); these resolve the repo by slug and delegate, falling
  // back to the bare-slug builder for a reviewed PR from a repo that isn't in config.
  prCreateUrl(github, branch) {
    return this.config.repoByGithub(github)?.compareUrl(branch) ?? repoUrls.compare(github, branch);
  }
  forkBranchUrl(github, branch) {
    return this.config.repoByGithub(github)?.forkBranchUrl(branch) ?? repoUrls.fork(github, branch);
  }
  remoteBranchUrl(github, branch) {
    return this.config.repoByGithub(github)?.remoteBranchUrl(branch) ?? repoUrls.remote(github, branch);
  }
  mergebotUrl(github, number) {
    return this.config.repoByGithub(github)?.mergebotUrl(number) ?? repoUrls.mergebot(github, number);
  }
  async remoteExists(path, branch) {
    const res = await postJSON("/api/code/branch/remote", { path, branch });
    return res.exists;
  }
  // last commits on a branch (ref; defaults to the repo's current branch)
  async commits(path, ref = "") {
    const res = await postJSON("/api/code/log", { path, ref });
    if (!res.ok) throw new Error(res.error || "git log failed");
    return res.commits;
  }
  // surface a failure in the app's error dialog (scrollable, styled) rather than a
  // native alert() — git errors like "already checked out at <worktree>" can be long
  _errorDialog(title, message) {
    this.dialogs.open({
      title,
      message,
      cls: "dialog-error",
      okLabel: "OK",
      cancelLabel: null
    });
  }
  async _mutate(label, fn, reload = true) {
    this.busy.set(true);
    try {
      await fn();
      if (reload) await this.load(true);
    } catch (e) {
      this._errorDialog(`${label} failed`, e.message);
    } finally {
      this.busy.set(false);
    }
  }
  // checkout the given {repo, path, branch} in each repo, then re-read branch state
  // for just those repos. A checkout only changes their local working tree, so we
  // refresh only them (merging into the view) and leave every other repo alone —
  // and PRs (keyed by head branch), runbot (by branch) and mergebot (by PR) are
  // unaffected, so we keep those from the cache (the dashboard lazily fills any new).
  async checkout(repos) {
    this.busy.set(true);
    try {
      const res = await postJSON("/api/code/checkout", { repos });
      const failed = (res.results || []).filter((r) => !r.ok);
      if (failed.length)
        this._errorDialog(
          "Checkout failed",
          failed.map((r) => `${r.branch}: ${r.error}`).join("\n")
        );
      const ids = new Set(repos.map((r) => r.repo).filter(Boolean));
      await (ids.size ? this.refreshBranches(ids) : this.load(false));
    } catch (e) {
      this._errorDialog("Checkout failed", e.message);
    } finally {
      this.busy.set(false);
    }
  }
  // fetch each repo's base branch from its canonical repo and rebase onto it, then
  // re-read branch state for just those repos. A rebase changes only their local
  // commits (head sha, ahead/behind, pushed-state), so we refresh only them; the PR
  // list / runbot / mergebot reflect the pushed branch, which a local rebase hasn't
  // touched, so we leave those as-is rather than re-querying everything.
  async rebase(repos) {
    this.busy.set(true);
    try {
      const res = await postJSON("/api/code/rebase", { repos });
      const failed = (res.results || []).filter((r) => !r.ok);
      if (failed.length) {
        for (const f of failed)
          this.eventLog.add(`fetch & rebase failed: ${f.repo} \u2014 ${f.error}`, "", "error");
        this._errorDialog(
          "Fetch & rebase failed",
          failed.map((r) => `${r.repo}: ${r.error}`).join("\n")
        );
      }
      const ids = new Set(repos.map((r) => r.repo).filter(Boolean));
      await (ids.size ? this.refreshBranches(ids) : this.load(true));
    } catch (e) {
      this.eventLog.add(`fetch & rebase failed: ${e.message}`, "", "error");
      this._errorDialog("Fetch & rebase failed", e.message);
    } finally {
      this.busy.set(false);
    }
  }
  // drop a branch from the view + cache without a server round-trip — a full
  // reload would re-fetch every branch's runbot badge, which is pointless here
  _dropBranch(repo, branch) {
    this.store.dropBranch(repo, branch);
    const cache = this._cache();
    if (cache) {
      const branchRepos = this.store.repoStatusList();
      localStorage.setItem(PRS_CACHE_KEY, JSON.stringify({ ...cache, branchRepos }));
    }
  }
  async deleteBranch(branch, repo, path, deleteRemote = false) {
    const scope = deleteRemote ? "locally and on the odoo-dev remote" : "locally";
    const ok = await this.dialogs.open({
      title: `Force-delete branch "${branch}" in ${repo}?`,
      message: `This deletes the branch ${scope}. This cannot be undone.`,
      okLabel: "Delete branch"
    });
    if (!ok) return;
    return this.deleteBranchNoConfirm(branch, repo, path, deleteRemote);
  }
  // delete a branch without prompting — the caller has already confirmed (e.g.
  // a single confirmation dialog covering several branches / PRs at once)
  deleteBranchNoConfirm(branch, repo, path, deleteRemote = false) {
    return this._mutate(
      "Delete",
      async () => {
        this.eventLog.add(`deleting branch ${branch} (${repo})`);
        const res = await postJSON("/api/code/branches/delete", {
          path,
          branch,
          delete_remote: deleteRemote
        });
        if (res.remote_error)
          this.dialogs.open({
            title: "Remote branch not deleted",
            message: `The local branch was deleted, but the remote branch could not be removed:

${res.remote_error}`,
            cls: "dialog-error",
            okLabel: "OK",
            cancelLabel: null
          });
        this._dropBranch(repo, branch);
      },
      false
    );
  }
  // create one or more branches in parallel (each at its own start point) without
  // checking any out, then re-read branch state for just the affected repos. Creating
  // a local branch never touches PRs/runbot/mergebot, so we skip that whole refresh
  // (the slow part) and never run the per-branch creates back-to-back.
  // specs: [{ path, name, startPoint }]
  async createBranches(specs) {
    const repoByPath = new Map(this.config.config.repos.map((r) => [r.path, r]));
    const branches = (specs || []).filter((s) => s.path && s.name && repoByPath.has(s.path)).map((s) => ({ path: s.path, name: s.name, start_point: s.startPoint }));
    if (!branches.length) return;
    this.busy.set(true);
    try {
      for (const b of branches) {
        const repo = repoByPath.get(b.path);
        this.eventLog.add(`creating branch ${b.name}${repo ? ` (${repo.id})` : ""}`);
      }
      const res = await postJSON("/api/code/branches/create", { branches });
      const failed = (res.results || []).filter((r) => !r.ok);
      if (failed.length)
        this._errorDialog(
          "Create branch failed",
          failed.map((r) => `${r.name}: ${r.error}`).join("\n")
        );
      const ids = new Set(branches.map((b) => repoByPath.get(b.path).id));
      await this.refreshBranches(ids);
    } catch (e) {
      this._errorDialog("Create branch failed", e.message);
    } finally {
      this.busy.set(false);
    }
  }
  // create a single branch at <startPoint> without checking it out
  createBranch(path, name, startPoint) {
    return this.createBranches([{ path, name, startPoint }]);
  }
  // optimistically mark a PR closed in the view, no reload (which would re-fetch
  // everything just to flip one PR's state). The server already invalidated its PR
  // cache in close_pr, so the next load reflects it too.
  _closePrLocally(github, number) {
    this.store.closePr(github, number);
  }
  async closePr(github, number) {
    const ok = await this.dialogs.open({
      title: `Close PR #${number} in ${github}?`,
      okLabel: "Close PR"
    });
    if (!ok) return;
    return this.closePrNoConfirm(github, number);
  }
  // close a PR without prompting — caller has already confirmed
  closePrNoConfirm(github, number) {
    return this._mutate(
      "Close PR",
      async () => {
        this.eventLog.add(`closing PR #${number} (${github})`);
        await postJSON("/api/prs/close", { repo: github, number });
        this._closePrLocally(github, number);
      },
      false
    );
  }
  // commit / discard the working tree. On failure the event log records the
  // failure and the error is surfaced in a (scrollable) dialog — opened by the
  // plugin itself via the DialogPlugin, no component involvement needed.
  // open a repo's working directory in the configured editor (default "code");
  // no git mutation, so no busy/reload — just fire the launch (only failures log)
  openEditor(path, repo) {
    return this.openEditorPaths([path], repo);
  }
  // open one or more repo folders in the configured editor — passing several dirs
  // opens them in a single window (`code repo1 repo2`). `label` names them in logs.
  async openEditorPaths(paths, label) {
    const editor = (this.config.config.editor || "code").trim();
    try {
      await postJSON("/api/open-editor", { editor, paths });
    } catch (e) {
      this.eventLog.add(`open with editor failed (${label}): ${e.message}`, "", "error");
      this.dialogs.open({
        title: "Could not open the editor",
        message: e.message,
        cls: "dialog-error",
        okLabel: "OK",
        cancelLabel: null
      });
    }
  }
  async wipCommit(path, repo) {
    this.busy.set(true);
    try {
      this.eventLog.add(`WIP commit (${repo})`);
      await postJSON("/api/code/wip-commit", { path });
      await this.refreshBranches(/* @__PURE__ */ new Set([repo]));
    } catch (e) {
      this.eventLog.add(`WIP commit failed (${repo})`);
      this.dialogs.open({
        title: "WIP commit failed",
        message: e.message,
        cls: "dialog-error",
        okLabel: "OK",
        cancelLabel: null
      });
    } finally {
      this.busy.set(false);
    }
  }
  async discard(path, repo) {
    const ok = await this.dialogs.open({
      title: `Discard changes in ${repo}?`,
      message: "This permanently removes all uncommitted changes, including untracked files. This cannot be undone.",
      okLabel: "Discard changes"
    });
    if (!ok) return;
    this.busy.set(true);
    try {
      this.eventLog.add(`discarding changes (${repo})`);
      await postJSON("/api/code/discard", { path });
      await this.refreshBranches(/* @__PURE__ */ new Set([repo]));
    } catch (e) {
      this.eventLog.add(`discard failed (${repo})`);
      this.dialogs.open({
        title: "Discard changes failed",
        message: e.message,
        cls: "dialog-error",
        okLabel: "OK",
        cancelLabel: null
      });
    } finally {
      this.busy.set(false);
    }
  }
  // push a branch to the dev remote without prompting — caller has confirmed
  // (via the app modal) before calling
  pushBranchNoConfirm(path, branch, reload = true, force = false) {
    const repo = this.config.config.repos.find((r) => r.path === path);
    return this._mutate(
      force ? "Force push" : "Push",
      async () => {
        const verb = force ? "force-pushing" : "pushing";
        this.eventLog.add(`${verb} ${branch}${repo ? ` (${repo.id})` : ""} to GitHub`);
        await postJSON("/api/code/branch/push", { path, branch, force });
        if (reload && repo) await this.refreshBranches(/* @__PURE__ */ new Set([repo.id]));
      },
      false
      // never the _mutate full reload — refreshBranches above is enough
    );
  }
};

// static/src/core/log_buffer.js
var MAX_LINES = 2e3;
var LogBuffer = class {
  constructor() {
    this.el = document.createElement("div");
    this.el.className = "log-scroll";
    this.count = signal(0);
    this.autoScroll = signal(true);
    this.savedScroll = 0;
    this._scrollQueued = false;
    this._lastTop = 0;
    this.el.addEventListener("scroll", () => {
      const top = this.el.scrollTop;
      const atBottom = top + this.el.clientHeight >= this.el.scrollHeight - 4;
      if (atBottom) {
        if (!this.autoScroll()) this.autoScroll.set(true);
      } else if (top < this._lastTop - 4) {
        if (this.autoScroll()) this.autoScroll.set(false);
      }
      this._lastTop = top;
    });
  }
  // `id` (optional) tags the row's DOM element so callers can scroll/link to it
  append(line, id) {
    const row = buildLogRow(line);
    if (id) row.id = id;
    this.el.appendChild(row);
    while (this.el.childElementCount > MAX_LINES) this.el.firstElementChild.remove();
    this.count.set(this.el.childElementCount);
    if (this.autoScroll()) this._queueScroll();
  }
  // Coalesce tail-following into one scroll per animation frame. Calling
  // toBottom() on every appended line interleaves a scrollHeight read with each
  // DOM mutation, forcing a synchronous reflow per line (layout thrashing). A
  // burst of appends now triggers a single reflow on the next frame instead.
  _queueScroll() {
    if (this._scrollQueued) return;
    this._scrollQueued = true;
    requestAnimationFrame(() => {
      this._scrollQueued = false;
      if (this.autoScroll()) this.toBottom();
    });
  }
  clear() {
    this.el.replaceChildren();
    this.count.set(0);
  }
  toBottom() {
    this.el.scrollTop = this.el.scrollHeight;
    this._lastTop = this.el.scrollTop;
  }
  // called by the host console on (re)mount to restore the scroll position,
  // since detaching the element resets scrollTop
  restore() {
    if (this.autoScroll()) this.toBottom();
    else this.el.scrollTop = this.savedScroll;
    this._lastTop = this.el.scrollTop;
  }
};

// static/src/core/server_plugin.js
var ServerPlugin = class extends Plugin {
  static sequence = 2;
  config = plugin(ConfigPlugin);
  store = plugin(StorePlugin);
  // the shared store — the main odoo lives in servers["main"]
  eventLog = plugin(EventLogPlugin);
  code = plugin(CodePlugin);
  dialogs = plugin(DialogPlugin);
  // optimistic in-flight action, for immediate button feedback in the gap between
  // a click and the first real status event: "start" | "stop" | "restart" | ""
  pending = signal("");
  now = signal(Date.now());
  output = new LogBuffer();
  // the persistent server-log element
  lineListeners = /* @__PURE__ */ new Set();
  // tests/addons mirror lines from here
  gooUpdateListeners = /* @__PURE__ */ new Set();
  // UpdatePlugin refreshes the navbar badge from here
  worktreeListeners = /* @__PURE__ */ new Set();
  // WorktreePlugin updates per-worktree state from here
  worktreeLogListeners = /* @__PURE__ */ new Set();
  // WorktreePlugin streams per-worktree logs from here
  claudeListeners = /* @__PURE__ */ new Set();
  // ClaudePlugin appends per-worktree chat items from here
  _startEid = null;
  // pending "starting server" timed event, resolved on the green dot
  // the active target (last started or activated), server-persisted + reactive. The
  // backend reads it from its own config for `goo --test-tags` (no client mirror).
  activeTarget = signal(this.config.getState("active_target", ""));
  setup() {
    setInterval(() => this.now.set(Date.now()), 1e3);
    this._connect();
  }
  // the main odoo's live snapshot — servers["main"], fed by the "server" SSE event
  // ("stopped" until the first one lands). The ~40 status() reads app-wide are unchanged.
  status() {
    return this.store.server("main") || { state: "stopped" };
  }
  onLine(cb) {
    this.lineListeners.add(cb);
    return () => this.lineListeners.delete(cb);
  }
  onGooUpdate(cb) {
    this.gooUpdateListeners.add(cb);
    return () => this.gooUpdateListeners.delete(cb);
  }
  onWorktree(cb) {
    this.worktreeListeners.add(cb);
    return () => this.worktreeListeners.delete(cb);
  }
  onWorktreeLog(cb) {
    this.worktreeLogListeners.add(cb);
    return () => this.worktreeLogListeners.delete(cb);
  }
  onClaude(cb) {
    this.claudeListeners.add(cb);
    return () => this.claudeListeners.delete(cb);
  }
  log(line) {
    this.output.append(line);
    for (const cb of this.lineListeners) cb(line);
  }
  _connect() {
    const es = new EventSource("/api/events");
    es.onopen = () => this.output.clear();
    es.onerror = () => this.store.mergeServer({ id: "main", state: "disconnected" });
    es.addEventListener("server", (e) => {
      const snap = JSON.parse(e.data);
      if (snap.id === "main") {
        const prev = this.status();
        this.store.mergeServer(snap);
        this.pending.set("");
        this._resolveStartEvent(prev, this.status());
      } else {
        this.store.mergeServer(snap);
        for (const cb of this.worktreeListeners) cb(snap);
      }
    });
    es.addEventListener("run", (e) => this.store.mergeRun(JSON.parse(e.data)));
    es.addEventListener("log", (e) => this.log(JSON.parse(e.data).line));
    es.addEventListener("config", (e) => {
      const d = JSON.parse(e.data);
      this.config.applyBroadcast(d);
      const at = (d.state || {}).active_target;
      if (at !== void 0 && at !== this.activeTarget()) this.activeTarget.set(at);
    });
    es.addEventListener("event", (e) => {
      const d = JSON.parse(e.data);
      if (d.status === "start") this.eventLog.start(d.id, d.text, d.level || "");
      else if (d.status === "done" || d.status === "error")
        this.eventLog.finish(d.id, d.status, d.text, d.level || "");
      else this.eventLog.add(d.text, "", d.level || "");
    });
    es.addEventListener("goo_update", (e) => {
      const d = JSON.parse(e.data);
      for (const cb of this.gooUpdateListeners) cb(d);
    });
    es.addEventListener("worktree_log", (e) => {
      const d = JSON.parse(e.data);
      for (const cb of this.worktreeLogListeners) cb(d);
    });
    es.addEventListener("claude", (e) => {
      const d = JSON.parse(e.data);
      for (const cb of this.claudeListeners) cb(d);
    });
  }
  // an override bundle for a thin launch request — only the bits that differ from the
  // target's stored config (the server resolves the rest from its own config)
  _overrides(otherArgs) {
    return otherArgs == null ? {} : { other_args: otherArgs };
  }
  _hasTarget(targetId) {
    return !!this.config.config.targets.find((t2) => t2.id === targetId);
  }
  // fetch the live status once, synchronously, before the first render — the SSE
  // delivers it too, but only after connecting, which leaves a "stopped" flash
  // (Start → Stop) on a reload of an already-running server. Await this in the
  // app's onWillStart. Best-effort: on failure the SSE still fills it in shortly.
  async loadStatus() {
    try {
      const res = await fetch("/api/status");
      if (res.ok) this.store.mergeServer(await res.json());
    } catch {
    }
  }
  lastTarget() {
    return this.activeTarget();
  }
  // the state the UI should reflect: an optimistic "start" click reads as
  // "starting" before the backend confirms, so the navbar dot and the favicon
  // flip the instant the button is pressed (and stay in lockstep with each other)
  displayState() {
    return this.pending() === "start" ? "starting" : this.status().state;
  }
  _targetName(id) {
    return this.config.config.targets.find((t2) => t2.id === id)?.name || id;
  }
  setLastTarget(id) {
    this.activeTarget.set(id);
    this.config.setState("active_target", id);
  }
  // the command that would launch this target (built by the backend); "" if invalid
  async previewCommand(targetId, otherArgs) {
    if (!this._hasTarget(targetId)) return "";
    try {
      const res = await postJSON("/api/command", {
        target: targetId,
        overrides: this._overrides(otherArgs)
      });
      return res.cmd;
    } catch (e) {
      return `# ${e.message}`;
    }
  }
  async _run(path, body, label) {
    try {
      await postJSON(path, body);
    } catch (e) {
      this._failStart();
      this.log(`[goo] ${label} failed: ${e.message}`);
      this.eventLog.add(`${label} failed: ${e.message}`, "", "error");
      this.dialogs.open({
        title: `Could not ${label} the server`,
        message: e.message,
        cls: "dialog-error",
        okLabel: "OK",
        cancelLabel: null
      });
    }
  }
  // The "starting server" line is a timed event: it shows an animated "..." right
  // away (logged before the branch-confirm load, so there's no delay) and resolves
  // to "ok" once the server reports "running" (the green dot) — or "failed" if it
  // never gets there. A new start supersedes any still-pending one.
  _beginStart(text) {
    if (this._startEid) this.eventLog.drop(this._startEid);
    this._startEid = this.eventLog.begin(text);
  }
  _cancelStart() {
    if (this._startEid) this.eventLog.drop(this._startEid);
    this._startEid = null;
    this.pending.set("");
  }
  _failStart() {
    if (this._startEid) this.eventLog.finish(this._startEid, "error");
    this._startEid = null;
    this.pending.set("");
  }
  // drive the pending start event off the live status: "ok" when it enters
  // "running", "failed" if the process exits before getting there
  _resolveStartEvent(prev, s) {
    if (!this._startEid) return;
    if (s.state === "running" && prev.state !== "running") {
      this.eventLog.finish(this._startEid, "done");
      this._startEid = null;
    } else if (s.state === "stopped" && s.exited_unexpectedly) {
      this._failStart();
    }
  }
  // the server launches whatever branches are currently checked out (the target's
  // branches aren't sent to the backend). If they don't match the target, ask the
  // user to confirm — starting with different branches is a valid use case.
  // Returns true to proceed, false if the user cancelled.
  async _confirmBranches(targetId) {
    const target = this.config.config.targets.find((t2) => t2.id === targetId);
    if (!target) return true;
    await this.code.loadBranches(new Set((target.checkouts || []).map((c) => c.repo)));
    const off = this.store.targetView(target).checkouts.filter((c) => c.current !== void 0 && !c.matches);
    if (!off.length) return true;
    const lines = off.map(({ repo, branch, current }) => `${repo}: on "${current}" \u2014 target wants "${branch}"`).join("\n");
    const ok = await this.dialogs.open({
      title: "Branches don't match this target",
      message: `The checked-out branches differ from "${this._targetName(targetId)}":

${lines}

Start with the current branches anyway?`,
      okLabel: "Start anyway",
      cancelLabel: "Cancel"
    });
    return !!ok;
  }
  async start(targetId, otherArgs) {
    if (!this._hasTarget(targetId)) return this.log(`[goo] no such target: "${targetId}"`);
    this.pending.set("start");
    this._beginStart(`starting server (target: ${this._targetName(targetId)})`);
    if (!await this._confirmBranches(targetId)) return this._cancelStart();
    this.setLastTarget(targetId);
    await this._run(
      "/api/start",
      { target: targetId, overrides: this._overrides(otherArgs) },
      "start"
    );
  }
  async restart(targetId, otherArgs) {
    if (!this._hasTarget(targetId)) return;
    this.pending.set("restart");
    this._beginStart(`restarting server (target: ${this._targetName(targetId)})`);
    if (!await this._confirmBranches(targetId)) return this._cancelStart();
    this.setLastTarget(targetId);
    await this._run(
      "/api/restart",
      { target: targetId, overrides: this._overrides(otherArgs) },
      "restart"
    );
  }
  // re-start the server on the last target (e.g. DatabasePlugin stops it for a db op,
  // then resumes). The backend rebuilds the launch config from the target id.
  async resume() {
    const targetId = this.lastTarget();
    if (!this._hasTarget(targetId)) return;
    this._beginStart(`restarting server (target: ${this._targetName(targetId)})`);
    await this._run("/api/start", { target: targetId, overrides: {} }, "resume");
  }
  async stop() {
    this.pending.set("stop");
    this.eventLog.add("stopping server");
    await this._run("/api/stop", void 0, "stop");
  }
  // resolve true once the server reports "running", false on timeout
  waitUntilRunning(timeout = 9e4) {
    return new Promise((resolve) => {
      if (this.status().state === "running") return resolve(true);
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (this.status().state === "running") {
          clearInterval(iv);
          resolve(true);
        } else if (Date.now() - t0 > timeout) {
          clearInterval(iv);
          resolve(false);
        }
      }, 300);
    });
  }
};

// static/src/core/config_models.js
function withScope(rec, fn) {
  const ctx = rec.orm._ctx;
  return ctx ? ctx.run(fn) : fn();
}
var SETTINGS_CHARS = [
  "work_dir",
  "venv_activate",
  "server_path",
  "worktree_dir",
  "db_user",
  "db_password",
  "filestore",
  "editor"
];
var SETTINGS_BOOLS = ["auto_open_event_log", "update_check", "rust_bundler"];
var SETTINGS_JSON = ["start", "tabs", "links", "test_presets"];
var STATE_CHARS = ["active_target", "claude_model"];
var STATE_JSON = ["test_history", "reviews_favorites", "reviews_merged", "reviews_no_mergebot"];
var Settings = class extends Model {
  static id = "settings";
  // singleton
  work_dir = fields.char();
  venv_activate = fields.char();
  server_path = fields.char();
  worktree_dir = fields.char();
  db_user = fields.char();
  db_password = fields.char();
  filestore = fields.char();
  editor = fields.char();
  auto_open_event_log = fields.bool();
  update_check = fields.bool();
  rust_bundler = fields.bool();
  start = fields.json();
  tabs = fields.json();
  links = fields.json();
  test_presets = fields.json();
};
var Repository = class extends Model {
  static id = "repository";
  path = fields.char();
  github = fields.char();
  favorite = fields.bool();
  external = fields.bool();
  autoreload = fields.bool();
  checkouts = fields.one2many({ comodel: () => Checkout, inverse: "repository" });
  // the canonical GitHub slug — the stored value, else the built-in default for this id
  githubOrDefault() {
    return this.github() || DEFAULT_CONFIG.repos.find((d) => d.id === this.id)?.github || "";
  }
  compareUrl(branch) {
    return repoUrls.compare(this.githubOrDefault(), branch);
  }
  forkBranchUrl(branch) {
    return repoUrls.fork(this.githubOrDefault(), branch);
  }
  remoteBranchUrl(branch) {
    return repoUrls.remote(this.githubOrDefault(), branch);
  }
  mergebotUrl(number) {
    return repoUrls.mergebot(this.githubOrDefault(), number);
  }
};
var repoUrls = {
  // GitHub "create PR" compare page for a work branch (base inferred from the name)
  compare(github, branch) {
    const base = (/^(saas-\d+\.\d+|\d+\.\d+|master)/.exec(branch) || ["", "master"])[1];
    const name = github.split("/")[1];
    return `https://github.com/${github}/compare/${base}...odoo-dev:${name}:${branch}?expand=1`;
  },
  // the branch on the odoo-dev fork
  fork(github, branch) {
    const name = github.split("/")[1];
    return `https://github.com/odoo-dev/${name}/tree/${encodeURIComponent(branch)}`;
  },
  // where a branch lives remotely: base branches on the canonical repo, work branches on the fork
  remote(github, branch) {
    if (BASE_BRANCH_RE.test(branch)) {
      return `https://github.com/${github}/tree/${encodeURIComponent(branch)}`;
    }
    return repoUrls.fork(github, branch);
  },
  // the mergebot page for one of this repo's PRs
  mergebot(github, number) {
    return `${MERGEBOT}/${github}/pull/${number}`;
  }
};
var Target = class extends Model {
  static id = "target";
  name = fields.char();
  favorite = fields.bool();
  db = fields.char();
  on_create_args = fields.char();
  demo_data = fields.bool({ defaultValue: true });
  kind = fields.char({ defaultValue: "plain" });
  worktree = fields.json();
  // { base, dir } | null — only worktree targets
  checkouts = fields.one2many({ comodel: () => Checkout, inverse: "target" });
  // ── derivations (pure — this + this.orm) ─────────────────────────────────────
  // "repo:branch, …" — the human-readable checkout list
  checkoutsLabel() {
    return this.checkouts().map((c) => `${c.repository().id}:${c.branch()}`).join(", ");
  }
  // the explicit `kind` marks a worktree, falling back to `worktree` metadata presence
  isWorktree() {
    return (this.kind() || (this.worktree() ? "worktree" : "plain")) === "worktree";
  }
  hasCommunity() {
    return this.checkouts().some((c) => c.repository().id === "community");
  }
  // the repo ids this target checks out
  repoIds() {
    return this.checkouts().map((c) => c.repository().id);
  }
  // the worktree's on-disk directory: the value frozen at creation (worktree.dir),
  // else derived from <settings.worktree_dir>/<name>. Persisting it means a later
  // rename can't move the path off the real checkout (worktreeDirFor, utils.js).
  dirPath() {
    const dir = this.worktree()?.dir;
    if (dir) return dir;
    const settings = this.orm.getById(Settings, "settings");
    return worktreeDirFor(settings?.worktree_dir(), { name: this.name(), id: this.id });
  }
  // ── mutations (edit records, persist via ConfigPlugin's existing save wire) ───
  _configPlugin() {
    return withScope(this, () => plugin(ConfigPlugin));
  }
  toggleFavorite() {
    this.favorite.set(!this.favorite());
    this._configPlugin().touch();
  }
  toggleDemoData() {
    this.demo_data.set(!this.demo_data());
    this._configPlugin().touch();
  }
  // commit an inline edit onto the target (favorite/demo_data untouched — each is
  // toggled directly via its own checkbox).
  // The caller validates; checkouts arrive already parsed as [{repo, branch}].
  applyEdit({ name, checkouts, db, on_create_args }) {
    this.name.set(name);
    this.db.set(db);
    this.on_create_args.set(on_create_args);
    reconcileCheckouts(this.orm, { id: this.id, checkouts });
    this._configPlugin().touch();
  }
  // ── action: stop the server, switch to this target, check out its branches ────
  async activate() {
    const { server, code, eventLog } = withScope(this, () => ({
      server: plugin(ServerPlugin),
      code: plugin(CodePlugin),
      eventLog: plugin(EventLogPlugin)
    }));
    const repoMap = {};
    for (const r of code.branchRepos()) {
      repoMap[r.id] = {
        current: r.current,
        dirty: r.dirty,
        branches: new Set((r.branches || []).map((b) => b.name))
      };
    }
    const cos = this.checkouts().map((c) => ({ repo: c.repository().id, branch: c.branch() }));
    const s = server.status();
    const activeId = s.state === "running" || s.state === "starting" ? s.target : server.lastTarget();
    if (this.id === activeId) return;
    if (!cos.every(({ repo, branch }) => repoMap[repo]?.branches.has(branch))) return;
    if (cos.some(({ repo }) => repoMap[repo]?.dirty)) return;
    const pathByRepo = code.groups().pathByRepo;
    const repos = cos.map(({ repo, branch }) => ({ repo, path: pathByRepo[repo], branch })).filter((r) => r.path);
    const switched = repos.filter((r) => repoMap[r.repo]?.current !== r.branch);
    eventLog.add(`activating target ${this.name()}`);
    for (const r of switched) eventLog.add(`checking out ${r.branch} (${r.repo})`);
    const stopping = s.state === "running" || s.state === "starting" ? server.stop() : null;
    await Promise.all([stopping, code.checkout(repos)]);
    server.setLastTarget(this.id);
  }
};
var Checkout = class extends Model {
  static id = "checkout";
  // id = `${target}:${repo}` — the join formerly mis-named target.config
  target = fields.many2one({ comodel: () => Target, inverse: "checkouts" });
  repository = fields.many2one({ comodel: () => Repository, inverse: "checkouts" });
  branch = fields.char();
};
var AppState = class extends Model {
  static id = "appstate";
  // singleton — the app-recorded state blob
  active_target = fields.char();
  claude_model = fields.char();
  test_history = fields.json();
  reviews_favorites = fields.json();
  reviews_merged = fields.json();
  reviews_no_mergebot = fields.json();
};
var CONFIG_MODELS = [Settings, Repository, Target, Checkout, AppState];
var checkoutId = (targetId, repo) => `${targetId}:${repo}`;
function toModels(orm, config = {}, state = {}) {
  const settings = { id: "settings" };
  for (const k of SETTINGS_CHARS) settings[k] = config[k] ?? "";
  for (const k of SETTINGS_BOOLS) settings[k] = !!config[k];
  settings.start = config.start ?? {};
  settings.tabs = config.tabs ?? [];
  settings.links = config.links ?? [];
  settings.test_presets = config.test_presets ?? [];
  orm.create(Settings, settings);
  for (const r of config.repos || []) createRepo(orm, r);
  for (const t2 of config.targets || []) createTarget(orm, t2);
  const st = { id: "state" };
  for (const k of STATE_CHARS) st[k] = state[k] ?? "";
  for (const k of STATE_JSON) st[k] = state[k] ?? [];
  orm.create(AppState, st);
}
function repoData(r) {
  return {
    id: r.id,
    path: r.path ?? "",
    github: r.github ?? "",
    favorite: !!r.favorite,
    external: !!r.external,
    autoreload: !!r.autoreload
  };
}
function createRepo(orm, r) {
  orm.create(Repository, repoData(r));
}
function targetData(t2) {
  return {
    id: t2.id,
    name: t2.name ?? "",
    favorite: !!t2.favorite,
    db: t2.db ?? "",
    on_create_args: t2.on_create_args ?? "",
    demo_data: t2.demo_data ?? true,
    kind: t2.kind || "plain",
    worktree: t2.worktree ?? null
  };
}
function createTarget(orm, t2) {
  orm.create(Target, targetData(t2));
  for (const c of t2.checkouts || []) {
    orm.create(Checkout, {
      id: checkoutId(t2.id, c.repo),
      target: t2.id,
      repository: c.repo,
      branch: c.branch ?? ""
    });
  }
}
function toConfig(orm) {
  const s = orm.getById(Settings, "settings");
  const out = {};
  if (s) {
    for (const k of SETTINGS_CHARS) out[k] = s[k]();
    for (const k of SETTINGS_BOOLS) out[k] = s[k]();
    out.start = s.start() ?? {};
    out.tabs = s.tabs() ?? [];
    out.links = s.links() ?? [];
    out.test_presets = s.test_presets() ?? [];
  }
  out.repos = orm.records(Repository).map((r) => ({
    id: r.id,
    path: r.path(),
    github: r.github(),
    favorite: r.favorite(),
    external: r.external(),
    autoreload: r.autoreload()
  }));
  out.targets = orm.records(Target).map((t2) => {
    const tgt = {
      id: t2.id,
      name: t2.name(),
      favorite: t2.favorite(),
      db: t2.db(),
      on_create_args: t2.on_create_args(),
      demo_data: t2.demo_data(),
      kind: t2.kind(),
      checkouts: t2.checkouts().map((c) => ({ repo: c.repository().id, branch: c.branch() }))
    };
    const wt = t2.worktree();
    if (wt) tgt.worktree = wt;
    return tgt;
  });
  return out;
}
function toState(orm) {
  const st = orm.getById(AppState, "state");
  if (!st) return {};
  const out = {};
  for (const k of STATE_CHARS) out[k] = st[k]();
  for (const k of STATE_JSON) out[k] = st[k]();
  return out;
}
function applyPatch(orm, patch) {
  const s = orm.getById(Settings, "settings");
  if (s) {
    for (const k of [...SETTINGS_CHARS, ...SETTINGS_BOOLS, ...SETTINGS_JSON]) {
      if (k in patch) s[k].set(patch[k]);
    }
  }
  if ("repos" in patch) reconcileRepos(orm, patch.repos || []);
  if ("targets" in patch) reconcileTargets(orm, patch.targets || []);
}
function reconcile(orm, Cls, desired, keyOf, update, create) {
  const have = new Map(orm.records(Cls).map((rec) => [rec.id, rec]));
  const keep = /* @__PURE__ */ new Set();
  for (const item of desired) {
    const id = keyOf(item);
    keep.add(id);
    const rec = have.get(id);
    if (rec) update(rec, item);
    else create(orm, item);
  }
  for (const [id, rec] of have) if (!keep.has(id)) orm.delete(rec);
}
function reconcileRepos(orm, repos) {
  reconcile(
    orm,
    Repository,
    repos,
    (r) => r.id,
    (rec, r) => {
      const d = repoData(r);
      for (const k of ["path", "github", "favorite", "external", "autoreload"]) rec[k].set(d[k]);
    },
    createRepo
  );
}
function reconcileTargets(orm, targets) {
  reconcile(
    orm,
    Target,
    targets,
    (t2) => t2.id,
    (rec, t2) => {
      const d = targetData(t2);
      for (const k of [
        "name",
        "favorite",
        "db",
        "on_create_args",
        "demo_data",
        "kind",
        "worktree"
      ]) {
        rec[k].set(d[k]);
      }
      reconcileCheckouts(orm, t2);
    },
    (o, t2) => createTarget(o, t2)
  );
  const liveTargets = new Set(targets.map((t2) => t2.id));
  for (const c of orm.records(Checkout)) {
    const tgt = c.target();
    if (!tgt || !liveTargets.has(tgt.id)) orm.delete(c);
  }
}
function reconcileCheckouts(orm, t2) {
  const desired = (t2.checkouts || []).map((c) => ({
    id: checkoutId(t2.id, c.repo),
    repo: c.repo,
    branch: c.branch ?? ""
  }));
  const have = new Map(
    orm.records(Checkout).filter((c) => c.target()?.id === t2.id).map((c) => [c.id, c])
  );
  const keep = /* @__PURE__ */ new Set();
  for (const c of desired) {
    keep.add(c.id);
    const rec = have.get(c.id);
    if (rec) rec.branch.set(c.branch);
    else orm.create(Checkout, { id: c.id, target: t2.id, repository: c.repo, branch: c.branch });
  }
  for (const [id, rec] of have) if (!keep.has(id)) orm.delete(rec);
}

// static/src/core/config_plugin.js
var STATE_KEYS = {
  "oo-last-target": "active_target",
  "oo-test-history": "test_history",
  "oo-reviews-merged": "reviews_merged",
  "oo-reviews-no-mergebot": "reviews_no_mergebot",
  "oo-reviews-favorites": "reviews_favorites",
  "oo-claude-model": "claude_model"
};
function newTargetId() {
  return crypto.randomUUID ? crypto.randomUUID() : `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function slugId(name, used) {
  const base = (name || "target").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "target";
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
  return id;
}
function tryParse(v) {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}
function migrateConfigState(config, state) {
  config = { ...config || {} };
  state = { ...state || {} };
  if (Array.isArray(config.targets)) {
    const stale = (t2) => !t2.id || t2.config !== void 0 || !t2.kind || t2.worktree && !t2.worktree.dir;
    if (config.targets.some(stale)) {
      const worktreeDir = config.worktree_dir ?? DEFAULT_CONFIG.worktree_dir;
      const used = new Set(config.targets.map((t2) => t2.id).filter(Boolean));
      config.targets = config.targets.map((t2) => {
        const { config: checkoutList, ...rest } = t2;
        const id = t2.id || slugId(t2.name, used);
        used.add(id);
        const worktree = t2.worktree ? { ...t2.worktree, dir: t2.worktree.dir ?? worktreeDirFor(worktreeDir, { ...t2, id }) } : t2.worktree;
        return {
          ...rest,
          id,
          checkouts: t2.checkouts ?? checkoutList ?? [],
          kind: t2.kind ?? (t2.worktree ? "worktree" : "plain"),
          ...worktree ? { worktree } : {}
        };
      });
    }
  }
  const at = state.active_target;
  if (at && Array.isArray(config.targets) && !config.targets.some((t2) => t2.id === at)) {
    const byName = config.targets.find((t2) => t2.name === at);
    if (byName) state.active_target = byName.id;
  }
  return { config, state };
}
var _boot = null;
function merge(config) {
  return { ...DEFAULT_CONFIG, ...config || {} };
}
async function loadServerConfig() {
  let payload = null;
  try {
    const resp = await fetch("/api/config");
    payload = await resp.json();
  } catch {
  }
  if (payload && payload.ok && payload.config) {
    _boot = { rev: payload.rev, config: payload.config, state: payload.state || {} };
    return;
  }
  const rev = payload && payload.ok ? payload.rev : 0;
  const adopted = adoptFromLocalStorage();
  const { config, state } = migrateConfigState(adopted.config, adopted.state);
  try {
    const resp = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rev, config, state })
    });
    const res = await resp.json();
    _boot = { rev: res.rev, config: res.config ?? config, state: res.state ?? state };
  } catch {
    _boot = { rev, config, state };
  }
}
function adoptFromLocalStorage() {
  let config;
  try {
    config = JSON.parse(localStorage.getItem("oo-config"));
  } catch {
    config = null;
  }
  config = merge(config);
  const state = {};
  for (const [key, field] of Object.entries(STATE_KEYS)) {
    const v = localStorage.getItem(key);
    if (v !== null) state[field] = tryParse(v);
  }
  return { config, state };
}
function presetToConfigState(preset) {
  const data = preset.data || {};
  let overrides = {};
  if (data["oo-config"]) {
    try {
      overrides = JSON.parse(data["oo-config"]);
    } catch {
    }
  }
  const state = {};
  for (const [key, field] of Object.entries(STATE_KEYS)) {
    if (data[key] !== void 0) state[field] = tryParse(data[key]);
  }
  return migrateConfigState(merge(overrides), state);
}
var ConfigPlugin = class extends Plugin {
  static sequence = 1;
  // everything else may depend on config
  _b = _boot || { rev: 0, config: {}, state: {} };
  orm = this._seedOrm();
  // the config graph as owl-orm records (config_models.js)
  rev = signal(this._b.rev);
  // server revision — guards concurrent writes
  // the flat config blob, derived from the ORM records — recomputed only when a
  // record changes, so the ~72 `config.config.*` consumers stay reactive + cheap
  _configView = computed(() => merge(toConfig(this.orm)));
  _dirty = { config: false, state: false };
  // blobs edited since the last flush
  _timer = null;
  // seed a fresh ORM from the boot payload (field initializer, so config + state are
  // populated the moment the plugin is constructed — other plugins' field inits read
  // getState right after `plugin(ConfigPlugin)` returns)
  _seedOrm() {
    const orm = new ORM();
    toModels(orm, merge(this._b.config), this._b.state || {});
    return orm;
  }
  // clear + re-seed the ORM in place (reset / preset / import / another tab's write).
  // Mutating the existing ORM — not replacing it — keeps `_configView` tracking it.
  _reload(config, state) {
    for (const M of CONFIG_MODELS) for (const rec of this.orm.records(M)) this.orm.delete(rec);
    toModels(this.orm, merge(config), state || {});
  }
  get config() {
    return this._configView();
  }
  // ── config writes ──────────────────────────────────────────────────────────
  // merge a patch into the config and persist it. Optimistic: the records update now,
  // the POST is debounced/coalesced (see _schedule). ~20 callers across the Config and
  // Targets UIs — their call sites are unchanged.
  updateConfig(patch) {
    applyPatch(this.orm, patch);
    this._dirty.config = true;
    this._schedule();
  }
  // persist a model-driven edit (a Target/Repository method mutated its own record)
  // through the same debounced, rev-checked save — the record already reflects it.
  touch() {
    this._dirty.config = true;
    this._schedule();
  }
  // record accessors, so consumers holding an id can call the models' own methods
  target(id) {
    return this.orm.getById(Target, id);
  }
  repoByGithub(github) {
    return this.orm.records(Repository).find((r) => r.githubOrDefault() === github) || null;
  }
  // ── app-state (the AppState singleton record) ────────────────────────────────
  getState(field, fallback = null) {
    const st = this.orm.getById(AppState, "state");
    const v = st && st[field] ? st[field]() : void 0;
    return v === void 0 || v === null ? fallback : v;
  }
  setState(field, value) {
    const st = this.orm.getById(AppState, "state");
    if (st && st[field]) st[field].set(value);
    this._dirty.state = true;
    this._schedule();
  }
  // ── server sync ──────────────────────────────────────────────────────────────
  _schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._flush(), 250);
  }
  // POST whatever changed since the last flush, rev-checked. On a stale rev (another
  // tab wrote), adopt the server's rev and retry so our edit lands on top
  // (last-write-wins — fine for a single user); bounded so a pathological loop can't
  // hang. Clears the dirty flags optimistically and re-sets them on failure/conflict.
  async _flush(tries = 0) {
    if (!this._dirty.config && !this._dirty.state) return;
    const sent = { ...this._dirty };
    this._dirty = { config: false, state: false };
    const body = { rev: this.rev() };
    if (sent.config) body.config = toConfig(this.orm);
    if (sent.state) body.state = toState(this.orm);
    try {
      const resp = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const res = await resp.json().catch(() => ({}));
      if (resp.status === 409 && tries < 3) {
        this.rev.set(res.rev);
        this._dirty.config ||= sent.config;
        this._dirty.state ||= sent.state;
        return this._flush(tries + 1);
      }
      if (!resp.ok) throw new Error(res.error || resp.status);
      this.rev.set(res.rev);
    } catch (e) {
      this._dirty.config ||= sent.config;
      this._dirty.state ||= sent.state;
      console.error(`[goo] config save failed: ${e.message}`);
    }
  }
  // apply a config broadcast from another tab (SSE "config"). Ignored while we have a
  // pending local edit (our own flush reconciles via the 409 retry) or when the rev
  // isn't newer than ours (stale, or the echo of our own write).
  applyBroadcast(payload) {
    if (!payload || typeof payload.rev !== "number") return;
    if (this._dirty.config || this._dirty.state) return;
    if (payload.rev <= this.rev()) return;
    this.rev.set(payload.rev);
    this._reload(payload.config, payload.state);
  }
  // ── reset / presets (immediate, awaited so the caller can reload) ─────────────
  async _pushNow(config, state) {
    this._reload(config, state);
    this._dirty = { config: false, state: false };
    clearTimeout(this._timer);
    try {
      const resp = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rev: this.rev(),
          config: toConfig(this.orm),
          state: toState(this.orm)
        })
      });
      const res = await resp.json();
      if (res.rev !== void 0) this.rev.set(res.rev);
    } catch (e) {
      console.error(`[goo] config save failed: ${e.message}`);
    }
  }
  // reset the whole config + state back to the built-in defaults
  async resetConfig() {
    await this._pushNow({ ...DEFAULT_CONFIG }, {});
  }
  // a portable snapshot for the Backup export (config + app state, no rev)
  snapshot() {
    return { config: toConfig(this.orm), state: toState(this.orm) };
  }
  // restore a snapshot (from a Backup import), replacing config + state on the server
  async importSnapshot(snap) {
    await this._pushNow(snap.config || {}, snap.state || {});
  }
  // replace the whole config + state with a preset (see presets.js)
  async applyPreset(id) {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return false;
    const { config, state } = presetToConfigState(preset);
    await this._pushNow(config, state);
    return true;
  }
};

// static/src/core/router_plugin.js
var RouterPlugin = class extends Plugin {
  static sequence = 1;
  section = signal(this._fromHash());
  setup() {
    window.addEventListener("hashchange", () => this.section.set(this._fromHash()));
  }
  _fromHash() {
    const s = location.hash.replace("#", "");
    return SECTIONS.includes(s) ? s : "dashboard";
  }
  go(section) {
    location.hash = section;
  }
};

// static/src/core/update_plugin.js
var UpdatePlugin = class extends Plugin {
  server = plugin(ServerPlugin);
  dialogs = plugin(DialogPlugin);
  // { checked, is_repo, branch, behind, ahead, dirty, can_fast_forward } | null
  info = signal(null);
  applying = signal(false);
  // true while updating + restarting (drives an overlay)
  setup() {
    this._load();
    setInterval(() => this._load(true), 30 * 60 * 1e3);
    this.server.onGooUpdate((status) => this.info.set(status));
  }
  // on-demand re-check (the Config tab's "Check for update" button): fetch +
  // recompute on the backend, refresh `info`, and return the fresh result
  async check() {
    try {
      const data = await postJSON("/api/goo/check");
      this.info.set(data);
      return data;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  // confirm, then (when it's a clean fast-forward) update + restart goo and reload;
  // otherwise explain how to update manually so local work is never clobbered.
  // Only meaningful when behind > 0 (the badge / a positive check gate it).
  async promptUpdate() {
    const u = this.info() || {};
    if (!u.behind) return;
    if (!u.can_fast_forward) {
      let why = `goo is ${u.behind} commit${u.behind === 1 ? "" : "s"} behind origin/master`;
      if (u.ahead) why += `, with ${u.ahead} local commit${u.ahead === 1 ? "" : "s"} on top`;
      if (u.dirty) why += ", and the working tree has uncommitted changes";
      why += ". Update manually to keep your work, e.g. `git pull --rebase`.";
      return void this.dialogs.open({
        title: "goo update available",
        message: why,
        okLabel: "OK",
        cancelLabel: null
      });
    }
    const serverNote = this.server.status().state === "running" ? " The running Odoo server will be stopped." : "";
    const ok = await this.dialogs.open({
      title: "goo update available",
      message: `goo is ${u.behind} commit${u.behind === 1 ? "" : "s"} behind origin/master and can be updated cleanly. goo will fast-forward, restart, and this page will reload automatically.${serverNote}`,
      okLabel: "Update & restart",
      cancelLabel: "Later"
    });
    if (!ok) return;
    const res = await this.applyAndRestart();
    if (!res.ok)
      this.dialogs.open({
        title: "Update failed",
        message: res.error,
        cls: "dialog-error",
        okLabel: "OK",
        cancelLabel: null
      });
  }
  async _load(retried = false) {
    try {
      const data = await (await fetch("/api/goo/update", { cache: "no-store" })).json();
      this.info.set(data);
      if (!data.checked && !retried) setTimeout(() => this._load(true), 3e3);
    } catch {
    }
  }
  // fast-forward goo onto origin/master, restart the server, then reload the page
  // once it's back. Returns { ok, error }; on success the page is reloading.
  async applyAndRestart() {
    this.applying.set(true);
    const boot2 = this.info()?.boot;
    try {
      await postJSON("/api/goo/update");
      await postJSON("/api/goo/restart").catch(() => {
      });
      if (await this._waitUntilRestarted(boot2)) {
        location.reload();
        return { ok: true };
      }
      this.applying.set(false);
      return { ok: false, error: "goo was updated but didn't come back \u2014 restart it manually." };
    } catch (e) {
      this.applying.set(false);
      return { ok: false, error: e.message };
    }
  }
  // wait until the re-exec'd goo is serving: a changed boot id is the reliable
  // signal (the old, still-shutting-down server keeps the old id); fall back to
  // "saw it go down, then back up" if we never had a boot id to compare.
  async _waitUntilRestarted(boot2, timeout = 3e4) {
    const t0 = Date.now();
    let wentDown = false;
    await new Promise((r) => setTimeout(r, 600));
    while (Date.now() - t0 < timeout) {
      try {
        const data = await (await fetch("/api/goo/update", { cache: "no-store" })).json();
        if (boot2 ? data.boot && data.boot !== boot2 : wentDown) return true;
      } catch {
        wentDown = true;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  }
};

// static/src/addons_screen/addons_plugin.js
var AddonsPlugin = class _AddonsPlugin extends Plugin {
  static sequence = 4;
  static MAX_ROWS = 200;
  config = plugin(ConfigPlugin);
  store = plugin(StorePlugin);
  // install/upgrade runs live in the shared store's runs map
  server = plugin(ServerPlugin);
  eventLog = plugin(EventLogPlugin);
  dialogs = plugin(DialogPlugin);
  output = new LogBuffer();
  modules = signal([]);
  loadedDb = signal("");
  erroredDb = signal("");
  // db whose last auto-load failed — don't auto-retry it (avoids a hot loop)
  loading = signal(false);
  error = signal("");
  filter = signal("");
  stateFilter = signal("");
  // "" | "installed" | "uninstalled"
  appOnly = signal(true);
  // only modules flagged as an application (on by default)
  status = signal("");
  _pending = signal(false);
  // optimistic "run starting", until the backend's "run" event lands
  _announced = null;
  // run id we've seen running this session
  _finishedRun = null;
  // run id we've finalized (once per run)
  // filtered + sorted modules — recomputed only when modules/filter change
  filtered = computed(() => this._filtered());
  setup() {
    useEffect(() => this._onRun(this.currentRun()));
    this.server.onLine((line) => {
      if (this.runActive()) this.output.append(line);
    });
  }
  // the current/last install-or-upgrade run (backend-minted, from the shared store)
  currentRun() {
    const i = this.store.latestRunOfKind("install");
    const u = this.store.latestRunOfKind("upgrade");
    return [i, u].filter(Boolean).sort((a, b) => (b.started_at || 0) - (a.started_at || 0))[0] || null;
  }
  // a run is active — optimistic between clicking Install/Upgrade and the backend's
  // first "run" event, then driven by the run's state (a method: components call it)
  runActive() {
    return this._pending() || this.currentRun()?.state === "running";
  }
  // the active target: the running server's target, else the last one used
  // (both reference a target id)
  _activeTarget() {
    const id = this.server.status().target || this.server.lastTarget();
    return this.config.config.targets.find((t2) => t2.id === id) || null;
  }
  targetName() {
    return this._activeTarget()?.name || "";
  }
  targetDb() {
    return this._activeTarget()?.db || "";
  }
  // the active target's repos as {id, path} — the addons-path used to list +
  // install, so only modules from the target's repos are ever shown
  _repos() {
    const target = this._activeTarget();
    if (!target) return [];
    const pathById = Object.fromEntries(this.config.config.repos.map((r) => [r.id, r.path]));
    return (target.checkouts || []).map((c) => ({ id: c.repo, path: pathById[c.repo] })).filter((r) => r.path);
  }
  async load() {
    const db = this.targetDb();
    if (!db) {
      this.modules.set([]);
      this.loadedDb.set("");
      return;
    }
    this.loading.set(true);
    this.error.set("");
    this.erroredDb.set("");
    try {
      const data = await postJSON("/api/addons", { repos: this._repos(), db });
      if (this.targetDb() !== db) return;
      this.modules.set(data.modules);
      this.loadedDb.set(db);
    } catch (e) {
      if (this.targetDb() !== db) return;
      this.error.set(e.message);
      this.erroredDb.set(db);
    } finally {
      this.loading.set(false);
    }
  }
  _filtered() {
    const q = this.filter().trim().toLowerCase();
    const sf = this.stateFilter();
    const appOnly = this.appOnly();
    const matched = this.modules().filter((mod) => {
      const installed = mod.state === "installed";
      if (sf === "installed" && !installed) return false;
      if (sf === "uninstalled" && installed) return false;
      if (appOnly && !mod.application) return false;
      return !q || mod.name.toLowerCase().includes(q) || mod.summary.toLowerCase().includes(q) || mod.category.toLowerCase().includes(q);
    });
    matched.sort(
      (a, b) => (b.state === "installed") - (a.state === "installed") || a.name.localeCompare(b.name)
    );
    return { total: matched.length, shown: matched.slice(0, _AddonsPlugin.MAX_ROWS) };
  }
  // react to the backend-minted install/upgrade Run moving running → done/failed.
  // Resume-after is backend-owned now; this just drives the status + reloads module
  // states when the run ends. Finalize once per run id.
  _onRun(run) {
    if (!run) return;
    if (run.state === "running") {
      this._pending.set(false);
      this._announced = run.id;
      this.status.set(`${run.kind === "upgrade" ? "upgrading" : "installing"}\u2026`);
    } else if (this._finishedRun !== run.id) {
      this._finishedRun = run.id;
      if (this._announced !== run.id) return;
      const stopped = run.returncode === null;
      this.status.set(
        stopped ? "stopped" : run.returncode ? `failed \u2014 exit ${run.returncode}` : "done"
      );
      this.load();
    }
  }
  get running() {
    return this.currentRun()?.state === "running";
  }
  async run(op, name) {
    const target = this._activeTarget();
    const db = this.targetDb();
    if (!target || !db) return;
    const verb = op === "upgrade" ? "Upgrade" : "Install";
    const ok = await this.dialogs.open({
      title: `${verb} "${name}" on ${db}?`,
      okLabel: verb
    });
    if (!ok) return;
    this.output.clear();
    this._pending.set(true);
    this.status.set(`${op === "upgrade" ? "upgrading" : "installing"} ${name}\u2026`);
    this.eventLog.add(`${op === "upgrade" ? "upgrading" : "installing"} ${name} in ${db}`);
    try {
      await postJSON("/api/addons/run", { target: target.id, overrides: { [op]: name } });
    } catch (e) {
      this._pending.set(false);
      this.status.set(`failed to start: ${e.message}`);
    }
  }
};

// static/src/core/common.js
var appBus = new EventBus();
var m = (s) => markup(s);
function mbCategory(s) {
  if (s === "merged") return "merged";
  if (["ready", "approved", "validated", "mergeable", "reviewed"].includes(s)) return "ready";
  if (["staged", "staging", "squashed", "pending"].includes(s)) return "progress";
  if (["blocked", "error"].includes(s)) return "blocked";
  return "other";
}
var ICONS = {
  dashboard: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-.6 4"/><polyline points="20 4 20 11 13 11"/></svg>`,
  clear: `<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13"/></svg>`,
  copy: `<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`,
  star: `<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z"/></svg>`,
  server: `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><circle cx="7" cy="7.5" r="1" fill="currentColor" stroke="none"/><circle cx="7" cy="16.5" r="1" fill="currentColor" stroke="none"/></svg>`,
  code: `<svg viewBox="0 0 24 24"><polyline points="8.5 8 4.5 12 8.5 16"/><polyline points="15.5 8 19.5 12 15.5 16"/></svg>`,
  target: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="1.5" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22.5"/><line x1="1.5" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22.5" y2="12"/></svg>`,
  branches: `<svg viewBox="0 0 24 24"><line x1="6" y1="4" x2="6" y2="15"/><circle cx="6" cy="18" r="2.6"/><circle cx="18" cy="6" r="2.6"/><path d="M18 8.6c0 5.4-4 5.4-9 7.4"/></svg>`,
  pr: `<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="6" y1="9" x2="6" y2="15"/><circle cx="18" cy="18" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/></svg>`,
  tests: `<svg viewBox="0 0 24 24"><path d="M9 3h6"/><path d="M10 3v6.5L4.8 18a2 2 0 0 0 1.8 3h10.8a2 2 0 0 0 1.8-3L14 9.5V3"/><path d="M7.5 14h9"/></svg>`,
  databases: `<svg viewBox="0 0 24 24"><ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/><path d="M4 11.5v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/></svg>`,
  addons: `<svg viewBox="0 0 24 24"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5"/><path d="M12 12v9"/></svg>`,
  assets: `<svg viewBox="0 0 24 24"><polygon points="12 2 22 7 12 12 2 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`,
  config: `<svg viewBox="0 0 24 24"><line x1="4" y1="8" x2="20" y2="8"/><line x1="4" y1="16" x2="20" y2="16"/><circle cx="15" cy="8" r="2.4" class="knob"/><circle cx="9" cy="16" r="2.4" class="knob"/></svg>`,
  kebab: `<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.7" fill="currentColor" stroke="none"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>`,
  check: `<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>`,
  push: `<svg viewBox="0 0 24 24"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="6 11 12 5 18 11"/></svg>`,
  play: `<svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none"/></svg>`,
  stop: `<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/></svg>`,
  external: `<svg viewBox="0 0 24 24"><path d="M7 17 17 7M9 7h8v8"/></svg>`,
  journal: `<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="2"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="13" y2="16"/></svg>`,
  terminal: `<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="6 9 10 12 6 15"/><line x1="12" y1="15" x2="18" y2="15"/></svg>`,
  history: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><line x1="2.5" y1="12" x2="8.8" y2="12"/><line x1="15.2" y1="12" x2="21.5" y2="12"/></svg>`,
  worktree: `<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.4"/><line x1="6" y1="8.4" x2="6" y2="20"/><path d="M6 12h6a2 2 0 0 1 2 2v1"/><rect x="14" y="9" width="7" height="6" rx="1.5"/></svg>`,
  nightly: `<svg viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
  memory: `<svg viewBox="0 0 24 24"><polyline points="2 17 6 11 10 13 14 7 18 10 22 4"/><polyline points="22 4 22 9 17 9"/></svg>`
};
var NAV = [
  { id: "dashboard", label: "Dashboard", icon: ICONS.dashboard },
  { id: "code", label: "Code", icon: ICONS.code },
  { id: "targets", label: "Targets", icon: ICONS.target },
  { id: "server", label: "Server", icon: ICONS.server },
  { id: "worktree", label: "Worktrees", icon: ICONS.worktree, optIn: true },
  { id: "tests", label: "Tests", icon: ICONS.tests },
  { id: "branches", label: "Branches", icon: ICONS.branches },
  { id: "prs", label: "PRs", icon: ICONS.pr },
  { id: "assets", label: "Assets", icon: ICONS.assets },
  { id: "addons", label: "Addons", icon: ICONS.addons },
  { id: "databases", label: "Databases", icon: ICONS.databases },
  { id: "nightly", label: "Nightly", icon: ICONS.nightly, optIn: true },
  { id: "memory", label: "Memory", icon: ICONS.memory, optIn: true },
  { id: "config", label: "Configuration", icon: ICONS.config }
];
function mergedTabIds(configured) {
  const inNav = new Set(NAV.map((n) => n.id));
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const t2 of configured || []) {
    if (!inNav.has(t2.id) || seen.has(t2.id)) continue;
    seen.add(t2.id);
    out.push(t2.id);
  }
  let anchor = -1;
  for (const n of NAV) {
    const idx = out.indexOf(n.id);
    if (idx !== -1) {
      anchor = idx;
    } else {
      out.splice(++anchor, 0, n.id);
    }
  }
  return out;
}
var LogConsole = class extends Component {
  static template = xml`
    <section class="console" t-att-class="this.consoleClass">
      <div t-if="!this.props.bare" class="log-toolbar">
        <span class="console-title"><span class="cdot" t-att-class="{on: this.live}"/><t t-out="this.props.title"/></span>
        <div class="toolbar-right">
          <label class="toggle" t-att-class="{on: this.props.buffer.autoScroll()}" t-on-click="() => this.toggleAuto()"><span class="switch"/>Autoscroll</label>
          <button class="tool-btn" t-on-click="() => this.props.buffer.clear()"><t t-out="this.clearIcon"/>Clear</button>
        </div>
      </div>
      <div class="log-host" t-ref="this.host"/>
    </section>`;
  props = props({
    title: t.string(),
    buffer: t.any(),
    extraClass: t.string().optional(),
    bare: t.boolean().optional()
  });
  server = plugin(ServerPlugin);
  host = signal.ref(HTMLElement);
  clearIcon = m(ICONS.clear);
  setup() {
    onMounted(() => {
      this.host().appendChild(this.props.buffer.el);
      this.props.buffer.restore();
    });
    onWillUnmount(() => {
      this.props.buffer.savedScroll = this.props.buffer.el.scrollTop;
    });
  }
  get live() {
    return this.server.status().state === "running";
  }
  get consoleClass() {
    return [this.props.extraClass, this.props.bare ? "bare" : ""].filter(Boolean).join(" ");
  }
  toggleAuto() {
    const b = this.props.buffer;
    b.autoScroll.set(!b.autoScroll());
    if (b.autoScroll()) b.toBottom();
  }
};
var SearchBox = class extends Component {
  static template = xml`
    <div class="search-box">
      <input type="text" t-att-value="this.props.value()" autocomplete="off" placeholder="Search…"
             t-on-input="ev => this.props.value.set(ev.target.value)"/>
      <button t-if="this.props.value()" class="search-clear" title="clear search" t-on-click="() => this.props.value.set('')">✕</button>
    </div>`;
  props = props({ value: t.any() });
};
var Panel = class extends Component {
  static template = xml`
    <div class="panel">
      <div class="panel-top" t-att-class="{'has-filters': this.hasSlot('top-middle')}">
        <h1 t-out="this.props.title"/>
        <div t-if="this.hasSlot('top-middle')" class="panel-filters"><t t-slot="top-middle"/></div>
        <div t-if="this.hasSlot('top-right')" class="panel-top-right"><t t-slot="top-right"/></div>
      </div>
      <div t-if="this.hasSlot('bottom-left') or this.hasSlot('bottom-right')" class="panel-actions">
        <t t-slot="bottom-left"/>
        <t t-slot="bottom-right"/>
      </div>
    </div>`;
  props = props({ title: t.string(), slots: t.any().optional() });
  hasSlot(name) {
    return name in (this.props.slots || {});
  }
};
var DirtyBadge = class extends Component {
  static template = xml`
    <button class="dirty-badge" t-on-click.stop="(ev) => this.openMenu(ev)" title="uncommitted changes">dirty</button>`;
  props = props({ path: t.string(), repo: t.string() });
  openMenu(ev) {
    const rect = ev.currentTarget.getBoundingClientRect();
    appBus.dispatchEvent(
      new CustomEvent("dirty-menu", {
        detail: { rect, path: this.props.path, repo: this.props.repo }
      })
    );
  }
};
var DirtyMenu = class extends Component {
  static template = xml`
    <div class="dash-menu dirty-menu" t-att-class="{hidden: !this.open()}" t-on-click.stop="() => {}">
      <button class="dash-menu-item" t-on-click="() => this.wipCommit()">WIP commit</button>
      <button class="dash-menu-item danger" t-on-click="() => this.discard()">Discard changes</button>
    </div>`;
  code = plugin(CodePlugin);
  open = signal(false);
  _path = null;
  _repo = null;
  _el = null;
  setup() {
    onMounted(() => {
      this._el = document.querySelector(".dirty-menu");
      appBus.addEventListener("dirty-menu", (e) => this.openMenu(e.detail));
      document.addEventListener("click", () => this.open.set(false));
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") this.open.set(false);
      });
    });
  }
  async openMenu({ rect, path, repo }) {
    this._path = path;
    this._repo = repo;
    this.open.set(true);
    await Promise.resolve();
    const w = this._el.offsetWidth;
    this._el.style.top = `${rect.bottom + 4}px`;
    this._el.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - w - 12))}px`;
  }
  wipCommit() {
    this.open.set(false);
    this.code.wipCommit(this._path, this._repo);
  }
  discard() {
    this.open.set(false);
    this.code.discard(this._path, this._repo);
  }
};
function loadScript(src, isLoaded) {
  return new Promise((resolve, reject) => {
    if (isLoaded()) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}
function useDragResize({ w = 780, h = 440, place = null } = {}) {
  const handle = signal.ref(HTMLElement);
  let x = 0;
  let y = 0;
  let width = w;
  let height = h;
  let placed = false;
  let dragging = false;
  let resizing = false;
  let offX = 0;
  let offY = 0;
  let startX = 0;
  let startY = 0;
  let startW = 0;
  let startH = 0;
  const apply = () => {
    const el = handle();
    if (!el) return;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
  };
  const onMouseMove = (e) => {
    if (dragging) {
      x = Math.max(0, e.clientX - offX);
      y = Math.max(0, e.clientY - offY);
      apply();
    } else if (resizing) {
      width = Math.max(300, startW + e.clientX - startX);
      height = Math.max(200, startH + e.clientY - startY);
      apply();
    }
  };
  const onMouseUp = () => {
    dragging = false;
    resizing = false;
  };
  onMounted(() => {
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });
  onWillUnmount(() => {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  });
  useEffect(() => {
    const el = handle();
    if (!el) return;
    if (!placed) {
      const p = place ? place(width, height) : null;
      x = p ? p.x : Math.max(0, Math.floor((window.innerWidth - width) / 2));
      y = p ? p.y : Math.max(0, Math.floor((window.innerHeight - height) / 2));
      placed = true;
    }
    apply();
  });
  return {
    handle,
    onDragStart: (e) => {
      if (e.button !== 0) return;
      dragging = true;
      offX = e.clientX - x;
      offY = e.clientY - y;
      e.preventDefault();
    },
    onResizeStart: (e) => {
      if (e.button !== 0) return;
      resizing = true;
      startX = e.clientX;
      startY = e.clientY;
      startW = width;
      startH = height;
      e.preventDefault();
      e.stopPropagation();
    }
  };
}

// static/src/addons_screen/addons.js
var AddonsScreen = class extends Component {
  static components = { LogConsole, SearchBox };
  static template = xml`
    <section>
      <div class="panel">
        <div class="panel-top has-filters">
          <h1>Addons</h1>
          <div class="panel-filters">
            <SearchBox value="this.addons.filter"/>
            <button class="pbtn" t-att-class="{active: this.addons.stateFilter() === 'installed'}" t-on-click="() => this.toggleState('installed')">Installed</button>
            <button class="pbtn" t-att-class="{active: this.addons.stateFilter() === 'uninstalled'}" t-on-click="() => this.toggleState('uninstalled')">Uninstalled</button>
            <button class="pbtn" t-att-class="{active: this.addons.appOnly()}" t-on-click="() => this.addons.appOnly.set(!this.addons.appOnly())">Apps</button>
          </div>
          <div class="panel-top-right">
            <span class="meta" t-out="this.addons.status()"/>
            <button class="pbtn" t-att-disabled="!this.addons.targetDb()" t-on-click="() => this.addons.load()"><t t-out="this.refreshIcon"/>Refresh</button>
          </div>
        </div>
        <div class="panel-actions">
          <span t-if="this.addons.targetName()" class="addons-target" t-out="this.targetLabel"/>
          <span t-if="this.addons.targetDb()" class="row-count" t-out="this.count"/>
        </div>
      </div>
      <div class="content addons-content">
        <div t-if="!this.addons.targetDb()" class="dim addons-empty">No active target — start a server to browse its addons.</div>
        <t t-else="">
          <div class="addons-grid-wrap">
            <div t-if="this.addons.loading()" class="dim addons-msg">Loading…</div>
            <div t-elif="this.addons.error()" class="dim addons-msg" t-out="'Failed to load: ' + this.addons.error()"/>
            <div t-elif="!this.view.total" class="dim addons-msg">No modules match.</div>
            <t t-else="">
              <div class="brg-table">
                <table class="br-table brg-flat">
                  <thead>
                    <tr><th>Module</th><th>Summary</th><th>Repository</th><th>State</th><th/></tr>
                  </thead>
                  <tbody>
                    <tr t-foreach="this.view.shown" t-as="mod" t-key="mod.name">
                      <td class="addon-name" t-att-title="mod.summary" t-out="mod.name"/>
                      <td class="dim"><div class="br-ellip" t-att-title="mod.summary" t-out="mod.summary || '—'"/></td>
                      <td class="dim" t-out="mod.repo"/>
                      <td><span class="addon-state" t-att-class="this.stateClass(mod)" t-out="mod.state || 'not installed'"/></td>
                      <td>
                        <div class="br-act">
                          <button class="addon-btn" t-att-disabled="this.addons.runActive() or mod.installable === false"
                                  t-on-click="() => this.addons.run(mod.state === 'installed' ? 'upgrade' : 'install', mod.name)"
                                  t-out="mod.state === 'installed' ? 'Upgrade' : 'Install'"/>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div t-if="this.view.total > this.view.shown.length" class="dim addons-more"
                   t-out="'Showing ' + this.view.shown.length + ' of ' + this.view.total + ' — refine the filter to see more.'"/>
            </t>
          </div>
          <LogConsole t-if="this.addons.runActive() or this.addons.running" title="'Install / upgrade output'" buffer="this.addons.output" extraClass="'addons-console'"/>
        </t>
      </div>
    </section>`;
  addons = plugin(AddonsPlugin);
  refreshIcon = m(ICONS.refresh);
  setup() {
    useEffect(() => {
      const db = this.addons.targetDb();
      if (db && db !== this.addons.loadedDb() && db !== this.addons.erroredDb() && !this.addons.loading())
        this.addons.load();
    });
  }
  get view() {
    return this.addons.filtered();
  }
  get count() {
    const n = this.view.total;
    return `${n} module${n === 1 ? "" : "s"}`;
  }
  get targetLabel() {
    return `${this.addons.targetName()} \xB7 ${this.addons.targetDb()}`;
  }
  toggleState(value) {
    this.addons.stateFilter.set(this.addons.stateFilter() === value ? "" : value);
  }
  stateClass(mod) {
    return (mod.state || "none").replace(/\s+/g, "-");
  }
};

// static/src/core/database_plugin.js
var DatabasePlugin = class extends Plugin {
  static sequence = 3;
  server = plugin(ServerPlugin);
  eventLog = plugin(EventLogPlugin);
  config = plugin(ConfigPlugin);
  databases = signal([]);
  // view state; freshness is the server's job now
  at = signal(0);
  loading = signal(false);
  error = signal("");
  dropping = signal("");
  _wasRunning = false;
  // last-seen server-running state, to detect the start edge
  setup() {
    useEffect(() => this._onStatus(this.server.status()));
  }
  // reload (bypassing the cache) on the rising edge into "running" — the freshly
  // created db may not be in the cached list yet
  _onStatus(status) {
    const running = status.state === "running";
    if (running && !this._wasRunning) this.load(true);
    this._wasRunning = running;
  }
  get activeDb() {
    return this.server.status().db || null;
  }
  // fetch the database list (the server caches it). `force` (manual Refresh) adds
  // ?refresh=1 so the backend re-queries instead of serving its cache.
  async load(force = false) {
    this.loading.set(true);
    this.error.set("");
    try {
      const resp = await fetch(force ? "/api/databases?refresh=1" : "/api/databases");
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || "failed");
      this.databases.set(data.databases);
      this.at.set(Date.now());
    } catch (e) {
      this.error.set(e.message);
    } finally {
      this.loading.set(false);
    }
  }
  // drop a database; returns null on success or an error message on failure
  // (the caller handles confirmation + error reporting via the dialog)
  async drop(name) {
    this.dropping.set(name);
    this.eventLog.add(`dropping database ${name}`);
    try {
      await postJSON("/api/databases/drop", { name, filestore: this._filestore() });
      await this.load(true);
      return null;
    } catch (e) {
      this.eventLog.add(`failed to drop database ${name}: ${e.message}`);
      return e.message;
    } finally {
      this.dropping.set("");
    }
  }
  // clone `name` into a new database `target`; returns null on success or an error
  async clone(name, target) {
    this.eventLog.add(`cloning database ${name} \u2192 ${target}`);
    try {
      await postJSON("/api/databases/clone", {
        source: name,
        target,
        filestore: this._filestore()
      });
      await this.load(true);
      return null;
    } catch (e) {
      this.eventLog.add(`failed to clone database ${name}: ${e.message}`);
      return e.message;
    }
  }
  // clone `source` into `target`, transparently stopping + resuming the server when
  // `source` is the active db (postgres createdb -T needs exclusive access). Returns
  // null on success or an error message; the server is resumed even if the clone fails.
  async cloneStoppingServer(source, target) {
    const resume = this.activeDb === source && this.server.status().state !== "stopped";
    if (resume) await this.server.stop();
    const error = await this.clone(source, target);
    if (resume) await this.server.resume();
    return error;
  }
  // drop `name`, stopping the server first when it's the active db (the server
  // holds a connection to it). Unlike clone, we don't resume — the database is
  // gone, so the server stays stopped. Returns null on success or an error message.
  async dropStoppingServer(name) {
    if (this.activeDb === name && this.server.status().state !== "stopped") {
      await this.server.stop();
    }
    return this.drop(name);
  }
  // rename `name` to `newName`; returns null on success or an error message
  async rename(name, newName) {
    this.eventLog.add(`renaming database ${name} \u2192 ${newName}`);
    try {
      await postJSON("/api/databases/rename", {
        name,
        new_name: newName,
        filestore: this._filestore()
      });
      await this.load(true);
      return null;
    } catch (e) {
      this.eventLog.add(`failed to rename database ${name}: ${e.message}`);
      return e.message;
    }
  }
  // the configured filestore root, sent with drop/clone/rename so the backend keeps
  // each db's <filestore>/<db> directory in lockstep (empty = leave the disk alone)
  _filestore() {
    return this.config.config.filestore || "";
  }
};

// static/src/assets_screen/assets_plugin.js
var AssetsPlugin = class extends Plugin {
  static sequence = 6;
  config = plugin(ConfigPlugin);
  server = plugin(ServerPlugin);
  db = plugin(DatabasePlugin);
  eventLog = plugin(EventLogPlugin);
  dialogs = plugin(DialogPlugin);
  bundles = signal([]);
  selectedDb = signal("");
  loadedDb = signal("");
  at = signal(0);
  loading = signal(false);
  generating = signal(false);
  error = signal("");
  // analysis of one bundle: { name, js:[[path,bytes]], css, xml } | null
  bundleData = signal(null);
  analyzing = signal(false);
  analyzeError = signal("");
  // disable actions while a load or a generation is in flight
  busy() {
    return this.loading() || this.generating();
  }
  // the db to inspect by default: the running server's db, else the active target's
  defaultDb() {
    const id = this.server.status().target || this.server.lastTarget();
    const target = this.config.config.targets.find((t2) => t2.id === id);
    return this.server.status().db || target?.db || "";
  }
  // pick a database and (re)load its bundles; "" clears the list
  selectDb(db) {
    this.selectedDb.set(db);
    if (db) this.load(true);
    else {
      this.bundles.set([]);
      this.loadedDb.set("");
    }
  }
  async load(force = false) {
    const db = this.selectedDb();
    if (!db) {
      this.bundles.set([]);
      this.loadedDb.set("");
      return;
    }
    this.loading.set(true);
    this.error.set("");
    try {
      const data = await postJSON("/api/assets", { db, refresh: force });
      if (this.selectedDb() !== db) return;
      this.bundles.set(data.bundles);
      this.loadedDb.set(db);
      this.at.set(Date.now());
    } catch (e) {
      if (this.selectedDb() === db) this.error.set(e.message);
    } finally {
      this.loading.set(false);
    }
  }
  // force a pregeneration of the bundles (odoo-bin shell), then reload the list.
  // The server builds the addons-path + venv prefix from its own config — just the db.
  async generate() {
    const db = this.selectedDb();
    if (!db) return;
    this.generating.set(true);
    this.error.set("");
    const eid = this.eventLog.begin(`generating asset bundles in ${db}\u2026`);
    try {
      await postJSON("/api/assets/generate", { db });
      this.eventLog.finish(eid, "done");
      await this.load(true);
    } catch (e) {
      this.eventLog.finish(eid, "error");
      this.error.set(e.message);
      this.dialogs.open({
        title: "Generate asset bundles failed",
        message: e.message,
        cls: "dialog-error",
        okLabel: "OK",
        cancelLabel: null
      });
    } finally {
      this.generating.set(false);
    }
  }
  // analyze a bundle's contents: ask the backend for the per-file minified-size
  // breakdown (read from the stored bundle), and open the view. kind scopes it to the
  // clicked asset — "js" → the .min.js (code + XML templates), "css" → the .min.css —
  // so the total matches that attachment's row size instead of summing js+css.
  async analyze(bundle, kind = "js") {
    const db = this.selectedDb();
    if (!db || !bundle) return;
    this.analyzing.set(true);
    this.analyzeError.set("");
    this.bundleData.set({ name: bundle, kind, js: [], css: [], xml: [] });
    try {
      const filestore = this.config.config.filestore || "";
      const data = await postJSON("/api/assets/breakdown", { db, bundle, filestore, kind });
      this.bundleData.set({ name: bundle, kind, js: data.js, css: data.css, xml: data.xml });
    } catch (e) {
      this.analyzeError.set(e.message);
    } finally {
      this.analyzing.set(false);
    }
  }
  closeAnalysis() {
    this.bundleData.set(null);
    this.analyzeError.set("");
  }
};

// static/src/assets_screen/assets.js
var BundleNode = class extends Component {
  static template = xml`
    <div class="bnode">
      <div class="bnode-row" t-att-class="{leaf: !this.props.node.children.length}" t-att-style="'padding-left:' + (this.props.depth * 14 + 10) + 'px'" t-on-click="() => this.toggle()">
        <span class="bnode-caret" t-out="this.props.node.children.length ? (this.open() ? '▾' : '▸') : ''"/>
        <span class="bnode-name" t-out="this.props.node.name"/>
        <span class="bnode-size" t-out="this.fmt(this.props.node.size)"/>
      </div>
      <t t-if="this.open()">
        <BundleNode t-foreach="this.props.node.children" t-as="c" t-key="c.name" node="c" depth="this.props.depth + 1"/>
      </t>
    </div>`;
  props = props({ node: t.any(), depth: t.any() });
  open = signal(false);
  setup() {
    if (this.props.depth === 0) this.open.set(true);
  }
  toggle() {
    if (this.props.node.children.length) this.open.set(!this.open());
  }
  fmt(n) {
    return formatBytes(n);
  }
};
BundleNode.components = { BundleNode };
var AssetsScreen = class extends Component {
  static components = { SearchBox, BundleNode };
  static template = xml`
    <section>
      <div class="panel">
        <div class="panel-top has-filters">
          <h1>Assets</h1>
          <div class="panel-filters">
            <SearchBox value="this.search"/>
            <label class="assets-chk"><input type="checkbox" t-att-checked="this.showJs()" t-on-change="() => this.showJs.set(!this.showJs())"/>js</label>
            <label class="assets-chk"><input type="checkbox" t-att-checked="this.showCss()" t-on-change="() => this.showCss.set(!this.showCss())"/>css</label>
            <label class="assets-chk"><input type="checkbox" t-att-checked="this.showOther()" t-on-change="() => this.showOther.set(!this.showOther())"/>other</label>
          </div>
          <div class="panel-top-right">
            <span class="meta" t-out="this.stamp"/>
            <button class="pbtn" t-att-disabled="!this.assets.selectedDb() or this.assets.busy()" t-on-click="() => this.assets.load(true)"><t t-out="this.refreshIcon"/>Refresh</button>
          </div>
        </div>
        <div class="panel-actions">
          <select t-att-value="this.assets.selectedDb()" t-on-change="ev => this.assets.selectDb(ev.target.value)" title="database to inspect">
            <option value="">Select a database…</option>
            <option t-foreach="this.dbOptions" t-as="d" t-key="d" t-att-value="d" t-out="d"/>
          </select>
          <button class="pbtn" t-att-disabled="!this.assets.selectedDb() or this.assets.busy()" t-on-click="() => this.assets.generate()">Generate asset bundles</button>
          <span t-if="this.assets.selectedDb()" class="row-count" t-out="this.count"/>
        </div>
      </div>
      <div class="content br-fill">
        <t t-if="this.assets.bundleData()">
          <div class="assets-analysis">
            <div class="assets-analysis-bar">
              <button class="pbtn" t-on-click="() => this.assets.closeAnalysis()">← Back</button>
              <span class="assets-analysis-title" t-out="this.analysisTitle"/>
              <span class="meta" t-out="this.analysisTotal"/>
              <div class="assets-analysis-views">
                <SearchBox value="this.treeSearch"/>
                <button class="pbtn" t-att-class="{active: this.view() === 'tree'}" t-on-click="() => this.view.set('tree')">Aggregate</button>
                <button class="pbtn" t-att-class="{active: this.view() === 'flat'}" t-on-click="() => this.view.set('flat')">Flat</button>
              </div>
            </div>
            <div class="assets-tree">
              <div t-if="this.assets.analyzing()" class="dim br-empty">Analyzing…</div>
              <div t-elif="this.assets.analyzeError()" class="dim br-empty" t-out="'Analysis failed: ' + this.assets.analyzeError()"/>
              <div t-elif="!this.flat.length" class="dim br-empty">No files in this bundle.</div>
              <div t-else="" class="assets-tree-inner">
                <t t-if="this.view() === 'tree'">
                  <BundleNode t-foreach="this.tree" t-as="n" t-key="n.name" node="n" depth="0"/>
                </t>
                <t t-else="">
                  <div t-foreach="this.flat" t-as="f" t-key="f.path" class="bflat-row">
                    <span class="bnode-name" t-out="f.path"/>
                    <span class="bnode-size" t-out="this.fmtSize(f.bytes)"/>
                  </div>
                </t>
              </div>
            </div>
          </div>
        </t>
        <t t-else="">
        <div t-att-class="{busy: this.assets.busy()}">
          <div t-if="!this.assets.selectedDb()" class="dim br-empty">Select a database to list its asset bundles.</div>
          <div t-elif="this.assets.error()" class="dim br-empty" t-out="'Failed to load: ' + this.assets.error()"/>
          <div t-elif="this.assets.loading() and !this.rows().length" class="dim br-empty">Loading…</div>
          <div t-elif="!this.rows().length" class="dim br-empty">No asset bundles in this database.</div>
          <div t-else="" class="br-card">
            <div class="brg-table">
              <table class="br-table brg-flat">
                <thead>
                  <tr>
                    <th class="br-sort" t-on-click="() => this.sort('name')">Bundle<span class="br-arrow" t-out="this.sortArrow('name')"/></th>
                    <th class="br-sort" t-on-click="() => this.sort('size')">Size<span class="br-arrow" t-out="this.sortArrow('size')"/></th>
                  </tr>
                </thead>
                <tbody>
                  <tr t-foreach="this.rows()" t-as="b" t-key="b.id">
                    <td class="addon-name">
                      <button class="assets-name" t-att-title="'analyze ' + this.bundleBase(b.name) + '.min bundle'" t-on-click="() => this.analyze(b)" t-out="b.name"/>
                      <button class="assets-copy" t-att-title="'copy ' + b.url" t-on-click="() => this.copyUrl(b)" t-out="this.copiedId() === b.id ? 'copied' : 'copy url'"/>
                    </td>
                    <td t-out="this.fmtSize(b.size)"/>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
        </t>
      </div>
    </section>`;
  assets = plugin(AssetsPlugin);
  db = plugin(DatabasePlugin);
  refreshIcon = m(ICONS.refresh);
  view = signal("tree");
  // analysis view: "tree" (aggregate) | "flat"
  treeSearch = signal("");
  // filter files within the analysis
  copiedId = signal(null);
  // id of the row whose url was just copied (transient label)
  sortKey = signal("size");
  // "name" | "size"
  sortDir = signal("desc");
  // "asc" | "desc" — default: largest bundle first
  search = signal("");
  showJs = signal(true);
  // include .js bundles
  showCss = signal(true);
  // include .css bundles
  showOther = signal(true);
  // include non-js/non-css assets (fonts, source maps, xml…)
  setup() {
    this.db.load();
    if (!this.assets.selectedDb()) {
      const d = this.assets.defaultDb();
      if (d) this.assets.selectDb(d);
    }
  }
  get dbOptions() {
    return this.db.databases().map((d) => d.name);
  }
  get stamp() {
    if (this.assets.generating()) return "generating\u2026";
    if (this.assets.loading()) return "loading\u2026";
    return this.assets.at() ? `updated ${timeAgo(new Date(this.assets.at()).toISOString())}` : "";
  }
  get count() {
    const n = this.rows().length;
    return `${n} bundle${n === 1 ? "" : "s"}`;
  }
  // the bundle base name an attachment belongs to, e.g. "web.assets_web.min.js" or
  // "web.assets_web.css.map" -> "web.assets_web"
  bundleBase(name) {
    return name.replace(/\.map$/, "").replace(/(\.min)?\.(js|css|xml)$/, "");
  }
  // analyze the bundle this row belongs to (its per-file size breakdown), scoped to
  // the clicked attachment's kind so the total matches its row size: any .css/.css.map
  // → css, everything else (.min.js, .js.map, …) → js.
  analyze(b) {
    const kind = /\.css(\.map)?$/i.test(b.name) ? "css" : "js";
    this.assets.analyze(this.bundleBase(b.name), kind);
  }
  // the analyzed attachment's name, e.g. "web.assets_web.min.js" — the .min asset the
  // breakdown was scoped to, so it reads as the row that was clicked
  get analysisTitle() {
    const d = this.assets.bundleData();
    if (!d) return "";
    return `${d.name}.min.${d.kind === "css" ? "css" : "js"}`;
  }
  // total minified size across the analyzed bundle's js + css + xml
  get analysisTotal() {
    const d = this.assets.bundleData();
    if (!d) return "";
    const all = [...d.js || [], ...d.css || [], ...d.xml || []];
    return `${formatBytes(all.reduce((s, [, n]) => s + n, 0))} minified`;
  }
  // the analyzed bundle's files as a flat list ({path, bytes}), search-filtered,
  // largest first. Same path can occur more than once (e.g. a template and its
  // registerTemplateExtension share their base template's name) — merge those into
  // one row (sizes summed), matching how the tree view aggregates by path already.
  get flat() {
    const d = this.assets.bundleData();
    if (!d) return [];
    const q = this.treeSearch().trim().toLowerCase();
    const byPath = /* @__PURE__ */ new Map();
    for (const [path, bytes] of [...d.js || [], ...d.css || [], ...d.xml || []]) {
      byPath.set(path, (byPath.get(path) || 0) + bytes);
    }
    return [...byPath.entries()].map(([path, bytes]) => ({ path, bytes })).filter((f) => !q || f.path.toLowerCase().includes(q)).sort((a, b) => b.bytes - a.bytes);
  }
  // the analyzed bundle aggregated into a tree: top level is js/css/xml, then each
  // path segment, sizes summed up the tree; children sorted largest first
  get tree() {
    const d = this.assets.bundleData();
    if (!d) return [];
    const q = this.treeSearch().trim().toLowerCase();
    const top = [];
    for (const [label, files] of [
      ["js", d.js],
      ["css", d.css],
      ["xml", d.xml]
    ]) {
      const matched = (files || []).filter(([p]) => !q || p.toLowerCase().includes(q));
      if (!matched.length) continue;
      const root = { name: label, size: 0, children: {} };
      for (const [path, bytes] of matched) {
        root.size += bytes;
        let node = root;
        for (const part of path.split("/").filter(Boolean)) {
          node.children[part] = node.children[part] || { name: part, size: 0, children: {} };
          node = node.children[part];
          node.size += bytes;
        }
      }
      top.push(root);
    }
    const finalize = (n) => ({
      name: n.name,
      size: n.size,
      children: Object.values(n.children).map(finalize).sort((a, b) => b.size - a.size)
    });
    return top.map(finalize).sort((a, b) => b.size - a.size);
  }
  // js / css / other, from the bundle's extension. Source maps (.js.map / .css.map)
  // and everything that isn't plain js/css (fonts, xml, …) count as "other".
  kind(b) {
    if (/\.map$/i.test(b.name)) return "other";
    if (/\.css$/i.test(b.name)) return "css";
    if (/\.js$/i.test(b.name)) return "js";
    return "other";
  }
  // search- and kind-filtered bundles, sorted by the active column
  rows() {
    const q = this.search().trim().toLowerCase();
    const showJs = this.showJs();
    const showCss = this.showCss();
    const showOther = this.showOther();
    const dir = this.sortDir() === "asc" ? 1 : -1;
    const bySize = this.sortKey() === "size";
    return this.assets.bundles().filter((b) => {
      const k = this.kind(b);
      if (k === "js" && !showJs) return false;
      if (k === "css" && !showCss) return false;
      if (k === "other" && !showOther) return false;
      return !q || b.name.toLowerCase().includes(q) || b.url.toLowerCase().includes(q);
    }).sort(
      (a, b) => bySize ? dir * ((a.size || 0) - (b.size || 0)) : dir * a.name.localeCompare(b.name)
    );
  }
  // toggle direction when re-clicking the active column, else switch column with a
  // sensible default (names ascending A→Z, sizes descending largest-first)
  sort(key) {
    if (this.sortKey() === key) {
      this.sortDir.set(this.sortDir() === "asc" ? "desc" : "asc");
    } else {
      this.sortKey.set(key);
      this.sortDir.set(key === "size" ? "desc" : "asc");
    }
  }
  // " ▲" / " ▼" for the active sort column, else ""
  sortArrow(key) {
    if (this.sortKey() !== key) return "";
    return this.sortDir() === "asc" ? " \u25B2" : " \u25BC";
  }
  // copy a bundle's /web/assets/… path to the clipboard, flipping its link to
  // "copied" for a moment
  copyUrl(b) {
    navigator.clipboard?.writeText(b.url);
    this.copiedId.set(b.id);
    setTimeout(() => {
      if (this.copiedId() === b.id) this.copiedId.set(null);
    }, 1400);
  }
  fmtSize(n) {
    return formatBytes(n || 0);
  }
};

// static/src/core/worktree_plugin.js
var WorktreePlugin = class extends Plugin {
  static sequence = 5;
  config = plugin(ConfigPlugin);
  store = plugin(StorePlugin);
  // worktree servers live in the shared servers map
  server = plugin(ServerPlugin);
  code = plugin(CodePlugin);
  eventLog = plugin(EventLogPlugin);
  dialogs = plugin(DialogPlugin);
  selectedId = signal("");
  // the worktree selected in the Worktree screen
  logs = /* @__PURE__ */ new Map();
  // targetId -> LogBuffer (per-server scrollback + live stream)
  _startEids = {};
  // targetId -> pending "starting worktree server" timed-event id
  setup() {
    this.server.onWorktree((d) => this.applyStatus(d));
    this.server.onWorktreeLog(({ target, line }) => this.logBuffer(target).append(line));
    this.load();
  }
  // ── which targets are worktrees ──────────────────────────────────────────────
  // the explicit `kind` marks a worktree; fall back to the presence of the
  // `worktree` metadata object for any target not yet carrying a kind.
  isWorktree(tgt) {
    if (!tgt) return false;
    const rec = this.config.target(tgt.id);
    if (rec) return rec.isWorktree();
    return (tgt.kind || (tgt.worktree ? "worktree" : "plain")) === "worktree";
  }
  worktreeTargets() {
    return (this.config.config.targets || []).filter((t2) => this.isWorktree(t2));
  }
  selected() {
    return this.worktreeTargets().find((t2) => t2.id === this.selectedId()) || null;
  }
  select(id) {
    this.selectedId.set(id);
    if (id) this._primeLogs(id);
  }
  // branch names owned by a worktree (for the Branches/PRs "wt" badge)
  worktreeBranches() {
    const s = /* @__PURE__ */ new Set();
    for (const t2 of this.worktreeTargets())
      for (const c of t2.checkouts || []) if (c.branch) s.add(c.branch);
    return s;
  }
  isWorktreeBranch(name) {
    return !!name && this.worktreeBranches().has(name);
  }
  // ── paths ────────────────────────────────────────────────────────────────────
  // the worktree's checkout directory: the value frozen at creation
  // (worktree.dir), else derived from the name. Persisting it means a later rename
  // can't move the path off the real on-disk checkout (worktreeDirFor in utils.js).
  dirPath(tgt) {
    const rec = this.config.target(tgt.id);
    if (rec) return rec.dirPath();
    return tgt.worktree?.dir || worktreeDirFor(this.config.config.worktree_dir, tgt);
  }
  hasCommunity(tgt) {
    const rec = this.config.target(tgt.id);
    if (rec) return rec.hasCommunity();
    return (tgt.checkouts || []).some((c) => c.repo === "community");
  }
  // per-repo worktree descriptors for an existing worktree target (start / remove)
  wtRepos(tgt) {
    const g = this.code.groups();
    const dir = this.dirPath(tgt);
    return (tgt.checkouts || []).map(({ repo, branch }) => ({
      repo,
      branch,
      mainPath: g.pathByRepo[repo] || "",
      github: g.githubByRepo[repo] || "",
      worktreePath: `${dir}/${repo}`
    })).filter((r) => r.mainPath);
  }
  // ── live state (from the shared servers map, keyed by target id) ─────────────
  state(tgt) {
    return this.store.server(tgt.id) || { exists: false, state: "stopped", port: null };
  }
  exists(tgt) {
    return !!this.state(tgt).exists;
  }
  serverState(tgt) {
    return this.state(tgt).state || "stopped";
  }
  running(tgt) {
    const s = this.serverState(tgt);
    return s === "running" || s === "starting";
  }
  port(tgt) {
    return this.state(tgt).port || null;
  }
  _merge(id, patch) {
    this.store.mergeServer({ id, ...patch });
  }
  // resolve a worktree's pending start timed-event on a state transition. The store
  // merge already happened in ServerPlugin's "server" SSE handler (which relays each
  // worktree snapshot here); this just drives the event-log row.
  applyStatus(d) {
    if (!d || !d.id) return;
    const eid = this._startEids[d.id];
    if (eid && (d.state === "running" || d.state === "stopped")) {
      this.eventLog.finish(eid, d.state === "running" ? "done" : "error");
      delete this._startEids[d.id];
    }
  }
  // hydrate existence + current server state for every worktree target
  async load() {
    const targets = this.worktreeTargets().map((t2) => ({ id: t2.id, dirPath: this.dirPath(t2) }));
    if (!targets.length) return;
    try {
      const res = await postJSON("/api/worktree/list", { targets });
      for (const snap of Object.values(res.worktrees || {})) this.store.mergeServer(snap);
    } catch {
    }
  }
  // ── logs ─────────────────────────────────────────────────────────────────────
  logBuffer(id) {
    if (!this.logs.has(id)) this.logs.set(id, new LogBuffer());
    return this.logs.get(id);
  }
  // fill scrollback from the server's tail once, only if we don't already hold the
  // live stream (e.g. after a page reload while the server was already running)
  async _primeLogs(id) {
    const buf = this.logBuffer(id);
    if (buf.count()) return;
    try {
      const res = await postJSON("/api/worktree/logs", { target: id });
      buf.clear();
      for (const line of res.lines || []) buf.append(line);
    } catch {
    }
  }
  // ── create ─────────────────────────────────────────────────────────────────
  _newId(seed) {
    const base = "wt-" + (seed || "wt").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
    const taken = new Set((this.config.config.targets || []).map((t2) => t2.id));
    let id = base;
    let n = 2;
    while (taken.has(id)) id = `${base}-${n++}`;
    return id;
  }
  // Fork <branch> from <baseTargetId>'s branches into a fresh worktree; optionally
  // clone <cloneSource> into the worktree's own db first. On success, persist a new
  // worktree target and select it. spec: {baseTargetId, name, branch, dbName, cloneSource}
  async createWorktree({ baseTargetId, name, branch, dbName, cloneSource }) {
    const base = (this.config.config.targets || []).find((t2) => t2.id === baseTargetId);
    if (!base) return this._error("Create worktree", "unknown base target");
    const id = this._newId(name || branch);
    const tgt = {
      id,
      name: name || branch,
      favorite: false,
      kind: "worktree",
      checkouts: (base.checkouts || []).map((c) => ({ repo: c.repo, branch })),
      db: dbName,
      on_create_args: base.on_create_args || "",
      demo_data: base.demo_data ?? true,
      worktree: { base: baseTargetId }
    };
    const g = this.code.groups();
    const dir = this.dirPath(tgt);
    tgt.worktree.dir = dir;
    const repos = (base.checkouts || []).map((c) => ({
      repo: c.repo,
      newBranch: branch,
      startPoint: c.branch,
      mainPath: g.pathByRepo[c.repo] || "",
      github: g.githubByRepo[c.repo] || "",
      worktreePath: `${dir}/${c.repo}`
    })).filter((r) => r.mainPath);
    if (!repos.length) return this._error("Create worktree", "the base target has no local repos");
    const eid = this.eventLog.begin(`creating worktree ${tgt.name}`);
    try {
      if (cloneSource) {
        await postJSON("/api/databases/clone", {
          source: cloneSource,
          target: dbName,
          filestore: this.config.config.filestore
        });
      }
      const res = await postJSON("/api/worktree/create", { target: id, repos });
      if (!res.ok) {
        this.eventLog.finish(eid, "error");
        const msg = (res.results || []).filter((r) => !r.ok).map((r) => `${r.repo}: ${r.error}`).join("\n");
        return this._error("Worktree creation failed", msg || "git worktree add failed");
      }
      this.config.updateConfig({ targets: [...this.config.config.targets, tgt] });
      this._merge(id, { exists: true, state: "stopped", port: null });
      this.eventLog.finish(eid, "done");
      this.select(id);
      return true;
    } catch (e) {
      this.eventLog.finish(eid, "error");
      return this._error("Worktree creation failed", e.message);
    }
  }
  // ── server lifecycle ─────────────────────────────────────────────────────────
  // The backend builds the worktree launch config from the target id (repos pointed
  // at the worktree copies + the worktree's odoo-bin, from the persisted worktree.dir).
  async startServer(tgt) {
    if (this.running(tgt)) return;
    if (!this.hasCommunity(tgt))
      return this._error("Cannot start worktree server", "this target has no community repo");
    const eid = this.eventLog.begin(`starting worktree server (${tgt.name})`);
    this._startEids[tgt.id] = eid;
    this._merge(tgt.id, { state: "starting" });
    try {
      const res = await postJSON("/api/worktree/start", { target: tgt.id });
      this._merge(tgt.id, { state: "starting", port: res.port });
    } catch (e) {
      delete this._startEids[tgt.id];
      this.eventLog.finish(eid, "error");
      this._merge(tgt.id, { state: "stopped" });
      this._error("Could not start the worktree server", e.message);
    }
  }
  async stopServer(tgt) {
    this.eventLog.add(`stopping worktree server (${tgt.name})`);
    try {
      await postJSON("/api/worktree/stop", { target: tgt.id });
      this._merge(tgt.id, { state: "stopped" });
    } catch {
    }
  }
  // stop is synchronous on the backend, so a plain stop-then-start restarts cleanly
  async restartServer(tgt) {
    await this.stopServer(tgt);
    await this.startServer(tgt);
  }
  async remove(tgt) {
    if (this.running(tgt))
      return this._error("Stop the server first", "Stop the worktree server before removing it.");
    const res = await this.dialogs.open({
      title: `Remove worktree "${tgt.name}"?`,
      message: `This deletes ${this.dirPath(tgt)} and its git worktrees. Uncommitted changes there are lost.`,
      fields: [
        { key: "dropDb", type: "checkbox", label: `Also drop database "${tgt.db}"`, value: false }
      ],
      okLabel: "Remove"
    });
    if (!res) return;
    const repos = this.wtRepos(tgt).map(({ repo, mainPath, worktreePath }) => ({
      repo,
      mainPath,
      worktreePath
    }));
    this.eventLog.add(`removing worktree ${tgt.name}`);
    try {
      await postJSON("/api/worktree/remove", { target: tgt.id, dirPath: this.dirPath(tgt), repos });
    } catch (e) {
      return this._error("Worktree removal failed", e.message);
    }
    if (res.dropDb && tgt.db) {
      try {
        await postJSON("/api/databases/drop", {
          name: tgt.db,
          filestore: this.config.config.filestore
        });
      } catch (e) {
        this._error("Database drop failed", e.message);
      }
    }
    this.config.updateConfig({
      targets: (this.config.config.targets || []).filter((t2) => t2.id !== tgt.id)
    });
    this.store.dropServer(tgt.id);
    this.logs.delete(tgt.id);
    if (this.selectedId() === tgt.id) this.selectedId.set("");
  }
  // open the worktree's repo folders in the configured editor (all in one window);
  // works whether or not the server is running — it's just the checkout on disk
  openEditor(tgt) {
    const paths = this.wtRepos(tgt).map((r) => r.worktreePath);
    if (paths.length) this.code.openEditorPaths(paths, `worktree ${tgt.name}`);
  }
  // ── autologin URLs against the worktree server's port ("" when not running) ──
  odooUrl(tgt) {
    const port = this.port(tgt);
    return port ? `http://localhost:${port}/dev/autologin?to=${encodeURIComponent("/odoo?debug=assets")}` : "";
  }
  testsUrl(tgt) {
    const port = this.port(tgt);
    return port ? `http://localhost:${port}/dev/autologin?to=${encodeURIComponent(
      "/web/tests?debug=assets&timeout=500000&manual=true"
    )}` : "";
  }
  _error(title, message) {
    this.dialogs.open({ title, message, cls: "dialog-error", okLabel: "OK", cancelLabel: null });
    return false;
  }
};

// static/src/core/dialogs.js
var RemoteBranchDialog = class extends Component {
  static template = xml`
    <div class="dialog-backdrop" t-on-click="() => this.done(null)">
      <div class="dialog rbd" t-on-click.stop="() => {}">
        <h2 class="dialog-title">Target from remote branch</h2>
        <div class="dialog-body">
          <div class="dialog-field">
            <label>Branch name</label>
            <input type="text" class="rbd-input" t-ref="this.inputEl"
                   placeholder="type to search across all repos…"
                   t-on-input="(ev) => this.onInput(ev.target.value)"
                   t-on-keydown="(ev) => this.onKey(ev)"/>
          </div>
          <div class="rbd-results">
            <div t-if="this.loading()" class="rbd-status">Searching…</div>
            <div t-elif="this.searched() and !this.rows().length" class="rbd-status">No matching branches found.</div>
            <div t-foreach="this.rows()" t-as="r" t-key="r.branch"
                 class="rbd-row" t-att-class="{selected: this.sel() === r.branch}"
                 t-on-click="() => this.sel.set(r.branch)">
              <span class="rbd-branch" t-out="r.branch"/>
              <span class="rbd-repos" t-out="r.repos.join(', ')"/>
            </div>
          </div>
        </div>
        <div class="dialog-foot">
          <button class="pbtn primary" t-att-disabled="!this.sel()" t-on-click="() => this.ok()">Create target</button>
          <button class="pbtn" t-on-click="() => this.done(null)">Cancel</button>
        </div>
      </div>
    </div>`;
  props = props({ done: t.function() });
  config = plugin(ConfigPlugin);
  loading = signal(false);
  searched = signal(false);
  rows = signal([]);
  sel = signal("");
  inputEl = signal.ref(HTMLElement);
  _timer = null;
  setup() {
    onMounted(() => this.inputEl()?.focus());
    const onKey = (e) => {
      if (e.key === "Escape") this.done(null);
    };
    document.addEventListener("keydown", onKey);
    onWillUnmount(() => {
      document.removeEventListener("keydown", onKey);
      clearTimeout(this._timer);
    });
  }
  done(result) {
    this.props.done(result);
  }
  onInput(val) {
    this.sel.set("");
    clearTimeout(this._timer);
    if (!val.trim()) {
      this.loading.set(false);
      this.searched.set(false);
      this.rows.set([]);
      return;
    }
    this.loading.set(true);
    this._timer = setTimeout(() => this._search(val.trim()), 300);
  }
  async _search(query) {
    const repos = this.config.config.repos.filter((r) => r.github).map((r) => ({ id: r.id, github: r.github }));
    try {
      const res = await fetch("/api/code/remote-branches/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repos, query })
      });
      const data = await res.json();
      if (!data.ok) return;
      const byBranch = {};
      for (const { repo, branch } of data.results) {
        if (!byBranch[branch]) byBranch[branch] = [];
        byBranch[branch].push(repo);
      }
      this.rows.set(Object.entries(byBranch).map(([branch, repos2]) => ({ branch, repos: repos2 })));
    } finally {
      this.loading.set(false);
      this.searched.set(true);
    }
  }
  onKey(ev) {
    if (ev.key === "Enter" && this.sel()) this.ok();
  }
  ok() {
    if (!this.sel()) return;
    const branch = this.sel();
    const repos = this.rows().find((r) => r.branch === branch)?.repos || [];
    this.done({ branch, repos });
  }
};
var CommitsDialog = class extends Component {
  static template = xml`
    <div class="term-panel commits-panel" t-ref="this.drag.handle">
      <div class="term-panel-head" t-on-mousedown="this.drag.onDragStart">
        <span class="term-panel-title" t-att-title="this.props.path" t-out="this.props.label"/>
        <button class="event-log-x" title="close" t-on-click="() => this.done(null)">✕</button>
      </div>
      <div class="commits-body">
        <div t-if="this.loading()" class="commits-empty">loading…</div>
        <div t-elif="this.error()" class="commits-empty" t-out="this.error()"/>
        <div t-elif="!this.commits().length" class="commits-empty">no commits</div>
        <t t-else="">
          <t t-foreach="this.commits()" t-as="c" t-key="c.sha">
            <div class="commit-row" t-att-class="{expanded: this.isExpanded(c.sha)}" t-on-click="() => this.toggle(c.sha)">
              <span class="commit-when" t-att-title="c.date" t-out="this.when(c.date)"/>
              <span class="commit-subject" t-att-title="c.subject" t-out="c.subject"/>
              <span class="commit-author" t-out="c.author"/>
            </div>
            <div t-if="this.isExpanded(c.sha)" class="commit-detail">
              <div class="commit-detail-meta">
                <a t-if="this.props.github" class="commit-detail-hash" target="_blank" t-att-href="this.commitUrl(c)" t-att-title="'open ' + c.sha + ' on GitHub'"><t t-out="c.sha"/><t t-out="this.externalIcon"/></a>
                <span t-else="" class="commit-detail-hash" t-out="c.sha"/>
                <span class="commit-detail-date" t-out="this.fullDate(c.date)"/>
              </div>
              <pre class="commit-body" t-out="this.message(c)"/>
            </div>
          </t>
        </t>
      </div>
      <div class="term-panel-resize" t-on-mousedown="this.drag.onResizeStart"/>
    </div>`;
  props = props({
    done: t.function(),
    path: t.string(),
    label: t.string(),
    ref: t.string(),
    github: t.string().optional()
  });
  code = plugin(CodePlugin);
  externalIcon = m(ICONS.external);
  commits = signal([]);
  loading = signal(true);
  error = signal("");
  expanded = signal(/* @__PURE__ */ new Set());
  setup() {
    this.drag = useDragResize({ w: 620, h: 460 });
    onMounted(() => this.load());
    const onKey = (e) => {
      if (e.key === "Escape") this.done(null);
    };
    document.addEventListener("keydown", onKey);
    onWillUnmount(() => document.removeEventListener("keydown", onKey));
  }
  async load() {
    try {
      this.commits.set(await this.code.commits(this.props.path, this.props.ref));
    } catch (e) {
      this.error.set(e.message);
    } finally {
      this.loading.set(false);
    }
  }
  when(date) {
    return timeAgo(date);
  }
  fullDate(date) {
    const d = new Date(date);
    return isNaN(d) ? date : d.toLocaleString();
  }
  toggle(sha) {
    const s = new Set(this.expanded());
    if (s.has(sha)) s.delete(sha);
    else s.add(sha);
    this.expanded.set(s);
  }
  isExpanded(sha) {
    return this.expanded().has(sha);
  }
  // full commit message (subject + body) shown when a row is expanded
  message(c) {
    return c.body ? `${c.subject}

${c.body}` : c.subject;
  }
  // the commit on GitHub (only linked when the repo has a github slug)
  commitUrl(c) {
    return `https://github.com/${this.props.github}/commit/${c.sha}`;
  }
  done(result) {
    this.props.done(result);
  }
};

// static/src/targets_screen/targets.js
async function createTargetFromRemoteBranch(config, eventLog, dialogs, branch, repos) {
  const existingTargets = config.config.targets;
  const configStr = repos.map((r) => `${r}:${branch}`).join(",");
  const res = await dialogs.open({
    title: "New target from remote branch",
    okLabel: "Create",
    validate: (v) => {
      const name = (v.name || "").trim();
      if (!name) return "a name is required";
      if (existingTargets.some((t2) => t2.name === name))
        return `a target named "${name}" already exists`;
      if (!repoBranchList.parse((v.config || "").trim()).length) return "a config is required";
      return "";
    },
    fields: [
      { key: "name", type: "text", label: "Name", value: branch, placeholder: "target name" },
      {
        key: "config",
        type: "text",
        label: "Config",
        value: configStr,
        placeholder: "community:branch,enterprise:branch"
      },
      { key: "db", type: "text", label: "Database", value: branch, placeholder: "database name" },
      { key: "args", type: "text", label: "Start args", placeholder: "-i sale_management" },
      { key: "demoData", type: "checkbox", label: "Demo data", value: true },
      { key: "fav", type: "checkbox", label: "Favorite", value: false }
    ]
  });
  if (!res) return;
  const target = {
    id: newTargetId(),
    name: res.name.trim(),
    favorite: !!res.fav,
    kind: "plain",
    checkouts: repoBranchList.parse(res.config.trim()),
    db: (res.db || "").trim(),
    on_create_args: (res.args || "").trim(),
    demo_data: !!res.demoData
  };
  eventLog.add(`creating target ${target.name} from remote branch ${branch}`);
  config.updateConfig({ targets: [...config.config.targets, target] });
}
async function activateTarget(server, code, eventLog, target) {
  const pathByRepo = code.groups().pathByRepo;
  const repos = (target.checkouts || []).map(({ repo, branch }) => ({ repo, path: pathByRepo[repo], branch })).filter((r) => r.path);
  eventLog.add(`activating target ${target.name}`);
  const s = server.status().state;
  const stopping = s === "running" || s === "starting" ? server.stop() : null;
  await Promise.all([stopping, code.checkout(repos)]);
  server.setLastTarget(target.id);
}
async function startCreateTarget(config, eventLog, code, dialogs, db, server) {
  const existingTargets = config.config.targets;
  await db.load();
  const dbNames = new Set(db.databases().map((d) => d.name));
  const dbOptions = db.databases().map((d) => ({ value: d.name, label: d.name }));
  const res = await dialogs.open({
    title: "New target",
    okLabel: "Create",
    validate: (v) => {
      const name = (v.name || "").trim();
      if (!name) return "a name is required";
      if (existingTargets.some((t2) => t2.name === name))
        return `a target named "${name}" already exists`;
      if (!repoBranchList.parse((v.config || "").trim()).length) return "a config is required";
      if ((v.cloneDb || "") && !(v.db || "").trim())
        return "set a database name to clone the selected database into";
      return "";
    },
    fields: [
      {
        key: "template",
        type: "select",
        label: "Template",
        placeholder: "\u2014 start blank \u2014",
        options: existingTargets.map((t2) => ({ value: t2.id, label: t2.name })),
        value: "",
        onChange: (tplId) => {
          if (!tplId) return null;
          const tpl = existingTargets.find((t2) => t2.id === tplId);
          if (!tpl) return null;
          const branchName = tpl.checkouts.find((c) => c.repo === "enterprise")?.branch || tpl.checkouts.find((c) => c.repo === "community")?.branch || "";
          return {
            name: branchName,
            config: repoBranchList.format(tpl.checkouts),
            db: tpl.db || "",
            args: tpl.on_create_args || "",
            demoData: tpl.demo_data ?? true,
            fav: !!tpl.favorite
          };
        }
      },
      {
        key: "name",
        type: "text",
        label: "Name",
        placeholder: "name (e.g. master-mytask)",
        onChange: (newName, currentValues, oldValues) => {
          const oldName = oldValues.name;
          if (!oldName) return null;
          return {
            config: (currentValues.config || "").replaceAll(oldName, newName),
            db: (currentValues.db || "").replaceAll(oldName, newName)
          };
        }
      },
      {
        key: "config",
        type: "text",
        label: "Config",
        placeholder: "community:master,enterprise:master"
      },
      { key: "db", type: "text", label: "Database", placeholder: "database name" },
      { key: "args", type: "text", label: "Start args", placeholder: "-i sale_management" },
      {
        // off by default; tick it to clone an existing db into the target's db. The
        // revealed select is seeded with the template's db (when it's on disk), else
        // the first database — see Dialog.toggleCheckSelect.
        key: "cloneDb",
        type: "check-select",
        label: "Clone db",
        options: dbOptions,
        value: "",
        default: (v) => {
          const tpl = existingTargets.find((t2) => t2.id === v.template);
          if (tpl?.db && dbNames.has(tpl.db)) return tpl.db;
          return dbOptions[0]?.value || "";
        }
      },
      { key: "demoData", type: "checkbox", label: "Demo data", value: true },
      { key: "fav", type: "checkbox", label: "Favorite", value: false },
      { key: "createBranches", type: "checkbox", label: "Create branches", value: true },
      { key: "activate", type: "checkbox", label: "Activate it", value: true }
    ]
  });
  if (!res) return;
  const target = {
    id: newTargetId(),
    name: res.name.trim(),
    favorite: !!res.fav,
    kind: "plain",
    checkouts: repoBranchList.parse(res.config.trim()),
    db: (res.db || "").trim(),
    on_create_args: (res.args || "").trim(),
    demo_data: !!res.demoData
  };
  eventLog.add(`creating target ${target.name}`);
  config.updateConfig({ targets: [...config.config.targets, target] });
  if (res.createBranches && code) {
    const tpl = existingTargets.find((t2) => t2.id === res.template);
    const baseBranchByRepo = Object.fromEntries(
      (tpl?.checkouts || []).map((c) => [c.repo, c.branch])
    );
    const pathByRepo = Object.fromEntries(config.config.repos.map((r) => [r.id, r.path]));
    await code.createBranches(
      target.checkouts.map((c) => ({
        path: pathByRepo[c.repo],
        name: c.branch,
        startPoint: baseBranchByRepo[c.repo]
      }))
    );
  }
  if (res.activate && server) {
    await activateTarget(server, code, eventLog, target);
  }
  if (res.cloneDb && target.db && res.cloneDb !== target.db) {
    await db.cloneStoppingServer(res.cloneDb, target.db);
  }
}
async function pushBranchesDialog(code, dialogs, branches, { title, message, force = false }) {
  if (!branches.length) return;
  const ok = await dialogs.open({ title, message, okLabel: force ? "Force push" : "Push" });
  if (!ok) return;
  for (const b of branches) await code.pushBranchNoConfirm(b.path, b.branch, true, force);
}
async function deleteTargetDialog(tgt, { config, code, db, eventLog, repoMap, isActive, dialogs }) {
  if (isActive) return;
  const groups = code.groups();
  const branches = (tgt.checkouts || []).map(({ repo, branch }) => ({ repo, branch, b: repoMap[repo]?.branches.get(branch) })).filter((x) => x.b && !BASE_BRANCH_RE.test(x.branch)).map((x) => ({
    repo: x.repo,
    branch: x.branch,
    path: groups.pathByRepo[x.repo],
    remote: !!x.b.remote
  }));
  const prs = (tgt.checkouts || []).map(({ repo, branch }) => ({
    pr: groups.prIndex[`${repo}:${branch}`],
    github: groups.githubByRepo[repo]
  })).filter((x) => x.pr && x.pr.state === "open" && x.github).map((x) => ({ github: x.github, number: x.pr.number }));
  const fields2 = [];
  if (branches.length)
    fields2.push({
      key: "delBranches",
      type: "checkbox",
      label: `Also delete ${branches.length === 1 ? "its branch" : `its ${branches.length} branches`}`,
      value: true
    });
  if (branches.some((b) => b.remote))
    fields2.push({
      key: "delRemote",
      type: "checkbox",
      label: "\u2026also on the remote (odoo-dev)",
      value: true
    });
  if (prs.length)
    fields2.push({
      key: "closePrs",
      type: "checkbox",
      label: `Close ${prs.length === 1 ? "its open pull request" : `its ${prs.length} open pull requests`}`,
      value: true
    });
  const dbExists = tgt.db && db.databases().some((d) => d.name === tgt.db);
  if (dbExists)
    fields2.push({
      key: "dropDb",
      type: "checkbox",
      label: `Drop database "${tgt.db}"`,
      value: true
    });
  const res = await dialogs.open({
    title: `Delete "${tgt.name}"?`,
    message: "The target will be removed from your list. This cannot be undone.",
    okLabel: "Delete",
    fields: fields2
  });
  if (!res) return;
  eventLog.add(`deleting target ${tgt.name}`);
  const ops = [];
  if (res.closePrs) for (const p of prs) ops.push(code.closePrNoConfirm(p.github, p.number));
  if (res.delBranches)
    for (const b of branches)
      ops.push(code.deleteBranchNoConfirm(b.branch, b.repo, b.path, !!res.delRemote && b.remote));
  if (res.dropDb && tgt.db) ops.push(db.drop(tgt.db));
  await Promise.all(ops);
  config.updateConfig({ targets: config.config.targets.filter((t2) => t2.id !== tgt.id) });
}
var TargetsScreen = class extends Component {
  static template = xml`
    <section>
      <div class="panel">
        <div class="panel-top"><h1>Targets</h1></div>
        <div class="panel-actions">
          <button class="pbtn primary" t-on-click="() => this.startCreate()">New target</button>
          <button class="pbtn" t-on-click="() => this.targetFromRemoteBranch()">From remote branch</button>
          <button t-if="this.selectedCount" class="pbtn danger" t-on-click="() => this.deleteSelected()">Delete <t t-out="this.selectedCount"/></button>
          <span t-if="this.error()" class="form-error" t-out="this.error()"/>
          <span class="row-count" t-out="this.count"/>
        </div>
      </div>
      <div class="content br-fill">
        <div>
          <div t-if="!this.targets.length" class="dim br-empty">No targets.</div>
          <div t-else="" class="br-card">
            <!-- full-width card = scroll container (scrollbar on the right); the
                 wrapper sizes the table to its natural width, like the Branches list -->
            <div class="brg-table">
            <table class="br-table brg-flat">
              <thead>
                <tr><th><input type="checkbox" class="br-select" t-att-checked="this.allSelected" t-on-change="() => this.toggleSelectAll()" title="select all targets"/></th><th>Name</th><th/><th>Config</th><th>Database</th><th>Start args</th><th>Demo data</th><th/></tr>
              </thead>
              <tbody>
                <tr t-foreach="this.targets" t-as="tgt" t-key="tgt.id" t-att-class="{'br-editing': this.editId() === tgt.id, active: this.isActive(tgt), 'row-sel': this.selected().has(tgt.id), dragging: this.dragId() === tgt.id, 'drag-over': this.dragOverId() === tgt.id}" t-on-dragover="ev => this.onDragOver(ev, tgt)" t-on-drop="ev => this.onDrop(ev, tgt)">
                  <td>
                    <input type="checkbox" class="br-select" t-att-checked="this.selected().has(tgt.id)" t-on-change="() => this.toggleSelect(tgt.id)" title="select this target for batch actions"/>
                  </td>
                  <t t-if="this.editId() === tgt.id">
                    <td><input type="text" class="cell-input" t-att-value="this.draftName()" placeholder="name" t-on-input="ev => this.draftName.set(ev.target.value)" t-on-keydown="ev => this.onEditKey(ev)"/></td>
                    <td><button class="fav-star" t-att-class="{'is-fav': tgt.favorite}" title="Favorite targets show up on the Dashboard" t-on-click="() => this.toggleFavorite(tgt.id)"><t t-out="this.starIcon"/></button></td>
                    <td><input type="text" class="cell-input wide" t-att-value="this.draftConfig()" placeholder="community:master,enterprise:master" t-on-input="ev => this.draftConfig.set(ev.target.value)" t-on-keydown="ev => this.onEditKey(ev)"/></td>
                    <td><input type="text" class="cell-input" t-att-value="this.draftDb()" placeholder="database" t-on-input="ev => this.draftDb.set(ev.target.value)" t-on-keydown="ev => this.onEditKey(ev)"/></td>
                    <td><input type="text" class="cell-input" t-att-value="this.draftArgs()" placeholder="-i sale_management" t-on-input="ev => this.draftArgs.set(ev.target.value)" t-on-keydown="ev => this.onEditKey(ev)"/></td>
                    <td><input type="checkbox" class="br-select" t-att-checked="tgt.demo_data" t-on-change="() => this.toggleDemoData(tgt.id)" title="load demo data when this target creates its database"/></td>
                    <td>
                      <div class="br-act">
                        <button class="drop-btn pr-close" t-on-click="() => this.saveEdit()">Save</button>
                        <button class="drop-btn" t-on-click="() => this.cancelEdit()">Cancel</button>
                      </div>
                    </td>
                  </t>
                  <t t-else="">
                    <td class="tgt-name-handle" draggable="true" title="drag to reorder" t-on-dragstart="ev => this.onDragStart(ev, tgt)" t-on-dragend="() => this.onDragEnd()" t-out="tgt.name"/>
                    <td><button class="fav-star" t-att-class="{'is-fav': tgt.favorite}" title="Favorite targets show up on the Dashboard" t-on-click="() => this.toggleFavorite(tgt.id)"><t t-out="this.starIcon"/></button></td>
                    <td class="dim"><div class="br-ellip" t-att-title="this.fmtConfig(tgt)" t-out="this.fmtConfig(tgt)"/></td>
                    <td t-out="tgt.db"/>
                    <td class="dim"><div class="br-ellip" t-att-title="tgt.on_create_args" t-out="tgt.on_create_args || '—'"/></td>
                    <td><input type="checkbox" class="br-select" t-att-checked="tgt.demo_data" t-on-change="() => this.toggleDemoData(tgt.id)" title="load demo data when this target creates its database"/></td>
                    <td>
                      <div class="br-act">
                        <button class="dash-kebab" title="target actions"
                                t-on-click.stop="(ev) => this.openRowMenu(ev, tgt)"><t t-out="this.kebabIcon"/></button>
                      </div>
                    </td>
                  </t>
                </tr>
              </tbody>
            </table>
            </div>
          </div>
        </div>
      </div>
    </section>`;
  config = plugin(ConfigPlugin);
  server = plugin(ServerPlugin);
  code = plugin(CodePlugin);
  db = plugin(DatabasePlugin);
  dialogs = plugin(DialogPlugin);
  eventLog = plugin(EventLogPlugin);
  starIcon = m(ICONS.star);
  kebabIcon = m(ICONS.kebab);
  editId = signal("");
  // id of the row being edited inline ("" = none)
  draftName = signal("");
  draftConfig = signal("");
  draftDb = signal("");
  draftArgs = signal("");
  error = signal("");
  // inline-edit validation error
  selected = signal(/* @__PURE__ */ new Set());
  // target ids ticked for batch actions
  dragId = signal("");
  // id of the target currently being dragged ("" = none)
  dragOverId = signal("");
  // id of the row the drag is hovering over
  // This screen does no git/network on mount — the table is just config, and the
  // active-row highlight is browser-side (see isActive). Branch / PR / db state is
  // pulled lazily, scoped to the repos of the target(s) involved, when a kebab or
  // batch action actually needs it (see openRowMenu, _loadForDelete).
  // the deduped set of repo ids used by the given targets — to scope the lazy reads
  _repoIdsFor(targets) {
    const ids = /* @__PURE__ */ new Set();
    for (const t2 of targets) for (const c of t2.checkouts || []) ids.add(c.repo);
    return ids;
  }
  // branches + open PRs + the db list for the given targets' repos: what the delete
  // dialog needs to offer "also delete branches / close PRs / drop db"
  async _loadForDelete(targets) {
    const ids = this._repoIdsFor(targets);
    await Promise.all([this.code.load(false, ids, ids), this.db.load()]);
  }
  // repo id -> { current branch, dirty, branches map } — for the activate checks
  get repoMap() {
    const map = {};
    for (const repo of this.code.branchRepos()) {
      map[repo.id] = {
        current: repo.current,
        dirty: repo.dirty,
        branches: new Map((repo.branches || []).map((b) => [b.name, b]))
      };
    }
    return map;
  }
  // the active target: the explicit one (set on Activate / Start). A browser-side
  // fact — the running server's code + database belong to the last-activated target
  // regardless of what's currently checked out — so it needs no git read, which is
  // what lets this screen skip the per-repo branch scan on a passive visit. The id
  // check disambiguates overlapping targets (e.g. master vs master(e)).
  isActive(tgt) {
    const s = this.server.status();
    const id = s.state === "running" || s.state === "starting" ? s.target : this.server.lastTarget();
    return tgt.id === id;
  }
  _targetDirty(tgt) {
    const repos = this.repoMap;
    return (tgt.checkouts || []).some(({ repo }) => repos[repo]?.dirty);
  }
  _targetPresent(tgt) {
    const repos = this.repoMap;
    return (tgt.checkouts || []).every(({ repo, branch }) => repos[repo]?.branches.has(branch));
  }
  canActivate(tgt) {
    return !this.isActive(tgt) && this._targetPresent(tgt) && !this._targetDirty(tgt);
  }
  activateTitle(tgt) {
    if (this.isActive(tgt)) return "this target is already active";
    if (this._targetDirty(tgt)) return "commit or stash changes first \u2014 the working tree is dirty";
    if (!this._targetPresent(tgt)) return "some of this target's branches are missing locally";
    return "stop the server, switch to this target and check out its branches";
  }
  // stop the server, switch to this target, check out its branches — the action lives
  // on the Target model (it drives ServerPlugin/CodePlugin/EventLog itself)
  async activate(tgt) {
    if (!this.canActivate(tgt)) return;
    await this.config.target(tgt.id)?.activate();
  }
  // the configured order — reorderable by dragging a row's name
  get targets() {
    return this.config.config.targets;
  }
  onDragStart(ev, tgt) {
    this.dragId.set(tgt.id);
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", tgt.id);
  }
  onDragOver(ev, tgt) {
    if (!this.dragId()) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    if (this.dragOverId() !== tgt.id) this.dragOverId.set(tgt.id);
  }
  onDrop(ev, tgt) {
    ev.preventDefault();
    this.reorderTargets(this.dragId(), tgt.id);
    this.onDragEnd();
  }
  onDragEnd() {
    this.dragId.set("");
    this.dragOverId.set("");
  }
  // move the dragged target to sit immediately before the drop target
  reorderTargets(fromId, toId) {
    if (!fromId || fromId === toId) return;
    const targets = [...this.config.config.targets];
    const from = targets.findIndex((t2) => t2.id === fromId);
    if (from < 0) return;
    const [moved] = targets.splice(from, 1);
    const to = targets.findIndex((t2) => t2.id === toId);
    if (to < 0) return;
    targets.splice(to, 0, moved);
    this.config.updateConfig({ targets });
  }
  get count() {
    const n = this.targets.length;
    return `${n} target${n === 1 ? "" : "s"}`;
  }
  fmtConfig(tgt) {
    return this.config.target(tgt.id)?.checkoutsLabel() ?? (tgt.checkouts || []).map((c) => `${c.repo}:${c.branch}`).join(", ");
  }
  toggleFavorite(id) {
    this.config.target(id)?.toggleFavorite();
  }
  toggleDemoData(id) {
    this.config.target(id)?.toggleDemoData();
  }
  toggleSelect(id) {
    const sel = new Set(this.selected());
    sel.has(id) ? sel.delete(id) : sel.add(id);
    this.selected.set(sel);
  }
  get _selectableTargets() {
    return this.targets.filter((t2) => !this.isActive(t2));
  }
  get allSelected() {
    const sel = this.selected();
    const selectable = this._selectableTargets;
    return selectable.length > 0 && selectable.every((t2) => sel.has(t2.id));
  }
  toggleSelectAll() {
    this.selected.set(
      this.allSelected ? /* @__PURE__ */ new Set() : new Set(this._selectableTargets.map((t2) => t2.id))
    );
  }
  get _selectedTargets() {
    const sel = this.selected();
    return this.targets.filter((t2) => sel.has(t2.id) && !this.isActive(t2));
  }
  get selectedCount() {
    return this._selectedTargets.length;
  }
  async deleteSelected() {
    const targets = this._selectedTargets;
    if (!targets.length) return;
    await this._loadForDelete(targets);
    const repos = this.repoMap;
    const groups = this.code.groups();
    const allBranches = targets.flatMap(
      (tgt) => (tgt.checkouts || []).map(({ repo, branch }) => ({ repo, branch, b: repos[repo]?.branches.get(branch) })).filter((x) => x.b && !BASE_BRANCH_RE.test(x.branch)).map((x) => ({
        repo: x.repo,
        branch: x.branch,
        path: groups.pathByRepo[x.repo],
        remote: !!x.b.remote
      }))
    );
    const allPrs = targets.flatMap(
      (tgt) => (tgt.checkouts || []).map(({ repo, branch }) => ({
        pr: groups.prIndex[`${repo}:${branch}`],
        github: groups.githubByRepo[repo]
      })).filter((x) => x.pr && x.pr.state === "open" && x.github).map((x) => ({ github: x.github, number: x.pr.number }))
    );
    const existingDbs = this.db.databases().map((d) => d.name);
    const allDbs = [
      ...new Set(targets.map((t2) => t2.db).filter((db) => db && existingDbs.includes(db)))
    ];
    const n = targets.length;
    const fields2 = [];
    if (allBranches.length)
      fields2.push({
        key: "delBranches",
        type: "checkbox",
        label: `Also delete ${allBranches.length === 1 ? "their branch" : `their ${allBranches.length} branches`}`,
        value: true
      });
    if (allBranches.some((b) => b.remote))
      fields2.push({
        key: "delRemote",
        type: "checkbox",
        label: "\u2026also on the remote (odoo-dev)",
        value: true
      });
    if (allPrs.length)
      fields2.push({
        key: "closePrs",
        type: "checkbox",
        label: `Close ${allPrs.length === 1 ? "their open pull request" : `their ${allPrs.length} open pull requests`}`,
        value: true
      });
    if (allDbs.length)
      fields2.push({
        key: "dropDbs",
        type: "checkbox",
        label: `Drop ${allDbs.length === 1 ? `database "${allDbs[0]}"` : `their ${allDbs.length} databases`}`,
        value: true
      });
    const res = await this.dialogs.open({
      title: `Delete ${n} target${n === 1 ? "" : "s"}?`,
      message: "The targets will be removed from your list. This cannot be undone.",
      okLabel: "Delete",
      fields: fields2
    });
    if (!res) return;
    for (const t2 of targets) this.eventLog.add(`deleting target ${t2.name}`);
    const ops = [];
    if (res.closePrs)
      for (const p of allPrs) ops.push(this.code.closePrNoConfirm(p.github, p.number));
    if (res.delBranches)
      for (const b of allBranches)
        ops.push(
          this.code.deleteBranchNoConfirm(b.branch, b.repo, b.path, !!res.delRemote && b.remote)
        );
    if (res.dropDbs) for (const db of allDbs) ops.push(this.db.drop(db));
    await Promise.all(ops);
    const deletedIds = new Set(targets.map((t2) => t2.id));
    this.config.updateConfig({
      targets: this.config.config.targets.filter((t2) => !deletedIds.has(t2.id))
    });
    this.selected.set(/* @__PURE__ */ new Set());
  }
  // create a new target through a dialog form (validated before it closes)
  startCreate() {
    return startCreateTarget(
      this.config,
      this.eventLog,
      this.code,
      this.dialogs,
      this.db,
      this.server
    );
  }
  // search for a remote branch across all repos, fetch it locally, then open
  // the prefilled target creation dialog
  async targetFromRemoteBranch() {
    const res = await this.dialogs.openComponent(RemoteBranchDialog);
    if (!res) return;
    const { branch, repos } = res;
    const pathByRepo = this.code.groups().pathByRepo;
    for (const repoId of repos) {
      const path = pathByRepo[repoId];
      if (!path) continue;
      await fetch("/api/code/remote-branch/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, branch })
      });
    }
    await createTargetFromRemoteBranch(this.config, this.eventLog, this.dialogs, branch, repos);
  }
  // regroup the per-target actions into the floating kebab menu (shared ActionMenu)
  async openRowMenu(ev, tgt) {
    const rect = ev.currentTarget.getBoundingClientRect();
    await this.code.loadBranches(this._repoIdsFor([tgt]));
    const active = this.isActive(tgt);
    const actions = [
      { label: "Edit", onClick: () => this.startEdit(tgt) },
      {
        label: "Apply",
        disabled: !this.canActivate(tgt),
        title: this.activateTitle(tgt),
        onClick: () => this.activate(tgt)
      },
      { label: "Duplicate", onClick: () => this.duplicateTarget(tgt) },
      {
        label: "Delete",
        danger: true,
        disabled: active,
        title: active ? "the active target cannot be deleted" : "",
        onClick: () => this.deleteTarget(tgt)
      }
    ];
    appBus.dispatchEvent(new CustomEvent("action-menu", { detail: { rect, actions } }));
  }
  // turn one row into inline inputs, pre-filled with the target's values
  // (only one row is editable at a time)
  startEdit(tgt) {
    this.draftName.set(tgt.name);
    this.draftConfig.set(repoBranchList.format(tgt.checkouts));
    this.draftDb.set(tgt.db || "");
    this.draftArgs.set(tgt.on_create_args || "");
    this.error.set("");
    this.editId.set(tgt.id);
  }
  // commit the inline edit back onto the target (favorite is left untouched —
  // it is toggled directly via the star)
  saveEdit() {
    const id = this.editId();
    const name = this.draftName().trim();
    if (!name) return this.error.set("a name is required");
    if (this.config.config.targets.some((t2) => t2.name === name && t2.id !== id))
      return this.error.set(`a target named "${name}" already exists`);
    const checkouts = repoBranchList.parse(this.draftConfig().trim());
    if (!checkouts.length) return this.error.set("a config is required");
    this.config.target(id).applyEdit({
      name,
      checkouts,
      db: this.draftDb().trim(),
      on_create_args: this.draftArgs().trim()
    });
    this.cancelEdit();
  }
  cancelEdit() {
    this.editId.set("");
    this.error.set("");
  }
  // Enter saves the inline edit, Escape cancels it
  onEditKey(ev) {
    if (ev.key === "Enter") this.saveEdit();
    else if (ev.key === "Escape") this.cancelEdit();
  }
  // clone a target onto a chosen branch: ask (via a dialog) for a branch name —
  // prefilled from the first configured branch — and point every repo at it.
  // When "Create branches" is checked, also create that branch in each repo,
  // starting from the repo's branch in the original target (its base).
  async duplicateTarget(tgt) {
    const first = tgt.checkouts?.[0]?.branch || "master";
    const res = await this.dialogs.open({
      title: `Duplicate "${tgt.name}"`,
      fields: [
        {
          key: "branch",
          type: "text",
          label: "Branch name",
          value: first,
          placeholder: "branch (applied to all repos)"
        },
        { key: "create", type: "checkbox", label: "Create branches", value: true }
      ]
    });
    if (!res) return;
    const b = (res.branch || "").trim();
    if (!b) return;
    const names = new Set(this.config.config.targets.map((t2) => t2.name));
    let name = b;
    for (let i = 2; names.has(name); i++) name = `${b} (${i})`;
    const copy = {
      id: newTargetId(),
      name,
      favorite: !!tgt.favorite,
      kind: "plain",
      checkouts: (tgt.checkouts || []).map((c) => ({ repo: c.repo, branch: b })),
      db: b,
      // default the database to the branch name
      on_create_args: tgt.on_create_args || "",
      demo_data: tgt.demo_data ?? true
    };
    this.eventLog.add(`creating target ${copy.name}`);
    this.config.updateConfig({ targets: [...this.config.config.targets, copy] });
    if (res.create) {
      const pathByRepo = Object.fromEntries(this.config.config.repos.map((r) => [r.id, r.path]));
      await this.code.createBranches(
        (tgt.checkouts || []).map((c) => ({
          path: pathByRepo[c.repo],
          name: b,
          startPoint: c.branch
          // start from the base
        }))
      );
    }
  }
  async deleteTarget(tgt) {
    await this._loadForDelete([tgt]);
    return deleteTargetDialog(tgt, {
      config: this.config,
      code: this.code,
      db: this.db,
      eventLog: this.eventLog,
      repoMap: this.repoMap,
      dialogs: this.dialogs,
      isActive: this.isActive(tgt)
    });
  }
};
var repoBranchList = {
  format: (v) => (v || []).map((c) => `${c.repo}:${c.branch}`).join(","),
  parse: (s) => s.split(",").map((x) => x.trim()).filter(Boolean).map((pair) => {
    const [repo, branch = ""] = pair.split(":").map((p) => p.trim());
    return { repo, branch };
  })
};

// static/src/branches_screen/branches.js
var BranchesScreen = class extends Component {
  static components = { SearchBox, DirtyBadge };
  worktree = plugin(WorktreePlugin);
  // "wt" badge on branches owned by a worktree
  static template = xml`
    <section>
      <div class="panel">
        <div class="panel-top has-filters">
          <h1>Branches</h1>
          <div class="panel-filters">
            <SearchBox value="this.search"/>
            <select t-att-value="this.repoFilter()" t-on-change="ev => this.repoFilter.set(ev.target.value)" title="filter by repository">
              <option value="">All repositories</option>
              <option t-foreach="this.repos" t-as="r" t-key="r" t-att-value="r" t-out="r"/>
            </select>
          </div>
          <div class="panel-top-right">
            <span class="meta" t-out="this.stamp"/>
            <button class="pbtn" t-on-click="() => this.code.load(true)"><t t-out="this.refreshIcon"/>Refresh</button>
          </div>
        </div>
        <div class="panel-actions">
          <button t-if="this.selectedCount" class="pbtn danger" t-on-click="() => this.deleteSelected()">Delete <t t-out="this.selectedCount"/></button>
          <span class="row-count" t-out="this.count"/>
        </div>
      </div>
      <div class="content br-fill">
        <div t-att-class="{busy: this.code.busy()}">
          <div t-if="this.code.error()" class="dim br-empty" t-out="'Failed to load: ' + this.code.error()"/>
          <div t-elif="!this.groups().length" class="dim br-empty">No branches.</div>
          <div t-else="" class="br-card brg">
            <!-- full-width card = scroll container (scrollbar stays on the right);
                 this wrapper sizes to the table's natural width, left-aligned -->
            <div class="brg-table">
            <!-- column header: "Branch" over the name column, the rest over the repo rows -->
            <div class="brg-head">
              <div class="brg-name-head br-sort" t-on-click="() => this.sort('name')">
                <span t-on-click.stop=""><input type="checkbox" class="br-select" t-att-checked="this.allSelected" t-on-change="() => this.toggleSelectAll()" title="select all branches"/></span>
                Branch<span class="br-arrow" t-out="this.sortArrow('name')"/>
              </div>
              <div class="brg-cols brg-colhead">
                <span>Repository</span>
                <span class="br-sort" t-on-click="() => this.sort('update')">Last update<span class="br-arrow" t-out="this.sortArrow('update')"/></span>
                <span>Last commit</span>
                <span>PR</span>
                <span/>
              </div>
            </div>
            <!-- one group per branch name: the name shown once on the left, repo rows on the right -->
            <div t-foreach="this.groups()" t-as="g" t-key="g.name" class="brg-group" t-att-class="{'row-sel': this.selected().has(g.name)}">
              <div class="brg-name">
                <input type="checkbox" class="br-select" t-att-checked="this.selected().has(g.name)" t-on-change="() => this.toggleSelect(g.name)" title="select this branch for batch actions"/>
                <span class="br-branch select-toggle" t-on-click="() => this.toggleSelect(g.name)" t-out="g.name"/>
                <span t-if="this.worktree.isWorktreeBranch(g.name)" class="wt-badge" title="has a worktree">wt</span>
              </div>
              <div class="brg-rows">
                <div t-foreach="g.repos" t-as="r" t-key="r.repo" class="brg-cols brg-row" t-att-class="{active: r.active}">
                  <span class="brg-repo">
                    <a t-if="r.remote and r.github" class="br-repo-link" target="_blank" t-att-href="this.code.remoteBranchUrl(r.github, r.branch)" t-att-title="'open the ' + r.repo + ' branch on GitHub'"><t t-out="r.repo"/><t t-out="this.externalIcon"/></a>
                    <span t-else="" t-out="r.repo"/>
                    <DirtyBadge t-if="r.dirty" path="r.path" repo="r.repo"/>
                  </span>
                  <span class="brg-when" t-att-title="r.date" t-out="r.date ? this.cell(r.date) : '—'"/>
                  <span class="brg-commit" t-att-title="r.subject" t-out="r.subject || '—'"/>
                  <span class="brg-pr">
                    <t t-if="r.pr">
                      <a class="pr-link" target="_blank" t-att-href="r.pr.url" t-out="'#' + r.pr.number"/>
                      <span class="pr-state" t-att-class="this.prState(r.pr)" t-out="this.prState(r.pr)"/>
                    </t>
                    <span t-else="" class="brg-dash">—</span>
                  </span>
                  <span class="brg-act">
                    <button class="dash-kebab" title="branch actions"
                            t-on-click.stop="(ev) => this.openRowMenu(ev, r)"><t t-out="this.kebabIcon"/></button>
                  </span>
                </div>
              </div>
            </div>
            </div>
          </div>
        </div>
      </div>
    </section>`;
  code = plugin(CodePlugin);
  config = plugin(ConfigPlugin);
  dialogs = plugin(DialogPlugin);
  refreshIcon = m(ICONS.refresh);
  externalIcon = m(ICONS.external);
  kebabIcon = m(ICONS.kebab);
  repoFilter = signal("");
  // "" = all repositories
  search = signal("");
  selected = signal(/* @__PURE__ */ new Set());
  // branch names ticked for batch actions
  sortKey = signal("update");
  // "name" | "update" — default: most recently updated first
  sortDir = signal("desc");
  // "asc" | "desc"
  // branches grouped by name (one group per branch name). Each group carries its
  // repo rows and is "active" when the branch is checked out in any of its repos.
  // Sorted by the chosen column (branch name, or summed last-update time).
  groups = computed(() => {
    const { prIndex, pathByRepo, githubByRepo } = this.code.groups();
    const repoFilter = this.repoFilter();
    const q = this.search().trim().toLowerCase();
    const byBranch = /* @__PURE__ */ new Map();
    for (const repo of this.code.branchRepos()) {
      if (repo.error) continue;
      if (repoFilter && repo.id !== repoFilter) continue;
      for (const b of repo.branches) {
        if (q && !b.name.toLowerCase().includes(q) && !repo.id.toLowerCase().includes(q)) continue;
        if (!byBranch.has(b.name)) byBranch.set(b.name, []);
        byBranch.get(b.name).push({
          branch: b.name,
          repo: repo.id,
          path: pathByRepo[repo.id] || "",
          github: githubByRepo[repo.id] || "",
          remote: b.remote,
          base: BASE_BRANCH_RE.test(b.name),
          date: b.date,
          subject: b.subject || "",
          active: b.name === repo.current,
          dirty: b.name === repo.current && repo.dirty,
          repoDirty: repo.dirty,
          // the repo's working tree (its current branch)
          pr: prIndex[`${repo.id}:${b.name}`]
        });
      }
    }
    const dir = this.sortDir() === "asc" ? 1 : -1;
    const key = this.sortKey();
    return [...byBranch.entries()].map(([name, repos]) => ({
      name,
      base: BASE_BRANCH_RE.test(name),
      // combined last-update time for the branch (sum across its repos)
      updateSum: repos.reduce((s, r) => s + (Date.parse(r.date) || 0), 0),
      repos
    })).sort(
      (a, b) => key === "update" ? (a.updateSum - b.updateSum) * dir : a.name.localeCompare(b.name) * dir
    );
  });
  setup() {
    this.code.load();
  }
  // tick/untick a branch (by name) for batch actions
  toggleSelect(name) {
    const sel = new Set(this.selected());
    sel.has(name) ? sel.delete(name) : sel.add(name);
    this.selected.set(sel);
  }
  get allSelected() {
    const groups = this.groups();
    const sel = this.selected();
    return groups.length > 0 && groups.every((g) => sel.has(g.name));
  }
  toggleSelectAll() {
    this.selected.set(this.allSelected ? /* @__PURE__ */ new Set() : new Set(this.groups().map((g) => g.name)));
  }
  // selected branch groups that are still visible (a filter may hide some)
  get selectedGroups() {
    const sel = this.selected();
    return this.groups().filter((g) => sel.has(g.name));
  }
  // total branches (one per repo) across the selected groups, not group count
  get selectedCount() {
    return this.selectedGroups.reduce((n, g) => n + g.repos.length, 0);
  }
  // batch-delete every selected branch in each repo where it can be removed
  // (only the checked-out branch is skipped). Open PRs on the selected branches
  // can be closed first via a checkbox.
  async deleteSelected() {
    const groups = this.selectedGroups;
    if (!groups.length) return;
    const rows = groups.flatMap((g) => g.repos).filter((r) => !this.deleteBlocked(r));
    const total = groups.reduce((n, g) => n + g.repos.length, 0);
    const skipped = total - rows.length;
    const prs = rows.filter((r) => r.pr && r.pr.state === "open" && r.github);
    const remoteRows = rows.filter((r) => r.remote && !r.base);
    const what = groups.length === 1 ? `branch "${groups[0].name}"` : `${groups.length} branches`;
    const fields2 = [];
    if (remoteRows.length)
      fields2.push({
        key: "delRemote",
        type: "checkbox",
        label: `Also delete ${remoteRows.length === 1 ? "it" : "them"} on the remote (odoo-dev)`,
        value: false
      });
    if (prs.length)
      fields2.push({
        key: "closePrs",
        type: "checkbox",
        label: `Close ${prs.length === 1 ? "its open pull request" : `${prs.length} open pull requests`}`,
        value: true
      });
    const res = await this.dialogs.open({
      title: "Delete branches",
      message: `Delete ${what} in ${rows.length} repo${rows.length === 1 ? "" : "s"} locally?` + (skipped ? ` ${skipped} skipped (checked out).` : "") + " This cannot be undone.",
      okLabel: "Delete",
      fields: fields2
    });
    if (!res) return;
    if (res.closePrs) for (const r of prs) await this.code.closePrNoConfirm(r.github, r.pr.number);
    for (const r of rows)
      await this.code.deleteBranchNoConfirm(
        r.branch,
        r.repo,
        r.path,
        !!res.delRemote && r.remote && !r.base
      );
    this.selected.set(/* @__PURE__ */ new Set());
  }
  // single-row delete, confirmed via the dialog. When the branch has an open PR
  // it can be closed first; targets that reference this exact branch can be
  // removed in the same step.
  async deleteRow(r) {
    if (this.deleteBlocked(r)) return;
    const canRemote = r.remote && !r.base;
    const hasPr = !!(r.pr && r.pr.state === "open" && r.github);
    const targets = this.config.config.targets.filter(
      (t2) => (t2.checkouts || []).some((c) => c.repo === r.repo && c.branch === r.branch)
    );
    const fields2 = [];
    if (canRemote)
      fields2.push({
        key: "delRemote",
        type: "checkbox",
        label: "Also delete it on the remote (odoo-dev)",
        value: false
      });
    if (hasPr)
      fields2.push({
        key: "closePr",
        type: "checkbox",
        label: `Close PR #${r.pr.number}`,
        value: true
      });
    for (const t2 of targets)
      fields2.push({
        key: `tgt:${t2.id}`,
        type: "checkbox",
        label: `Delete target "${t2.name}"`,
        value: false
      });
    const res = await this.dialogs.open({
      title: `Delete "${r.branch}"?`,
      message: `Force-delete "${r.branch}" in ${r.repo} locally. This cannot be undone.`,
      okLabel: "Delete",
      fields: fields2
    });
    if (!res) return;
    if (hasPr && res.closePr) await this.code.closePrNoConfirm(r.github, r.pr.number);
    await this.code.deleteBranchNoConfirm(r.branch, r.repo, r.path, !!res.delRemote);
    const drop = targets.filter((t2) => res[`tgt:${t2.id}`]);
    if (drop.length) {
      const ids = new Set(drop.map((t2) => t2.id));
      for (const t2 of drop) this.code.eventLog.add(`deleting target ${t2.name}`);
      this.config.updateConfig({
        targets: this.config.config.targets.filter((t2) => !ids.has(t2.id))
      });
    }
  }
  // sort by a column; clicking the active column flips the direction
  sort(key) {
    if (this.sortKey() === key) {
      this.sortDir.set(this.sortDir() === "asc" ? "desc" : "asc");
    } else {
      this.sortKey.set(key);
      this.sortDir.set(key === "update" ? "desc" : "asc");
    }
  }
  // " ▲" / " ▼" for the active sort column, else ""
  sortArrow(key) {
    if (this.sortKey() !== key) return "";
    return this.sortDir() === "asc" ? " \u25B2" : " \u25BC";
  }
  // repositories present in the loaded data (for the filter dropdown)
  get repos() {
    return this.code.branchRepos().map((r) => r.id);
  }
  get count() {
    const n = this.groups().reduce((t2, g) => t2 + g.repos.length, 0);
    return `${n} branch${n === 1 ? "" : "es"}`;
  }
  openPr(row) {
    this.code.eventLog.add(`opening PR for ${row.branch} (${row.repo})`);
    window.open(this.code.prCreateUrl(row.github, row.branch), "_blank");
  }
  // build the per-branch action list for this row and open the floating kebab
  // menu anchored to the clicked button (see ActionMenu)
  openRowMenu(ev, r) {
    const rect = ev.currentTarget.getBoundingClientRect();
    const actions = [{ label: "Commits", onClick: () => this.openCommits(r) }];
    if (!r.remote)
      actions.push({
        label: "Push",
        title: "push this branch to the dev remote (odoo-dev)",
        onClick: () => this.pushBranch(r)
      });
    if (!r.base && r.remote && r.github && !r.pr)
      actions.push({ label: "Open PR", onClick: () => this.openPr(r) });
    if (r.pr && r.github && r.pr.state === "open")
      actions.push({
        label: "Close PR",
        danger: true,
        onClick: () => this.code.closePr(r.github, r.pr.number)
      });
    const coBlocked = this.checkoutBlocked(r);
    actions.push({
      label: "Checkout",
      disabled: !!coBlocked,
      title: coBlocked || `check out ${r.branch} in ${r.repo}`,
      onClick: () => this.checkout(r)
    });
    actions.push({
      label: "Duplicate",
      title: "create a new branch based on this one",
      onClick: () => this.duplicateBranch(r)
    });
    const delBlocked = this.deleteBlocked(r);
    actions.push({
      label: "Delete",
      danger: true,
      disabled: !!delBlocked,
      title: delBlocked || "",
      onClick: () => this.deleteRow(r)
    });
    appBus.dispatchEvent(new CustomEvent("action-menu", { detail: { rect, actions } }));
  }
  // why a branch can't be checked out ("" = allowed): already checked out, or the
  // repo's working tree is dirty (a checkout would fail / lose changes)
  checkoutBlocked(row) {
    if (row.active) return "this branch is already checked out";
    if (row.repoDirty) return "commit or stash changes first \u2014 the working tree is dirty";
    return "";
  }
  checkout(row) {
    if (this.checkoutBlocked(row)) return;
    this.code.eventLog.add(`checking out ${row.branch} (${row.repo})`);
    this.code.checkout([{ repo: row.repo, path: row.path, branch: row.branch }]);
  }
  pushBranch(row) {
    return pushBranchesDialog(this.code, this.dialogs, [{ path: row.path, branch: row.branch }], {
      title: `Push "${row.branch}"?`,
      message: `Push ${row.branch} (${row.repo}) to the dev remote (odoo-dev)?`
    });
  }
  // create a new branch based on this one (git branch <new> <branch> — no checkout)
  // show the last commits on this branch (in a floating dialog)
  openCommits(row) {
    if (!row.path) return;
    this.dialogs.openComponent(CommitsDialog, {
      path: row.path,
      ref: row.branch,
      label: `${row.repo} \xB7 ${row.branch}`,
      github: row.github || ""
    });
  }
  async duplicateBranch(row) {
    const res = await this.dialogs.open({
      title: `Duplicate "${row.branch}" (${row.repo})`,
      fields: [
        {
          key: "branch",
          type: "text",
          label: "New branch name",
          value: row.branch,
          placeholder: "new branch name"
        }
      ]
    });
    if (!res) return;
    const name = (res.branch || "").trim();
    if (!name) return;
    this.code.createBranch(row.path, name, row.branch);
  }
  // why a branch can't be deleted ("" = deletable). Deleting closes an open PR
  // (it removes the head branch), so require closing the PR first.
  deleteBlocked(row) {
    if (row.active) return "cannot delete the checked-out branch";
    return "";
  }
  get stamp() {
    if (this.code.loading()) return "refreshing\u2026";
    return this.code.at() ? `updated ${timeAgo(new Date(this.code.at()).toISOString())}` : "";
  }
  cell(date) {
    return timeAgo(date);
  }
  prState(p) {
    return p.draft && p.state === "open" ? "draft" : p.state;
  }
};

// static/src/core/terminal_plugin.js
var TerminalPlugin = class extends Plugin {
  open = signal(false);
  toggle() {
    this.open.set(!this.open());
  }
};

// static/src/core/terminal.js
var _xtermReady = null;
function loadXterm() {
  if (!_xtermReady) {
    _xtermReady = new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/static/lib/xterm/xterm.css";
      document.head.appendChild(link);
      const s1 = document.createElement("script");
      s1.src = "/static/lib/xterm/xterm.js";
      s1.onload = () => {
        const s2 = document.createElement("script");
        s2.src = "/static/lib/xterm/addon-fit.js";
        s2.onload = resolve;
        s2.onerror = reject;
        document.head.appendChild(s2);
      };
      s1.onerror = reject;
      document.head.appendChild(s1);
    });
  }
  return _xtermReady;
}
async function attachXterm(el, wsUrl, focusOnOpen = false) {
  await loadXterm();
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "var(--mono, monospace)"
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  await new Promise((r) => requestAnimationFrame(r));
  fit.fit();
  if (focusOnOpen) term.focus();
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";
  const sendSize = () => {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  };
  ws.onopen = sendSize;
  ws.onmessage = (e) => term.write(new Uint8Array(e.data));
  const onData = term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data));
  });
  const ro = new ResizeObserver(() => {
    fit.fit();
    sendSize();
  });
  ro.observe(el);
  return () => {
    ro.disconnect();
    onData.dispose?.();
    try {
      ws.close();
    } catch {
    }
    term.dispose();
  };
}
var TerminalPanel = class extends Component {
  static template = xml`
    <div t-if="this.term.open()" class="term-panel" t-ref="this.drag.handle">
      <div class="term-panel-head" t-on-mousedown="this.drag.onDragStart">
        <span class="term-panel-title">Terminal</span>
        <button class="event-log-x" t-on-click="() => this.term.toggle()" title="close">✕</button>
      </div>
      <div class="term-panel-body" t-ref="this.container"/>
      <div class="term-panel-resize" t-on-mousedown="this.drag.onResizeStart"/>
    </div>`;
  term = plugin(TerminalPlugin);
  container = signal.ref(HTMLElement);
  _dispose = null;
  _termOpen = false;
  // guard against double-open on re-renders
  setup() {
    this.drag = useDragResize();
    onWillUnmount(() => this._closeTerminal());
    useEffect(() => {
      const el = this.container();
      if (el) {
        this._openTerminal(el);
      } else {
        this._closeTerminal();
      }
    });
  }
  async _openTerminal(el) {
    if (this._termOpen) return;
    this._termOpen = true;
    try {
      const dispose = await attachXterm(el, `ws://${location.host}/api/terminal`);
      if (this.container() !== el) {
        dispose();
        return;
      }
      this._dispose = dispose;
    } catch (e) {
      this._termOpen = false;
    }
  }
  _closeTerminal() {
    if (!this._termOpen) return;
    this._termOpen = false;
    this._dispose?.();
    this._dispose = null;
  }
};
var TerminalDialog = class extends Component {
  static template = xml`
    <div class="term-panel" t-ref="this.drag.handle">
      <div class="term-panel-head" t-on-mousedown="this.drag.onDragStart">
        <span class="term-panel-title" t-att-title="this.props.path" t-out="this.label"/>
        <button class="event-log-x" title="close" t-on-click="() => this.done(null)">✕</button>
      </div>
      <div class="term-panel-body" t-ref="this.container"/>
      <div class="term-panel-resize" t-on-mousedown="this.drag.onResizeStart"/>
    </div>`;
  props = props({ done: t.function(), path: t.string(), label: t.string() });
  container = signal.ref(HTMLElement);
  _dispose = null;
  setup() {
    this.drag = useDragResize();
    useEffect(() => {
      const el = this.container();
      if (!el) return;
      let live = true;
      const url = `ws://${location.host}/api/shell?cwd=${encodeURIComponent(this.props.path)}`;
      attachXterm(el, url, true).then((dispose) => live ? this._dispose = dispose : dispose());
      return () => {
        live = false;
        this._dispose?.();
        this._dispose = null;
      };
    });
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      const el = this.container();
      if (el && el.contains(document.activeElement)) return;
      this.done(null);
    };
    document.addEventListener("keydown", onKey);
    onWillUnmount(() => document.removeEventListener("keydown", onKey));
  }
  get label() {
    return this.props.label || this.props.path;
  }
  done(result) {
    this.props.done(result);
  }
};

// static/src/code_screen/code.js
var CodeScreen = class extends Component {
  static components = { DirtyBadge };
  static template = xml`
    <section>
      <div class="panel">
        <div class="panel-top">
          <h1>Code</h1>
          <div class="panel-top-right">
            <span class="meta" t-out="this.stamp"/>
            <button class="pbtn" t-on-click="() => this._load(true)"><t t-out="this.refreshIcon"/>Refresh</button>
          </div>
        </div>
        <div class="panel-actions">
          <span class="dash-subtitle">Manage the main repository checkouts — switch branches, rebase, push and open them.</span>
        </div>
      </div>
      <div class="content">
        <div t-att-class="{busy: this.code.busy()}">
          <div t-foreach="this.errors" t-as="e" t-key="e.id" class="dim" t-out="e.id + ': ' + e.error"/>
          <div class="dash-layout">
          <!-- repositories sync strip: the repo list collapses to one row of chips,
               each carrying its sync health (up to date / N behind). Per-repo actions
               live in the chip's menu. -->
          <div t-if="this.favRepos.length" class="dash-repos">
            <div class="dash-repos-label">
              <span class="dash-repos-icon"><t t-out="this.addonsIcon"/></span>
              <span>Repos</span>
            </div>
            <div class="dash-repos-chips">
              <div t-foreach="this.favRepos" t-as="r" t-key="r.id" class="dash-chip" t-att-class="this.chipClass(r)" t-att-title="this.commitTip(r)" t-on-click.stop="() => this.toggleMenu('repo:' + r.id)">
                <span class="dash-chip-name" t-out="r.id"/>
                <span class="dash-chip-branch" t-att-title="r.current" t-out="r.current || '—'"/>
                <DirtyBadge t-if="r.dirty" path="r.path" repo="r.id"/>
                <span class="dash-chip-div"/>
                <span class="dash-chip-sync" t-att-title="this.syncTitle(r)"><span class="dash-chip-dot"/><t t-out="this.syncText(r)"/></span>
                <button t-if="r.behind and this.canRebaseRepo(r)" class="dash-chip-rebase" t-att-title="this.rebaseRepoTitle(r)" t-on-click.stop="() => this.rebaseRepo(r)">Rebase</button>
                <div class="dash-kebab-wrap">
                  <span class="dash-chip-caret" t-att-class="{open: this.menuId() === 'repo:' + r.id}"><t t-out="this.chevronIcon"/></span>
                  <div t-if="this.menuId() === 'repo:' + r.id" class="dash-menu">
                    <button class="dash-menu-item" t-att-disabled="!this.canRebaseRepo(r)" t-att-title="this.rebaseRepoTitle(r)" t-on-click="() => this.rebaseRepo(r)">Fetch &amp; rebase</button>
                    <button class="dash-menu-item" t-att-disabled="!this.canPushRepo(r)" t-att-title="this.pushRepoTitle(r)" t-on-click="() => this.pushRepo(r)">Push</button>
                    <button class="dash-menu-item" t-att-disabled="!this.canPushRepo(r)" t-att-title="this.pushRepoTitle(r)" t-on-click="() => this.pushForceRepo(r)">Push (force)</button>
                    <button t-if="r.canPr" class="dash-menu-item" t-on-click="() => this.openPr(r)">Open PR</button>
                    <button class="dash-menu-item" t-att-disabled="!r.path" t-on-click="() => this.openTerminal(r)">Open in terminal</button>
                    <button class="dash-menu-item" t-att-disabled="!r.path" t-on-click="() => this.code.openEditor(r.path, r.id)">Open with editor</button>
                    <button class="dash-menu-item" t-att-disabled="!r.path" t-on-click="() => this.openCommits(r)">See commits</button>
                    <button t-if="r.dirty" class="dash-menu-item" t-on-click="() => this.code.wipCommit(r.path, r.id)">WIP commit</button>
                    <button t-if="r.dirty" class="dash-menu-item danger" t-on-click="() => this.code.discard(r.path, r.id)">Discard changes</button>
                  </div>
                </div>
              </div>
            </div>
            <div class="dash-repos-actions">
              <button class="dash-rebase" t-att-disabled="!this.editorPaths.length" t-att-title="this.editAllTitle()" t-on-click="() => this.openAllEditors()">
                <t t-out="this.codeIcon"/>Edit
              </button>
              <button class="dash-rebase" t-att-disabled="!this.canRebaseAll()" t-att-title="this.rebaseAllTitle()" t-on-click="() => this.rebaseAll()">
                <t t-out="this.refreshIcon"/>Fetch &amp; rebase all
              </button>
            </div>
          </div>
          <div t-elif="this.code.error()" class="dim" t-out="'Failed to load: ' + this.code.error()"/>
          <div t-else="" class="dim">No repositories — mark repos as favorite in the Configuration tab to manage them here.</div>
          </div><!-- /.dash-layout -->
        </div>
      </div>
    </section>`;
  code = plugin(CodePlugin);
  config = plugin(ConfigPlugin);
  server = plugin(ServerPlugin);
  dialogs = plugin(DialogPlugin);
  eventLog = plugin(EventLogPlugin);
  refreshIcon = m(ICONS.refresh);
  addonsIcon = m(ICONS.addons);
  // "Repos" sync-strip label icon
  codeIcon = m(ICONS.code);
  // "Edit" (open all repos in the editor)
  chevronIcon = m(ICONS.chevron);
  // the repo chip's dropdown caret
  menuId = signal("");
  // id of the repo chip whose action menu is open ("" = none)
  setup() {
    this._load(false);
    const closeMenu = () => this.menuId() && this.menuId.set("");
    onMounted(() => document.addEventListener("click", closeMenu));
    onWillUnmount(() => document.removeEventListener("click", closeMenu));
  }
  toggleMenu(id) {
    this.menuId.set(this.menuId() === id ? "" : id);
  }
  get stamp() {
    if (this.code.loading()) return "refreshing\u2026";
    return this.code.at() ? `updated ${timeAgo(new Date(this.code.at()).toISOString())}` : "";
  }
  get errors() {
    return this.code.groups().errors;
  }
  // repo ids shown by the strip — favorite repos plus the current target's repos.
  // Narrow both the branch and PR fetch to these (the only repos this screen shows).
  _repoIds() {
    const ids = new Set(this.config.config.repos.filter((r) => r.favorite).map((r) => r.id));
    const current = this.config.config.targets.find((t2) => t2.id === this.server.lastTarget());
    for (const c of current?.checkouts || []) ids.add(c.repo);
    return ids;
  }
  _load(force) {
    const ids = this._repoIds();
    this.code.load(force, ids, ids);
  }
  // repositories shown in the strip: union of the active target's repos and the
  // favorite repositories, in config order
  get favRepos() {
    const byId = Object.fromEntries(this.code.branchRepos().map((r) => [r.id, r]));
    const groups = this.code.groups();
    const currentTarget = this.config.config.targets.find((t2) => t2.id === this.server.lastTarget());
    const visibleIds = /* @__PURE__ */ new Set([
      ...(currentTarget?.checkouts || []).map((c) => c.repo),
      ...this.config.config.repos.filter((r) => r.favorite).map((r) => r.id)
    ]);
    return this.config.config.repos.filter((r) => visibleIds.has(r.id)).map((r) => {
      const b = byId[r.id] || {};
      const current = b.current || "";
      const github = groups.githubByRepo[r.id] || "";
      const pr = groups.prIndex[`${r.id}:${current}`] || null;
      return {
        id: r.id,
        current,
        dirty: !!b.dirty,
        subject: b.head_subject || "",
        remote: !!b.head_remote,
        // the current branch has a remote-tracking ref
        date: b.head_date || "",
        ahead: b.ahead || 0,
        // commits ahead of the base (target) branch
        behind: b.behind || 0,
        // commits behind the base (target) branch
        base: this._baseBranch(current),
        error: b.error || "",
        github,
        path: groups.pathByRepo[r.id] || "",
        pr,
        // a work branch that's pushed and PR-less can have a PR opened for it
        canPr: !!(current && b.head_remote && github && !pr && !BASE_BRANCH_RE.test(current))
      };
    });
  }
  // the canonical base branch a branch derives from: master-owl-update -> master,
  // 19.0-some-fix -> 19.0 (defaults to master)
  _baseBranch(branch) {
    return (/^(saas-\d+\.\d+|\d+\.\d+|master)/.exec(branch) || ["", "master"])[1];
  }
  // commit tooltip: the last-commit date before the title
  commitTip(row) {
    const subject = row.subject || "\u2014";
    return row.date ? `${timeAgo(row.date)} \xB7 ${subject}` : subject;
  }
  // sync-strip chip: state class + health text. "behind" (needs a rebase onto its
  // base) is the headline; missing/unreadable repos read as an error, and a repo we
  // have no branch data for yet stays neutral rather than claiming "up to date".
  chipClass(r) {
    if (r.error) return "chip-err";
    if (!r.current) return "chip-unknown";
    return r.behind ? "chip-behind" : "chip-ok";
  }
  syncText(r) {
    if (r.error) return "error";
    if (!r.current) return "\u2014";
    return r.behind ? `${r.behind} behind` : "up to date";
  }
  syncTitle(r) {
    if (r.error) return r.error;
    if (!r.current) return "branch state not loaded yet";
    if (r.behind) {
      const ahead = r.ahead ? ` \xB7 ${r.ahead} ahead` : "";
      return `${r.behind} commit${r.behind === 1 ? "" : "s"} behind ${r.base}${ahead}`;
    }
    return `up to date with ${r.base}`;
  }
  // fetch+rebase a single repo's current branch onto its canonical base branch
  canRebaseRepo(r) {
    return !!r.current && !r.dirty && !r.error && !!r.github && !!r.path;
  }
  rebaseRepoTitle(r) {
    if (r.error) return r.error;
    if (r.dirty) return "commit or stash changes first \u2014 the working tree is dirty";
    if (!r.github || !r.path) return "no canonical repo configured for this repository";
    return `fetch and rebase ${r.current} onto ${r.github}@${this._baseBranch(r.current)}`;
  }
  async rebaseRepo(r) {
    if (!this.canRebaseRepo(r)) return;
    await this.code.rebase([
      { repo: r.id, base: this._baseBranch(r.current), github: r.github, path: r.path }
    ]);
  }
  // push a single repo's current branch to the dev remote
  canPushRepo(r) {
    return !!r.current && !r.error && !!r.github && !!r.path;
  }
  pushRepoTitle(r) {
    if (r.error) return r.error;
    if (!r.github || !r.path) return "no canonical repo configured for this repository";
    return `push ${r.current} to the dev remote (odoo-dev)`;
  }
  pushRepo(r) {
    if (!this.canPushRepo(r)) return;
    return pushBranchesDialog(this.code, this.dialogs, [{ path: r.path, branch: r.current }], {
      title: `Push "${r.current}"?`,
      message: `Push ${r.current} (${r.id}) to the dev remote (odoo-dev)?`
    });
  }
  pushForceRepo(r) {
    if (!this.canPushRepo(r)) return;
    return pushBranchesDialog(this.code, this.dialogs, [{ path: r.path, branch: r.current }], {
      title: `Force-push "${r.current}"?`,
      message: `Force-push ${r.current} (${r.id}) to the dev remote (odoo-dev) with --force-with-lease? This overwrites the remote branch.`,
      force: true
    });
  }
  // every shown repository whose current branch can be fetched + rebased
  get rebasableRepos() {
    return this.favRepos.filter((r) => this.canRebaseRepo(r));
  }
  canRebaseAll() {
    return this.rebasableRepos.length > 0;
  }
  rebaseAllTitle() {
    const n = this.rebasableRepos.length;
    if (!n)
      return "nothing to rebase \u2014 repositories are dirty, missing, or have no canonical remote";
    return `fetch and rebase ${n} branch${n === 1 ? "" : "es"} onto their base`;
  }
  // fetch + rebase every shown repo's current branch onto its base, in one call
  async rebaseAll() {
    const repos = this.rebasableRepos.map((r) => ({
      repo: r.id,
      base: this._baseBranch(r.current),
      github: r.github,
      path: r.path
    }));
    if (repos.length) await this.code.rebase(repos);
  }
  // local checkout folders of every shown repo, for "Edit" (open them all at once)
  get editorPaths() {
    return this.favRepos.map((r) => r.path).filter(Boolean);
  }
  editAllTitle() {
    const n = this.editorPaths.length;
    if (!n) return "no local repository folders to open";
    const editor = (this.config.config.editor || "code").trim();
    return `open ${n} repositor${n === 1 ? "y" : "ies"} in ${editor}`;
  }
  // open every shown repo's folder in the configured editor, all in one window
  openAllEditors() {
    const paths = this.editorPaths;
    if (paths.length) this.code.openEditorPaths(paths, "all repositories");
  }
  // open a modal bash terminal in this repo's directory
  openTerminal(r) {
    if (!r.path) return;
    this.dialogs.openComponent(TerminalDialog, { path: r.path, label: r.id });
  }
  // show the last commits on this repo's current branch
  openCommits(r) {
    if (!r.path) return;
    this.dialogs.openComponent(CommitsDialog, {
      path: r.path,
      ref: r.current || "",
      label: `${r.id} \xB7 ${r.current || "?"}`,
      github: r.github || ""
    });
  }
  // open GitHub's PR-creation page for this repo's current branch
  openPr(r) {
    this.eventLog.add(`opening PR for ${r.current} (${r.id})`);
    window.open(this.code.prCreateUrl(r.github, r.current), "_blank");
  }
};

// static/src/config_screen/config.js
var ListEditor = class extends Component {
  static template = xml`
    <div class="config-block">
      <h2 class="subtitle" t-out="this.spec.title"/>
      <div class="rows" data-form-type="other">
        <div t-foreach="this.rows()" t-as="row" t-key="row_index" class="edit-row"
             t-att-class="{dragging: this.dragIndex() === row_index, 'drag-over': this.dragOverIndex() === row_index}"
             t-on-dragover="ev => this.onDragOver(ev, row_index)" t-on-drop="ev => this.onDrop(ev, row_index)">
          <span t-if="this.spec.reorderable" class="row-handle" draggable="true" title="drag to reorder"
                t-on-dragstart="ev => this.onDragStart(ev, row_index)" t-on-dragend="() => this.onDragEnd()">⠿</span>
          <t t-foreach="this.spec.fields" t-as="f" t-key="f.key">
            <label t-if="f.type === 'checkbox'" class="edit-check" t-att-title="f.title || f.name">
              <input type="checkbox" t-att-checked="row[f.key]" t-on-change="ev => { row[f.key] = ev.target.checked; this.saveAuto(); }"/>
              <t t-out="f.name"/>
            </label>
            <input t-else="" t-att-class="f.className" t-att-placeholder="f.placeholder"
                   t-att-value="row[f.key]" t-on-input="ev => row[f.key] = ev.target.value"
                   t-on-change="() => this.saveAuto()"/>
          </t>
          <button class="row-remove" title="remove" t-on-click="() => this.removeRow(row_index)">✕</button>
        </div>
      </div>
      <div class="config-actions">
        <button t-on-click="() => this.addRow()" t-out="'Add ' + this.spec.itemName"/>
        <span t-att-class="this.msgCls()" t-out="this.msgText()"/>
      </div>
    </div>`;
  props = props({ kind: t.string() });
  config = plugin(ConfigPlugin);
  spec = SPECS[this.props.kind];
  rows = signal([]);
  msgText = signal("");
  msgCls = signal("");
  dragIndex = signal(-1);
  // row being dragged (-1 = none); only set for reorderable specs
  dragOverIndex = signal(-1);
  // row the drag is hovering over
  setup() {
    this.load();
  }
  onDragStart(ev, i) {
    this.dragIndex.set(i);
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", String(i));
  }
  onDragOver(ev, i) {
    if (this.dragIndex() < 0) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    if (this.dragOverIndex() !== i) this.dragOverIndex.set(i);
  }
  onDrop(ev, i) {
    if (this.dragIndex() < 0) return;
    ev.preventDefault();
    this.reorderRows(this.dragIndex(), i);
    this.onDragEnd();
  }
  onDragEnd() {
    this.dragIndex.set(-1);
    this.dragOverIndex.set(-1);
  }
  // move the dragged row to sit immediately before the drop target, then persist
  reorderRows(from, to) {
    if (from < 0 || to < 0 || from === to) return;
    const rows = [...this.rows()];
    const [moved] = rows.splice(from, 1);
    rows.splice(from < to ? to - 1 : to, 0, moved);
    this.rows.set(rows);
    this.saveAuto();
  }
  load() {
    this.rows.set(
      this.config.config[this.spec.key].map((item) => {
        const r = {};
        for (const f of this.spec.fields)
          r[f.key] = f.type === "checkbox" ? !!item[f.key] : f.format ? f.format(item[f.key]) : item[f.key] || "";
        return r;
      })
    );
  }
  addRow() {
    const r = {};
    for (const f of this.spec.fields) r[f.key] = "";
    this.rows.set([...this.rows(), r]);
  }
  removeRow(i) {
    this.rows.set(this.rows().filter((_, j) => j !== i));
    this.saveAuto();
  }
  flash(text, isError) {
    this.msgText.set(text);
    this.msgCls.set(isError ? "error" : "ok");
    if (!isError) setTimeout(() => this.msgText.set(""), 2e3);
  }
  // auto-save: silently skips rows with incomplete required fields so mid-edit
  // keystrokes don't flash errors; still surfaces spec-level errors (e.g. missing
  // "community" repo) and duplicate-key errors.
  saveAuto() {
    const items = [];
    const seen = /* @__PURE__ */ new Set();
    for (const row of this.rows()) {
      const raw = {};
      for (const f of this.spec.fields)
        raw[f.key] = f.type === "checkbox" ? !!row[f.key] : (row[f.key] || "").trim();
      if (this.spec.fields.every((f) => !raw[f.key])) continue;
      if (this.spec.fields.some((f) => !f.optional && !raw[f.key])) continue;
      const keyVal = raw[this.spec.fields[0].key];
      if (seen.has(keyVal)) return;
      seen.add(keyVal);
      const item = {};
      for (const f of this.spec.fields) item[f.key] = f.parse ? f.parse(raw[f.key]) : raw[f.key];
      items.push(item);
    }
    const err = this.spec.validate(items, this.config.config);
    if (err) return this.flash(err, true);
    this.msgText.set("");
    this.config.updateConfig({ [this.spec.key]: items });
  }
};
var TabsEditor = class extends Component {
  static template = xml`
    <div class="config-block">
      <h2 class="subtitle">Tabs</h2>
      <p class="dim">Show, hide and reorder the sidebar tabs (drag the handle to reorder).</p>
      <div class="rows" data-form-type="other">
        <div t-foreach="this.rows" t-as="row" t-key="row.id" class="edit-row"
             t-att-class="{dragging: this.dragIndex() === row_index, 'drag-over': this.dragOverIndex() === row_index}"
             t-on-dragover="ev => this.onDragOver(ev, row_index)" t-on-drop="ev => this.onDrop(ev, row_index)">
          <span class="row-handle" draggable="true" title="drag to reorder"
                t-on-dragstart="ev => this.onDragStart(ev, row_index)" t-on-dragend="() => this.onDragEnd()">⠿</span>
          <label class="tab-row">
            <input type="checkbox" t-att-checked="row.visible" t-att-disabled="row.id === 'config'"
                   t-att-title="row.id === 'config' ? 'the Configuration tab is always shown' : ''"
                   t-on-change="ev => this.toggle(row.id, ev.target.checked)"/>
            <t t-out="row.label"/>
          </label>
        </div>
      </div>
    </div>`;
  config = plugin(ConfigPlugin);
  dragIndex = signal(-1);
  dragOverIndex = signal(-1);
  // configured order, with any NAV tab missing from config slotted in at its
  // natural position (see mergedTabIds, so a newly-added tab shows up next to its
  // neighbours). Config is always visible; new tabs default to visible.
  get rows() {
    const meta = Object.fromEntries(NAV.map((n) => [n.id, n]));
    const configured = this.config.config.tabs || [];
    const cfg = Object.fromEntries(configured.map((t2) => [t2.id, t2]));
    return mergedTabIds(configured).map((id) => ({
      id,
      label: meta[id].label,
      visible: id === "config" ? true : cfg[id] ? cfg[id].visible !== false : !meta[id].optIn
    }));
  }
  _save(rows) {
    this.config.updateConfig({ tabs: rows.map((r) => ({ id: r.id, visible: r.visible })) });
  }
  toggle(id, visible) {
    if (id === "config") return;
    this._save(this.rows.map((r) => r.id === id ? { ...r, visible } : r));
  }
  onDragStart(ev, i) {
    this.dragIndex.set(i);
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", String(i));
  }
  onDragOver(ev, i) {
    if (this.dragIndex() < 0) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    if (this.dragOverIndex() !== i) this.dragOverIndex.set(i);
  }
  onDrop(ev, i) {
    if (this.dragIndex() < 0) return;
    ev.preventDefault();
    const from = this.dragIndex();
    this.onDragEnd();
    if (from === i) return;
    const rows = [...this.rows];
    const [moved] = rows.splice(from, 1);
    rows.splice(from < i ? i - 1 : i, 0, moved);
    this._save(rows);
  }
  onDragEnd() {
    this.dragIndex.set(-1);
    this.dragOverIndex.set(-1);
  }
};
var LinksEditor = class extends Component {
  static template = xml`
    <div class="config-block links-editor">
      <h2 class="subtitle">Navbar links</h2>
      <p class="dim">Drag the handle to reorder. Drop a link onto a menu to put it inside. Menus show as dropdowns in the top bar.</p>
      <div class="links-tree" data-form-type="other">
        <t t-foreach="this.items()" t-as="it" t-key="it._id">
          <div t-if="this.isMenu(it)" class="link-menu">
            <div class="edit-row link-menu-head" t-att-class="{dragging: this.dragId() === it._id, 'drag-over': this.overId() === it._id}"
                 t-on-dragover="ev => this.onOver(ev, it._id)" t-on-drop="ev => this.onDrop(ev, it._id)">
              <span class="row-handle" draggable="true" title="drag to reorder"
                    t-on-dragstart="ev => this.onDragStart(ev, it._id)" t-on-dragend="() => this.onDragEnd()">⠿</span>
              <span class="link-menu-caret">▾</span>
              <input class="w-flex" placeholder="menu name" t-att-value="it.label"
                     t-on-input="ev => this.edit(it, 'label', ev.target.value)" t-on-change="() => this.save()"/>
              <span class="link-menu-tag">menu</span>
              <button class="row-remove" title="remove menu" t-on-click="() => this.remove(it._id)">✕</button>
            </div>
            <div class="link-menu-body" t-att-class="{'drag-over': this.overInto() === it._id}"
                 t-on-dragover="ev => this.onOverInto(ev, it._id)" t-on-drop="ev => this.onDropInto(ev, it._id)">
              <div t-foreach="it.children" t-as="c" t-key="c._id" class="edit-row link-child"
                   t-att-class="{dragging: this.dragId() === c._id, 'drag-over': this.overId() === c._id}"
                   t-on-dragover="ev => this.onOver(ev, c._id)" t-on-drop="ev => this.onDrop(ev, c._id)">
                <span class="row-handle" draggable="true" title="drag to move"
                      t-on-dragstart="ev => this.onDragStart(ev, c._id)" t-on-dragend="() => this.onDragEnd()">⠿</span>
                <input class="w-name" placeholder="label" t-att-value="c.label"
                       t-on-input="ev => this.edit(c, 'label', ev.target.value)" t-on-change="() => this.save()"/>
                <input class="w-flex" placeholder="href (https://…)" t-att-value="c.href"
                       t-on-input="ev => this.edit(c, 'href', ev.target.value)" t-on-change="() => this.save()"/>
                <button class="row-remove" title="remove" t-on-click="() => this.remove(c._id)">✕</button>
              </div>
              <button class="link-add-child" t-on-click="() => this.addLink(it._id)">+ link</button>
            </div>
          </div>
          <div t-else="" class="edit-row link-row" t-att-class="{dragging: this.dragId() === it._id, 'drag-over': this.overId() === it._id}"
               t-on-dragover="ev => this.onOver(ev, it._id)" t-on-drop="ev => this.onDrop(ev, it._id)">
            <span class="row-handle" draggable="true" title="drag to reorder / into a menu"
                  t-on-dragstart="ev => this.onDragStart(ev, it._id)" t-on-dragend="() => this.onDragEnd()">⠿</span>
            <input class="w-name" placeholder="label" t-att-value="it.label"
                   t-on-input="ev => this.edit(it, 'label', ev.target.value)" t-on-change="() => this.save()"/>
            <input class="w-flex" placeholder="href (https://…)" t-att-value="it.href"
                   t-on-input="ev => this.edit(it, 'href', ev.target.value)" t-on-change="() => this.save()"/>
            <button class="row-remove" title="remove" t-on-click="() => this.remove(it._id)">✕</button>
          </div>
        </t>
        <div t-if="this.dragId()" class="links-drop-end" t-att-class="{'drag-over': this.overEnd()}"
             t-on-dragover="ev => this.onOverEnd(ev)" t-on-drop="ev => this.onDropEnd(ev)">move here for top level</div>
      </div>
      <div class="config-actions">
        <button t-on-click="() => this.addLink(null)">Add link</button>
        <button t-on-click="() => this.addMenu()">Add menu</button>
      </div>
    </div>`;
  config = plugin(ConfigPlugin);
  items = signal([]);
  // [{label, href, _id} | {label, children:[{label, href, _id}], _id}]
  dragId = signal(0);
  // _id of the dragged row (0 = none)
  overId = signal(0);
  // row hovered as a "drop before" target
  overInto = signal(0);
  // menu whose body is hovered (drop inside)
  overEnd = signal(false);
  // trailing "top level" zone hovered
  _nextId = 1;
  setup() {
    this.load();
  }
  isMenu(n) {
    return Array.isArray(n.children);
  }
  load() {
    this._nextId = 1;
    this.items.set(
      (this.config.config.links || []).map((n) => {
        const node = { ...n, _id: this._nextId++ };
        if (this.isMenu(n)) node.children = n.children.map((c) => ({ ...c, _id: this._nextId++ }));
        return node;
      })
    );
  }
  // mutate a node field in place (no re-render → no cursor jump); persisted on change
  edit(node, key, value) {
    node[key] = value;
  }
  addLink(menuId) {
    const items = this.items();
    const link = { label: "", href: "", _id: this._nextId++ };
    if (menuId) {
      const menu = items.find((n) => n._id === menuId && this.isMenu(n));
      if (menu) menu.children.push(link);
    } else {
      items.push(link);
    }
    this.items.set([...items]);
  }
  addMenu() {
    this.items.set([...this.items(), { label: "", children: [], _id: this._nextId++ }]);
  }
  remove(id) {
    const items = this.items();
    const loc = this._locate(items, id);
    if (loc) loc.container.splice(loc.index, 1);
    this.items.set([...items]);
    this.save();
  }
  // {container, index, node} for the row with `id`, searching the top level then
  // every menu's children; null if not found
  _locate(items, id) {
    const i = items.findIndex((n) => n._id === id);
    if (i >= 0) return { container: items, index: i, node: items[i] };
    for (const it of items) {
      if (this.isMenu(it)) {
        const ci = it.children.findIndex((c) => c._id === id);
        if (ci >= 0) return { container: it.children, index: ci, node: it.children[ci] };
      }
    }
    return null;
  }
  onDragStart(ev, id) {
    this.dragId.set(id);
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", String(id));
  }
  onDragEnd() {
    this.dragId.set(0);
    this.overId.set(0);
    this.overInto.set(0);
    this.overEnd.set(false);
  }
  onOver(ev, id) {
    if (!this.dragId()) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (this.overId() !== id) this.overId.set(id);
    this.overInto.set(0);
    this.overEnd.set(false);
  }
  onOverInto(ev, menuId) {
    if (!this.dragId()) return;
    ev.preventDefault();
    if (this.overInto() !== menuId) this.overInto.set(menuId);
    this.overId.set(0);
    this.overEnd.set(false);
  }
  onOverEnd(ev) {
    if (!this.dragId()) return;
    ev.preventDefault();
    this.overEnd.set(true);
    this.overId.set(0);
    this.overInto.set(0);
  }
  onDrop(ev, targetId) {
    ev.preventDefault();
    ev.stopPropagation();
    this._moveBefore(this.dragId(), targetId);
    this.onDragEnd();
  }
  onDropInto(ev, menuId) {
    ev.preventDefault();
    this._moveInto(this.dragId(), menuId);
    this.onDragEnd();
  }
  onDropEnd(ev) {
    ev.preventDefault();
    this._moveEnd(this.dragId());
    this.onDragEnd();
  }
  // place the dragged node immediately before the target row, in the target's
  // container (top level or a menu). Menus can't nest (depth 1).
  _moveBefore(dragId, targetId) {
    if (!dragId || dragId === targetId) return;
    const items = this.items();
    const src = this._locate(items, dragId);
    const tgt = this._locate(items, targetId);
    if (!src || !tgt) return;
    if (this.isMenu(src.node) && tgt.container !== items) return;
    src.container.splice(src.index, 1);
    const t2 = this._locate(items, targetId);
    t2.container.splice(t2.index, 0, src.node);
    this.items.set([...items]);
    this.save();
  }
  // move the dragged link into a menu (appended); ignored for menus (depth 1)
  _moveInto(dragId, menuId) {
    if (!dragId) return;
    const items = this.items();
    const src = this._locate(items, dragId);
    const menu = items.find((n) => n._id === menuId && this.isMenu(n));
    if (!src || !menu || this.isMenu(src.node)) return;
    src.container.splice(src.index, 1);
    menu.children.push(src.node);
    this.items.set([...items]);
    this.save();
  }
  // move the dragged node to the end of the top level
  _moveEnd(dragId) {
    if (!dragId) return;
    const items = this.items();
    const src = this._locate(items, dragId);
    if (!src) return;
    src.container.splice(src.index, 1);
    items.push(src.node);
    this.items.set([...items]);
    this.save();
  }
  // persist to config.links: strip _id, trim, drop blank top-level links and blank
  // child links (a menu is kept even when empty so a freshly-added one sticks)
  save() {
    const links = this.items().map((it) => {
      if (this.isMenu(it)) {
        return {
          label: (it.label || "").trim(),
          children: it.children.map((c) => ({ label: (c.label || "").trim(), href: (c.href || "").trim() })).filter((c) => c.label && c.href)
        };
      }
      return { label: (it.label || "").trim(), href: (it.href || "").trim() };
    }).filter((it) => it.children || it.label || it.href);
    this.config.updateConfig({ links });
  }
};
var SETTINGS_FIELDS = [
  { key: "venv_activate", name: "venv activate (optional)" },
  { key: "server_path", name: "odoo-bin path" },
  { key: "worktree_dir", name: "worktree dir" },
  { key: "db_user", name: "database user" },
  { key: "db_password", name: "database password" },
  { key: "filestore", name: "filestore path" },
  { key: "editor", name: "editor command" }
];
var ConfigScreen = class extends Component {
  static components = { ListEditor, TabsEditor, LinksEditor };
  static template = xml`
    <section>
      <div class="panel">
        <div class="panel-top"><h1>Configuration</h1></div>
        <div class="panel-actions">
          <button class="pbtn" t-on-click="() => this.openPresets()">Presets</button>
          <button class="pbtn" t-att-disabled="this.checking()" t-on-click="() => this.checkUpdate()"><t t-out="this.refreshIcon"/><t t-out="this.checking() ? 'Checking…' : 'Check for update'"/></button>
          <span t-if="this.upToDate()" class="check-uptodate">✓ up to date</span>
        </div>
      </div>
      <div class="content">
        <div class="config-block">
          <h2 class="subtitle">Odoo settings</h2>
          <div class="settings-grid" data-form-type="other">
            <t t-foreach="this.settingsFields" t-as="f" t-key="f.key">
              <label t-att-for="'setting-' + f.key" t-out="f.name"/>
              <input t-att-id="'setting-' + f.key" type="text" class="edit-input" autocomplete="off" t-att-value="this.settings()[f.key]"
                     t-on-input="ev => this.setSetting(f.key, ev.target.value)"
                     t-on-change="() => this.saveSettings()"/>
            </t>
          </div>
        </div>
        <div class="config-block">
          <h2 class="subtitle">Miscellaneous</h2>
          <div class="settings-grid" data-form-type="other">
            <label for="setting-editor">editor command</label>
            <input id="setting-editor" type="text" class="edit-input" autocomplete="off" t-att-value="this.settings().editor"
                   t-on-input="ev => this.setSetting('editor', ev.target.value)"
                   t-on-change="() => this.saveSettings()"/>
            <label for="setting-auto-open-event-log" title="When enabled, the event log overlay opens automatically whenever a new event arrives (and stays open).">auto-open event log</label>
            <input id="setting-auto-open-event-log" type="checkbox" class="settings-check" title="When enabled, the event log overlay opens automatically whenever a new event arrives (and stays open)."
                   t-att-checked="this.config.config.auto_open_event_log"
                   t-on-change="ev => this.config.updateConfig({ auto_open_event_log: ev.target.checked })"/>
            <label for="setting-rust-bundler" title="Launch odoo with RUST_BUNDLER=1 so the rust_bundler addon bundles JS assets through the odoo_bundler Rust extension (build it into the venv with 'maturin develop --release'). Takes effect on the next server start.">rust bundler</label>
            <input id="setting-rust-bundler" type="checkbox" class="settings-check" title="Launch odoo with RUST_BUNDLER=1 so the rust_bundler addon bundles JS assets through the odoo_bundler Rust extension (build it into the venv with 'maturin develop --release'). Takes effect on the next server start."
                   t-att-checked="this.config.config.rust_bundler"
                   t-on-change="ev => this.config.updateConfig({ rust_bundler: ev.target.checked })"/>
            <label for="setting-update-check" title="Automatically check for goo updates (git fetch of origin/master at startup and then hourly) to surface the navbar update badge. The 'Check for update' button above always works, even when this is off.">check for goo updates</label>
            <input id="setting-update-check" type="checkbox" class="settings-check" title="Automatically check for goo updates (git fetch of origin/master at startup and then hourly) to surface the navbar update badge. The 'Check for update' button above always works, even when this is off."
                   t-att-checked="this.config.config.update_check !== false"
                   t-on-change="ev => this.config.updateConfig({ update_check: ev.target.checked })"/>
          </div>
        </div>
        <TabsEditor/>
        <ListEditor kind="'repos'"/>
        <ListEditor kind="'testPresets'"/>
        <LinksEditor/>
        <div class="config-block">
          <h2 class="subtitle">Backup</h2>
          <p class="dim">goo stores your config on the server (~/.config/goo/config.json). Save a copy to a file, or restore one.</p>
          <div class="config-actions">
            <button t-on-click="() => this.exportData()">Export</button>
            <button t-on-click="() => this.triggerImport()">Import</button>
            <input type="file" id="goo-import-file" accept="application/json,.json" hidden="hidden" t-on-change="(ev) => this.importData(ev)"/>
            <span t-out="this.backupMsg()"/>
          </div>
        </div>
        <div class="config-block">
          <h2 class="subtitle">Danger zone</h2>
          <p class="dim">Erase every customization (settings, repos, targets, links, favorites, last target, history) and restore the built-in initial config. This cannot be undone.</p>
          <div class="config-actions">
            <button class="danger" t-on-click="() => this.resetAll()">Reset to initial config</button>
          </div>
        </div>
      </div>
    </section>`;
  config = plugin(ConfigPlugin);
  update = plugin(UpdatePlugin);
  dialogs = plugin(DialogPlugin);
  eventLog = plugin(EventLogPlugin);
  refreshIcon = m(ICONS.refresh);
  checking = signal(false);
  upToDate = signal(false);
  // brief green check by the button when already up to date
  backupMsg = signal("");
  settingsFields = SETTINGS_FIELDS.filter((f) => f.key !== "editor");
  // editor lives in Miscellaneous
  settings = signal(this._loadSettings());
  // manually re-check whether goo is behind origin/master, then report the result
  async checkUpdate() {
    if (this.checking()) return;
    this.checking.set(true);
    this.upToDate.set(false);
    const r = await this.update.check();
    this.checking.set(false);
    if (r.behind > 0) {
      const n = r.behind;
      this.eventLog.add(
        `checked for updates \u2014 ${n} commit${n === 1 ? "" : "s"} behind origin/master`
      );
      return void this.update.promptUpdate();
    }
    if (r.ok) {
      this.eventLog.add("checked for updates \u2014 goo is up to date");
      this.upToDate.set(true);
      setTimeout(() => this.upToDate.set(false), 3e3);
      return;
    }
    this.eventLog.add("checked for updates \u2014 could not reach origin", "", "error");
    this.dialogs.open({
      title: "Couldn't check for updates",
      message: "Make sure goo runs from a git checkout with an 'origin' remote and that you're online.",
      cls: "dialog-error",
      okLabel: "OK",
      cancelLabel: null
    });
  }
  _loadSettings() {
    const c = this.config.config;
    return Object.fromEntries(SETTINGS_FIELDS.map((f) => [f.key, c[f.key] || ""]));
  }
  setSetting(key, val) {
    this.settings.set({ ...this.settings(), [key]: val });
  }
  saveSettings() {
    const patch = {};
    for (const f of SETTINGS_FIELDS) patch[f.key] = (this.settings()[f.key] || "").trim();
    this.config.updateConfig(patch);
  }
  triggerImport() {
    document.getElementById("goo-import-file").click();
  }
  async resetAll() {
    const ok = await this.dialogs.open({
      title: "Reset the complete config to its initial state?",
      message: "This erases all your customizations (settings, repos, targets, links, favorites, last target, history) and cannot be undone.",
      okLabel: "Reset everything",
      cls: "dialog-error"
    });
    if (!ok) return;
    await this.config.resetConfig();
    location.reload();
  }
  // pick a preset (presets.js) and replace the whole config with it
  async openPresets() {
    const res = await this.dialogs.open({
      title: "Configuration presets",
      message: "Applying a preset replaces your current configuration (settings, repos, targets, links, tabs, favorites). This cannot be undone.",
      fields: [
        {
          key: "preset",
          type: "select",
          label: "Preset",
          value: "normal",
          options: PRESETS.map((p) => ({ value: p.id, label: p.label }))
        }
      ],
      okLabel: "Apply",
      cancelLabel: "Cancel",
      validate: (v) => v.preset ? "" : "Choose a preset to apply."
    });
    if (!res) return;
    await this.config.applyPreset(res.preset);
    location.reload();
  }
  exportData() {
    const blob = new Blob([JSON.stringify(this.config.snapshot(), null, 2)], {
      type: "application/json"
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "goo-backup.json";
    a.click();
    URL.revokeObjectURL(a.href);
    this.backupMsg.set("Exported.");
  }
  async importData(ev) {
    const file = ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data !== "object" || !data.config)
        throw new Error("not a goo config backup");
      await this.config.importSnapshot(data);
      this.backupMsg.set("Imported, reloading\u2026");
      setTimeout(() => location.reload(), 700);
    } catch (e) {
      this.backupMsg.set(`Import failed: ${e.message}`);
    }
  }
};
var SPECS = {
  repos: {
    key: "repos",
    title: "Repositories",
    itemName: "repository",
    fields: [
      { key: "id", name: "name", placeholder: "name (e.g. community)", className: "w-name" },
      {
        key: "path",
        name: "path",
        placeholder: "path (e.g. ~/work/community)",
        className: "w-flex"
      },
      {
        key: "github",
        name: "github repo",
        placeholder: "github (e.g. odoo/odoo)",
        className: "w-name",
        optional: true
      },
      { key: "autoreload", name: "auto-reload master", type: "checkbox", optional: true },
      {
        key: "external",
        name: "external",
        type: "checkbox",
        optional: true,
        title: "a repo outside the odoo CI ecosystem (e.g. odoo/owl) \u2014 skip its mergebot/runbot lookups"
      },
      {
        key: "favorite",
        name: "favorite",
        type: "checkbox",
        optional: true,
        title: "favorite repositories appear in the dashboard summary"
      }
    ],
    validate(repos, config) {
      if (!repos.find((r) => r.id === "community"))
        return 'a "community" repository is required (odoo-bin lives there)';
      const ids = new Set(repos.map((r) => r.id));
      for (const t2 of config.targets) {
        const used = (t2.checkouts || []).find((c) => !ids.has(c.repo));
        if (used) return `repository "${used.repo}" is still used by target "${t2.name}"`;
      }
      return null;
    }
  },
  testPresets: {
    key: "test_presets",
    title: "Test presets",
    itemName: "preset",
    reorderable: true,
    // drag the handle to reorder how presets appear in the Tests selector
    fields: [
      {
        key: "tags",
        name: "test tags",
        placeholder: "--test-tags, e.g. /web:WebSuite[@web]",
        className: "w-flex"
      }
    ],
    validate() {
      return null;
    }
  }
};

// static/src/core/review_plugin.js
var mbKey = (p) => `${p.github}#${p.number}`;
var ReviewPlugin = class extends Plugin {
  static sequence = 5;
  config = plugin(ConfigPlugin);
  store = plugin(StorePlugin);
  // the shared observed store
  prs = signal([]);
  // view state; freshness is the server's job
  at = signal(0);
  loading = signal(false);
  error = signal("");
  // mergebot state is one shared map: the Code screen reads and writes the same one,
  // so a PR scraped on either screen shows its badge on both (dedup via store.mbPending)
  mergebot = this.store.mergebot;
  // "github#number" -> mergebot state (or "" / "merged")
  mbDetails = this.store.mbDetails;
  // "github#number" -> blocked-reason detail
  favorites = signal(this._readArr("reviews_favorites"));
  // [branch, …] (starred groups, sorted first)
  _merged = new Set(this._readArr("reviews_merged"));
  // terminal merged PRs
  _noMergebot = new Set(this._readArr("reviews_no_mergebot"));
  // repos without mergebot
  // fetch the commented-on PRs (the server caches them). `force` (manual Refresh)
  // adds ?refresh=1 so the backend re-queries instead of serving its cache.
  async load(force = false) {
    this.loading.set(true);
    this.error.set("");
    try {
      const resp = await fetch(force ? "/api/reviews?refresh=1" : "/api/reviews");
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || "failed");
      this.prs.set((data.prs || []).map(PullRequest.from));
      this.at.set(Date.now());
    } catch (e) {
      this.error.set(e.message);
    } finally {
      this.loading.set(false);
    }
  }
  // starred branch groups (by branch name), persisted; sorted first in the Reviews screen
  isFavorite(key) {
    return this.favorites().includes(key);
  }
  toggleFavorite(key) {
    const favs = this.favorites();
    const next = favs.includes(key) ? favs.filter((k) => k !== key) : [...favs, key];
    this.favorites.set(next);
    this.config.setState("reviews_favorites", next);
  }
  // load mergebot states for `prs` ([{github, number}]). Skips PRs already known
  // merged and (on normal loads) repos known to lack mergebot, so only the unknown
  // ones hit the network. Pass {refresh:true} to re-probe (bypasses caches; still
  // never re-fetches merged PRs).
  async loadMergebot(prs, { refresh = false } = {}) {
    const seeded = {};
    for (const p of prs) {
      const k = mbKey(p);
      if (this._merged.has(k) && this.mergebot()[k] !== "merged") seeded[k] = "merged";
    }
    if (Object.keys(seeded).length) this.store.mergeMergebot(seeded, null);
    const have = this.mergebot();
    const todo = prs.filter((p) => {
      const k = mbKey(p);
      if (this._merged.has(k)) return false;
      if (this._noMergebot.has(p.github) && !refresh) return false;
      return refresh || !(k in have) && !this.store.mbPending.has(k);
    });
    if (!todo.length) return;
    const keys = todo.map(mbKey);
    keys.forEach((k) => this.store.mbPending.add(k));
    try {
      const res = await postJSON("/api/mergebot", { prs: todo, refresh });
      this.store.mergeMergebot(res.states, res.details || {});
      this._record(todo, res);
    } catch {
    } finally {
      keys.forEach((k) => this.store.mbPending.delete(k));
    }
  }
  // fold a /api/mergebot response into the persisted sets: newly-merged PRs become
  // terminal; repos the backend flags unsupported are remembered; repos we re-probed
  // that came back supported recover (dropped from the skip list).
  _record(requested, res) {
    let changed = false;
    for (const [k, state] of Object.entries(res.states || {})) {
      if (state === "merged" && !this._merged.has(k)) {
        this._merged.add(k);
        changed = true;
      }
    }
    const unsupported = new Set(res.unsupported || []);
    for (const repo of new Set(requested.map((p) => p.github))) {
      if (!unsupported.has(repo) && this._noMergebot.delete(repo)) changed = true;
    }
    for (const repo of unsupported) {
      if (!this._noMergebot.has(repo)) {
        this._noMergebot.add(repo);
        changed = true;
      }
    }
    if (changed) this._persist();
  }
  _persist() {
    this.config.setState("reviews_merged", [...this._merged]);
    this.config.setState("reviews_no_mergebot", [...this._noMergebot]);
  }
  _readArr(field) {
    const v = this.config.getState(field, []);
    return Array.isArray(v) ? v : [];
  }
};

// static/src/dashboard_screen/dashboard.js
var DashboardScreen = class extends Component {
  static components = { DirtyBadge, Panel };
  static template = xml`
    <section>
      <Panel title="'Dashboard'">
        <t t-set-slot="top-right">
          <span class="meta" t-out="this.stamp"/>
          <button class="pbtn" t-on-click="() => this._dashLoad(true)"><t t-out="this.refreshIcon"/>Refresh</button>
        </t>
        <t t-set-slot="bottom-left">
          <button class="dash-rebase" t-on-click="() => this.startCreate()">New target</button>
          <span class="dash-subtitle">Monitor repositories and switch between build targets.</span>
        </t>
      </Panel>
      <div class="content">
        <div t-att-class="{busy: this.code.busy()}">
          <div t-foreach="this.errors" t-as="e" t-key="e.id" class="dim" t-out="e.id + ': ' + e.error"/>

          <div class="dash-layout">
          <!-- build targets — a responsive grid, one self-contained card per target -->
          <div t-if="this.code.error()" class="dim" t-out="'Failed to load: ' + this.code.error()"/>
          <div t-elif="!this.targets.length" class="dim">No favorite targets — star targets in the Targets tab to see them here.</div>
          <section t-else="" class="dash-tgts-sec">
            <div class="dash-tgts">
              <div t-foreach="this.targets" t-as="tgt" t-key="tgt.id" class="dash-tgt" t-att-class="{active: this.isActive(tgt)}">
                <div class="dash-tgt-head">
                  <div class="dash-tgt-title">
                    <span class="dash-dot" t-att-class="{active: this.isActive(tgt)}"/>
                    <span class="dash-name" t-att-class="{clickable: this.canActivate(tgt)}" t-att-title="this.nameTitle(tgt)" t-on-click="() => this.activate(tgt)" t-out="tgt.name"/>
                    <!-- one runbot/CI badge per target (the build is per bundle, the same
                         across the target's repos): a link to the runbot bundle that, when
                         there's a per-check CI breakdown, opens the breakdown popover on
                         hover (info on hover, the runbot link on click) -->
                    <t t-set="brow" t-value="this.bundleRow(tgt)"/>
                    <t t-if="brow">
                      <t t-set="ci" t-value="this.ciBadge(brow)"/>
                      <t t-set="rbUrl" t-value="this.runbotUrl(tgt)"/>
                      <a t-if="rbUrl" class="dash-ci" t-att-class="ci.cls" target="_blank" t-att-href="rbUrl" t-att-title="ci.checks ? '' : ('runbot: ' + ci.title)" t-on-mouseenter="(ev) => this.showCiMenu(ev, ci.checks)" t-on-mouseleave="() => this.hideCiMenu()">
                        <span class="dash-ci-dot"/><t t-out="ci.label"/>
                        <span t-if="ci.running" class="dash-ci-run" title="some checks still running"/>
                      </a>
                      <span t-else="" class="dash-ci" t-att-class="ci.cls" t-att-title="ci.checks ? '' : ('runbot: ' + ci.title)" t-on-mouseenter="(ev) => this.showCiMenu(ev, ci.checks)" t-on-mouseleave="() => this.hideCiMenu()">
                        <span class="dash-ci-dot"/><t t-out="ci.label"/>
                        <span t-if="ci.running" class="dash-ci-run" title="tests still running"/>
                      </span>
                    </t>
                    <!-- one mergebot badge per target, aggregating its PRs' mergebot
                         states (the most-blocking is shown). A link to the first PR's
                         mergebot page; the per-repo breakdown opens in a popover on hover. -->
                    <t t-set="mb" t-value="this.mbBadge(tgt)"/>
                    <a t-if="mb" class="dash-ci dash-mb" t-att-class="mb.cls" target="_blank" t-att-href="mb.url" t-on-mouseenter="(ev) => this.showMbMenu(ev, mb.rows)" t-on-mouseleave="() => this.hideMbMenu()">
                      <span class="dash-ci-dot"/><t t-out="mb.label"/>
                    </a>
                    <span t-if="this.worktree.isWorktree(tgt)" class="wt-badge" role="button" title="worktree — open the Worktree screen" t-on-click.stop="() => this.openWorktree(tgt)">wt</span>
                  </div>
                  <div class="dash-tgt-actions">
                    <div class="dash-kebab-wrap">
                      <button class="dash-kebab" t-att-class="{open: this.menuId() === tgt.id}" title="more actions" t-on-click.stop="() => this.toggleMenu(tgt.id)"><t t-out="this.kebabIcon"/></button>
                      <div t-if="this.menuId() === tgt.id" class="dash-menu" t-on-click.stop="">
                        <button class="dash-menu-item" t-att-disabled="!this.canPushTarget(tgt)" t-att-title="this.canPushTarget(tgt) ? '' : 'no pushable branches'" t-on-click="() => this.menuPush(tgt)">Push branches to GitHub</button>
                        <button class="dash-menu-item" t-on-click="() => this.menuRemoveFavorite(tgt)">Remove from favorites</button>
                        <button class="dash-menu-item danger" t-att-disabled="!this.targetDbExists(tgt)" t-att-title="this.dropDbTitle(tgt)" t-on-click="() => this.menuDropDb(tgt)">Drop database</button>
                        <button class="dash-menu-item danger" t-att-disabled="this.isCurrent(tgt)" t-att-title="this.isCurrent(tgt) ? 'the current target cannot be deleted' : ''" t-on-click="() => this.menuDelete(tgt)">Delete</button>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="dash-tgt-body">
                  <div t-foreach="this.rows(tgt)" t-as="row" t-key="row.repo" class="dash-trow">
                    <div class="dash-trow-repo">
                      <div class="dash-row-name" t-out="row.repo"/>
                      <a t-if="row.remote and row.github" class="dash-row-branch branch-link" target="_blank" t-att-href="this.code.remoteBranchUrl(row.github, row.branch)" t-att-title="row.branch" t-out="row.branch"/>
                      <div t-else="" class="dash-row-branch" t-att-title="row.branch" t-out="row.branch"/>
                    </div>
                    <t t-if="row.present">
                      <!-- commit title + PR link share one cell: the title fills the
                           space (truncating), the PR number aligns at the end; with no
                           PR the title gets the full width -->
                      <div class="dash-trow-cm">
                        <span class="dash-trow-commit commit-open" t-att-class="{disabled: !row.path}" t-att-title="this.commitTip(row)" t-on-click="() => this.openRowCommits(row)" t-out="row.subject || '—'"/>
                        <a t-if="row.pr and row.github" class="dash-pr-num" target="_blank" t-att-href="row.pr.url" t-att-title="'open #' + row.pr.number + ' on GitHub'" t-out="'#' + row.pr.number"/>
                        <a t-if="row.pr and row.github and this.mbState(row)" class="dash-pr-state" t-att-class="this.mbClass(row)" target="_blank" t-att-href="this.code.mergebotUrl(row.github, row.pr.number)" t-att-title="'mergebot: ' + this.mbState(row) + (this.mbDetail(row) ? ' — missing: ' + this.mbDetail(row) : '')" t-out="this.mbState(row)"/>
                      </div>
                      <span class="dash-trow-when" t-att-title="row.date" t-out="row.date ? this.cell(row.date) : '—'"/>
                    </t>
                    <div t-else="" class="dash-row-missing">
                      <span>no local branch</span>
                      <button class="dash-create" t-on-click="() => this.createTargetBranch(row)">create it</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <!-- starred PRs — the PRs whose branch you starred in the PRs tab (Mine +
               Reviewing), one per line, so the PRs you're tracking sit below your
               targets. Hidden until something is starred. -->
          <section t-if="this.starredPrs().length" class="dash-stars-sec">
            <div class="dash-stars-head">
              <h2 class="dash-stars-title">Starred PRs</h2>
            </div>
            <div class="dash-stars">
              <div t-foreach="this.starredPrs()" t-as="pr" t-key="pr.github + ':' + pr.number" class="dash-star-row">
                <button class="dash-star-fav" title="unstar — removes this branch from Starred PRs" t-on-click="() => this.toggleStar(pr)">★</button>
                <a class="dash-pr-num" target="_blank" t-att-href="pr.url" t-att-title="'open #' + pr.number + ' on GitHub'" t-out="'#' + pr.number"/>
                <span class="dash-star-branch" t-att-title="pr.branch" t-out="pr.branch || '—'"/>
                <span class="dash-star-repo" t-out="pr.repoLabel"/>
                <span class="dash-star-title" t-att-title="pr.title" t-out="pr.title || '—'"/>
                <span class="pr-state" t-att-class="this.prState(pr)" t-out="this.prState(pr)"/>
                <a t-if="this.prMb(pr)" class="dash-pr-state" t-att-class="this.prMbClass(pr)" target="_blank" t-att-href="this.code.mergebotUrl(pr.github, pr.number)" t-att-title="'mergebot: ' + this.prMb(pr) + (this.prMbDetail(pr) ? ' — missing: ' + this.prMbDetail(pr) : '')" t-out="this.prMb(pr)"/>
                <span t-else="" class="dash-star-nomb">—</span>
                <span class="dash-star-when" t-att-title="this.prDate(pr)" t-out="this.prDate(pr) ? this.cell(this.prDate(pr)) : '—'"/>
              </div>
            </div>
          </section>
          </div><!-- /.dash-layout -->
        </div>
      </div>
    </section>`;
  code = plugin(CodePlugin);
  config = plugin(ConfigPlugin);
  server = plugin(ServerPlugin);
  db = plugin(DatabasePlugin);
  dialogs = plugin(DialogPlugin);
  eventLog = plugin(EventLogPlugin);
  review = plugin(ReviewPlugin);
  // starred branch groups + their reviewed PRs
  worktree = plugin(WorktreePlugin);
  // "wt" badge on worktree targets
  router = plugin(RouterPlugin);
  refreshIcon = m(ICONS.refresh);
  kebabIcon = m(ICONS.kebab);
  pushIcon = m(ICONS.push);
  terminalIcon = m(ICONS.terminal);
  historyIcon = m(ICONS.history);
  prIcon = m(ICONS.pr);
  menuId = signal("");
  // id of the card whose kebab menu is open ("" = none)
  openWorktree(tgt) {
    this.worktree.select(tgt.id);
    this.router.go("worktree");
  }
  startCreate() {
    return startCreateTarget(
      this.config,
      this.eventLog,
      this.code,
      this.dialogs,
      this.db,
      this.server
    );
  }
  toggleMenu(id) {
    this.menuId.set(this.menuId() === id ? "" : id);
  }
  // the "current" target: the one being worked on (last activated), regardless
  // of whether its branches are still checked out
  isCurrent(tgt) {
    return tgt.id === this.server.lastTarget();
  }
  async menuDelete(tgt) {
    this.menuId.set("");
    if (this.isCurrent(tgt)) return;
    await this.deleteTarget(tgt);
  }
  deleteTarget(tgt) {
    return deleteTargetDialog(tgt, {
      config: this.config,
      code: this.code,
      db: this.db,
      eventLog: this.eventLog,
      repoMap: this.repoMap,
      dialogs: this.dialogs,
      isActive: this.isActive(tgt)
    });
  }
  // the target's work branches that exist locally and have a canonical repo on
  // GitHub (base branches like master are never pushed to the dev fork)
  _pushableBranches(tgt) {
    const groups = this.code.groups();
    const repoMap = this.repoMap;
    return (tgt.checkouts || []).filter(
      ({ repo, branch }) => !BASE_BRANCH_RE.test(branch) && repoMap[repo]?.branches.has(branch)
    ).map(({ repo, branch }) => ({
      branch,
      path: groups.pathByRepo[repo],
      github: groups.githubByRepo[repo]
    })).filter((x) => x.path && x.github);
  }
  canPushTarget(tgt) {
    return this._pushableBranches(tgt).length > 0;
  }
  menuPush(tgt) {
    this.menuId.set("");
    const branches = this._pushableBranches(tgt);
    if (!branches.length) return;
    const n = branches.length;
    return pushBranchesDialog(this.code, this.dialogs, branches, {
      title: `Push ${n} branch${n === 1 ? "" : "es"}?`,
      message: `Push ${n} branch${n === 1 ? "" : "es"} of "${tgt.name}" to the dev remote (odoo-dev)?`
    });
  }
  menuRemoveFavorite(tgt) {
    this.menuId.set("");
    const targets = this.config.config.targets.map(
      (t2) => t2.id === tgt.id ? { ...t2, favorite: false } : t2
    );
    this.config.updateConfig({ targets });
  }
  // whether the target's configured database actually exists (so there's something
  // to drop) — drives the "Drop database" item's enabled state
  targetDbExists(tgt) {
    return !!tgt.db && this.db.databases().some((d) => d.name === tgt.db);
  }
  dropDbTitle(tgt) {
    if (!tgt.db) return "no database set for this target";
    if (!this.targetDbExists(tgt)) return `database "${tgt.db}" does not exist`;
    return `drop database "${tgt.db}"`;
  }
  // drop the target's database, stopping the server first when it's running on it
  // (the db is about to vanish, so the server stays stopped)
  async menuDropDb(tgt) {
    this.menuId.set("");
    if (!this.targetDbExists(tgt)) return;
    const stopping = this.db.activeDb === tgt.db && this.server.status().state !== "stopped";
    const res = await this.dialogs.open({
      title: `Drop "${tgt.db}"?`,
      message: stopping ? `This permanently deletes the database and stops the server (it's running on "${tgt.db}"). This cannot be undone.` : "This permanently deletes the database. This cannot be undone.",
      okLabel: "Drop"
    });
    if (!res) return;
    const error = await this.db.dropStoppingServer(tgt.db);
    if (error)
      await this.dialogs.open({
        title: "Drop failed",
        message: error,
        okLabel: "OK",
        cancelLabel: null
      });
  }
  setup() {
    this._dashLoad(false);
    this.db.load();
    if (this.review.favorites().length) this.review.load();
    const closeMenu = () => this.menuId() && this.menuId.set("");
    onMounted(() => document.addEventListener("click", closeMenu));
    onWillUnmount(() => document.removeEventListener("click", closeMenu));
    useEffect(() => {
      const branches = this._runbotBranches();
      if (branches.length) this.code.loadRunbot(branches);
      const prs = this._prs();
      if (prs.length) this.code.loadMergebot(prs);
      const starred = this._starredMbPrs();
      if (starred.length) this.code.loadMergebot(starred);
    });
  }
  // branches that still need the scraped runbot fallback: shown on the dashboard,
  // backed by a real bundle of ours, and NOT already covered by a PR's GitHub CI
  // rollup (that comes free with the PR list, so there's no point scraping). A
  // feature branch only has a bundle once its local tip is actually pushed (`synced`)
  // — otherwise runbot name-matches an unrelated, often ancient bundle that merely
  // shares the name (e.g. a fresh local `master-test` vs a 1.5y-old `master-test`
  // bundle from a long-gone same-named ref). Base branches (master, 19.0, saas-x.y)
  // always have a canonical bundle, synced or not.
  _runbotBranches() {
    const seen = /* @__PURE__ */ new Set();
    for (const tgt of this.targets)
      for (const row of this.rows(tgt)) {
        if (!row.present) continue;
        if (this.code.isExternalRepo(row.github)) continue;
        if (!BASE_BRANCH_RE.test(row.branch) && !row.synced) continue;
        const ci = row.pr && row.pr.ci;
        if (ci && ci.checks && ci.checks.length) continue;
        seen.add(row.branch);
      }
    return [...seen];
  }
  // repo ids the dashboard actually shows PRs for — favorite repos, the current
  // target's repos, and every favorite target's repos. PRs for any other repo
  // (e.g. tutorials/owl when neither favorited nor targeted) aren't displayed, so
  // load() skips fetching them. Returns a Set of repo ids.
  _dashRepoIds() {
    const ids = new Set(this.config.config.repos.filter((r) => r.favorite).map((r) => r.id));
    const current = this.config.config.targets.find((t2) => t2.id === this.server.lastTarget());
    for (const c of current?.checkouts || []) ids.add(c.repo);
    for (const tgt of this.targets) for (const c of tgt.checkouts || []) ids.add(c.repo);
    return ids;
  }
  // the dashboard shows only this subset of repos, so narrow both the PR and the
  // branch fetch to it (same ids for both) — no point reading branches/PRs for repos
  // that appear nowhere on this screen. Other tabs call code.load() unnarrowed.
  _dashLoad(force) {
    const ids = this._dashRepoIds();
    this.code.load(force, ids, ids);
  }
  // the unique {github, number} of every PR shown on the dashboard (for mergebot)
  _prs() {
    const seen = /* @__PURE__ */ new Set();
    const prs = [];
    for (const tgt of this.targets) {
      for (const row of this.rows(tgt)) {
        if (!row.pr || !row.github || this.code.isExternalRepo(row.github)) continue;
        const key = `${row.github}#${row.pr.number}`;
        if (seen.has(key)) continue;
        seen.add(key);
        prs.push({ github: row.github, number: row.pr.number });
      }
    }
    return prs;
  }
  // the scraped mergebot state for a row's PR ("" if unknown / not fetched yet)
  mbState(row) {
    if (!row.pr || !row.github) return "";
    return this.code.mergebot()[`${row.github}#${row.pr.number}`] || "";
  }
  // the unmet merge requirements behind a blocked state, e.g. "Review, CI" ("" if none)
  mbDetail(row) {
    if (!row.pr || !row.github) return "";
    return this.code.mbDetails()[`${row.github}#${row.pr.number}`] || "";
  }
  // color category for a mergebot state
  mbClass(row) {
    return mbCategory(this.mbState(row));
  }
  // the runbot bundle branch for a target: a bundle is per branch name and a
  // target's repos share one, so prefer its feature (non-base) branch, else the
  // shared base branch ("" if the target has no branches)
  bundleBranch(tgt) {
    const branches = (tgt.checkouts || []).map((c) => c.branch).filter(Boolean);
    return branches.find((b) => !BASE_BRANCH_RE.test(b)) || branches[0] || "";
  }
  // a present row representing the target's bundle (the bundle-branch row, else the
  // first present row) — drives the single runbot/CI badge in the target header
  bundleRow(tgt) {
    const present = this.rows(tgt).filter((r) => r.present);
    const branch = this.bundleBranch(tgt);
    return present.find((r) => r.branch === branch) || present[0] || null;
  }
  // the fetched runbot status for a row's branch ({result, running} or null)
  rbState(row) {
    return this.code.runbot()[row.branch] || null;
  }
  // commit tooltip: the last-commit date (no longer shown inline) before the title
  commitTip(row) {
    const subject = row.subject || "\u2014";
    return row.date ? `${this.cell(row.date)} \xB7 ${subject}` : subject;
  }
  // CI badge model for a card row. Prefer the PR's GitHub status rollup (runbot
  // + every other CI check, fetched alongside the PR list); fall back to the
  // scraped runbot bundle for branches that have no PR. `running` adds a "still
  // running" indicator next to a verdict; `checks` (when set) drives the
  // click-through breakdown popover.
  ciBadge(row) {
    const ci = row.pr && row.pr.ci;
    if (ci && ci.checks && ci.checks.length) {
      const pending = ci.checks.some((c) => c.state === "pending");
      let badge2;
      if (ci.overall === "failure")
        badge2 = { cls: "fail", label: "ko", title: "a CI check failed" };
      else if (ci.overall === "success")
        badge2 = { cls: "pass", label: "ok", title: "all CI checks passing" };
      else if (ci.overall === "pending" || pending)
        badge2 = { cls: "run", label: "running", title: "CI running" };
      else badge2 = { cls: "unknown", label: "\u2014", title: "no CI status" };
      badge2.running = pending && (ci.overall === "success" || ci.overall === "failure");
      badge2.checks = ci.checks;
      return badge2;
    }
    const s = this.rbState(row);
    const result = s && s.result || "";
    const running = !!(s && s.running);
    let badge;
    if (result === "success") badge = { cls: "pass", label: "ok", title: "passing" };
    else if (result === "failure") badge = { cls: "fail", label: "ko", title: "failing" };
    else if (running) badge = { cls: "run", label: "running", title: "running" };
    else badge = { cls: "unknown", label: "\u2014", title: "unknown" };
    badge.running = running && !!result;
    if (badge.running) badge.title += " \u2014 still running";
    return badge;
  }
  // the runbot URL for a target's bundle badge. The backend resolves the branch
  // *name* to its canonical bundle URL (and only when a bundle actually exists — a
  // never-pushed branch has none), so link to that rather than building
  // /runbot/bundle/<branch>, which runbot would mis-resolve to a foreign bundle when
  // the branch ends in a number. When the branch has a PR, its runbot scrape is
  // skipped (the GitHub CI rollup already covers it), so fall back to the ci/runbot
  // check's URL from that rollup. "" only when neither source has a runbot link yet.
  runbotUrl(tgt) {
    const branch = this.bundleBranch(tgt);
    const scraped = branch && this.code.runbot()[branch]?.url;
    if (scraped) return scraped;
    const checks = this.bundleRow(tgt)?.pr?.ci?.checks || [];
    return checks.find((c) => c.context === "ci/runbot")?.url || "";
  }
  // open the CI breakdown popover (full per-check status) anchored to the badge on
  // hover; a no-op when the badge has no per-check breakdown. The badge itself is a
  // link to runbot, so the popover is purely the on-hover info.
  showCiMenu(ev, checks) {
    if (!checks || !checks.length) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    appBus.dispatchEvent(new CustomEvent("ci-menu", { detail: { rect, checks } }));
  }
  // ask the popover to close (it lingers briefly so the mouse can move into it)
  hideCiMenu() {
    appBus.dispatchEvent(new CustomEvent("ci-menu-hide"));
  }
  // aggregate mergebot badge for a target: one entry per present PR row that has a
  // scraped state. Links to the first PR's mergebot page; the badge label/color is
  // the most-blocking state (so a single blocked PR surfaces), and `rows` drives
  // the per-repo hover popover. Returns null when no row has a state yet.
  mbBadge(tgt) {
    const rows = [];
    for (const row of this.rows(tgt)) {
      const state = this.mbState(row);
      if (!state) continue;
      rows.push({
        repo: row.repo,
        state,
        detail: this.mbDetail(row),
        cls: this.mbClass(row),
        url: this.code.mergebotUrl(row.github, row.pr.number)
      });
    }
    if (!rows.length) return null;
    const RANK = { blocked: 0, progress: 1, ready: 2, merged: 3, other: 4 };
    const worst = rows.reduce((a, b) => RANK[a.cls] <= RANK[b.cls] ? a : b);
    return { cls: worst.cls, label: worst.state, url: rows[0].url, rows };
  }
  // open the mergebot per-repo breakdown popover on hover (no-op with no rows)
  showMbMenu(ev, rows) {
    if (!rows || !rows.length) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    appBus.dispatchEvent(new CustomEvent("mb-menu", { detail: { rect, rows } }));
  }
  // ask the mergebot popover to close (it lingers briefly, like the CI one)
  hideMbMenu() {
    appBus.dispatchEvent(new CustomEvent("mb-menu-hide"));
  }
  get stamp() {
    if (this.code.loading()) return "refreshing\u2026";
    return this.code.at() ? `updated ${timeAgo(new Date(this.code.at()).toISOString())}` : "";
  }
  get errors() {
    return this.code.groups().errors;
  }
  // favorite targets only, in the order defined in the Targets tab
  get targets() {
    return this.config.config.targets.filter((t2) => t2.favorite);
  }
  // repoId -> { current, dirty, branches: Map(name -> branch) }
  get repoMap() {
    const map = {};
    for (const repo of this.code.branchRepos()) {
      map[repo.id] = {
        current: repo.current,
        dirty: repo.dirty,
        branches: new Map((repo.branches || []).map((b) => [b.name, b]))
      };
    }
    return map;
  }
  // one row per repo:branch in the target's config, with its local + remote state
  rows(tgt) {
    const repos = this.repoMap;
    const groups = this.code.groups();
    return (tgt.checkouts || []).map(({ repo, branch }) => {
      const r = repos[repo];
      const b = r && r.branches.get(branch);
      return {
        repo,
        branch,
        path: groups.pathByRepo[repo] || "",
        github: groups.githubByRepo[repo] || "",
        present: !!b,
        remote: !!b && b.remote,
        synced: !!b && b.synced,
        // local tip is exactly what's on the remote ref
        date: b ? b.date : "",
        subject: b ? b.subject || "" : "",
        pr: groups.prIndex[`${repo}:${branch}`] || null
      };
    });
  }
  // every repo in the target's config is checked out on the target's branch
  _checkedOut(tgt) {
    const repos = this.repoMap;
    const cfg = tgt.checkouts || [];
    return cfg.length > 0 && cfg.every(({ repo, branch }) => repos[repo]?.current === branch);
  }
  // the active target is the explicit one (set on Activate / Start) — and only
  // while its branches are still checked out. The id check disambiguates
  // overlapping targets (e.g. master vs master(e), whose branches are a subset)
  isActive(tgt) {
    return tgt.id === this.server.lastTarget() && this._checkedOut(tgt);
  }
  // can't switch branches with uncommitted work, or to branches not present
  _targetDirty(tgt) {
    const repos = this.repoMap;
    return (tgt.checkouts || []).some(({ repo }) => repos[repo]?.dirty);
  }
  _targetPresent(tgt) {
    const repos = this.repoMap;
    return (tgt.checkouts || []).every(({ repo, branch }) => repos[repo]?.branches.has(branch));
  }
  canActivate(tgt) {
    if (this.worktree.isWorktree(tgt)) return false;
    return !this.isActive(tgt) && this._targetPresent(tgt) && !this._targetDirty(tgt);
  }
  activateTitle(tgt) {
    if (this._targetDirty(tgt)) return "commit or stash changes first \u2014 the working tree is dirty";
    if (!this._targetPresent(tgt)) return "some of this target's branches are missing locally";
    return "stop the server, switch to this target and check out its branches";
  }
  // tooltip for the clickable target name — clicking an inactive, applyable target
  // applies it (replaces the old "Apply" button); otherwise say why it can't be
  nameTitle(tgt) {
    if (this.worktree.isWorktree(tgt))
      return "worktree target \u2014 manage it from the Worktrees screen";
    if (this.isActive(tgt)) return "this target is active";
    if (this.canActivate(tgt)) return "click to apply \u2014 " + this.activateTitle(tgt);
    return this.activateTitle(tgt);
  }
  // stop the server, switch to this target, check out its branches — the action lives
  // on the Target model (it drives ServerPlugin/CodePlugin/EventLog itself)
  async activate(tgt) {
    if (!this.canActivate(tgt)) return;
    await this.config.target(tgt.id)?.activate();
  }
  // the canonical base branch a branch derives from: master-owl-update -> master,
  // 19.0-some-fix -> 19.0 (defaults to master)
  _baseBranch(branch) {
    return (/^(saas-\d+\.\d+|\d+\.\d+|master)/.exec(branch) || ["", "master"])[1];
  }
  // create a target's missing branch locally, off its base branch
  createTargetBranch(row) {
    const path = this.code.groups().pathByRepo[row.repo];
    if (path) this.code.createBranch(path, row.branch, this._baseBranch(row.branch));
  }
  // show the last commits for a target row's repo:branch (the commit title in a card)
  openRowCommits(row) {
    if (!row.path) return;
    this.dialogs.openComponent(CommitsDialog, {
      path: row.path,
      ref: row.branch || "",
      label: `${row.repo} \xB7 ${row.branch || "?"}`,
      github: row.github || ""
    });
  }
  // ── starred PRs ──────────────────────────────────────────────────────────
  // The branch groups the user starred in the PRs tab, surfaced below the target
  // cards. Favorites are keyed by branch name (shared across Mine/Reviewing), so
  // we gather every PR on a starred branch from both the authored list (code) and
  // the reviewed list (review), dedupe by repo#number, group by branch and sort
  // each branch's PRs in config repo order — the same shape the PRs tab renders.
  // friendly repo id for a github slug ("odoo/enterprise" -> "enterprise"),
  // falling back to the slug for repos not in config
  get _slugToId() {
    return Object.fromEntries(
      (this.config.config.repos || []).filter((r) => r.github).map((r) => [r.github, r.id])
    );
  }
  starredGroups() {
    const favs = new Set(this.review.favorites());
    if (!favs.size) return [];
    const slugToId = this._slugToId;
    const seen = /* @__PURE__ */ new Set();
    const byBranch = /* @__PURE__ */ new Map();
    const add = (pr) => {
      if (!pr.branch || !favs.has(pr.branch)) return;
      const key = `${pr.github}#${pr.number}`;
      if (seen.has(key)) return;
      seen.add(key);
      (byBranch.get(pr.branch) || byBranch.set(pr.branch, []).get(pr.branch)).push(pr);
    };
    for (const repo of this.code.prRepos()) {
      if (repo.error) continue;
      for (const pr of repo.prs) add({ ...pr, repoLabel: repo.id });
    }
    for (const pr of this.review.prs()) add({ ...pr, repoLabel: slugToId[pr.github] || pr.github });
    const ts = (r) => Date.parse(this.prDate(r)) || 0;
    const repoOrder = (this.config.config.repos || []).map((r) => r.github);
    const rank = (r) => {
      const i = repoOrder.indexOf(r.github);
      return i === -1 ? repoOrder.length : i;
    };
    return [...byBranch.entries()].map(([branch, prs]) => ({
      branch,
      prs: prs.slice().sort((a, b) => rank(a) - rank(b) || a.github.localeCompare(b.github) || ts(b) - ts(a)),
      updated: Math.max(...prs.map(ts))
    })).sort((a, b) => b.updated - a.updated);
  }
  // the starred PRs as one flat list (each carries its own branch) — branches are
  // sorted most-recently-updated first, with a branch's PRs kept adjacent
  starredPrs() {
    return this.starredGroups().flatMap((g) => g.prs);
  }
  // unstar from a row — favorites are by branch (see ReviewPlugin), so this drops
  // every PR on that branch from the list (the section hides once none are left)
  toggleStar(pr) {
    this.review.toggleFavorite(pr.branch);
  }
  // open, non-external starred PRs in mergebot's {github, number} shape (terminal
  // and external PRs never get a useful scrape — same filter the target cards use)
  _starredMbPrs() {
    return this.starredPrs().filter((pr) => pr.state === "open" && !this.code.isExternalRepo(pr.github)).map((pr) => ({ github: pr.github, number: pr.number }));
  }
  // mergebot helpers for the starred rows — same code.mergebot() store the target
  // cards read (we load these PRs' state alongside), keyed by the PR's own slug/number
  prMb(pr) {
    return this.code.mergebot()[`${pr.github}#${pr.number}`] || "";
  }
  prMbDetail(pr) {
    return this.code.mbDetails()[`${pr.github}#${pr.number}`] || "";
  }
  prMbClass(pr) {
    return mbCategory(this.prMb(pr));
  }
  prState(pr) {
    return pr.draft && pr.state === "open" ? "draft" : pr.state;
  }
  // the date shown for a starred row: your own PRs show when they were opened
  // (createdAt); reviewed PRs show updatedAt (no createdAt on those)
  prDate(pr) {
    return pr.createdAt || pr.updatedAt;
  }
  cell(date) {
    return timeAgo(date);
  }
};

// static/src/databases_screen/databases.js
var DatabasesScreen = class extends Component {
  static template = xml`
    <section>
      <div class="panel">
        <div class="panel-top">
          <h1>Databases</h1>
          <div class="panel-top-right">
            <span class="meta" t-out="this.stamp"/>
            <button class="pbtn" t-on-click="() => this.db.load(true)"><t t-out="this.refreshIcon"/>Refresh</button>
          </div>
        </div>
        <div class="panel-actions">
          <button t-if="this.selectedCount" class="pbtn danger" t-on-click="() => this.dropSelected()">Drop <t t-out="this.selectedCount"/></button>
          <span class="row-count" t-out="this.count"/>
        </div>
      </div>
      <div class="content br-fill">
        <div t-att-class="{busy: this.db.dropping()}">
          <div t-if="this.db.error()" class="dim br-empty" t-out="'Failed to load: ' + this.db.error()"/>
          <div t-elif="!this.db.databases().length" class="dim br-empty">No databases.</div>
          <div t-else="" class="br-card">
            <!-- full-width card = scroll container (scrollbar on the right); the
                 wrapper sizes the table to its natural width, like the Branches list -->
            <div class="brg-table">
            <table class="br-table brg-flat">
              <thead>
                <tr><th><input type="checkbox" class="br-select" t-att-checked="this.allSelected" t-on-change="() => this.toggleSelectAll()" title="select all databases"/></th><th>Name</th><th>Odoo version</th><th>Demo data</th><th>Size</th><th>Created</th><th>Last activity</th><th/></tr>
              </thead>
              <tbody>
                <tr t-foreach="this.rows()" t-as="d" t-key="d.name" t-att-class="{active: d.active, 'row-sel': this.selected().has(d.name)}">
                  <td>
                    <input t-if="!d.active" type="checkbox" class="br-select" t-att-checked="this.selected().has(d.name)" t-on-change="() => this.toggleSelect(d.name)" title="select this database for batch actions"/>
                  </td>
                  <td t-att-class="{'active-name': d.active, 'select-toggle': !d.active}"
                      t-on-click="() => d.active || this.toggleSelect(d.name)">
                    <span class="br-branch" t-out="d.name"/>
                    <span t-if="d.active" class="db-badge"><span class="pulse"/>Active</span>
                  </td>
                  <td t-att-class="{dim: !d.version}"><t t-out="d.version || '—'"/><t t-if="d.enterprise"> (ent)</t></td>
                  <td class="br-when" t-att-title="d.version ? (d.demoData ? 'demo data installed' : 'no demo data') : ''" t-out="d.version ? (d.demoData ? '✓' : '✕') : '—'"/>
                  <td class="br-when" t-att-class="{dim: !d.size}" t-out="d.size || '—'"/>
                  <td class="br-when" t-att-title="d.createdTitle" t-out="d.created ? d.createdAgo : '—'"/>
                  <td class="br-when" t-att-title="d.lastTitle" t-out="d.last ? d.lastAgo : '—'"/>
                  <td>
                    <div class="br-act">
                      <button class="dash-kebab" title="database actions"
                              t-on-click.stop="(ev) => this.openRowMenu(ev, d)"><t t-out="this.kebabIcon"/></button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
            </div>
          </div>
        </div>
      </div>
    </section>`;
  db = plugin(DatabasePlugin);
  dialogs = plugin(DialogPlugin);
  refreshIcon = m(ICONS.refresh);
  kebabIcon = m(ICONS.kebab);
  selected = signal(/* @__PURE__ */ new Set());
  // database names ticked for batch actions
  // sorted, view-ready rows — recomputed only when the db list / active db change
  rows = computed(() => {
    const activeDb = this.db.activeDb;
    return [...this.db.databases()].sort((a, b) => (Date.parse(b.last_update) || 0) - (Date.parse(a.last_update) || 0)).map((d) => ({
      name: d.name,
      active: d.name === activeDb,
      version: d.odoo_version,
      enterprise: d.enterprise,
      demoData: d.demo_data,
      created: d.created,
      createdAgo: d.created && timeAgo(d.created),
      createdTitle: d.created ? `${d.created} (UTC)` : "",
      last: d.last_update,
      lastAgo: d.last_update && timeAgo(d.last_update),
      lastTitle: d.last_update ? `${d.last_update} (UTC)` : "",
      size: formatBytes(d.size)
    }));
  });
  setup() {
    this.db.load();
  }
  get stamp() {
    if (this.db.loading()) return "refreshing\u2026";
    return this.db.at() ? `updated ${timeAgo(new Date(this.db.at()).toISOString())}` : "";
  }
  get count() {
    const n = this.rows().length;
    return `${n} database${n === 1 ? "" : "s"}`;
  }
  toggleSelect(name) {
    const sel = new Set(this.selected());
    sel.has(name) ? sel.delete(name) : sel.add(name);
    this.selected.set(sel);
  }
  // per-database actions in the floating kebab menu (shared ActionMenu). Clone,
  // rename and drop all need the source db to have no active connections. Rename
  // and drop stay disabled on the active db; Clone is allowed — it stops the
  // server (releasing connections), clones, then restarts.
  openRowMenu(ev, d) {
    const rect = ev.currentTarget.getBoundingClientRect();
    const busyTitle = d.active ? "stop the server first (no active connections allowed)" : "";
    const actions = [
      {
        label: "Clone",
        title: d.active ? "stops the server to clone, then restarts it" : "",
        onClick: () => this.cloneDb(d)
      },
      {
        label: "Rename",
        disabled: d.active,
        title: busyTitle,
        onClick: () => this.renameDb(d)
      },
      {
        label: "Drop",
        danger: true,
        disabled: d.active,
        title: d.active ? "in use by the running server" : "",
        onClick: () => this.dropDb(d)
      }
    ];
    appBus.dispatchEvent(new CustomEvent("action-menu", { detail: { rect, actions } }));
  }
  get _selectableDbs() {
    return this.rows().filter((d) => !d.active);
  }
  get allSelected() {
    const sel = this.selected();
    const selectable = this._selectableDbs;
    return selectable.length > 0 && selectable.every((d) => sel.has(d.name));
  }
  toggleSelectAll() {
    this.selected.set(
      this.allSelected ? /* @__PURE__ */ new Set() : new Set(this._selectableDbs.map((d) => d.name))
    );
  }
  get selectedCount() {
    return this.rows().filter((d) => this.selected().has(d.name) && !d.active).length;
  }
  async dropSelected() {
    const dbs = this._selectableDbs.filter((d) => this.selected().has(d.name));
    if (!dbs.length) return;
    const n = dbs.length;
    const res = await this.dialogs.open({
      title: `Drop ${n} database${n === 1 ? "" : "s"}?`,
      message: "This permanently deletes the selected databases. This cannot be undone.",
      okLabel: "Drop"
    });
    if (!res) return;
    for (const d of dbs) await this.db.drop(d.name);
    this.selected.set(/* @__PURE__ */ new Set());
  }
  // confirm via the dialog, then drop; report any failure in a dialog too
  async dropDb(d) {
    const res = await this.dialogs.open({
      title: `Drop "${d.name}"?`,
      message: "This permanently deletes the database. This cannot be undone.",
      okLabel: "Drop"
    });
    if (!res) return;
    const error = await this.db.drop(d.name);
    if (error)
      await this.dialogs.open({
        title: "Drop failed",
        message: error,
        okLabel: "OK",
        cancelLabel: null
      });
  }
  // valid db name: letters/digits then letters/digits/._- (mirrors the backend)
  _badName(name) {
    if (!name) return "a name is required";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
      return "use letters, digits, . _ - (not starting with -)";
    if (this.db.databases().some((x) => x.name === name))
      return `a database named "${name}" already exists`;
    return "";
  }
  // ask for a target name, then clone; report any failure in a dialog. Cloning the
  // active db requires exclusive access (postgres createdb -T), so the server is
  // stopped first and restarted afterwards.
  async cloneDb(d) {
    const res = await this.dialogs.open({
      title: `Clone "${d.name}"`,
      message: d.active ? "This database is in use by the running server. goo will stop the server to clone it, then restart it." : "",
      fields: [
        {
          key: "target",
          type: "text",
          label: "New database name",
          value: `${d.name}-copy`,
          placeholder: "new database name"
        }
      ],
      okLabel: "Clone",
      validate: (v) => this._badName((v.target || "").trim())
    });
    if (!res) return;
    const error = await this.db.cloneStoppingServer(d.name, res.target.trim());
    if (error)
      await this.dialogs.open({
        title: "Clone failed",
        message: error,
        okLabel: "OK",
        cancelLabel: null
      });
  }
  // ask for a new name, then rename; report any failure in a dialog
  async renameDb(d) {
    const res = await this.dialogs.open({
      title: `Rename "${d.name}"`,
      fields: [
        {
          key: "name",
          type: "text",
          label: "New name",
          value: d.name,
          placeholder: "new database name"
        }
      ],
      okLabel: "Rename",
      validate: (v) => {
        const t2 = (v.name || "").trim();
        if (t2 === d.name) return "choose a different name";
        return this._badName(t2);
      }
    });
    if (!res) return;
    const error = await this.db.rename(d.name, res.name.trim());
    if (error)
      await this.dialogs.open({
        title: "Rename failed",
        message: error,
        okLabel: "OK",
        cancelLabel: null
      });
  }
};

// static/src/core/tests_plugin.js
var HISTORY_MAX = 10;
var TestsPlugin = class extends Plugin {
  static sequence = 3;
  config = plugin(ConfigPlugin);
  store = plugin(StorePlugin);
  // one-shot runs live in the shared store's runs map
  server = plugin(ServerPlugin);
  eventLog = plugin(EventLogPlugin);
  output = new LogBuffer();
  status = signal("");
  history = signal(this._readHistory());
  // last test tags run, most recent first
  _pending = signal(false);
  // optimistic "run starting", until the backend's "run" event lands
  _capturing = false;
  // whether server lines are currently mirrored to the test console
  _finished = false;
  // guard: "test suite finished" is logged once per run
  _tags = "";
  // current run's tags (for the deferred "running tests" log)
  _cutOnChrome = false;
  // WebSuite runs end the console window at the chrome teardown
  _result = "";
  // "success" | "fail" — derived from the HOOT result lines
  _failSeq = 0;
  // monotonic id source for failure-row anchors (never reset)
  _announced = null;
  // run id we've logged "running tests" for (once per run)
  _finishedRun = null;
  // run id we've finalized (once per run)
  _readHistory() {
    const h = this.config.getState("test_history", []);
    return Array.isArray(h) ? h : [];
  }
  // record a run's tag at the front, deduped, capped at HISTORY_MAX
  _pushHistory(tag) {
    tag = tag.trim();
    if (!tag) return;
    const h = [tag, ...this.history().filter((t2) => t2 !== tag)].slice(0, HISTORY_MAX);
    this.history.set(h);
    this.config.setState("test_history", h);
  }
  // the target id tests run against: the running/starting server's target, else the
  // last-used one, else the first configured target. Tests are a one-shot run against
  // the target's db, so they work even with the server down; the run endpoint resolves
  // the launch config from this id server-side.
  get target() {
    const targets = this.config.config.targets;
    const candidate = this.server.status().target || this.server.lastTarget();
    if (targets.some((t2) => t2.id === candidate)) return candidate;
    return targets[0]?.id || "";
  }
  // the current/last test run (backend-minted, from the shared store)
  currentRun() {
    return this.store.latestRunOfKind("test");
  }
  // a test run is active — optimistically true between clicking Run and the backend's
  // first "run" event, then driven by the run's state (a method: components call it)
  runActive() {
    return this._pending() || this.currentRun()?.state === "running";
  }
  setup() {
    useEffect(() => this._onRun(this.currentRun()));
    this.server.onLine((line) => {
      if (!this.runActive()) return;
      if (!this._capturing && line.includes("[goo] starting odoo:")) this._capturing = true;
      if (!this._capturing) return;
      const failed = line.match(/\[HOOT\] Test "(.+?)" failed/);
      const anchor = failed ? `test-fail-${++this._failSeq}` : "";
      this.output.append(line, anchor);
      if (failed) this.eventLog.add(`test failed: ${failed[1]}`, anchor, "error");
      if (line.includes("[HOOT] Test suite succeeded")) this._result = "success";
      else if (line.includes("Some tests failed") || line.includes("[HOOT] Failed"))
        this._result = "fail";
      if (this._cutOnChrome && line.includes("Terminating chrome headless with pid"))
        this._finishRun();
    });
  }
  // react to the backend-minted test Run moving running → done/failed. Resume-after
  // (bringing back a server the run interrupted) is owned by the backend now, so this
  // just drives the console + event log. Announce/finalize once per run id.
  _onRun(run) {
    if (!run) return;
    if (run.state === "running") {
      this._pending.set(false);
      if (this._announced !== run.id) {
        this._announced = run.id;
        this.eventLog.add(`running tests (tags: ${run.spec?.tags ?? this._tags})`);
        this._capturing = true;
      }
      this.status.set("running\u2026");
    } else if (this._finishedRun !== run.id) {
      this._finishedRun = run.id;
      if (this._announced !== run.id) return;
      const stopped = run.returncode === null;
      this.status.set(
        stopped ? "stopped" : run.returncode ? `failed \u2014 exit ${run.returncode}` : "passed"
      );
      const byExit = stopped ? "" : run.returncode ? "fail" : "success";
      this._finishRun(this._result || byExit);
    }
  }
  // close the test-tab log window and log the finish event (once per run)
  _finishRun(result = this._result) {
    this._capturing = false;
    if (this._finished) return;
    this._finished = true;
    const failed = result && String(result).includes("fail");
    this.eventLog.add(
      `test run finished${result ? ` (${result})` : ""}`,
      "",
      failed ? "error" : ""
    );
  }
  get running() {
    return this.currentRun()?.state === "running";
  }
  async run(tags) {
    if (!tags.trim()) return;
    const targetId = this.target;
    if (!targetId) return this.server.log(`[goo] no valid target to test`);
    const s = this.server.status();
    const serverWasUp = (s.state === "running" || s.state === "starting") && s.mode === "server";
    this._pushHistory(tags);
    this._tags = tags.trim();
    this._cutOnChrome = this._tags.includes("web:WebSuite");
    this._result = "";
    if (serverWasUp) this.eventLog.add("stopping server to run tests");
    this.output.clear();
    this._capturing = false;
    this._finished = false;
    this._pending.set(true);
    this.status.set("starting\u2026");
    try {
      await postJSON("/api/tests/run", { target: targetId, overrides: { test_tags: this._tags } });
    } catch (e) {
      this._pending.set(false);
      this.status.set(`failed to start: ${e.message}`);
    }
  }
};

// static/src/core/event_log.js
var EventLog = class extends Component {
  static template = xml`
    <div t-if="this.log.open()" class="event-log" t-ref="this.drag.handle">
      <div class="event-log-head" t-on-mousedown="this.drag.onDragStart">
        <span class="event-log-title">Event log</span>
        <div class="event-log-tools">
          <label class="toggle" t-att-class="{on: this.autoScroll()}" t-on-click="() => this.toggleAuto()"><span class="switch"/>Autoscroll</label>
          <label class="toggle" t-att-class="{on: this.config.config.auto_open_event_log}" t-on-click="() => this.toggleAutoOpen()" title="open this log automatically when a new event arrives"><span class="switch"/>Auto-open</label>
          <button class="tool-btn" t-on-click="() => this.log.clear()"><t t-out="this.clearIcon"/>Clear</button>
          <button class="event-log-x" t-on-click="() => this.log.toggle()" title="close">✕</button>
        </div>
      </div>
      <div class="event-log-body" t-ref="this.body">
        <div t-if="!this.log.entries().length" class="event-log-empty">No events yet.</div>
        <div t-foreach="this.rows" t-as="e" t-key="e.id" class="event-log-row" t-att-class="{error: e.level === 'error' or e.status === 'error'}">
          <span class="event-log-time" t-att-title="e.full" t-out="e.time"/>
          <span class="event-log-text"><t t-out="e.text"/><span t-if="e.status" class="ev-status" t-att-class="'ev-' + e.status" t-att-title="e.statusTitle"/></span>
          <a t-if="e.anchor" class="event-log-jump" t-on-click="() => this.jump(e.anchor)" title="jump to this line in the test log">[jump]</a>
        </div>
      </div>
      <div class="term-panel-resize" t-on-mousedown="this.drag.onResizeStart"/>
    </div>`;
  log = plugin(EventLogPlugin);
  config = plugin(ConfigPlugin);
  router = plugin(RouterPlugin);
  tests = plugin(TestsPlugin);
  clearIcon = m(ICONS.clear);
  body = signal.ref(HTMLElement);
  autoScroll = signal(true);
  // follow the tail as new events arrive
  _lastCount = 0;
  setup() {
    this.drag = useDragResize({
      w: 540,
      h: 380,
      place: (w, h) => ({
        x: Math.max(0, window.innerWidth - w - 16),
        y: Math.max(0, window.innerHeight - h - 16)
      })
    });
    this._lastCount = this.log.entries().length;
    useEffect(() => {
      const count = this.log.entries().length;
      if (count > this._lastCount && this.config.config.auto_open_event_log)
        this.log.open.set(true);
      this._lastCount = count;
    });
    onPatched(() => {
      if (!this.autoScroll()) return;
      const el = this.body();
      if (el) el.scrollTop = el.scrollHeight;
    });
  }
  toggleAuto() {
    this.autoScroll.set(!this.autoScroll());
  }
  // toggle the persisted "open the log when a new event arrives" setting — the same
  // config flag the Settings checkbox controls
  toggleAutoOpen() {
    this.config.updateConfig({ auto_open_event_log: !this.config.config.auto_open_event_log });
  }
  // open the Tests tab and scroll its console to the anchored line. The console
  // unmounts when off-tab and its element is re-hosted on return, so we wait
  // (a few frames) for the row to become laid out before revealing it.
  jump(anchor) {
    this.router.go("tests");
    let tries = 0;
    const reveal = () => {
      const row = document.getElementById(anchor);
      if (row && row.offsetParent !== null) {
        this.tests.output.autoScroll.set(false);
        row.scrollIntoView({ block: "center" });
        row.classList.add("log-jump-flash");
        setTimeout(() => row.classList.remove("log-jump-flash"), 1500);
      } else if (tries++ < 30) {
        requestAnimationFrame(reveal);
      }
    };
    requestAnimationFrame(reveal);
  }
  // chronological: oldest first, newest appended at the end
  get rows() {
    const STATUS_TITLE = { pending: "in progress\u2026", done: "done", error: "failed" };
    return this.log.entries().map((e) => {
      const d = new Date(e.at);
      return {
        id: e.id,
        time: d.toLocaleTimeString([], { hour12: false }),
        // 24h, no AM/PM
        full: d.toLocaleString(),
        // full date + time, shown on hover
        text: e.text,
        anchor: e.anchor || "",
        level: e.level || "",
        status: e.status || "",
        // "" | pending | done | error (timed events)
        statusTitle: STATUS_TITLE[e.status] || ""
      };
    });
  }
};

// static/src/memory_screen/memory_plugin.js
var STORAGE_KEY = "oo-memory-builds";
var STORAGE_KEY_BATCH_URL = "oo-memory-batch-url";
var MemoryPlugin = class extends Plugin {
  static sequence = 4;
  builds = signal(this._loadBuilds());
  data = signal([]);
  loading = signal(false);
  error = signal("");
  withMobile = signal(false);
  batchUrl = signal(localStorage.getItem(STORAGE_KEY_BATCH_URL) || "");
  batchLoading = signal(false);
  batchError = signal("");
  _loadBuilds() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) && parsed.length ? parsed : [{ label: "", url: "" }];
    } catch {
      return [{ label: "", url: "" }];
    }
  }
  _saveBuilds(builds) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(builds));
    } catch {
    }
  }
  setBuilds(builds) {
    this.builds.set(builds);
    this._saveBuilds(builds);
  }
  addBuild() {
    this.setBuilds([...this.builds(), { label: "", url: "" }]);
  }
  removeBuild(idx) {
    const next = this.builds().filter((_, i) => i !== idx);
    this.setBuilds(next.length ? next : [{ label: "", url: "" }]);
    this.data.set([]);
  }
  updateBuild(idx, key, value) {
    const next = this.builds().map((b, i) => i === idx ? { ...b, [key]: value } : b);
    this.setBuilds(next);
  }
  setBatchUrl(url) {
    this.batchUrl.set(url);
    try {
      localStorage.setItem(STORAGE_KEY_BATCH_URL, url);
    } catch {
    }
  }
  async fetchBatch() {
    const url = this.batchUrl().trim();
    if (!url || this.batchLoading()) return;
    this.batchLoading.set(true);
    this.batchError.set("");
    try {
      const res = await postJSON("/api/memory/batch", { url });
      if (!res.builds || !res.builds.length) {
        this.batchError.set("No builds found at that URL.");
      } else {
        const existing = this.builds().filter((b) => b.label.trim() || b.url.trim());
        this.setBuilds([...existing, ...res.builds]);
      }
    } catch (e) {
      this.batchError.set(e.message || "failed to fetch batch builds");
    } finally {
      this.batchLoading.set(false);
    }
  }
  async load() {
    const builds = this.builds().filter((b) => b.url.trim());
    if (!builds.length || this.loading()) return;
    this.loading.set(true);
    this.error.set("");
    try {
      const res = await postJSON("/api/memory/fetch", {
        builds,
        with_mobile: this.withMobile()
      });
      this.data.set(res.data || []);
    } catch (e) {
      this.error.set(e.message || "failed to load memory data");
    } finally {
      this.loading.set(false);
    }
  }
};

// static/src/nightly_screen/nightly_plugin.js
var NightlyPlugin = class extends Plugin {
  static sequence = 4;
  versions = signal([]);
  nights = signal([]);
  loading = signal(false);
  error = signal("");
  at = signal(0);
  _maxNights = 0;
  // how many nights the backend last fetched, this session
  _errorsCache = /* @__PURE__ */ new Map();
  // build url -> { errors, metrics } (session-only memo)
  timeoutUrls = signal(/* @__PURE__ */ new Set());
  // URLs whose builds contain a timeout error
  async fetchErrors(url) {
    if (this._errorsCache.has(url)) return this._errorsCache.get(url);
    const res = await postJSON("/api/nightly/errors", { url });
    const result = { errors: res.errors || [], metrics: res.metrics || {} };
    this._errorsCache.set(url, result);
    if (result.errors.some((e) => e.timeout)) {
      const s = new Set(this.timeoutUrls());
      s.add(url);
      this.timeoutUrls.set(s);
    }
    return result;
  }
  async load(force = false, maxNights = 7) {
    if (this.loading()) return;
    if (!force && this.at() && this._maxNights >= maxNights) return;
    this.loading.set(true);
    this.error.set("");
    try {
      const res = await postJSON("/api/nightly", { refresh: !!force, max_nights: maxNights });
      this.versions.set(res.versions || []);
      this.nights.set(res.nights || []);
      this._maxNights = maxNights;
      this.at.set(Date.now());
    } catch (e) {
      this.error.set(e.message);
    } finally {
      this.loading.set(false);
    }
  }
};

// static/src/nightly_screen/nightly.js
var _chartJsReady = null;
function loadChartJs() {
  if (!_chartJsReady) {
    _chartJsReady = loadScript("/static/lib/chart/chart.umd.min.js", () => window.Chart).then(
      () => loadScript("/static/lib/chart/chartjs-plugin-zoom.min.js", () => window.ChartZoom)
    ).then(() => window.Chart.register(window.ChartZoom)).catch((e) => {
      _chartJsReady = null;
      throw e;
    });
  }
  return _chartJsReady;
}
var CHART_ZOOM_OPTIONS = {
  pan: { enabled: true, mode: "x" },
  zoom: {
    wheel: { enabled: true },
    drag: { enabled: true, modifierKey: "shift" },
    mode: "x"
  }
};
var CHART_COLORS = [
  "#4e79a7",
  "#f28e2b",
  "#e15759",
  "#76b7b2",
  "#59a14f",
  "#edc948",
  "#b07aa1",
  "#ff9da7",
  "#9c755f",
  "#bab0ac"
];
var GRAPH_METRICS = [
  { id: "ok", label: "Passing builds", fmt: (v) => String(Math.round(v)) },
  { id: "warning", label: "Warning builds", fmt: (v) => String(Math.round(v)) },
  { id: "failed", label: "Failed builds", fmt: (v) => String(Math.round(v)) },
  {
    id: "tests",
    label: "Tests",
    fmt: (v) => v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : `${Math.round(v)}`
  },
  {
    id: "assertions",
    label: "Assertions",
    fmt: (v) => v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : `${Math.round(v)}`
  },
  { id: "avg_mem", label: "Avg memory", fmt: (v) => `${Math.round(v / 1024 / 1024)} MB` },
  { id: "max_mem", label: "Max memory", fmt: (v) => `${Math.round(v / 1024 / 1024)} MB` },
  {
    id: "time",
    label: "Test time",
    fmt: (v) => v >= 60 ? `${Math.floor(v / 60)}m ${Math.round(v % 60)}s` : `${Math.round(v)}s`
  }
];
var NB_COUNT_METRICS = /* @__PURE__ */ new Set(["ok", "warning", "failed"]);
var NightlyScreen = class extends Component {
  static template = xml`
    <section class="nb-screen">
      <div class="panel">
        <div class="panel-top">
          <h1>Nightly builds</h1>
          <div class="panel-top-right">
            <span class="meta" t-out="this.stamp"/>
            <button class="pbtn" t-att-class="{active: this.graphMode()}" t-on-click="() => this.toggleGraph()">
              <t t-out="this.graphIcon"/> Graph
            </button>
            <button class="pbtn" t-att-disabled="this.nightly.loading()" t-on-click="() => this.refresh()">
              <t t-out="this.refreshIcon"/> Refresh
            </button>
          </div>
        </div>
      </div>
      <div class="content nb-content">
        <div t-if="this.nightly.loading() and !this.visibleNights.length" class="dim nb-status">Loading nightly build data…</div>
        <div t-elif="this.nightly.error()" class="dim nb-status">Failed to load: <t t-out="this.nightly.error()"/></div>
        <div t-elif="this.graphMode()" class="nb-graph-view">
          <div class="nb-graph-sidebar">
            <div class="nb-graph-group">
              <div class="nb-graph-label">Versions</div>
              <label class="nb-graph-check" t-foreach="this.nightly.versions()" t-as="v" t-key="v">
                <input type="checkbox" t-att-checked="this.graphVersionSel().has(v)" t-on-change="() => this.toggleGraphVersion(v)"/>
                <t t-out="this.shortVersion(v)"/>
              </label>
            </div>
            <div class="nb-graph-group">
              <div class="nb-graph-label">Series</div>
              <label class="nb-graph-check">
                <input type="checkbox" t-att-checked="this.graphShowCommunity()" t-on-change="ev => this.graphShowCommunity.set(ev.target.checked)"/>
                Community
              </label>
              <label class="nb-graph-check">
                <input type="checkbox" t-att-checked="this.graphShowEnterprise()" t-on-change="ev => this.graphShowEnterprise.set(ev.target.checked)"/>
                Enterprise
              </label>
            </div>
            <div class="nb-graph-group">
              <div class="nb-graph-label">Metrics</div>
              <label class="nb-graph-check" t-foreach="this.graphMetrics" t-as="gm" t-key="gm.id">
                <input type="checkbox" t-att-checked="this.graphMetricSel().has(gm.id)" t-on-change="() => this.toggleGraphMetric(gm.id)"/>
                <t t-out="gm.label"/>
              </label>
            </div>
          </div>
          <div class="nb-graph-main">
            <div t-if="!this.activeGraphMetrics.length" class="nb-graph-empty">Select at least one metric.</div>
            <t t-else="">
              <div class="nb-graph-chart" t-foreach="this.activeGraphMetrics" t-as="gm" t-key="gm.id">
                <div class="nb-graph-chart-title" t-out="gm.label"/>
                <canvas t-ref="this.chartRef(gm.id)"/>
              </div>
              <div t-if="this.graphNeedsDetailedMetrics" class="nb-graph-note dim">Older nights load on popover open.</div>
            </t>
            <div class="nb-graph-footer">
              <button class="pbtn" t-on-click="() => this.loadMoreGraphNights()">Load older nights</button>
            </div>
          </div>
        </div>
        <div t-elif="!this.visibleNights.length" class="dim nb-status">No nightly build data found.</div>
        <div t-else="" class="nb-grid-wrap">
          <table class="nb-table">
            <thead>
              <tr>
                <th class="nb-th-date">Night</th>
                <th t-foreach="this.nightly.versions()" t-as="v" t-key="v" class="nb-th-ver" t-att-title="v"><t t-out="this.shortVersion(v)"/></th>
              </tr>
            </thead>
            <tbody>
              <tr t-foreach="this.visibleNights" t-as="night" t-key="night.date">
                <td class="nb-td-date" t-out="night.date"/>
                <td t-foreach="this.nightly.versions()" t-as="v" t-key="v" class="nb-td-ver">
                  <div t-if="this.cellKinds(night, v)" class="nb-td-ver-stack">
                    <t t-foreach="this.cellKinds(night, v)" t-as="c" t-key="c.kind">
                      <button t-if="c.build" class="nb-build" t-att-class="this.badgeCls(c.build)"
                              t-on-click="ev => this.openPopover(ev, c.build.url, this.shortVersion(v) + ' ' + c.label + ' — ' + night.date)">
                        <span class="nb-letter" t-out="c.letter"/>
                        <t t-if="c.build.counts">
                          <span class="nb-ct nb-ct-ok" t-out="c.build.counts.ok"/>
                          <span class="nb-ct nb-ct-warn" t-out="c.build.counts.warning"/>
                          <span class="nb-ct nb-ct-fail" t-out="c.build.counts.failed"/>
                        </t>
                        <t t-else="">
                          <span class="nb-ct nb-ct-dim">?</span>
                          <span class="nb-ct nb-ct-dim">?</span>
                          <span class="nb-ct nb-ct-dim">?</span>
                        </t>
                      </button>
                      <span t-else="" class="nb-build nb-none">
                        <span class="nb-letter" t-out="c.letter"/>
                        <span class="nb-ct nb-ct-dim">—</span>
                        <span class="nb-ct nb-ct-dim">—</span>
                        <span class="nb-ct nb-ct-dim">—</span>
                      </span>
                    </t>
                  </div>
                  <span t-else="" class="nb-no-data">—</span>
                </td>
              </tr>
            </tbody>
          </table>
          <div class="nb-table-footer">
            <button class="pbtn" t-att-disabled="this.nightly.loading()" t-on-click="() => this.loadMoreNights()">
              <t t-out="this.nightly.loading() ? 'Loading…' : 'Load more'"/>
            </button>
          </div>
        </div>
      </div>

      <div t-if="this.popover()" class="nb-popover nb-popover-float"
           t-att-style="'top:' + this.popover().top + 'px; left:' + this.popover().left + 'px'">
        <div class="nb-pop-head">
          <span class="nb-pop-label" t-out="this.popover().label"/>
          <a class="nb-pop-ext" t-att-href="'https://runbot.odoo.com' + this.popover().url" target="_blank" rel="noopener" title="View this build on runbot"><t t-out="this.extIcon"/></a>
          <button class="nb-pop-btn" t-on-click="() => this.pin()"><t t-out="this.pinIcon"/></button>
        </div>
        <div t-if="this.popover().metrics.length" class="nb-pop-metrics">
          <t t-foreach="this.popover().metrics" t-as="m" t-key="m.suite">
            <div class="nb-pop-metric-row">
              <span class="nb-pop-metric-suite" t-out="m.label"/>
              <span class="nb-pop-metric-val" t-out="this.fmtMem(m.avg_mem)"/><span class="nb-pop-metric-lbl">avg</span>
              <span class="nb-pop-metric-sep">·</span>
              <span class="nb-pop-metric-val" t-out="this.fmtMem(m.max_mem)"/><span class="nb-pop-metric-lbl">max</span>
              <span class="nb-pop-metric-sep">·</span>
              <span class="nb-pop-metric-val" t-out="this.fmtTime(m.time)"/>
              <span class="nb-pop-metric-n" t-out="m.count + ' builds'"/>
            </div>
            <div t-if="m.tests != null" class="nb-pop-metric-row nb-pop-metric-row2">
              <span class="nb-pop-metric-suite"/>
              <span class="nb-pop-metric-val" t-out="m.tests"/><span class="nb-pop-metric-lbl">tests</span>
              <span class="nb-pop-metric-sep">·</span>
              <span class="nb-pop-metric-val" t-out="m.assertions"/><span class="nb-pop-metric-lbl">assertions</span>
            </div>
          </t>
        </div>
        <div class="nb-pop-body">
          <div t-if="this.popover().loading" class="nb-pop-info dim">Loading…</div>
          <div t-elif="this.popover().error" class="nb-pop-info dim">Failed: <t t-out="this.popover().error"/></div>
          <div t-elif="!this.popover().errors.length" class="nb-pop-info dim">No specific test failures found.</div>
          <ul t-else="" class="nb-pop-list">
            <li t-foreach="this.popover().errors" t-as="err" t-key="err_index"
                class="nb-pop-item" t-att-class="'nb-pop-' + err.status + (err.timeout ? ' nb-pop-timeout' : '')">
              <t t-out="err.timeout ? this.timeoutIcon : (err.status === 'danger' ? this.errIcon : this.warnIcon)"/>
              <span class="nb-pop-name" t-out="err.test_name"/>
              <span t-if="err.known || err.assignee" class="nb-pop-known" t-out="err.assignee || 'known'"/>
              <a class="nb-pop-link" t-att-href="'https://runbot.odoo.com' + err.url" target="_blank" rel="noopener"><t t-out="this.extIcon"/></a>
            </li>
          </ul>
        </div>
      </div>
      <div t-foreach="this.pinnedPopovers()" t-as="pp" t-key="pp.id" class="nb-popover nb-popover-pinned"
           t-att-style="'top:' + pp.top + 'px; left:' + pp.left + 'px'">
        <div class="nb-pop-drag nb-pop-head" t-on-mousedown="ev => this._startDrag(ev, pp.id)">
          <span class="nb-pop-label" t-out="pp.label"/>
          <a class="nb-pop-ext" t-att-href="'https://runbot.odoo.com' + pp.url" target="_blank" rel="noopener" title="View this build on runbot"><t t-out="this.extIcon"/></a>
          <button class="nb-pop-btn" t-on-click="() => this.unpin(pp.id)"><t t-out="this.closeIcon"/></button>
        </div>
        <div t-if="pp.metrics.length" class="nb-pop-metrics">
          <t t-foreach="pp.metrics" t-as="m" t-key="m.suite">
            <div class="nb-pop-metric-row">
              <span class="nb-pop-metric-suite" t-out="m.label"/>
              <span class="nb-pop-metric-val" t-out="this.fmtMem(m.avg_mem)"/><span class="nb-pop-metric-lbl">avg</span>
              <span class="nb-pop-metric-sep">·</span>
              <span class="nb-pop-metric-val" t-out="this.fmtMem(m.max_mem)"/><span class="nb-pop-metric-lbl">max</span>
              <span class="nb-pop-metric-sep">·</span>
              <span class="nb-pop-metric-val" t-out="this.fmtTime(m.time)"/>
              <span class="nb-pop-metric-n" t-out="m.count + ' builds'"/>
            </div>
            <div t-if="m.tests != null" class="nb-pop-metric-row nb-pop-metric-row2">
              <span class="nb-pop-metric-suite"/>
              <span class="nb-pop-metric-val" t-out="m.tests"/><span class="nb-pop-metric-lbl">tests</span>
              <span class="nb-pop-metric-sep">·</span>
              <span class="nb-pop-metric-val" t-out="m.assertions"/><span class="nb-pop-metric-lbl">assertions</span>
            </div>
          </t>
        </div>
        <div class="nb-pop-body">
          <div t-if="pp.loading" class="nb-pop-info dim">Loading…</div>
          <div t-elif="pp.error" class="nb-pop-info dim">Failed: <t t-out="pp.error"/></div>
          <div t-elif="!pp.errors.length" class="nb-pop-info dim">No specific test failures found.</div>
          <ul t-else="" class="nb-pop-list">
            <li t-foreach="pp.errors" t-as="err" t-key="err_index"
                class="nb-pop-item" t-att-class="'nb-pop-' + err.status + (err.timeout ? ' nb-pop-timeout' : '')">
              <t t-out="err.timeout ? this.timeoutIcon : (err.status === 'danger' ? this.errIcon : this.warnIcon)"/>
              <span class="nb-pop-name" t-out="err.test_name"/>
              <span t-if="err.known || err.assignee" class="nb-pop-known" t-out="err.assignee || 'known'"/>
              <a class="nb-pop-link" t-att-href="'https://runbot.odoo.com' + err.url" target="_blank" rel="noopener"><t t-out="this.extIcon"/></a>
            </li>
          </ul>
        </div>
      </div>
    </section>`;
  nightly = plugin(NightlyPlugin);
  graphMetrics = GRAPH_METRICS;
  refreshIcon = m(ICONS.refresh);
  // self-contained (explicit size/fill), unlike ICONS.external which relies on
  // ambient CSS (e.g. .nav-item svg) that doesn't reach the popover
  extIcon = m(
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><path d="M7 17 17 7M9 7h8v8"/></svg>`
  );
  graphIcon = m(
    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="1,13 5,7 9,10 15,3"/><line x1="1" y1="15" x2="15" y2="15"/></svg>`
  );
  errIcon = m(
    `<svg viewBox="0 0 12 12" fill="currentColor" width="12" height="12"><path d="M6 1a5 5 0 1 0 0 10A5 5 0 0 0 6 1zm.75 7.5h-1.5V7h1.5v1.5zm0-3h-1.5v-3h1.5v3z"/></svg>`
  );
  warnIcon = m(
    `<svg viewBox="0 0 12 12" fill="currentColor" width="12" height="12"><path d="M6 .5.5 11h11L6 .5zm-.75 4h1.5v3H5.25v-3zm0 4h1.5v1.5H5.25V8.5z"/></svg>`
  );
  timeoutIcon = m(
    `<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M6 2v6l4 4-4 4v6h12v-6l-4-4 4-4V2H6zm10 14.5V20H8v-3.5l4-4 4 4zm-4-5-4-4V4h8v3.5l-4 4z"/></svg>`
  );
  pinIcon = m(
    `<svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M4.146 14.354a.5.5 0 0 0 .708 0L8 11.207l3.146 3.147a.5.5 0 0 0 .708-.708L8.707 10.5l2.647-2.646A3 3 0 0 0 12 5.5V2h.5a.5.5 0 0 0 0-1h-9a.5.5 0 0 0 0 1H4v3.5a3 3 0 0 0 .646 1.854L7.293 10.5l-3.147 3.146a.5.5 0 0 0 0 .708z"/></svg>`
  );
  closeIcon = m(
    `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" width="12" height="12"><path d="M1 1l10 10M11 1L1 11"/></svg>`
  );
  popover = signal(null);
  pinnedPopovers = signal([]);
  _badgeRect = null;
  _drag = null;
  graphMode = signal(false);
  graphVersionSel = signal(/* @__PURE__ */ new Set());
  graphShowCommunity = signal(true);
  graphShowEnterprise = signal(true);
  graphMetricSel = signal(/* @__PURE__ */ new Set());
  graphCacheBust = signal(0);
  // bumped to force the chart-sync effect to re-run
  chartJsReady = signal(false);
  _charts = /* @__PURE__ */ new Map();
  // metric id -> live Chart.js instance
  _chartRefs = /* @__PURE__ */ new Map();
  // metric id -> signal.ref()
  setup() {
    this.nightly.load().then(() => this._checkFreshness());
    loadChartJs().then(() => this.chartJsReady.set(true)).catch(() => {
    });
    document.addEventListener("click", this._closePopover);
    document.addEventListener("keydown", this._onKey);
    document.addEventListener("mousemove", this._onMouseMove);
    document.addEventListener("mouseup", this._onMouseUp);
    onWillUnmount(() => {
      document.removeEventListener("click", this._closePopover);
      document.removeEventListener("keydown", this._onKey);
      document.removeEventListener("mousemove", this._onMouseMove);
      document.removeEventListener("mouseup", this._onMouseUp);
      for (const chart of this._charts.values()) chart.destroy();
      this._charts.clear();
    });
    useEffect(() => {
      const metrics = this.graphMode() ? this.activeGraphMetrics : [];
      const activeIds = new Set(metrics.map((gm) => gm.id));
      for (const [id, chart] of this._charts) {
        if (!activeIds.has(id)) {
          chart.destroy();
          this._charts.delete(id);
        }
      }
      if (!this.chartJsReady() || !metrics.length) return;
      for (const gm of metrics) {
        const canvas = this.chartRef(gm.id)();
        if (!canvas) continue;
        const { labels, datasets } = this._chartData(gm);
        let chart = this._charts.get(gm.id);
        if (chart) {
          chart.data.labels = labels;
          chart.data.datasets = datasets;
          chart.update();
        } else {
          this._charts.set(
            gm.id,
            new window.Chart(canvas, this._chartConfig(gm, labels, datasets))
          );
        }
      }
    });
  }
  _closePopover = (ev) => {
    if (this.popover() && !ev.target.closest(".nb-popover-float, .nb-build"))
      this.popover.set(null);
  };
  _onKey = (ev) => {
    if (ev.key === "Escape") this.popover.set(null);
  };
  _startDrag = (ev, id) => {
    const p = this.pinnedPopovers().find((pp) => pp.id === id);
    if (!p) return;
    this._drag = { id, offsetX: ev.clientX - p.left, offsetY: ev.clientY - p.top };
  };
  _onMouseMove = (ev) => {
    if (!this._drag) return;
    const { id, offsetX, offsetY } = this._drag;
    this.pinnedPopovers.set(
      this.pinnedPopovers().map(
        (p) => p.id === id ? { ...p, left: ev.clientX - offsetX, top: ev.clientY - offsetY } : p
      )
    );
  };
  _onMouseUp = () => {
    this._drag = null;
  };
  _checkFreshness() {
    const nights = this.nightly.nights();
    if (!nights.length) return;
    const yesterday = /* @__PURE__ */ new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (new Date(nights[0].date) < yesterday) this.nightly.load(true, 7);
  }
  _clampPopover() {
    const el = document.querySelector(".nb-popover-float");
    const p = this.popover();
    if (!el || !p) return;
    const rect = el.getBoundingClientRect();
    let { top, left } = p;
    if (rect.right > window.innerWidth) left -= rect.right - window.innerWidth + 8;
    if (left < 8) left = 8;
    if (rect.bottom > window.innerHeight) top = (this._badgeRect?.top || top) - rect.height - 6;
    if (top < 8) top = 8;
    if (top !== p.top || left !== p.left) this.popover.set({ ...p, top, left });
  }
  pin() {
    const p = this.popover();
    if (!p) return;
    this.pinnedPopovers.set([...this.pinnedPopovers(), { ...p, id: `${p.url}:${Date.now()}` }]);
    this.popover.set(null);
  }
  unpin(id) {
    this.pinnedPopovers.set(this.pinnedPopovers().filter((p) => p.id !== id));
  }
  async openPopover(ev, url, label) {
    ev.stopPropagation();
    if (this.popover()?.url === url) {
      this.popover.set(null);
      return;
    }
    const rect = ev.currentTarget.getBoundingClientRect();
    this._badgeRect = rect;
    this.popover.set({
      url,
      label,
      top: rect.bottom + 4,
      left: rect.left,
      errors: [],
      metrics: [],
      loading: true,
      error: ""
    });
    requestAnimationFrame(() => this._clampPopover());
    try {
      const res = await this.nightly.fetchErrors(url);
      const patch = {
        errors: res.errors,
        metrics: this._buildMetrics(res.metrics),
        loading: false,
        error: ""
      };
      if (this.popover()?.url === url) this.popover.set({ ...this.popover(), ...patch });
      this.pinnedPopovers.set(
        this.pinnedPopovers().map((p) => p.url === url ? { ...p, ...patch } : p)
      );
    } catch (e) {
      if (this.popover()?.url === url)
        this.popover.set({ ...this.popover(), loading: false, error: e.message });
    } finally {
      this.graphCacheBust.set(this.graphCacheBust() + 1);
    }
  }
  _buildMetrics(raw) {
    const entries = Object.entries(raw || {}).map(([suite, metric]) => ({
      suite,
      label: suite.toLowerCase().includes("mobile") ? "Mobile" : "Desktop",
      ...metric
    }));
    entries.sort((a, b) => a.label === b.label ? 0 : a.label === "Desktop" ? -1 : 1);
    return entries;
  }
  fmtMem(bytes) {
    return bytes == null ? "" : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
  fmtTime(sec) {
    if (sec == null) return "";
    const mins = Math.floor(sec / 60);
    return mins ? `${mins}m ${Math.round(sec % 60)}s` : `${Math.round(sec)}s`;
  }
  get visibleNights() {
    return this.nightly.nights();
  }
  refresh() {
    this.nightly.load(true, 7);
  }
  loadMoreNights() {
    this.nightly.load(false, this.nightly.nights().length + 7);
  }
  get stamp() {
    if (this.nightly.loading()) return "loading\u2026";
    if (!this.nightly.at()) return "";
    const secs = Math.floor((Date.now() - this.nightly.at()) / 1e3);
    if (secs < 5) return "just loaded";
    if (secs < 60) return `loaded ${secs}s ago`;
    return `loaded ${Math.floor(secs / 60)}m ago`;
  }
  statusCls(status) {
    if (status === "success") return "nb-ok";
    if (status === "warning") return "nb-warn";
    if (status === "danger") return "nb-fail";
    if (status === "info") return "nb-run";
    return "nb-none";
  }
  badgeCls(b) {
    return this.nightly.timeoutUrls().has(b.url) ? "nb-timeout" : this.statusCls(b.status);
  }
  shortVersion(v) {
    return v.startsWith("saas-") ? v.slice(5) : v;
  }
  cellKinds(night, v) {
    const vdata = night.versions[v];
    if (!vdata) return null;
    return [
      { kind: "community", letter: "C", label: "Community", build: vdata.community || null },
      { kind: "enterprise", letter: "E", label: "Enterprise", build: vdata.enterprise || null }
    ];
  }
  // ── graph mode ─────────────────────────────────────────────────────────
  toggleGraph() {
    const next = !this.graphMode();
    this.graphMode.set(next);
    if (next) {
      if (!this.graphVersionSel().size) this.graphVersionSel.set(/* @__PURE__ */ new Set(["master"]));
      this._loadRecentGraphData();
    }
  }
  toggleGraphVersion(v) {
    const s = new Set(this.graphVersionSel());
    if (s.has(v)) s.delete(v);
    else s.add(v);
    this.graphVersionSel.set(s);
  }
  toggleGraphMetric(id) {
    const s = new Set(this.graphMetricSel());
    if (s.has(id)) s.delete(id);
    else s.add(id);
    this.graphMetricSel.set(s);
  }
  get activeGraphMetrics() {
    return GRAPH_METRICS.filter((gm) => this.graphMetricSel().has(gm.id));
  }
  get graphNeedsDetailedMetrics() {
    return this.activeGraphMetrics.some((gm) => !NB_COUNT_METRICS.has(gm.id));
  }
  chartRef(id) {
    if (!this._chartRefs.has(id)) this._chartRefs.set(id, signal.ref());
    return this._chartRefs.get(id);
  }
  async _loadRecentGraphData() {
    await this._loadGraphData(this.nightly.nights().slice(0, 7));
  }
  async loadMoreGraphNights() {
    const prevCount = this.nightly.nights().length;
    await this.nightly.load(false, prevCount + 7);
    await this._loadGraphData(this.nightly.nights().slice(prevCount));
  }
  async _loadGraphData(nights) {
    const urls = /* @__PURE__ */ new Set();
    for (const night of nights) {
      for (const vdata of Object.values(night.versions || {})) {
        for (const kind of ["community", "enterprise"]) {
          const b = vdata[kind];
          if (b && !this.nightly._errorsCache.has(b.url)) urls.add(b.url);
        }
      }
    }
    const queue = [...urls];
    const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
      let url;
      while ((url = queue.pop()) !== void 0) {
        await this.nightly.fetchErrors(url).catch(() => {
        });
        this.graphCacheBust.set(this.graphCacheBust() + 1);
      }
    });
    await Promise.all(workers);
  }
  _getMetricValue(metricId, build) {
    if (NB_COUNT_METRICS.has(metricId)) return build.counts ? build.counts[metricId] : null;
    const agg = this._aggregateMetricsForBuild(build.url);
    return agg ? agg[metricId] : null;
  }
  _aggregateMetricsForBuild(url) {
    const cached = this.nightly._errorsCache.get(url);
    const suites = cached ? Object.values(cached.metrics || {}) : [];
    if (!suites.length) return null;
    return {
      tests: suites.reduce((s, m2) => s + (m2.tests || 0), 0),
      assertions: suites.reduce((s, m2) => s + (m2.assertions || 0), 0),
      time: suites.reduce((s, m2) => s + (m2.time || 0), 0),
      avg_mem: suites.reduce((s, m2) => s + m2.avg_mem, 0) / suites.length,
      max_mem: Math.max(...suites.map((m2) => m2.max_mem))
    };
  }
  _chartData(gm) {
    const nights = [...this.nightly.nights()].reverse();
    const labels = nights.map((n) => n.date.slice(5));
    const datasets = [];
    this.nightly.versions().forEach((v, vi) => {
      if (!this.graphVersionSel().has(v)) return;
      const color = CHART_COLORS[vi % CHART_COLORS.length];
      for (const [kind, enabled, dash, label] of [
        ["community", this.graphShowCommunity(), [], "Community"],
        ["enterprise", this.graphShowEnterprise(), [5, 3], "Enterprise"]
      ]) {
        if (!enabled) continue;
        const data = nights.map((n) => {
          const b = (n.versions[v] || {})[kind];
          return b ? this._getMetricValue(gm.id, b) : null;
        });
        if (data.every((d) => d == null)) continue;
        datasets.push({
          label: `${this.shortVersion(v)} ${label}`,
          data,
          borderColor: color,
          backgroundColor: color,
          borderDash: dash,
          borderWidth: 1.5,
          pointRadius: 2,
          spanGaps: false,
          tension: 0
        });
      }
    });
    return { labels, datasets };
  }
  _chartConfig(gm, labels, datasets) {
    return {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        animation: false,
        plugins: {
          legend: { position: "top", labels: { boxWidth: 20, font: { size: 10 } } },
          tooltip: {
            callbacks: { label: (ctx) => `${ctx.dataset.label}: ${gm.fmt(ctx.parsed.y)}` }
          }
        },
        scales: {
          x: { ticks: { maxRotation: 90, font: { size: 9 } } },
          y: { title: { display: true, text: gm.label }, ticks: { callback: (v) => gm.fmt(v) } }
        }
      }
    };
  }
};

// static/src/memory_screen/memory.js
var MemoryScreen = class extends Component {
  static template = xml`
    <section class="mem-screen">
      <div class="panel">
        <div class="panel-top"><h1>Memory</h1></div>
        <div class="panel-actions">
          <button class="pbtn primary" t-att-disabled="this.memory.loading() || !this.hasUrls()" t-on-click="() => this.draw()">
            <t t-out="this.memory.loading() ? 'Loading…' : 'Draw graph'"/>
          </button>
          <label class="toggle" t-att-class="{on: this.memory.withMobile()}" t-on-click="() => this.toggleMobile()">
            <span class="switch"/> With mobile
          </label>
          <span t-if="this.memory.error()" class="form-error" t-out="this.memory.error()"/>
        </div>
      </div>
      <div class="content mem-content">
        <div class="mem-sidebar" t-att-class="{collapsed: this.sidebarCollapsed()}">
          <button class="mem-sidebar-toggle" t-att-class="{collapsed: this.sidebarCollapsed()}"
                  t-att-title="this.sidebarCollapsed() ? 'Show build list' : 'Hide build list'"
                  t-on-click="() => this.toggleSidebar()">
            <t t-out="this.chevronIcon"/>
          </button>
          <t t-if="!this.sidebarCollapsed()">
            <div class="mem-batch-section">
              <div class="mem-batch-input-row">
                <input type="text" class="mem-url-input" placeholder="batch URL, e.g. https://runbot.odoo.com/runbot/batch/1/build/1"
                       t-att-value="this.memory.batchUrl()" t-on-input="ev => this.memory.setBatchUrl(ev.target.value)"
                       t-on-keydown="ev => this.onBatchKeydown(ev)"/>
                <button class="pbtn" t-att-disabled="!this.memory.batchUrl().trim() || this.memory.batchLoading()" t-on-click="() => this.fetchBatch()">
                  <t t-out="this.memory.batchLoading() ? 'Fetching…' : 'Fetch builds'"/>
                </button>
              </div>
              <span t-if="this.memory.batchError()" class="form-error" t-out="this.memory.batchError()"/>
            </div>
            <div class="mem-builds">
              <div class="mem-build-row" t-foreach="this.memory.builds()" t-as="b" t-key="b_index">
                <input type="text" class="mem-label-input" placeholder="label (e.g. master)"
                       t-att-value="b.label" t-on-input="ev => this.memory.updateBuild(b_index, 'label', ev.target.value)"/>
                <input type="text" class="mem-url-input" placeholder="log URL (e.g. https://runbot…/logs/test_only.txt)"
                       t-att-value="b.url" t-on-input="ev => this.memory.updateBuild(b_index, 'url', ev.target.value)"/>
                <button class="drop-btn" t-on-click="() => this.memory.removeBuild(b_index)">✕</button>
              </div>
              <button class="pbtn" t-on-click="() => this.addBuild()">Add build</button>
            </div>
          </t>
        </div>
        <div class="mem-chart-wrap">
          <div t-if="!this.memory.data().length &amp;&amp; !this.memory.loading() &amp;&amp; !this.memory.error()" class="dim mem-hint">
            Enter one or more build log URLs on the left and click "Draw graph".
          </div>
          <div t-if="this.memory.data().length" class="mem-chart-hint dim">Scroll to zoom · shift-drag to zoom a range · double-click to reset</div>
          <canvas t-ref="this.canvas" t-on-dblclick="() => this.resetZoom()"/>
        </div>
      </div>
    </section>`;
  memory = plugin(MemoryPlugin);
  canvas = signal.ref(HTMLElement);
  chevronIcon = m(ICONS.chevron);
  _chart = null;
  _focusRowIndex = -1;
  // index to focus on the next patch, once its DOM exists
  sidebarCollapsed = signal(false);
  setup() {
    loadChartJs().then(() => this._redraw()).catch(() => {
    });
    onWillUnmount(() => {
      if (this._chart) this._chart.destroy();
    });
    onPatched(() => {
      if (this._focusRowIndex < 0) return;
      const idx = this._focusRowIndex;
      this._focusRowIndex = -1;
      this._focusRow(idx);
    });
  }
  hasUrls() {
    return this.memory.builds().some((b) => b.url.trim());
  }
  toggleSidebar() {
    this.sidebarCollapsed.set(!this.sidebarCollapsed());
  }
  _focusRow(idx) {
    const rows = document.querySelectorAll(".mem-build-row .mem-label-input");
    rows[idx]?.focus();
  }
  addBuild() {
    const builds = this.memory.builds();
    const emptyIdx = builds.findIndex((b) => !b.label.trim() && !b.url.trim());
    if (emptyIdx !== -1) {
      this._focusRow(emptyIdx);
      return;
    }
    this.memory.addBuild();
    this._focusRowIndex = builds.length;
  }
  toggleMobile() {
    this.memory.withMobile.set(!this.memory.withMobile());
  }
  async fetchBatch() {
    await this.memory.fetchBatch();
  }
  onBatchKeydown(ev) {
    if (ev.key === "Enter") this.fetchBatch();
  }
  async draw() {
    await this.memory.load();
    this._redraw();
  }
  _redraw() {
    if (!window.Chart || !this.canvas()) return;
    if (this._chart) {
      this._chart.destroy();
      this._chart = null;
    }
    const data = this.memory.data();
    if (!data.length) return;
    const builds = Object.keys(data[0]).filter((k) => k !== "suite");
    const datasets = builds.map((build, i) => ({
      label: build,
      data: data.map(
        (d) => d[build] != null ? Math.round(d[build] / 1024 / 1024 * 100) / 100 : null
      ),
      borderColor: CHART_COLORS[i % CHART_COLORS.length],
      backgroundColor: CHART_COLORS[i % CHART_COLORS.length] + "33",
      borderWidth: 1.5,
      pointRadius: 1.5,
      spanGaps: false
    }));
    this._chart = new window.Chart(this.canvas(), {
      type: "line",
      data: { labels: data.map((d) => d.suite), datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { position: "top" },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y} MB` } },
          zoom: CHART_ZOOM_OPTIONS
        },
        scales: {
          x: { ticks: { maxRotation: 90, font: { size: 10 } } },
          y: { title: { display: true, text: "Memory (MB after GC)" } }
        }
      }
    });
  }
  resetZoom() {
    this._chart?.resetZoom();
  }
};

// static/src/core/menus.js
var ActionMenu = class extends Component {
  static template = xml`
    <div class="dash-menu action-menu" t-att-class="{hidden: !this.open()}" t-on-click.stop="() => {}">
      <button t-foreach="this.actions()" t-as="a" t-key="a_index" class="dash-menu-item"
              t-att-class="{danger: a.danger}" t-att-disabled="a.disabled" t-att-title="a.title || ''"
              t-on-click="() => this.select(a)" t-out="a.label"/>
    </div>`;
  open = signal(false);
  actions = signal([]);
  _el = null;
  setup() {
    onMounted(() => {
      this._el = document.querySelector(".action-menu");
      appBus.addEventListener("action-menu", (e) => this.openMenu(e.detail));
      document.addEventListener("click", () => this.open.set(false));
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") this.open.set(false);
      });
    });
  }
  async openMenu({ rect, actions }) {
    this.actions.set(actions);
    this.open.set(true);
    await Promise.resolve();
    const w = this._el.offsetWidth;
    const h = this._el.offsetHeight;
    let top = rect.bottom + 4;
    if (top + h > window.innerHeight - 12) top = Math.max(12, rect.top - h - 4);
    this._el.style.top = `${top}px`;
    this._el.style.left = `${Math.max(12, Math.min(rect.right - w, window.innerWidth - w - 12))}px`;
  }
  select(a) {
    if (a.disabled) return;
    this.open.set(false);
    a.onClick?.();
  }
};
var CiMenu = class extends Component {
  static template = xml`
    <div class="dash-menu ci-menu" t-att-class="{hidden: !this.open()}"
         t-on-mouseenter="() => this.cancelClose()" t-on-mouseleave="() => this.scheduleClose()">
      <a t-foreach="this.checks()" t-as="c" t-key="c_index" class="ci-menu-item" t-att-class="c.state || 'unknown'"
         t-att-href="c.url || undefined" t-att-target="c.url ? '_blank' : undefined">
        <span class="ci-menu-dot"/>
        <span class="ci-menu-ctx" t-out="c.context"/>
        <span class="ci-menu-state" t-out="this.stateLabel(c.state)"/>
      </a>
    </div>`;
  open = signal(false);
  checks = signal([]);
  _el = null;
  _closeTimer = null;
  setup() {
    onMounted(() => {
      this._el = document.querySelector(".ci-menu");
      appBus.addEventListener("ci-menu", (e) => this.openMenu(e.detail));
      appBus.addEventListener("ci-menu-hide", () => this.scheduleClose());
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") this.close();
      });
    });
  }
  cancelClose() {
    if (this._closeTimer) {
      clearTimeout(this._closeTimer);
      this._closeTimer = null;
    }
  }
  scheduleClose() {
    this.cancelClose();
    this._closeTimer = setTimeout(() => this.open.set(false), 180);
  }
  close() {
    this.cancelClose();
    this.open.set(false);
  }
  async openMenu({ rect, checks }) {
    this.cancelClose();
    this.checks.set(checks);
    this.open.set(true);
    await Promise.resolve();
    const w = this._el.offsetWidth;
    const h = this._el.offsetHeight;
    let top = rect.bottom + 4;
    if (top + h > window.innerHeight - 12) top = Math.max(12, rect.top - h - 4);
    this._el.style.top = `${top}px`;
    this._el.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - w - 12))}px`;
  }
  stateLabel(state) {
    return { success: "ok", failure: "ko", pending: "running" }[state] || "\u2014";
  }
};
var MbMenu = class extends Component {
  static template = xml`
    <div class="dash-menu mb-menu" t-att-class="{hidden: !this.open()}"
         t-on-mouseenter="() => this.cancelClose()" t-on-mouseleave="() => this.scheduleClose()">
      <a t-foreach="this.rows()" t-as="r" t-key="r_index" class="ci-menu-item mb-menu-item" t-att-class="r.cls"
         t-att-href="r.url || undefined" t-att-target="r.url ? '_blank' : undefined">
        <span class="ci-menu-dot"/>
        <span class="ci-menu-ctx" t-out="r.repo"/>
        <span class="ci-menu-state" t-out="this.label(r)"/>
      </a>
    </div>`;
  open = signal(false);
  rows = signal([]);
  _el = null;
  _closeTimer = null;
  setup() {
    onMounted(() => {
      this._el = document.querySelector(".mb-menu");
      appBus.addEventListener("mb-menu", (e) => this.openMenu(e.detail));
      appBus.addEventListener("mb-menu-hide", () => this.scheduleClose());
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") this.close();
      });
    });
  }
  cancelClose() {
    if (this._closeTimer) {
      clearTimeout(this._closeTimer);
      this._closeTimer = null;
    }
  }
  scheduleClose() {
    this.cancelClose();
    this._closeTimer = setTimeout(() => this.open.set(false), 180);
  }
  close() {
    this.cancelClose();
    this.open.set(false);
  }
  async openMenu({ rect, rows }) {
    this.cancelClose();
    this.rows.set(rows);
    this.open.set(true);
    await Promise.resolve();
    const w = this._el.offsetWidth;
    const h = this._el.offsetHeight;
    let top = rect.bottom + 4;
    if (top + h > window.innerHeight - 12) top = Math.max(12, rect.top - h - 4);
    this._el.style.top = `${top}px`;
    this._el.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - w - 12))}px`;
  }
  // "blocked · Review, CI" — the state word, plus the unmet requirements when present
  label(r) {
    return r.detail ? `${r.state} \xB7 ${r.detail}` : r.state;
  }
};

// static/src/prs_screen/prs.js
var PrsScreen = class extends Component {
  static components = { SearchBox };
  worktree = plugin(WorktreePlugin);
  // "wt" badge on PR branches owned by a worktree
  static template = xml`
    <section>
      <div class="panel">
        <div class="panel-top has-filters">
          <h1>PRs</h1>
          <div class="panel-filters">
            <button class="pbtn" t-att-class="{active: this.mode() === 'mine'}" t-on-click="() => this.setMode('mine')">Mine</button>
            <button class="pbtn" t-att-class="{active: this.mode() === 'reviewing'}" t-on-click="() => this.setMode('reviewing')">Reviewing</button>
            <SearchBox value="this.search"/>
            <select t-att-value="this.repoFilter()" t-on-change="ev => this.repoFilter.set(ev.target.value)" title="filter by repository">
              <option value="">All repositories</option>
              <option t-foreach="this.repoOptions" t-as="r" t-key="r" t-att-value="r" t-out="r"/>
            </select>
            <select t-att-value="this.statusFilter()" t-on-change="ev => this.statusFilter.set(ev.target.value)" title="filter by mergebot status">
              <option value="">All</option>
              <option value="unmerged">All (except merged)</option>
              <option value="merged">Merged</option>
              <option value="error">Error</option>
              <option value="blocked">Blocked</option>
            </select>
          </div>
          <div class="panel-top-right">
            <span class="meta" t-out="this.stamp"/>
            <button class="pbtn" t-on-click="() => this.refresh()"><t t-out="this.refreshIcon"/>Refresh</button>
          </div>
        </div>
        <div class="panel-actions">
          <button t-if="this.mode() === 'mine' and this.selectedCount" class="pbtn pr-close-batch" t-on-click="() => this.closeSelected()">Close <t t-out="this.selectedCount"/></button>
          <span t-if="this.mode() === 'reviewing'" class="dash-subtitle">Pull requests you commented on, but didn't author, in the last 14 days.</span>
          <span class="row-count" t-out="this.count"/>
        </div>
      </div>
      <div class="content br-fill">
        <div t-att-class="{busy: this.busyNow}">
          <div t-foreach="this.errors" t-as="e" t-key="e.id" class="dim br-empty" t-out="e.id + ': ' + e.error"/>
          <div t-if="this.loadError" class="dim br-empty" t-out="'Failed to load: ' + this.loadError"/>
          <div t-elif="!this.groups().length" class="dim br-empty" t-out="this.emptyMsg"/>
          <div t-else="" class="br-card">
            <!-- full-width card = scroll container (scrollbar on the right); the
                 wrapper sizes the table to its natural width, like the Branches list.
                 One tbody per branch: the branch name spans its PRs (rowspan). -->
            <div class="brg-table">
            <table class="br-table brg-flat rev-table">
              <thead>
                <tr>
                  <th t-if="this.mode() === 'mine'"><input type="checkbox" class="br-select" t-att-checked="this.allSelected" t-on-change="() => this.toggleSelectAll()" title="select all open pull requests"/></th>
                  <th>Branch</th><th>PR</th><th>Title</th><th>Repository</th><th>State</th><th>Mergebot</th><th t-out="this.dateLabel"/>
                  <th t-if="this.mode() === 'mine'"/>
                </tr>
              </thead>
              <tbody t-foreach="this.groups()" t-as="g" t-key="g.branch" class="rev-group">
                <tr t-foreach="g.prs" t-as="row" t-key="row.github + ':' + row.number" t-att-class="{'row-sel': this.mode() === 'mine' and this.selected().has(row.github + ':' + row.number)}">
                  <td t-if="this.mode() === 'mine'">
                    <input t-if="row.state === 'open' and row.github" type="checkbox" class="br-select" t-att-checked="this.selected().has(row.github + ':' + row.number)" t-on-change="() => this.toggleSelect(row.github + ':' + row.number)" title="select this PR for batch actions"/>
                  </td>
                  <td t-if="row_index === 0" class="br-name br-branch" t-att-rowspan="g.prs.length" t-att-title="g.branch">
                    <span class="br-branch-name" t-att-class="{ 'select-toggle': this.groupSelectable(g) }" t-on-click="() => this.selectGroup(g)" t-out="g.branch || '—'"/>
                  <span t-if="this.worktree.isWorktreeBranch(g.branch)" class="wt-badge" title="has a worktree">wt</span>
                    <button class="rev-star" t-att-class="{on: g.fav}" t-att-title="g.fav ? 'unfavorite branch' : 'favorite branch'" t-on-click="() => this.toggleFav(g)">★</button>
                  </td>
                  <td><a class="pr-link" target="_blank" t-att-href="row.url" t-out="'#' + row.number"/></td>
                  <td class="br-title" t-att-class="{ 'select-toggle': this.selectable(row) }"
                      t-att-title="this.selectable(row) ? (row.title || '') + ' — click to select' : row.title"
                      t-on-click="() => this.selectRow(row)" t-out="row.title || '—'"/>
                  <td class="dim" t-out="row.repoLabel"/>
                  <td><span class="pr-state" t-att-class="this.prState(row)" t-out="this.prState(row)"/></td>
                  <td>
                    <a t-if="this.mbState(row)" class="dash-pr-state" t-att-class="this.mbClass(row)" target="_blank" t-att-href="this.mergebotUrl(row)" t-att-title="'mergebot: ' + this.mbState(row) + (this.mbDetail(row) ? ' — missing: ' + this.mbDetail(row) : '')" t-out="this.mbState(row)"/>
                    <span t-else="" class="dim">—</span>
                  </td>
                  <td t-att-title="this.prDate(row)" t-out="this.prDate(row) ? this.cell(this.prDate(row)) : '—'"/>
                  <td t-if="this.mode() === 'mine'">
                    <div class="br-act">
                      <button t-if="row.state === 'open' and row.github" class="dash-kebab" title="PR actions"
                              t-on-click.stop="(ev) => this.openRowMenu(ev, row)"><t t-out="this.kebabIcon"/></button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
            </div>
          </div>
        </div>
      </div>
    </section>`;
  code = plugin(CodePlugin);
  review = plugin(ReviewPlugin);
  config = plugin(ConfigPlugin);
  dialogs = plugin(DialogPlugin);
  router = plugin(RouterPlugin);
  refreshIcon = m(ICONS.refresh);
  kebabIcon = m(ICONS.kebab);
  // "mine" = PRs I authored (CodePlugin); "reviewing" = PRs I commented on but
  // didn't author (ReviewPlugin). Seed from the route so a #reviews bookmark opens
  // on Reviewing with no flash of Mine.
  mode = signal(this.router.section() === "reviews" ? "reviewing" : "mine");
  repoFilter = signal("");
  // "" = all repositories
  search = signal("");
  statusFilter = signal("unmerged");
  // mergebot status; "" = all, "unmerged" = still in flight
  selected = signal(/* @__PURE__ */ new Set());
  // "github:number" of PRs ticked for batch close (Mine only)
  _reviewLoaded = false;
  // lazy-load guard for the Reviewing segment
  setup() {
    this.code.load();
    if (this.mode() === "reviewing") {
      this._reviewLoaded = true;
      this.review.load();
    }
    const onHash = () => this.setMode(location.hash.slice(1) === "reviews" ? "reviewing" : "mine");
    onMounted(() => window.addEventListener("hashchange", onHash));
    onWillUnmount(() => window.removeEventListener("hashchange", onHash));
    useEffect(() => {
      if (this.rows().length) this.review.loadMergebot(this._mbPrs());
    });
  }
  // flip segment; clear the Mine-only selection and lazy-load Reviewing once
  setMode(m2) {
    if (this.mode() === m2) return;
    this.mode.set(m2);
    this.selected.set(/* @__PURE__ */ new Set());
    if (m2 === "reviewing" && !this._reviewLoaded) {
      this._reviewLoaded = true;
      this.review.load();
    }
  }
  // the open PRs in mergebot's {github, number} shape (github === the slug).
  // mergebot only tracks the in-flight merge, so terminal PRs (GitHub merged or
  // closed) never need a scrape — and the authored list is fetched --state all,
  // so this is most of them. Skipping them avoids hundreds of pointless requests.
  _mbPrs() {
    return this.rows().filter((r) => r.state === "open" && !this.code.isExternalRepo(r.github)).map((r) => ({ github: r.github, number: r.number }));
  }
  // Refresh: reload the active segment, then re-probe mergebot (merged PRs stay
  // terminal; unsupported repos get re-checked so a false positive can recover)
  async refresh() {
    if (this.mode() === "mine") await this.code.load(true);
    else await this.review.load(true);
    this.review.loadMergebot(this._mbPrs(), { refresh: true });
  }
  // per-PR actions in the floating kebab menu (shared ActionMenu) — Mine only
  openRowMenu(ev, row) {
    const rect = ev.currentTarget.getBoundingClientRect();
    const actions = [
      {
        label: "Close PR",
        danger: true,
        onClick: () => this.code.closePr(row.github, row.number)
      }
    ];
    appBus.dispatchEvent(new CustomEvent("action-menu", { detail: { rect, actions } }));
  }
  // tick/untick a PR (by "github:number") for batch actions
  toggleSelect(key) {
    const sel = new Set(this.selected());
    sel.has(key) ? sel.delete(key) : sel.add(key);
    this.selected.set(sel);
  }
  // a PR can be selected (and batch-closed) only in Mine mode, while open and on GitHub
  selectable(row) {
    return this.mode() === "mine" && row.state === "open" && !!row.github;
  }
  // clicking a PR's title toggles its selection, mirroring the row checkbox
  selectRow(row) {
    if (this.selectable(row)) this.toggleSelect(`${row.github}:${row.number}`);
  }
  // a branch group's selectable PRs (Mine, open, on GitHub)
  _groupSelectable(g) {
    return g.prs.filter((r) => this.selectable(r));
  }
  // whether clicking the branch name can select anything (drives the clickable cue)
  groupSelectable(g) {
    return this._groupSelectable(g).length > 0;
  }
  // clicking the branch name toggles selection of all its selectable PRs (a branch
  // often pairs an odoo + enterprise PR): select them all when any is unselected,
  // else clear them
  selectGroup(g) {
    const keys = this._groupSelectable(g).map((r) => `${r.github}:${r.number}`);
    if (!keys.length) return;
    const sel = new Set(this.selected());
    const allSel = keys.every((k) => sel.has(k));
    for (const k of keys) allSel ? sel.delete(k) : sel.add(k);
    this.selected.set(sel);
  }
  get _selectablePrs() {
    return this.rows().filter((r) => this.selectable(r));
  }
  get allSelected() {
    const sel = this.selected();
    const selectable = this._selectablePrs;
    return selectable.length > 0 && selectable.every((r) => sel.has(`${r.github}:${r.number}`));
  }
  toggleSelectAll() {
    this.selected.set(
      this.allSelected ? /* @__PURE__ */ new Set() : new Set(this._selectablePrs.map((r) => `${r.github}:${r.number}`))
    );
  }
  // selected, still-visible, closeable PRs
  get _selectedPrs() {
    const sel = this.selected();
    return this.rows().filter((r) => sel.has(`${r.github}:${r.number}`) && this.selectable(r));
  }
  get selectedCount() {
    return this._selectedPrs.length;
  }
  // confirm, then close every selected PR
  async closeSelected() {
    const prs = this._selectedPrs;
    if (!prs.length) return;
    const res = await this.dialogs.open({
      title: "Close pull requests",
      message: `Close ${prs.length} pull request${prs.length === 1 ? "" : "s"}? This cannot be undone here (reopen on GitHub).`,
      okLabel: "Close",
      fields: []
    });
    if (!res) return;
    await Promise.all(prs.map((r) => this.code.closePrNoConfirm(r.github, r.number)));
    this.selected.set(/* @__PURE__ */ new Set());
  }
  get stamp() {
    const [loading, at] = this.mode() === "mine" ? [this.code.loading(), this.code.at()] : [this.review.loading(), this.review.at()];
    if (loading) return "refreshing\u2026";
    return at ? `updated ${timeAgo(new Date(at).toISOString())}` : "";
  }
  get busyNow() {
    return this.mode() === "mine" ? this.code.busy() : this.review.loading();
  }
  // per-repo load errors (Mine only; Reviewing has a single top-level error)
  get errors() {
    return this.mode() === "mine" ? this.code.prRepos().filter((r) => r.error) : [];
  }
  get loadError() {
    return this.mode() === "mine" ? this.code.error() : this.review.error();
  }
  get emptyMsg() {
    return this.mode() === "mine" ? "No pull requests." : "No PRs commented on in the last 14 days.";
  }
  // repository labels present in the active segment (for the filter dropdown)
  get repoOptions() {
    return [...new Set(this.rows().map((r) => r.repoLabel))].sort();
  }
  get count() {
    const n = this.groups().reduce((sum, g) => sum + g.prs.length, 0);
    return `${n} PR${n === 1 ? "" : "s"}`;
  }
  // friendly short id for a repo's github slug (e.g. "odoo/enterprise" -> "enterprise"),
  // falling back to the slug for repos not in config
  get _slugToId() {
    return Object.fromEntries(
      (this.config.config.repos || []).filter((r) => r.github).map((r) => [r.github, r.id])
    );
  }
  labelFor(github) {
    return this._slugToId[github] || github;
  }
  // PRs of the active segment, filtered by search + repository. PRs arrive already
  // normalized (see models.js), so a row is just the PR plus its display repoLabel;
  // every downstream helper reads the unified fields. Mine rows carry createdAt —
  // the date column shows it for your own PRs (their updatedAt is noisy: it bumps on
  // any comment/label long after the work).
  rows() {
    const q = this.search().trim().toLowerCase();
    const repoFilter = this.repoFilter();
    let list;
    if (this.mode() === "mine") {
      list = [];
      for (const repo of this.code.prRepos()) {
        if (repo.error) continue;
        for (const pr of repo.prs) list.push({ ...pr, repoLabel: repo.id });
      }
    } else {
      list = this.review.prs().map((pr) => ({ ...pr, repoLabel: this.labelFor(pr.github) }));
    }
    return list.filter((r) => {
      if (repoFilter && r.repoLabel !== repoFilter) return false;
      if (q && !`${r.title} ${r.repoLabel} ${r.branch} #${r.number}`.toLowerCase().includes(q))
        return false;
      return true;
    });
  }
  // normalized rows grouped by branch name. Within a group, PRs follow the config
  // repository order (e.g. odoo/odoo before odoo/enterprise); repos not in config
  // sort last. The same branch often has a PR in odoo and one in enterprise —
  // grouping keeps that work together. Groups are ordered by their most recent PR,
  // with starred branches first. The mergebot-status filter is group-level: a group
  // is kept whole when ANY of its PRs matches.
  groups() {
    const byBranch = /* @__PURE__ */ new Map();
    for (const r of this.rows()) {
      const key = r.branch || "\u2014";
      (byBranch.get(key) || byBranch.set(key, []).get(key)).push(r);
    }
    const ts = (r) => Date.parse(this.prDate(r)) || 0;
    const repoOrder = (this.config.config.repos || []).map((r) => r.github);
    const rank = (r) => {
      const i = repoOrder.indexOf(r.github);
      return i === -1 ? repoOrder.length : i;
    };
    const status = this.statusFilter();
    return [...byBranch.entries()].map(([branch, prs]) => ({
      branch,
      prs: prs.slice().sort((a, b) => rank(a) - rank(b) || a.github.localeCompare(b.github) || ts(b) - ts(a)),
      updated: Math.max(...prs.map(ts)),
      fav: this.review.isFavorite(branch)
    })).filter((g) => {
      if (!status) return true;
      if (status === "unmerged") return g.prs.some((pr) => !this._isMerged(pr));
      if (status === "merged") return g.prs.some((pr) => this._isMerged(pr));
      return g.prs.some((pr) => this.mbState(pr) === status);
    }).sort((a, b) => b.fav - a.fav || b.updated - a.updated);
  }
  // "done" for the default filter: mergebot-merged, or a terminal GitHub state
  // (merged/closed) — so "unmerged" hides finished work in both segments, the way
  // the old Mine "Open" toggle did
  _isMerged(row) {
    return this.mbState(row) === "merged" || row.state === "merged" || row.state === "closed";
  }
  // favorite (star) a whole branch group — keyed by branch name (see ReviewPlugin);
  // starred groups sort first. Shared across both segments (one branch = one star).
  toggleFav(g) {
    this.review.toggleFavorite(g.branch);
  }
  mbState(row) {
    return this.review.mergebot()[`${row.github}#${row.number}`] || "";
  }
  // the unmet merge requirements behind a blocked state, e.g. "Review, CI" ("" if none)
  mbDetail(row) {
    return this.review.mbDetails()[`${row.github}#${row.number}`] || "";
  }
  mbClass(row) {
    return mbCategory(this.mbState(row));
  }
  mergebotUrl(row) {
    return `${MERGEBOT}/${row.github}/pull/${row.number}`;
  }
  cell(date) {
    return timeAgo(date);
  }
  // the date shown in the last column: your own PRs show when they were opened
  // (createdAt); reviewed PRs show GitHub's updatedAt (no createdAt on those rows)
  prDate(row) {
    return row.createdAt || row.updatedAt;
  }
  // header for that column, matching prDate's source per segment
  get dateLabel() {
    return this.mode() === "mine" ? "Created" : "Last update";
  }
  prState(row) {
    return row.draft && row.state === "open" ? "draft" : row.state;
  }
};

// static/src/server_screen/server.js
var ServerScreen = class extends Component {
  static components = { LogConsole };
  static template = xml`
    <section>
      <div class="panel">
        <div class="panel-top">
          <div class="server-head">
            <h1>Server</h1>
            <div t-if="this.info" class="sub"><t t-out="this.info"/></div>
            <div t-if="this.hint" class="sub hint" t-out="this.hint"/>
          </div>
          <div t-if="this.uptime" class="uptime">uptime: <b t-out="this.uptime"/></div>
        </div>
        <div class="panel-actions">
          <button class="pbtn primary dash-start" t-att-disabled="!this.stopped or this.busy" t-on-click="() => this.server.start(this.target(), this.extraArgs())"><span class="play"/><t t-out="this.startLabel"/></button>
          <button class="pbtn stop" t-att-disabled="!this.canStop or this.busy" t-on-click="() => this.server.stop()"><span class="ic square"/>Stop</button>
          <button class="pbtn" t-att-disabled="!this.active or this.busy" t-on-click="() => this.server.restart(this.target(), this.extraArgs())"><span class="restart"/>Restart</button>
          <button class="pbtn pbtn-icon" t-att-class="{active: this.term.open()}" t-att-disabled="!this.active" title="Open terminal" t-on-click="() => this.term.toggle()"><t t-out="this.termIcon"/></button>
          <span t-if="this.transient" class="run-state" t-out="this.transient"/>
          <div t-if="this.showLogs" class="log-controls">
            <label class="toggle" t-att-class="{on: this.server.output.autoScroll()}" t-on-click="() => this.toggleAuto()"><span class="switch"/>Autoscroll</label>
            <button class="tool-btn" t-on-click="() => this.server.output.clear()"><t t-out="this.clearIcon"/>Clear</button>
          </div>
        </div>
      </div>
      <div class="content" t-att-class="{ flush: !this.stopped }">
        <div t-if="this.disconnected" class="offline">server is offline</div>
        <LogConsole t-elif="!this.stopped" title="'Server log'" buffer="this.server.output" bare="true"/>
        <div t-else="" class="launch-form">
          <div class="launch-field">
            <label>Target</label>
            <select t-att-value="this.target()" t-on-change="ev => this.target.set(ev.target.value)">
              <option t-foreach="this.targets" t-as="tgt" t-key="tgt.id" t-att-value="tgt.id" t-out="tgt.name"/>
            </select>
          </div>
          <div class="launch-field">
            <label>Extra arguments</label>
            <input type="text" t-att-value="this.extraArgs()" t-on-input="ev => this.extraArgs.set(ev.target.value)" placeholder="e.g. --dev all"/>
          </div>
          <div class="launch-field">
            <label>Command</label>
            <div class="cmd">
              <span class="label">launch</span>
              <div class="code" t-out="this.cmdPreviewMarkup"/>
              <button class="copy" t-on-click="() => this.copy()"><t t-out="this.copyIcon"/><span t-out="this.copyLbl()"/></button>
            </div>
          </div>
        </div>
      </div>
    </section>`;
  server = plugin(ServerPlugin);
  config = plugin(ConfigPlugin);
  term = plugin(TerminalPlugin);
  copyIcon = m(ICONS.copy);
  clearIcon = m(ICONS.clear);
  termIcon = m(ICONS.terminal);
  copyLbl = signal("Copy");
  target = signal(this._initialTarget());
  extraArgs = signal(this.config.config.start.other_args || "");
  command = signal("");
  setup() {
    let timer;
    useEffect(() => {
      const tgt = this.target();
      const args = this.extraArgs();
      clearTimeout(timer);
      timer = setTimeout(
        () => this.server.previewCommand(tgt, args).then((c) => this.command.set(c)),
        200
      );
    });
  }
  get targets() {
    return this.config.config.targets;
  }
  // last used target id if it still exists, else the first one
  _initialTarget() {
    const ids = this.targets.map((t2) => t2.id);
    const last = this.server.lastTarget();
    return ids.includes(last) ? last : ids[0] || "";
  }
  status() {
    return this.server.status();
  }
  get stopped() {
    return this.status().state === "stopped";
  }
  // an optimistic start/stop/restart is in flight (between the click and the
  // first real status event) — disable the controls so it can't be double-fired
  get busy() {
    return !!this.server.pending();
  }
  get startLabel() {
    return this.server.pending() === "start" || this.status().state === "starting" ? "Starting\u2026" : "Start";
  }
  get disconnected() {
    return this.status().state === "disconnected";
  }
  get transient() {
    const s = this.status().state;
    return s === "starting" ? "starting\u2026" : s === "stopping" ? "stopping\u2026" : null;
  }
  // logs are visible (so their controls belong in the panel) whenever we're not
  // showing the launch form or the offline message
  get showLogs() {
    return !this.stopped && !this.disconnected;
  }
  toggleAuto() {
    const b = this.server.output;
    b.autoScroll.set(!b.autoScroll());
    if (b.autoScroll()) b.toBottom();
  }
  get active() {
    return this.status().state === "starting" || this.status().state === "running";
  }
  get canStop() {
    return this.active || this.stopped && this.status().odoo_port_busy;
  }
  get cmdPreviewMarkup() {
    return m(tintCmd(this.command() || ""));
  }
  get info() {
    const s = this.status();
    if (s.db) {
      let html = `database: <b>${s.db}</b>`;
      if (s.odoo_version) {
        html += `<span class="sep">\xB7</span>odoo: <b>${s.odoo_version}</b>`;
        if (s.enterprise) html += ` (enterprise)`;
      }
      return m(html);
    }
    const tgt = this.targets.find((t2) => t2.id === this.target());
    return tgt && tgt.db ? m(`database: <b>${tgt.db}</b>`) : null;
  }
  get hint() {
    const s = this.status();
    const hints = [];
    if (s.exited_unexpectedly) hints.push(`odoo exited unexpectedly (code ${s.returncode})`);
    if (s.state === "stopped" && s.odoo_port_busy)
      hints.push("port 8069 is busy (external odoo?) \u2014 Stop will kill it");
    return hints.join(" \u2014 ") || null;
  }
  get uptime() {
    const s = this.status();
    if (s.state !== "starting" && s.state !== "running" || !s.started_at) return null;
    const secs = Math.max(0, Math.floor(this.server.now() / 1e3 - s.started_at));
    const h = Math.floor(secs / 3600), mn = Math.floor(secs % 3600 / 60), sec = secs % 60;
    return h ? `${h}h ${mn}m` : mn ? `${mn}m ${sec}s` : `${sec}s`;
  }
  copy() {
    if (!this.command()) return;
    navigator.clipboard?.writeText(this.command());
    this.copyLbl.set("Copied");
    setTimeout(() => this.copyLbl.set("Copy"), 1400);
  }
};

// static/src/tests_screen/tests.js
var TestsScreen = class extends Component {
  static components = { LogConsole };
  static template = xml`
    <section>
      <div class="panel">
        <div class="panel-top"><div class="test-title"><h1>Tests</h1><span t-if="this.badge" class="test-badge" t-att-class="this.badge.cls" t-out="this.badge.label"/></div></div>
        <div class="panel-actions">
          <form class="test-form" t-on-submit.prevent="() => this.run()">
            <select class="preset-select" t-on-change="(ev) => this.onPreset(ev)" title="presets and recent test tags">
              <option value="" selected="selected" hidden="hidden">Presets</option>
              <optgroup t-if="this.presets.length" label="Presets">
                <option t-foreach="this.presets" t-as="p" t-key="p_index" t-att-value="p.tags" t-out="p.tags"/>
              </optgroup>
              <optgroup t-if="this.tests.history().length" label="Recent">
                <option t-foreach="this.tests.history()" t-as="h" t-key="h_index" t-att-value="h" t-out="h"/>
              </optgroup>
            </select>
            <input type="text" t-att-value="this.tags()" t-on-input="ev => this.tags.set(ev.target.value)" autocomplete="off"
                   placeholder="--test-tags, e.g. my_module, :TestClass, /module_tour"/>
            <button type="button" class="tool-btn" t-att-disabled="!this.tags().trim()"
                    title="Copy a 'goo --test-tags …' command for these tags — run it on this machine (e.g. hand it to an agent) to run the test from the CLI"
                    t-on-click="() => this.copyCommand()"><t t-out="this.copyIcon"/></button>
            <button type="submit" t-att-disabled="!this.tests.target or this.tests.runActive() or !this.tags().trim()"><span class="play"/>Run</button>
            <button type="button" class="stop" t-att-disabled="!this.tests.running" t-on-click="() => this.server.stop()"><span class="ic square"/>Stop</button>
            <div class="log-controls">
              <label class="toggle" t-att-class="{on: this.tests.output.autoScroll()}" t-on-click="() => this.toggleAuto()"><span class="switch"/>Autoscroll</label>
              <button type="button" class="tool-btn" t-on-click="() => this.tests.output.clear()"><t t-out="this.clearIcon"/>Clear</button>
            </div>
          </form>
        </div>
      </div>
      <div class="content flush tests-content">
        <div t-if="!this.tests.output.count() and !this.tests.runActive()" class="tests-empty">
          <p class="tests-empty-title">No test output yet</p>
          <p class="tests-empty-hint">Pick a preset or type <code>--test-tags</code> above, then hit <strong>Run</strong> to launch a test on the active target.</p>
        </div>
        <LogConsole title="'Test output'" buffer="this.tests.output" bare="true"/>
      </div>
    </section>`;
  tests = plugin(TestsPlugin);
  server = plugin(ServerPlugin);
  config = plugin(ConfigPlugin);
  clearIcon = m(ICONS.clear);
  copyIcon = m(ICONS.copy);
  tags = signal("");
  // configured test-tag presets (Configuration tab), non-empty only
  get presets() {
    return (this.config.config.test_presets || []).filter((p) => (p.tags || "").trim());
  }
  // copy a `goo --test-tags …` command for the current tags (single-quoted so the
  // shell doesn't mangle globs); an agent can run it to run this test from the CLI
  copyCommand() {
    const tags = this.tags().trim();
    if (!tags) return;
    navigator.clipboard?.writeText(`goo --test-tags '${tags.replace(/'/g, "'\\''")}'`);
  }
  // a compact result chip shown next to the title, replacing the old status text
  get badge() {
    const s = this.tests.status();
    if (s === "passed") return { label: "success", cls: "ok" };
    if (s.startsWith("failed")) return { label: "fail", cls: "fail" };
    if (s === "running\u2026" || s === "starting\u2026") return { label: "running", cls: "run" };
    return null;
  }
  run() {
    this.tests.run(this.tags());
  }
  // fill the input from the preset/recent menu, then reset it back to "Presets"
  onPreset(ev) {
    const v = ev.target.value;
    ev.target.value = "";
    if (v) this.tags.set(v);
  }
  toggleAuto() {
    const b = this.tests.output;
    b.autoScroll.set(!b.autoScroll());
    if (b.autoScroll()) b.toBottom();
  }
};

// static/src/worktree_screen/claude_plugin.js
var CLAUDE_MODELS = [
  { value: "", label: "Default model" },
  { value: "opus[1m]", label: "Opus 4.8 \xB7 1M" },
  { value: "opus", label: "Opus 4.8" },
  { value: "sonnet", label: "Sonnet 5" },
  { value: "haiku", label: "Haiku 4.5" }
];
var ClaudePlugin = class extends Plugin {
  static sequence = 6;
  // after WorktreePlugin (5), whose wtRepos() it reuses
  config = plugin(ConfigPlugin);
  server = plugin(ServerPlugin);
  worktree = plugin(WorktreePlugin);
  eventLog = plugin(EventLogPlugin);
  dialogs = plugin(DialogPlugin);
  convos = signal({});
  // targetId -> { items: [...], state: "idle"|"running" }
  models = CLAUDE_MODELS;
  model = signal(this.config.getState("claude_model", ""));
  // chosen model, persisted
  _primed = /* @__PURE__ */ new Set();
  // targets whose transcript we've fetched from the backend
  setup() {
    this.server.onClaude((d) => this.apply(d));
  }
  setModel(v) {
    this.model.set(v || "");
    this.config.setState("claude_model", v || "");
  }
  _get(id) {
    return this.convos()[id] || { items: [], state: "idle" };
  }
  _set(id, next) {
    this.convos.set({ ...this.convos(), [id]: next });
  }
  _append(id, item) {
    const c = this._get(id);
    this._set(id, { ...c, items: [...c.items, item] });
  }
  items(id) {
    return this._get(id).items;
  }
  running(id) {
    return this._get(id).state === "running";
  }
  // a live chat item pushed from the backend (assistant text, tool activity, result,
  // or error). The final "result" ends the turn — flip back to idle.
  apply(d) {
    if (!d || !d.target) return;
    const id = d.target;
    if (d.role === "result") {
      const c = this._get(id);
      if (!d.ok && d.error) this._set(id, { ...c, items: [...c.items, d], state: "idle" });
      else this._set(id, { ...c, state: "idle" });
      return;
    }
    this._append(id, d);
  }
  // fetch the transcript once per target (after a reload the backend still holds it);
  // skip if we already have live items so an in-flight turn isn't clobbered
  async prime(id) {
    if (!id || this._primed.has(id)) return;
    this._primed.add(id);
    if (this._get(id).items.length) return;
    try {
      const res = await postJSON("/api/worktree/claude/history", { target: id });
      this._set(id, { items: res.items || [], state: res.state || "idle" });
    } catch {
    }
  }
  // send a task to Claude for <tgt>, running in its worktree's community checkout with
  // the target's other repos added as extra allowed dirs
  async send(tgt, prompt) {
    const text = (prompt || "").trim();
    if (!text || this.running(tgt.id)) return;
    const repos = this.worktree.wtRepos(tgt);
    const community = repos.find((r) => r.repo === "community");
    if (!community) {
      this._error("Cannot run Claude", "this worktree has no community repo");
      return;
    }
    const addDirs = repos.filter((r) => r.repo !== "community").map((r) => r.worktreePath);
    this._append(tgt.id, { role: "user", text });
    this._set(tgt.id, { ...this._get(tgt.id), state: "running" });
    try {
      await postJSON("/api/worktree/claude", {
        target: tgt.id,
        prompt: text,
        cwd: community.worktreePath,
        addDirs,
        model: this.model() || void 0
      });
    } catch (e) {
      this._append(tgt.id, { role: "error", text: e.message });
      this._set(tgt.id, { ...this._get(tgt.id), state: "idle" });
    }
  }
  async stop(tgt) {
    try {
      await postJSON("/api/worktree/claude/stop", { target: tgt.id });
    } catch {
    }
    this._set(tgt.id, { ...this._get(tgt.id), state: "idle" });
  }
  _error(title, message) {
    this.dialogs.open({ title, message, cls: "dialog-error", okLabel: "OK", cancelLabel: null });
  }
};

// static/src/worktree_screen/worktree.js
var ClaudeChat = class extends Component {
  static template = xml`
    <div class="cchat">
      <div class="cchat-msgs" t-ref="this.scroll">
        <div t-if="!this.items.length" class="cchat-hint dim">
          Send a task to Claude. It runs in this worktree's checkout with full autonomy —
          it can edit files and run commands here without touching your main tree.
        </div>
        <t t-foreach="this.items" t-as="m" t-key="m_index">
          <div t-if="m.role === 'user'" class="cmsg cmsg-user"><div class="cmsg-body" t-out="m.text"/></div>
          <div t-elif="m.role === 'assistant'" class="cmsg cmsg-asst"><div class="cmsg-body" t-out="m.text"/></div>
          <div t-elif="m.role === 'tool'" class="cmsg-tool">
            <span class="cmsg-tool-name" t-out="m.tool"/>
            <span t-if="m.text" class="cmsg-tool-text" t-out="m.text"/>
          </div>
          <div t-elif="m.role === 'error'" class="cmsg cmsg-error"><div class="cmsg-body" t-out="m.text"/></div>
        </t>
        <div t-if="this.running" class="cchat-working"><span class="spin"/>Claude is working…</div>
      </div>
      <div class="cchat-input">
        <div class="cchat-toolbar">
          <span class="cchat-model-label dim">Model</span>
          <select class="cchat-model" t-on-change="(ev) => this.claude.setModel(ev.target.value)">
            <option t-foreach="this.claude.models" t-as="opt" t-key="opt.value"
                    t-att-value="opt.value" t-att-selected="opt.value === this.claude.model()" t-out="opt.label"/>
          </select>
        </div>
        <div class="cchat-row">
          <textarea t-ref="this.ta" class="cchat-ta" rows="2"
                    placeholder="Describe a task —  Enter to send, Shift+Enter for a newline"
                    t-att-disabled="this.running" t-on-keydown="(ev) => this.onKey(ev)"/>
          <button t-if="!this.running" class="pbtn primary cchat-send" t-on-click="() => this.send()">Send</button>
          <button t-else="" class="pbtn stop cchat-send" t-on-click="() => this.stop()"><span class="ic square"/>Stop</button>
        </div>
      </div>
    </div>`;
  props = props({ target: t.any() });
  claude = plugin(ClaudePlugin);
  scroll = signal.ref(HTMLElement);
  ta = signal.ref(HTMLElement);
  setup() {
    onMounted(() => this.claude.prime(this.props.target.id));
    useEffect(
      () => {
        const el = this.scroll();
        if (el) el.scrollTop = el.scrollHeight;
      },
      () => [this.items.length, this.running]
    );
  }
  get items() {
    return this.claude.items(this.props.target.id);
  }
  get running() {
    return this.claude.running(this.props.target.id);
  }
  onKey(ev) {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      this.send();
    }
  }
  send() {
    const el = this.ta();
    const text = el ? el.value : "";
    if (!text.trim() || this.running) return;
    this.claude.send(this.props.target, text);
    if (el) el.value = "";
  }
  stop() {
    this.claude.stop(this.props.target);
  }
};
var WorktreeScreen = class extends Component {
  static components = { LogConsole, ClaudeChat };
  static template = xml`
    <section>
      <div class="panel">
        <div class="panel-top">
          <h1>Worktrees</h1>
          <div class="panel-top-right">
            <span class="meta" t-out="this.list.length + (this.list.length === 1 ? ' worktree' : ' worktrees')"/>
          </div>
        </div>
        <div class="panel-actions">
          <button class="pbtn primary" t-on-click="() => this.create()">Create Worktree</button>
          <span class="dash-subtitle">Run a branch in its own checkout, database and server — alongside the main one.</span>
        </div>
      </div>
      <div class="content wt-content">
        <div class="wt-list">
          <div t-if="!this.list.length" class="wt-empty dim">No worktrees yet. Create one to get started.</div>
          <button t-foreach="this.list" t-as="tgt" t-key="tgt.id" class="wt-item"
                  t-att-class="{selected: tgt.id === this.wt.selectedId()}" t-on-click="() => this.wt.select(tgt.id)">
            <span class="wt-dot" t-att-class="this.dotClass(tgt)"/>
            <span class="wt-item-main">
              <span class="wt-item-name" t-out="tgt.name"/>
              <span class="wt-item-sub"><t t-out="this.branchOf(tgt)"/> · <t t-out="tgt.db"/></span>
            </span>
            <span t-if="this.wt.port(tgt)" class="wt-item-port" t-out="':' + this.wt.port(tgt)"/>
          </button>
        </div>
        <div class="wt-detail" t-if="this.list.length">
          <t t-if="this.sel">
            <div class="wt-detail-head">
              <h2 t-out="this.sel.name"/>
              <div class="wt-meta">
                <span>branch <b t-out="this.branchOf(this.sel)"/></span>
                <span>db <b t-out="this.sel.db"/></span>
                <span t-if="this.wt.port(this.sel)">port <b t-out="this.wt.port(this.sel)"/></span>
                <span class="wt-state" t-att-class="this.dotClass(this.sel)" t-out="this.wt.serverState(this.sel)"/>
              </div>
            </div>
            <div class="wt-detail-actions">
              <button class="pbtn primary" t-att-disabled="this.wt.running(this.sel)" t-on-click="() => this.wt.startServer(this.sel)"><span class="play"/><t t-out="this.startLabel"/></button>
              <button class="pbtn stop" t-att-disabled="!this.wt.running(this.sel)" t-on-click="() => this.wt.stopServer(this.sel)"><span class="ic square"/>Stop</button>
              <button class="pbtn" t-att-disabled="!this.wt.running(this.sel)" t-on-click="() => this.wt.restartServer(this.sel)"><span class="restart"/>Restart</button>
              <span class="wt-sp"/>
              <button class="pbtn" title="open the worktree's repos in the editor" t-on-click="() => this.wt.openEditor(this.sel)"><t t-out="this.codeIcon"/>Edit</button>
              <button class="pbtn" t-att-disabled="!this.isRunning" title="open /odoo (autologin)" t-on-click="() => this.open(this.wt.odooUrl(this.sel))"><t t-out="this.externalIcon"/>/odoo</button>
              <button class="pbtn" t-att-disabled="!this.isRunning" title="open /web/tests (autologin)" t-on-click="() => this.open(this.wt.testsUrl(this.sel))"><t t-out="this.externalIcon"/>/web/tests</button>
              <span class="wt-sp"/>
              <button class="pbtn danger" t-att-disabled="this.wt.running(this.sel)" title="remove the worktree" t-on-click="() => this.wt.remove(this.sel)">Remove</button>
            </div>
            <div class="wt-panes">
              <div class="wt-tabs">
                <button class="wt-tab" t-att-class="{on: this.pane() === 'log'}" t-on-click="() => this.pane.set('log')">Server log</button>
                <button class="wt-tab" t-att-class="{on: this.pane() === 'claude'}" t-on-click="() => this.pane.set('claude')">Claude</button>
              </div>
              <div class="wt-pane" t-if="this.pane() === 'log'">
                <LogConsole t-key="this.sel.id" title="'Server log'" buffer="this.wt.logBuffer(this.sel.id)" bare="true"/>
              </div>
              <div class="wt-pane" t-else="">
                <ClaudeChat t-key="this.sel.id" target="this.sel"/>
              </div>
            </div>
          </t>
          <div t-else="" class="wt-detail-empty dim">Select a worktree on the left, or create one.</div>
        </div>
      </div>
    </section>`;
  wt = plugin(WorktreePlugin);
  config = plugin(ConfigPlugin);
  db = plugin(DatabasePlugin);
  dialogs = plugin(DialogPlugin);
  externalIcon = m(ICONS.external);
  codeIcon = m(ICONS.code);
  // "Edit" (open the worktree's repos in the editor)
  pane = signal("log");
  // which detail pane is shown: "log" | "claude"
  setup() {
    this.db.load();
  }
  get list() {
    return this.wt.worktreeTargets();
  }
  get sel() {
    return this.wt.selected();
  }
  get isRunning() {
    return !!this.sel && this.wt.serverState(this.sel) === "running";
  }
  get startLabel() {
    return this.sel && this.wt.serverState(this.sel) === "starting" ? "Starting\u2026" : "Start";
  }
  branchOf(tgt) {
    return tgt.checkouts && tgt.checkouts[0] && tgt.checkouts[0].branch || "";
  }
  dotClass(tgt) {
    return "wt-dot-" + this.wt.serverState(tgt);
  }
  open(url) {
    if (url) window.open(url, "_blank", "noopener");
  }
  async create() {
    const bases = (this.config.config.targets || []).filter((t2) => !this.wt.isWorktree(t2));
    if (!bases.length)
      return this.dialogs.open({
        title: "Create worktree",
        message: "Define a normal target first \u2014 a worktree forks its branch from one.",
        cls: "dialog-error",
        okLabel: "OK",
        cancelLabel: null
      });
    await this.db.load();
    const sanitize = (s) => (s || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    const dbNames = this.db.databases().map((d) => d.name);
    const res = await this.dialogs.open({
      title: "Create worktree",
      okLabel: "Create",
      fields: [
        {
          key: "base",
          type: "select",
          label: "Base target",
          value: bases[0].id,
          placeholder: "\u2014 pick a target \u2014",
          options: bases.map((t2) => ({ value: t2.id, label: t2.name }))
        },
        {
          key: "branch",
          type: "text",
          label: "New branch",
          placeholder: "e.g. my-feature",
          onChange: (v) => ({ db: sanitize(v) })
        },
        { key: "name", type: "text", label: "Display name (optional)" },
        { key: "db", type: "text", label: "Database" },
        {
          key: "clone",
          type: "select",
          label: "Data",
          value: "",
          placeholder: "(fresh install)",
          options: dbNames.map((n) => ({ value: n, label: "clone " + n }))
        }
      ],
      validate: (v) => {
        if (!v.base) return "pick a base target";
        if (!sanitize(v.branch)) return "enter a branch name";
        if (!sanitize(v.db)) return "enter a database name";
        if (v.clone && dbNames.includes(sanitize(v.db)))
          return `database "${sanitize(v.db)}" already exists \u2014 pick a new name to clone into`;
        return "";
      }
    });
    if (!res) return;
    await this.wt.createWorktree({
      baseTargetId: res.base,
      name: (res.name || res.branch).trim(),
      branch: sanitize(res.branch),
      dbName: sanitize(res.db),
      cloneSource: res.clone || ""
    });
  }
};

// static/src/core/app.js
var Topbar = class extends Component {
  static template = xml`
    <header class="topbar">
      <div class="top-left">
        <div class="logo"><a class="name" href="https://github.com/ged-odoo/goo" target="_blank" title="GED Odoo Overseer — open on GitHub">goo</a><span class="version" t-out="this.version"/><button t-if="this.updateAvailable" class="nav-update" t-att-title="this.updateTip" t-on-click="() => this.update.promptUpdate()">↑ update</button></div>
      </div>
      <div t-if="this.target" class="nav-target" t-att-class="this.stateClass" t-att-title="this.tooltip">
        <span class="nt-name">
          <span class="dot"/>
          <span class="t-name" t-out="this.target"/>
        </span>
        <button class="nt-toggle" t-att-class="this.toggle.cls" t-att-disabled="this.toggle.disabled" t-att-title="this.toggle.title" t-on-click="() => this.onToggle()" t-out="this.toggle.label"/>
      </div>
      <div class="top-right">
        <t t-foreach="this.routes" t-as="r" t-key="r_index">
          <a t-if="!this.isMenu(r)" class="route" t-att-href="r.href" target="_blank" t-out="r.label"/>
          <div t-elif="r.children.length" class="route-menu">
            <span class="route route-menu-label"><t t-out="r.label"/><span class="route-caret">▾</span></span>
            <div class="route-menu-drop">
              <a t-foreach="r.children" t-as="c" t-key="c_index" class="route-menu-item" t-att-href="c.href" target="_blank" t-out="c.label"/>
            </div>
          </div>
        </t>
        <button class="nav-events" t-att-class="{active: this.eventLog.open()}" t-on-click="() => this.eventLog.toggle()" t-att-title="this.eventsTip">
          <t t-out="this.journalIcon"/>
          <span t-if="this.eventLog.unread()" class="nav-events-badge" t-out="this.eventLog.unread()"/>
        </button>
      </div>
    </header>`;
  server = plugin(ServerPlugin);
  config = plugin(ConfigPlugin);
  update = plugin(UpdatePlugin);
  eventLog = plugin(EventLogPlugin);
  journalIcon = m(ICONS.journal);
  version = `v${VERSION}`;
  // event-log toggle tooltip, surfacing the unread count when there is one
  get eventsTip() {
    const n = this.eventLog.unread();
    return n ? `${n} new event${n === 1 ? "" : "s"} \u2014 toggle the event log` : "toggle the event log";
  }
  // user-configurable navbar links (/odoo + /web/tests included — they go through
  // the autologin addon and only resolve while the server is up). An entry with a
  // `children` array is a menu, rendered as a dropdown of links.
  get routes() {
    return this.config.config.links;
  }
  isMenu(r) {
    return Array.isArray(r.children);
  }
  // goo's own checkout is behind origin/master (see UpdatePlugin)
  get updateAvailable() {
    return (this.update.info()?.behind || 0) > 0;
  }
  get updateTip() {
    const u = this.update.info() || {};
    let tip = `${u.behind} commit${u.behind === 1 ? "" : "s"} behind origin/master`;
    if (u.ahead) tip += `, ${u.ahead} local commit${u.ahead === 1 ? "" : "s"} ahead`;
    if (u.dirty) tip += ", working tree dirty";
    return tip;
  }
  get active() {
    const s = this.server.status().state;
    return s === "running" || s === "starting";
  }
  // the active target id: the running one while up, else the last-used one
  get activeId() {
    const s = this.server.status();
    return s.state === "running" || s.state === "starting" ? s.target : this.server.lastTarget();
  }
  // the active target's display name (dimmed when the server is stopped)
  get target() {
    const tgt = this.config.config.targets.find((t2) => t2.id === this.activeId);
    return tgt ? tgt.name : this.activeId || "";
  }
  get stateClass() {
    const s = this.server.displayState();
    return s === "running" ? "live" : s === "starting" ? "starting" : "idle";
  }
  get tooltip() {
    return this.active ? `current target (${this.server.status().state})` : "last target \u2014 server stopped";
  }
  // the Start/Stop control on the right of the badge. "Starting…" spans the whole
  // launch — from the optimistic click (pending) through the backend's "starting"
  // phase — flipping to "Stop" only once the server reports running. An optimistic
  // `pending` likewise drives the stopping side before the first status lands.
  get toggle() {
    const pending = this.server.pending();
    const s = this.server.status().state;
    if (pending === "start" || s === "starting")
      return { label: "Starting\u2026", cls: "start", disabled: true, title: "starting the server\u2026" };
    if (pending === "stop" || pending === "restart" || s === "stopping")
      return { label: "Stopping\u2026", cls: "stop", disabled: true, title: "stopping the server\u2026" };
    if (s === "running")
      return { label: "Stop", cls: "stop", disabled: false, title: "stop the server" };
    if (s === "disconnected")
      return { label: "Start", cls: "start", disabled: true, title: "server unreachable" };
    return { label: "Start", cls: "start", disabled: false, title: "start the active target" };
  }
  onToggle() {
    const s = this.server.status().state;
    if (s === "running" || s === "starting") this.server.stop();
    else if (s === "stopped") this.server.start(this.activeId);
  }
};
var Sidebar = class extends Component {
  static template = xml`
    <nav class="sidebar">
      <button t-foreach="this.nav" t-as="item" t-key="item.id" class="nav-item"
              t-att-class="{active: this.router.section() === item.id}"
              t-on-click="() => this.router.go(item.id)">
        <t t-out="this.icon(item.icon)"/>
        <t t-out="item.label"/>
      </button>
    </nav>`;
  router = plugin(RouterPlugin);
  config = plugin(ConfigPlugin);
  // sidebar tabs from config (order + visibility, see TabsEditor); falls back to
  // the built-in NAV. Unknown configured ids are dropped; NAV tabs missing from
  // config slot in at their natural position (see mergedTabIds); Config is always
  // kept, hidden tabs are filtered out.
  get nav() {
    const meta = Object.fromEntries(NAV.map((n) => [n.id, n]));
    const configured = this.config.config.tabs;
    const cfg = Object.fromEntries((configured || []).map((t2) => [t2.id, t2]));
    const shown = (id) => id === "config" || (cfg[id] ? cfg[id].visible !== false : !meta[id].optIn);
    if (!configured || !configured.length) return NAV.filter((n) => shown(n.id));
    const out = mergedTabIds(configured).filter((id) => shown(id)).map((id) => meta[id]);
    if (!out.some((n) => n.id === "config")) out.push(meta.config);
    return out;
  }
  icon(s) {
    return m(s);
  }
};
var SCREENS = {
  dashboard: DashboardScreen,
  code: CodeScreen,
  server: ServerScreen,
  worktree: WorktreeScreen,
  targets: TargetsScreen,
  branches: BranchesScreen,
  prs: PrsScreen,
  // back-compat: old #reviews bookmarks render the merged PRs screen, which opens
  // on its Reviewing segment (PrsScreen seeds its mode from the route)
  reviews: PrsScreen,
  tests: TestsScreen,
  databases: DatabasesScreen,
  assets: AssetsScreen,
  addons: AddonsScreen,
  nightly: NightlyScreen,
  memory: MemoryScreen,
  config: ConfigScreen
};
var App = class extends Component {
  static components = {
    Topbar,
    Sidebar,
    DashboardScreen,
    CodeScreen,
    ServerScreen,
    WorktreeScreen,
    TargetsScreen,
    BranchesScreen,
    PrsScreen,
    TestsScreen,
    DatabasesScreen,
    AssetsScreen,
    AddonsScreen,
    NightlyScreen,
    MemoryScreen,
    ConfigScreen,
    ActionMenu,
    CiMenu,
    MbMenu,
    DirtyMenu,
    EventLog,
    TerminalPanel
  };
  static template = xml`
    <div class="app">
      <Topbar/>
      <div class="body">
        <Sidebar/>
        <main><t t-component="this.currentScreen()"/></main>
      </div>
      <ActionMenu/>
      <CiMenu/>
      <MbMenu/>
      <DirtyMenu/>
      <EventLog/>
      <TerminalPanel/>
      <div t-ref="this.dialogRoot"/>
      <div t-if="this.update.applying()" class="goo-updating">
        <div class="goo-updating-box"><span class="spin"/>Updating goo and restarting…</div>
      </div>
    </div>`;
  dialogRoot = plugin(DialogPlugin).root;
  router = plugin(RouterPlugin);
  server = plugin(ServerPlugin);
  update = plugin(UpdatePlugin);
  // the active screen's component class (a class, not an instance)
  currentScreen = computed(() => SCREENS[this.router.section()] || DashboardScreen);
  setup() {
    onWillStart(() => this.server.loadStatus());
    useEffect(() => {
      const state = this.server.displayState();
      const el = document.getElementById("favicon");
      const icon = state === "running" ? "favicon-up" : state === "starting" ? "favicon-starting" : state === "disconnected" ? "favicon-down" : "favicon";
      if (el) el.href = `/static/${icon}.svg`;
    });
    const onHoot = (e) => this.openHoot(e.detail.url);
    document.addEventListener("goo:open-hoot", onHoot);
    onWillUnmount(() => document.removeEventListener("goo:open-hoot", onHoot));
  }
  async openHoot(url) {
    const running = this.server.status().state === "running";
    const win = window.open(running ? url : "about:blank", "_blank");
    if (running) return;
    await this.server.start(this.server.lastTarget());
    const ok = await this.server.waitUntilRunning();
    if (win && !win.closed) {
      if (ok) win.location.href = url;
      else win.close();
    }
  }
};

// static/src/main.js
var PLUGINS = [
  StorePlugin,
  ConfigPlugin,
  RouterPlugin,
  EventLogPlugin,
  ServerPlugin,
  DatabasePlugin,
  CodePlugin,
  TestsPlugin,
  AddonsPlugin,
  AssetsPlugin,
  ReviewPlugin,
  TerminalPlugin,
  DialogPlugin,
  UpdatePlugin,
  WorktreePlugin,
  ClaudePlugin,
  NightlyPlugin,
  MemoryPlugin
];
async function boot() {
  await loadServerConfig();
  mount(App, document.getElementById("root"), { plugins: PLUGINS, dev: true });
}
boot();
