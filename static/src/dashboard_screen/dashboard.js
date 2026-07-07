import { Component, onMounted, onWillUnmount, plugin, signal, useEffect, xml } from "@odoo/owl";
import { BASE_BRANCH_RE } from "../core/config.js";
import { timeAgo } from "../core/utils.js";
import { CodePlugin } from "../core/code_plugin.js";
import { ConfigPlugin } from "../core/config_plugin.js";
import { DatabasePlugin } from "../core/database_plugin.js";
import { DialogPlugin } from "../core/dialog_plugin.js";
import { EventLogPlugin } from "../core/event_log_plugin.js";
import { ReviewPlugin } from "../core/review_plugin.js";
import { RouterPlugin } from "../core/router_plugin.js";
import { ServerPlugin } from "../core/server_plugin.js";
import { WorktreePlugin } from "../core/worktree_plugin.js";
import { DirtyBadge, ICONS, appBus, m, mbCategory } from "../core/common.js";
import { Panel } from "../core/panel.js";
import { CommitsDialog } from "../core/dialogs.js";

import {
  deleteTargetDialog,
  pushBranchesDialog,
  startCreateTarget,
} from "../targets_screen/targets.js";

export class DashboardScreen extends Component {
  static components = { DirtyBadge, Panel };
  static template = xml`
    <section>
      <Panel title="'Dashboard'">
        <t t-set-slot="top-right">
          <span class="meta" t-out="this.stamp"/>
          <button class="pbtn" t-on-click="() => this._dashLoad(true)"><t t-out="this.refreshIcon"/>Refresh</button>
        </t>
        <t t-set-slot="bottom-left">
          <button class="dash-rebase" t-on-click="() => this.startCreate()">New target</button>
          <span class="dash-subtitle">Monitor repositories and switch between build targets.</span>
        </t>
      </Panel>
      <div class="content">
        <div t-att-class="{busy: this.code.busy()}">
          <div t-foreach="this.errors" t-as="e" t-key="e.id" class="dim" t-out="e.id + ': ' + e.error"/>

          <div class="dash-layout">
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
                    <span t-if="this.worktree.isWorktree(tgt)" class="wt-badge" role="button" title="worktree — open the Workspaces screen" t-on-click.stop="() => this.openWorktree(tgt)">wt</span>
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
                        <a t-if="row.pr and row.github and this.mbState(row)" class="dash-pr-state" t-att-class="this.mbClass(row)" target="_blank" t-att-href="this.code.mergebotUrl(row.github, row.pr.number)" t-att-title="'mergebot: ' + this.mbState(row) + (this.mbDetail(row) ? ' — missing: ' + this.mbDetail(row) : '')" t-out="this.mbState(row)"/>
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
  kebabIcon = m(ICONS.kebab);
  pushIcon = m(ICONS.push);
  terminalIcon = m(ICONS.terminal);
  historyIcon = m(ICONS.history);
  prIcon = m(ICONS.pr);
  menuId = signal(""); // id of the card whose kebab menu is open ("" = none)

  openWorktree(tgt) {
    this.worktree.select(tgt.id);
    this.router.go("workspaces");
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
    return (tgt.checkouts || [])
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
    for (const c of current?.checkouts || []) ids.add(c.repo);
    for (const tgt of this.targets) for (const c of tgt.checkouts || []) ids.add(c.repo);
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
    const branches = (tgt.checkouts || []).map((c) => c.branch).filter(Boolean);
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
    return (tgt.checkouts || []).map(({ repo, branch }) => {
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
    const cfg = tgt.checkouts || [];
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
    return (tgt.checkouts || []).some(({ repo }) => repos[repo]?.dirty);
  }

  _targetPresent(tgt) {
    const repos = this.repoMap;
    return (tgt.checkouts || []).every(({ repo, branch }) => repos[repo]?.branches.has(branch));
  }

  canActivate(tgt) {
    // a worktree target lives in its own checkout — its branch is checked out in the
    // worktree (git won't let the main tree check it out too), so it's never applied
    // here; it's started from the Workspaces screen instead
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
      return "worktree workspace — manage it from the Workspaces screen";
    if (this.isActive(tgt)) return "this target is active";
    if (this.canActivate(tgt)) return "click to apply — " + this.activateTitle(tgt);
    return this.activateTitle(tgt);
  }

  // stop the server, switch to this target, check out its branches — the action lives
  // on the Target model (it drives ServerPlugin/CodePlugin/EventLog itself)
  async activate(tgt) {
    if (!this.canActivate(tgt)) return;
    await this.config.target(tgt.id)?.activate();
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
    // PRs arrive already normalized (see models.js); each row just needs its
    // display repoLabel. Authored PRs carry createdAt (shown instead of updatedAt).
    // authored (Mine) — on the dashboard code PRs are narrowed to target/favorite
    // repos, but a starred branch you authored almost always lives in one of those
    for (const repo of this.code.prRepos()) {
      if (repo.error) continue;
      for (const pr of repo.prs) add({ ...pr, repoLabel: repo.id });
    }
    // reviewed (Reviewing) — fetched unnarrowed, so this covers review targets
    for (const pr of this.review.prs()) add({ ...pr, repoLabel: slugToId[pr.github] || pr.github });
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

// ─────────────────────────── Code screen ───────────────────────────

// Manipulate the main repository checkouts: the repositories sync strip, where
// each favorite/active-target repo shows its current branch and sync health and
// carries its per-repo git actions (rebase, push, open, commits, WIP/discard).
// (Worktree tooling will grow here too.)
