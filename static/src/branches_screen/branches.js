import { Component, computed, plugin, signal, xml } from "@odoo/owl";
import { BASE_BRANCH_RE } from "../core/config.js";
import { timeAgo } from "../core/utils.js";
import { CodePlugin } from "../core/code_plugin.js";
import { ConfigPlugin } from "../core/config_plugin.js";
import { DialogPlugin } from "../core/dialog_plugin.js";

import { WorktreePlugin } from "../core/worktree_plugin.js";
import { DirtyBadge, ICONS, SearchBox, appBus, m } from "../core/common.js";
import { Panel } from "../core/panel.js";
import { CommitsDialog } from "../core/dialogs.js";

import { pushBranchesDialog } from "../core/dialogs.js";

export class BranchesScreen extends Component {
  static components = { SearchBox, DirtyBadge, Panel };
  worktree = plugin(WorktreePlugin); // "wt" badge on branches owned by a worktree
  static template = xml`
    <section>
      <Panel title="'Branches'">
        <t t-set-slot="top-middle">
          <SearchBox value="this.search"/>
          <select t-att-value="this.repoFilter()" t-on-change="ev => this.repoFilter.set(ev.target.value)" title="filter by repository">
            <option value="">All repositories</option>
            <option t-foreach="this.repos" t-as="r" t-key="r" t-att-value="r" t-out="r"/>
          </select>
        </t>
        <t t-set-slot="top-right">
          <span class="meta" t-out="this.stamp"/>
          <button class="pbtn" t-on-click="() => this.code.load(true)"><t t-out="this.refreshIcon"/>Refresh</button>
        </t>
        <t t-set-slot="bottom-left">
          <button t-if="this.selectedCount" class="pbtn danger" t-on-click="() => this.deleteSelected()">Delete <t t-out="this.selectedCount"/></button>
        </t>
        <t t-set-slot="bottom-right">
          <span class="row-count" t-out="this.count"/>
        </t>
      </Panel>
      <div class="content br-fill">
        <div t-att-class="{busy: this.code.busy()}">
          <div t-if="this.code.error()" class="dim br-empty" t-out="'Failed to load: ' + this.code.error()"/>
          <div t-elif="!this.groups().length" class="dim br-empty">No branches.</div>
          <div t-else="" class="br-card brg">
            <!-- full-width card = scroll container (scrollbar stays on the right);
                 this wrapper sizes to the table's natural width, left-aligned -->
            <div class="brg-table">
            <!-- column header: "Branch" over the name column, the rest over the repo rows -->
            <div class="brg-head">
              <div class="brg-name-head br-sort" t-on-click="() => this.sort('name')">
                <span t-on-click.stop=""><input type="checkbox" class="br-select" t-att-checked="this.allSelected" t-on-change="() => this.toggleSelectAll()" title="select all branches"/></span>
                Branch<span class="br-arrow" t-out="this.sortArrow('name')"/>
              </div>
              <div class="brg-cols brg-colhead">
                <span>Repository</span>
                <span class="br-sort" t-on-click="() => this.sort('update')">Last update<span class="br-arrow" t-out="this.sortArrow('update')"/></span>
                <span>Last commit</span>
                <span>PR</span>
                <span/>
              </div>
            </div>
            <!-- one group per branch name: the name shown once on the left, repo rows on the right -->
            <div t-foreach="this.groups()" t-as="g" t-key="g.name" class="brg-group" t-att-class="{'row-sel': this.selected().has(g.name)}">
              <div class="brg-name">
                <input type="checkbox" class="br-select" t-att-checked="this.selected().has(g.name)" t-on-change="() => this.toggleSelect(g.name)" title="select this branch for batch actions"/>
                <span class="br-branch select-toggle" t-on-click="() => this.toggleSelect(g.name)" t-out="g.name"/>
                <span t-if="this.worktree.isWorktreeBranch(g.name)" class="wt-badge" title="has a worktree">wt</span>
              </div>
              <div class="brg-rows">
                <div t-foreach="g.repos" t-as="r" t-key="r.repo" class="brg-cols brg-row" t-att-class="{active: r.active}">
                  <span class="brg-repo">
                    <a t-if="r.remote and r.github" class="br-repo-link" target="_blank" t-att-href="this.code.remoteBranchUrl(r.github, r.branch)" t-att-title="'open the ' + r.repo + ' branch on GitHub'"><t t-out="r.repo"/><t t-out="this.externalIcon"/></a>
                    <span t-else="" t-out="r.repo"/>
                    <DirtyBadge t-if="r.dirty" path="r.path" repo="r.repo"/>
                  </span>
                  <span class="brg-when" t-att-title="r.date" t-out="r.date ? this.cell(r.date) : '—'"/>
                  <span class="brg-commit" t-att-title="r.subject" t-out="r.subject || '—'"/>
                  <span class="brg-pr">
                    <t t-if="r.pr">
                      <a class="pr-link" target="_blank" t-att-href="r.pr.url" t-out="'#' + r.pr.number"/>
                      <span class="pr-state" t-att-class="this.prState(r.pr)" t-out="this.prState(r.pr)"/>
                    </t>
                    <span t-else="" class="brg-dash">—</span>
                  </span>
                  <span class="brg-act">
                    <button class="dash-kebab" title="branch actions"
                            t-on-click.stop="(ev) => this.openRowMenu(ev, r)"><t t-out="this.kebabIcon"/></button>
                  </span>
                </div>
              </div>
            </div>
            </div>
          </div>
        </div>
      </div>
    </section>`;

