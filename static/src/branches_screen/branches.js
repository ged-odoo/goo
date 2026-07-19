// The merged "Branches & PRs" screen — one grouped list (the generic RecordList)
// with one group per branch name. Rows are the union of both old screens:
//   kind "local" — a per-repo local branch (from CodePlugin's branch scan),
//                  enriched with its PR when one exists (prIndex join)
//   kind "pr"    — an authored PR whose branch has no local checkout anywhere
//                  (deleted locally, or opened from another machine)
// The group line hosts the group actions (selection for batch delete / close);
// per-row kebabs keep the full branch menu (commits/push/PR/checkout/delete).

import { Component, computed, usePlugin, signal, useEffect, xml } from "@odoo/owl";
import { BASE_BRANCH_RE } from "../core/config.js";
import { timeAgo } from "../core/utils.js";
import { CodePlugin } from "../core/code_plugin.js";
import { ConfigPlugin } from "../core/config_plugin.js";
import { DialogPlugin } from "../core/dialog_plugin.js";
import { ServerPlugin } from "../core/server_plugin.js";

import { WorkspacePlugin, cascadeRemoveDescendants } from "../core/workspace_plugin.js";
import { ICONS, SearchBox, appBus, m } from "../core/common.js";
import { Panel } from "../core/panel.js";
import { RecordList, recordset } from "../core/recordset.js";
import { CommitsDialog, pushBranchesDialog } from "../core/dialogs.js";
import { ActionsCell, MergebotCell, PrCell, RepoCell } from "./cells.js";

export class BranchesScreen extends Component {
  static components = { SearchBox, Panel, RecordList };
  worktree = usePlugin(WorkspacePlugin); // "wt" badge on branches owned by a worktree
  server = usePlugin(ServerPlugin);
  static template = xml`
    <section>
      <Panel title="'Branches &amp; PRs'">
        <t t-set-slot="title-extra">
          <div class="panel-inline-actions">
            <input type="checkbox" class="br-select" t-att-checked="this.allSelected" t-on-change="() => this.toggleSelectAll()" title="select all branches"/>
            <span class="sub" t-out="this.count"/>
            <button t-if="this.selectedLocalRows.length" class="pbtn danger" t-on-click="() => this.deleteSelected()">Delete <t t-out="this.selectedLocalRows.length"/></button>
            <button t-if="this.selectedOpenPrs.length" class="pbtn pr-close-batch" t-on-click="() => this.closeSelected()">Close <t t-out="this.selectedOpenPrs.length"/> PR<t t-if="this.selectedOpenPrs.length !== 1">s</t></button>
          </div>
        </t>
        <t t-set-slot="top-middle">
          <SearchBox value="this.search"/>
          <select t-att-value="this.repoFilter()" t-on-change="ev => this.repoFilter.set(ev.target.value)" title="filter by repository">
            <option value="">All repositories</option>
            <option t-foreach="this.repos" t-as="r" t-key="r" t-att-value="r" t-out="r"/>
          </select>
          <select t-att-value="this.statusFilter()" t-on-change="ev => this.statusFilter.set(ev.target.value)" title="filter by merge status">
            <option value="">All</option>
            <option value="unmerged">All (except merged)</option>
            <option value="merged">Merged</option>
            <option value="error">Error</option>
            <option value="blocked">Blocked</option>
          </select>
        </t>
        <t t-set-slot="top-right">
          <span class="meta" t-out="this.stamp"/>
          <button class="pbtn" t-on-click="() => this.refresh()"><t t-out="this.refreshIcon"/>Refresh</button>
        </t>
      </Panel>
      <div class="content br-fill">
        <div t-att-class="{busy: this.code.busy()}">
          <div t-foreach="this.errors" t-as="e" t-key="e.id" class="dim br-empty" t-out="e.id + ': ' + e.error"/>
          <div t-if="this.code.error()" class="dim br-empty" t-out="'Failed to load: ' + this.code.error()"/>
          <div t-elif="!this.groups().length" class="dim br-empty">No branches or pull requests.</div>
          <div t-else="" class="br-card">
            <!-- full-width card = scroll container (scrollbar stays on the right);
                 this wrapper sizes to the table's natural width, left-aligned -->
            <div class="brg-table">
              <RecordList recordset="this.rs" groupBy="this.groupByBranch" rowClass="this.rowClassFn"
                          collapsible="true" stateKey="'goo-branches-collapsed'" sort="this.sortApi">
                <t t-set-slot="group-header" t-slot-scope="scope">
                  <input type="checkbox" class="br-select" t-att-checked="this.selected().has(scope.g.key)" t-on-change="() => this.toggleSelect(scope.g.key)" title="select this branch for batch actions"/>
                  <span class="br-branch select-toggle" t-on-click="() => this.toggleSelect(scope.g.key)" t-out="scope.g.key"/>
                  <span t-if="this.worktree.isWorktreeBranch(scope.g.key)" class="wt-badge" title="has a worktree">wt</span>
                  <span class="rl-group-count" t-out="'(' + scope.g.rows.length + ')'"/>
                </t>
              </RecordList>
            </div>
          </div>
        </div>
      </div>
    </section>`;

