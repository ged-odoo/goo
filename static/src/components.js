// Owl 3 components. Screens stay mounted (toggled via the `hidden` class) so
// the log console keeps its streamed lines across tab switches. Plugin refs,
// signals and constants are class fields; setup() is only for lifecycle. State
// is held in individual signals (read via signal() in templates); component
// props use the props({...}) helper with `t` types.

import { BASE_BRANCH_RE, MERGEBOT, VERSION } from "./config.js";
import { PRESETS } from "./presets.js";
import { ConfigPlugin, newTargetId } from "./config_plugin.js";
import { RouterPlugin } from "./router_plugin.js";
import { ServerPlugin } from "./server_plugin.js";
import { DatabasePlugin } from "./database_plugin.js";
import { CodePlugin } from "./code_plugin.js";
import { TestsPlugin } from "./tests_plugin.js";
import { AddonsPlugin } from "./addons_plugin.js";
import { AssetsPlugin } from "./assets_plugin.js";
import { ReviewPlugin } from "./review_plugin.js";
import { EventLogPlugin } from "./event_log_plugin.js";
import { TerminalPlugin } from "./terminal_plugin.js";
import { DialogPlugin } from "./dialog_plugin.js";
import { UpdatePlugin } from "./update_plugin.js";
import { WorktreePlugin } from "./worktree_plugin.js";
import { ClaudePlugin } from "./claude_plugin.js";
import { timeAgo, tintCmd, formatBytes } from "./utils.js";

const {
  Component,
  xml,
  plugin,
  markup,
  onMounted,
  onPatched,
  onWillStart,
  onWillUnmount,
  useEffect,
  EventBus,
  signal,
  computed,
  props,
  t,
} = owl;

// app-wide event bus (Owl 3 has no `this.env`); used to open the branch popover
const appBus = new EventBus();
const m = (s) => markup(s);

// map a mergebot state string to its color category (the badge's CSS class)
function mbCategory(s) {
  if (s === "merged") return "merged";
  if (["ready", "approved", "validated", "mergeable", "reviewed"].includes(s)) return "ready";
  if (["staged", "staging", "squashed", "pending"].includes(s)) return "progress";
  if (["blocked", "error"].includes(s)) return "blocked";
  return "other";
}

const ICONS = {
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
};
const NAV = [
  { id: "dashboard", label: "Dashboard", icon: ICONS.code },
  { id: "targets", label: "Targets", icon: ICONS.target },
  { id: "server", label: "Server", icon: ICONS.server },
  { id: "worktree", label: "Worktrees", icon: ICONS.worktree, optIn: true },
  { id: "tests", label: "Tests", icon: ICONS.tests },
  { id: "branches", label: "Branches", icon: ICONS.branches },
  { id: "prs", label: "PRs", icon: ICONS.pr },
  { id: "assets", label: "Assets", icon: ICONS.assets },
  { id: "addons", label: "Addons", icon: ICONS.addons },
  { id: "databases", label: "Databases", icon: ICONS.databases },
  { id: "config", label: "Configuration", icon: ICONS.config },
];
// Merge a saved tab config with NAV → the ordered list of tab ids to show. The
// user's order is preserved for tabs they've configured; any NAV tab missing from
// their config (e.g. a newly-shipped one) is inserted at its natural NAV position
// — right after its NAV predecessor — instead of tacked on at the end.
function mergedTabIds(configured) {
  const inNav = new Set(NAV.map((n) => n.id));
  const out = [];
  const seen = new Set();
  for (const t of configured || []) {
    if (!inNav.has(t.id) || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t.id);
  }
  let anchor = -1; // index in `out` of the last NAV tab we've placed/seen
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
// ─────────────────────────── Topbar ───────────────────────────

class Topbar extends Component {
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
    return n
      ? `${n} new event${n === 1 ? "" : "s"} — toggle the event log`
      : "toggle the event log";
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
    const tgt = this.config.config.targets.find((t) => t.id === this.activeId);
    return tgt ? tgt.name : this.activeId || "";
  }

  get stateClass() {
    // displayState() is orange the moment Start is clicked, held through "starting"
    const s = this.server.displayState();
    return s === "running" ? "live" : s === "starting" ? "starting" : "idle";
  }

  get tooltip() {
    return this.active
      ? `current target (${this.server.status().state})`
      : "last target — server stopped";
  }

  // the Start/Stop control on the right of the badge. "Starting…" spans the whole
  // launch — from the optimistic click (pending) through the backend's "starting"
  // phase — flipping to "Stop" only once the server reports running. An optimistic
  // `pending` likewise drives the stopping side before the first status lands.
  get toggle() {
    const pending = this.server.pending();
    const s = this.server.status().state;
    if (pending === "start" || s === "starting")
      return { label: "Starting…", cls: "start", disabled: true, title: "starting the server…" };
    if (pending === "stop" || pending === "restart" || s === "stopping")
      return { label: "Stopping…", cls: "stop", disabled: true, title: "stopping the server…" };
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
}

// ─────────────────────────── Sidebar ───────────────────────────

class Sidebar extends Component {
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
    // config wins; an unconfigured tab defaults to visible, EXCEPT opt-in tabs (e.g.
    // Worktrees) which stay hidden until enabled in the Tabs editor. Config is always shown.
    const cfg = Object.fromEntries((configured || []).map((t) => [t.id, t]));
    const shown = (id) =>
      id === "config" || (cfg[id] ? cfg[id].visible !== false : !meta[id].optIn);
    if (!configured || !configured.length) return NAV.filter((n) => shown(n.id));
    const out = mergedTabIds(configured)
      .filter((id) => shown(id))
      .map((id) => meta[id]);
    if (!out.some((n) => n.id === "config")) out.push(meta.config);
    return out;
  }

  icon(s) {
    return m(s);
  }
}

// ─────────────────────────── Log console ───────────────────────────
// Hosts a plugin-owned LogBuffer element while mounted; the element (with all
// its rows + scroll position) lives on the plugin and survives unmount.

class LogConsole extends Component {
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
    bare: t.boolean().optional(),
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
}

// ─────────────────────────── Search box ───────────────────────────

// Reusable search input with a clear (✕) button; `value` is a signal.
class SearchBox extends Component {
  static template = xml`
    <div class="search-box">
      <input type="text" t-att-value="this.props.value()" autocomplete="off" placeholder="Search…"
             t-on-input="ev => this.props.value.set(ev.target.value)"/>
      <button t-if="this.props.value()" class="search-clear" title="clear search" t-on-click="() => this.props.value.set('')">✕</button>
    </div>`;

  props = props({ value: t.any() });
}

// ─────────────────────────── Dirty badge + menu ──────────────────────────────

class DirtyBadge extends Component {
  static template = xml`
    <button class="dirty-badge" t-on-click.stop="(ev) => this.openMenu(ev)" title="uncommitted changes">dirty</button>`;

  props = props({ path: t.string(), repo: t.string() });
  openMenu(ev) {
    const rect = ev.currentTarget.getBoundingClientRect();
    appBus.dispatchEvent(
      new CustomEvent("dirty-menu", {
        detail: { rect, path: this.props.path, repo: this.props.repo },
      }),
    );
  }
}

class DirtyMenu extends Component {
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
}

// ─────────────────────────── Dashboard screen ───────────────────────────

