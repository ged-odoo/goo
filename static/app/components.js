// Owl 3 components. Screens stay mounted (toggled via the `hidden` class) so
// the log console keeps its streamed lines across tab switches. All state is
// read from plugins; components hold only ephemeral UI state (proxy()).
//
// Note: Owl 3 templates require `this.` to reach component members; bare
// identifiers are loop variables (t-as / t-set) only.

import {
  ConfigPlugin, RouterPlugin, ServerPlugin, DatabasePlugin,
  CodePlugin, TestsPlugin, AddonsPlugin,
} from "./plugins.js";
import { timeAgo, tintCmd, buildLogRow } from "./utils.js";

const { Component, xml, plugin, proxy, markup, onMounted, onWillUnmount, effect, EventBus, signal } = owl;

// app-wide event bus (Owl 3 has no `this.env`); used to open the branch popover
const appBus = new EventBus();
const m = (s) => markup(s);

const ICONS = {
  refresh: `<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-.6 4"/><polyline points="20 4 20 11 13 11"/></svg>`,
  clear: `<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13"/></svg>`,
  copy: `<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`,
  star: `<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z"/></svg>`,
  server: `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><circle cx="7" cy="7.5" r="1" fill="currentColor" stroke="none"/><circle cx="7" cy="16.5" r="1" fill="currentColor" stroke="none"/></svg>`,
  code: `<svg viewBox="0 0 24 24"><polyline points="8.5 8 4.5 12 8.5 16"/><polyline points="15.5 8 19.5 12 15.5 16"/></svg>`,
  tests: `<svg viewBox="0 0 24 24"><path d="M9 3h6"/><path d="M10 3v6.5L4.8 18a2 2 0 0 0 1.8 3h10.8a2 2 0 0 0 1.8-3L14 9.5V3"/><path d="M7.5 14h9"/></svg>`,
  databases: `<svg viewBox="0 0 24 24"><ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/><path d="M4 11.5v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/></svg>`,
  addons: `<svg viewBox="0 0 24 24"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5"/><path d="M12 12v9"/></svg>`,
  config: `<svg viewBox="0 0 24 24"><line x1="4" y1="8" x2="20" y2="8"/><line x1="4" y1="16" x2="20" y2="16"/><circle cx="15" cy="8" r="2.4" class="knob"/><circle cx="9" cy="16" r="2.4" class="knob"/></svg>`,
};
const NAV = [
  { id: "server", label: "Server", icon: ICONS.server, live: true },
  { id: "code", label: "Code", icon: ICONS.code },
  { id: "tests", label: "Tests", icon: ICONS.tests },
  { id: "databases", label: "Databases", icon: ICONS.databases },
  { id: "addons", label: "Addons", icon: ICONS.addons },
  { id: "config", label: "Config", icon: ICONS.config },
];
const ROUTES = [
  { href: "http://localhost:8069/odoo?debug=assets", label: "/odoo" },
  { href: "http://localhost:8069/web/tests?debug=assets&timeout=500000", label: "/web/tests" },
  { href: "https://odoo.github.io/owl/documentation/v3/owl/", label: "owl docs" },
  { href: "https://odoo.github.io/owl/playground/", label: "owl playground" },
  { href: "https://github.com/odoo/owl", label: "owl github" },
];

// ─────────────────────────── Topbar ───────────────────────────

class Topbar extends Component {
  static template = xml`
    <header class="topbar">
      <div class="top-left">
        <div class="logo"><span class="name">oo</span></div>
        <span t-if="this.pill" class="status-pill" t-att-class="this.pill.cls">
          <span class="dot"/><t t-out="this.pill.text"/>
        </span>
      </div>
      <div class="top-right">
        <a t-foreach="this.routes" t-as="r" t-key="r.label" class="route" t-att-href="r.href" target="_blank" t-out="r.label"/>
      </div>
    </header>`;
  setup() { this.server = plugin(ServerPlugin); this.routes = ROUTES; }
  get pill() {
    const s = this.server.status.state;
    const map = { starting: "STARTING", stopping: "STOPPING", disconnected: "DISCONNECTED" };
    return map[s] ? { cls: `status-pill ${s}`, text: map[s] } : null;
  }
}

// ─────────────────────────── Sidebar ───────────────────────────