  code = usePlugin(CodePlugin);
  config = usePlugin(ConfigPlugin);
  dialogs = usePlugin(DialogPlugin);
  refreshIcon = m(ICONS.refresh);
  repoFilter = signal(""); // "" = all repositories
  search = signal("");
  statusFilter = signal("unmerged"); // merge status; "" = all, "unmerged" = still in flight
  selected = signal(new Set()); // branch names ticked for batch actions
  sortDir = signal("desc"); // groups by combined last-update time; "asc" | "desc"
  sortKey = signal("update"); // the one sortable column (kept as state for the header API)

  // ── the union rows, grouped by branch name ──
  // One group per branch name; each carries its rows and is "active" when the
  // branch is checked out in any repo. A branch's PR rides its local row (prIndex
  // join); authored PRs with no local branch anywhere become PR-only rows.
  groups = computed(() => {
    const { prIndex, pathByRepo, githubByRepo, pushRemoteByRepo } = this.code.groups();
    const repoFilter = this.repoFilter();
    const q = this.search().trim().toLowerCase();
    const byBranch = new Map();
    const push = (name, row) => {
      if (!byBranch.has(name)) byBranch.set(name, []);
      byBranch.get(name).push(row);
    };
    // local-branch keys (unfiltered), so a filtered-out local row never
    // resurfaces as a duplicate PR-only row
    const local = new Set();
    for (const repo of this.code.branchRepos())
      for (const b of repo.branches || []) local.add(`${repo.id}:${b.name}`);
    for (const repo of this.code.branchRepos()) {
      if (repo.error) continue;
      if (repoFilter && repo.id !== repoFilter) continue;
      for (const b of repo.branches) {
        const pr = prIndex[`${repo.id}:${b.name}`];
        const hay = `${b.name} ${repo.id}` + (pr ? ` ${pr.title} #${pr.number}` : "");
        if (q && !hay.toLowerCase().includes(q)) continue;
        push(b.name, {
          kind: "local",
          id: `l:${repo.id}:${b.name}`,
          branch: b.name,
          repo: repo.id,
          path: pathByRepo[repo.id] || "",
          github: githubByRepo[repo.id] || "",
          push_remote: pushRemoteByRepo[repo.id] || "dev",
          remote: b.remote,
          base: BASE_BRANCH_RE.test(b.name),
          date: b.date,
          subject: b.subject || "",
          active: b.name === repo.current,
          dirty: b.name === repo.current && repo.dirty,
          repoDirty: repo.dirty, // the repo's working tree (its current branch)
          pr,
        });
      }
    }
    for (const repo of this.code.prRepos()) {
      if (repo.error) continue;
      if (repoFilter && repo.id !== repoFilter) continue;
      for (const pr of repo.prs) {
        if (local.has(`${repo.id}:${pr.branch}`)) continue;
        if (q && !`${pr.branch} ${repo.id} ${pr.title} #${pr.number}`.toLowerCase().includes(q))
          continue;
        push(pr.branch || "—", {
          kind: "pr",
          id: `p:${pr.github}#${pr.number}`,
          branch: pr.branch || "—",
          repo: repo.id,
          github: pr.github,
          // the PR stands in for the missing local branch: its title is the
          // "commit" column, createdAt the date (updatedAt is noisy)
          date: pr.createdAt || pr.updatedAt,
          subject: pr.title || "",
          pr,
        });
      }
    }
    // within a group: config repo order (odoo before enterprise), local rows first
    const repoOrder = (this.config.config.repos || []).map((r) => r.id);
    const rank = (r) => {
      const i = repoOrder.indexOf(r.repo);
      return i === -1 ? repoOrder.length : i; // unknown repos sort last
    };
    const dir = this.sortDir() === "asc" ? 1 : -1;
    const status = this.statusFilter();
    return [...byBranch.entries()]
      .map(([name, rows]) => ({
        name,
        rows: rows
          .slice()
          .sort((a, b) => (a.kind === "pr") - (b.kind === "pr") || rank(a) - rank(b)),
        // combined last-update time for the branch (sum across its rows)
        updateSum: rows.reduce((s, r) => s + (Date.parse(r.date) || 0), 0),
      }))
      .filter((g) => this._matchesStatus(g, status))
      .sort((a, b) => (a.updateSum - b.updateSum) * dir);
  });