// Per-target view of the code state: for each target, the git/runbot/PR state
// of every repo:branch in its config. Reuses CodePlugin's branch + PR data.
class DashboardScreen extends Component {
  static components = { DirtyBadge };
  static template = xml`
    <section>
      <div class="panel">
        <div class="panel-top">
          <h1>Dashboard</h1>
          <div class="panel-top-right">
            <span class="meta" t-out="this.stamp"/>
            <button class="pbtn" t-on-click="() => this._dashLoad(true)"><t t-out="this.refreshIcon"/>Refresh</button>
          </div>
        </div>
        <div class="panel-actions">
          <button class="dash-rebase" t-on-click="() => this.startCreate()">New target</button>
          <span class="dash-subtitle">Monitor repositories and switch between build targets.</span>
        </div>
      </div>
      <div class="content">
        <div t-att-class="{busy: this.code.busy()}">
          <div t-foreach="this.errors" t-as="e" t-key="e.id" class="dim" t-out="e.id + ': ' + e.error"/>

          <div class="dash-layout">
          <!-- repositories sync strip: the repo list collapses to one row of chips,
               each carrying its sync health (up to date / N behind) — the one thing
               the target cards never show. Per-repo actions live in the chip's menu. -->
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
  review = plugin(ReviewPlugin); // starred branch groups + their reviewed PRs
  worktree = plugin(WorktreePlugin); // "wt" badge on worktree targets
  router = plugin(RouterPlugin);
  refreshIcon = m(ICONS.refresh);
  addonsIcon = m(ICONS.addons); // "Repos" sync-strip label icon
  codeIcon = m(ICONS.code); // "Edit" (open all repos in the editor)
  kebabIcon = m(ICONS.kebab);
  chevronIcon = m(ICONS.chevron); // the repo chip's dropdown caret
  pushIcon = m(ICONS.push);
  terminalIcon = m(ICONS.terminal);
  historyIcon = m(ICONS.history);
  prIcon = m(ICONS.pr);
  menuId = signal(""); // id of the card whose kebab menu is open ("" = none)

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
      this.server,
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
      isActive: this.isActive(tgt),
    });
  }

  // the target's work branches that exist locally and have a canonical repo on
  // GitHub (base branches like master are never pushed to the dev fork)
  _pushableBranches(tgt) {
    const groups = this.code.groups();
    const repoMap = this.repoMap;
    return (tgt.config || [])
      .filter(
        ({ repo, branch }) => !BASE_BRANCH_RE.test(branch) && repoMap[repo]?.branches.has(branch),
      )
      .map(({ repo, branch }) => ({
        branch,
        path: groups.pathByRepo[repo],
        github: groups.githubByRepo[repo],
      }))
      .filter((x) => x.path && x.github);
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
      message: `Push ${n} branch${n === 1 ? "" : "es"} of "${tgt.name}" to the dev remote (odoo-dev)?`,
    });
  }

  menuRemoveFavorite(tgt) {
    this.menuId.set("");
    const targets = this.config.config.targets.map((t) =>
      t.id === tgt.id ? { ...t, favorite: false } : t,
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
      message: stopping
        ? `This permanently deletes the database and stops the server (it's running on "${tgt.db}"). This cannot be undone.`
        : "This permanently deletes the database. This cannot be undone.",
      okLabel: "Drop",
    });
    if (!res) return;
    const error = await this.db.dropStoppingServer(tgt.db);
    if (error)
      await this.dialogs.open({
        title: "Drop failed",
        message: error,
        okLabel: "OK",
        cancelLabel: null,
      });
  }

  setup() {
    this._dashLoad(false);
    this.db.load(); // the delete dialog needs the database list to offer "drop db"
    // reviewed PRs back the starred-PRs section (favorites are mostly review
    // targets); only fetch them when the user has actually starred something
    if (this.review.favorites().length) this.review.load();
    // close the kebab menu on any outside click
    const closeMenu = () => this.menuId() && this.menuId.set("");
    onMounted(() => document.addEventListener("click", closeMenu));
    onWillUnmount(() => document.removeEventListener("click", closeMenu));
    // fetch runbot + mergebot status only for what the target cards + starred PRs
    // actually show (loadMergebot dedups, so the two PR lists can overlap freely)
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
    const seen = new Set();
    for (const tgt of this.targets)
      for (const row of this.rows(tgt)) {
        if (!row.present) continue;
        if (this.code.isExternalRepo(row.github)) continue; // not on runbot — would 404
        if (!BASE_BRANCH_RE.test(row.branch) && !row.synced) continue;
        const ci = row.pr && row.pr.ci;
        if (ci && ci.checks && ci.checks.length) continue; // covered by the GitHub API
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
    const current = this.config.config.targets.find((t) => t.id === this.server.lastTarget());
    for (const c of current?.config || []) ids.add(c.repo);
    for (const tgt of this.targets) for (const c of tgt.config || []) ids.add(c.repo);
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
    const seen = new Set();
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
    const branches = (tgt.config || []).map((c) => c.branch).filter(Boolean);
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
    const subject = row.subject || "—";
    return row.date ? `${this.cell(row.date)} · ${subject}` : subject;
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
      let badge;
      if (ci.overall === "failure")
        badge = { cls: "fail", label: "ko", title: "a CI check failed" };
      else if (ci.overall === "success")
        badge = { cls: "pass", label: "ok", title: "all CI checks passing" };
      else if (ci.overall === "pending" || pending)
        badge = { cls: "run", label: "running", title: "CI running" };
      else badge = { cls: "unknown", label: "—", title: "no CI status" };
      // a definitive verdict while other checks are still pending → "still running"
      badge.running = pending && (ci.overall === "success" || ci.overall === "failure");
      badge.checks = ci.checks; // breakdown popover
      return badge;
    }
    // fallback: scraped runbot bundle status (branch has no PR)
    const s = this.rbState(row);
    const result = (s && s.result) || "";
    const running = !!(s && s.running);
    let badge;
    if (result === "success") badge = { cls: "pass", label: "ok", title: "passing" };
    else if (result === "failure") badge = { cls: "fail", label: "ko", title: "failing" };
    else if (running) badge = { cls: "run", label: "running", title: "running" };
    else badge = { cls: "unknown", label: "—", title: "unknown" };
    // a concrete pass/fail that's still running gets the extra running indicator
    badge.running = running && !!result;
    if (badge.running) badge.title += " — still running";
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
        url: this.code.mergebotUrl(row.github, row.pr.number),
      });
    }
    if (!rows.length) return null;
    const RANK = { blocked: 0, progress: 1, ready: 2, merged: 3, other: 4 };
    const worst = rows.reduce((a, b) => (RANK[a.cls] <= RANK[b.cls] ? a : b));
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
    if (this.code.loading()) return "refreshing…";
    return this.code.at() ? `updated ${timeAgo(new Date(this.code.at()).toISOString())}` : "";
  }

  get errors() {
    return this.code.groups().errors;
  }

  // repositories shown in the dashboard summary: union of the active target's
  // repos and the favorite repositories, in config order
  get favRepos() {
    const byId = Object.fromEntries(this.code.branchRepos().map((r) => [r.id, r]));
    const groups = this.code.groups();
    const currentTarget = this.config.config.targets.find((t) => t.id === this.server.lastTarget());
    const visibleIds = new Set([
      ...(currentTarget?.config || []).map((c) => c.repo),
      ...this.config.config.repos.filter((r) => r.favorite).map((r) => r.id),
    ]);
    return this.config.config.repos
      .filter((r) => visibleIds.has(r.id))
      .map((r) => {
        const b = byId[r.id] || {};
        const current = b.current || "";
        const github = groups.githubByRepo[r.id] || "";
        const pr = groups.prIndex[`${r.id}:${current}`] || null;
        return {
          id: r.id,
          current,
          dirty: !!b.dirty,
          subject: b.head_subject || "",
          remote: !!b.head_remote, // the current branch has a remote-tracking ref
          date: b.head_date || "",
          ahead: b.ahead || 0, // commits ahead of the base (target) branch
          behind: b.behind || 0, // commits behind the base (target) branch
          base: this._baseBranch(current),
          error: b.error || "",
          github,
          path: groups.pathByRepo[r.id] || "",
          pr,
          // a work branch that's pushed and PR-less can have a PR opened for it
          canPr: !!(current && b.head_remote && github && !pr && !BASE_BRANCH_RE.test(current)),
        };
      });
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
    if (!r.current) return "—";
    return r.behind ? `${r.behind} behind` : "up to date";
  }

  syncTitle(r) {
    if (r.error) return r.error;
    if (!r.current) return "branch state not loaded yet";
    if (r.behind) {
      const ahead = r.ahead ? ` · ${r.ahead} ahead` : "";
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
    if (r.dirty) return "commit or stash changes first — the working tree is dirty";
    if (!r.github || !r.path) return "no canonical repo configured for this repository";
    return `fetch and rebase ${r.current} onto ${r.github}@${this._baseBranch(r.current)}`;
  }

  async rebaseRepo(r) {
    if (!this.canRebaseRepo(r)) return;
    await this.code.rebase([
      { repo: r.id, base: this._baseBranch(r.current), github: r.github, path: r.path },
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
      message: `Push ${r.current} (${r.id}) to the dev remote (odoo-dev)?`,
    });
  }

  pushForceRepo(r) {
    if (!this.canPushRepo(r)) return;
    return pushBranchesDialog(this.code, this.dialogs, [{ path: r.path, branch: r.current }], {
      title: `Force-push "${r.current}"?`,
      message: `Force-push ${r.current} (${r.id}) to the dev remote (odoo-dev) with --force-with-lease? This overwrites the remote branch.`,
      force: true,
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
      return "nothing to rebase — repositories are dirty, missing, or have no canonical remote";
    return `fetch and rebase ${n} branch${n === 1 ? "" : "es"} onto their base`;
  }

  // fetch + rebase every shown repo's current branch onto its base, in one call
  async rebaseAll() {
    const repos = this.rebasableRepos.map((r) => ({
      repo: r.id,
      base: this._baseBranch(r.current),
      github: r.github,
      path: r.path,
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

  // favorite targets only, in the order defined in the Targets tab
  get targets() {
    return this.config.config.targets.filter((t) => t.favorite);
  }

  // repoId -> { current, dirty, branches: Map(name -> branch) }
  get repoMap() {
    const map = {};
    for (const repo of this.code.branchRepos()) {
      map[repo.id] = {
        current: repo.current,
        dirty: repo.dirty,
        branches: new Map((repo.branches || []).map((b) => [b.name, b])),
      };
    }
    return map;
  }

  // one row per repo:branch in the target's config, with its local + remote state
  rows(tgt) {
    const repos = this.repoMap;
    const groups = this.code.groups();
    return (tgt.config || []).map(({ repo, branch }) => {
      const r = repos[repo];
      const b = r && r.branches.get(branch);
      return {
        repo,
        branch,
        path: groups.pathByRepo[repo] || "",
        github: groups.githubByRepo[repo] || "",
        present: !!b,
        remote: !!b && b.remote,
        synced: !!b && b.synced, // local tip is exactly what's on the remote ref
        date: b ? b.date : "",
        subject: b ? b.subject || "" : "",
        pr: groups.prIndex[`${repo}:${branch}`] || null,
      };
    });
  }

  // every repo in the target's config is checked out on the target's branch
  _checkedOut(tgt) {
    const repos = this.repoMap;
    const cfg = tgt.config || [];
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
    return (tgt.config || []).some(({ repo }) => repos[repo]?.dirty);
  }

  _targetPresent(tgt) {
    const repos = this.repoMap;
    return (tgt.config || []).every(({ repo, branch }) => repos[repo]?.branches.has(branch));
  }

  canActivate(tgt) {
    // a worktree target lives in its own checkout — its branch is checked out in the
    // worktree (git won't let the main tree check it out too), so it's never applied
    // here; it's started from the Worktrees screen instead
    if (this.worktree.isWorktree(tgt)) return false;
    return !this.isActive(tgt) && this._targetPresent(tgt) && !this._targetDirty(tgt);
  }

  activateTitle(tgt) {
    if (this._targetDirty(tgt)) return "commit or stash changes first — the working tree is dirty";
    if (!this._targetPresent(tgt)) return "some of this target's branches are missing locally";
    return "stop the server, switch to this target and check out its branches";
  }

  // tooltip for the clickable target name — clicking an inactive, applyable target
  // applies it (replaces the old "Apply" button); otherwise say why it can't be
  nameTitle(tgt) {
    if (this.worktree.isWorktree(tgt))
      return "worktree target — manage it from the Worktrees screen";
    if (this.isActive(tgt)) return "this target is active";
    if (this.canActivate(tgt)) return "click to apply — " + this.activateTitle(tgt);
    return this.activateTitle(tgt);
  }

  // stop the server, switch to this target, check out its branches
  async activate(tgt) {
    if (!this.canActivate(tgt)) return;
    const pathByRepo = this.code.groups().pathByRepo;
    const repos = (tgt.config || [])
      .map(({ repo, branch }) => ({ repo, path: pathByRepo[repo], branch }))
      .filter((r) => r.path);
    // repos that will actually switch (skip the ones already on the target branch)
    const switched = repos.filter((r) => this.repoMap[r.repo]?.current !== r.branch);
    this.eventLog.add(`activating target ${tgt.name}`);
    for (const r of switched) this.eventLog.add(`checking out ${r.branch} (${r.repo})`);
    // stop the server and switch branches concurrently: the checkout only swaps
    // working-tree files, which the running Odoo (already-loaded code in memory)
    // doesn't care about, so the two are independent
    const s = this.server.status().state;
    const stopping = s === "running" || s === "starting" ? this.server.stop() : null;
    await Promise.all([stopping, this.code.checkout(repos)]);
    this.server.setLastTarget(tgt.id);
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
      label: `${r.id} · ${r.current || "?"}`,
      github: r.github || "",
    });
  }

  // show the last commits for a target row's repo:branch (the commit title in a card)
  openRowCommits(row) {
    if (!row.path) return;
    this.dialogs.openComponent(CommitsDialog, {
      path: row.path,
      ref: row.branch || "",
      label: `${row.repo} · ${row.branch || "?"}`,
      github: row.github || "",
    });
  }

  // open GitHub's PR-creation page for this repo's current branch
  openPr(r) {
    this.eventLog.add(`opening PR for ${r.current} (${r.id})`);
    window.open(this.code.prCreateUrl(r.github, r.current), "_blank");
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
      (this.config.config.repos || []).filter((r) => r.github).map((r) => [r.github, r.id]),
    );
  }

  starredGroups() {
    const favs = new Set(this.review.favorites());
    if (!favs.size) return [];
    const slugToId = this._slugToId;
    const seen = new Set();
    const byBranch = new Map();
    const add = (pr) => {
      if (!pr.branch || !favs.has(pr.branch)) return;
      const key = `${pr.github}#${pr.number}`;
      if (seen.has(key)) return;
      seen.add(key);
      (byBranch.get(pr.branch) || byBranch.set(pr.branch, []).get(pr.branch)).push(pr);
    };
    // authored (Mine) — on the dashboard code PRs are narrowed to target/favorite
    // repos, but a starred branch you authored almost always lives in one of those
    for (const repo of this.code.prRepos()) {
      if (repo.error) continue;
      for (const pr of repo.prs)
        add({
          number: pr.number,
          title: pr.title || "",
          url: pr.url,
          github: repo.github,
          repoLabel: repo.id,
          branch: pr.headRefName,
          state: (pr.state || "").toLowerCase(),
          draft: !!pr.isDraft,
          createdAt: pr.createdAt, // your own PRs show created, not updatedAt
          updatedAt: pr.updatedAt,
        });
    }
    // reviewed (Reviewing) — fetched unnarrowed, so this covers review targets
    for (const pr of this.review.prs())
      add({
        number: pr.number,
        title: pr.title || "",
        url: pr.url,
        github: pr.repo,
        repoLabel: slugToId[pr.repo] || pr.repo,
        branch: pr.branch,
        state: pr.state,
        draft: !!pr.draft,
        updatedAt: pr.updatedAt,
      });
    const ts = (r) => Date.parse(this.prDate(r)) || 0; // sort by the date shown
    const repoOrder = (this.config.config.repos || []).map((r) => r.github);
    const rank = (r) => {
      const i = repoOrder.indexOf(r.github);
      return i === -1 ? repoOrder.length : i; // unknown repos sort last
    };
    return [...byBranch.entries()]
      .map(([branch, prs]) => ({
        branch,
        prs: prs
          .slice()
          .sort((a, b) => rank(a) - rank(b) || a.github.localeCompare(b.github) || ts(b) - ts(a)),
        updated: Math.max(...prs.map(ts)),
      }))
      .sort((a, b) => b.updated - a.updated);
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
    return this.starredPrs()
      .filter((pr) => pr.state === "open" && !this.code.isExternalRepo(pr.github))
      .map((pr) => ({ github: pr.github, number: pr.number }));
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
}

// ─────────────────────────── Server screen ───────────────────────────

class ServerScreen extends Component {
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
    // keep the command preview in sync with target / extra args (debounced)
    useEffect(() => {
      const tgt = this.target();
      const args = this.extraArgs();
      clearTimeout(timer);
      timer = setTimeout(
        () => this.server.previewCommand(tgt, args).then((c) => this.command.set(c)),
        200,
      );
    });
  }

  get targets() {
    return this.config.config.targets;
  }

  // last used target id if it still exists, else the first one
  _initialTarget() {
    const ids = this.targets.map((t) => t.id);
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
    return this.server.pending() === "start" || this.status().state === "starting"
      ? "Starting…"
      : "Start";
  }

  get disconnected() {
    return this.status().state === "disconnected";
  }

  get transient() {
    const s = this.status().state;
    return s === "starting" ? "starting…" : s === "stopping" ? "stopping…" : null;
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
    return this.active || (this.stopped && this.status().odoo_port_busy);
  }

  get cmdPreviewMarkup() {
    return m(tintCmd(this.command() || ""));
  }

  get info() {
    const s = this.status();
    if (s.db) {
      // running — live status (db, odoo version); target is shown in the navbar
      let html = `database: <b>${s.db}</b>`;
      if (s.odoo_version) {
        html += `<span class="sep">·</span>odoo: <b>${s.odoo_version}</b>`;
        if (s.enterprise) html += ` (enterprise)`;
      }
      return m(html);
    }
    // stopped — the selected target's database (the would-be launch)
    const tgt = this.targets.find((t) => t.id === this.target());
    return tgt && tgt.db ? m(`database: <b>${tgt.db}</b>`) : null;
  }

  get hint() {
    const s = this.status();
    const hints = [];
    if (s.exited_unexpectedly) hints.push(`odoo exited unexpectedly (code ${s.returncode})`);
    if (s.state === "stopped" && s.odoo_port_busy)
      hints.push("port 8069 is busy (external odoo?) — Stop will kill it");
    return hints.join(" — ") || null;
  }

  get uptime() {
    const s = this.status();
    if ((s.state !== "starting" && s.state !== "running") || !s.started_at) return null;
    const secs = Math.max(0, Math.floor(this.server.now() / 1000 - s.started_at));
    const h = Math.floor(secs / 3600),
      mn = Math.floor((secs % 3600) / 60),
      sec = secs % 60;
    return h ? `${h}h ${mn}m` : mn ? `${mn}m ${sec}s` : `${sec}s`;
  }

  copy() {
    if (!this.command()) return;
    navigator.clipboard?.writeText(this.command());
    this.copyLbl.set("Copied");
    setTimeout(() => this.copyLbl.set("Copy"), 1400);
  }
}

// ─────────────────────────── Claude chat (worktree) ───────────────────────────

// The chat pane inside a worktree's detail: a running conversation with a headless
// Claude launched in that worktree's checkout. Type a task, hit Send; assistant text
// and tool activity stream in as bubbles. State lives in ClaudePlugin (keyed by
// target), so it survives pane/tab switches; the transcript re-primes on mount.
class ClaudeChat extends Component {
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
    // follow the tail as items stream in (reads items() so the effect re-runs on change)
    useEffect(
      () => {
        const el = this.scroll();
        if (el) el.scrollTop = el.scrollHeight;
      },
      () => [this.items.length, this.running],
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
}

// ─────────────────────────── Worktrees screen ───────────────────────────

// A worktree is a first-class target backed by a git worktree checkout, running
// its own odoo server. Left: the list of worktree targets; right: the selected
// one's detail — start/stop/restart, /odoo + /web/tests, its live server log, and a
// Claude chat that runs tasks in the worktree.
class WorktreeScreen extends Component {
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
  codeIcon = m(ICONS.code); // "Edit" (open the worktree's repos in the editor)
  pane = signal("log"); // which detail pane is shown: "log" | "claude"

  setup() {
    this.db.load(); // cache-aware; warms the clone-source list for the create dialog
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
    return this.sel && this.wt.serverState(this.sel) === "starting" ? "Starting…" : "Start";
  }

  branchOf(tgt) {
    return (tgt.config && tgt.config[0] && tgt.config[0].branch) || "";
  }

  dotClass(tgt) {
    return "wt-dot-" + this.wt.serverState(tgt);
  }

  open(url) {
    if (url) window.open(url, "_blank", "noopener");
  }

  async create() {
    const bases = (this.config.config.targets || []).filter((t) => !this.wt.isWorktree(t));
    if (!bases.length)
      return this.dialogs.open({
        title: "Create worktree",
        message: "Define a normal target first — a worktree forks its branch from one.",
        cls: "dialog-error",
        okLabel: "OK",
        cancelLabel: null,
      });
    await this.db.load(); // ensure the db list is present for the clone option
    const sanitize = (s) =>
      (s || "")
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");
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
          placeholder: "— pick a target —",
          options: bases.map((t) => ({ value: t.id, label: t.name })),
        },
        {
          key: "branch",
          type: "text",
          label: "New branch",
          placeholder: "e.g. my-feature",
          onChange: (v) => ({ db: sanitize(v) }),
        },
        { key: "name", type: "text", label: "Display name (optional)" },
        { key: "db", type: "text", label: "Database" },
        {
          key: "clone",
          type: "select",
          label: "Data",
          value: "",
          placeholder: "(fresh install)",
          options: dbNames.map((n) => ({ value: n, label: "clone " + n })),
        },
      ],
      validate: (v) => {
        if (!v.base) return "pick a base target";
        if (!sanitize(v.branch)) return "enter a branch name";
        if (!sanitize(v.db)) return "enter a database name";
        if (v.clone && dbNames.includes(sanitize(v.db)))
          return `database "${sanitize(v.db)}" already exists — pick a new name to clone into`;
        return "";
      },
    });
    if (!res) return;
    await this.wt.createWorktree({
      baseTargetId: res.base,
      name: (res.name || res.branch).trim(),
      branch: sanitize(res.branch),
      dbName: sanitize(res.db),
      cloneSource: res.clone || "",
    });
  }
}

