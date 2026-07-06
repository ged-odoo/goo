import { Component, onMounted, onWillUnmount, plugin, signal, useEffect, xml } from "@odoo/owl";
import { MERGEBOT } from "../core/config.js";
import { timeAgo } from "../core/utils.js";
import { CodePlugin } from "../core/code_plugin.js";
import { ConfigPlugin } from "../core/config_plugin.js";
import { DialogPlugin } from "../core/dialog_plugin.js";
import { ReviewPlugin } from "../core/review_plugin.js";
import { RouterPlugin } from "../core/router_plugin.js";
import { WorktreePlugin } from "../core/worktree_plugin.js";
import { ICONS, SearchBox, appBus, m, mbCategory } from "../core/common.js";

export class PrsScreen extends Component {
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

  // PRs of the active segment, filtered by search + repository. PRs arrive already
  // normalized (see models.js), so a row is just the PR plus its display repoLabel;
  // every downstream helper reads the unified fields. Mine rows carry createdAt —
  // the date column shows it for your own PRs (their updatedAt is noisy: it bumps on
  // any comment/label long after the work).
  rows() {
    const q = this.search().trim().toLowerCase();
    const repoFilter = this.repoFilter();
    let list;
    if (this.mode() === "mine") {
      list = [];
      for (const repo of this.code.prRepos()) {
        if (repo.error) continue;
        for (const pr of repo.prs) list.push({ ...pr, repoLabel: repo.id });
      }
    } else {
      list = this.review.prs().map((pr) => ({ ...pr, repoLabel: this.labelFor(pr.github) }));
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
