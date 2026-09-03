// Reviews: a curated watchlist of other people's PRs to review, r+, and follow
// through to merge (config.reviews). One row per tracked PR, grouped by branch
// name — the cross-repo convention a multi-repo task always shares — so a task
// spanning several repos gets one group with a rollup status and a single
// "create workspace for this task" action that resolves every repo's branch at
// once (createWorkspaceFromPRs, workspaces_screen/dialogs.js).

import { Component, computed, usePlugin, signal, useEffect, xml } from "@odoo/owl";
import { CodePlugin } from "../core/code_plugin.js";
import { ConfigPlugin } from "../core/config_plugin.js";
import { DatabasePlugin } from "../core/database_plugin.js";
import { DialogPlugin } from "../core/dialog_plugin.js";
import { EventLogPlugin } from "../core/event_log_plugin.js";
import { RouterPlugin } from "../core/router_plugin.js";
import { WorkspacePlugin } from "../core/workspace_plugin.js";
import { ClaudePlugin } from "../workspaces_screen/claude_plugin.js";
import { ReviewsPlugin } from "./reviews_plugin.js";
import { ReviewPanel } from "./review_panel.js";
import { appBus, ICONS, m } from "../core/common.js";
import { timeAgo, reviewScoreClass } from "../core/utils.js";
import { Panel } from "../core/panel.js";
import { RecordList, recordset } from "../core/recordset.js";
import {
  createReviewWorkspace,
  createWorkspaceFromPRs,
  runClaudeReview,
  REVIEW_CATEGORY,
} from "../workspaces_screen/dialogs.js";
import { ActionsCell } from "../branches_screen/cells.js";
import {
  ForwardPortsCell,
  isMerged,
  PrCell,
  STATUS_META,
  StatusCell,
  statusKey,
  taskFullyMerged,
  worstStatusKey,
} from "./cells.js";

// a pasted GitHub PR URL or "owner/repo#123" shorthand → {github, number}, or null
function parsePrRef(text) {
  const url = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/.exec(text);
  if (url) return { github: url[1], number: Number(url[2]) };
  const short = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(text.trim());
  if (short) return { github: short[1], number: Number(short[2]) };
  return null;
}