// ─────────────────────────── Databases screen ───────────────────────────

class DatabasesScreen extends Component {
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
                <tr><th><input type="checkbox" class="br-select" t-att-checked="this.allSelected" t-on-change="() => this.toggleSelectAll()" title="select all databases"/></th><th>Name</th><th>Odoo version</th><th>Size</th><th>Created</th><th>Last activity</th><th/></tr>
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
  selected = signal(new Set()); // database names ticked for batch actions
  // sorted, view-ready rows — recomputed only when the db list / active db change
  rows = computed(() => {
    const activeDb = this.db.activeDb;
    return [...this.db.databases()]
      .sort((a, b) => (Date.parse(b.last_update) || 0) - (Date.parse(a.last_update) || 0))
      .map((d) => ({
        name: d.name,
        active: d.name === activeDb,
        version: d.odoo_version,
        enterprise: d.enterprise,
        created: d.created,
        createdAgo: d.created && timeAgo(d.created),
        createdTitle: d.created ? `${d.created} (UTC)` : "",
        last: d.last_update,
        lastAgo: d.last_update && timeAgo(d.last_update),
        lastTitle: d.last_update ? `${d.last_update} (UTC)` : "",
        size: formatBytes(d.size),
      }));
  });

  setup() {
    this.db.load();
  }

  get stamp() {
    if (this.db.loading()) return "refreshing…";
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
        onClick: () => this.cloneDb(d),
      },
      {
        label: "Rename",
        disabled: d.active,
        title: busyTitle,
        onClick: () => this.renameDb(d),
      },
      {
        label: "Drop",
        danger: true,
        disabled: d.active,
        title: d.active ? "in use by the running server" : "",
        onClick: () => this.dropDb(d),
      },
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
      this.allSelected ? new Set() : new Set(this._selectableDbs.map((d) => d.name)),
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
      okLabel: "Drop",
    });
    if (!res) return;
    for (const d of dbs) await this.db.drop(d.name);
    this.selected.set(new Set());
  }

  // confirm via the dialog, then drop; report any failure in a dialog too
  async dropDb(d) {
    const res = await this.dialogs.open({
      title: `Drop "${d.name}"?`,
      message: "This permanently deletes the database. This cannot be undone.",
      okLabel: "Drop",
    });
    if (!res) return;
    const error = await this.db.drop(d.name);
    if (error)
      await this.dialogs.open({
        title: "Drop failed",
        message: error,
        okLabel: "OK",
        cancelLabel: null,
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
      message: d.active
        ? "This database is in use by the running server. goo will stop the server to clone it, then restart it."
        : "",
      fields: [
        {
          key: "target",
          type: "text",
          label: "New database name",
          value: `${d.name}-copy`,
          placeholder: "new database name",
        },
      ],
      okLabel: "Clone",
      validate: (v) => this._badName((v.target || "").trim()),
    });
    if (!res) return;
    // cloneStoppingServer frees the source by stopping the server when it's the
    // active db (the clone needs exclusive access), then resumes it
    const error = await this.db.cloneStoppingServer(d.name, res.target.trim());
    if (error)
      await this.dialogs.open({
        title: "Clone failed",
        message: error,
        okLabel: "OK",
        cancelLabel: null,
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
          placeholder: "new database name",
        },
      ],
      okLabel: "Rename",
      validate: (v) => {
        const t = (v.name || "").trim();
        if (t === d.name) return "choose a different name";
        return this._badName(t);
      },
    });
    if (!res) return;
    const error = await this.db.rename(d.name, res.name.trim());
    if (error)
      await this.dialogs.open({
        title: "Rename failed",
        message: error,
        okLabel: "OK",
        cancelLabel: null,
      });
  }
}

// ─────────────────────────── Targets screen ───────────────────────────

// First-class targets: name, favorite flag, config (repo:branch pairs), db and
// start args. Rows are edited inline; "New target" opens a dialog form.

// After remote branches have been fetched locally, open a prefilled
// target-creation dialog (no "Create branches" step — they already exist).
async function createTargetFromRemoteBranch(config, eventLog, dialogs, branch, repos) {
  const existingTargets = config.config.targets;
  const configStr = repos.map((r) => `${r}:${branch}`).join(",");
  const res = await dialogs.open({
    title: "New target from remote branch",
    okLabel: "Create",
    validate: (v) => {
      const name = (v.name || "").trim();
      if (!name) return "a name is required";
      if (existingTargets.some((t) => t.name === name))
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
        placeholder: "community:branch,enterprise:branch",
      },
      { key: "db", type: "text", label: "Database", value: branch, placeholder: "database name" },
      { key: "args", type: "text", label: "Start args", placeholder: "-i sale_management" },
      { key: "fav", type: "checkbox", label: "Favorite", value: false },
    ],
  });
  if (!res) return;
  const target = {
    id: newTargetId(),
    name: res.name.trim(),
    favorite: !!res.fav,
    config: repoBranchList.parse(res.config.trim()),
    db: (res.db || "").trim(),
    on_create_args: (res.args || "").trim(),
  };
  eventLog.add(`creating target ${target.name} from remote branch ${branch}`);
  config.updateConfig({ targets: [...config.config.targets, target] });
}

// Switch the working tree to a target's branches and make it the active target:
// stop the server if it's up and checkout concurrently (the checkout only swaps
// working-tree files, which the already-loaded Odoo doesn't care about), then
// record it as the last-used target. Used by the create dialog's "activate it".
async function activateTarget(server, code, eventLog, target) {
  const pathByRepo = code.groups().pathByRepo;
  const repos = (target.config || [])
    .map(({ repo, branch }) => ({ repo, path: pathByRepo[repo], branch }))
    .filter((r) => r.path);
  eventLog.add(`activating target ${target.name}`);
  const s = server.status().state;
  const stopping = s === "running" || s === "starting" ? server.stop() : null;
  await Promise.all([stopping, code.checkout(repos)]);
  server.setLastTarget(target.id);
}

