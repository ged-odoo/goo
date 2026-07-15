import {
  Component,
  computed,
  onWillStart,
  onWillUnmount,
  usePlugin,
  signal,
  useEffect,
  xml,
} from "@odoo/owl";
import { VERSION } from "./config.js";
import { ConfigPlugin } from "./config_plugin.js";
import { DialogPlugin } from "./dialog_plugin.js";
import { EventLogPlugin } from "./event_log_plugin.js";
import { CodePlugin } from "./code_plugin.js";
import { RouterPlugin } from "./router_plugin.js";
import { ServerPlugin } from "./server_plugin.js";
import { StorePlugin } from "./store_plugin.js";
import { WorkspacePlugin } from "./workspace_plugin.js";
import { UpdatePlugin } from "./update_plugin.js";
import { BranchesScreen } from "../branches_screen/branches.js";
import { DirtyMenu, ICONS, NAV, m, mergedTabIds } from "./common.js";
import { ConfigScreen } from "../config_screen/config.js";
import { DatabasesScreen } from "../databases_screen/databases.js";
import { EventLog } from "./event_log.js";
import { MemoryScreen } from "../memory_screen/memory.js";
import { ActionMenu, CiMenu, MbMenu } from "./menus.js";
import { NightlyScreen } from "../nightly_screen/nightly.js";
import { PrsScreen } from "../prs_screen/prs.js";
import { TerminalPanel } from "./terminal.js";
import { TodoScreen } from "../todo_screen/todo.js";
import { WorkspacesScreen } from "../workspaces_screen/workspaces.js";