class Sidebar extends Component {
  static template = xml`
    <nav class="sidebar">
      <button t-foreach="this.nav" t-as="item" t-key="item.id" class="nav-item"
              t-att-class="{active: this.router.state().section === item.id}"
              t-on-click="() => this.router.go(item.id)">
        <t t-out="this.icon(item.icon)"/>
        <t t-out="item.label"/>
        <span t-if="item.live and this.serverRunning" class="live"/>
      </button>
      <div class="spacer"/>
      <div t-if="this.env" class="env-card">
        <div class="row"><span class="k">target</span><span class="v" t-out="this.env.target"/></div>
        <div class="row"><span class="k">db</span><span class="v" t-out="this.env.db"/></div>
        <div class="row"><span class="k">pid</span><span class="v" t-out="this.env.pid"/></div>
      </div>
    </nav>`;
  setup() { this.router = plugin(RouterPlugin); this.server = plugin(ServerPlugin); this.nav = NAV; }
  icon(s) { return m(s); }
  get serverRunning() { return this.server.status.state === "running"; }
  get env() {
    const s = this.server.status;
    if (s.state !== "starting" && s.state !== "running") return null;
    return { target: s.target || "—", db: s.db || "—", pid: s.pid || "—" };
  }
}

// ─────────────────────────── Log console (manual DOM) ───────────────────────────

let consoleUid = 0;

class LogConsole extends Component {
  // props: title, mode ("server" | "task"), task (TestsPlugin|AddonsPlugin for "task"), extraClass
  static template = xml`
    <section class="console" t-att-class="this.props.extraClass">
      <div class="log-toolbar">
        <span class="console-title"><span class="cdot" t-att-class="{on: this.live}"/><t t-out="this.props.title"/></span>
        <div class="toolbar-right">
          <span class="linecount"><t t-out="this.state().count"/> lines</span>
          <label t-if="this.props.mode === 'server'" class="toggle" t-att-class="{on: this.state().auto}" t-on-click="() => this.toggleAuto()"><span class="switch"/>Autoscroll</label>
          <button class="tool-btn" t-on-click="() => this.clear()"><t t-out="this.clearIcon"/>Clear</button>
        </div>
      </div>
      <div class="log-scroll" t-att-id="this.paneId"/>
    </section>`;

  setup() {
    this.props = this.__owl__.props;
    this.server = plugin(ServerPlugin);
    this.state = signal.Object({ count: 0, auto: true });
    this.paneId = `log-pane-${consoleUid++}`;
    this.clearIcon = m(ICONS.clear);
    onMounted(() => {
      this.pane = document.getElementById(this.paneId);
      this.unsub = this.server.onLog((ev) => this.onLog(ev));
      if (this.props.mode === "task") {
        effect(() => { if (this.props.task.state().runActive) this.clear(); });
      }
    });
    onWillUnmount(() => this.unsub && this.unsub());
  }
  get live() {
    return this.props.mode === "server" ? this.server.status.state === "running" : this.props.task.running;
  }
  shouldAppend() { return this.props.mode === "server" || this.props.task.state().runActive; }
  onLog(ev) {
    if (ev.type === "reset") { if (this.props.mode === "server") this.clear(); return; }
    if (!this.shouldAppend() || !this.pane) return;
    this.pane.appendChild(buildLogRow(ev.line));
    while (this.pane.childElementCount > 2000) this.pane.firstElementChild.remove();
    this.state().count = this.pane.childElementCount;
    if (this.props.mode !== "server" || this.state().auto) this.pane.scrollTop = this.pane.scrollHeight;
  }
  toggleAuto() {
    this.state().auto = !this.state().auto;
    if (this.state().auto && this.pane) this.pane.scrollTop = this.pane.scrollHeight;
  }
  clear() { if (this.pane) { this.pane.replaceChildren(); this.state().count = 0; } }
}

// ─────────────────────────── Server screen ───────────────────────────