async function startCreateTarget(config, eventLog, code, dialogs, db, server) {
  const existingTargets = config.config.targets;
  await db.load(); // populate the "Clone db" select with the existing databases
  const dbNames = new Set(db.databases().map((d) => d.name));
  const dbOptions = db.databases().map((d) => ({ value: d.name, label: d.name }));
  const res = await dialogs.open({
    title: "New target",
    okLabel: "Create",
    validate: (v) => {
      const name = (v.name || "").trim();
      if (!name) return "a name is required";
      if (existingTargets.some((t) => t.name === name))
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
        placeholder: "— start blank —",
        options: existingTargets.map((t) => ({ value: t.id, label: t.name })),
        value: "",
        onChange: (tplId) => {
          if (!tplId) return null;
          const tpl = existingTargets.find((t) => t.id === tplId);
          if (!tpl) return null;
          const branchName =
            tpl.config.find((c) => c.repo === "enterprise")?.branch ||
            tpl.config.find((c) => c.repo === "community")?.branch ||
            "";
          return {
            name: branchName,
            config: repoBranchList.format(tpl.config),
            db: tpl.db || "",
            args: tpl.on_create_args || "",
            fav: !!tpl.favorite,
          };
        },
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
            db: (currentValues.db || "").replaceAll(oldName, newName),
          };
        },
      },
      {
        key: "config",
        type: "text",
        label: "Config",
        placeholder: "community:master,enterprise:master",
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
          const tpl = existingTargets.find((t) => t.id === v.template);
          if (tpl?.db && dbNames.has(tpl.db)) return tpl.db;
          return dbOptions[0]?.value || "";
        },
      },
      { key: "fav", type: "checkbox", label: "Favorite", value: false },
      { key: "createBranches", type: "checkbox", label: "Create branches", value: true },
      { key: "activate", type: "checkbox", label: "Activate it", value: true },
    ],
  });
  if (!res) return;
  const target = {
    id: newTargetId(),
    name: res.name.trim(),
    favorite: !!res.fav,
    config: repoBranchList.parse(res.config.trim()),
    db: (res.db || "").trim(),
    on_create_args: (res.args || "").trim(),
  };
  eventLog.add(`creating target ${target.name}`);
  config.updateConfig({ targets: [...config.config.targets, target] });
  if (res.createBranches && code) {
    const tpl = existingTargets.find((t) => t.id === res.template);
    const baseBranchByRepo = Object.fromEntries((tpl?.config || []).map((c) => [c.repo, c.branch]));
    const pathByRepo = Object.fromEntries(config.config.repos.map((r) => [r.id, r.path]));
    await code.createBranches(
      target.config.map((c) => ({
        path: pathByRepo[c.repo],
        name: c.branch,
        startPoint: baseBranchByRepo[c.repo],
      })),
    );
  }
  // apply the target right away (checkout its branches + make it current). Done
  // before the db clone so a clone of the active db sees the server already
  // stopped (no needless stop/resume cycle).
  if (res.activate && server) {
    await activateTarget(server, code, eventLog, target);
  }
  // clone the chosen source database into the target's database name (skip when it
  // would clone onto itself — the destination already exists in that case). When the
  // source is the active db, the server is stopped for the clone and resumed after.
  if (res.cloneDb && target.db && res.cloneDb !== target.db) {
    await db.cloneStoppingServer(res.cloneDb, target.db);
  }
}

// confirm (via the app modal) then push one or more branches to the dev remote.
// branches: [{ path, branch }]. Shared by every "Push" affordance.
async function pushBranchesDialog(code, dialogs, branches, { title, message, force = false }) {
  if (!branches.length) return;
  const ok = await dialogs.open({ title, message, okLabel: force ? "Force push" : "Push" });
  if (!ok) return;
  for (const b of branches) await code.pushBranchNoConfirm(b.path, b.branch, true, force);
}

// delete a target via a confirmation dialog that can also (optionally) delete
// its local/remote branches (non-base ones that exist), close its open PRs and
// drop its database. Shared by the Targets tab and the dashboard card menu.
async function deleteTargetDialog(tgt, { config, code, db, eventLog, repoMap, isActive, dialogs }) {
  if (isActive) return; // the active target cannot be deleted
  const groups = code.groups();
  // deletable branches: present locally and not a base/primary branch
  const branches = (tgt.config || [])
    .map(({ repo, branch }) => ({ repo, branch, b: repoMap[repo]?.branches.get(branch) }))
    .filter((x) => x.b && !BASE_BRANCH_RE.test(x.branch))
    .map((x) => ({
      repo: x.repo,
      branch: x.branch,
      path: groups.pathByRepo[x.repo],
      remote: !!x.b.remote,
    }));
  // open PRs for the target's branches
  const prs = (tgt.config || [])
    .map(({ repo, branch }) => ({
      pr: groups.prIndex[`${repo}:${branch}`],
      github: groups.githubByRepo[repo],
    }))
    .filter((x) => x.pr && x.pr.state === "OPEN" && x.github)
    .map((x) => ({ github: x.github, number: x.pr.number }));

  const fields = [];
  if (branches.length)
    fields.push({
      key: "delBranches",
      type: "checkbox",
      label: `Also delete ${branches.length === 1 ? "its branch" : `its ${branches.length} branches`}`,
      value: true,
    });
  if (branches.some((b) => b.remote))
    fields.push({
      key: "delRemote",
      type: "checkbox",
      label: "…also on the remote (odoo-dev)",
      value: true,
    });
  if (prs.length)
    fields.push({
      key: "closePrs",
      type: "checkbox",
      label: `Close ${prs.length === 1 ? "its open pull request" : `its ${prs.length} open pull requests`}`,
      value: true,
    });
  // only offer to drop the db if it actually exists (a never-run target has none)
  const dbExists = tgt.db && db.databases().some((d) => d.name === tgt.db);
  if (dbExists)
    fields.push({
      key: "dropDb",
      type: "checkbox",
      label: `Drop database "${tgt.db}"`,
      value: true,
    });

  const res = await dialogs.open({
    title: `Delete "${tgt.name}"?`,
    message: "The target will be removed from your list. This cannot be undone.",
    okLabel: "Delete",
    fields,
  });
  if (!res) return;

  eventLog.add(`deleting target ${tgt.name}`);
  // these are independent network/git ops (close PRs, delete branches per repo,
  // drop the db) — fire them concurrently rather than one slow await after another.
  // Each helper handles its own errors and never rejects, so Promise.all is safe.
  const ops = [];
  if (res.closePrs) for (const p of prs) ops.push(code.closePrNoConfirm(p.github, p.number));
  if (res.delBranches)
    for (const b of branches)
      ops.push(code.deleteBranchNoConfirm(b.branch, b.repo, b.path, !!res.delRemote && b.remote));
  if (res.dropDb && tgt.db) ops.push(db.drop(tgt.db));
  await Promise.all(ops);
  config.updateConfig({ targets: config.config.targets.filter((t) => t.id !== tgt.id) });
}

class TargetsScreen extends Component {
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
                <tr><th><input type="checkbox" class="br-select" t-att-checked="this.allSelected" t-on-change="() => this.toggleSelectAll()" title="select all targets"/></th><th>Name</th><th/><th>Config</th><th>Database</th><th>Start args</th><th/></tr>
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
  editId = signal(""); // id of the row being edited inline ("" = none)
  draftName = signal("");
  draftConfig = signal("");
  draftDb = signal("");
  draftArgs = signal("");
  error = signal(""); // inline-edit validation error
  selected = signal(new Set()); // target ids ticked for batch actions
  dragId = signal(""); // id of the target currently being dragged ("" = none)
  dragOverId = signal(""); // id of the row the drag is hovering over

  // This screen does no git/network on mount — the table is just config, and the
  // active-row highlight is browser-side (see isActive). Branch / PR / db state is
  // pulled lazily, scoped to the repos of the target(s) involved, when a kebab or
  // batch action actually needs it (see openRowMenu, _loadForDelete).

  // the deduped set of repo ids used by the given targets — to scope the lazy reads
  _repoIdsFor(targets) {
    const ids = new Set();
    for (const t of targets) for (const c of t.config || []) ids.add(c.repo);
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
        branches: new Map((repo.branches || []).map((b) => [b.name, b])),
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
    const id =
      s.state === "running" || s.state === "starting" ? s.target : this.server.lastTarget();
    return tgt.id === id;
  }

  _targetDirty(tgt) {
    const repos = this.repoMap;
    return (tgt.config || []).some(({ repo }) => repos[repo]?.dirty);
  }

  _targetPresent(tgt) {
    const repos = this.repoMap;
    return (tgt.config || []).every(({ repo, branch }) => repos[repo]?.branches.has(branch));
  }

  canActivate(tgt) {
    return !this.isActive(tgt) && this._targetPresent(tgt) && !this._targetDirty(tgt);
  }

  activateTitle(tgt) {
    if (this.isActive(tgt)) return "this target is already active";
    if (this._targetDirty(tgt)) return "commit or stash changes first — the working tree is dirty";
    if (!this._targetPresent(tgt)) return "some of this target's branches are missing locally";
    return "stop the server, switch to this target and check out its branches";
  }

  // stop the server, switch to this target, check out its branches
  async activate(tgt) {
    if (!this.canActivate(tgt)) return;
    const pathByRepo = this.code.groups().pathByRepo;
    const repos = (tgt.config || [])
      .map(({ repo, branch }) => ({ repo, path: pathByRepo[repo], branch }))
      .filter((r) => r.path);
    // repos that will actually switch (skip the ones already on the target branch)
    const switched = repos.filter((r) => this.repoMap[r.repo]?.current !== r.branch);
    this.eventLog.add(`activating target ${tgt.name}`);
    for (const r of switched) this.eventLog.add(`checking out ${r.branch} (${r.repo})`);
    // stop the server and switch branches concurrently: the checkout only swaps
    // working-tree files, which the running Odoo (already-loaded code in memory)
    // doesn't care about, so the two are independent
    const s = this.server.status().state;
    const stopping = s === "running" || s === "starting" ? this.server.stop() : null;
    await Promise.all([stopping, this.code.checkout(repos)]);
    this.server.setLastTarget(tgt.id);
  }

  // the configured order — reorderable by dragging a row's name
  get targets() {
    return this.config.config.targets;
  }

  onDragStart(ev, tgt) {
    this.dragId.set(tgt.id);
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", tgt.id); // some browsers need data to start a drag
  }

  onDragOver(ev, tgt) {
    if (!this.dragId()) return; // ignore drags that didn't start on a name handle
    ev.preventDefault(); // mark this row as a valid drop target
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
    const from = targets.findIndex((t) => t.id === fromId);
    if (from < 0) return;
    const [moved] = targets.splice(from, 1);
    const to = targets.findIndex((t) => t.id === toId);
    if (to < 0) return;
    targets.splice(to, 0, moved);
    this.config.updateConfig({ targets });
  }

  get count() {
    const n = this.targets.length;
    return `${n} target${n === 1 ? "" : "s"}`;
  }

  fmtConfig(tgt) {
    return (tgt.config || []).map((c) => `${c.repo}:${c.branch}`).join(", ");
  }

  toggleFavorite(id) {
    const targets = this.config.config.targets.map((t) =>
      t.id === id ? { ...t, favorite: !t.favorite } : t,
    );
    this.config.updateConfig({ targets });
  }

  toggleSelect(id) {
    const sel = new Set(this.selected());
    sel.has(id) ? sel.delete(id) : sel.add(id);
    this.selected.set(sel);
  }

  get _selectableTargets() {
    return this.targets.filter((t) => !this.isActive(t));
  }

  get allSelected() {
    const sel = this.selected();
    const selectable = this._selectableTargets;
    return selectable.length > 0 && selectable.every((t) => sel.has(t.id));
  }

  toggleSelectAll() {
    this.selected.set(
      this.allSelected ? new Set() : new Set(this._selectableTargets.map((t) => t.id)),
    );
  }

