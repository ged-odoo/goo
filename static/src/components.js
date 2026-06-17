// Owl 3 components. Screens stay mounted (toggled via the `hidden` class) so
// the log console keeps its streamed lines across tab switches. Plugin refs,
// signals and constants are class fields; setup() is only for lifecycle. State
// is held in individual signals (read via signal() in templates); component
// props use the props({...}) helper with `t` types.

import { BASE_BRANCH_RE } from "./config.js";
import { ConfigPlugin } from "./config_plugin.js";
import { RouterPlugin } from "./router_plugin.js";
import { ServerPlugin } from "./server_plugin.js";
import { DatabasePlugin } from "./database_plugin.js";
import { CodePlugin } from "./code_plugin.js";
import { TestsPlugin } from "./tests_plugin.js";
import { AddonsPlugin } from "./addons_plugin.js";
import { timeAgo, tintCmd } from "./utils.js";

const {
  Component,
  xml,
  plugin,
  proxy,
  markup,
  onMounted,
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
  config: `<svg viewBox="0 0 24 24"><line x1="4" y1="8" x2="20" y2="8"/><line x1="4" y1="16" x2="20" y2="16"/><circle cx="15" cy="8" r="2.4" class="knob"/><circle cx="9" cy="16" r="2.4" class="knob"/></svg>`,
  play: `<svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none"/></svg>`,
  stop: `<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/></svg>`,
  external: `<svg viewBox="0 0 24 24"><path d="M7 17 17 7M9 7h8v8"/></svg>`,
};
const NAV = [
  { id: "dashboard", label: "Dashboard", icon: ICONS.code },
  { id: "server", label: "Server", icon: ICONS.server },
  { id: "branches", label: "Branches", icon: ICONS.branches },
  { id: "prs", label: "PRs", icon: ICONS.pr },
  { id: "tests", label: "Tests", icon: ICONS.tests },
  { id: "addons", label: "Addons", icon: ICONS.addons },
  { id: "databases", label: "Databases", icon: ICONS.databases },
  { id: "targets", label: "Targets", icon: ICONS.target },
  { id: "config", label: "Config", icon: ICONS.config },
];
// ─────────────────────────── Topbar ───────────────────────────

class Topbar extends Component {
  static template = xml`
    <header class="topbar">
      <div class="top-left">
        <div class="logo"><span class="name" title="GED Odoo Overseer">goo</span></div>
        <div t-if="this.target" class="nav-target" t-att-class="this.stateClass" t-att-title="this.tooltip">
          <span class="dot"/>
          <span class="t-name" t-out="this.target"/>
        </div>
      </div>
      <div class="top-right">
        <a t-foreach="this.routes" t-as="r" t-key="r.label" class="route" t-att-href="r.href" target="_blank" t-out="r.label"/>
      </div>
    </header>`;

  server = plugin(ServerPlugin);
  config = plugin(ConfigPlugin);

  // navbar links, editable in the Config tab
  get routes() {
    return this.config.config.links;
  }

  get active() {
    const s = this.server.status().state;
    return s === "running" || s === "starting";
  }

  // the running target while active, else the last-used one (shown dimmed)
  get target() {
    return this.active ? this.server.status().target || "" : this.server.lastTarget();
  }

  get stateClass() {
    const s = this.server.status().state;
    return s === "running" ? "live" : s === "starting" ? "starting" : "idle";
  }