class ServerScreen extends Component {
  static components = { LogConsole };
  static template = xml`
    <section t-att-class="{hidden: this.router.state().section !== 'server'}">
      <div class="panel">
        <div class="panel-top">
          <div>
            <h1>Server</h1>
            <div t-if="this.info" class="sub"><t t-out="this.info"/></div>
            <div t-if="this.hint" class="sub hint" t-out="this.hint"/>
          </div>
          <div t-if="this.uptime" class="uptime"><div class="big" t-out="this.uptime"/><div class="lbl">uptime</div></div>
        </div>
        <div class="panel-actions">
          <select t-if="this.stopped" t-att-value="this.ui().target" t-on-change="ev => this.ui().target = ev.target.value" title="target to start">
            <option t-foreach="this.targets" t-as="t" t-key="t.id" t-att-value="t.id" t-out="t.id"/>
          </select>
          <div class="controls">
            <button t-att-disabled="!this.stopped" t-on-click="() => this.server.start(this.ui().target)"><span class="play"/>Start</button>
            <button class="stop" t-att-disabled="!this.canStop" t-on-click="() => this.server.stop()"><span class="ic square"/>Stop</button>
            <button t-att-disabled="!this.active" t-on-click="() => this.server.restart(this.ui().target)"><span class="restart"/>Restart</button>
          </div>
        </div>
      </div>
      <div class="content">
        <div t-if="this.status.cmd" class="cmd">
          <span class="label">launch</span>
          <div class="code" t-out="this.cmdMarkup"/>
          <button class="copy" t-on-click="() => this.copy()"><t t-out="this.copyIcon"/><span t-out="this.copyLbl"/></button>
        </div>
        <LogConsole title="'Server log'" mode="'server'"/>
      </div>
    </section>`;
  setup() {
    this.router = plugin(RouterPlugin);
    this.server = plugin(ServerPlugin);
    this.config = plugin(ConfigPlugin);
    this.copyIcon = m(ICONS.copy);
    this.copyLbl = "Copy";
    const targets = this.config.config.targets;
    this.ui = signal.Object({ target: this.server.lastTarget() || (targets[0] && targets[0].id) || "" });
  }
  get targets() { return this.config.config.targets; }
  get status() { return this.server.status; }
  get stopped() { return this.status.state === "stopped"; }
  get active() { return this.status.state === "starting" || this.status.state === "running"; }
  get canStop() { return this.active || (this.stopped && this.status.odoo_port_busy); }
  get cmdMarkup() { return m(tintCmd(this.status.cmd)); }
  get info() {
    const s = this.status;
    if (!s.db) return null;
    let html = `database: <b>${s.db}</b>`;
    if (s.odoo_version) {
      html += `<span class="sep">·</span>odoo <b>${s.odoo_version}</b>`;
      if (s.enterprise) html += `<span class="sep">·</span>enterprise`;
    }
    return m(html);
  }
  get hint() {
    const s = this.status;
    const hints = [];
    if (s.exited_unexpectedly) hints.push(`odoo exited unexpectedly (code ${s.returncode})`);
    if (s.state === "stopped" && s.odoo_port_busy) hints.push("port 8069 is busy (external odoo?) — Stop will kill it");
    return hints.join(" — ") || null;
  }
  get uptime() {
    const s = this.status;
    if ((s.state !== "starting" && s.state !== "running") || !s.started_at) return null;
    const secs = Math.max(0, Math.floor(this.server.state().now / 1000 - s.started_at));
    const h = Math.floor(secs / 3600), mn = Math.floor((secs % 3600) / 60), sec = secs % 60;
    return h ? `${h}h ${mn}m` : mn ? `${mn}m ${sec}s` : `${sec}s`;
  }
  copy() {
    if (!this.status.cmd) return;
    navigator.clipboard?.writeText(this.status.cmd);
    this.copyLbl = "Copied";
    this.render();
    setTimeout(() => { this.copyLbl = "Copy"; this.render(); }, 1400);
  }
}

// ─────────────────────────── Databases screen ───────────────────────────

class DatabasesScreen extends Component {
  static template = xml`
    <section t-att-class="{hidden: this.router.state().section !== 'databases'}">
      <div class="panel">
        <div class="panel-top"><h1>Databases</h1><span class="meta" t-out="this.stamp"/></div>
        <div class="panel-actions">
          <button class="pbtn" t-on-click="() => this.db.load(true)"><t t-out="this.refreshIcon"/>Refresh</button>
        </div>
      </div>
      <div class="content">
        <div class="db-list" t-att-class="{busy: this.db.state().dropping}">
          <div t-if="this.db.state().error" class="dim" t-out="'Failed to load: ' + this.db.state().error"/>
          <div t-elif="!this.db.state().databases.length" class="dim">No databases.</div>
          <table t-else="" class="db-table">
            <thead><tr><th>Name</th><th>Odoo version</th><th>Created</th><th>Last activity</th><th/></tr></thead>
            <tbody>
              <tr t-foreach="this.rows" t-as="d" t-key="d.name" t-att-class="{'db-active': d.active}">
                <td t-att-class="{'active-name': d.active}">
                  <span t-out="d.name"/>
                  <span t-if="d.active" class="db-badge"><span class="pulse"/>Active</span>
                </td>
                <td t-att-class="{dim: !d.version}"><t t-out="d.version || '—'"/><t t-if="d.enterprise"> (ent)</t></td>
                <td t-att-class="{dim: !d.created}" t-att-title="d.createdTitle" t-out="d.created ? d.createdAgo : '—'"/>
                <td t-att-class="{dim: !d.last}" t-att-title="d.lastTitle" t-out="d.last ? d.lastAgo : '—'"/>
                <td class="db-actions">
                  <button class="drop-btn" t-att-disabled="d.active" t-att-title="d.active ? 'in use by the running server' : ''"
                          t-on-click="() => this.db.drop(d.name)">Drop</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>`;
  setup() {
    this.router = plugin(RouterPlugin);
    this.db = plugin(DatabasePlugin);
    this.refreshIcon = m(ICONS.refresh);
    lazyLoad("databases", () => this.db.load());
  }
  get stamp() {
    if (this.db.state().loading) return "refreshing…";
    return this.db.state().at ? `updated ${timeAgo(new Date(this.db.state().at).toISOString())}` : "";
  }
  get rows() {
    const activeDb = this.db.activeDb;
    return [...this.db.state().databases]
      .sort((a, b) => (Date.parse(b.last_update) || 0) - (Date.parse(a.last_update) || 0))
      .map((d) => ({
        name: d.name, active: d.name === activeDb,
        version: d.odoo_version, enterprise: d.enterprise,
        created: d.created, createdAgo: d.created && timeAgo(d.created), createdTitle: d.created ? `${d.created} (UTC)` : "",
        last: d.last_update, lastAgo: d.last_update && timeAgo(d.last_update), lastTitle: d.last_update ? `${d.last_update} (UTC)` : "",
      }));
  }
}