  get _selectedTargets() {
    const sel = this.selected();
    return this.targets.filter((t) => sel.has(t.id) && !this.isActive(t));
  }

  get selectedCount() {
    return this._selectedTargets.length;
  }

  async deleteSelected() {
    const targets = this._selectedTargets;
    if (!targets.length) return;
    await this._loadForDelete(targets); // branches + PRs + db for the cleanup options
    const repos = this.repoMap;
    const groups = this.code.groups();

    // aggregate deletable branches across all selected targets
    const allBranches = targets.flatMap((tgt) =>
      (tgt.config || [])
        .map(({ repo, branch }) => ({ repo, branch, b: repos[repo]?.branches.get(branch) }))
        .filter((x) => x.b && !BASE_BRANCH_RE.test(x.branch))
        .map((x) => ({
          repo: x.repo,
          branch: x.branch,
          path: groups.pathByRepo[x.repo],
          remote: !!x.b.remote,
        })),
    );

    // aggregate open PRs across all selected targets
    const allPrs = targets.flatMap((tgt) =>
      (tgt.config || [])
        .map(({ repo, branch }) => ({
          pr: groups.prIndex[`${repo}:${branch}`],
          github: groups.githubByRepo[repo],
        }))
        .filter((x) => x.pr && x.pr.state === "OPEN" && x.github)
        .map((x) => ({ github: x.github, number: x.pr.number })),
    );

    // aggregate existing databases across all selected targets
    const existingDbs = this.db.databases().map((d) => d.name);
    const allDbs = [
      ...new Set(targets.map((t) => t.db).filter((db) => db && existingDbs.includes(db))),
    ];

    const n = targets.length;
    const fields = [];
    if (allBranches.length)
      fields.push({
        key: "delBranches",
        type: "checkbox",
        label: `Also delete ${allBranches.length === 1 ? "their branch" : `their ${allBranches.length} branches`}`,
        value: true,
      });
    if (allBranches.some((b) => b.remote))
      fields.push({
        key: "delRemote",
        type: "checkbox",
        label: "…also on the remote (odoo-dev)",
        value: true,
      });
    if (allPrs.length)
      fields.push({
        key: "closePrs",
        type: "checkbox",
        label: `Close ${allPrs.length === 1 ? "their open pull request" : `their ${allPrs.length} open pull requests`}`,
        value: true,
      });
    if (allDbs.length)
      fields.push({
        key: "dropDbs",
        type: "checkbox",
        label: `Drop ${allDbs.length === 1 ? `database "${allDbs[0]}"` : `their ${allDbs.length} databases`}`,
        value: true,
      });

    const res = await this.dialogs.open({
      title: `Delete ${n} target${n === 1 ? "" : "s"}?`,
      message: "The targets will be removed from your list. This cannot be undone.",
      okLabel: "Delete",
      fields,
    });
    if (!res) return;

    for (const t of targets) this.eventLog.add(`deleting target ${t.name}`);
    // independent ops across all selected targets — run them concurrently (each
    // helper swallows its own errors, so Promise.all never rejects here)
    const ops = [];
    if (res.closePrs)
      for (const p of allPrs) ops.push(this.code.closePrNoConfirm(p.github, p.number));
    if (res.delBranches)
      for (const b of allBranches)
        ops.push(
          this.code.deleteBranchNoConfirm(b.branch, b.repo, b.path, !!res.delRemote && b.remote),
        );
    if (res.dropDbs) for (const db of allDbs) ops.push(this.db.drop(db));
    await Promise.all(ops);

    const deletedIds = new Set(targets.map((t) => t.id));
    this.config.updateConfig({
      targets: this.config.config.targets.filter((t) => !deletedIds.has(t.id)),
    });
    this.selected.set(new Set());
  }

  // create a new target through a dialog form (validated before it closes)
  startCreate() {
    return startCreateTarget(
      this.config,
      this.eventLog,
      this.code,
      this.dialogs,
      this.db,
      this.server,
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
        body: JSON.stringify({ path, branch }),
      });
    }
    await createTargetFromRemoteBranch(this.config, this.eventLog, this.dialogs, branch, repos);
  }

  // regroup the per-target actions into the floating kebab menu (shared ActionMenu)
  async openRowMenu(ev, tgt) {
    const rect = ev.currentTarget.getBoundingClientRect(); // capture before the await
    // Apply's enabled state + its "dirty / missing branch" tooltip need this target's
    // checkout state — read it now, scoped to just this target's repos
    await this.code.loadBranches(this._repoIdsFor([tgt]));
    const active = this.isActive(tgt);
    const actions = [
      { label: "Edit", onClick: () => this.startEdit(tgt) },
      {
        label: "Apply",
        disabled: !this.canActivate(tgt),
        title: this.activateTitle(tgt),
        onClick: () => this.activate(tgt),
      },
      { label: "Duplicate", onClick: () => this.duplicateTarget(tgt) },
      {
        label: "Delete",
        danger: true,
        disabled: active,
        title: active ? "the active target cannot be deleted" : "",
        onClick: () => this.deleteTarget(tgt),
      },
    ];
    appBus.dispatchEvent(new CustomEvent("action-menu", { detail: { rect, actions } }));
  }

  // turn one row into inline inputs, pre-filled with the target's values
  // (only one row is editable at a time)
  startEdit(tgt) {
    this.draftName.set(tgt.name);
    this.draftConfig.set(repoBranchList.format(tgt.config));
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
    if (this.config.config.targets.some((t) => t.name === name && t.id !== id))
      return this.error.set(`a target named "${name}" already exists`);
    const config = repoBranchList.parse(this.draftConfig().trim());
    if (!config.length) return this.error.set("a config is required");
    const targets = this.config.config.targets.map((t) =>
      t.id === id
        ? { ...t, name, config, db: this.draftDb().trim(), on_create_args: this.draftArgs().trim() }
        : t,
    );
    this.config.updateConfig({ targets });
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
    const first = tgt.config?.[0]?.branch || "master";
    const res = await this.dialogs.open({
      title: `Duplicate "${tgt.name}"`,
      fields: [
        {
          key: "branch",
          type: "text",
          label: "Branch name",
          value: first,
          placeholder: "branch (applied to all repos)",
        },
        { key: "create", type: "checkbox", label: "Create branches", value: true },
      ],
    });
    if (!res) return;
    const b = (res.branch || "").trim();
    if (!b) return;
    // the new target is named after the chosen branch (deduped if it collides)
    const names = new Set(this.config.config.targets.map((t) => t.name));
    let name = b;
    for (let i = 2; names.has(name); i++) name = `${b} (${i})`;
    const copy = {
      id: newTargetId(),
      name,
      favorite: !!tgt.favorite,
      config: (tgt.config || []).map((c) => ({ repo: c.repo, branch: b })),
      db: b, // default the database to the branch name
      on_create_args: tgt.on_create_args || "",
    };
    this.eventLog.add(`creating target ${copy.name}`);
    this.config.updateConfig({ targets: [...this.config.config.targets, copy] });
    if (res.create) {
      const pathByRepo = Object.fromEntries(this.config.config.repos.map((r) => [r.id, r.path]));
      await this.code.createBranches(
        (tgt.config || []).map((c) => ({
          path: pathByRepo[c.repo],
          name: b,
          startPoint: c.branch, // start from the base
        })),
      );
    }
  }

  async deleteTarget(tgt) {
    await this._loadForDelete([tgt]); // branches + PRs + db for the cleanup options
    return deleteTargetDialog(tgt, {
      config: this.config,
      code: this.code,
      db: this.db,
      eventLog: this.eventLog,
      repoMap: this.repoMap,
      dialogs: this.dialogs,
      isActive: this.isActive(tgt),
    });
  }
}

// ─────────────────────────── Branches screen ───────────────────────────
// flat list (one row per branch × repo) over the same data the Dashboard tab loads

class BranchesScreen extends Component {
  static components = { SearchBox, DirtyBadge };
  worktree = plugin(WorktreePlugin); // "wt" badge on branches owned by a worktree
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
  repoFilter = signal(""); // "" = all repositories
  search = signal("");
  selected = signal(new Set()); // branch names ticked for batch actions
  sortKey = signal("update"); // "name" | "update" — default: most recently updated first
  sortDir = signal("desc"); // "asc" | "desc"
  // branches grouped by name (one group per branch name). Each group carries its
  // repo rows and is "active" when the branch is checked out in any of its repos.
  // Sorted by the chosen column (branch name, or summed last-update time).
  groups = computed(() => {
    const { prIndex, pathByRepo, githubByRepo } = this.code.groups();
    const repoFilter = this.repoFilter();
    const q = this.search().trim().toLowerCase();
    const byBranch = new Map();
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
          repoDirty: repo.dirty, // the repo's working tree (its current branch)
          pr: prIndex[`${repo.id}:${b.name}`],
        });
      }
    }
    const dir = this.sortDir() === "asc" ? 1 : -1;
    const key = this.sortKey();
    return [...byBranch.entries()]
      .map(([name, repos]) => ({
        name,
        base: BASE_BRANCH_RE.test(name),
        // combined last-update time for the branch (sum across its repos)
        updateSum: repos.reduce((s, r) => s + (Date.parse(r.date) || 0), 0),
        repos,
      }))
      .sort((a, b) =>
        key === "update" ? (a.updateSum - b.updateSum) * dir : a.name.localeCompare(b.name) * dir,
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
    this.selected.set(this.allSelected ? new Set() : new Set(this.groups().map((g) => g.name)));
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
    const prs = rows.filter((r) => r.pr && r.pr.state === "OPEN" && r.github);
    const remoteRows = rows.filter((r) => r.remote && !r.base);
    const what = groups.length === 1 ? `branch "${groups[0].name}"` : `${groups.length} branches`;
    const fields = [];
    if (remoteRows.length)
      fields.push({
        key: "delRemote",
        type: "checkbox",
        label: `Also delete ${remoteRows.length === 1 ? "it" : "them"} on the remote (odoo-dev)`,
        value: false,
      });
    if (prs.length)
      fields.push({
        key: "closePrs",
        type: "checkbox",
        label: `Close ${prs.length === 1 ? "its open pull request" : `${prs.length} open pull requests`}`,
        value: true,
      });
    const res = await this.dialogs.open({
      title: "Delete branches",
      message:
        `Delete ${what} in ${rows.length} repo${rows.length === 1 ? "" : "s"} locally?` +
        (skipped ? ` ${skipped} skipped (checked out).` : "") +
        " This cannot be undone.",
      okLabel: "Delete",
      fields,
    });
    if (!res) return;
    if (res.closePrs) for (const r of prs) await this.code.closePrNoConfirm(r.github, r.pr.number);
    for (const r of rows)
      await this.code.deleteBranchNoConfirm(
        r.branch,
        r.repo,
        r.path,
        !!res.delRemote && r.remote && !r.base,
      );
    this.selected.set(new Set());
  }

  // single-row delete, confirmed via the dialog. When the branch has an open PR
  // it can be closed first; targets that reference this exact branch can be
  // removed in the same step.
  async deleteRow(r) {
    if (this.deleteBlocked(r)) return;
    const canRemote = r.remote && !r.base; // pushed, non-base: removable on the remote
    const hasPr = !!(r.pr && r.pr.state === "OPEN" && r.github);
    const targets = this.config.config.targets.filter((t) =>
      (t.config || []).some((c) => c.repo === r.repo && c.branch === r.branch),
    );
    const fields = [];
    if (canRemote)
      fields.push({
        key: "delRemote",
        type: "checkbox",
        label: "Also delete it on the remote (odoo-dev)",
        value: false,
      });
    if (hasPr)
      fields.push({
        key: "closePr",
        type: "checkbox",
        label: `Close PR #${r.pr.number}`,
        value: true,
      });
    for (const t of targets)
      fields.push({
        key: `tgt:${t.id}`,
        type: "checkbox",
        label: `Delete target "${t.name}"`,
        value: false,
      });

    const res = await this.dialogs.open({
      title: `Delete "${r.branch}"?`,
      message: `Force-delete "${r.branch}" in ${r.repo} locally. This cannot be undone.`,
      okLabel: "Delete",
      fields,
    });
    if (!res) return;
    // close the PR before deleting the branch, then drop the branch
    if (hasPr && res.closePr) await this.code.closePrNoConfirm(r.github, r.pr.number);
    await this.code.deleteBranchNoConfirm(r.branch, r.repo, r.path, !!res.delRemote);
    // remove any targets the user opted to delete
    const drop = targets.filter((t) => res[`tgt:${t.id}`]);
    if (drop.length) {
      const ids = new Set(drop.map((t) => t.id));
      for (const t of drop) this.code.eventLog.add(`deleting target ${t.name}`);
      this.config.updateConfig({
        targets: this.config.config.targets.filter((t) => !ids.has(t.id)),
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
    return this.sortDir() === "asc" ? " ▲" : " ▼";
  }

  // repositories present in the loaded data (for the filter dropdown)
  get repos() {
    return this.code.branchRepos().map((r) => r.id);
  }

  get count() {
    const n = this.groups().reduce((t, g) => t + g.repos.length, 0);
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
        onClick: () => this.pushBranch(r),
      });
    if (!r.base && r.remote && r.github && !r.pr)
      actions.push({ label: "Open PR", onClick: () => this.openPr(r) });
    if (r.pr && r.github && r.pr.state === "OPEN")
      actions.push({
        label: "Close PR",
        danger: true,
        onClick: () => this.code.closePr(r.github, r.pr.number),
      });
    const coBlocked = this.checkoutBlocked(r);
    actions.push({
      label: "Checkout",
      disabled: !!coBlocked,
      title: coBlocked || `check out ${r.branch} in ${r.repo}`,
      onClick: () => this.checkout(r),
    });
    actions.push({
      label: "Duplicate",
      title: "create a new branch based on this one",
      onClick: () => this.duplicateBranch(r),
    });
    const delBlocked = this.deleteBlocked(r);
    actions.push({
      label: "Delete",
      danger: true,
      disabled: !!delBlocked,
      title: delBlocked || "",
      onClick: () => this.deleteRow(r),
    });
    appBus.dispatchEvent(new CustomEvent("action-menu", { detail: { rect, actions } }));
  }

  // why a branch can't be checked out ("" = allowed): already checked out, or the
  // repo's working tree is dirty (a checkout would fail / lose changes)
  checkoutBlocked(row) {
    if (row.active) return "this branch is already checked out";
    if (row.repoDirty) return "commit or stash changes first — the working tree is dirty";
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
      message: `Push ${row.branch} (${row.repo}) to the dev remote (odoo-dev)?`,
    });
  }

  // create a new branch based on this one (git branch <new> <branch> — no checkout)
  // show the last commits on this branch (in a floating dialog)
  openCommits(row) {
    if (!row.path) return;
    this.dialogs.openComponent(CommitsDialog, {
      path: row.path,
      ref: row.branch,
      label: `${row.repo} · ${row.branch}`,
      github: row.github || "",
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
          placeholder: "new branch name",
        },
      ],
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
    return ""; // an open PR no longer blocks: the delete dialog offers to close it
  }

  get stamp() {
    if (this.code.loading()) return "refreshing…";
    return this.code.at() ? `updated ${timeAgo(new Date(this.code.at()).toISOString())}` : "";
  }

  cell(date) {
    return timeAgo(date);
  }

  prState(p) {
    const st = p.isDraft && p.state === "OPEN" ? "DRAFT" : p.state;
    return st.toLowerCase();
  }
}