export class Topbar extends Component {
  static template = xml`
    <header class="topbar">
      <div class="top-left">
        <div class="logo"><a class="name" href="https://github.com/ged-odoo/goo" target="_blank" title="GED Odoo Overseer — open on GitHub">goo</a><span class="version" t-out="this.version"/></div>
      </div>
      <div t-if="this.target" class="nav-target" t-att-class="this.stateClass" t-att-title="this.tooltip">
        <span class="nt-name">
          <span class="dot"/>
          <span class="t-name" t-out="this.target"/>
          <span class="nt-caret">▾</span>
        </span>
        <div class="nt-menu">
          <button t-foreach="this.mainWorkspaces" t-as="ws" t-key="ws.id" class="nt-item"
                  t-att-class="{active: ws.id === this.activeId}"
                  t-att-title="ws.id === this.activeId ? 'the loaded workspace' : 'stop the server, check out its branches and make it current'"
                  t-on-click="() => this.switchTo(ws)">
            <span class="nt-item-dot" t-att-class="{on: ws.id === this.activeId}"/>
            <span class="nt-item-name" t-out="ws.name"/>
          </button>
          <t t-if="this.runningWorktrees.length">
            <div class="nt-sep"/>
            <button t-foreach="this.runningWorktrees" t-as="wt" t-key="wt.id" class="nt-item"
                    title="worktree server — open it in the Workspaces screen"
                    t-on-click="() => this.openWorktree(wt.id)">
              <span class="nt-item-dot on wt"/>
              <span class="nt-item-name" t-out="wt.name"/>
              <span class="nt-item-port" t-out="':' + wt.port"/>
            </button>
          </t>
          <div class="nt-sep"/>
          <button class="nt-item nt-all" t-on-click="() => this.router.go('workspaces')">All workspaces →</button>
        </div>
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

  server = usePlugin(ServerPlugin);
  config = usePlugin(ConfigPlugin);
  eventLog = usePlugin(EventLogPlugin);
  code = usePlugin(CodePlugin); // activation guards read the live branch state
  store = usePlugin(StorePlugin); // running worktree servers for the switcher menu
  wt = usePlugin(WorkspacePlugin);
  router = usePlugin(RouterPlugin);
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

  get active() {
    const s = this.server.status().state;
    return s === "running" || s === "starting";
  }

  // the loaded workspace id: the running one while up, else the last-used one
  get activeId() {
    const s = this.server.status();
    return s.state === "running" || s.state === "starting"
      ? s.workspace
      : this.server.lastWorkspace();
  }

  // the loaded workspace's display name (dimmed when the server is stopped)
  get target() {
    const ws = (this.config.config.workspaces || []).find((w) => w.id === this.activeId);
    return ws ? ws.name : this.activeId || "";
  }

  // the switcher menu: every main-located workspace (they share the main checkout —
  // exactly the set "activate" can switch between), in the configured order
  get mainWorkspaces() {
    return (this.config.config.workspaces || []).filter((w) => w.location !== "worktree");
  }

  // worktree workspaces whose own server is up — quick jumps to their screen
  get runningWorktrees() {
    return (this.config.config.workspaces || [])
      .filter((w) => w.location === "worktree")
      .map((w) => ({ ...w, state: this.store.server(w.id)?.state }))
      .filter((w) => w.state === "running" || w.state === "starting")
      .map((w) => ({ ...w, port: this.store.server(w.id)?.port || w.port || "?" }));
  }

  // activate a main-located workspace from the menu: load the live branch state
  // first (the model's guard reads it — empty state would silently refuse), then
  // let the Workspace model do the guarded stop+checkout+set-current
  async switchTo(ws) {
    if (ws.id === this.activeId) return;
    await this.code.loadBranches(new Set((ws.checkouts || []).map((c) => c.repo)));
    await this.config.workspace(ws.id)?.activate();
  }

  openWorktree(id) {
    this.wt.selectOnOpen(id);
    this.router.go("workspaces");
  }

  get stateClass() {
    // displayState() is orange the moment Start is clicked, held through "starting"
    const s = this.server.displayState();
    return s === "running" ? "live" : s === "starting" ? "starting" : "idle";
  }

  get tooltip() {
    return this.active
      ? `loaded workspace (${this.server.status().state})`
      : "loaded workspace — server stopped";
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
    return { label: "Start", cls: "start", disabled: false, title: "start the loaded workspace" };
  }

  onToggle() {
    const s = this.server.status().state;
    if (s === "running" || s === "starting") this.server.stop();
    else if (s === "stopped") this.server.start(this.activeId);
  }
}

// ─────────────────────────── Sidebar ───────────────────────────

const SIDEBAR_COLLAPSED_KEY = "oo-sidebar-collapsed";

export class Sidebar extends Component {
  static template = xml`
    <nav class="sidebar" t-att-class="{collapsed: this.collapsed()}">
      <button t-foreach="this.nav" t-as="item" t-key="item.id" class="nav-item"
              t-att-class="{active: this.router.section() === item.id}"
              t-att-title="this.collapsed() ? item.label : ''"
              t-on-click="() => this.router.go(item.id)">
        <t t-out="this.icon(item.icon)"/>
        <span class="nav-label" t-out="item.label"/>
      </button>
      <div class="nav-spacer"/>
      <button t-if="this.updateAvailable" class="nav-item nav-update" t-att-title="this.updateTip"
              t-on-click="() => this.update.promptUpdate()">
        <span class="nav-update-glyph"><t t-out="this.updateIcon"/><span class="nav-update-bang">!</span></span>
        <span class="nav-label">Update goo</span>
      </button>
      <button class="nav-item nav-collapse" t-att-title="this.collapsed() ? 'Expand sidebar' : 'Collapse sidebar'"
              t-on-click="() => this.toggleCollapsed()">
        <t t-out="this.collapseIcon"/>
        <span class="nav-label">Collapse</span>
      </button>
    </nav>`;

  router = usePlugin(RouterPlugin);
  config = usePlugin(ConfigPlugin);
  update = usePlugin(UpdatePlugin);
  collapseIcon = m(ICONS.collapse);
  updateIcon = m(ICONS.push);
  collapsed = signal(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1");

  setup() {
    // reflect the collapse state on <html> so the --sidebar-width override cascades
    // to both the body grid and the topbar (which mirror the same column), and
    // persist it across reloads. owl3's useEffect tracks the body → reruns on toggle.
    useEffect(() => {
      const on = this.collapsed();
      document.documentElement.classList.toggle("sidebar-collapsed", on);
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, on ? "1" : "0");
    });
    onWillUnmount(() => document.documentElement.classList.remove("sidebar-collapsed"));
  }

  toggleCollapsed() {
    this.collapsed.set(!this.collapsed());
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
    return `${tip} — click to update goo`;
  }

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

export const SCREENS = {
  workspaces: WorkspacesScreen,
  branches: BranchesScreen,
  prs: PrsScreen,
  // back-compat: old #reviews bookmarks render the merged PRs screen, which opens
  // on its Reviewing segment (PrsScreen seeds its mode from the route)
  reviews: PrsScreen,
  todo: TodoScreen,
  databases: DatabasesScreen,
  nightly: NightlyScreen,
  memory: MemoryScreen,
  config: ConfigScreen,
};

export class App extends Component {
  static components = {
    Topbar,
    Sidebar,
    WorkspacesScreen,
    BranchesScreen,
    PrsScreen,
    TodoScreen,
    DatabasesScreen,
    NightlyScreen,
    MemoryScreen,
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

  dialogRoot = usePlugin(DialogPlugin).root;
  router = usePlugin(RouterPlugin);
  server = usePlugin(ServerPlugin);
  update = usePlugin(UpdatePlugin);
  // the active screen's component class (a class, not an instance)
  currentScreen = computed(() => SCREENS[this.router.section()] || WorkspacesScreen);
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
    await this.server.start(this.server.lastWorkspace());
    const ok = await this.server.waitUntilRunning();
    if (win && !win.closed) {
      if (ok) win.location.href = url;
      else win.close(); // server didn't come up (start error is surfaced separately)
    }
  }
}

// ─────────────────────────── helpers ───────────────────────────

// "community:master,enterprise:master" <-> [{repo, branch}, ...]
