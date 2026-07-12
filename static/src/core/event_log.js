import { Component, onPatched, usePlugin, signal, useEffect, xml } from "@odoo/owl";
import { ConfigPlugin } from "./config_plugin.js";
import { EventLogPlugin } from "./event_log_plugin.js";
import { RouterPlugin } from "./router_plugin.js";
import { TestsPlugin } from "./tests_plugin.js";
import { ServerPlugin } from "./server_plugin.js";
import { WorkspacePlugin } from "./workspace_plugin.js";
import { ICONS, m, useDragResize } from "./common.js";

export class EventLog extends Component {
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

  log = usePlugin(EventLogPlugin);
  config = usePlugin(ConfigPlugin);
  router = usePlugin(RouterPlugin);
  tests = usePlugin(TestsPlugin);
  server = usePlugin(ServerPlugin);
  worktree = usePlugin(WorkspacePlugin);
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

  // open the loaded workspace's Tests pane (anchors are main-slot only) and scroll
  // its console to the anchored line. The console unmounts when off-pane and its
  // element is re-hosted on return, so we wait (a few frames) for the row to
  // become laid out before revealing it.
  jump(anchor) {
    // anchors are main-slot rows — land on the LOADED workspace's Tests pane
    const s = this.server.status();
    const loaded =
      s.state === "running" || s.state === "starting" ? s.workspace : this.server.lastWorkspace();
    if (loaded) this.worktree.selectOnOpen(loaded);
    this.worktree.requestedPane.set("tests");
    this.router.go("workspaces");
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

// ─────────────────────────── Nightly ───────────────────────────

// one line-chart metric option in the graph sidebar; `fmt` formats both the
// tooltip value and the y-axis ticks
