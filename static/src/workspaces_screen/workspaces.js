import {
  Component,
  onMounted,
  onWillUnmount,
  usePlugin,
  signal,
  untrack,
  useEffect,
  xml,
} from "@odoo/owl";
import { CodePlugin } from "../core/code_plugin.js";
import { ConfigPlugin } from "../core/config_plugin.js";
import { DatabasePlugin } from "../core/database_plugin.js";
import { DialogPlugin } from "../core/dialog_plugin.js";
import { EventLogPlugin } from "../core/event_log_plugin.js";
import { ServerPlugin } from "../core/server_plugin.js";
import { StorePlugin } from "../core/store_plugin.js";
import { WorkspacePlugin } from "../core/workspace_plugin.js";
import { BASE_BRANCH_RE } from "../core/config.js";
import { ICONS, LogConsole, SearchBox, appBus, m, mbCategory } from "../core/common.js";
import { branchKey } from "../core/models.js";
import { repoBranchList, timeAgo, nestByParent } from "../core/utils.js";
import {
  ARCHIVED_CATEGORY,
  adoptCurrentCheckout,
  categoryOptions,
  deleteWorkspaceDialog,
  startCreateWorkspace,
  startNewWorkspaceWizard,
} from "./dialogs.js";
import { ClaudeChat } from "./claude_chat.js";
import { CodePane } from "./code_pane.js";
import { AddonsPane, AssetsPane, TerminalPane, TestsPane } from "./panes.js";
// ─────────────────────────── Workspaces screen ───────────────────────────

// The primary work surface: every workspace (main-located and worktree) in one
// searchable list; the selected one's detail — status, per-location server
// controls, and the Code / Server logs / Claude / Terminal tabs. A main-located
// workspace shares the primary checkout (one loaded at a time — Start loads it,
// i.e. checks out its branches, then starts the main server on :8069); a worktree
// workspace runs concurrently from its own checkout on its own stable port.

const WORKSPACE_ORDER_KEY = "goo-workspace-order";
const WORKSPACE_ORDER_OPTIONS = [
  { value: "config", label: "Configured order", short: "Configured" },
  { value: "name", label: "Name (A–Z)", short: "Name" },
  { value: "created", label: "Creation date (newest)", short: "Created" },
  { value: "recent", label: "Most recent activity", short: "Recent" },
  { value: "mergebot", label: "Mergebot (blocked first)", short: "Mergebot" },
];
const WORKSPACE_ORDERS = new Set(WORKSPACE_ORDER_OPTIONS.map((option) => option.value));

function savedWorkspaceOrder() {
  try {
    const value = localStorage.getItem(WORKSPACE_ORDER_KEY) || "config";
    return WORKSPACE_ORDERS.has(value) ? value : "config";
  } catch {
    return "config";
  }
}

// collapsed category groups (a browser-side view preference, like the ordering)
const WORKSPACE_COLLAPSED_KEY = "goo-workspace-collapsed-categories";

function savedCollapsedGroups() {
  try {
    const stored = JSON.parse(localStorage.getItem(WORKSPACE_COLLAPSED_KEY));
    return new Set(Array.isArray(stored) ? stored : []);
  } catch {
    return new Set();
  }
}

export class WorkspacesScreen extends Component {
  static components = {
    LogConsole,
    ClaudeChat,
    CodePane,
    TerminalPane,
    TestsPane,
    AddonsPane,
    AssetsPane,
    SearchBox,
  };