// ─────────────────────────── PRs screen ───────────────────────────

// One PR tracker with a role toggle: "Mine" (gh pr list --author @me, via
// CodePlugin) and "Reviewing" (PRs I commented on but didn't author, via
// ReviewPlugin). Both fold into one normalized row shape and render the same
// grouped-by-branch table (mergebot column, star favorites). Mine adds the
// Close-PR kebab + batch close; Reviewing is read-only.
class PrsScreen extends Component {
  static components = { SearchBox };
  worktree = plugin(WorktreePlugin); // "wt" badge on PR branches owned by a worktree
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
  repoFilter = signal(""); // "" = all repositories
  search = signal("");
  statusFilter = signal("unmerged"); // mergebot status; "" = all, "unmerged" = still in flight
  selected = signal(new Set()); // "github:number" of PRs ticked for batch close (Mine only)
  _reviewLoaded = false; // lazy-load guard for the Reviewing segment

  setup() {
    this.code.load(); // Mine data (also fed to the Dashboard); the common default
    if (this.mode() === "reviewing") {
      this._reviewLoaded = true;
      this.review.load();
    }
    // Back-compat: #prs and #reviews map to this same (never-remounted) component,
    // so an old #reviews bookmark hit while it's already mounted must flip the
    // segment by hand. A plain hashchange listener does it — NOT a reactive
    // useEffect, which (Owl's useEffect tracks signal reads, with no deps array)
    // would also re-fire on mode() changes and revert the manual toggle.
    const onHash = () => this.setMode(location.hash.slice(1) === "reviews" ? "reviewing" : "mine");
    onMounted(() => window.addEventListener("hashchange", onHash));
    onWillUnmount(() => window.removeEventListener("hashchange", onHash));
    // mergebot for the active segment, routed through ReviewPlugin (its dedup +
    // persistent merged/no-mergebot caches make repeat renders cheap)
    useEffect(() => {
      if (this.rows().length) this.review.loadMergebot(this._mbPrs());
    });
  }

  // flip segment; clear the Mine-only selection and lazy-load Reviewing once
  setMode(m) {
    if (this.mode() === m) return;
    this.mode.set(m);
    this.selected.set(new Set());
    if (m === "reviewing" && !this._reviewLoaded) {
      this._reviewLoaded = true;
      this.review.load();
    }
  }