export class ReviewsScreen extends Component {
  static components = { Panel, RecordList };
  static template = xml`
    <section>
      <Panel title="'Reviews'">
        <t t-set-slot="title-extra">
          <div class="panel-inline-actions">
            <span class="sub" t-out="this.count"/>
          </div>
        </t>
        <t t-set-slot="top-middle">
          <form class="rev-add" t-on-submit.prevent="() => this.addPr()">
            <input type="text" t-att-value="this.addPrText()" autocomplete="off"
                   placeholder="PR URL or owner/repo#123"
                   t-on-input="ev => this.addPrText.set(ev.target.value)"/>
            <button type="submit" class="pbtn">Add PR</button>
          </form>
          <span t-if="this.addPrNote()" class="dim rev-add-note" t-out="this.addPrNote()"/>
          <select t-att-value="this.statusFilter()" t-on-change="ev => this.statusFilter.set(ev.target.value)" title="filter by status">
            <option value="">All</option>
            <option value="to_review">To review</option>
            <option value="reviewed">Reviewed</option>
            <option value="rplus">R+'d</option>
            <option value="merged">Merged</option>
          </select>
        </t>
        <t t-set-slot="top-right">
          <span class="meta" t-out="this.stamp"/>
          <button class="pbtn danger" t-att-disabled="!this.mergedTaskCount" t-on-click="() => this.untrackAllMerged()">Untrack all merged (<t t-out="this.mergedTaskCount"/>)</button>
          <button class="pbtn" t-on-click="() => this.refresh()"><t t-out="this.refreshIcon"/>Refresh</button>
        </t>
      </Panel>
      <div class="content br-fill">
        <div t-if="this.reviews.error()" class="dim br-empty" t-out="'Failed to load: ' + this.reviews.error()"/>
        <div t-elif="!this.groupsView().length" class="dim br-empty">No PRs tracked yet — paste one above.</div>
        <div t-else="" class="br-card">
          <div class="brg-table">
            <RecordList recordset="this.rs" groupBy="this.groupByBranch"
                        collapsible="true" stateKey="'goo-review-queue-collapsed'">
              <t t-set-slot="group-header" t-slot-scope="scope">
                <span class="rl-group-label" t-out="scope.g.key"/>
                <span t-if="scope.g.rows.length > 1" class="dash-pr-state" t-att-class="this.rollup(scope.g.rows).cls" t-out="this.rollup(scope.g.rows).label"/>
                <span class="rl-group-count" t-out="'(' + scope.g.rows.length + ')'"/>
                <button class="rev-important" t-att-class="{on: this.isImportant(scope.g.rows)}"
                        t-att-title="this.isImportant(scope.g.rows) ? 'unflag as important' : 'flag as important'"
                        t-on-click.stop="(ev) => this.toggleImportant(scope.g.rows)"><t t-out="this.warningIcon"/></button>
                <button class="rev-review" t-att-class="this.reviewStateFor(scope.g.key)"
                        t-att-title="this.reviewTitleFor(scope.g.key)"
                        t-on-click.stop="(ev) => this.onReviewIconClick(scope.g.rows)">
                  <t t-out="this.claudeIcon"/>
                  <span t-if="this.reviewScoreFor(scope.g.key) !== null" class="rev-score"
                        t-att-class="this.scoreClass(this.reviewScoreFor(scope.g.key))"
                        t-out="this.reviewScoreFor(scope.g.key)"/>
                </button>
                <button class="dash-kebab" title="task actions" t-on-click.stop="(ev) => this.openGroupMenu(ev, scope.g.rows)"><t t-out="this.kebabIcon"/></button>
              </t>
            </RecordList>
          </div>
        </div>
      </div>
    </section>`;

  code = usePlugin(CodePlugin);
  config = usePlugin(ConfigPlugin);
  db = usePlugin(DatabasePlugin);
  dialogs = usePlugin(DialogPlugin);
  eventLog = usePlugin(EventLogPlugin);
  router = usePlugin(RouterPlugin);
  wt = usePlugin(WorkspacePlugin);
  claude = usePlugin(ClaudePlugin);
  reviews = usePlugin(ReviewsPlugin);
  refreshIcon = m(ICONS.refresh);
  kebabIcon = m(ICONS.kebab);
  warningIcon = m(ICONS.warning);
  claudeIcon = m(ICONS.claude);
  addPrText = signal("");
  addPrNote = signal("");
  statusFilter = signal(""); // "" = all

  // one row per tracked {id, github, number}, enriched with fetched PR info +
  // review status once they've loaded (loaded=false until then).
  allRows = computed(() => {
    const tracked = this.config.config.reviews || [];
    const prInfo = this.reviews.prInfo();
    const reviewStatus = this.reviews.reviewStatus();
    return tracked.map((t) => {
      const info = prInfo[t.id];
      return {
        id: t.id,
        github: t.github,
        number: t.number,
        // groups alone (by its own id) until its branch is known, so loading
        // rows never transiently pile into one shared group
        branch: info?.branch || t.id,
        title: info?.title || "",
        url: info?.url || `https://github.com/${t.github}/pull/${t.number}`,
        state: info?.state || "",
        draft: info?.draft || false,
        loaded: !!info,
        reviewStatus: reviewStatus[t.id],
        important: !!t.important,
      };
    });
  });

  // grouped by branch, filtered group-wise (a task stays visible if ANY of its
  // PRs matches the selected status) — same pattern as Branches & PRs.
  groupsView = computed(() => {
    const byBranch = new Map();
    for (const row of this.allRows()) {
      if (!byBranch.has(row.branch)) byBranch.set(row.branch, []);
      byBranch.get(row.branch).push(row);
    }
    const status = this.statusFilter();
    return [...byBranch.entries()]
      .map(([key, rows]) => ({ key, rows }))
      .filter((g) => !status || g.rows.some((r) => this._statusKey(r) === status));
  });