// ─────────────────────────── Code screen ───────────────────────────

class CodeScreen extends Component {
  static template = xml`
    <section t-att-class="{hidden: this.router.state().section !== 'code'}">
      <div class="panel">
        <div class="panel-top"><h1>Code</h1><span class="meta" t-out="this.stamp"/></div>
        <div class="panel-actions">
          <button class="pbtn" t-on-click="() => this.code.load(true)"><t t-out="this.refreshIcon"/>Refresh</button>
        </div>
      </div>
      <div class="content">
        <div t-att-class="{busy: this.code.state().busy}">
          <div t-foreach="this.vm.errors" t-as="e" t-key="e.id" class="dim" t-out="e.id + ': ' + e.error"/>
          <div t-if="this.code.state().error" class="dim" t-out="'Failed to load: ' + this.code.state().error"/>
          <div t-elif="!this.vm.list.length" class="dim">No branches.</div>
          <table t-else="" class="db-table pr-table">
            <thead><tr><th>Branch</th><th>Repo</th><th>Last update</th><th>PR</th><th/></tr></thead>
            <tbody>
              <t t-foreach="this.vm.list" t-as="g" t-key="g.branch">
                <tr t-foreach="g.rows" t-as="row" t-key="row.repo" t-att-class="{'group-start': row_index === 0}">
                  <td t-if="row_index === 0" class="pr-branch" t-att-rowspan="g.rows.length">
                    <button class="fav-star" t-att-class="{'is-fav': g.favorite}" t-on-click="() => this.code.toggleFavorite(g.branch)"><t t-out="this.starIcon"/></button>
                    <button t-if="!g.base" class="branch-trigger" t-on-click.stop="(ev) => this.openMenu(ev, g)" t-out="g.branch"/>
                    <span t-else="" t-out="g.branch"/>
                    <span t-if="!g.base" class="runbot-inline">
                      <span class="runbot-paren">(</span>
                      <a class="runbot-link" target="_blank" t-att-href="this.code.bundleUrl(g.branch)">runbot</a>
                      <span class="runbot-dot" t-att-class="g.runbot || 'unknown'" t-att-title="'runbot: ' + (g.runbot || 'unknown')"/>
                      <span class="runbot-paren">)</span>
                    </span>
                  </td>
                  <td class="dim" t-out="row.repo"/>
                  <td t-att-title="row.date" t-out="row.date ? this.cell(row.date) : '—'"/>
                  <td t-att-class="{dim: !this.pr(g, row)}">
                    <t t-set="p" t-value="this.pr(g, row)"/>
                    <t t-if="p">
                      <a class="pr-link" target="_blank" t-att-href="p.url" t-out="'#' + p.number"/>
                      <span class="pr-state" t-att-class="this.prState(p)" t-out="this.prState(p)"/>
                    </t>
                    <t t-else="">—</t>
                  </td>
                  <td/>
                </tr>
              </t>
            </tbody>
          </table>
        </div>
      </div>
    </section>`;
  setup() {
    this.router = plugin(RouterPlugin);
    this.code = plugin(CodePlugin);
    this.refreshIcon = m(ICONS.refresh);
    this.starIcon = m(ICONS.star);
    lazyLoad("code", () => this.code.load());
  }
  get stamp() {
    if (this.code.state().loading) return "refreshing…";
    return this.code.state().at ? `updated ${timeAgo(new Date(this.code.state().at).toISOString())}` : "";
  }
  get vm() { return this.code.groups(); }
  cell(date) { return timeAgo(date); }
  pr(g, row) { return this.vm.prIndex[`${row.repo}:${g.branch}`]; }
  prState(p) { const st = p.isDraft && p.state === "OPEN" ? "DRAFT" : p.state; return st.toLowerCase(); }
  openMenu(ev, g) { appBus.trigger("branch-menu", { ev, group: g, vm: this.vm }); }
}