  // the open PRs in mergebot's {github, number} shape (github === the slug).
  // mergebot only tracks the in-flight merge, so terminal PRs (GitHub merged or
  // closed) never need a scrape — and the authored list is fetched --state all,
  // so this is most of them. Skipping them avoids hundreds of pointless requests.
  _mbPrs() {
    return this.rows()
      .filter((r) => r.state === "open" && !this.code.isExternalRepo(r.github))
      .map((r) => ({ github: r.github, number: r.number }));
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
        onClick: () => this.code.closePr(row.github, row.number),
      },
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
      this.allSelected
        ? new Set()
        : new Set(this._selectablePrs.map((r) => `${r.github}:${r.number}`)),
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
      fields: [],
    });
    if (!res) return;
    // independent network ops — fire them concurrently rather than one slow await
    // after another (closePrNoConfirm handles its own errors, so this never rejects)
    await Promise.all(prs.map((r) => this.code.closePrNoConfirm(r.github, r.number)));
    this.selected.set(new Set());
  }

  get stamp() {
    const [loading, at] =
      this.mode() === "mine"
        ? [this.code.loading(), this.code.at()]
        : [this.review.loading(), this.review.at()];
    if (loading) return "refreshing…";
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
    return this.mode() === "mine"
      ? "No pull requests."
      : "No PRs commented on in the last 14 days.";
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
      (this.config.config.repos || []).filter((r) => r.github).map((r) => [r.github, r.id]),
    );
  }

  labelFor(github) {
    return this._slugToId[github] || github;
  }

  // PRs of the active segment, normalized to one row shape and filtered by search +
  // repository. The two sources differ (state case, draft/branch/repo field names),
  // so both fold into { number, title, url, github (slug), repoLabel, branch,
  // state (lowercase), draft, updatedAt }; every downstream helper reads these.
  // Mine rows also carry createdAt — the date column shows it for your own PRs
  // (their updatedAt is noisy: it bumps on any comment/label long after the work).
  rows() {
    const q = this.search().trim().toLowerCase();
    const repoFilter = this.repoFilter();
    let list;
    if (this.mode() === "mine") {
      list = [];
      for (const repo of this.code.prRepos()) {
        if (repo.error) continue;
        for (const pr of repo.prs) {
          list.push({
            number: pr.number,
            title: pr.title || "",
            url: pr.url,
            github: repo.github,
            repoLabel: repo.id,
            branch: pr.headRefName,
            state: (pr.state || "").toLowerCase(),
            draft: !!pr.isDraft,
            createdAt: pr.createdAt,
            updatedAt: pr.updatedAt,
          });
        }
      }
    } else {
      list = this.review.prs().map((pr) => ({
        number: pr.number,
        title: pr.title || "",
        url: pr.url,
        github: pr.repo,
        repoLabel: this.labelFor(pr.repo),
        branch: pr.branch,
        state: pr.state,
        draft: !!pr.draft,
        updatedAt: pr.updatedAt,
      }));
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
    const byBranch = new Map();
    for (const r of this.rows()) {
      const key = r.branch || "—";
      (byBranch.get(key) || byBranch.set(key, []).get(key)).push(r);
    }
    const ts = (r) => Date.parse(this.prDate(r)) || 0; // sort by the same date shown
    const repoOrder = (this.config.config.repos || []).map((r) => r.github);
    const rank = (r) => {
      const i = repoOrder.indexOf(r.github);
      return i === -1 ? repoOrder.length : i; // unknown repos sort last
    };
    const status = this.statusFilter();
    return [...byBranch.entries()]
      .map(([branch, prs]) => ({
        branch,
        prs: prs
          .slice()
          .sort((a, b) => rank(a) - rank(b) || a.github.localeCompare(b.github) || ts(b) - ts(a)),
        updated: Math.max(...prs.map(ts)),
        fav: this.review.isFavorite(branch),
      }))
      .filter((g) => {
        if (!status) return true;
        // "merged" is the complement of "unmerged"; both read GitHub's terminal
        // state (no mergebot needed). "error"/"blocked" are mergebot states that
        // only exist on still-open PRs, which we do scrape.
        if (status === "unmerged") return g.prs.some((pr) => !this._isMerged(pr));
        if (status === "merged") return g.prs.some((pr) => this._isMerged(pr));
        return g.prs.some((pr) => this.mbState(pr) === status);
      })
      .sort((a, b) => b.fav - a.fav || b.updated - a.updated);
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
}

// ─────────────────────────── Tests screen ───────────────────────────

class TestsScreen extends Component {
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
    if (s === "running…" || s === "starting…") return { label: "running", cls: "run" };
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
}

// ─────────────────────────── Assets screen ───────────────────────────

// One node of the bundle-analysis tree: a path segment (folder) or a leaf file,
// with its aggregated minified size. Recursive — expands to its children, which
// are sorted largest-first by the screen. Top-level (depth 0) nodes open by default.
class BundleNode extends Component {
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
}
BundleNode.components = { BundleNode };

// Inspect a database's asset bundles: pick a db, list its /web/assets/* attachments
// (ir_attachment in the db/filestore), force a fresh pregeneration, and analyze one
// bundle's per-file size breakdown (click a bundle name).
class AssetsScreen extends Component {
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
  view = signal("tree"); // analysis view: "tree" (aggregate) | "flat"
  treeSearch = signal(""); // filter files within the analysis
  copiedId = signal(null); // id of the row whose url was just copied (transient label)
  sortKey = signal("size"); // "name" | "size"
  sortDir = signal("desc"); // "asc" | "desc" — default: largest bundle first
  search = signal("");
  showJs = signal(true); // include .js bundles
  showCss = signal(true); // include .css bundles
  showOther = signal(true); // include non-js/non-css assets (fonts, source maps, xml…)

  setup() {
    this.db.load(); // populate the database selector
    if (!this.assets.selectedDb()) {
      const d = this.assets.defaultDb();
      if (d) this.assets.selectDb(d);
    }
  }

  get dbOptions() {
    return this.db.databases().map((d) => d.name);
  }

  get stamp() {
    if (this.assets.generating()) return "generating…";
    if (this.assets.loading()) return "loading…";
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
    const all = [...(d.js || []), ...(d.css || []), ...(d.xml || [])];
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
    const byPath = new Map();
    for (const [path, bytes] of [...(d.js || []), ...(d.css || []), ...(d.xml || [])]) {
      byPath.set(path, (byPath.get(path) || 0) + bytes);
    }
    return [...byPath.entries()]
      .map(([path, bytes]) => ({ path, bytes }))
      .filter((f) => !q || f.path.toLowerCase().includes(q))
      .sort((a, b) => b.bytes - a.bytes);
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
      ["xml", d.xml],
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
      children: Object.values(n.children)
        .map(finalize)
        .sort((a, b) => b.size - a.size),
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
    return this.assets
      .bundles()
      .filter((b) => {
        const k = this.kind(b);
        if (k === "js" && !showJs) return false;
        if (k === "css" && !showCss) return false;
        if (k === "other" && !showOther) return false;
        return !q || b.name.toLowerCase().includes(q) || b.url.toLowerCase().includes(q);
      })
      .sort((a, b) =>
        bySize ? dir * ((a.size || 0) - (b.size || 0)) : dir * a.name.localeCompare(b.name),
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
    return this.sortDir() === "asc" ? " ▲" : " ▼";
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
}

// ─────────────────────────── Addons screen ───────────────────────────

class AddonsScreen extends Component {
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
    // load (and reload when the active target's db changes) while mounted
    useEffect(() => {
      const db = this.addons.targetDb();
      if (
        db &&
        db !== this.addons.loadedDb() &&
        db !== this.addons.erroredDb() &&
        !this.addons.loading()
      )
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
    return `${this.addons.targetName()} · ${this.addons.targetDb()}`;
  }

  toggleState(value) {
    this.addons.stateFilter.set(this.addons.stateFilter() === value ? "" : value);
  }

  stateClass(mod) {
    return (mod.state || "none").replace(/\s+/g, "-");
  }
}

// ─────────────────────────── Config screen ───────────────────────────

class ListEditor extends Component {
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
  dragIndex = signal(-1); // row being dragged (-1 = none); only set for reorderable specs
  dragOverIndex = signal(-1); // row the drag is hovering over
  setup() {
    this.load();
  }

  onDragStart(ev, i) {
    this.dragIndex.set(i);
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", String(i)); // some browsers need data to start a drag
  }

  onDragOver(ev, i) {
    if (this.dragIndex() < 0) return; // no handle drag in progress (e.g. non-reorderable list)
    ev.preventDefault(); // mark this row as a valid drop target
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
    rows.splice(from < to ? to - 1 : to, 0, moved); // account for the removed row's shift
    this.rows.set(rows);
    this.saveAuto();
  }

  load() {
    this.rows.set(
      this.config.config[this.spec.key].map((item) => {
        const r = {};
        for (const f of this.spec.fields)
          r[f.key] =
            f.type === "checkbox"
              ? !!item[f.key]
              : f.format
                ? f.format(item[f.key])
                : item[f.key] || "";
        return r;
      }),
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
    if (!isError) setTimeout(() => this.msgText.set(""), 2000);
  }

  // auto-save: silently skips rows with incomplete required fields so mid-edit
  // keystrokes don't flash errors; still surfaces spec-level errors (e.g. missing
  // "community" repo) and duplicate-key errors.
  saveAuto() {
    const items = [];
    const seen = new Set();
    for (const row of this.rows()) {
      const raw = {};
      for (const f of this.spec.fields)
        raw[f.key] = f.type === "checkbox" ? !!row[f.key] : (row[f.key] || "").trim();
      if (this.spec.fields.every((f) => !raw[f.key])) continue; // skip blank rows
      if (this.spec.fields.some((f) => !f.optional && !raw[f.key])) continue; // skip incomplete rows silently
      const keyVal = raw[this.spec.fields[0].key];
      if (seen.has(keyVal)) return; // duplicate — abort silently
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
}

// Show/hide and reorder the sidebar tabs. Stored in config.tabs as [{id, visible}]
// in display order; NAV is the source of tab metadata (label/icon) and defaults.
class TabsEditor extends Component {
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
    const cfg = Object.fromEntries(configured.map((t) => [t.id, t]));
    // unconfigured tabs default visible, except opt-in ones (Worktrees) which start off
    return mergedTabIds(configured).map((id) => ({
      id,
      label: meta[id].label,
      visible: id === "config" ? true : cfg[id] ? cfg[id].visible !== false : !meta[id].optIn,
    }));
  }

  _save(rows) {
    this.config.updateConfig({ tabs: rows.map((r) => ({ id: r.id, visible: r.visible })) });
  }

  toggle(id, visible) {
    if (id === "config") return; // can't hide Config (no way back otherwise)
    this._save(this.rows.map((r) => (r.id === id ? { ...r, visible } : r)));
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
    rows.splice(from < i ? i - 1 : i, 0, moved); // account for the removed row's shift
    this._save(rows);
  }

  onDragEnd() {
    this.dragIndex.set(-1);
    this.dragOverIndex.set(-1);
  }
}

// Navbar links editor — a depth-1 tree. Top-level rows are links or menus; a menu
// holds links. Drag the handle to reorder within a level, drop a link onto a menu's
// body to move it inside (or onto a row to place it before that row). Saved to
// config.links as [{label, href} | {label, children:[{label, href}]}]. Editor-only
// `_id`s give drag/drop a stable identity and are stripped on save.
class LinksEditor extends Component {
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
  items = signal([]); // [{label, href, _id} | {label, children:[{label, href, _id}], _id}]
  dragId = signal(0); // _id of the dragged row (0 = none)
  overId = signal(0); // row hovered as a "drop before" target
  overInto = signal(0); // menu whose body is hovered (drop inside)
  overEnd = signal(false); // trailing "top level" zone hovered
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
      }),
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
    ev.dataTransfer.setData("text/plain", String(id)); // some browsers need data to start a drag
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
    ev.stopPropagation(); // a child row shouldn't also mark its menu body as the target
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
    if (this.isMenu(src.node) && tgt.container !== items) return; // no menu inside a menu
    src.container.splice(src.index, 1);
    const t = this._locate(items, targetId); // re-locate: removal may have shifted indices
    t.container.splice(t.index, 0, src.node);
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
    const links = this.items()
      .map((it) => {
        if (this.isMenu(it)) {
          return {
            label: (it.label || "").trim(),
            children: it.children
              .map((c) => ({ label: (c.label || "").trim(), href: (c.href || "").trim() }))
              .filter((c) => c.label && c.href),
          };
        }
        return { label: (it.label || "").trim(), href: (it.href || "").trim() };
      })
      .filter((it) => it.children || it.label || it.href);
    this.config.updateConfig({ links });
  }
}

// scalar config fields editable in the Config tab's Settings block
const SETTINGS_FIELDS = [
  { key: "venv_activate", name: "venv activate (optional)" },
  { key: "server_path", name: "odoo-bin path" },
  { key: "worktree_dir", name: "worktree dir" },
  { key: "db_user", name: "database user" },
  { key: "db_password", name: "database password" },
  { key: "filestore", name: "filestore path" },
  { key: "editor", name: "editor command" },
];

class ConfigScreen extends Component {
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
          </div>
        </div>
        <TabsEditor/>
        <ListEditor kind="'repos'"/>
        <ListEditor kind="'testPresets'"/>
        <LinksEditor/>
        <div class="config-block">
          <h2 class="subtitle">Storage</h2>
          <p class="dim">By default, config and favorites live only in this browser. Set a file path to persist them on disk instead — shared across browsers and safe from clearing site data.</p>
          <div class="config-actions">
            <input type="text" class="w-flex" t-att-value="this.path()" t-on-input="ev => this.path.set(ev.target.value)" placeholder="e.g. ~/.config/oo/data.json"/>
            <button t-on-click="() => this.useFile()">Use file</button>
            <button t-on-click="() => this.clearFile()">Use browser</button>
            <span t-out="this.msg()"/>
          </div>
        </div>
        <div class="config-block">
          <h2 class="subtitle">Backup</h2>
          <p class="dim">Save your config and favorites to a file, or restore them from one.</p>
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
  upToDate = signal(false); // brief green check by the button when already up to date
  path = signal(this.config.getDataFile());
  msg = signal("");
  backupMsg = signal("");
  settingsFields = SETTINGS_FIELDS.filter((f) => f.key !== "editor"); // editor lives in Miscellaneous
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
        `checked for updates — ${n} commit${n === 1 ? "" : "s"} behind origin/master`,
      );
      return void this.update.promptUpdate();
    }
    if (r.ok) {
      // up to date — a quiet green check next to the button rather than a dialog
      this.eventLog.add("checked for updates — goo is up to date");
      this.upToDate.set(true);
      setTimeout(() => this.upToDate.set(false), 3000);
      return;
    }
    this.eventLog.add("checked for updates — could not reach origin", "", "error");
    this.dialogs.open({
      title: "Couldn't check for updates",
      message:
        "Make sure goo runs from a git checkout with an 'origin' remote and that you're online.",
      cls: "dialog-error",
      okLabel: "OK",
      cancelLabel: null,
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
      message:
        "This erases all your customizations (settings, repos, targets, links, favorites, last target, history) and cannot be undone.",
      okLabel: "Reset everything",
      cls: "dialog-error",
    });
    if (!ok) return;
    await this.config.resetConfig();
    location.reload();
  }

  // pick a preset (presets.js) and replace the whole config with it
  async openPresets() {
    const res = await this.dialogs.open({
      title: "Configuration presets",
      message:
        "Applying a preset replaces your current configuration (settings, repos, targets, links, tabs, favorites). This cannot be undone.",
      fields: [
        {
          key: "preset",
          type: "select",
          label: "Preset",
          value: "normal",
          options: PRESETS.map((p) => ({ value: p.id, label: p.label })),
        },
      ],
      okLabel: "Apply",
      cancelLabel: "Cancel",
      validate: (v) => (v.preset ? "" : "Choose a preset to apply."),
    });
    if (!res) return;
    await this.config.applyPreset(res.preset);
    location.reload();
  }

  async useFile() {
    try {
      this.msg.set(await this.config.useFile(this.path()));
      setTimeout(() => location.reload(), 700);
    } catch (e) {
      this.msg.set(`Could not use file: ${e.message}`);
    }
  }

  clearFile() {
    this.config.clearFile();
    this.path.set("");
    this.msg.set("Using browser storage.");
  }

  exportData() {
    const data = {};
    for (const k of ["oo-config", "oo-prs-favorites", "oo-last-target", "oo-test-history"]) {
      const v = localStorage.getItem(k);
      if (v !== null) data[k] = v;
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
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
      if (!data || typeof data !== "object") throw new Error("not a JSON object");
      let n = 0;
      for (const k of ["oo-config", "oo-prs-favorites", "oo-last-target", "oo-test-history"]) {
        if (typeof data[k] === "string") {
          localStorage.setItem(k, data[k]);
          n++;
        }
      }
      if (!n) throw new Error("no recognized data in file");
      if (this.config.getDataFile()) await this.config.flush(this.config.getDataFile());
      this.backupMsg.set(`Imported ${n} item(s), reloading…`);
      setTimeout(() => location.reload(), 700);
    } catch (e) {
      this.backupMsg.set(`Import failed: ${e.message}`);
    }
  }
}

// ─────────────────────────── Action menu popover ───────────────────────────

// A generic floating kebab menu. Lives at the app root and is opened via the
// appBus "action-menu" event with an anchor rect + a list of actions
// ({ label, danger?, disabled?, title?, onClick }). Positioned fixed so it
// escapes overflow-clipped containers (e.g. the scrolling branches table);
// flips above the anchor when it would run off the bottom of the viewport.
class ActionMenu extends Component {
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
    await Promise.resolve(); // wait a tick so offsetWidth/Height reflect the items
    const w = this._el.offsetWidth;
    const h = this._el.offsetHeight;
    // open below the anchor; flip above if it would overflow the viewport bottom
    let top = rect.bottom + 4;
    if (top + h > window.innerHeight - 12) top = Math.max(12, rect.top - h - 4);
    this._el.style.top = `${top}px`;
    // right-align the menu to the kebab, clamped to the viewport
    this._el.style.left = `${Math.max(12, Math.min(rect.right - w, window.innerWidth - w - 12))}px`;
  }

  select(a) {
    if (a.disabled) return;
    this.open.set(false);
    a.onClick?.();
  }
}