  static template = xml`
    <section>
      <div class="content wt-content">
        <div class="wt-list">
          <div class="wt-list-title">
            <h1>Workspaces</h1>
            <span class="wt-sp"/>
            <button class="wt-new" t-att-disabled="this.refreshingStatuses()" title="refresh every workspace's runbot / mergebot status" t-on-click="() => this.refreshStatuses()">
              <span t-if="this.refreshingStatuses()" class="wt-refresh-spin"/>
              <t t-else="" t-out="this.refreshIcon"/>
            </button>
            <button class="pbtn primary" title="New workspace — a bundle of branches, a database and a server" t-on-click="() => this.create()">Add</button>
          </div>
          <div class="wt-list-head">
            <SearchBox value="this.query"/>
          <div class="wt-order-wrap">
            <button class="wt-order" t-att-class="{open: this.orderMenuOpen()}" t-att-title="'order workspaces: ' + this.orderLabel" t-on-click.stop="() => this.orderMenuOpen.set(!this.orderMenuOpen())">
              <t t-out="this.sortIcon"/><span class="wt-order-caret">▾</span>
            </button>
            <div t-if="this.orderMenuOpen()" class="dash-menu wt-order-menu" t-on-click.stop="">
              <button t-foreach="this.orderOptions" t-as="option" t-key="option.value" class="dash-menu-item" t-att-class="{selected: option.value === this.order()}" t-on-click="() => this.chooseOrder(option.value)">
                <span class="wt-order-check"><t t-if="option.value === this.order()" t-out="this.checkIcon"/></span><t t-out="option.label"/>
              </button>
            </div>
          </div>
          </div>
          <div class="wt-list-items">
            <div t-if="!this.list.length" class="wt-empty dim">
              <t t-if="this.query()">No workspace matches.</t>
              <div t-else="" class="wt-empty-cta">
                <p>No workspaces yet.</p>
                <button class="pbtn primary" title="turn the branches currently checked out in your repos into a workspace — no form, one click" t-on-click="() => this.adoptCheckout()">Adopt current checkout</button>
                <button class="pbtn" t-on-click="() => this.create()">New workspace…</button>
              </div>
            </div>
            <div t-foreach="this.listGroups" t-as="grp" t-key="grp.id" class="wt-group">
              <button t-if="grp.name" class="wt-group-head" t-att-title="(this.isCollapsed(grp.id) ? 'expand' : 'collapse') + ' ' + grp.name" t-on-click="() => this.toggleGroup(grp.id)">
                <span class="wt-group-caret" t-att-class="{collapsed: this.isCollapsed(grp.id)}"/>
                <span class="wt-group-name" t-out="grp.name"/>
                <span class="wt-sp"/>
                <span class="wt-group-count" t-out="grp.items.length"/>
              </button>
              <t t-if="!grp.name || !this.isCollapsed(grp.id)">
                <div class="wt-group-items" t-att-class="{'with-header': !!grp.name}">
                  <button t-foreach="grp.items" t-as="row" t-key="row.ws.id" class="wt-item"
                          t-att-class="{selected: row.ws.id === this.wt.selectedId()}" t-on-click="() => this.wt.select(row.ws.id)"
                          t-att-style="'padding-left:' + (16 + row.depth * 16) + 'px'"
                          t-att-title="this.branchOf(row.ws) + ' · ' + (row.ws.db || '') + (this.isDrifted(row.ws) ? ' · checkout drifted' : '')">
                    <span class="wt-dot" t-att-class="this.listDotClass(row.ws)"/>
                    <span class="wt-item-name" t-out="row.ws.name"/>
                    <span t-if="this.isDrifted(row.ws)" class="wt-badge wt-badge-drift" title="checkout drifted — the main checkout no longer matches this workspace">drift</span>
                    <span t-if="this.isWt(row.ws)" class="wt-badge" title="worktree workspace">wt</span>
                    <span class="wt-sp"/>
                    <span class="wt-status-dot" t-att-class="this.ciDotClass(row.ws)" t-att-title="this.ciDotTitle(row.ws)"/>
                    <span class="wt-status-dot" t-att-class="this.mbDotClass(row.ws)" t-att-title="this.mbDotTitle(row.ws)"/>
                  </button>
                </div>
              </t>
            </div>
          </div>
        </div>
        <div class="wt-detail">
          <t t-if="this.sel">
            <div class="wt-detail-top">
            <div class="wt-detail-name" t-att-title="this.sel.name + ' — double-click to edit'"
                 t-on-dblclick="() => this.edit(this.sel)" t-out="this.sel.name"/>
            <div class="wt-detail-head">
              <div class="wt-head-row">
                <!-- one primary slot: a main-located workspace that isn't loaded offers
                     Activate (check out its branches first); once loaded — and always
                     for worktrees — the slot is the Start/Stop toggle -->
                <button t-if="!this.isWt(this.sel) and !this.isLoaded(this.sel)" class="pbtn primary wt-lifecycle-btn" t-att-disabled="!this.canActivate(this.sel)" t-att-title="this.activateTitle(this.sel)" t-on-click="() => this.activate(this.sel)">Activate</button>
                <t t-else="">
                  <button t-if="!this.isLive(this.sel)" class="pbtn primary wt-lifecycle-btn" t-att-disabled="!this.canStart(this.sel)" t-att-title="this.startTitle(this.sel)" t-on-click="() => this.start(this.sel)"><span class="play"/><t t-out="this.startLabel"/></button>
                  <button t-else="" class="pbtn stop wt-lifecycle-btn" t-on-click="() => this.stop(this.sel)"><span class="ic square"/>Stop</button>
                </t>
                <button class="pbtn ghost ws-refresh" t-att-disabled="this.code.loading()" t-att-title="this.workspaceRefreshTitle(this.sel)" t-on-click="() => this.refreshWorkspace(this.sel)">
                  <span t-if="this.code.loading()" class="ws-refresh-spin"/>Refresh
                </button>
                <t t-set="ci" t-value="this.wsCiStatus(this.sel)"/>
                <t t-if="ci">
                  <t t-set="rbUrl" t-value="this.runbotUrl(this.sel)"/>
                  <a t-if="rbUrl" class="dash-ci" t-att-class="ci.cls" target="_blank" t-att-href="rbUrl" t-att-title="ci.checks ? '' : ('runbot: ' + ci.title)" t-on-mouseenter="(ev) => this.showCiMenu(ev, ci.checks)" t-on-mouseleave="() => this.hideCiMenu()">
                    <span class="dash-ci-dot"/><t t-out="ci.label"/>
                    <span t-if="ci.running" class="dash-ci-run" title="some checks still running"/>
                  </a>
                  <span t-else="" class="dash-ci" t-att-class="ci.cls" t-att-title="ci.checks ? '' : ('runbot: ' + ci.title)" t-on-mouseenter="(ev) => this.showCiMenu(ev, ci.checks)" t-on-mouseleave="() => this.hideCiMenu()">
                    <span class="dash-ci-dot"/><t t-out="ci.label"/>
                    <span t-if="ci.running" class="dash-ci-run" title="some checks still running"/>
                  </span>
                </t>
                <t t-set="mb" t-value="this.mbStatus(this.sel)"/>
                <a t-if="mb" class="dash-ci dash-mb" t-att-class="mb.cls" target="_blank" t-att-href="mb.url" t-on-mouseenter="(ev) => this.showMbMenu(ev, mb.rows)" t-on-mouseleave="() => this.hideMbMenu()">
                  <span class="dash-ci-dot"/><t t-out="mb.label"/>
                </a>
                <span t-if="this.stateOf(this.sel) !== 'stopped'" class="wt-state" t-att-class="this.dotClass(this.sel)" t-out="this.stateOf(this.sel)"/>
                <span class="wt-sp"/>
                <button t-if="this.isWt(this.sel)" class="pbtn ghost" t-att-disabled="!this.isRunning" title="open /odoo (autologin)" t-on-click="() => this.openWorkspaceUrl(this.sel, this.odooUrl(this.sel))"><t t-out="this.externalIcon"/>/odoo</button>
                <button t-if="this.isWt(this.sel)" class="pbtn ghost" t-att-disabled="!this.isRunning" title="open /web/tests (autologin)" t-on-click="() => this.openWorkspaceUrl(this.sel, this.testsUrl(this.sel))"><t t-out="this.externalIcon"/>/web/tests</button>
                <span class="wt-head-meta" t-att-title="this.sel.db || 'no database'"><t t-out="this.databaseIcon"/><b t-out="this.sel.db || '—'"/></span>
                <span t-if="this.portOf(this.sel)" class="wt-head-meta wt-head-port">port <b t-out="this.portOf(this.sel)"/></span>
                <div class="dash-kebab-wrap">
                  <button class="dash-kebab" t-att-class="{open: this.menuOpen()}" title="more actions" t-on-click.stop="() => this.menuOpen.set(!this.menuOpen())"><t t-out="this.kebabIcon"/></button>
                  <div t-if="this.menuOpen()" class="dash-menu" t-on-click.stop="">
                    <button class="dash-menu-item" title="edit name / branches / database / args" t-on-click="() => this.headMenu(() => this.edit(this.sel))">Edit workspace…</button>
                    <button class="dash-menu-item" t-att-title="this.isArchived(this.sel) ? 'move it back to uncategorized' : 'move it to the archived group (keeps branches, db and settings)'" t-on-click="() => this.headMenu(() => this.toggleArchived(this.sel))" t-out="this.isArchived(this.sel) ? 'Unarchive workspace' : 'Archive workspace'"/>
                    <button class="dash-menu-item danger" t-att-disabled="!this.canDropDb(this.sel)" t-att-title="this.dropDbTitle(this.sel)" t-on-click="() => this.headMenu(() => this.dropDb(this.sel))">Drop database</button>
                    <button class="dash-menu-item danger" t-att-disabled="this.removeBlocked(this.sel)" t-att-title="this.removeTitle(this.sel)" t-on-click="() => this.headMenu(() => this.remove(this.sel))">Remove workspace</button>
                  </div>
                </div>
              </div>
            </div>
            <div class="wt-tabs">
                <button class="wt-tab" t-att-class="{on: this.pane() === 'code'}" t-on-click="() => this.pane.set('code')"><t t-out="this.icons.code"/>Main</button>
                <button class="wt-tab" t-att-class="{on: this.pane() === 'log'}" t-on-click="() => this.pane.set('log')"><t t-out="this.icons.journal"/>Server logs</button>
                <button class="wt-tab" t-att-class="{on: this.pane() === 'tests'}" t-on-click="() => this.pane.set('tests')"><t t-out="this.icons.tests"/>Tests</button>
                <button class="wt-tab" t-att-class="{on: this.pane() === 'addons'}" t-on-click="() => this.pane.set('addons')"><t t-out="this.icons.addons"/>Addons</button>
                <button class="wt-tab" t-att-class="{on: this.pane() === 'assets'}" t-on-click="() => this.pane.set('assets')"><t t-out="this.icons.assets"/>Assets</button>
                <button class="wt-tab" t-att-class="{on: this.pane() === 'claude'}" t-on-click="() => this.pane.set('claude')"><t t-out="this.icons.claude"/>Claude</button>
                <button class="wt-tab" t-att-class="{on: this.pane() === 'terminal'}" t-on-click="() => this.openTerminalPane(this.sel)"><t t-out="this.icons.terminal"/>Terminal</button>
                <button class="wt-tab" t-att-class="{on: this.pane() === 'details'}" t-on-click="() => this.pane.set('details')"><t t-out="this.icons.info"/>Details</button>
              </div>
            </div>
            <div class="wt-panes">
              <div class="wt-pane ws-code-pane" t-if="this.pane() === 'code'">
                <div t-if="this.isDrifted(this.sel)" class="ws-drift-strip">
                  <span class="ws-drift-text">checkout drift: <t t-out="this.driftText(this.sel)"/></span>
                  <span class="wt-sp"/>
                  <button class="pbtn" t-att-disabled="!!this.restoreBlocked(this.sel)" t-att-title="this.restoreTitle(this.sel)" t-on-click="() => this.restore(this.sel)">Restore branches</button>
                  <t t-set="adopt" t-value="this.adoptTarget(this.sel)"/>
                  <button t-if="adopt" class="pbtn" t-att-title="'the current checkout matches ' + adopt.name + ' — make it the loaded workspace instead'" t-on-click="() => this.switchToMatch(adopt)" t-out="'Switch to ' + adopt.name"/>
                  <button t-else="" class="pbtn" title="the terminal detour is the new truth — rewrite this workspace's branches to what is actually checked out" t-on-click="() => this.adopt(this.sel)">Adopt current branches</button>
                  <button class="pbtn" title="keep this workspace as is and save the currently checked-out branches as a new workspace" t-on-click="() => this.saveDriftAsWorkspace(this.sel)">Save as new workspace…</button>
                </div>
                <CodePane t-key="this.sel.id" ws="this.sel"/>
              </div>
              <div class="wt-pane" t-elif="this.pane() === 'log'">
                <t t-if="this.isWt(this.sel)">
                  <LogConsole t-key="this.sel.id" title="'Server log'" buffer="this.wt.logBuffer(this.sel.id)" bare="true"/>
                </t>
                <t t-elif="this.isLoaded(this.sel)">
                  <LogConsole t-key="this.sel.id" title="'Server log'" buffer="this.server.output" bare="true"/>
                </t>
                <div t-else="" class="ws-pane-hint dim">This workspace isn't loaded — Start it to see its server log.</div>
              </div>
              <div class="wt-pane" t-elif="this.pane() === 'tests'">
                <TestsPane t-if="this.canRunHere(this.sel)" t-key="this.sel.id" ws="this.sel"/>
                <div t-else="" class="ws-pane-hint dim" t-out="this.runHint(this.sel, 'This workspace is not loaded — Start it first to run tests against its database and checkout.')"/>
              </div>
              <div class="wt-pane" t-elif="this.pane() === 'addons'">
                <AddonsPane t-if="this.canRunHere(this.sel)" t-key="this.sel.id" ws="this.sel"/>
                <div t-else="" class="ws-pane-hint dim" t-out="this.runHint(this.sel, 'This workspace is not loaded — Start it first to browse and install its modules.')"/>
              </div>
              <div class="wt-pane" t-elif="this.pane() === 'assets'">
                <AssetsPane t-if="this.sel.db" t-key="this.sel.id" ws="this.sel"/>
                <div t-else="" class="ws-pane-hint dim">This workspace has no database.</div>
              </div>
              <div class="wt-pane" t-elif="this.pane() === 'claude'">
                <ClaudeChat t-if="this.canRunHere(this.sel)" t-key="this.sel.id" target="this.sel" inMain="!this.isWt(this.sel)"/>
                <div t-else="" class="ws-pane-hint dim" t-out="this.runHint(this.sel, 'This workspace is not loaded — load it first, or use a worktree workspace to let Claude work in isolation.')"/>
              </div>
              <div class="wt-pane" t-elif="this.pane() === 'terminal'">
                <TerminalPane t-if="this.termUrl" t-key="this.sel.id" url="this.termUrl"/>
                <div t-else="" class="ws-pane-hint dim" t-out="this.termHint"/>
              </div>
              <div class="wt-pane ws-details-pane" t-elif="this.pane() === 'details'" t-key="this.sel.id">
                <div class="ws-details-grid">
                  <span class="dim">Created</span>
                  <span t-out="this.fmtWhen(this.sel.created_at)"/>
                  <span class="dim">Last activity</span>
                  <span t-out="this.fmtWhen(this.sel.last_activity)"/>
                </div>
                <label class="ws-notes-label dim" for="ws-notes">Notes</label>
                <textarea id="ws-notes" class="ws-notes" placeholder="Anything worth remembering about this workspace — context, findings, next steps…"
                          t-att-value="this.sel.notes || ''"
                          t-on-change="ev => this.config.workspace(this.sel.id)?.setNotes(ev.target.value)"/>
              </div>
            </div>
          </t>
          <div t-else="" class="wt-detail-empty dim">Select a workspace on the left, or create one.</div>
        </div>
      </div>
    </section>`;