  rows = () => this.groupsView().flatMap((g) => g.rows);
  groupByBranch = (row) => row.branch;

  // every forward-port pull across every merged tracked row — their own
  // mergebot/review status needs its own fetch, since the tracked row's own
  // fetch only covers the row's own PR, not what its forward-port matrix names.
  forwardPortPairs = computed(() => {
    const seen = new Set();
    const pairs = [];
    for (const row of this.allRows()) {
      const key = `${row.github}#${row.number}`;
      if (!isMerged(row, this.code.mergebot()[key] || "")) continue;
      for (const fp of this.code.mbForwardPorts()[key] || []) {
        for (const pull of (fp.cells || []).flatMap((c) => c.pulls || [])) {
          const k = `${pull.github}#${pull.number}`;
          if (seen.has(k)) continue;
          seen.add(k);
          pairs.push({ github: pull.github, number: pull.number });
        }
      }
    }
    return pairs;
  });

  _cell = (row) => ({ row, screen: this });
  rs = recordset(this.rows, [
    { name: "repo", label: "Repo", get: (r) => this._repoLabel(r.github) },
    { name: "pr", label: "PR", component: PrCell, cellProps: this._cell },
    { name: "status", label: "Status", component: StatusCell, cellProps: this._cell },
    { name: "fwports", label: "Forward ports", component: ForwardPortsCell, cellProps: this._cell },
    { name: "act", label: "", component: ActionsCell, cellProps: this._cell },
  ]);

  setup() {
    useEffect(() => {
      const tracked = this.config.config.reviews || [];
      if (!tracked.length) return;
      this.reviews.loadPrInfo(tracked);
      this.reviews.loadReviewStatus(tracked);
      this.code.loadMergebot(tracked);
    });
    // once a tracked PR's forward-port matrix is known, fetch those PRs' own
    // status too (re-runs as the matrix fills in, e.g. a forward-port opens later)
    useEffect(() => {
      const pairs = this.forwardPortPairs();
      if (!pairs.length) return;
      this.code.loadMergebot(pairs);
      this.reviews.loadReviewStatus(pairs);
    });
    // seed each visible task's review status from the backend once (ClaudePlugin.prime
    // is itself a one-shot fetch, guarded internally) — after that, live SSE "claude"
    // events keep it current reactively (ClaudePlugin.apply is wired globally, not
    // just while the Workspaces screen is mounted), so the group-header icon reflects
    // "running"/"done" without any polling here.
    useEffect(() => {
      for (const g of this.groupsView()) {
        const ws = this.reviewWorkspaceFor(g.key);
        if (ws) this.claude.prime(ws.id);
      }
    });
  }

  _statusKey(row) {
    const key = `${row.github}#${row.number}`;
    return statusKey(row, this.code.mergebot()[key] || "", this.code.mbDetails()[key] || "");
  }

  _repoLabel(github) {
    const repo = (this.config.config.repos || []).find((r) => r.github === github);
    return repo ? repo.id : github;
  }

  // worst-of across a group's rows, in STATUS_META's precedence order
  rollup(rows) {
    return STATUS_META[worstStatusKey(rows.map((r) => this._statusKey(r)))];
  }

  // a task (group of rows) is "important" if any of its PRs is flagged
  isImportant(rows) {
    return rows.some((r) => r.important);
  }

  toggleImportant(rows) {
    this.reviews.toggleImportant(
      this.config,
      rows.map((r) => r.id),
    );
  }

  get count() {
    const n = (this.config.config.reviews || []).length;
    return `${n} PR${n === 1 ? "" : "s"}`;
  }

  get stamp() {
    if (this.reviews.loading()) return "refreshing…";
    return this.reviews.at() ? `updated ${timeAgo(new Date(this.reviews.at()).toISOString())}` : "";
  }