  // The merge-status filter is group-level: a group is kept whole when ANY of its
  // rows matches. "merged" reads GitHub's terminal state (or mergebot's); a local
  // branch without a PR counts as unmerged (in-flight work). "error"/"blocked"
  // are mergebot states that only exist on still-open PRs, which we do scrape.
  _matchesStatus(g, status) {
    if (!status) return true;
    if (status === "unmerged") return g.rows.some((r) => !r.pr || !this._isMerged(r.pr));
    if (status === "merged") return g.rows.some((r) => r.pr && this._isMerged(r.pr));
    return g.rows.some((r) => r.pr && this.mbState(r.pr) === status);
  }

  _isMerged(pr) {
    return this.mbState(pr) === "merged" || pr.state === "merged" || pr.state === "closed";
  }

  mbState(pr) {
    return this.code.mergebot()[`${pr.github}#${pr.number}`] || "";
  }

  // ── RecordList wiring ──
  rows = () => this.groups().flatMap((g) => g.rows);
  groupByBranch = (r) => r.branch;
  rowClassFn = (r) => ({
    active: r.kind === "local" && r.active,
    "row-sel": this.selected().has(r.branch),
  });

  sortApi = {
    key: () => this.sortKey(),
    dir: () => this.sortDir(),
    toggle: () => this.sortDir.set(this.sortDir() === "asc" ? "desc" : "asc"),
  };

  _cell = (row) => ({ row, screen: this });
  rs = recordset(this.rows, [
    { name: "repo", label: "Repository", component: RepoCell, cellProps: this._cell },
    {
      name: "update",
      label: "Last update",
      sortable: true,
      class: "brg-when",
      get: (r) => (r.date ? timeAgo(r.date) : "—"),
      title: (r) => r.date || "",
    },
    {
      name: "commit",
      label: "Last commit",
      class: "brg-commit",
      get: (r) => r.subject || "—",
      title: (r) => r.subject || "",
    },
    { name: "pr", label: "PR", component: PrCell, cellProps: this._cell },
    { name: "mergebot", label: "Mergebot", component: MergebotCell, cellProps: this._cell },
    { name: "act", label: "", component: ActionsCell, cellProps: this._cell },
  ]);