  wt = usePlugin(WorkspacePlugin);
  config = usePlugin(ConfigPlugin);
  code = usePlugin(CodePlugin);
  db = usePlugin(DatabasePlugin);
  dialogs = usePlugin(DialogPlugin);
  eventLog = usePlugin(EventLogPlugin);
  server = usePlugin(ServerPlugin);
  store = usePlugin(StorePlugin);
  externalIcon = m(ICONS.external);
  databaseIcon = m(ICONS.databases);
  kebabIcon = m(ICONS.kebab);
  sortIcon = m(ICONS.sort);
  checkIcon = m(ICONS.check);
  refreshIcon = m(ICONS.refresh);
  refreshingStatuses = signal(false); // the list's status-refresh spinner
  orderOptions = WORKSPACE_ORDER_OPTIONS;
  icons = {
    code: m(ICONS.code),
    journal: m(ICONS.journal),
    tests: m(ICONS.tests),
    addons: m(ICONS.addons),
    assets: m(ICONS.assets),
    claude: m(ICONS.claude),
    terminal: m(ICONS.terminal),
    info: m(ICONS.info),
  };

  // which detail pane is shown: code | log | tests | addons | assets | claude | terminal
  pane = signal("code");
  query = signal(""); // the list search
  order = signal(savedWorkspaceOrder()); // config | name | created | recent | mergebot
  orderMenuOpen = signal(false);
  menuOpen = signal(false); // the header's Edit/Remove overflow menu
  collapsedGroups = signal(savedCollapsedGroups()); // collapsed category ids