  async addPr() {
    const text = this.addPrText().trim();
    if (!text) return;
    const ref = parsePrRef(text);
    if (!ref) {
      this.addPrNote.set("paste a GitHub PR URL or owner/repo#123");
      return;
    }
    const added = this.reviews.track(this.config, ref.github, ref.number);
    this.addPrText.set("");
    if (!added) {
      this.addPrNote.set("already tracked");
      return;
    }
    this.addPrNote.set("");
    const { branch, siblings } = await this.discoverSiblings(ref);
    if (branch && this.config.config.auto_workspace_on_review) {
      const targets = [ref, ...siblings]
        .map((p) => ({ repo: this._repoFor(p.github), pull: p }))
        .filter((t) => t.repo && t.repo.path);
      if (targets.length) {
        const wsId =
          this.reviewWorkspaceFor(branch)?.id ||
          (await createReviewWorkspace(this._dialogPlugins(), targets));
        if (wsId && this.config.config.auto_claude_review) {
          await this._runReviewIfNeeded(wsId, branch);
        }
      }
    }
  }

  // once a PR is tracked, look for a sibling PR on the same branch in every
  // OTHER configured repo (the cross-repo task convention) and track those too
  // — so adding one PR of a multi-repo task picks up the rest automatically.
  // Returns the resolved branch (null if it couldn't be resolved at all) and
  // the newly-tracked siblings, so addPr can also drive auto-workspace-creation.
  async discoverSiblings(ref) {
    const info = await this.reviews.fetchOne(ref);
    if (!info?.branch) return { branch: null, siblings: [] };
    const otherRepos = (this.config.config.repos || []).filter(
      (r) => r.github && r.github !== ref.github,
    );
    if (!otherRepos.length) return { branch: info.branch, siblings: [] };
    const siblings = await this.reviews.findSiblings(
      otherRepos.map((r) => ({ github: r.github, branch: info.branch })),
    );
    const added = siblings.filter((s) => this.reviews.track(this.config, s.github, s.number));
    if (added.length)
      this.addPrNote.set(
        `+${added.length} related PR${added.length === 1 ? "" : "s"} found on "${info.branch}"`,
      );
    return { branch: info.branch, siblings: added };
  }

  async refresh() {
    const tracked = this.config.config.reviews || [];
    const fpPairs = this.forwardPortPairs();
    await Promise.all([
      this.reviews.loadPrInfo(tracked, true),
      this.reviews.loadReviewStatus(tracked, true),
      this.reviews.loadReviewStatus(fpPairs, true),
      this.code.refreshStatuses([], [...tracked, ...fpPairs]),
    ]);
  }

  _dialogPlugins() {
    return {
      config: this.config,
      dialogs: this.dialogs,
      db: this.db,
      code: this.code,
      eventLog: this.eventLog,
      wt: this.wt,
      claude: this.claude,
    };
  }

  // a row's repo — resolved from its github slug against configured repos (a
  // tracked PR whose repo isn't configured locally has no checkout to branch)
  _repoFor(github) {
    return (this.config.config.repos || []).find((r) => r.github === github) || null;
  }

  // {repo, pull} targets for a set of rows, dropping any whose repo isn't
  // configured locally — shared by createTaskWorkspace and reviewGroup.
  _targetsFor(rows) {
    return rows
      .map((row) => ({
        repo: this._repoFor(row.github),
        pull: { github: row.github, number: row.number },
      }))
      .filter((t) => t.repo && t.repo.path);
  }

  // the review workspace already tracking this task's branch, if any — a plain
  // synchronous lookup (no priming/network) so the group-header button can color
  // itself "ready" without an N-groups history fetch on every render.
  reviewWorkspaceFor(branch) {
    return (
      (this.config.config.workspaces || []).find(
        (w) => w.category === REVIEW_CATEGORY && w.name === branch,
      ) || null
    );
  }