  code = plugin(CodePlugin);
  config = plugin(ConfigPlugin);
  dialogs = plugin(DialogPlugin);
  refreshIcon = m(ICONS.refresh);
  externalIcon = m(ICONS.external);
  kebabIcon = m(ICONS.kebab);
  repoFilter = signal(""); // "" = all repositories
  search = signal("");
  selected = signal(new Set()); // branch names ticked for batch actions
  sortKey = signal("update"); // "name" | "update" — default: most recently updated first
  sortDir = signal("desc"); // "asc" | "desc"
  // branches grouped by name (one group per branch name). Each group carries its
  // repo rows and is "active" when the branch is checked out in any of its repos.
  // Sorted by the chosen column (branch name, or summed last-update time).
  groups = computed(() => {
    const { prIndex, pathByRepo, githubByRepo } = this.code.groups();
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
          subject: b.subject || "",
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

  // tick/untick a branch (by name) for batch actions
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

  // total branches (one per repo) across the selected groups, not group count
  get selectedCount() {
    return this.selectedGroups.reduce((n, g) => n + g.repos.length, 0);
  }

  // batch-delete every selected branch in each repo where it can be removed
  // (only the checked-out branch is skipped). Open PRs on the selected branches
  // can be closed first via a checkbox.
  async deleteSelected() {
    const groups = this.selectedGroups;
    if (!groups.length) return;
    const rows = groups.flatMap((g) => g.repos).filter((r) => !this.deleteBlocked(r));
    const total = groups.reduce((n, g) => n + g.repos.length, 0);
    const skipped = total - rows.length;
    const prs = rows.filter((r) => r.pr && r.pr.state === "open" && r.github);
    const remoteRows = rows.filter((r) => r.remote && !r.base);
    const what = groups.length === 1 ? `branch "${groups[0].name}"` : `${groups.length} branches`;
    const fields = [];
    if (remoteRows.length)
      fields.push({
        key: "delRemote",
        type: "checkbox",
        label: `Also delete ${remoteRows.length === 1 ? "it" : "them"} on the remote (odoo-dev)`,
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

  // single-row delete, confirmed via the dialog. When the branch has an open PR
  // it can be closed first; targets that reference this exact branch can be
  // removed in the same step.
  async deleteRow(r) {
    if (this.deleteBlocked(r)) return;
    const canRemote = r.remote && !r.base; // pushed, non-base: removable on the remote
    const hasPr = !!(r.pr && r.pr.state === "open" && r.github);
    const targets = this.config.config.targets.filter((t) =>
      (t.checkouts || []).some((c) => c.repo === r.repo && c.branch === r.branch),
    );
    const fields = [];
    if (canRemote)
      fields.push({
        key: "delRemote",
        type: "checkbox",
        label: "Also delete it on the remote (odoo-dev)",
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
        label: `Delete target "${t.name}"`,
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
    // remove any targets the user opted to delete
    const drop = targets.filter((t) => res[`tgt:${t.id}`]);
    if (drop.length) {
      const ids = new Set(drop.map((t) => t.id));
      for (const t of drop) this.code.eventLog.add(`deleting target ${t.name}`);
      this.config.updateConfig({
        targets: this.config.config.targets.filter((t) => !ids.has(t.id)),
      });
    }
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
    this.code.eventLog.add(`opening PR for ${row.branch} (${row.repo})`);
    window.open(this.code.prCreateUrl(row.github, row.branch), "_blank");
  }

  // build the per-branch action list for this row and open the floating kebab
  // menu anchored to the clicked button (see ActionMenu)
  openRowMenu(ev, r) {
    const rect = ev.currentTarget.getBoundingClientRect();
    const actions = [{ label: "Commits", onClick: () => this.openCommits(r) }];
    if (!r.remote)
      actions.push({
        label: "Push",
        title: "push this branch to the dev remote (odoo-dev)",
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
    this.code.eventLog.add(`checking out ${row.branch} (${row.repo})`);
    this.code.checkout([{ repo: row.repo, path: row.path, branch: row.branch }]);
  }

  pushBranch(row) {
    return pushBranchesDialog(this.code, this.dialogs, [{ path: row.path, branch: row.branch }], {
      title: `Push "${row.branch}"?`,
      message: `Push ${row.branch} (${row.repo}) to the dev remote (odoo-dev)?`,
    });
  }

  // create a new branch based on this one (git branch <new> <branch> — no checkout)
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

  cell(date) {
    return timeAgo(date);
  }

  prState(p) {
    return p.draft && p.state === "open" ? "draft" : p.state;
  }
}

// ─────────────────────────── PRs screen ───────────────────────────

// One PR tracker with a role toggle: "Mine" (gh pr list --author @me, via
// CodePlugin) and "Reviewing" (PRs I commented on but didn't author, via
// ReviewPlugin). Both fold into one normalized row shape and render the same
// grouped-by-branch table (mergebot column, star favorites). Mine adds the
// Close-PR kebab + batch close; Reviewing is read-only.
