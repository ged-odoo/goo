import { Component, onMounted, plugin, props, signal, t, useEffect, xml } from "@odoo/owl";
import { ClaudePlugin } from "./claude_plugin.js";
import { CodePlugin } from "../core/code_plugin.js";
import { ConfigPlugin } from "../core/config_plugin.js";
import { DatabasePlugin } from "../core/database_plugin.js";
import { DialogPlugin } from "../core/dialog_plugin.js";
import { EventLogPlugin } from "../core/event_log_plugin.js";
import { ServerPlugin } from "../core/server_plugin.js";
import { StorePlugin } from "../core/store_plugin.js";
import { WorkspacePlugin } from "../core/workspace_plugin.js";
import { ICONS, LogConsole, SearchBox, appBus, m } from "../core/common.js";
import { Panel } from "../core/panel.js";
import { attachXterm } from "../core/terminal.js";
import { branchKey } from "../core/models.js";
import { repoBranchList, timeAgo } from "../core/utils.js";
import {
  createWorkspaceFromRemoteBranch,
  deleteWorkspaceDialog,
  startCreateWorkspace,
} from "./dialogs.js";
import { AddonsPane, AssetsPane, TestsPane } from "./panes.js";

export class ClaudeChat extends Component {
  static template = xml`
    <div class="cchat">
      <div class="cchat-msgs" t-ref="this.scroll">
        <div t-if="!this.items.length" class="cchat-hint dim">
          <t t-if="this.props.inMain">
            Send a task to Claude. <b>Caution:</b> it runs with full autonomy in your
            MAIN checkout — it edits the real working tree this workspace shares.
          </t>
          <t t-else="">
            Send a task to Claude. It runs in this worktree's checkout with full autonomy —
            it can edit files and run commands here without touching your main tree.
          </t>
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

  props = props({ target: t.any(), inMain: t.boolean().optional() });
  claude = plugin(ClaudePlugin);
  scroll = signal.ref(HTMLElement);
  ta = signal.ref(HTMLElement);

  setup() {
    onMounted(() => this.claude.prime(this.props.target.id));
    // follow the tail as items stream in (owl3's useEffect tracks the body itself —
    // the items/running reads below are what re-run it)
    useEffect(() => {
      (void this.items.length, this.running);
      const el = this.scroll();
      if (el) el.scrollTop = el.scrollHeight;
    });
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

// ─────────────────────────── Code pane ───────────────────────────

// The selected workspace's code view: one card per checkout (branch, checked-out
// badge, last commit, PR) and the deduped list of its pull requests. Data comes
// from CodePlugin, loaded narrowed to the workspace's repos on selection.

export class CodePane extends Component {
  static template = xml`
    <div class="ws-code">
      <div class="ws-sec">
        <span>Branches</span>
        <span t-if="this.code.loading()" class="dim ws-sec-meta">loading…</span>
        <button class="pbtn ws-refresh" title="refresh branches + pull requests" t-on-click="() => this.load(true)"><span class="restart"/></button>
      </div>
      <div class="ws-card" t-foreach="this.rows" t-as="r" t-key="r.key">
        <div class="ws-card-main">
          <div class="ws-card-head">
            <span class="ws-branch" t-out="r.branch"/>
            <span class="ws-repo-tag" t-out="r.repo"/>
            <span t-if="r.checkedOut" class="ws-co-badge">checked out</span>
            <span t-if="r.dirty" class="ws-dirty" title="the working tree has uncommitted changes">dirty</span>
            <span t-if="r.missing" class="ws-missing dim">branch not found locally</span>
          </div>
          <div t-if="r.subject" class="ws-commit dim">
            <t t-out="r.subject"/><t t-if="r.when"> · <t t-out="r.when"/></t>
          </div>
        </div>
        <div t-if="r.pr" class="ws-pr-row">
          <a class="pr-link" t-att-href="r.pr.url" target="_blank" t-out="'#' + r.pr.number"/>
          <span class="pr-state" t-att-class="this.prCls(r.pr)" t-out="this.prLabel(r.pr)"/>
          <t t-set="ci" t-value="this.ciBadge(r.pr)"/>
          <span t-if="ci" class="dash-ci" t-att-class="ci.cls" t-att-title="ci.title"
                t-on-mouseenter="(ev) => this.showCiMenu(ev, ci.checks)" t-on-mouseleave="() => this.hideCiMenu()">
            <span class="dash-ci-dot"/><t t-out="ci.label"/>
          </span>
        </div>
      </div>
      <div t-if="!this.rows.length" class="dim ws-empty-note">This workspace has no checkouts.</div>