// ─────────────────────────── Tests screen ───────────────────────────

class TestsScreen extends Component {
  static components = { LogConsole };
  static template = xml`
    <section t-att-class="{hidden: this.router.state().section !== 'tests'}">
      <div class="panel">
        <div class="panel-top"><h1>Tests</h1><span class="meta" t-out="this.tests.state().status"/></div>
        <div class="panel-actions">
          <form class="test-form" t-on-submit.prevent="() => this.run()">
            <select t-att-value="this.ui().target" t-on-change="ev => this.ui().target = ev.target.value" title="target (database + addons)">
              <option t-foreach="this.targets" t-as="t" t-key="t.id" t-att-value="t.id" t-out="t.id"/>
            </select>
            <input type="text" t-att-value="this.ui().tags" t-on-input="ev => this.ui().tags = ev.target.value" autocomplete="off"
                   placeholder="--test-tags, e.g. my_module, :TestClass, /module_tour"/>
            <button type="submit"><span class="play"/>Run</button>
            <button type="button" class="stop" t-att-disabled="!this.tests.running" t-on-click="() => this.server.stop()"><span class="ic square"/>Stop</button>
          </form>
        </div>
      </div>
      <div class="content">
        <LogConsole title="'Test output'" mode="'task'" task="this.tests"/>
      </div>
    </section>`;
  setup() {
    this.router = plugin(RouterPlugin);
    this.tests = plugin(TestsPlugin);
    this.server = plugin(ServerPlugin);
    this.config = plugin(ConfigPlugin);
    const targets = this.config.config.targets;
    this.ui = signal.Object({ target: (targets[0] && targets[0].id) || "", tags: "" });
  }
  get targets() { return this.config.config.targets; }
  run() { this.tests.run(this.ui().target, this.ui().tags); }
}

// ─────────────────────────── Addons screen ───────────────────────────

class AddonsScreen extends Component {
  static components = { LogConsole };
  static template = xml`
    <section t-att-class="{hidden: this.router.state().section !== 'addons'}">
      <div class="panel">
        <div class="panel-top"><h1>Addons</h1><span class="meta" t-out="this.addons.state().status"/></div>
        <div class="panel-actions">
          <select t-att-value="this.addons.state().targetId" t-on-change="ev => this.onTargetChange(ev)" title="target (database + addons)">
            <option t-foreach="this.targets" t-as="t" t-key="t.id" t-att-value="t.id" t-out="t.id"/>
          </select>
          <input type="text" t-att-value="this.addons.state().filter" t-on-input="ev => this.addons.state().filter = ev.target.value" placeholder="Filter modules…" autocomplete="off"/>
          <button class="pbtn" t-on-click="() => this.addons.load(this.addons.state().targetId)"><t t-out="this.refreshIcon"/>Refresh</button>
          <button type="button" class="addons-stop" t-att-disabled="!this.addons.running" t-on-click="() => this.server.stop()">Stop</button>
        </div>
      </div>
      <div class="content">
        <div class="addons-list">
          <div t-if="this.addons.state().loading" class="dim">Loading…</div>
          <div t-elif="this.addons.state().error" class="dim" t-out="'Failed to load: ' + this.addons.state().error"/>
          <div t-elif="!this.view.total" class="dim">No modules match.</div>
          <t t-else="">
            <table class="db-table addons-table">
              <thead><tr><th>Module</th><th>Repo</th><th>State</th><th/></tr></thead>
              <tbody>
                <tr t-foreach="this.view.shown" t-as="mod" t-key="mod.name">
                  <td class="addon-name" t-att-title="mod.summary" t-att-class="{'active-name': mod.state === 'installed'}" t-out="mod.name"/>
                  <td class="dim" t-out="mod.repo"/>
                  <td><span class="addon-state" t-att-class="this.stateClass(mod)" t-out="mod.state || '—'"/></td>
                  <td class="db-actions">
                    <button class="drop-btn" t-att-disabled="this.addons.state().runActive or mod.installable === false"
                            t-on-click="() => this.addons.run(mod.state === 'installed' ? 'upgrade' : 'install', mod.name, this.addons.state().targetId)"
                            t-out="mod.state === 'installed' ? 'Upgrade' : 'Install'"/>
                  </td>
                </tr>
              </tbody>
            </table>
            <div t-if="this.view.total > this.view.shown.length" class="dim addons-more"
                 t-out="'Showing ' + this.view.shown.length + ' of ' + this.view.total + ' — refine the filter to see more.'"/>
          </t>
        </div>
        <LogConsole title="'Install / upgrade output'" mode="'task'" task="this.addons" extraClass="'addons-console'"/>
      </div>
    </section>`;
  setup() {
    this.router = plugin(RouterPlugin);
    this.addons = plugin(AddonsPlugin);
    this.server = plugin(ServerPlugin);
    this.config = plugin(ConfigPlugin);
    this.refreshIcon = m(ICONS.refresh);
    if (!this.addons.state().targetId) {
      const t = this.config.config.targets[0];
      this.addons.state().targetId = t ? t.id : "";
    }
    lazyLoad("addons", () => {
      if (this.addons.state().loadedFor !== this.addons.state().targetId) this.addons.load(this.addons.state().targetId);
    });
  }
  get targets() { return this.config.config.targets; }
  get view() { return this.addons.filtered(); }
  stateClass(mod) { return (mod.state || "none").replace(/\s+/g, "-"); }
  onTargetChange(ev) { this.addons.state().targetId = ev.target.value; this.addons.load(ev.target.value); }
}