  get tooltip() {
    return this.active
      ? `current target (${this.server.status().state})`
      : "last target — server stopped";
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
  nav = NAV;
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

// ─────────────────────────── Dashboard screen ───────────────────────────

// Per-target view of the code state: for each target, the git/runbot/PR state
// of every repo:branch in its config. Reuses CodePlugin's branch + PR data.
class DashboardScreen extends Component {
  static template = xml`
    <section>
      <div class="panel">
        <div class="panel-top">
          <h1>Dashboard</h1>
          <div class="panel-top-right">
            <span class="meta" t-out="this.stamp"/>
            <button class="pbtn" t-on-click="() => this.code.load(true)"><t t-out="this.refreshIcon"/>Refresh</button>
          </div>
        </div>
        <div class="panel-actions">
          <button t-if="this.activeTarget and this.serverStopped" class="dash-activate dash-start" t-on-click="() => this.server.start(this.activeTarget.name)" title="start the active target">
            <t t-out="this.playIcon"/>Start
          </button>
          <button t-if="this.serverRunning or this.serverStopping" class="dash-activate dash-stop" t-att-disabled="this.serverStopping" t-on-click="() => this.server.stop()" title="stop the server">
            <t t-out="this.stopIcon"/>Stop
          </button>
          <span class="dash-subtitle">Monitor repositories and switch between build targets.</span>
        </div>
      </div>
      <div class="content">
        <div t-att-class="{busy: this.code.busy()}">
          <div t-foreach="this.errors" t-as="e" t-key="e.id" class="dim" t-out="e.id + ': ' + e.error"/>

          <!-- favorite repositories (flat list, fetch &amp; rebase per repo) -->
          <section t-if="this.favRepos.length" class="dash-repos">
            <div class="dash-repos-head">
              <span>Repository</span><span>Branch</span><span>Last commit</span><span>When</span>
              <button class="dash-rebase dash-rebase-all" t-att-disabled="!this.canRebaseAll()" t-att-title="this.rebaseAllTitle()" t-on-click="() => this.rebaseAll()">
                <t t-out="this.refreshIcon"/>Fetch &amp; rebase all
              </button>
            </div>
            <div t-foreach="this.favRepos" t-as="r" t-key="r.id" class="dash-repo-row">
              <div class="dash-repo-name"><t t-out="this.branchIcon"/><span t-out="r.id"/></div>
              <span class="dash-branch">
                <t t-if="r.error"><span class="git-state missing" t-out="r.error"/></t>
                <t t-else="">
                  <span t-out="r.current || '—'"/>
                  <span t-if="r.dirty" class="dirty-mark" title="uncommitted changes"> *</span>
                </t>
              </span>
              <span class="dash-commit" t-att-title="r.subject" t-out="r.subject || '—'"/>
              <span class="dash-when" t-att-title="r.date" t-out="r.date ? this.cell(r.date) : '—'"/>
              <button class="dash-rebase" t-att-disabled="!this.canRebaseRepo(r)" t-att-title="this.rebaseRepoTitle(r)" t-on-click="() => this.rebaseRepo(r)">
                <t t-out="this.refreshIcon"/>Fetch &amp; rebase
              </button>
            </div>
          </section>

          <!-- build targets (cards) -->
          <div t-if="this.code.error()" class="dim" t-out="'Failed to load: ' + this.code.error()"/>
          <div t-elif="!this.targets.length" class="dim">No favorite targets — star targets in the Targets tab to see them here.</div>
          <div t-else="" class="dash-cards">
            <div t-foreach="this.targets" t-as="tgt" t-key="tgt.name" class="dash-card" t-att-class="{active: this.isActive(tgt)}">
              <div class="dash-card-head">
                <div class="dash-card-title">
                  <span class="dash-dot" t-att-class="{active: this.isActive(tgt)}"/>
                  <span class="dash-name" t-out="tgt.name"/>
                  <span class="dash-db"><span class="dim">db:</span> <t t-out="tgt.db"/></span>
                </div>
                <button t-if="!this.isActive(tgt)" class="dash-activate" t-att-disabled="!this.canActivate(tgt)" t-att-title="this.activateTitle(tgt)" t-on-click="() => this.activate(tgt)">Activate</button>
              </div>
              <div class="dash-card-body">
                <div t-foreach="this.rows(tgt)" t-as="row" t-key="row.repo" class="dash-card-row">
                  <div class="dash-row-repo">
                    <div class="dash-row-name" t-out="row.repo"/>
                    <a t-if="row.remote and row.github" class="dash-row-branch branch-link" target="_blank" t-att-href="this.code.remoteBranchUrl(row.github, row.branch)" t-att-title="row.branch" t-out="row.branch"/>
                    <div t-else="" class="dash-row-branch" t-att-title="row.branch" t-out="row.branch"/>
                  </div>
                  <span class="dash-row-commit" t-att-title="row.subject" t-out="row.present ? (row.subject || '—') : '—'"/>
                  <t t-set="ci" t-value="this.ciBadge(row)"/>
                  <a t-if="row.present" class="dash-ci" t-att-class="ci.cls" target="_blank" t-att-href="this.code.bundleUrl(row.branch)" t-att-title="'runbot: ' + ci.title">
                    <span class="dash-ci-dot"/><t t-out="ci.label"/>
                  </a>
                  <span t-else="" class="dash-ci missing">missing</span>
                  <div class="dash-row-pr">
                    <t t-if="row.pr and row.github">
                      <a class="dash-pr-num" target="_blank" t-att-href="row.pr.url" t-att-title="'open #' + row.pr.number + ' on GitHub'" t-out="'#' + row.pr.number"/>
                      <a t-if="this.mbState(row)" class="dash-pr-state" t-att-class="this.mbClass(row)" target="_blank" t-att-href="this.code.mergebotUrl(row.github, row.pr.number)" t-att-title="'mergebot: ' + this.mbState(row)" t-out="this.mbState(row)"/>
                    </t>
                    <span t-else="" class="dim">—</span>
                  </div>
                  <span class="dash-row-when" t-att-title="row.date" t-out="row.date ? this.cell(row.date) : '—'"/>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>`;

  code = plugin(CodePlugin);
  config = plugin(ConfigPlugin);
  server = plugin(ServerPlugin);
  refreshIcon = m(ICONS.refresh);
  branchIcon = m(ICONS.branches);
  playIcon = m(ICONS.play);
  stopIcon = m(ICONS.stop);

  setup() {
    this.code.load();
    // fetch runbot + mergebot status only for what the target cards actually show
    useEffect(() => {
      const branches = this._branches();
      if (branches.length) this.code.loadRunbot(branches);
      const prs = this._prs();
      if (prs.length) this.code.loadMergebot(prs);
    });
  }

  // present branches shown on the dashboard (for the runbot fetch)
  _branches() {
    const seen = new Set();
    for (const tgt of this.targets)
      for (const row of this.rows(tgt)) if (row.present) seen.add(row.branch);
    return [...seen];
  }

  // the unique {github, number} of every PR shown on the dashboard (for mergebot)
  _prs() {
    const seen = new Set();
    const prs = [];
    for (const tgt of this.targets) {
      for (const row of this.rows(tgt)) {
        if (!row.pr || !row.github) continue;
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

  // color category for a mergebot state
  mbClass(row) {
    const s = this.mbState(row);
    if (s === "merged") return "merged";
    if (["ready", "approved", "validated", "mergeable", "reviewed"].includes(s)) return "ready";
    if (["staged", "staging", "squashed", "pending"].includes(s)) return "progress";
    if (["blocked", "error"].includes(s)) return "blocked";
    return "other";
  }

  // the fetched runbot status for a row's branch ("" if unknown / not fetched)
  rbState(row) {
    return this.code.runbot()[row.branch] || "";
  }

  // CI badge model for a card repo row, mapping runbot status -> design states
  ciBadge(row) {
    const s = this.rbState(row);
    if (s === "success") return { cls: "pass", label: "ok", title: "passing" };
    if (s === "failure") return { cls: "fail", label: "ko", title: "failing" };
    if (s === "pending") return { cls: "run", label: "running", title: "running" };
    return { cls: "unknown", label: "—", title: "unknown" };
  }

  // backend reachable but odoo not running — offer a one-click start on the
  // active target's card (mirrors the navbar Start button)
  get serverStopped() {
    return this.server.status().state === "stopped";
  }

  // server up (or coming up) — offer Stop in the same spot
  get serverRunning() {
    const s = this.server.status().state;
    return s === "running" || s === "starting";
  }

  // shutting down — keep Stop visible but disabled until it reaches "stopped"
  // (so the button doesn't flicker out before Start can appear)
  get serverStopping() {
    return this.server.status().state === "stopping";
  }

  // the currently active target (checked out + last started), or null — the
  // control-panel Start/Stop buttons act on it
  get activeTarget() {
    return this.config.config.targets.find((t) => this.isActive(t)) || null;
  }

  get stamp() {
    if (this.code.loading()) return "refreshing…";
    return this.code.at() ? `updated ${timeAgo(new Date(this.code.at()).toISOString())}` : "";
  }

  get errors() {
    return this.code.groups().errors;
  }

  // favorite repositories with their current state (for the dashboard summary)
  get favRepos() {
    const byId = Object.fromEntries(this.code.branchRepos().map((r) => [r.id, r]));
    const groups = this.code.groups();
    return this.config.config.repos
      .filter((r) => r.favorite)
      .map((r) => {
        const b = byId[r.id] || {};
        return {
          id: r.id,
          current: b.current || "",
          dirty: !!b.dirty,
          subject: b.head_subject || "",
          date: b.head_date || "",
          error: b.error || "",
          github: groups.githubByRepo[r.id] || "",
          path: groups.pathByRepo[r.id] || "",
        };
      });
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

  // every shown repository whose current branch can be fetched + rebased
  get rebasableRepos() {
    return this.favRepos.filter((r) => this.canRebaseRepo(r));
  }

  canRebaseAll() {
    return this.rebasableRepos.length > 0;
  }

  rebaseAllTitle() {
    const n = this.rebasableRepos.length;
    if (!n) return "nothing to rebase — repositories are dirty, missing, or have no canonical remote";
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

  // favorite targets only, ordered by last activity (most recent first)
  get targets() {
    return this.config.config.targets
      .filter((t) => t.favorite)
      .map((t) => ({ t, activity: this._activity(t) }))
      .sort((a, b) => b.activity - a.activity)
      .map((x) => x.t);
  }

  // most recent timestamp across a target's branches + their PRs (0 if none)
  _activity(tgt) {
    let last = 0;
    for (const row of this.rows(tgt)) {
      if (row.date) last = Math.max(last, Date.parse(row.date) || 0);
      if (row.pr && row.pr.updatedAt) last = Math.max(last, Date.parse(row.pr.updatedAt) || 0);
    }
    return last;
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
        github: groups.githubByRepo[repo] || "",
        present: !!b,
        remote: !!b && b.remote,
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
  // while its branches are still checked out. The name check disambiguates
  // overlapping targets (e.g. master vs master(e), whose branches are a subset)
  isActive(tgt) {
    return tgt.name === this.server.lastTarget() && this._checkedOut(tgt);
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
    return !this.isActive(tgt) && this._targetPresent(tgt) && !this._targetDirty(tgt);
  }

  activateTitle(tgt) {
    if (this._targetDirty(tgt)) return "commit or stash changes first — the working tree is dirty";
    if (!this._targetPresent(tgt)) return "some of this target's branches are missing locally";
    return "stop the server, switch to this target and check out its branches";
  }

  // stop the server, switch to this target, check out its branches
  async activate(tgt) {
    if (!this.canActivate(tgt)) return;
    const pathByRepo = this.code.groups().pathByRepo;
    const repos = (tgt.config || [])
      .map(({ repo, branch }) => ({ path: pathByRepo[repo], branch }))
      .filter((r) => r.path);
    const s = this.server.status().state;
    if (s === "running" || s === "starting") await this.server.stop();
    await this.code.checkout(repos);
    this.server.setLastTarget(tgt.name);
  }

  // the canonical base branch a branch derives from: master-owl-update -> master,
  // 19.0-some-fix -> 19.0 (defaults to master)
  _baseBranch(branch) {
    return (/^(saas-\d+\.\d+|\d+\.\d+|master)/.exec(branch) || ["", "master"])[1];
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
          <button class="pbtn primary" t-att-disabled="!this.stopped" t-on-click="() => this.server.start(this.target(), this.extraArgs())"><span class="play"/>Start</button>
          <button class="pbtn stop" t-att-disabled="!this.canStop" t-on-click="() => this.server.stop()"><span class="ic square"/>Stop</button>
          <button class="pbtn" t-att-disabled="!this.active" t-on-click="() => this.server.restart(this.target(), this.extraArgs())"><span class="restart"/>Restart</button>
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
              <option t-foreach="this.targets" t-as="tgt" t-key="tgt.name" t-att-value="tgt.name" t-out="tgt.name"/>
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
  copyIcon = m(ICONS.copy);
  clearIcon = m(ICONS.clear);
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

  // last used target if it still exists, else the first one
  _initialTarget() {
    const names = this.targets.map((t) => t.name);
    const last = this.server.lastTarget();
    return names.includes(last) ? last : names[0] || "";
  }

  status() {
    return this.server.status();
  }

  get stopped() {
    return this.status().state === "stopped";
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
    if (!s.db) return null;
    let html = `database: <b>${s.db}</b>`;
    if (s.odoo_version) {
      html += `<span class="sep">·</span>odoo: <b>${s.odoo_version}</b>`;
      if (s.enterprise) html += ` (enterprise)`;
    }
    if (s.target) html += `<span class="sep">·</span>target: <b>${s.target}</b>`;
    return m(html);
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
          <span class="row-count" t-out="this.count"/>
        </div>
      </div>
      <div class="content">
        <div class="db-list" t-att-class="{busy: this.db.dropping()}">
          <div t-if="this.db.error()" class="dim" t-out="'Failed to load: ' + this.db.error()"/>
          <div t-elif="!this.db.databases().length" class="dim">No databases.</div>
          <table t-else="" class="db-table">
            <thead><tr><th>Name</th><th>Odoo version</th><th>Created</th><th>Last activity</th><th/></tr></thead>
            <tbody>
              <tr t-foreach="this.rows()" t-as="d" t-key="d.name" t-att-class="{'db-active': d.active}">
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

  db = plugin(DatabasePlugin);
  refreshIcon = m(ICONS.refresh);
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
}

// ─────────────────────────── Targets screen ───────────────────────────

// First-class targets: name, favorite flag, config (repo:branch pairs), db and
// start args. The list is read-only except for starring; "New target" swaps the
// main area for a creation form seeded (as placeholders) from a target template.
class TargetsScreen extends Component {
  static template = xml`
    <section>
      <div class="panel">
        <div class="panel-top"><h1>Targets</h1></div>
        <div class="panel-actions">
          <select t-if="!this.creating()" class="preset-select" t-att-value="this.preset()" t-on-change="ev => this.preset.set(ev.target.value)" title="prefill a new target from an existing one">
            <option value="">Blank</option>
            <option t-foreach="this.targets" t-as="tgt" t-key="tgt.name" t-att-value="tgt.name" t-out="tgt.name"/>
          </select>
          <button t-if="!this.creating()" class="pbtn primary" t-on-click="() => this.startCreate()">New target</button>
          <t t-else="">
            <button class="pbtn primary" t-on-click="() => this.save()">Save</button>
            <button class="pbtn" t-on-click="() => this.discard()">Discard</button>
            <span t-if="this.error()" class="form-error" t-out="this.error()"/>
          </t>
          <span t-if="!this.creating()" class="row-count" t-out="this.count"/>
        </div>
      </div>
      <div class="content">
        <div t-if="this.creating()" class="launch-form">
          <h2 class="subtitle" t-out="this.editName() ? 'Editing ' + this.editName() : 'New target'"/>
          <div class="launch-field">
            <label>Name</label>
            <input type="text" t-att-value="this.draftName()" placeholder="name (e.g. master-mytask)" t-on-input="ev => this.draftName.set(ev.target.value)"/>
          </div>
          <div class="launch-field">
            <label>Config</label>
            <input type="text" t-att-value="this.draftConfig()" placeholder="community:master,enterprise:master" t-on-input="ev => this.draftConfig.set(ev.target.value)"/>
          </div>
          <div class="launch-field">
            <label>Database</label>
            <input type="text" t-att-value="this.draftDb()" placeholder="database name" t-on-input="ev => this.draftDb.set(ev.target.value)"/>
          </div>
          <div class="launch-field">
            <label>Start args</label>
            <input type="text" t-att-value="this.draftArgs()" placeholder="-i sale_management" t-on-input="ev => this.draftArgs.set(ev.target.value)"/>
          </div>
          <div class="launch-field">
            <label>Favorite</label>
            <label class="edit-check"><input type="checkbox" t-att-checked="this.draftFav()" t-on-change="ev => this.draftFav.set(ev.target.checked)"/> starred</label>
          </div>
        </div>
        <t t-else="">
          <div t-if="!this.targets.length" class="dim">No targets.</div>
          <table t-else="" class="db-table">
            <thead><tr><th/><th>Name</th><th>Config</th><th>Database</th><th>Start args</th><th/></tr></thead>
            <tbody>
              <tr t-foreach="this.targets" t-as="tgt" t-key="tgt.name">
                <td class="pr-branch">
                  <button class="fav-star" t-att-class="{'is-fav': tgt.favorite}" t-on-click="() => this.toggleFavorite(tgt.name)"><t t-out="this.starIcon"/></button>
                </td>
                <td t-out="tgt.name"/>
                <td class="dim" t-out="this.fmtConfig(tgt)"/>
                <td t-out="tgt.db"/>
                <td class="dim" t-out="tgt.on_create_args || '—'"/>
                <td class="db-actions">
                  <button class="drop-btn pr-close" t-on-click="() => this.startEdit(tgt)">Edit</button>
                  <button class="drop-btn" t-on-click="() => this.deleteTarget(tgt.name)">Delete</button>
                </td>
              </tr>
            </tbody>
          </table>
        </t>
      </div>
    </section>`;

  config = plugin(ConfigPlugin);
  starIcon = m(ICONS.star);
  creating = signal(false);
  editName = signal(""); // "" while creating; the edited target's original name otherwise
  preset = signal(""); // existing target to prefill a new one from ("" = blank)
  draftName = signal("");
  draftConfig = signal("");
  draftDb = signal("");
  draftArgs = signal("");
  draftFav = signal(false);
  error = signal("");

  // favorites first, otherwise keep configured order
  get targets() {
    return [...this.config.config.targets].sort(
      (a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0),
    );
  }

  get count() {
    const n = this.targets.length;
    return `${n} target${n === 1 ? "" : "s"}`;
  }

  fmtConfig(tgt) {
    return (tgt.config || []).map((c) => `${c.repo}:${c.branch}`).join(", ");
  }

  toggleFavorite(name) {
    const targets = this.config.config.targets.map((t) =>
      t.name === name ? { ...t, favorite: !t.favorite } : t,
    );
    this.config.updateConfig({ targets });
  }

  // prefill config/db/args/favorite from the selected preset target (if any);
  // the name stays blank since a new target needs its own unique name
  startCreate() {
    const src = this.config.config.targets.find((t) => t.name === this.preset());
    this.editName.set("");
    this.draftName.set("");
    this.draftConfig.set(src ? repoBranchList.format(src.config) : "");
    this.draftDb.set(src ? src.db || "" : "");
    this.draftArgs.set(src ? src.on_create_args || "" : "");
    this.draftFav.set(src ? !!src.favorite : false);
    this.error.set("");
    this.creating.set(true);
  }

  // open the form on an existing target, fields pre-filled with its values
  startEdit(tgt) {
    this.editName.set(tgt.name);
    this.draftName.set(tgt.name);
    this.draftConfig.set(repoBranchList.format(tgt.config));
    this.draftDb.set(tgt.db || "");
    this.draftArgs.set(tgt.on_create_args || "");
    this.draftFav.set(!!tgt.favorite);
    this.error.set("");
    this.creating.set(true);
  }

  deleteTarget(name) {
    if (!confirm(`Delete target "${name}"?`)) return;
    this.config.updateConfig({
      targets: this.config.config.targets.filter((t) => t.name !== name),
    });
  }

  discard() {
    this.creating.set(false);
    this.error.set("");
  }

  save() {
    const editing = this.editName();
    const name = this.draftName().trim();
    if (!name) return this.error.set("a name is required");
    if (this.config.config.targets.some((t) => t.name === name && t.name !== editing))
      return this.error.set(`a target named "${name}" already exists`);
    const config = repoBranchList.parse(this.draftConfig().trim());
    if (!config.length) return this.error.set("a config is required");
    const target = {
      name,
      favorite: this.draftFav(),
      config,
      db: this.draftDb().trim(),
      on_create_args: this.draftArgs().trim(),
    };
    const targets = this.config.config.targets;
    this.config.updateConfig({
      targets: editing
        ? targets.map((t) => (t.name === editing ? target : t))
        : [...targets, target],
    });
    this.creating.set(false);
  }
}

// ─────────────────────────── Branches screen ───────────────────────────
// flat list (one row per branch × repo) over the same data the Dashboard tab loads

class BranchesScreen extends Component {
  static components = { SearchBox };
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
          <span class="row-count" t-out="this.count"/>
        </div>
      </div>
      <div class="content br-fill">
        <div t-att-class="{busy: this.code.busy()}">
          <div t-if="this.code.error()" class="dim br-empty" t-out="'Failed to load: ' + this.code.error()"/>
          <div t-elif="!this.groups().length" class="dim br-empty">No branches.</div>
          <div t-else="" class="br-card">
            <table class="br-table">
              <thead>
                <tr>
                  <th class="br-sort" t-on-click="() => this.sort('name')">Branch<span class="br-arrow" t-out="this.sortArrow('name')"/></th>
                  <th>Repository</th>
                  <th class="br-sort" t-on-click="() => this.sort('update')">Last update<span class="br-arrow" t-out="this.sortArrow('update')"/></th>
                  <th>PR</th>
                  <th/><th class="br-spacer"/>
                </tr>
              </thead>
              <tbody t-foreach="this.groups()" t-as="g" t-key="g.name">
                <tr t-foreach="g.repos" t-as="r" t-key="r.repo" t-att-class="{active: r.active}">
                  <td t-if="r_index === 0" t-att-rowspan="g.repos.length" class="br-name">
                    <div class="br-name-inner">
                      <button class="fav-star" t-att-class="{'is-fav': g.favorite}" t-on-click="() => this.code.toggleFavorite(g.name)"><t t-out="this.starIcon"/></button>
                      <span class="br-branch" t-out="g.name"/>
                    </div>
                  </td>
                  <td class="br-repo">
                    <a t-if="r.remote and r.github" class="br-repo-link" target="_blank" t-att-href="this.code.remoteBranchUrl(r.github, r.branch)" t-att-title="'open the ' + r.repo + ' branch on GitHub'"><t t-out="r.repo"/><t t-out="this.externalIcon"/></a>
                    <span t-else="" t-out="r.repo"/>
                    <span t-if="r.dirty" class="dirty-mark" title="uncommitted changes">*</span>
                  </td>
                  <td class="br-when" t-att-title="r.date" t-out="r.date ? this.cell(r.date) : '—'"/>
                  <td class="br-pr">
                    <t t-if="r.pr">
                      <a class="pr-link" target="_blank" t-att-href="r.pr.url" t-out="'#' + r.pr.number"/>
                      <span class="pr-state" t-att-class="this.prState(r.pr)" t-out="this.prState(r.pr)"/>
                    </t>
                    <t t-else="">—</t>
                  </td>
                  <td>
                    <div class="br-act">
                      <button t-if="!r.remote" class="drop-btn pr-open"
                              t-on-click="() => this.code.pushBranch(r.path, r.branch)"
                              title="push this branch to the dev remote (odoo-dev)">Push</button>
                      <button t-if="!r.base and r.remote and r.github and !r.pr" class="drop-btn pr-open"
                              t-on-click="() => this.openPr(r)">Open PR</button>
                      <button t-if="r.pr and r.github and r.pr.state === 'OPEN'" class="drop-btn pr-close"
                              t-on-click="() => this.code.closePr(r.github, r.pr.number)">Close PR</button>
                      <button class="drop-btn checkout" t-att-disabled="!!this.checkoutBlocked(r)"
                              t-att-title="this.checkoutBlocked(r) || ('check out ' + r.branch + ' in ' + r.repo)"
                              t-on-click="() => this.checkout(r)">Checkout</button>
                      <button class="drop-btn" t-att-disabled="!!this.deleteBlocked(r)" t-att-title="this.deleteBlocked(r)"
                              t-on-click="() => this.code.deleteBranch(r.branch, r.repo, r.path, r.remote and !r.base)">Delete</button>
                    </div>
                  </td>
                  <td class="br-spacer"/>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>`;

  code = plugin(CodePlugin);
  refreshIcon = m(ICONS.refresh);
  starIcon = m(ICONS.star);
  externalIcon = m(ICONS.external);
  repoFilter = signal(""); // "" = all repositories
  search = signal("");
  sortKey = signal("name"); // "name" | "update"
  sortDir = signal("asc"); // "asc" | "desc"
  // branches grouped by name (one group per branch name). Each group carries its
  // repo rows and is "active" when the branch is checked out in any of its repos.
  // Sorted by the chosen column (branch name, or summed last-update time).
  groups = computed(() => {
    const { prIndex, pathByRepo, githubByRepo } = this.code.groups();
    const favs = this.code.favorites();
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
        favorite: favs.includes(name),
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
    window.open(this.code.prCreateUrl(row.github, row.branch), "_blank");
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
    this.code.checkout([{ path: row.path, branch: row.branch }]);
  }

  // why a branch can't be deleted ("" = deletable). Deleting closes an open PR
  // (it removes the head branch), so require closing the PR first.
  deleteBlocked(row) {
    if (row.active) return "cannot delete the checked-out branch";
    if (row.pr && row.pr.state === "OPEN") return `close PR #${row.pr.number} first`;
    return "";
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

// Flat list of every PR across repos (gh pr list --author @me), newest first.
class PrsScreen extends Component {
  static components = { SearchBox };
  static template = xml`
    <section>
      <div class="panel">
        <div class="panel-top has-filters">
          <h1>PRs</h1>
          <div class="panel-filters">
            <SearchBox value="this.search"/>
            <select t-att-value="this.repoFilter()" t-on-change="ev => this.repoFilter.set(ev.target.value)" title="filter by repository">
              <option value="">All repositories</option>
              <option t-foreach="this.repos" t-as="r" t-key="r" t-att-value="r" t-out="r"/>
            </select>
            <button class="pbtn" t-att-class="{active: this.openOnly()}" t-on-click="() => this.openOnly.set(!this.openOnly())">Open</button>
          </div>
          <div class="panel-top-right">
            <span class="meta" t-out="this.stamp"/>
            <button class="pbtn" t-on-click="() => this.code.load(true)"><t t-out="this.refreshIcon"/>Refresh</button>
          </div>
        </div>
        <div class="panel-actions">
          <span class="row-count" t-out="this.count"/>
        </div>
      </div>
      <div class="content">
        <div t-att-class="{busy: this.code.busy()}">
          <div t-foreach="this.errors" t-as="e" t-key="e.id" class="dim" t-out="e.id + ': ' + e.error"/>
          <div t-if="this.code.error()" class="dim" t-out="'Failed to load: ' + this.code.error()"/>
          <div t-elif="!this.rows().length" class="dim">No pull requests.</div>
          <table t-else="" class="db-table">
            <thead><tr><th>PR</th><th>Title</th><th>Repository</th><th>Branch</th><th>State</th><th>Last update</th><th/></tr></thead>
            <tbody>
              <tr t-foreach="this.rows()" t-as="row" t-key="row.repo + ':' + row.number">
                <td><a class="pr-link" target="_blank" t-att-href="row.url" t-out="'#' + row.number"/></td>
                <td t-att-title="row.title" t-out="row.title || '—'"/>
                <td class="dim" t-out="row.repo"/>
                <td t-out="row.branch"/>
                <td><span class="pr-state" t-att-class="this.prState(row)" t-out="this.prState(row)"/></td>
                <td t-att-title="row.updatedAt" t-out="row.updatedAt ? this.cell(row.updatedAt) : '—'"/>
                <td class="db-actions">
                  <button t-if="row.state === 'OPEN' and row.github" class="drop-btn pr-close"
                          t-on-click="() => this.code.closePr(row.github, row.number)">Close PR</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>`;

  code = plugin(CodePlugin);
  refreshIcon = m(ICONS.refresh);
  openOnly = signal(true); // show only open PRs by default
  repoFilter = signal(""); // "" = all repositories
  search = signal("");

  setup() {
    this.code.load();
  }

  get stamp() {
    if (this.code.loading()) return "refreshing…";
    return this.code.at() ? `updated ${timeAgo(new Date(this.code.at()).toISOString())}` : "";
  }

  get errors() {
    return this.code.prRepos().filter((r) => r.error);
  }

  // repositories present in the loaded data (for the filter dropdown)
  get repos() {
    return this.code.prRepos().map((r) => r.id);
  }

  get count() {
    const n = this.rows().length;
    return `${n} PR${n === 1 ? "" : "s"}`;
  }

  // every PR across repos, newest first (open-only unless the filter is off)
  rows() {
    const openOnly = this.openOnly();
    const repoFilter = this.repoFilter();
    const q = this.search().trim().toLowerCase();
    const list = [];
    for (const repo of this.code.prRepos()) {
      if (repo.error) continue;
      if (repoFilter && repo.id !== repoFilter) continue;
      for (const pr of repo.prs) {
        if (openOnly && pr.state !== "OPEN") continue;
        if (
          q &&
          !`${pr.title} ${pr.headRefName} #${pr.number} ${repo.id}`.toLowerCase().includes(q)
        )
          continue;
        list.push({
          number: pr.number,
          title: pr.title || "",
          url: pr.url,
          repo: repo.id,
          github: repo.github,
          branch: pr.headRefName,
          state: pr.state,
          isDraft: pr.isDraft,
          updatedAt: pr.updatedAt,
        });
      }
    }
    return list.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  }

  cell(date) {
    return timeAgo(date);
  }

  prState(p) {
    const st = p.isDraft && p.state === "OPEN" ? "DRAFT" : p.state;
    return st.toLowerCase();
  }
}

// ─────────────────────────── Tests screen ───────────────────────────

class TestsScreen extends Component {
  static components = { LogConsole };
  static template = xml`
    <section>
      <div class="panel">
        <div class="panel-top"><h1>Tests</h1><span class="meta" t-out="this.meta"/></div>
        <div class="panel-actions">
          <form class="test-form" t-on-submit.prevent="() => this.run()">
            <select class="preset-select" t-on-change="(ev) => this.onPreset(ev)" title="presets and recent test tags">
              <option value="">Presets</option>
              <option value="/web:WebSuite[@web]">/web:WebSuite[@web]</option>
              <optgroup t-if="this.tests.history().length" label="Recent">
                <option t-foreach="this.tests.history()" t-as="h" t-key="h_index" t-att-value="h" t-out="h"/>
              </optgroup>
            </select>
            <input type="text" t-att-value="this.tags()" t-on-input="ev => this.tags.set(ev.target.value)" autocomplete="off"
                   placeholder="--test-tags, e.g. my_module, :TestClass, /module_tour"/>
            <button type="submit" t-att-disabled="!this.tests.target"><span class="play"/>Run</button>
            <button type="button" class="stop" t-att-disabled="!this.tests.running" t-on-click="() => this.server.stop()"><span class="ic square"/>Stop</button>
            <div class="log-controls">
              <label class="toggle" t-att-class="{on: this.tests.output.autoScroll()}" t-on-click="() => this.toggleAuto()"><span class="switch"/>Autoscroll</label>
              <button type="button" class="tool-btn" t-on-click="() => this.tests.output.clear()"><t t-out="this.clearIcon"/>Clear</button>
            </div>
          </form>
        </div>
      </div>
      <div class="content flush">
        <LogConsole title="'Test output'" buffer="this.tests.output" bare="true"/>
      </div>
    </section>`;

  tests = plugin(TestsPlugin);
  server = plugin(ServerPlugin);
  clearIcon = m(ICONS.clear);
  tags = signal("");

  get meta() {
    const t = this.tests.target;
    if (!t) return "no target configured";
    const st = this.tests.status();
    return `target: ${t}${st ? " · " + st : ""}`;
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
            <div t-if="this.addons.loading()" class="dim">Loading…</div>
            <div t-elif="this.addons.error()" class="dim" t-out="'Failed to load: ' + this.addons.error()"/>
            <div t-elif="!this.view.total" class="dim">No modules match.</div>
            <t t-else="">
              <div class="addons-grid">
                <div t-foreach="this.view.shown" t-as="mod" t-key="mod.name" class="addon-card" t-att-class="{installed: mod.state === 'installed'}">
                  <div class="addon-card-row">
                    <div class="addon-card-name" t-att-title="mod.summary" t-out="mod.name"/>
                    <span class="addon-state" t-att-class="this.stateClass(mod)" t-out="mod.state || 'not installed'"/>
                  </div>
                  <div class="addon-card-row">
                    <div class="addon-card-repo" t-out="mod.repo"/>
                    <button class="addon-btn" t-att-disabled="this.addons.runActive() or mod.installable === false"
                            t-on-click="() => this.addons.run(mod.state === 'installed' ? 'upgrade' : 'install', mod.name)"
                            t-out="mod.state === 'installed' ? 'Upgrade' : 'Install'"/>
                  </div>
                </div>
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
      if (db && db !== this.addons.loadedDb() && !this.addons.loading()) this.addons.load();
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
      <div class="rows">
        <div t-foreach="this.rows()" t-as="row" t-key="row_index" class="edit-row">
          <t t-foreach="this.spec.fields" t-as="f" t-key="f.key">
            <label t-if="f.type === 'checkbox'" class="edit-check" t-att-title="f.title || f.name">
              <input type="checkbox" t-att-checked="row[f.key]" t-on-change="ev => row[f.key] = ev.target.checked"/>
              <t t-out="f.name"/>
            </label>
            <input t-else="" t-att-class="f.className" t-att-placeholder="f.placeholder"
                   t-att-value="row[f.key]" t-on-input="ev => row[f.key] = ev.target.value"/>
          </t>
          <button class="row-remove" title="remove" t-on-click="() => this.removeRow(row_index)">✕</button>
        </div>
      </div>
      <div class="config-actions">
        <button t-on-click="() => this.addRow()" t-out="'Add ' + this.spec.itemName"/>
        <button t-on-click="() => this.save()">Save</button>
        <button t-on-click="() => this.reset()">Reset to defaults</button>
        <span t-att-class="this.msgCls()" t-out="this.msgText()"/>
      </div>
    </div>`;

  props = props({ kind: t.string() });
  config = plugin(ConfigPlugin);
  spec = SPECS[this.props.kind];
  rows = signal([]);
  msgText = signal("");
  msgCls = signal("");
  setup() {
    this.load();
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
  }

  flash(text, isError) {
    this.msgText.set(text);
    this.msgCls.set(isError ? "error" : "ok");
    if (!isError) setTimeout(() => this.msgText.set(""), 2000);
  }

  save() {
    const items = [];
    const seen = new Set();
    for (const row of this.rows()) {
      const raw = {};
      for (const f of this.spec.fields)
        raw[f.key] = f.type === "checkbox" ? !!row[f.key] : (row[f.key] || "").trim();
      if (this.spec.fields.every((f) => !raw[f.key])) continue;
      for (const f of this.spec.fields) {
        if (!f.optional && !raw[f.key])
          return this.flash(`every ${this.spec.itemName} needs a ${f.name}`, true);
      }
      const keyVal = raw[this.spec.fields[0].key]; // first field is the identity
      if (seen.has(keyVal))
        return this.flash(`duplicate ${this.spec.fields[0].name} "${keyVal}"`, true);
      seen.add(keyVal);
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

// scalar config fields editable in the Config tab's Settings block
const SETTINGS_FIELDS = [
  { key: "venv_activate", name: "venv activate" },
  { key: "start_cmd", name: "start server command" },
  { key: "db_user", name: "database user" },
  { key: "db_password", name: "database password" },
];

class ConfigScreen extends Component {
  static components = { ListEditor };
  static template = xml`
    <section>
      <div class="panel"><div class="panel-top"><h1>Config</h1></div></div>
      <div class="content">
        <div class="config-block">
          <h2 class="subtitle">Settings</h2>
          <div class="settings-grid">
            <t t-foreach="this.settingsFields" t-as="f" t-key="f.key">
              <label t-out="f.name"/>
              <input type="text" class="edit-input" autocomplete="off" t-att-value="this.settings()[f.key]" t-on-input="ev => this.setSetting(f.key, ev.target.value)"/>
            </t>
          </div>
          <div class="config-actions">
            <button t-on-click="() => this.saveSettings()">Save</button>
            <button t-on-click="() => this.resetSettings()">Reset to defaults</button>
            <span t-att-class="this.settingsMsg() === 'saved' ? 'ok' : ''" t-out="this.settingsMsg()"/>
          </div>
        </div>
        <ListEditor kind="'repos'"/>
        <ListEditor kind="'links'"/>
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
  path = signal(this.config.getDataFile());
  msg = signal("");
  backupMsg = signal("");
  settingsFields = SETTINGS_FIELDS;
  settings = signal(this._loadSettings());
  settingsMsg = signal("");

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
    this.settings.set(this._loadSettings());
    this.settingsMsg.set("saved");
    setTimeout(() => this.settingsMsg.set(""), 2000);
  }

  resetSettings() {
    if (!confirm("Reset settings to the built-in defaults?")) return;
    for (const f of SETTINGS_FIELDS) this.config.resetKey(f.key);
    this.settings.set(this._loadSettings());
    this.settingsMsg.set("reset to defaults");
    setTimeout(() => this.settingsMsg.set(""), 2000);
  }

  triggerImport() {
    document.getElementById("goo-import-file").click();
  }

  async resetAll() {
    if (
      !confirm(
        "Reset the complete config to its initial state?\n\nThis erases all your customizations (settings, repos, targets, links, favorites, last target, history) and cannot be undone.",
      )
    )
      return;
    await this.config.resetConfig();
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

// ─────────────────────────── Branch action popover ───────────────────────────

class BranchMenu extends Component {
  static template = xml`
    <div class="branch-popover" t-att-class="{hidden: !this.open()}" t-on-click.stop="() => {}">
      <button t-foreach="this.actions()" t-as="a" t-key="a_index" class="branch-popover-item"
              t-att-class="{danger: a.danger}" t-att-disabled="a.disabled" t-att-title="a.title || ''"
              t-on-click="() => this.select(a)" t-out="a.label"/>
    </div>`;

  code = plugin(CodePlugin);
  open = signal(false);
  actions = signal([]);
  el = null;
  setup() {
    onMounted(() => {
      this.el = document.querySelector(".branch-popover");
      appBus.addEventListener("branch-menu", (e) => this.openMenu(e.detail));
      document.addEventListener("click", () => this.close());
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") this.close();
      });
    });
  }

  close() {
    this.open.set(false);
  }

  async openMenu({ ev, group, vm }) {
    const { actions, resolvers } = this.buildActions(group, vm);
    this.actions.set(actions); // a deep proxy array
    this.open.set(true);
    await Promise.resolve();
    const r = ev.currentTarget.getBoundingClientRect();
    const w = this.el.offsetWidth;
    this.el.style.top = `${r.bottom + 4}px`;
    this.el.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - w - 12))}px`;
    for (const { index, run } of resolvers) {
      run().then((patch) => Object.assign(this.actions()[index], patch));
    }
  }

  select(a) {
    if (!a.disabled && a.onClick) {
      this.close();
      a.onClick();
    }
  }

  buildActions(group, vm) {
    const code = this.code;
    const actions = [];
    const resolvers = [];
    for (const r of group.rows) {
      const github = vm.githubByRepo[r.repo];
      if (!github) continue;
      const path = vm.pathByRepo[r.repo];
      const pr = vm.prIndex[`${r.repo}:${group.branch}`];
      const linkAction = {
        label: `Branch on GitHub — ${r.repo}`,
        disabled: false,
        onClick: () => window.open(code.forkBranchUrl(github, group.branch), "_blank"),
      };
      actions.push({ label: `Checking GitHub… — ${r.repo}`, disabled: true });
      resolvers.push({
        index: actions.length - 1,
        run: async () => {
          if (pr || r.remote) return linkAction;
          try {
            return (await code.remoteExists(path, group.branch))
              ? linkAction
              : {
                  label: `Push branch to GitHub — ${r.repo}`,
                  disabled: false,
                  onClick: () => code.pushBranch(path, group.branch),
                };
          } catch (e) {
            return { label: `GitHub check failed — ${r.repo}`, disabled: true, title: e.message };
          }
        },
      });
      if (!pr)
        actions.push({
          label: `Create PR — ${r.repo}`,
          onClick: () => window.open(code.prCreateUrl(github, group.branch), "_blank"),
        });
      else if (pr.state === "OPEN")
        actions.push({
          label: `Close PR #${pr.number} — ${r.repo}`,
          danger: true,
          onClick: () => code.closePr(github, pr.number),
        });
    }
    for (const r of group.rows) {
      actions.push({
        label: `Delete local branch — ${r.repo}`,
        danger: true,
        disabled: r.checkedOut,
        title: r.checkedOut ? "currently checked out" : "",
        onClick: () => code.deleteBranch(group.branch, r.repo, vm.pathByRepo[r.repo]),
      });
    }
    actions.push({ label: "Rebase onto base", disabled: true, title: "coming soon" });
    return { actions: proxy(actions), resolvers };
  }
}

// ─────────────────────────── Root ───────────────────────────

const SCREENS = {
  dashboard: DashboardScreen,
  server: ServerScreen,
  targets: TargetsScreen,
  branches: BranchesScreen,
  prs: PrsScreen,
  tests: TestsScreen,
  databases: DatabasesScreen,
  addons: AddonsScreen,
  config: ConfigScreen,
};

export class App extends Component {
  static components = {
    Topbar,
    Sidebar,
    DashboardScreen,
    ServerScreen,
    TargetsScreen,
    BranchesScreen,
    PrsScreen,
    TestsScreen,
    DatabasesScreen,
    AddonsScreen,
    ConfigScreen,
    BranchMenu,
  };

  static template = xml`
    <div class="app">
      <Topbar/>
      <div class="body">
        <Sidebar/>
        <main><t t-component="this.currentScreen()"/></main>
      </div>
      <BranchMenu/>
    </div>`;

  router = plugin(RouterPlugin);
  server = plugin(ServerPlugin);
  // the active screen's component class (a class, not an instance)
  currentScreen = computed(() => SCREENS[this.router.section()] || DashboardScreen);
  setup() {
    useEffect(() => {
      const state = this.server.status().state;
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
  links: {
    key: "links",
    title: "Navbar links",
    itemName: "link",
    fields: [
      { key: "label", name: "label", placeholder: "label (e.g. /odoo)", className: "w-name" },
      { key: "href", name: "href", placeholder: "href (e.g. https://…)", className: "w-flex" },
    ],
    validate() {
      return null;
    },
  },
};
