import { Component, onMounted, onWillUnmount, plugin, props, signal, t, xml } from "@odoo/owl";
import { timeAgo } from "../utils.js";
import { CodePlugin } from "../plugins/code_plugin.js";
import { ConfigPlugin } from "../plugins/config_plugin.js";
import { ICONS, m, useDragResize } from "./common.js";

export class RemoteBranchDialog extends Component {
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

export class CommitsDialog extends Component {
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
