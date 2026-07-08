import { Component, plugin, signal, useEffect, xml } from "@odoo/owl";
import { tintCmd } from "../core/utils.js";

import { ConfigPlugin } from "../core/config_plugin.js";
import { ServerPlugin } from "../core/server_plugin.js";
import { TerminalPlugin } from "../core/terminal_plugin.js";
import { ICONS, LogConsole, m } from "../core/common.js";
import { Panel } from "../core/panel.js";

export class ServerScreen extends Component {
  static components = { LogConsole, Panel };
  static template = xml`
    <section>
      <Panel title="'Server'">
        <t t-set-slot="title-extra">
          <div t-if="this.info" class="sub"><t t-out="this.info"/></div>
          <div t-if="this.hint" class="sub hint" t-out="this.hint"/>
        </t>
        <t t-set-slot="top-right">
          <div t-if="this.uptime" class="uptime">uptime: <b t-out="this.uptime"/></div>
        </t>
        <t t-set-slot="bottom-left">
          <button class="pbtn primary dash-start" t-att-disabled="!this.stopped or this.busy" t-on-click="() => this.server.start(this.target(), this.extraArgs())"><span class="play"/><t t-out="this.startLabel"/></button>
          <button class="pbtn stop" t-att-disabled="!this.canStop or this.busy" t-on-click="() => this.server.stop()"><span class="ic square"/>Stop</button>
          <button class="pbtn" t-att-disabled="!this.active or this.busy" t-on-click="() => this.server.restart(this.target(), this.extraArgs())"><span class="restart"/>Restart</button>
          <button class="pbtn pbtn-icon" t-att-class="{active: this.term.open()}" t-att-disabled="!this.active" title="Open terminal" t-on-click="() => this.term.toggle()"><t t-out="this.termIcon"/></button>
          <span t-if="this.transient" class="run-state" t-out="this.transient"/>
          <div t-if="this.showLogs" class="log-controls">
            <label class="toggle" t-att-class="{on: this.server.output.autoScroll()}" t-on-click="() => this.toggleAuto()"><span class="switch"/>Autoscroll</label>
            <button class="tool-btn" t-on-click="() => this.server.output.clear()"><t t-out="this.clearIcon"/>Clear</button>
          </div>
        </t>
      </Panel>
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
    return this.config.config.workspaces || [];
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