// ─────────────────────────── CI breakdown popover ────────────────────────────

// The full per-check CI status of a PR (runbot, style, lint, security, install,
// upgrade, l10n…), each row linking to its build. Opened via the appBus
// "ci-menu" event with an anchor rect + the checks list; fixed-positioned (like
// ActionMenu) so it escapes overflow-clipped containers.
class CiMenu extends Component {
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
      // opened on badge hover; lingers briefly on leave so the mouse can cross the
      // gap into the popover (to use its per-check build links)
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
    this.cancelClose(); // moving onto another badge cancels the pending close
    this.checks.set(checks);
    this.open.set(true);
    await Promise.resolve(); // let the list render so offsetWidth/Height are real
    const w = this._el.offsetWidth;
    const h = this._el.offsetHeight;
    let top = rect.bottom + 4;
    if (top + h > window.innerHeight - 12) top = Math.max(12, rect.top - h - 4);
    this._el.style.top = `${top}px`;
    this._el.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - w - 12))}px`;
  }

  stateLabel(state) {
    return { success: "ok", failure: "ko", pending: "running" }[state] || "—";
  }
}

// ─────────────────────────── Mergebot breakdown popover ──────────────────────

// The per-repo mergebot status of a target's PRs (one row per repo), each linking
// to its mergebot page; a blocked row also shows its unmet requirements. Opened
// via the appBus "mb-menu" event with an anchor rect + the rows list;
// fixed-positioned (like CiMenu) so it escapes overflow-clipped containers.
class MbMenu extends Component {
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
      // opened on badge hover; lingers briefly on leave so the mouse can cross the
      // gap into the popover (to use its per-repo mergebot links)
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
    this.cancelClose(); // moving onto another badge cancels the pending close
    this.rows.set(rows);
    this.open.set(true);
    await Promise.resolve(); // let the list render so offsetWidth/Height are real
    const w = this._el.offsetWidth;
    const h = this._el.offsetHeight;
    let top = rect.bottom + 4;
    if (top + h > window.innerHeight - 12) top = Math.max(12, rect.top - h - 4);
    this._el.style.top = `${top}px`;
    this._el.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - w - 12))}px`;
  }

  // "blocked · Review, CI" — the state word, plus the unmet requirements when present
  label(r) {
    return r.detail ? `${r.state} · ${r.detail}` : r.state;
  }
}

// ─────────────────────────── Remote branch dialog ────────────────────────────
// Search for a branch on GitHub across all configured repos, select one, then
// hand back { branch, repos } to the caller to create a local tracking branch.

class RemoteBranchDialog extends Component {
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
    const repos = this.config.config.repos
      .filter((r) => r.github)
      .map((r) => ({ id: r.id, github: r.github }));
    try {
      const res = await fetch("/api/code/remote-branches/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repos, query }),
      });
      const data = await res.json();
      if (!data.ok) return;
      const byBranch = {};
      for (const { repo, branch } of data.results) {
        if (!byBranch[branch]) byBranch[branch] = [];
        byBranch[branch].push(repo);
      }
      this.rows.set(Object.entries(byBranch).map(([branch, repos]) => ({ branch, repos })));
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
}

// ─────────────────────────── Event log ───────────────────────────
// A floating, toggleable panel (bottom-right) listing business events. Hidden
// by default; toggled from the sidebar. Newest entries first.

// lazy-load xterm.js + addon-fit only on first terminal open
let _xtermReady = null;
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

/* global Terminal, FitAddon */
// attach an xterm terminal to `el`, backed by the WebSocket at `wsUrl` (bytes
// both ways, JSON resize messages). Returns a dispose() that tears it all down.
// Shared by the floating TerminalPanel (/api/terminal) and TerminalDialog (/api/shell).
async function attachXterm(el, wsUrl, focusOnOpen = false) {
  await loadXterm();
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "var(--mono, monospace)",
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  // rAF lets the browser lay out xterm's DOM so FitAddon reads non-zero cells
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
      /* already closing */
    }
    term.dispose();
  };
}

// ─────────────────────────── Terminal panel ───────────────────────────

// draggable + resizable floating-window behaviour shared by the terminal windows.
// Call from setup() and bind the returned `handle` to the panel root via t-ref.
// Position is written straight to the DOM (not through a reactive style binding),
// so the window paints centered on the very first frame — no reposition flash —
// and dragging mutates the element directly instead of re-rendering per mousemove.
// `place(w, h) => {x, y}` overrides the default (centered) first position — e.g.
// the event log anchors bottom-right. x/y persist in the closure so a dragged
// window keeps its spot when reshown.
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
  // when the panel root (re)mounts, center it once then write the position
  // directly. The effect runs before the browser paints, so there is no flash;
  // x/y persist in this closure, so a dragged window keeps its spot if reshown.
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
    },
  };
}

class TerminalPanel extends Component {
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
  _termOpen = false; // guard against double-open on re-renders

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
        dispose(); // container swapped/gone while loading
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
}

// ─────────────────────────── Terminal dialog ───────────────────────────
// A draggable, resizable floating terminal running bash in a given directory
// (opened from the Dashboard repo list). Backed by /api/shell, so it works
// regardless of the Odoo server; shares the term-panel chrome + useDragResize
// with the server-tab TerminalPanel.
class TerminalDialog extends Component {
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
      attachXterm(el, url, true).then((dispose) => (live ? (this._dispose = dispose) : dispose()));
      return () => {
        live = false;
        this._dispose?.();
        this._dispose = null;
      };
    });
    const onKey = (e) => {
      // let a focused terminal handle Escape itself (vim, readline, …); only
      // close the dialog when focus is outside the terminal
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
}

// ─────────────────────────── Commits dialog ───────────────────────────
// A draggable, resizable floating window listing the last commits on a repo's
// current branch (opened from the Dashboard repo list). Shares the term-panel
// chrome + useDragResize with the terminal windows.
class CommitsDialog extends Component {
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
    github: t.string().optional(),
  });

  code = plugin(CodePlugin);
  externalIcon = m(ICONS.external);
  commits = signal([]);
  loading = signal(true);
  error = signal("");
  expanded = signal(new Set());

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
    return c.body ? `${c.subject}\n\n${c.body}` : c.subject;
  }

  // the commit on GitHub (only linked when the repo has a github slug)
  commitUrl(c) {
    return `https://github.com/${this.props.github}/commit/${c.sha}`;
  }

  done(result) {
    this.props.done(result);
  }
}

class EventLog extends Component {
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
  autoScroll = signal(true); // follow the tail as new events arrive
  _lastCount = 0;

  setup() {
    // draggable + resizable; defaults to the bottom-right corner (its old fixed spot)
    this.drag = useDragResize({
      w: 540,
      h: 380,
      place: (w, h) => ({
        x: Math.max(0, window.innerWidth - w - 16),
        y: Math.max(0, window.innerHeight - h - 16),
      }),
    });
    this._lastCount = this.log.entries().length;
    // auto-open the panel when a *new* event arrives, if the setting is on
    // (kept separate from the scroll effect; never reads open() to avoid a loop)
    useEffect(() => {
      const count = this.log.entries().length;
      if (count > this._lastCount && this.config.config.auto_open_event_log)
        this.log.open.set(true);
      this._lastCount = count;
    });
    // keep the newest entry in view while autoscroll is on. onPatched runs after
    // the DOM is updated (the new rows are present), so scrollHeight is correct —
    // a reactive effect would run before the patch and read a stale height
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
        this.tests.output.autoScroll.set(false); // stay on the line, don't snap to the tail
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
    const STATUS_TITLE = { pending: "in progress…", done: "done", error: "failed" };
    return this.log.entries().map((e) => {
      const d = new Date(e.at);
      return {
        id: e.id,
        time: d.toLocaleTimeString([], { hour12: false }), // 24h, no AM/PM
        full: d.toLocaleString(), // full date + time, shown on hover
        text: e.text,
        anchor: e.anchor || "",
        level: e.level || "",
        status: e.status || "", // "" | pending | done | error (timed events)
        statusTitle: STATUS_TITLE[e.status] || "",
      };
    });
  }
}

// ─────────────────────────── Root ───────────────────────────

const SCREENS = {
  dashboard: DashboardScreen,
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
  config: ConfigScreen,
};

export class App extends Component {
  static components = {
    Topbar,
    Sidebar,
    DashboardScreen,
    ServerScreen,
    WorktreeScreen,
    TargetsScreen,
    BranchesScreen,
    PrsScreen,
    TestsScreen,
    DatabasesScreen,
    AssetsScreen,
    AddonsScreen,
    ConfigScreen,
    ActionMenu,
    CiMenu,
    MbMenu,
    DirtyMenu,
    EventLog,
    TerminalPanel,
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
    // load the real server state before the first render, so a reload of a running
    // server shows "Stop" straight away instead of flashing "Start" → "Stop"
    onWillStart(() => this.server.loadStatus());
    useEffect(() => {
      // displayState() (not the raw status) so the favicon flips in lockstep with
      // the navbar dot — amber the instant Start is clicked, before the backend
      // confirms — rather than lagging until the first status event
      const state = this.server.displayState();
      const el = document.getElementById("favicon");
      // green up, amber starting, red disconnected, black (default) when stopped
      const icon =
        state === "running"
          ? "favicon-up"
          : state === "starting"
            ? "favicon-starting"
            : state === "disconnected"
              ? "favicon-down"
              : "favicon";
      if (el) el.href = `/static/${icon}.svg`;
    });
    // "[open in hoot]" links (built in utils.js) — HOOT is served by odoo, so
    // start the server first if it's down, then point the tab at the test.
    const onHoot = (e) => this.openHoot(e.detail.url);
    document.addEventListener("goo:open-hoot", onHoot);
    onWillUnmount(() => document.removeEventListener("goo:open-hoot", onHoot));
  }

  async openHoot(url) {
    const running = this.server.status().state === "running";
    // open the tab now (inside the click gesture) to avoid popup blockers
    const win = window.open(running ? url : "about:blank", "_blank");
    if (running) return;
    await this.server.start(this.server.lastTarget());
    const ok = await this.server.waitUntilRunning();
    if (win && !win.closed) {
      if (ok) win.location.href = url;
      else win.close(); // server didn't come up (start error is surfaced separately)
    }
  }
}

// ─────────────────────────── helpers ───────────────────────────

// "community:master,enterprise:master" <-> [{repo, branch}, ...]
const repoBranchList = {
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
const SPECS = {
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
        className: "w-flex",
      },
      {
        key: "github",
        name: "github repo",
        placeholder: "github (e.g. odoo/odoo)",
        className: "w-name",
        optional: true,
      },
      { key: "autoreload", name: "auto-reload master", type: "checkbox", optional: true },
      {
        key: "external",
        name: "external",
        type: "checkbox",
        optional: true,
        title:
          "a repo outside the odoo CI ecosystem (e.g. odoo/owl) — skip its mergebot/runbot lookups",
      },
      {
        key: "favorite",
        name: "favorite",
        type: "checkbox",
        optional: true,
        title: "favorite repositories appear in the dashboard summary",
      },
    ],
    validate(repos, config) {
      if (!repos.find((r) => r.id === "community"))
        return 'a "community" repository is required (odoo-bin lives there)';
      const ids = new Set(repos.map((r) => r.id));
      for (const t of config.targets) {
        const used = (t.config || []).find((c) => !ids.has(c.repo));
        if (used) return `repository "${used.repo}" is still used by target "${t.name}"`;
      }
      return null;
    },
  },
  testPresets: {
    key: "test_presets",
    title: "Test presets",
    itemName: "preset",
    reorderable: true, // drag the handle to reorder how presets appear in the Tests selector
    fields: [
      {
        key: "tags",
        name: "test tags",
        placeholder: "--test-tags, e.g. /web:WebSuite[@web]",
        className: "w-flex",
      },
    ],
    validate() {
      return null;
    },
  },
};