// ─────────────────────────── Config screen ───────────────────────────

class ListEditor extends Component {
  // props: kind ("repos"|"targets")
  static template = xml`
    <div class="config-block">
      <h2 class="subtitle" t-out="this.spec.title"/>
      <div class="rows">
        <div t-foreach="this.state().rows" t-as="row" t-key="row_index" class="edit-row">
          <input t-foreach="this.spec.fields" t-as="f" t-key="f.key" t-att-class="f.className"
                 t-att-placeholder="f.placeholder" t-att-value="row[f.key]" t-on-input="ev => row[f.key] = ev.target.value"/>
          <button class="row-remove" title="remove" t-on-click="() => this.removeRow(row_index)">✕</button>
        </div>
      </div>
      <div class="config-actions">
        <button t-on-click="() => this.addRow()" t-out="'Add ' + this.spec.itemName"/>
        <button t-on-click="() => this.save()">Save</button>
        <button t-on-click="() => this.reset()">Reset to defaults</button>
        <span t-att-class="this.msg().cls" t-out="this.msg().text"/>
      </div>
    </div>`;
  setup() {
    this.props = this.__owl__.props;
    this.config = plugin(ConfigPlugin);
    this.spec = SPECS[this.props.kind];
    this.state = signal.Object({ rows: [] });
    this.msg = signal.Object({ text: "", cls: "" });
    this.load();
  }
  load() {
    this.state().rows = this.config.config[this.spec.key].map((item) => {
      const r = {};
      for (const f of this.spec.fields) r[f.key] = f.format ? f.format(item[f.key]) : (item[f.key] || "");
      return r;
    });
  }
  addRow() { const r = {}; for (const f of this.spec.fields) r[f.key] = ""; this.state().rows = [...this.state().rows, r]; }
  removeRow(i) { this.state().rows = this.state().rows.filter((_, j) => j !== i); }
  flash(text, isError) {
    this.msg().text = text; this.msg().cls = isError ? "error" : "ok";
    if (!isError) setTimeout(() => { this.msg().text = ""; }, 2000);
  }
  save() {
    const items = []; const seen = new Set();
    for (const row of this.state().rows) {
      const raw = {};
      for (const f of this.spec.fields) raw[f.key] = (row[f.key] || "").trim();
      if (this.spec.fields.every((f) => !raw[f.key])) continue;
      for (const f of this.spec.fields) {
        if (!f.optional && !raw[f.key]) return this.flash(`every ${this.spec.itemName} needs a ${f.name}`, true);
      }
      if (seen.has(raw.id)) return this.flash(`duplicate ${this.spec.fields[0].name} "${raw.id}"`, true);
      seen.add(raw.id);
      const item = {};
      for (const f of this.spec.fields) item[f.key] = f.parse ? f.parse(raw[f.key]) : raw[f.key];
      items.push(item);
    }
    const err = this.spec.validate(items, this.config.config);
    if (err) return this.flash(err, true);
    this.config.updateConfig({ [this.spec.key]: items });
    this.load();
    this.flash("saved");
  }
  reset() {
    if (!confirm(`Reset ${this.spec.itemName}s to the built-in defaults?`)) return;
    this.config.resetKey(this.spec.key);
    this.load();
    this.flash("reset to defaults");
  }
}