  setup() {
    this.code.load();
    // mergebot for the listed PRs, via CodePlugin (session-deduped; a forced
    // load() arms the refresh scope so the next pass re-scrapes)
    useEffect(() => {
      const prs = this._mbPrs();
      if (prs.length) this.code.loadMergebot(prs);
    });
  }

  // the open PRs across all rows in mergebot's {github, number} shape. Terminal
  // PRs (merged/closed) never need a scrape; external repos aren't on mergebot.
  _mbPrs() {
    const out = [];
    const seen = new Set();
    for (const r of this.rows()) {
      const pr = r.pr;
      if (!pr || pr.state !== "open" || !pr.github || this.code.isExternalRepo(pr.github)) continue;
      const key = `${pr.github}#${pr.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ github: pr.github, number: pr.number });
    }
    return out;
  }

  async refresh() {
    await this.code.load(true);
  }

  // ── selection (group-level: a Set of branch names) ──
  toggleSelect(name) {
    const sel = new Set(this.selected());
    sel.has(name) ? sel.delete(name) : sel.add(name);
    this.selected.set(sel);
  }

  get allSelected() {
    const groups = this.groups();
    const sel = this.selected();
    return groups.length > 0 && groups.every((g) => sel.has(g.name));
  }

  toggleSelectAll() {
    this.selected.set(this.allSelected ? new Set() : new Set(this.groups().map((g) => g.name)));
  }

  // selected branch groups that are still visible (a filter may hide some)
  get selectedGroups() {
    const sel = this.selected();
    return this.groups().filter((g) => sel.has(g.name));
  }

  // the selected groups' local branches (what batch Delete operates on)
  get selectedLocalRows() {
    return this.selectedGroups.flatMap((g) => g.rows.filter((r) => r.kind === "local"));
  }

  // the selected groups' open PRs, deduped (what batch Close operates on)
  get selectedOpenPrs() {
    const out = [];
    const seen = new Set();
    for (const g of this.selectedGroups)
      for (const r of g.rows) {
        const pr = r.pr;
        if (!pr || pr.state !== "open" || !pr.github) continue;
        const key = `${pr.github}#${pr.number}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(pr);
      }
    return out;
  }

  // batch-delete every selected branch in each repo where it can be removed
  // (only the checked-out branch is skipped). Open PRs on the selected branches
  // can be closed first via a checkbox.
  async deleteSelected() {
    const groups = this.selectedGroups.filter((g) => g.rows.some((r) => r.kind === "local"));
    if (!groups.length) return;
    const all = this.selectedLocalRows;
    const rows = all.filter((r) => !this.deleteBlocked(r));
    const skipped = all.length - rows.length;
    const prs = rows.filter((r) => r.pr && r.pr.state === "open" && r.github);
    const remoteRows = rows.filter((r) => r.remote && !r.base);
    const what = groups.length === 1 ? `branch "${groups[0].name}"` : `${groups.length} branches`;
    const fields = [];
    if (remoteRows.length)
      fields.push({
        key: "delRemote",
        type: "checkbox",
        label: `Also delete ${remoteRows.length === 1 ? "it" : "them"} on the push remote`,
        value: false,
      });
    if (prs.length)
      fields.push({
        key: "closePrs",
        type: "checkbox",
        label: `Close ${prs.length === 1 ? "its open pull request" : `${prs.length} open pull requests`}`,
        value: true,
      });
    const res = await this.dialogs.open({
      title: "Delete branches",
      message:
        `Delete ${what} in ${rows.length} repo${rows.length === 1 ? "" : "s"} locally?` +
        (skipped ? ` ${skipped} skipped (checked out).` : "") +
        " This cannot be undone.",
      okLabel: "Delete",
      fields,
    });
    if (!res) return;
    if (res.closePrs) for (const r of prs) await this.code.closePrNoConfirm(r.github, r.pr.number);
    for (const r of rows)
      await this.code.deleteBranchNoConfirm(
        r.branch,
        r.repo,
        r.path,
        !!res.delRemote && r.remote && !r.base,
      );
    this.selected.set(new Set());
  }