      <div class="ws-sec">
        <span>Pull requests</span>
        <span class="dim ws-sec-meta" t-out="this.prsMeta"/>
      </div>
      <div t-if="!this.prs.length" class="dim ws-empty-note">No pull requests for this workspace's branches.</div>
      <div class="ws-card ws-pr-card" t-foreach="this.prs" t-as="pr" t-key="pr.key">
        <div class="ws-card-main">
          <div class="ws-card-head">
            <a class="pr-link" t-att-href="pr.url" target="_blank" t-out="'#' + pr.number"/>
            <span class="ws-pr-title" t-out="pr.title"/>
          </div>
        </div>
        <div class="ws-pr-row">
          <span class="pr-state" t-att-class="this.prCls(pr)" t-out="this.prLabel(pr)"/>
          <t t-set="ci" t-value="this.ciBadge(pr)"/>
          <span t-if="ci" class="dash-ci" t-att-class="ci.cls" t-att-title="ci.title"
                t-on-mouseenter="(ev) => this.showCiMenu(ev, ci.checks)" t-on-mouseleave="() => this.hideCiMenu()">
            <span class="dash-ci-dot"/><t t-out="ci.label"/>
          </span>
        </div>
      </div>
    </div>`;

  props = props({ ws: t.any() });
  code = plugin(CodePlugin);
  store = plugin(StorePlugin);

  setup() {
    // load branches + PRs narrowed to this workspace's repos (merging, so other
    // repos' cached state is untouched); owl3's useEffect tracks the body, so this
    // re-runs when the workspace's checkouts change (the pane is t-keyed per ws)
    useEffect(() => {
      this.load(false);
    });
  }

  load(force) {
    const ids = new Set((this.props.ws.checkouts || []).map((c) => c.repo));
    if (ids.size) this.code.load(force, ids, ids);
  }

  // one row per checkout, joined with live git state + its PR
  get rows() {
    const view = this.store.workspaceView(this.props.ws);
    const byRepo = new Map(this.code.branchRepos().map((r) => [r.id, r]));
    const prIndex = this.code.groups().prIndex;
    return (view.checkouts || []).map((c) => {
      const repo = byRepo.get(c.repo);
      const b = (repo?.branches || []).find((x) => x.name === c.branch);
      return {
        key: branchKey(c.repo, c.branch),
        repo: c.repo,
        branch: c.branch,
        checkedOut: !!c.matches,
        dirty: !!(c.matches && c.dirty),
        missing: !!repo && !b,
        subject: b?.subject || "",
        when: b?.date ? timeAgo(b.date) : "",
        pr: prIndex[branchKey(c.repo, c.branch)] || null,
      };
    });
  }

  get prs() {
    const seen = new Set();
    return this.rows.map((r) => r.pr).filter((pr) => pr && !seen.has(pr.key) && seen.add(pr.key));
  }

  get prsMeta() {
    const n = this.prs.length;
    return n ? `${n} pull request${n === 1 ? "" : "s"}` : "";
  }

  prCls(pr) {
    return pr.draft && pr.state === "open" ? "draft" : pr.state;
  }

  prLabel(pr) {
    return pr.draft && pr.state === "open" ? "draft" : pr.state;
  }

  // CI badge from the PR's GitHub status rollup (reduction of the dashboard's)
  ciBadge(pr) {
    const ci = pr && pr.ci;
    if (!ci || !ci.checks || !ci.checks.length) return null;
    const pending = ci.checks.some((c) => c.state === "pending");
    let badge;
    if (ci.overall === "failure") badge = { cls: "fail", label: "ko", title: "a CI check failed" };
    else if (ci.overall === "success")
      badge = { cls: "pass", label: "ok", title: "all CI checks passing" };
    else if (ci.overall === "pending" || pending)
      badge = { cls: "run", label: "running", title: "CI running" };
    else badge = { cls: "unknown", label: "—", title: "no CI status" };
    badge.checks = ci.checks;
    return badge;
  }

  showCiMenu(ev, checks) {
    if (!checks || !checks.length) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    appBus.dispatchEvent(new CustomEvent("ci-menu", { detail: { rect, checks } }));
  }

  hideCiMenu() {
    appBus.dispatchEvent(new CustomEvent("ci-menu-hide"));
  }
}

// ─────────────────────────── Terminal pane ───────────────────────────

// An xterm attached to a workspace server's PTY (Phase-2 backend:
// /api/terminal?workspace=<id>). The parent gates the URL — it only renders this
// component when the target PTY actually belongs to the selected workspace.

export class TerminalPane extends Component {
  static template = xml`<div class="ws-term" t-ref="this.host"/>`;

  props = props({ url: t.string() });
  host = signal.ref(HTMLElement);
  _dispose = null;

  setup() {
    useEffect(
      () => {
        const el = this.host();
        if (!el) return;
        let live = true;
        attachXterm(el, this.props.url, true).then((dispose) =>
          live ? (this._dispose = dispose) : dispose(),
        );
        return () => {
          live = false;
          this._dispose?.();
          this._dispose = null;
        };
      },
      () => [this.props.url],
    );
  }
}

// ─────────────────────────── Workspaces screen ───────────────────────────

// The primary work surface: every workspace (main-located and worktree) in one
// searchable list; the selected one's detail — status, per-location server
// controls, and the Code / Server logs / Claude / Terminal tabs. A main-located
// workspace shares the primary checkout (one loaded at a time — Start loads it,
// i.e. checks out its branches, then starts the main server on :8069); a worktree
// workspace runs concurrently from its own checkout on its own stable port.

export class WorkspacesScreen extends Component {
  static components = {
    LogConsole,
    ClaudeChat,
    CodePane,
    TerminalPane,
    TestsPane,
    AddonsPane,
    AssetsPane,
    Panel,
    SearchBox,
  };

  static template = xml`
    <section>
      <Panel title="'Workspaces'">
        <t t-set-slot="top-right">
          <span class="meta" t-out="this.count"/>
        </t>
        <t t-set-slot="bottom-left">
          <button class="pbtn primary" t-on-click="() => this.create()">New workspace</button>
          <button class="pbtn" title="fetch a remote branch and create a workspace on it" t-on-click="() => this.createFromRemoteBranch()">From remote branch</button>
          <span class="dash-subtitle">A workspace bundles branches, a database and a server — in the main checkout or its own worktree.</span>
        </t>
      </Panel>
      <div class="content wt-content">
        <div class="wt-list">
          <SearchBox value="this.query"/>
          <div t-if="!this.list.length" class="wt-empty dim" t-out="this.query() ? 'No workspace matches.' : 'No workspaces yet. Create one to get started.'"/>
          <button t-foreach="this.list" t-as="ws" t-key="ws.id" class="wt-item"
                  t-att-class="{selected: ws.id === this.wt.selectedId()}" t-on-click="() => this.wt.select(ws.id)">
            <span class="wt-dot" t-att-class="this.dotClass(ws)"/>
            <span class="wt-item-main">
              <span class="wt-item-name" t-out="ws.name"/>
              <span class="wt-item-sub"><t t-out="this.branchOf(ws)"/> · <t t-out="ws.db"/></span>
            </span>
            <span t-if="this.isWt(ws)" class="wt-badge" title="worktree workspace">wt</span>
            <span t-if="this.portOf(ws)" class="wt-item-port" t-out="':' + this.portOf(ws)"/>
          </button>
        </div>
        <div class="wt-detail">
          <t t-if="this.sel">
            <div class="wt-detail-head">
              <h2 t-out="this.sel.name"/>
              <div class="wt-meta">
                <span>branch <b t-out="this.branchOf(this.sel)"/></span>
                <span>db <b t-out="this.sel.db"/></span>
                <span t-if="this.portOf(this.sel)">port <b t-out="this.portOf(this.sel)"/></span>
                <span t-if="this.isLoaded(this.sel)" class="ws-loaded-tag" title="this workspace occupies the main checkout">loaded</span>
                <span class="wt-state" t-att-class="this.dotClass(this.sel)" t-out="this.stateOf(this.sel)"/>
              </div>
            </div>
            <div class="wt-detail-actions">
              <button class="pbtn primary" t-att-disabled="!this.canStart(this.sel)" t-att-title="this.startTitle(this.sel)" t-on-click="() => this.start(this.sel)"><span class="play"/><t t-out="this.startLabel"/></button>
              <button class="pbtn stop" t-att-disabled="!this.isLive(this.sel)" t-on-click="() => this.stop(this.sel)"><span class="ic square"/>Stop</button>
              <button class="pbtn" t-att-disabled="!this.isLive(this.sel)" t-on-click="() => this.restart(this.sel)"><span class="restart"/>Restart</button>
              <span class="wt-sp"/>
              <button class="pbtn" title="edit name / branches / database / args" t-on-click="() => this.edit(this.sel)">Edit</button>
              <button class="pbtn" title="open the workspace's repos in the editor" t-on-click="() => this.openEditor(this.sel)"><t t-out="this.codeIcon"/>Editor</button>
              <button class="pbtn" t-att-disabled="!this.isRunning" title="open /odoo (autologin)" t-on-click="() => this.open(this.odooUrl(this.sel))"><t t-out="this.externalIcon"/>/odoo</button>
              <button class="pbtn" t-att-disabled="!this.isRunning" title="open /web/tests (autologin)" t-on-click="() => this.open(this.testsUrl(this.sel))"><t t-out="this.externalIcon"/>/web/tests</button>
              <span class="wt-sp"/>
              <button class="pbtn danger" t-att-disabled="this.removeBlocked(this.sel)" t-att-title="this.removeTitle(this.sel)" t-on-click="() => this.remove(this.sel)">Remove</button>
            </div>
            <div class="wt-panes">
              <div class="wt-tabs">
                <button class="wt-tab" t-att-class="{on: this.pane() === 'code'}" t-on-click="() => this.pane.set('code')"><t t-out="this.icons.code"/>Code</button>
                <button class="wt-tab" t-att-class="{on: this.pane() === 'log'}" t-on-click="() => this.pane.set('log')"><t t-out="this.icons.journal"/>Server logs</button>
                <button class="wt-tab" t-att-class="{on: this.pane() === 'tests'}" t-on-click="() => this.pane.set('tests')"><t t-out="this.icons.tests"/>Tests</button>
                <button class="wt-tab" t-att-class="{on: this.pane() === 'addons'}" t-on-click="() => this.pane.set('addons')"><t t-out="this.icons.addons"/>Addons</button>
                <button class="wt-tab" t-att-class="{on: this.pane() === 'assets'}" t-on-click="() => this.pane.set('assets')"><t t-out="this.icons.assets"/>Assets</button>
                <button class="wt-tab" t-att-class="{on: this.pane() === 'claude'}" t-on-click="() => this.pane.set('claude')"><t t-out="this.icons.claude"/>Claude</button>
                <button class="wt-tab" t-att-class="{on: this.pane() === 'terminal'}" t-on-click="() => this.pane.set('terminal')"><t t-out="this.icons.terminal"/>Terminal</button>
              </div>
              <div class="wt-pane" t-if="this.pane() === 'code'">
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
                <div t-else="" class="ws-pane-hint dim">This workspace isn't loaded — Start it first to run tests against its database and checkout.</div>
              </div>
              <div class="wt-pane" t-elif="this.pane() === 'addons'">
                <AddonsPane t-if="this.canRunHere(this.sel)" t-key="this.sel.id" ws="this.sel"/>
                <div t-else="" class="ws-pane-hint dim">This workspace isn't loaded — Start it first to browse and install its modules.</div>
              </div>
              <div class="wt-pane" t-elif="this.pane() === 'assets'">
                <AssetsPane t-if="this.sel.db" t-key="this.sel.id" ws="this.sel"/>
                <div t-else="" class="ws-pane-hint dim">This workspace has no database.</div>
              </div>
              <div class="wt-pane" t-elif="this.pane() === 'claude'">
                <ClaudeChat t-if="this.canRunHere(this.sel)" t-key="this.sel.id" target="this.sel" inMain="!this.isWt(this.sel)"/>
                <div t-else="" class="ws-pane-hint dim">This workspace isn't loaded — load it first, or use a worktree workspace to let Claude work in isolation.</div>
              </div>
              <div class="wt-pane" t-elif="this.pane() === 'terminal'">
                <TerminalPane t-if="this.termUrl" t-key="this.sel.id" url="this.termUrl"/>
                <div t-else="" class="ws-pane-hint dim" t-out="this.termHint"/>
              </div>
            </div>
          </t>
          <div t-else="" class="wt-detail-empty dim">Select a workspace on the left, or create one.</div>
        </div>
      </div>
    </section>`;

  wt = plugin(WorkspacePlugin);
  config = plugin(ConfigPlugin);
  code = plugin(CodePlugin);
  db = plugin(DatabasePlugin);
  dialogs = plugin(DialogPlugin);
  eventLog = plugin(EventLogPlugin);
  server = plugin(ServerPlugin);
  store = plugin(StorePlugin);
  externalIcon = m(ICONS.external);
  codeIcon = m(ICONS.code);
  icons = {
    code: m(ICONS.code),
    journal: m(ICONS.journal),
    tests: m(ICONS.tests),
    addons: m(ICONS.addons),
    assets: m(ICONS.assets),
    claude: m(ICONS.claude),
    terminal: m(ICONS.terminal),
  };

  // which detail pane is shown: code | log | tests | addons | assets | claude | terminal
  pane = signal("code");
  query = signal(""); // the list search

  setup() {
    this.db.load(); // cache-aware; warms the clone-source list for the create dialog
    // keep the selected workspace's git state fresh (drives the Start guard + the
    // checked-out badges) — a scoped, cheap branch scan when the selection (read
    // via this.sel — owl3's useEffect tracks the body) changes
    useEffect(() => {
      const ws = this.sel;
      if (!ws) return;
      const ids = new Set((ws.checkouts || []).map((c) => c.repo));
      if (ids.size) this.code.loadBranches(ids);
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
  }

  // ── list / selection ─────────────────────────────────────────────────────────
  // reads the canonical `workspaces` array — it carries `location` and the stable
  // `port` (the legacy `targets` view drops both by design)
  get list() {
    const all = this.config.config.workspaces || []; // every workspace, config order
    const q = this.query().trim().toLowerCase();
    if (!q) return all;
    return all.filter((ws) =>
      `${ws.name} ${this.branchOf(ws)} ${ws.db || ""}`.toLowerCase().includes(q),
    );
  }

  get count() {
    const n = (this.config.config.workspaces || []).length;
    return `${n} workspace${n === 1 ? "" : "s"}`;
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

  // ── per-location server state ────────────────────────────────────────────────
  // the workspace occupying the main checkout: the running main server's, else the
  // last activated one (a browser-side fact — see targets_screen isActive)
  get activeId() {
    const s = this.server.status();
    return s.state === "running" || s.state === "starting"
      ? s.workspace
      : this.server.lastWorkspace();
  }

  isLoaded(ws) {
    return !this.isWt(ws) && ws.id === this.activeId;
  }

  // whether runs (tests/addons) and Claude can act on this workspace here: a
  // worktree always (its own checkout), a main-located one only when loaded —
  // running against another workspace's checked-out code would mislead
  canRunHere(ws) {
    return this.isWt(ws) || this.isLoaded(ws);
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

  restart(ws) {
    return this.isWt(ws) ? this.wt.restartServer(ws) : this.server.restart(ws.id);
  }

  openEditor(ws) {
    if (this.isWt(ws)) return this.wt.openEditor(ws);
    const g = this.code.groups();
    const paths = (ws.checkouts || []).map((c) => g.pathByRepo[c.repo]).filter(Boolean);
    if (paths.length) this.code.openEditorPaths(paths, ws.name);
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
      ],
    });
    if (!res) return;
    this.config.workspace(ws.id)?.applyEdit({
      name: res.name.trim(),
      checkouts: repoBranchList.parse(res.config.trim()),
      db: (res.db || "").trim(),
      on_create_args: (res.args || "").trim(),
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
    };
  }

  create() {
    return startCreateWorkspace(this._dialogPlugins());
  }

  createFromRemoteBranch() {
    return createWorkspaceFromRemoteBranch(this._dialogPlugins());
  }
}

// ─────────────────────────── Databases screen ───────────────────────────