  // "none" (nothing started yet — clicking starts one) | "running" (Claude is
  // actively working) | "done" (a review is available to read). Reflects
  // ClaudePlugin's live reactive state, which is only accurate once the
  // conversation has been primed at least once (setup()'s priming effect does
  // this for every visible task) — after that it stays current via the global
  // SSE "claude" listener (ClaudePlugin.apply), with no polling needed here.
  reviewStateFor(branch) {
    const ws = this.reviewWorkspaceFor(branch);
    if (!ws) return "none";
    if (this.claude.running(ws.id)) return "running";
    return this.claude.items(ws.id).length ? "done" : "none";
  }

  reviewTitleFor(branch) {
    const state = this.reviewStateFor(branch);
    if (state === "running") return "Claude is reviewing this task…";
    if (state === "done") {
      const score = this.reviewScoreFor(branch);
      return score === null
        ? "Claude review available — click to read it"
        : `Claude review available — merge-readiness guess: ${score}/100 — click to read it`;
    }
    return "Run a Claude review for this task";
  }

  // Claude's own merge-readiness guess (0-100) for a finished review, or null if
  // none was reported (see ClaudePlugin.reviewScore) — the little colored badge
  // next to the review icon once a review is "done".
  reviewScoreFor(branch) {
    const ws = this.reviewWorkspaceFor(branch);
    return ws ? this.claude.reviewScore(ws.id) : null;
  }

  scoreClass(score) {
    return reviewScoreClass(score);
  }

  async createRowWorkspace(row) {
    const repo = this._repoFor(row.github);
    if (!repo || !repo.path) {
      await this.dialogs.open({
        title: "Create workspace",
        message: `${row.github} isn't a configured repo with a local checkout.`,
        okLabel: "OK",
        cancelLabel: null,
      });
      return;
    }
    return createWorkspaceFromPRs(this._dialogPlugins(), [
      { repo, pull: { github: row.github, number: row.number } },
    ]);
  }

  async createTaskWorkspace(rows) {
    const targets = this._targetsFor(rows);
    if (!targets.length) return;
    return createWorkspaceFromPRs(this._dialogPlugins(), targets);
  }

  // Prime <wsId>'s conversation and start its Claude review ONLY if one hasn't
  // already started ("none" state — never while "running" or "done", so calling
  // this again never re-asks Claude to review again). Shared by _startReview
  // (the group-header icon / task menu's explicit "Review" action, which always
  // wants a review) and addPr's auto-review hook (which only wants one when
  // config.auto_claude_review is on — the caller gates that, not this helper).
  async _runReviewIfNeeded(wsId, branch) {
    await this.claude.prime(wsId);
    if (this.reviewStateFor(branch) === "none") {
      const ws = (this.config.config.workspaces || []).find((w) => w.id === wsId);
      if (ws) await runClaudeReview(this._dialogPlugins(), ws);
    }
  }

  // Ensure a review workspace exists for this task (idempotent) and start its
  // Claude review (see _runReviewIfNeeded). Returns the workspace id (or null on
  // failure — an error is already surfaced by resolvePrBranches/createWorktree).
  // Shared by the group-header icon (onReviewIconClick, stays on this screen) and
  // reviewGroup (the task menu's "Review" action, which navigates afterward).
  async _startReview(rows) {
    const branch = rows[0]?.branch;
    // fast path: the group's rows already carry their resolved branch name (no
    // fetch needed) — reuse an existing review workspace straight away rather
    // than going through createReviewWorkspace's own (network) pre-check.
    let wsId = this.reviewWorkspaceFor(branch)?.id;
    if (!wsId) {
      const targets = this._targetsFor(rows);
      if (!targets.length) return null;
      wsId = await createReviewWorkspace(this._dialogPlugins(), targets);
    }
    if (!wsId) return null;
    await this._runReviewIfNeeded(wsId, branch);
    return wsId;
  }

  // the task menu's "Review" action: same as the group-header icon, but always
  // lands on the workspace's own Claude tab afterward — "running" shows the
  // live in-progress conversation, "done" shows the finished answer.
  async reviewGroup(rows) {
    const wsId = await this._startReview(rows);
    if (!wsId) return;
    this.wt.selectOnOpen(wsId);
    this.wt.requestedPane.set("claude");
    this.router.go("workspaces");
  }