  setup() {
    this.db.load(); // cache-aware; warms the clone-source list for the create dialog
    // close the header overflow menu on any outside click
    const closeMenu = () => {
      if (this.menuOpen()) this.menuOpen.set(false);
      if (this.orderMenuOpen()) this.orderMenuOpen.set(false);
    };
    onMounted(() => document.addEventListener("click", closeMenu));
    onWillUnmount(() => document.removeEventListener("click", closeMenu));
    // An explicit cross-screen jump wins once; an ordinary return starts on the
    // first workspace in the user's saved ordering rather than reviving the last
    // selection from a previous visit.
    const requested = this.wt.requestedSelection();
    const selected = requested && this.list.find((ws) => ws.id === requested);
    const first = selected || this.list[0];
    if (first) this.wt.select(first.id);
    this.wt.requestedSelection.set("");
    // A jump can target Workspaces while this screen is already mounted (setting
    // the same hash does not remount it). Consume that request reactively too so
    // it cannot leak into the next ordinary visit.
    useEffect(() => {
      const id = this.wt.requestedSelection();
      if (!id) return;
      if (this.list.some((ws) => ws.id === id)) this.wt.select(id);
      this.wt.requestedSelection.set("");
    });
    // Load the selected workspace's code state (drives the Start guard, checkout
    // badges and Code pane), keyed by the selection + its repo set. The effect
    // tracks `this.sel` — i.e. the config records — so it re-runs on EVERY config
    // write, including ones that change nothing here: an activity timestamp (each
    // test run touches it) or another tab's edit echoed over SSE (applyBroadcast
    // rebuilds all records). Without the key guard each of those re-runs called
    // loadWorkspace, and once its 10-minute freshness lapsed every config write
    // re-scanned git in every open tab (see the `loadedIds` pattern below).
    // Keep the loader itself untracked: it reads and then rewrites the shared store.
    let loadedWsKey = "";
    useEffect(() => {
      const ws = this.sel;
      if (!ws) return;
      const ids = new Set((ws.checkouts || []).map((c) => c.repo));
      const key = `${ws.id}:${[...ids].sort().join(",")}`;
      if (!ids.size || key === loadedWsKey) return;
      loadedWsKey = key;
      untrack(() => this.code.loadWorkspace(ws.id, ids));
    });
    // consume the event log's one-shot pane request (its [jump] selects the
    // workspace and sets this before navigating here — the plugin holds it so it
    // survives this screen not being mounted at dispatch time)
    useEffect(() => {
      const pane = this.wt.requestedPane();
      if (!pane) return;
      this.pane.set(pane);
      this.wt.requestedPane.set(""); // one re-run with "" then settles
    });
    // badge data for the whole list, in two effects with different loop-safety.
    //
    // (1) PRs + branches for every workspace's repos. code.load() may NOT be
    // tracked by the effect: it rewrites branchRepos/groups (git reads are
    // volatile — every load yields fresh objects), so tracking its internal reads
    // would re-trigger the effect forever. The body therefore only tracks the
    // config read (_listRepoIds), guards on the repo-set key so unrelated config
    // touches don't reload, and untracks the load() call itself.
    let loadedIds = "";
    useEffect(() => {
      const ids = this._listRepoIds();
      const key = [...ids].sort().join(",");
      if (!ids.size || key === loadedIds) return;
      loadedIds = key;
      untrack(() => this.code.load(false, ids, ids));
    });
    // (2) runbot (bundle branches without a PR CI rollup) + mergebot (their PRs)
    // — body-tracked so it re-runs as branches/PRs stream in. Safe: both loaders
    // dedup against what's already held/in-flight (CodePlugin's `have` pattern), so
    // once everything is fetched they no-op and the effect settles.
    useEffect(() => {
      const branches = this._runbotBranches();
      if (branches.length) this.code.loadRunbot(branches);
      const prs = this._prs();
      if (prs.length) this.code.loadMergebot(prs);
    });
  }

  // every repo referenced by any workspace's checkouts (for the list-wide load)
  _listRepoIds() {
    const ids = new Set();
    for (const ws of this.config.config.workspaces || [])
      for (const c of ws.checkouts || []) ids.add(c.repo);
    return ids;
  }

  // Force-refresh only the selected workspace's repositories and widen the
  // one-shot runbot/mergebot scope to its configured + currently checked-out
  // branches. This is the same targeted refresh formerly owned by CodePane.
  refreshWorkspace(ws) {
    const ids = new Set((ws.checkouts || []).map((c) => c.repo));
    if (!ids.size) return;
    return this.code.loadWorkspace(ws.id, ids, true, this._workspaceStatusScope(ws));
  }

  _workspaceStatusScope(ws) {
    const byId = Object.fromEntries(this.code.branchRepos().map((r) => [r.id, r]));
    const groups = this.code.groups();
    const branches = new Set();
    const prs = new Set();
    for (const c of ws.checkouts || []) {
      const github = groups.githubByRepo[c.repo] || "";
      if (this.code.isExternalRepo(github)) continue;
      for (const branch of new Set([c.branch, byId[c.repo]?.current].filter(Boolean))) {
        branches.add(branch);
        const pr = groups.prIndex[branchKey(c.repo, branch)];
        if (pr && github) prs.add(`${github}#${pr.number}`);
      }
    }
    return { branches, prs };
  }

  workspaceRefreshTitle(ws) {
    const ids = new Set((ws.checkouts || []).map((c) => c.repo));
    const at = this.code.workspaceRefreshedAt(ids);
    const last = at ? timeAgo(new Date(at).toISOString()) : "never";
    return `refresh branches + pull requests · last refreshed ${last}`;
  }