class ConfigScreen extends Component {
  static components = { ListEditor };
  static template = xml`
    <section t-att-class="{hidden: this.router.state().section !== 'config'}">
      <div class="panel"><div class="panel-top"><h1>Config</h1></div></div>
      <div class="content">
        <ListEditor kind="'repos'"/>
        <ListEditor kind="'targets'"/>
        <div class="config-block">
          <h2 class="subtitle">Storage</h2>
          <p class="dim">By default, config and favorites live only in this browser. Set a file path to persist them on disk instead — shared across browsers and safe from clearing site data.</p>
          <div class="config-actions">
            <input type="text" class="w-flex" t-att-value="this.ui().path" t-on-input="ev => this.ui().path = ev.target.value" placeholder="e.g. ~/.config/oo/data.json"/>
            <button t-on-click="() => this.useFile()">Use file</button>
            <button t-on-click="() => this.clearFile()">Use browser</button>
            <span t-out="this.ui().msg"/>
          </div>
        </div>
        <div class="config-block">
          <h2 class="subtitle">Backup</h2>
          <p class="dim">Save your config and favorites to a file, or restore them from one.</p>
          <div class="config-actions">
            <button t-on-click="() => this.exportData()">Export</button>
            <button t-on-click="() => this.triggerImport()">Import</button>
            <input type="file" id="oo-import-file" accept="application/json,.json" hidden="hidden" t-on-change="(ev) => this.importData(ev)"/>
            <span t-out="this.ui().backupMsg"/>
          </div>
        </div>
      </div>
    </section>`;
  setup() {
    this.router = plugin(RouterPlugin);
    this.config = plugin(ConfigPlugin);
    this.ui = signal.Object({ path: this.config.getDataFile(), msg: "", backupMsg: "" });
  }
  triggerImport() { document.getElementById("oo-import-file").click(); }
  async useFile() {
    try { this.ui().msg = await this.config.useFile(this.ui().path); setTimeout(() => location.reload(), 700); }
    catch (e) { this.ui().msg = `Could not use file: ${e.message}`; }
  }
  clearFile() { this.config.clearFile(); this.ui().path = ""; this.ui().msg = "Using browser storage."; }
  exportData() {
    const data = {};
    for (const k of ["oo-config", "oo-prs-favorites", "oo-last-target"]) {
      const v = localStorage.getItem(k); if (v !== null) data[k] = v;
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "oo-backup.json"; a.click();
    URL.revokeObjectURL(a.href); this.ui().backupMsg = "Exported.";
  }
  async importData(ev) {
    const file = ev.target.files[0]; ev.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data !== "object") throw new Error("not a JSON object");
      let n = 0;
      for (const k of ["oo-config", "oo-prs-favorites", "oo-last-target"]) {
        if (typeof data[k] === "string") { localStorage.setItem(k, data[k]); n++; }
      }
      if (!n) throw new Error("no recognized data in file");
      if (this.config.getDataFile()) await this.config.flush(this.config.getDataFile());
      this.ui().backupMsg = `Imported ${n} item(s), reloading…`;
      setTimeout(() => location.reload(), 700);
    } catch (e) { this.ui().backupMsg = `Import failed: ${e.message}`; }
  }
}

// ─────────────────────────── Branch action popover ───────────────────────────