  // the group-header icon's click: "none" starts a review right here, without
  // navigating away (this screen is the vantage point — the icon itself starts
  // spinning via reviewStateFor/CSS while it runs); "running" is a no-op, the
  // spinning icon already says what's happening; "done" opens the saved review
  // in a side panel (openReviewPanel) instead of jumping to the Claude tab —
  // that panel's own "Continue to chat with claude" button is the escape hatch
  // for anyone who wants the full transcript.
  async onReviewIconClick(rows) {
    const state = this.reviewStateFor(rows[0]?.branch);
    if (state === "running") return;
    if (state === "done") return this.openReviewPanel(rows[0].branch);
    await this._startReview(rows);
  }

  // open the task's saved review markdown in a floating side panel, straight from
  // disk (ClaudePlugin.fetchReview) — a quick read that doesn't navigate away
  // from this screen the way reviewGroup's "open the Claude tab" does.
  openReviewPanel(branch) {
    const ws = this.reviewWorkspaceFor(branch);
    if (!ws) return;
    this.dialogs.openComponent(ReviewPanel, {
      workspaceId: ws.id,
      label: `Review · ${branch}`,
      onReviewAgain: () => this._rerunReview(branch),
    });
  }

  // start a fresh review turn for a task that already has one saved — unlike
  // _runReviewIfNeeded (which only starts one from the "none" state), this always
  // runs, so it's the only path that can add a second-or-later version to a
  // review's history. Called from the review panel's "Review again" button; a
  // no-op while one is already running.
  async _rerunReview(branch) {
    const ws = this.reviewWorkspaceFor(branch);
    if (!ws || this.claude.running(ws.id)) return;
    await runClaudeReview(this._dialogPlugins(), ws);
  }

  // how many tasks are fully merged (base PR(s) + every forward port) — drives
  // the top bar's "Untrack all merged" button, both its visibility and count.
  get mergedTaskCount() {
    return this.groupsView().filter((g) => taskFullyMerged(g.rows, this.code)).length;
  }

  // untracking a task that isn't fully merged yet means goo stops following
  // it through review/merge — worth a pause. A fully-merged task has nothing
  // left to lose, so it skips the prompt.
  async _confirmUntrack(rows) {
    if (taskFullyMerged(rows, this.code)) return true;
    const n = rows.length;
    const res = await this.dialogs.open({
      title: `Untrack unmerged PR${n === 1 ? "" : "s"}?`,
      message:
        "The base PR or one of its forward ports hasn't been merged yet. " +
        "Untracking it now means goo stops following it through review and merge.",
      okLabel: "Untrack anyway",
    });
    return !!res;
  }

  async untrackGroup(rows) {
    if (!(await this._confirmUntrack(rows))) return;
    this.reviews.untrackMany(
      this.config,
      rows.map((r) => r.id),
    );
    await this._removeWorkspaceIfOrphaned(rows[0]?.branch);
  }

  // bulk-drop every task that's fully merged (base PR(s) + every forward port)
  // — the top bar's "Untrack all merged" button.
  async untrackAllMerged() {
    const groups = this.groupsView().filter((g) => taskFullyMerged(g.rows, this.code));
    if (!groups.length) return;
    const n = groups.length;
    const res = await this.dialogs.open({
      title: `Untrack ${n} fully-merged task${n === 1 ? "" : "s"}?`,
      message: "Every base PR and forward port in these tasks has been merged.",
      okLabel: "Untrack",
    });
    if (!res) return;
    this.reviews.untrackMany(
      this.config,
      groups.flatMap((g) => g.rows.map((r) => r.id)),
    );
    await Promise.all(groups.map((g) => this._removeWorkspaceIfOrphaned(g.rows[0]?.branch)));
  }