  // ── list badges (runbot/CI + mergebot), scoped to a workspace's checkouts ────
  // one row per checkout with its local + remote/PR state
  wsRows(ws) {
    const repos = this.repoMap;
    const groups = this.code.groups();
    return (ws.checkouts || []).map(({ repo, branch }) => {
      const r = repos[repo];
      const b = r && r.branches.get(branch);
      return {
        repo,
        branch,
        github: groups.githubByRepo[repo] || "",
        present: !!b,
        synced: !!b && b.synced, // local tip matches the remote ref (has a real bundle)
        pr: groups.prIndex[branchKey(repo, branch)] || null,
      };
    });
  }

  // branches needing the scraped runbot fallback: present, ours, pushed (or a base
  // branch), and not already covered by a PR's GitHub CI rollup
  _runbotBranches() {
    const seen = new Set();
    for (const ws of this.config.config.workspaces || []) {
      if (ws.category === ARCHIVED_CATEGORY) continue; // dormant — don't poll
      for (const row of this.wsRows(ws)) {
        if (!row.present || this.code.isExternalRepo(row.github)) continue;
        if (!BASE_BRANCH_RE.test(row.branch) && !row.synced) continue;
        const ci = row.pr && row.pr.ci;
        if (ci && ci.checks && ci.checks.length) continue;
        seen.add(row.branch);
      }
    }
    return [...seen];
  }

  // the unique {github, number} of every PR across the list (for mergebot),
  // skipping archived workspaces (dormant — don't poll)
  _prs() {
    const seen = new Set();
    const prs = [];
    for (const ws of this.config.config.workspaces || []) {
      if (ws.category === ARCHIVED_CATEGORY) continue;
      for (const row of this.wsRows(ws)) {
        if (!row.pr || !row.github || this.code.isExternalRepo(row.github)) continue;
        const key = `${row.github}#${row.pr.number}`;
        if (seen.has(key)) continue;
        seen.add(key);
        prs.push({ github: row.github, number: row.pr.number });
      }
    }
    return prs;
  }

  // the list header's ⟳: force-refresh every workspace's runbot/mergebot status,
  // spinning until both re-scrapes land (badges stay visible, update in place)
  async refreshStatuses() {
    if (this.refreshingStatuses()) return;
    this.refreshingStatuses.set(true);
    try {
      await this.code.refreshStatuses(this._runbotBranches(), this._prs());
    } finally {
      this.refreshingStatuses.set(false);
    }
  }

  // a bundle is per branch name (shared across a workspace's repos): prefer the
  // feature (non-base) branch, else the base
  bundleBranch(ws) {
    const branches = (ws.checkouts || []).map((c) => c.branch).filter(Boolean);
    return branches.find((b) => !BASE_BRANCH_RE.test(b)) || branches[0] || "";
  }

  // the present row representing the workspace's bundle (bundle-branch row, else the
  // first present one) — drives the single CI badge
  bundleRow(ws) {
    const present = this.wsRows(ws).filter((r) => r.present);
    const branch = this.bundleBranch(ws);
    return present.find((r) => r.branch === branch) || present[0] || null;
  }