  // confirm, then close every selected open PR
  async closeSelected() {
    const prs = this.selectedOpenPrs;
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
    await Promise.all(prs.map((pr) => this.code.closePrNoConfirm(pr.github, pr.number)));
    this.selected.set(new Set());
  }

  // single-row delete, confirmed via the dialog. When the branch has an open PR
  // it can be closed first; targets that reference this exact branch can be
  // removed in the same step.
  async deleteRow(r) {
    if (this.deleteBlocked(r)) return;
    const canRemote = r.remote && !r.base; // pushed, non-base: removable on the remote
    const hasPr = !!(r.pr && r.pr.state === "open" && r.github);
    const targets = (this.config.config.workspaces || []).filter((w) =>
      (w.checkouts || []).some((c) => c.repo === r.repo && c.branch === r.branch),
    );
    const fields = [];
    if (canRemote)
      fields.push({
        key: "delRemote",
        type: "checkbox",
        label: `Also delete it on the push remote (${r.push_remote})`,
        value: false,
      });
    if (hasPr)
      fields.push({
        key: "closePr",
        type: "checkbox",
        label: `Close PR #${r.pr.number}`,
        value: true,
      });
    for (const t of targets)
      fields.push({
        key: `tgt:${t.id}`,
        type: "checkbox",
        label: `Delete workspace "${t.name}"`,
        value: false,
      });

    const res = await this.dialogs.open({
      title: `Delete "${r.branch}"?`,
      message: `Force-delete "${r.branch}" in ${r.repo} locally. This cannot be undone.`,
      okLabel: "Delete",
      fields,
    });
    if (!res) return;
    // close the PR before deleting the branch, then drop the branch
    if (hasPr && res.closePr) await this.code.closePrNoConfirm(r.github, r.pr.number);
    await this.code.deleteBranchNoConfirm(r.branch, r.repo, r.path, !!res.delRemote);
    // remove any workspaces the user opted to delete (canonical write — full
    // records spread so stable ports survive)
    const drop = targets.filter((t) => res[`tgt:${t.id}`]);
    if (drop.length) {
      const ids = new Set(drop.map((t) => t.id));
      for (const t of drop) this.code.eventLog.add(`deleting workspace ${t.name}`);
      this.config.updateConfig({
        workspaces: this.config.config.workspaces.filter((w) => !ids.has(w.id)),
      });
      for (const t of drop) {
        const { skipped } = await cascadeRemoveDescendants(
          {
            config: this.config,
            wt: this.worktree,
            eventLog: this.code.eventLog,
            server: this.server,
          },
          t,
        );
        if (skipped.length) {
          await this.dialogs.open({
            title: "Some sub-workspaces were kept",
            message: skipped
              .map(
                (w) => `"${w.name}" is still busy — kept, no longer linked to the deleted parent.`,
              )
              .join("\n"),
            okLabel: "OK",
            cancelLabel: null,
          });
        }
      }
    }
  }

  // repositories present in the loaded data (for the filter dropdown)
  get repos() {
    return [
      ...new Set([
        ...this.code.branchRepos().map((r) => r.id),
        ...this.code.prRepos().map((r) => r.id),
      ]),
    ];
  }

  get count() {
    let branches = 0;
    const prs = new Set();
    for (const r of this.rows()) {
      if (r.kind === "local") branches++;
      if (r.pr) prs.add(`${r.pr.github}#${r.pr.number}`);
    }
    return `${branches} branch${branches === 1 ? "" : "es"} · ${prs.size} PR${prs.size === 1 ? "" : "s"}`;
  }

  // per-repo PR load errors (branch-scan errors surface via code.error())
  get errors() {
    return this.code.prRepos().filter((r) => r.error);
  }

  openPr(row) {
    this.code.eventLog.add(`opening PR for ${row.branch} (${row.repo})`);
    window.open(this.code.prCreateUrl(row.repo, row.github, row.branch), "_blank");
  }