class BranchMenu extends Component {
  static template = xml`
    <div class="branch-popover" t-att-class="{hidden: !this.state().open}" t-on-click.stop="() => {}">
      <button t-foreach="this.state().actions" t-as="a" t-key="a_index" class="branch-popover-item"
              t-att-class="{danger: a.danger}" t-att-disabled="a.disabled" t-att-title="a.title || ''"
              t-on-click="() => this.select(a)" t-out="a.label"/>
    </div>`;
  setup() {
    this.code = plugin(CodePlugin);
    this.state = signal.Object({ open: false, actions: [] });
    this.el = null;
    onMounted(() => {
      this.el = document.querySelector(".branch-popover");
      appBus.addEventListener("branch-menu", (e) => this.open(e.detail));
      document.addEventListener("click", () => this.close());
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") this.close(); });
    });
  }
  close() { this.state().open = false; }
  async open({ ev, group, vm }) {
    const { actions, resolvers } = this.buildActions(group, vm);
    this.state().actions = actions;
    this.state().open = true;
    await Promise.resolve();
    const r = ev.currentTarget.getBoundingClientRect();
    const w = this.el.offsetWidth;
    this.el.style.top = `${r.bottom + 4}px`;
    this.el.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - w - 12))}px`;
    for (const { index, run } of resolvers) {
      run().then((patch) => Object.assign(this.state().actions[index], patch));
    }
  }
  select(a) { if (!a.disabled && a.onClick) { this.close(); a.onClick(); } }
  buildActions(group, vm) {
    const code = this.code;
    const actions = [];
    const resolvers = [];
    for (const r of group.rows) {
      const github = vm.githubByRepo[r.repo];
      if (!github) continue;
      const path = vm.pathByRepo[r.repo];
      const pr = vm.prIndex[`${r.repo}:${group.branch}`];
      const linkAction = { label: `Branch on GitHub — ${r.repo}`, disabled: false, onClick: () => window.open(code.forkBranchUrl(github, group.branch), "_blank") };
      actions.push({ label: `Checking GitHub… — ${r.repo}`, disabled: true });
      resolvers.push({
        index: actions.length - 1,
        run: async () => {
          if (pr || r.remote) return linkAction;
          try {
            return (await code.remoteExists(path, group.branch))
              ? linkAction
              : { label: `Push branch to GitHub — ${r.repo}`, disabled: false, onClick: () => code.pushBranch(path, group.branch) };
          } catch (e) { return { label: `GitHub check failed — ${r.repo}`, disabled: true, title: e.message }; }
        },
      });
      if (!pr) actions.push({ label: `Create PR — ${r.repo}`, onClick: () => window.open(code.prCreateUrl(github, group.branch), "_blank") });
      else if (pr.state === "OPEN") actions.push({ label: `Close PR #${pr.number} — ${r.repo}`, danger: true, onClick: () => code.closePr(github, pr.number) });
    }
    for (const r of group.rows) {
      actions.push({
        label: `Delete local branch — ${r.repo}`, danger: true,
        disabled: r.checkedOut, title: r.checkedOut ? "currently checked out" : "",
        onClick: () => code.deleteBranch(group.branch, r.repo, vm.pathByRepo[r.repo]),
      });
    }
    actions.push({ label: "Rebase onto base", disabled: true, title: "coming soon" });
    return { actions: proxy(actions), resolvers };
  }
}

// ─────────────────────────── Root ───────────────────────────

export class App extends Component {
  static components = { Topbar, Sidebar, ServerScreen, CodeScreen, TestsScreen, DatabasesScreen, AddonsScreen, ConfigScreen, BranchMenu };
  static template = xml`
    <div class="app">
      <Topbar/>
      <div class="body">
        <Sidebar/>
        <main>
          <ServerScreen/>
          <CodeScreen/>
          <TestsScreen/>
          <DatabasesScreen/>
          <AddonsScreen/>
          <ConfigScreen/>
        </main>
      </div>
      <BranchMenu/>
    </div>`;
  setup() {
    this.server = plugin(ServerPlugin);
    effect(() => {
      const running = this.server.status.state === "running";
      const el = document.getElementById("favicon");
      if (el) el.href = running ? "/static/favicon-on.svg" : "/static/favicon.svg";
    });
  }
}

// ─────────────────────────── helpers ───────────────────────────

function lazyLoad(section, fn) {
  const router = plugin(RouterPlugin);
  let done = false;
  effect(() => { if (!done && router.state().section === section) { done = true; fn(); } });
}

const commaList = {
  format: (v) => (v || []).join(","),
  parse: (s) => s.split(",").map((x) => x.trim()).filter(Boolean),
};
const SPECS = {
  repos: {
    key: "repos", title: "Repositories", itemName: "repository",
    fields: [
      { key: "id", name: "name", placeholder: "name (e.g. community)", className: "w-name" },
      { key: "path", name: "path", placeholder: "path (e.g. ~/work/community)", className: "w-flex" },
      { key: "github", name: "github repo", placeholder: "github (e.g. odoo/odoo)", className: "w-name", optional: true },
    ],
    validate(repos, config) {
      if (!repos.find((r) => r.id === "community")) return 'a "community" repository is required (odoo-bin lives there)';
      const ids = new Set(repos.map((r) => r.id));
      for (const t of config.targets) {
        const used = (t.repos || []).find((id) => !ids.has(id));
        if (used) return `repository "${used}" is still used by target "${t.id}"`;
      }
      return null;
    },
  },
  targets: {
    key: "targets", title: "Targets", itemName: "target",
    fields: [
      { key: "id", name: "id", placeholder: "id (e.g. enterprise)", className: "w-name" },
      { key: "repos", name: "repos list", placeholder: "repos (e.g. community,enterprise)", className: "w-mid", ...commaList },
      { key: "db", name: "db", placeholder: "db (e.g. test_db_e)", className: "w-name" },
      { key: "on_create_args", name: "on-create args", placeholder: "on create args (e.g. -i sale_management)", className: "w-flex", optional: true },
    ],
    validate(targets, config) {
      const repoIds = new Set(config.repos.map((r) => r.id));
      for (const t of targets) {
        const unknown = t.repos.find((id) => !repoIds.has(id));
        if (unknown) return `target "${t.id}": unknown repository "${unknown}"`;
      }
      return null;
    },
  },
};