  // drop the task's auto-created review workspace (createReviewWorkspace) once
  // nothing tracked still shares its branch — untracking every PR in a task
  // shouldn't leave its worktree/checkout behind forever. Skipped (does
  // nothing) when another row on the same branch is still tracked (a
  // multi-repo task untracked one row at a time via untrackRow) or when the
  // workspace is busy (removeSilently itself no-ops then) — the untrack action
  // was already confirmed, so this stays silent, same as cascade child removal.
  async _removeWorkspaceIfOrphaned(branch) {
    if (!branch) return;
    if (this.allRows().some((r) => r.branch === branch)) return;
    const ws = this.reviewWorkspaceFor(branch);
    if (ws) await this.wt.removeSilently(ws);
  }

  // a task's (group header's) menu: Create workspace always; Open on GitHub /
  // Open on mergebot only for a single-PR task (ambiguous which PR otherwise —
  // the row's own kebab covers that case); Untrack drops every PR in the task.
  openGroupMenu(ev, rows) {
    const rect = ev.currentTarget.getBoundingClientRect();
    const actions = [
      { label: "Create workspace", onClick: () => this.createTaskWorkspace(rows) },
      { label: "Review", onClick: () => this.reviewGroup(rows) },
    ];
    if (rows.length === 1) {
      const row = rows[0];
      actions.push({ label: "Open on GitHub", onClick: () => window.open(row.url, "_blank") });
      actions.push({
        label: "Open on mergebot",
        onClick: () => window.open(this.code.mergebotUrl(row.github, row.number), "_blank"),
      });
    }
    actions.push({
      label: "Untrack",
      danger: true,
      onClick: () => this.untrackGroup(rows),
    });
    appBus.dispatchEvent(new CustomEvent("action-menu", { detail: { rect, actions } }));
  }

  hasRowMenu() {
    return true;
  }

  // a forward-port branch's menu: one Create workspace spanning every repo the
  // branch's PRs are in, plus per-PR Open on GitHub / Open on mergebot / Send
  // r+ (repo-suffixed only when the branch spans more than one repo).
  openForwardPortMenu(ev, row, fp) {
    const rect = ev.currentTarget.getBoundingClientRect();
    const pulls = (fp.cells || []).flatMap((c) => c.pulls || []);
    const targets = pulls
      .map((p) => ({ repo: this._repoFor(p.github), pull: { github: p.github, number: p.number } }))
      .filter((t) => t.repo && t.repo.path);
    const actions = [];
    if (targets.length)
      actions.push({
        label: "Create workspace",
        onClick: () => createWorkspaceFromPRs(this._dialogPlugins(), targets),
      });
    for (const p of pulls) {
      const suffix = pulls.length > 1 ? ` (${this._repoLabel(p.github)})` : "";
      actions.push({
        label: `Open on GitHub${suffix}`,
        onClick: () => window.open(this.code.pullRequestUrl(p.github, p.number), "_blank"),
      });
      actions.push({
        label: `Open on mergebot${suffix}`,
        onClick: () => window.open(this.code.mergebotUrl(p.github, p.number), "_blank"),
      });
      actions.push({
        label: `Send r+${suffix}`,
        onClick: () => this.code.postRPlus(p.github, p.number),
      });
    }
    appBus.dispatchEvent(new CustomEvent("action-menu", { detail: { rect, actions } }));
  }

  openRowMenu(ev, row) {
    const rect = ev.currentTarget.getBoundingClientRect();
    const actions = [
      { label: "Create workspace", onClick: () => this.createRowWorkspace(row) },
      { label: "Open on GitHub", onClick: () => window.open(row.url, "_blank") },
    ];
    if (row.loaded)
      actions.push({
        label: "Open on mergebot",
        onClick: () => window.open(this.code.mergebotUrl(row.github, row.number), "_blank"),
      });
    actions.push({
      label: "Untrack",
      danger: true,
      onClick: () => this.untrackRow(row),
    });
    appBus.dispatchEvent(new CustomEvent("action-menu", { detail: { rect, actions } }));
  }

  async untrackRow(row) {
    if (!(await this._confirmUntrack([row]))) return;
    this.reviews.untrack(this.config, row.id);
    await this._removeWorkspaceIfOrphaned(row.branch);
  }
}
