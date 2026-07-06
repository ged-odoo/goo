import { Component, onMounted, plugin, props, signal, t, useEffect, xml } from "@odoo/owl";
import { ClaudePlugin } from "./claude_plugin.js";
import { ConfigPlugin } from "../core/config_plugin.js";
import { DatabasePlugin } from "../core/database_plugin.js";
import { DialogPlugin } from "../core/dialog_plugin.js";
import { WorktreePlugin } from "../core/worktree_plugin.js";
import { ICONS, LogConsole, m } from "../core/common.js";
import { Panel } from "../core/panel.js";

export class ClaudeChat extends Component {
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

export class WorktreeScreen extends Component {
  static components = { LogConsole, ClaudeChat, Panel };
  static template = xml`
    <section>
      <Panel title="'Worktrees'">
        <t t-set-slot="top-right">
          <span class="meta" t-out="this.list.length + (this.list.length === 1 ? ' worktree' : ' worktrees')"/>
        </t>
        <t t-set-slot="bottom-left">
          <button class="pbtn primary" t-on-click="() => this.create()">Create Worktree</button>
          <span class="dash-subtitle">Run a branch in its own checkout, database and server — alongside the main one.</span>
        </t>
      </Panel>
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
    return (tgt.checkouts && tgt.checkouts[0] && tgt.checkouts[0].branch) || "";
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