  hasRowMenu(row) {
    if (row.kind === "local") return true;
    return !!(row.pr && row.pr.state === "open" && row.pr.github);
  }

  // build the per-row action list and open the floating kebab menu anchored to
  // the clicked button (see ActionMenu). Local rows get the full branch menu;
  // PR-only rows (no local branch) just Close PR.
  openRowMenu(ev, r) {
    const rect = ev.currentTarget.getBoundingClientRect();
    if (r.kind === "pr") {
      const actions = [
        {
          label: "Close PR",
          danger: true,
          onClick: () => this.code.closePr(r.pr.github, r.pr.number),
        },
      ];
      appBus.dispatchEvent(new CustomEvent("action-menu", { detail: { rect, actions } }));
      return;
    }
    const actions = [{ label: "Commits", onClick: () => this.openCommits(r) }];
    if (!r.remote && !r.base)
      actions.push({
        label: "Push",
        title: `push this branch to the ${r.push_remote} remote`,
        onClick: () => this.pushBranch(r),
      });
    if (!r.base && r.remote && r.github && !r.pr)
      actions.push({ label: "Open PR", onClick: () => this.openPr(r) });
    if (r.pr && r.github && r.pr.state === "open")
      actions.push({
        label: "Close PR",
        danger: true,
        onClick: () => this.code.closePr(r.github, r.pr.number),
      });
    const coBlocked = this.checkoutBlocked(r);
    actions.push({
      label: "Checkout",
      disabled: !!coBlocked,
      title: coBlocked || `check out ${r.branch} in ${r.repo}`,
      onClick: () => this.checkout(r),
    });
    actions.push({
      label: "Duplicate",
      title: "create a new branch based on this one",
      onClick: () => this.duplicateBranch(r),
    });
    const delBlocked = this.deleteBlocked(r);
    actions.push({
      label: "Delete",
      danger: true,
      disabled: !!delBlocked,
      title: delBlocked || "",
      onClick: () => this.deleteRow(r),
    });
    appBus.dispatchEvent(new CustomEvent("action-menu", { detail: { rect, actions } }));
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
    // the backend announces the checkout as a timed SSE event — no pre-log
    this.code.checkout([{ repo: row.repo, path: row.path, branch: row.branch }]);
  }

  pushBranch(row) {
    return pushBranchesDialog(this.code, this.dialogs, [{ path: row.path, branch: row.branch }], {
      title: `Push "${row.branch}"?`,
      message: `Push ${row.branch} (${row.repo}) to the ${row.push_remote} remote?`,
    });
  }

  // show the last commits on this branch (in a floating dialog)
  openCommits(row) {
    if (!row.path) return;
    this.dialogs.openComponent(CommitsDialog, {
      path: row.path,
      ref: row.branch,
      label: `${row.repo} · ${row.branch}`,
      github: row.github || "",
    });
  }

  // create a new branch based on this one (git branch <new> <branch> — no checkout)
  async duplicateBranch(row) {
    const res = await this.dialogs.open({
      title: `Duplicate "${row.branch}" (${row.repo})`,
      fields: [
        {
          key: "branch",
          type: "text",
          label: "New branch name",
          value: row.branch,
          placeholder: "new branch name",
        },
      ],
    });
    if (!res) return;
    const name = (res.branch || "").trim();
    if (!name) return;
    this.code.createBranch(row.path, name, row.branch);
  }

  // why a branch can't be deleted ("" = deletable). Deleting closes an open PR
  // (it removes the head branch), so require closing the PR first.
  deleteBlocked(row) {
    if (row.active) return "cannot delete the checked-out branch";
    return ""; // an open PR no longer blocks: the delete dialog offers to close it
  }

  get stamp() {
    if (this.code.loading()) return "refreshing…";
    return this.code.at() ? `updated ${timeAgo(new Date(this.code.at()).toISOString())}` : "";
  }
}