  // the workspace's runbot/CI badge. Prefers the PR's GitHub CI rollup; falls back
  // to the scraped runbot bundle.
  wsCiStatus(ws) {
    const row = this.bundleRow(ws);
    if (!row) return null;
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
      badge.running = pending && (ci.overall === "success" || ci.overall === "failure");
      badge.checks = ci.checks;
      return badge;
    }
    // fallback: scraped runbot bundle status
    const s = this.code.runbot()[row.branch] || null;
    const result = (s && s.result) || "";
    const running = !!(s && s.running);
    let badge;
    if (result === "success") badge = { cls: "pass", label: "ok", title: "passing" };
    else if (result === "failure") badge = { cls: "fail", label: "ko", title: "failing" };
    else if (running) badge = { cls: "run", label: "running", title: "running" };
    else badge = { cls: "unknown", label: "—", title: "unknown" };
    badge.running = running && !!result;
    if (badge.running) badge.title += " — still running";
    return badge;
  }

  // aggregate mergebot status for a workspace: the most-blocking state across its PRs
  // that have a scraped state. The rows drive the per-repository hover breakdown.
  mbStatus(ws) {
    const rows = [];
    const RANK = { blocked: 0, progress: 1, ready: 2, merged: 3, other: 4 };
    for (const row of this.wsRows(ws)) {
      if (!row.pr || !row.github) continue;
      const state = this.code.mergebot()[`${row.github}#${row.pr.number}`] || "";
      if (!state) continue;
      rows.push({
        repo: row.repo,
        state,
        detail: this.code.mbDetails()[`${row.github}#${row.pr.number}`] || "",
        cls: mbCategory(state),
        url: this.code.mergebotUrl(row.github, row.pr.number),
      });
    }
    if (!rows.length) return null;
    const worst = rows.reduce((a, b) => (RANK[a.cls] <= RANK[b.cls] ? a : b));
    return { cls: worst.cls, label: worst.state, url: rows[0].url, rows };
  }

  runbotUrl(ws) {
    const branch = this.bundleBranch(ws);
    const scraped = branch && this.code.runbot()[branch]?.url;
    if (scraped) return scraped;
    const checks = this.bundleRow(ws)?.pr?.ci?.checks || [];
    return checks.find((c) => c.context === "ci/runbot")?.url || "";
  }

  showCiMenu(ev, checks) {
    if (!checks || !checks.length) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    appBus.dispatchEvent(new CustomEvent("ci-menu", { detail: { rect, checks } }));
  }

  hideCiMenu() {
    appBus.dispatchEvent(new CustomEvent("ci-menu-hide"));
  }

  showMbMenu(ev, rows) {
    if (!rows || !rows.length) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    appBus.dispatchEvent(new CustomEvent("mb-menu", { detail: { rect, rows } }));
  }

  hideMbMenu() {
    appBus.dispatchEvent(new CustomEvent("mb-menu-hide"));
  }

  // the two trailing status dots: a colour class per status (empty = neutral/unknown)
  ciDotClass(ws) {
    const s = this.wsCiStatus(ws);
    return s ? "s-" + s.cls : "";
  }

  mbDotClass(ws) {
    const s = this.mbStatus(ws);
    return s ? "s-" + s.cls : "";
  }

  ciDotTitle(ws) {
    const s = this.wsCiStatus(ws);
    return s ? "runbot: " + s.title : "runbot: no status";
  }

  mbDotTitle(ws) {
    const s = this.mbStatus(ws);
    return s ? "mergebot: " + s.label : "mergebot: no status";
  }

  // ── list / selection ─────────────────────────────────────────────────────────
  setOrder(value) {
    value = WORKSPACE_ORDERS.has(value) ? value : "config";
    this.order.set(value);
    try {
      localStorage.setItem(WORKSPACE_ORDER_KEY, value);
    } catch {
      /* browser storage can be disabled; the in-memory preference still works */
    }
  }

  chooseOrder(value) {
    this.setOrder(value);
    this.orderMenuOpen.set(false);
    const first = this.list[0];
    if (first) this.wt.select(first.id);
  }

  get orderLabel() {
    return (
      WORKSPACE_ORDER_OPTIONS.find((option) => option.value === this.order())?.short || "Order"
    );
  }

  // reads the canonical `workspaces` array — it carries `location` and the stable
  // `port` (the legacy `targets` view drops both by design)
  get list() {
    const all = this.config.config.workspaces || []; // every workspace, config order
    const q = this.query().trim().toLowerCase();
    const rows = (
      q
        ? all.filter((ws) =>
            `${ws.name} ${this.branchOf(ws)} ${ws.db || ""}`.toLowerCase().includes(q),
          )
        : all
    ).map((ws, index) => ({ ws, index }));
    const order = this.order();
    if (order === "name") {
      rows.sort(
        (a, b) =>
          a.ws.name.localeCompare(b.ws.name, undefined, { numeric: true, sensitivity: "base" }) ||
          a.index - b.index,
      );
    } else if (order === "created" || order === "recent") {
      const field = order === "created" ? "created_at" : "last_activity";
      rows.sort((a, b) => {
        const aTime = Date.parse(a.ws[field] || a.ws.created_at || "") || 0;
        const bTime = Date.parse(b.ws[field] || b.ws.created_at || "") || 0;
        return bTime - aTime || a.index - b.index;
      });
    } else if (order === "mergebot") {
      const rank = { blocked: 0, progress: 1, ready: 2, merged: 3, other: 4 };
      const statusRank = new Map(rows.map(({ ws }) => [ws.id, rank[this.mbStatus(ws)?.cls] ?? 5]));
      rows.sort((a, b) => statusRank.get(a.ws.id) - statusRank.get(b.ws.id) || a.index - b.index);
    }
    return rows.map(({ ws }) => ws);
  }

  get categoriesEnabled() {
    return !!this.config.config.workspace_categories_enabled;
  }

  // the list partitioned into category groups (config order, uncategorized last),
  // preserving the chosen sort within each group. With categories disabled, one
  // anonymous group — the template renders a header only for named groups.
  // "archived" is reserved: its group always renders last (after uncategorized),
  // and — unlike the other categories — even when categories are disabled.
  get listGroups() {
    const list = this.list;
    const archived = list.filter((ws) => ws.category === ARCHIVED_CATEGORY);
    const active = list.filter((ws) => ws.category !== ARCHIVED_CATEGORY);
    let groups;
    if (!this.categoriesEnabled) {
      groups = [{ id: "", name: "", items: active }];
    } else {
      const cats = (this.config.config.workspace_categories || [])
        .map((c) => c.id)
        .filter((c) => c !== ARCHIVED_CATEGORY); // reserved — never in config order
      const byCat = new Map(cats.map((c) => [c, []]));
      const rest = []; // no category, or one that was removed from the list
      for (const ws of active) {
        if (byCat.has(ws.category)) byCat.get(ws.category).push(ws);
        else rest.push(ws);
      }
      groups = cats.map((c) => ({ id: c, name: c, items: byCat.get(c) }));
      if (rest.length) groups.push({ id: "\0none", name: "uncategorized", items: rest });
    }
    if (archived.length)
      groups.push({ id: ARCHIVED_CATEGORY, name: ARCHIVED_CATEGORY, items: archived });
    // nest each group's items so a child sits directly below its parent, indented —
    // an item whose parent isn't in this same group renders flat (depth 0), never dropped
    return groups
      .filter((g) => g.items.length)
      .map((g) => ({ ...g, items: nestByParent(g.items) }));
  }

  isArchived(ws) {
    return ws.category === ARCHIVED_CATEGORY;
  }

  // shelve / restore: archived workspaces keep everything (branches, db, server
  // config) — they just live in the always-last "archived" group and are skipped
  // by the list's runbot/mergebot polling. Unarchive returns to uncategorized.
  toggleArchived(ws) {
    this.config.workspace(ws.id)?.setCategory(this.isArchived(ws) ? "" : ARCHIVED_CATEGORY);
  }

  isCollapsed(id) {
    return this.collapsedGroups().has(id);
  }

  toggleGroup(id) {
    const next = new Set(this.collapsedGroups());
    if (!next.delete(id)) next.add(id);
    this.collapsedGroups.set(next);
    try {
      localStorage.setItem(WORKSPACE_COLLAPSED_KEY, JSON.stringify([...next]));
    } catch {
      /* browser storage can be disabled; the in-memory preference still works */
    }
  }

  get sel() {
    return (this.config.config.workspaces || []).find((w) => w.id === this.wt.selectedId()) || null;
  }

  isWt(ws) {
    return ws.location === "worktree";
  }

  branchOf(ws) {
    return (ws.checkouts && ws.checkouts[0] && ws.checkouts[0].branch) || "";
  }

  // Details tab timestamps: absolute local date-time + relative ("2 days ago")
  fmtWhen(ts) {
    const t = Date.parse(ts || "");
    if (!t) return "—";
    const abs = new Date(t).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    return `${abs} · ${timeAgo(ts)}`;
  }

  // ── per-location server state ────────────────────────────────────────────────
  // the workspace occupying the main checkout: the running main server's, else the
  // last activated one (a browser-side fact — see targets_screen isActive)
  get activeId() {
    return this.server.loadedWorkspaceId();
  }

  isLoaded(ws) {
    return !this.isWt(ws) && ws.id === this.activeId;
  }

  // ── checkout drift (intent vs reality, loaded main-located workspaces only) ──
  // the loaded workspace claims the main checkout; a manual `git checkout` in a
  // terminal silently breaks that claim. driftOf lists the mismatched checkouts.
  driftOf(ws) {
    return this.isLoaded(ws) ? this.store.drift(ws) : [];
  }

  isDrifted(ws) {
    return this.driftOf(ws).length > 0;
  }

  driftText(ws) {
    return this.driftOf(ws)
      .map((c) => `${c.repo} is on ${c.current || "?"}, expected ${c.branch}`)
      .join(" · ");
  }

  // whether runs (tests/addons) and Claude can act on this workspace here: a
  // worktree always (its own checkout), a main-located one only when loaded AND
  // not drifted — running against code that isn't the workspace's would mislead
  canRunHere(ws) {
    return this.isWt(ws) || (this.isLoaded(ws) && !this.isDrifted(ws));
  }

  // the hint shown in a gated pane (tests / addons / claude) when it can't run here
  runHint(ws, hint) {
    if (this.isDrifted(ws))
      return "The main checkout no longer matches this workspace — Restore its branches first (see the drift banner on the Code tab).";
    return hint;
  }

  // serverFor: the main slot when it runs this workspace, else its own entry
  stateOf(ws) {
    return this.store.serverFor(ws)?.state || "stopped";
  }

  portOf(ws) {
    if (this.isWt(ws)) return this.wt.port(ws) || ws.port || null;
    return this.stateOf(ws) !== "stopped" ? 8069 : null;
  }

  dotClass(ws) {
    return "wt-dot-" + this.stateOf(ws);
  }

  // the list-row dot: a starting/running server keeps its live colour; a
  // worktree workspace or the loaded (active) one gets a solid black dot, and any
  // other (stopped, inactive) workspace stays faint. Checkout drift no longer
  // recolours the dot — it surfaces as a "drift" badge next to the name instead.
  listDotClass(ws) {
    if (this.isLive(ws)) return this.dotClass(ws);
    if (this.isWt(ws) || this.isLoaded(ws)) return "wt-dot-active";
    return this.dotClass(ws);
  }

  isLive(ws) {
    const s = this.stateOf(ws);
    return s === "running" || s === "starting";
  }

  get isRunning() {
    return !!this.sel && this.stateOf(this.sel) === "running";
  }

  get startLabel() {
    return this.sel && this.stateOf(this.sel) === "starting" ? "Starting…" : "Start";
  }

  // repo id -> { current, dirty, branches } from the live git state (Start guard)
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

  // why Start is blocked for a main-located workspace ("" = it can start). The
  // loaded workspace can always (re)start; switching to another one requires all
  // its branches locally + clean working trees (activate() silently no-ops else).
  _startBlocked(ws) {
    if (this.isLive(ws)) return "already running";
    if (this.isDrifted(ws))
      return "the main checkout drifted away from this workspace — Restore its branches first";
    if (this.isWt(ws) || this.isLoaded(ws)) return "";
    const repos = this.repoMap;
    const cos = ws.checkouts || [];
    if (!cos.every(({ repo, branch }) => repos[repo]?.branches.has(branch)))
      return "some of this workspace's branches are missing locally";
    if (cos.some(({ repo }) => repos[repo]?.dirty))
      return "commit or stash changes first — the working tree is dirty";
    return "";
  }

  canStart(ws) {
    return !this._startBlocked(ws);
  }

  startTitle(ws) {
    const blocked = this._startBlocked(ws);
    if (blocked) return blocked;
    if (this.isWt(ws)) return "start this workspace's server on its own port";
    return this.isLoaded(ws)
      ? "start the main server"
      : "load this workspace (check out its branches) and start the main server";
  }

  // ── activation (load without starting) ───────────────────────────────────────
  // main-located only: check out this workspace's branches + make it the loaded
  // workspace, without starting the main server. Blocked for the same reasons a
  // cold Start is (missing/dirty branches), and a no-op once it's the loaded one.
  _activateBlocked(ws) {
    if (this.isWt(ws)) return "worktree workspaces don't share the main checkout";
    if (this.isLoaded(ws)) return "already the loaded workspace";
    const repos = this.repoMap;
    const cos = ws.checkouts || [];
    if (!cos.every(({ repo, branch }) => repos[repo]?.branches.has(branch)))
      return "some of this workspace's branches are missing locally";
    if (cos.some(({ repo }) => repos[repo]?.dirty))
      return "commit or stash changes first — the working tree is dirty";
    return "";
  }

  canActivate(ws) {
    return !this._activateBlocked(ws);
  }

  activateTitle(ws) {
    return (
      this._activateBlocked(ws) ||
      "check out this workspace's branches and make it the loaded workspace (without starting the server)"
    );
  }

  async activate(ws) {
    if (!this.canActivate(ws)) return;
    await this.config.workspace(ws.id)?.activate();
  }

  // ── drift reconciliation (the strip's Restore / Adopt buttons) ────────────────
  // Restore: the workspace is right, the terminal detour was temporary — re-check
  // out its branches (stopping the server if it runs). Same guards as activate.
  restoreBlocked(ws) {
    const repos = this.repoMap;
    const cos = ws.checkouts || [];
    if (!cos.every(({ repo, branch }) => repos[repo]?.branches.has(branch)))
      return "some of this workspace's branches are missing locally";
    if (cos.some(({ repo }) => repos[repo]?.dirty))
      return "commit or stash changes first — a working tree is dirty";
    return "";
  }

  restoreTitle(ws) {
    return (
      this.restoreBlocked(ws) ||
      (this.isLive(ws)
        ? "stop the server and check out this workspace's branches again"
        : "check out this workspace's branches again")
    );
  }

  async restore(ws) {
    if (this.restoreBlocked(ws)) return;
    await this.config.workspace(ws.id)?.activate({ restore: true });
  }

  // Adopt: what's checked out is the new truth. If it exactly matches another
  // main-located workspace, switching to that one is the honest move; otherwise
  // rewrite this workspace's checkouts to the actual branches.
  adoptTarget(ws) {
    const repos = this.repoMap;
    return (
      (this.config.config.workspaces || []).find(
        (w) =>
          w.id !== ws.id &&
          w.location !== "worktree" &&
          (w.checkouts || []).length > 0 &&
          (w.checkouts || []).every(({ repo, branch }) => repos[repo]?.current === branch),
      ) || null
    );
  }

  switchToMatch(other) {
    return this.config.workspace(other.id)?.activate();
  }

  adopt(ws) {
    const repos = this.repoMap;
    this.config.workspace(ws.id)?.applyEdit({
      name: ws.name,
      db: ws.db || "",
      on_create_args: ws.on_create_args || "",
      checkouts: (ws.checkouts || []).map(({ repo, branch }) => ({
        repo,
        branch: repos[repo]?.current || branch,
      })),
    });
  }

  // Save-as: keep this workspace untouched and open the create dialog prefilled
  // with the ACTUAL checked-out branches — the terminal detour becomes its own
  // workspace. Named after the drifted feature branch; "create branches" defaults
  // off (the branches exist — they're checked out). Activating it (the dialog's
  // default) also resolves the drift: the new workspace matches reality.
  saveDriftAsWorkspace(ws) {
    const repos = this.repoMap;
    const checkouts = (ws.checkouts || []).map(({ repo, branch }) => ({
      repo,
      branch: repos[repo]?.current || branch,
    }));
    const feature =
      checkouts.map((c) => c.branch).find((b) => !BASE_BRANCH_RE.test(b)) ||
      checkouts[0]?.branch ||
      "";
    return startCreateWorkspace(this._dialogPlugins(), {
      name: feature,
      config: repoBranchList.format(checkouts),
      db: feature,
      template: "",
      createBranches: false,
    });
  }

  // ── actions ──────────────────────────────────────────────────────────────────
  async start(ws) {
    if (!this.canStart(ws)) return;
    if (this.isWt(ws)) return this.wt.startServer(ws);
    // loading = today's activate flow: checks out the branches, records the
    // workspace as active, stopping the previous server if needed (no-op when
    // this workspace is already the loaded one)
    await this.config.workspace(ws.id)?.activate();
    await this.server.start(ws.id);
  }

  stop(ws) {
    return this.isWt(ws) ? this.wt.stopServer(ws) : this.server.stop();
  }

  openTerminalPane(ws) {
    this.pane.set("terminal");
    if (this.termUrl) this.config.workspace(ws.id)?.touchActivity();
  }

  odooUrl(ws) {
    if (this.isWt(ws)) return this.wt.odooUrl(ws);
    return `http://localhost:8069/dev/autologin?to=${encodeURIComponent("/odoo?debug=assets")}`;
  }

  testsUrl(ws) {
    if (this.isWt(ws)) return this.wt.testsUrl(ws);
    return `http://localhost:8069/dev/autologin?to=${encodeURIComponent(
      "/web/tests?debug=assets&timeout=500000&manual=true",
    )}`;
  }

  open(url) {
    if (url) window.open(url, "_blank", "noopener");
  }

  openWorkspaceUrl(ws, url) {
    if (!url) return;
    this.config.workspace(ws.id)?.touchActivity();
    this.open(url);
  }

  // run a header-menu action then close the overflow menu
  headMenu(fn) {
    this.menuOpen.set(false);
    fn();
  }

  // ── drop the workspace's database (header ⋮ menu) ─────────────────────────────
  // guarded: the db must exist and the workspace's server must be stopped — the
  // server runs ON that database, so dropping under it is forbidden rather than
  // silently stopping it
  dbExists(ws) {
    return !!ws.db && this.db.databases().some((d) => d.name === ws.db);
  }

  canDropDb(ws) {
    return this.dbExists(ws) && !this.isLive(ws);
  }

  dropDbTitle(ws) {
    if (!ws.db) return "no database set for this workspace";
    if (!this.dbExists(ws)) return `database "${ws.db}" does not exist`;
    if (this.isLive(ws)) return "stop the server first — it is running on this database";
    return `drop database "${ws.db}"`;
  }

  async dropDb(ws) {
    if (!this.canDropDb(ws)) return;
    const res = await this.dialogs.open({
      title: `Drop "${ws.db}"?`,
      message: "This permanently deletes the database. This cannot be undone.",
      okLabel: "Drop",
    });
    if (!res) return;
    const error = await this.db.drop(ws.db);
    if (error)
      await this.dialogs.open({
        title: "Drop failed",
        message: error,
        okLabel: "OK",
        cancelLabel: null,
      });
  }

  removeBlocked(ws) {
    if (this.isWt(ws)) return this.isLive(ws);
    return this.isLoaded(ws);
  }

  removeTitle(ws) {
    if (this.isWt(ws))
      return this.isLive(ws) ? "stop the server first" : "remove the worktree + workspace";
    return this.isLoaded(ws) ? "the loaded workspace cannot be removed" : "remove the workspace";
  }

  async remove(ws) {
    if (this.removeBlocked(ws)) return;
    if (this.isWt(ws)) return this.wt.remove(ws);
    // main-located: the shared delete dialog (branches / PRs / db cleanup)
    const ids = new Set((ws.checkouts || []).map((c) => c.repo));
    await Promise.all([this.code.load(false, ids, ids), this.db.load()]);
    return deleteWorkspaceDialog(ws, {
      config: this.config,
      code: this.code,
      db: this.db,
      eventLog: this.eventLog,
      repoMap: this.repoMap,
      isActive: this.isLoaded(ws),
      dialogs: this.dialogs,
      wt: this.wt,
      server: this.server,
    });
  }

  // ── terminal gating: never show another workspace's server PTY ───────────────
  get termUrl() {
    const ws = this.sel;
    if (!ws) return "";
    if (this.isWt(ws)) {
      // the backend entry (and its PTY) exists only once the server has run
      return this.stateOf(ws) === "stopped"
        ? ""
        : `ws://${location.host}/api/terminal?workspace=${encodeURIComponent(ws.id)}`;
    }
    return this.isLoaded(ws) ? `ws://${location.host}/api/terminal?workspace=main` : "";
  }

  get termHint() {
    if (this.isWt(this.sel)) return "Start this workspace's server to attach a terminal.";
    return "This workspace isn't loaded — the main terminal belongs to the loaded workspace.";
  }

  // ── edit dialog (both locations) ─────────────────────────────────────────────
  async edit(ws) {
    const res = await this.dialogs.open({
      title: `Edit "${ws.name}"`,
      okLabel: "Save",
      validate: (v) => {
        const name = (v.name || "").trim();
        if (!name) return "a name is required";
        if ((this.config.config.workspaces || []).some((w) => w.name === name && w.id !== ws.id))
          return `a workspace named "${name}" already exists`;
        if (!repoBranchList.parse((v.config || "").trim()).length) return "a config is required";
        return "";
      },
      fields: [
        { key: "name", type: "text", label: "Name", value: ws.name },
        {
          key: "config",
          type: "text",
          label: "Config",
          value: repoBranchList.format(ws.checkouts),
          placeholder: "community:master,enterprise:master",
        },
        { key: "db", type: "text", label: "Database", value: ws.db || "" },
        { key: "args", type: "text", label: "Start args", value: ws.on_create_args || "" },
        ...(this.categoriesEnabled
          ? [
              {
                key: "category",
                type: "select",
                label: "Category",
                placeholder: "— none —",
                options: categoryOptions(this.config),
                value: ws.category || "",
              },
            ]
          : []),
      ],
    });
    if (!res) return;
    this.config.workspace(ws.id)?.applyEdit({
      name: res.name.trim(),
      checkouts: repoBranchList.parse(res.config.trim()),
      db: (res.db || "").trim(),
      on_create_args: (res.args || "").trim(),
      ...(this.categoriesEnabled ? { category: res.category || "" } : {}),
    });
  }

  // ── new workspace (unified: template picker + location) ─────────────────────
  _dialogPlugins() {
    return {
      config: this.config,
      dialogs: this.dialogs,
      db: this.db,
      code: this.code,
      eventLog: this.eventLog,
      wt: this.wt,
      server: this.server,
    };
  }

  create() {
    return startNewWorkspaceWizard(this._dialogPlugins());
  }

  adoptCheckout() {
    return adoptCurrentCheckout(this._dialogPlugins());
  }
}
