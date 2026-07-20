import {
  Component,
  onMounted,
  onWillUnmount,
  usePlugin,
  useProps,
  signal,
  t,
  xml,
} from "@odoo/owl";
import { CodePlugin } from "../core/code_plugin.js";
import { ConfigPlugin } from "../core/config_plugin.js";
import { DatabasePlugin } from "../core/database_plugin.js";
import { DialogPlugin } from "../core/dialog_plugin.js";
import { EventLogPlugin } from "../core/event_log_plugin.js";
import { StorePlugin } from "../core/store_plugin.js";
import { WorkspacePlugin } from "../core/workspace_plugin.js";
import { BASE_BRANCH_RE, baseBranchOf } from "../core/config.js";
import { DirtyBadge, ICONS, editCommitMessage, m } from "../core/common.js";
import { pushBranchesDialog } from "../core/dialogs.js";
import { TerminalDialog } from "../core/terminal.js";
import { branchKey } from "../core/models.js";
import { timeAgo } from "../core/utils.js";
import { createSubWorkspaceFromForwardPort, findSubWorkspace } from "./dialogs.js";
import { CommitHistory } from "./history.js";

// ─────────────────────────── Code pane ───────────────────────────

// The selected workspace's code view: one unified row per checkout — repo + branch,
// sync health (with an inline Rebase when behind), last commit, its PR (number /
// state / CI) and a per-checkout actions menu (rebase, push, editor, terminal,
// commits, WIP, discard). Replaces the old repo strip + branches + PR sections
// (which showed the same facts three times). Data comes from CodePlugin, loaded
// narrowed to the workspace's repos on selection.

export class CodePane extends Component {
  static components = { CommitHistory, DirtyBadge };
  static template = xml`
    <div class="ws-code" t-att-class="{'history-open': this.history()}">
      <t t-if="this.history()">
        <CommitHistory t-key="this.history().seq"
                       row="this.history().row" commits="this.history().commits"
                       diff="this.history().diff" conflict="this.history().conflict"
                       onClose="() => this.closeHistory()" reload="() => this.reloadHistory()"/>
      </t>
      <t t-else="">
      <div class="ws-sec">
        <span>Checkouts</span>
        <button class="pbtn ghost ws-tool ws-tool-start" t-att-disabled="!this.editorPaths.length" t-att-title="this.editAllTitle()" t-on-click="() => this.openAllEditors()"><t t-out="this.codeIcon"/>Editor</button>
        <button class="pbtn ghost ws-tool" t-att-disabled="!this.canRebaseAll()" t-att-title="this.rebaseAllTitle()" t-on-click="() => this.rebaseAll()"><span class="restart"/>Fetch &amp; rebase all</button>
        <button class="pbtn ghost ws-tool" t-att-disabled="!this.canPushAll()" t-att-title="this.pushAllTitle()" t-on-click="() => this.pushAll()"><t t-out="this.pushIcon"/>Push all</button>
        <button class="pbtn ghost ws-tool" t-att-disabled="!this.canPushAll()" t-att-title="this.pushAllForceTitle()" t-on-click="() => this.pushAllForce()"><t t-out="this.pushIcon"/>Push all (force)</button>
      </div>

      <div t-if="!this.checkoutRows.length" class="dim ws-empty-note">This workspace has no checkouts.</div>

      <div class="ws-co-grid">
        <div class="ws-co-card" t-foreach="this.checkoutRows" t-as="r" t-key="r.key">
          <span class="ws-repo-tag" t-out="r.repo"/>
          <div class="ws-co-main">
            <div class="ws-co-branch-row">
              <a t-if="r.remote and r.github" class="ws-branch ws-co-branch branch-link" target="_blank"
                 t-att-href="this.code.remoteBranchUrl(r.repo, r.github, r.branch)" t-att-title="'open ' + r.branch + ' on GitHub'" t-out="r.branch"/>
              <span t-else="" class="ws-branch ws-co-branch" t-att-title="r.branch" t-out="r.branch"/>
              <span t-if="r.checkedOut" class="ws-co-badge">checked out</span>
            </div>
            <div t-if="r.subject" class="ws-commit dim" t-att-class="{viewable: r.sha and r.path}"
                 t-att-title="r.sha and r.path ? 'view the commit history for this branch' : ''"
                 t-on-click="() => this.openHistory(r)">
              <t t-out="r.subject"/><t t-if="r.when"> · <t t-out="r.when"/></t>
            </div>
          </div>
          <div class="ws-co-badges">
            <t t-if="!this.isBaseBranch(r.branch)">
              <t t-if="r.pr">
                <a class="pr-link" t-att-href="r.pr.url" target="_blank" t-out="'#' + r.pr.number"/>
                <span class="pr-state" t-att-class="this.prState(r.pr)" t-out="this.prState(r.pr)"/>
              </t>
              <t t-else="">
                <span class="dim">no pull request</span>
                <a t-if="r.github" class="ws-pr-create" t-att-href="this.code.prCreateUrl(r.repo, r.github, r.branch)" target="_blank" title="create a PR" t-on-click="() => this.touchActivity()">create a PR</a>
              </t>
            </t>
            <span t-if="this.code.repoWorking(r.repo)" class="ws-sync working" title="a git operation is running for this repository (fetch / branch create / checkout / rebase) — large fetches can take a while">
              <span class="ws-sync-dot"/>working…
            </span>
            <DirtyBadge t-if="r.dirty" path="r.path" repo="r.repo"/>
            <span t-if="r.missing and !this.code.repoWorking(r.repo)" class="ws-missing dim">not found locally</span>
            <span t-if="r.checkedOut and !r.missing" class="ws-sync" t-att-class="r.behind ? 'behind' : 'ok'" t-att-title="this.syncTitleRow(r)">
              <span class="ws-sync-dot"/><t t-out="this.syncTextRow(r)"/>
            </span>
            <button t-if="r.behind and r.canRebase" class="ws-rebase-inline" t-att-title="this.rebaseRepoTitle(r.entry)" t-on-click.stop="() => this.rebaseCheckout(r)">Rebase</button>
          </div>
          <button t-if="r.canPush" class="pbtn ghost ws-co-push" t-att-title="this.pushRowTitle(r)" t-on-click="() => this.pushRow(r)"><t t-out="this.pushIcon"/>Push</button>
          <div class="dash-kebab-wrap ws-co-menu" t-if="r.entry">
            <button class="dash-kebab" t-att-class="{open: this.menuId() === r.key}" title="more actions" t-on-click.stop="() => this.toggleMenu(r.key)"><t t-out="this.kebabIcon"/></button>
            <div t-if="this.menuId() === r.key" class="dash-menu" t-on-click.stop="">
              <button t-if="r.checkedOut" class="dash-menu-item" t-att-disabled="!r.canRebase" t-att-title="this.rebaseRepoTitle(r.entry)" t-on-click="() => this.menuAct(() => this.rebaseRepo(r.entry))">Fetch &amp; rebase</button>
              <button class="dash-menu-item" t-att-disabled="!r.canPush" t-att-title="this.pushRowTitle(r)" t-on-click="() => this.menuAct(() => this.pushRow(r))">Push</button>
              <button class="dash-menu-item" t-att-disabled="!r.canPush" t-att-title="this.pushRowTitle(r)" t-on-click="() => this.menuAct(() => this.pushForceRow(r))">Push (force)</button>
              <button t-if="r.entry.canPr" class="dash-menu-item" t-on-click="() => this.menuAct(() => this.openPr(r.entry))">Open PR</button>
              <button class="dash-menu-item" t-att-disabled="!r.path" t-on-click="() => this.menuAct(() => this.openRepoEditor(r))">Open with editor</button>
              <button class="dash-menu-item" t-att-disabled="!r.path" t-on-click="() => this.menuAct(() => this.openTerminal(r.entry))">Open in terminal</button>
              <button class="dash-menu-item" t-att-disabled="!r.path" t-on-click="() => this.menuAct(() => this.openHistory(r))">See commits</button>
              <button t-if="r.dirty" class="dash-menu-item" t-on-click="() => this.menuAct(() => this.commitDialog(r))">Commit</button>
              <button t-if="r.dirty" class="dash-menu-item" t-on-click="() => this.menuAct(() => this.wipCommit(r))">WIP commit</button>
              <button t-if="r.dirty" class="dash-menu-item" t-att-disabled="!r.sha" t-on-click="() => this.menuAct(() => this.amendDialog(r))">Amend commit</button>
              <button t-if="r.dirty" class="dash-menu-item danger" t-on-click="() => this.menuAct(() => this.discard(r))">Discard changes</button>
            </div>
          </div>
        </div>
      </div>

      <t t-if="this.forwardPortChains.length">
        <div class="ws-sec ws-fp-heading"><span>Forward ports</span></div>
        <div class="ws-fp-chain" t-foreach="this.forwardPortChains" t-as="chain" t-key="chain.key">
          <div class="ws-fp-origin">
            <span class="ws-repo-tag" t-out="chain.repo"/>
            <a class="pr-link" target="_blank" t-att-href="this.code.pullRequestUrl(chain.github, chain.number)" t-out="'#' + chain.number"/>
          </div>
          <div class="ws-fp-list">
            <div class="ws-fp-row" t-foreach="chain.rows" t-as="row" t-key="row.branch">
              <a t-if="row.mergebotUrl" class="ws-fp-branch" target="_blank" t-att-href="row.mergebotUrl" t-out="row.branch"/>
              <span t-else="" class="ws-fp-branch" t-out="row.branch"/>
              <div class="ws-fp-cells">
                <div class="ws-fp-cell" t-foreach="row.cells" t-as="cell" t-key="cell.repository">
                  <span t-if="chain.multiRepo" class="ws-fp-repo dim" t-out="cell.repository"/>
                  <span t-if="!cell.pulls.length" class="ws-fp-waiting dim">waiting</span>
                  <span class="ws-fp-pull" t-foreach="cell.pulls" t-as="pull" t-key="pull.github + '#' + pull.number">
                    <a class="pr-link" target="_blank" t-att-href="this.code.pullRequestUrl(pull.github, pull.number)" t-out="'#' + pull.number"/>
                    <span class="ws-fp-status" t-att-class="'is-' + pull.category" t-out="pull.status"/>
                    <span t-if="pull.detail" class="ws-fp-detail" t-out="pull.detail"/>
                    <button t-if="this.hasMissingRPlus(pull)" class="pbtn ws-fp-rplus"
                            t-att-disabled="this.rPlusState(pull)"
                            t-on-click.stop="() => this.postRPlus(pull)"
                            t-out="this.rPlusState(pull) === 'posting' ? 'posting…' : this.rPlusState(pull) === 'posted' ? 'posted' : 'post r+'"/>
                  </span>
                </div>
              </div>
              <button class="pbtn ghost ws-fp-subws"
                      t-att-title="this.subWorkspaceFor(row) ? 'open the existing sub workspace for this forward port' : 'check out this forward port locally as a new sub workspace'"
                      t-on-click.stop="() => this.createSubWorkspace(row)">
                <t t-if="this.subWorkspaceFor(row)">Open sub workspace</t><t t-else="">Create sub workspace</t>
              </button>
            </div>
          </div>
        </div>
      </t>
      </t>
    </div>`;

  props = useProps({ ws: t.any() });
  code = usePlugin(CodePlugin);
  store = usePlugin(StorePlugin);
  config = usePlugin(ConfigPlugin);
  dialogs = usePlugin(DialogPlugin);
  eventLog = usePlugin(EventLogPlugin);
  db = usePlugin(DatabasePlugin);
  wt = usePlugin(WorkspacePlugin);
  codeIcon = m(ICONS.code); // "Editor" toolbar button
  kebabIcon = m(ICONS.kebab); // the per-checkout actions menu
  pushIcon = m(ICONS.push); // the "Push all" toolbar button
  menuId = signal(""); // key of the checkout whose action menu is open ("" = none)
  rPlusPosts = signal({}); // "github#number" -> "posting" | "posted"
  // the open commit-history editor's payload ({row, commits, diff, conflict, seq},
  // null = the checkout grid). Loaded fully by openHistory BEFORE being set, so
  // CommitHistory's first frame is complete; seq keys the component so a reload
  // remounts it fresh.
  history = signal(null);
  _historySequence = 0;
  _historyPendingKey = "";

  setup() {
    // close the repo chip menu on any outside click
    const closeMenu = () => {
      if (this.menuId()) this.menuId.set("");
    };
    onMounted(() => document.addEventListener("click", closeMenu));
    onWillUnmount(() => {
      this._historySequence++;
      document.removeEventListener("click", closeMenu);
    });
  }

  toggleMenu(id) {
    this.menuId.set(this.menuId() === id ? "" : id);
  }

  // repositories shown in the sync strip: this workspace's repos, in config order,
  // joined with live git state (current branch, sync counts) and their PRs
  get repos() {
    const byId = Object.fromEntries(this.code.branchRepos().map((r) => [r.id, r]));
    const groups = this.code.groups();
    const repoIds = new Set((this.props.ws.checkouts || []).map((c) => c.repo));
    return this.config.config.repos
      .filter((r) => repoIds.has(r.id))
      .map((r) => {
        const b = byId[r.id] || {};
        const current = b.current || "";
        const github = groups.githubByRepo[r.id] || "";
        const pr = groups.prIndex[`${r.id}:${current}`] || null;
        return {
          id: r.id,
          current,
          dirty: !!b.dirty,
          subject: b.head_subject || "",
          remote: !!b.head_remote, // the current branch has a remote-tracking ref
          date: b.head_date || "",
          ahead: b.ahead || 0, // commits ahead of the base (target) branch
          behind: b.behind || 0, // commits behind the base (target) branch
          base: baseBranchOf(current),
          error: b.error || "",
          github,
          path: groups.pathByRepo[r.id] || "",
          pull_remote: groups.pullRemoteByRepo[r.id] || "origin",
          push_remote: groups.pushRemoteByRepo[r.id] || "dev",
          pr,
          // a work branch that's pushed and PR-less can have a PR opened for it
          canPr: !!(current && b.head_remote && github && !pr && !BASE_BRANCH_RE.test(current)),
        };
      });
  }

  // per-checkout sync health text/tooltip (only shown when the checkout is actually
  // the repo's current branch, so the behind/ahead counts describe THIS branch)
  syncTextRow(r) {
    return r.behind ? `${r.behind} behind` : "up to date";
  }

  syncTitleRow(r) {
    if (r.behind) {
      const ahead = r.ahead ? ` · ${r.ahead} ahead` : "";
      return `${r.behind} commit${r.behind === 1 ? "" : "s"} behind ${r.base}${ahead}`;
    }
    return `up to date with ${r.base}`;
  }

  // fetch+rebase a single repo's current branch onto its canonical base branch
  canRebaseRepo(r) {
    return !!r.current && !r.dirty && !r.error && !!r.path;
  }

  rebaseRepoTitle(r) {
    if (r.error) return r.error;
    if (r.dirty) return "commit or stash changes first — the working tree is dirty";
    if (!r.path) return "no local path configured for this repository";
    return `fetch and rebase ${r.current} onto ${r.pull_remote}/${baseBranchOf(r.current)}`;
  }

  async rebaseRepo(r) {
    if (!this.canRebaseRepo(r)) return;
    this.touchActivity();
    await this.code.rebase([
      { repo: r.id, base: baseBranchOf(r.current), github: r.github, path: r.path },
    ]);
  }

  // push a checkout's branch to the repo's push remote. Git pushes an explicit
  // branch name (git push <remote> <branch>), so this works whether or not it's
  // checked out — the guard is only that the branch exists locally and is not a
  // base branch (those are never pushed).
  pushRowTitle(r) {
    if (r.entry?.error) return r.entry.error;
    if (!r.path) return "no local path configured for this repository";
    if (this.isBaseBranch(r.branch)) return "base branches cannot be pushed";
    if (!r.canPush) return "the branch does not exist locally";
    return `push ${r.branch} to the ${r.push_remote} remote`;
  }

  async pushRow(r) {
    if (!r.canPush) return;
    const pushed = await pushBranchesDialog(
      this.code,
      this.dialogs,
      [{ path: r.path, branch: r.branch }],
      {
        title: `Push "${r.branch}"?`,
        message: `Push ${r.branch} (${r.repo}) to the ${r.push_remote} remote?`,
      },
    );
    if (pushed) this.touchActivity();
  }

  async pushForceRow(r) {
    if (!r.canPush) return;
    const pushed = await pushBranchesDialog(
      this.code,
      this.dialogs,
      [{ path: r.path, branch: r.branch }],
      {
        title: `Force-push "${r.branch}"?`,
        message: `Force-push ${r.branch} (${r.repo}) to the ${r.push_remote} remote with --force-with-lease? This overwrites the remote branch.`,
        force: true,
      },
    );
    if (pushed) this.touchActivity();
  }

  // every shown repository whose current branch can be fetched + rebased
  get rebasableRepos() {
    return this.repos.filter((r) => this.canRebaseRepo(r));
  }

  // "Fetch & rebase all" operates on the repos' CURRENT branches (git can't rebase
  // a branch without checking it out), so it only means "rebase this workspace's
  // branches" when every checkout is what its repo actually has checked out. A
  // worktree workspace never qualifies: its branches live in the worktree, so the
  // main checkouts this pane rebases are someone else's by construction.
  get wsCheckedOut() {
    const rows = this.checkoutRows;
    return rows.length > 0 && rows.every((r) => r.checkedOut);
  }

  canRebaseAll() {
    return this.wsCheckedOut && this.rebasableRepos.length > 0;
  }

  rebaseAllTitle() {
    if (this.props.ws.location === "worktree")
      return "not available for worktree workspaces — it would rebase the main checkout, not the worktree";
    if (!this.wsCheckedOut)
      return "this workspace is not active — load it first, so rebasing applies to its branches";
    const repos = this.rebasableRepos;
    if (!repos.length)
      return "nothing to rebase — repositories are dirty, missing, or have no local path";
    // spell out each repo's pull remote — checkouts may fetch from different remotes
    return `fetch and rebase ${repos
      .map((r) => `${r.current} (${r.id}) onto ${r.pull_remote}/${baseBranchOf(r.current)}`)
      .join(", ")}`;
  }

  // fetch + rebase every shown repo's current branch onto its base, in one call
  // (guarded on wsCheckedOut: current branches == this workspace's branches)
  async rebaseAll() {
    if (!this.wsCheckedOut) return;
    const repos = this.rebasableRepos.map((r) => ({
      repo: r.id,
      base: baseBranchOf(r.current),
      github: r.github,
      path: r.path,
    }));
    if (repos.length) {
      this.touchActivity();
      await this.code.rebase(repos);
    }
  }

  // every work-branch checkout with something to push — base branches are excluded
  // (canPush), and so are branches already in sync with their remote: "push all"
  // means publishing local changes, not re-pushing what's already there
  get pushableRows() {
    return this.checkoutRows.filter((r) => r.canPush && !r.synced);
  }

  canPushAll() {
    return this.pushableRows.length > 0;
  }

  // spell out each branch's destination — checkouts may push to different remotes
  _pushList(rows) {
    return rows.map((r) => `${r.branch} (${r.repo}) to ${r.push_remote}`).join(", ");
  }

  pushAllTitle() {
    const rows = this.pushableRows;
    if (!rows.length) {
      return this.checkoutRows.some((r) => r.canPush)
        ? "nothing to push — every work branch is already in sync with its remote"
        : "nothing to push — no local work branches (base branches are never pushed)";
    }
    return `push ${this._pushList(rows)}`;
  }

  // push every work-branch checkout to its repo's push remote, one confirm for the batch
  async pushAll() {
    const rows = this.pushableRows;
    if (!rows.length) return;
    const pushed = await pushBranchesDialog(
      this.code,
      this.dialogs,
      rows.map((r) => ({ path: r.path, branch: r.branch })),
      {
        title: `Push ${rows.length} branch${rows.length === 1 ? "" : "es"}?`,
        message: `Push ${this._pushList(rows)}?`,
      },
    );
    if (pushed) this.touchActivity();
  }

  pushAllForceTitle() {
    const rows = this.pushableRows;
    if (!rows.length) {
      return this.checkoutRows.some((r) => r.canPush)
        ? "nothing to push — every work branch is already in sync with its remote"
        : "nothing to push — no local work branches (base branches are never pushed)";
    }
    return `force-push ${this._pushList(rows)} with --force-with-lease`;
  }

  // force-push every work-branch checkout to its repo's push remote, one confirm for the batch
  async pushAllForce() {
    const rows = this.pushableRows;
    if (!rows.length) return;
    const pushed = await pushBranchesDialog(
      this.code,
      this.dialogs,
      rows.map((r) => ({ path: r.path, branch: r.branch })),
      {
        title: `Force-push ${rows.length} branch${rows.length === 1 ? "" : "es"}?`,
        message: `Force-push ${this._pushList(rows)} with --force-with-lease? This overwrites the remote branches.`,
        force: true,
      },
    );
    if (pushed) this.touchActivity();
  }

  // local checkout folders of every shown repo, for "Edit" (open them all at once)
  get editorPaths() {
    return this.repos.map((r) => r.path).filter(Boolean);
  }

  editAllTitle() {
    const n = this.editorPaths.length;
    if (!n) return "no local repository folders to open";
    const editor = (this.config.config.editor || "code").trim();
    return `open ${n} repositor${n === 1 ? "y" : "ies"} in ${editor}`;
  }

  // open every shown repo's folder in the configured editor, all in one window
  openAllEditors() {
    const paths = this.editorPaths;
    if (paths.length) {
      this.touchActivity();
      this.code.openEditorPaths(paths, "all repositories");
    }
  }

  // open a modal bash terminal in this repo's directory
  openTerminal(r) {
    if (!r.path) return;
    this.touchActivity();
    this.dialogs.openComponent(TerminalDialog, { path: r.path, label: r.id });
  }

  openRepoEditor(r) {
    if (!r.path) return;
    this.touchActivity();
    this.code.openEditor(r.path, r.repo);
  }

  // Load the branch history + its head diff behind the still-visible checkout
  // table, then set `history` last as the single visibility gate. This avoids an
  // empty intermediate history render while the two git requests are in flight.
  async openHistory(r) {
    if (!r.path || !r.sha) return;
    if (this._historyPendingKey === r.key) return;
    this.touchActivity();
    this.menuId.set("");
    this._historyPendingKey = r.key;
    const sequence = ++this._historySequence;
    try {
      const [commits, stuck, clickedDiff] = await Promise.all([
        this.code.commits(r.path, r.branch, {
          base: r.base,
          pullRemote: r.entry?.pull_remote || "",
          count: 100,
        }),
        // checked fresh every open — not just right after an apply's own
        // conflict — so a rebase left stuck from a previous session is never
        // invisible. A failed check is treated as "not stuck" rather than
        // blocking the list on an unrelated error.
        this.code.rebaseStatus(r.path).catch(() => false),
        this.code.commitDiff(r.path, r.sha),
      ]);
      if (sequence !== this._historySequence) return;
      if (!commits.length) throw new Error(`No commits found for ${r.branch}.`);
      const head = commits[0];
      // The branch may have advanced since checkoutRows was last refreshed. In
      // that rare case, load the returned head instead of revealing a mismatched
      // selected commit and patch.
      const diff = head.sha === r.sha ? clickedDiff : await this.code.commitDiff(r.path, head.sha);
      if (sequence !== this._historySequence) return;
      this.history.set({
        row: r,
        commits,
        diff,
        conflict: stuck ? "a rebase is already in progress in this repository" : "",
        seq: sequence,
      });
    } catch (e) {
      if (sequence !== this._historySequence) return;
      this.dialogs.error("Could not load commit history", e.message);
    } finally {
      if (sequence === this._historySequence) this._historyPendingKey = "";
    }
  }

  closeHistory() {
    this._historySequence++;
    this.history.set(null);
  }

  // after a history rewrite (apply/abort): refresh this repo's branch state — a
  // rebase changes shas/subjects the checkout card also shows — and re-open the
  // history, which remounts CommitHistory with the fresh commits
  reloadHistory() {
    const row = this.history()?.row;
    if (!row) return;
    return Promise.all([this.code.refreshBranches(new Set([row.repo])), this.openHistory(row)]);
  }

  // open GitHub's PR-creation page for this repo's current branch
  openPr(r) {
    this.touchActivity();
    this.eventLog.add(`opening PR for ${r.current} (${r.id})`);
    window.open(this.code.prCreateUrl(r.id, r.github, r.current), "_blank");
  }

  // one row per checkout, joined with live git state, sync counts, its PR, and the
  // rich repo entry (for the actions menu). Sync + rebase/push are only meaningful
  // when this checkout is the repo's current branch (c.matches) — the behind/ahead
  // counts and the repo's actions are for whatever is actually checked out.
  get checkoutRows() {
    const view = this.store.workspaceView(this.props.ws);
    const gitByRepo = new Map(this.code.branchRepos().map((r) => [r.id, r]));
    const entryByRepo = new Map(this.repos.map((r) => [r.id, r]));
    const prIndex = this.code.groups().prIndex;
    return (view.checkouts || []).map((c) => {
      const git = gitByRepo.get(c.repo);
      const b = (git?.branches || []).find((x) => x.name === c.branch);
      const entry = entryByRepo.get(c.repo) || null;
      const checkedOut = !!c.matches;
      return {
        key: branchKey(c.repo, c.branch),
        repo: c.repo,
        branch: c.branch,
        checkedOut,
        dirty: !!(c.matches && c.dirty),
        missing: !!git && !b,
        remote: !!(b && b.remote), // the branch has a remote-tracking ref
        synced: !!(b && b.remote && b.synced), // …and the local tip is what's on the remote
        subject: b?.subject || "",
        sha: b?.sha || "",
        when: b?.date ? timeAgo(b.date) : "",
        pr: prIndex[branchKey(c.repo, c.branch)] || null,
        github: entry?.github || "",
        path: entry?.path || "",
        push_remote: entry?.push_remote || "dev",
        base: entry?.base || baseBranchOf(c.branch),
        behind: checkedOut ? entry?.behind || 0 : 0,
        ahead: checkedOut ? entry?.ahead || 0 : 0,
        canRebase: checkedOut && !!entry && this.canRebaseRepo(entry),
        // push works on any local branch (explicit refspec) — checkout not required,
        // but base branches are never pushed
        canPush: !!(b && entry && !entry.error && entry.path) && !this.isBaseBranch(c.branch),
        entry, // the rich repo entry (this.repos) the actions menu operates on
      };
    });
  }

  // One matrix per merged checkout PR. Rows are already sliced by the backend so
  // only branches after the workspace's target are shown (including empty ones).
  get forwardPortChains() {
    const states = this.code.mergebot();
    const matrices = this.code.mbForwardPorts();
    const chains = [];
    const seenMatrices = new Set();
    for (const row of this.checkoutRows) {
      if (!row.pr || !row.github) continue;
      const key = `${row.github}#${row.pr.number}`;
      const rows = matrices[key];
      if (states[key] !== "merged" || !Array.isArray(rows) || !rows.length) continue;
      // Linked community/enterprise PR pages expose the same matrix. When both are
      // workspace checkouts, render that chain once instead of duplicating it.
      const signature = JSON.stringify(rows);
      if (seenMatrices.has(signature)) continue;
      seenMatrices.add(signature);
      const linkedRows = rows.map((forwardRow) => {
        const firstPull = forwardRow.cells.flatMap((cell) => cell.pulls)[0];
        return {
          ...forwardRow,
          mergebotUrl: firstPull ? this.code.mergebotUrl(firstPull.github, firstPull.number) : "",
        };
      });
      chains.push({
        key,
        repo: row.repo,
        github: row.github,
        number: row.pr.number,
        rows: linkedRows,
        multiRepo: (rows[0]?.cells || []).length > 1,
      });
    }
    return chains;
  }

  _dialogPlugins() {
    return {
      config: this.config,
      dialogs: this.dialogs,
      db: this.db,
      code: this.code,
      eventLog: this.eventLog,
      wt: this.wt,
    };
  }

  createSubWorkspace(row) {
    return createSubWorkspaceFromForwardPort(this._dialogPlugins(), this.props.ws, row);
  }

  subWorkspaceFor(row) {
    return findSubWorkspace(this.config, this.props.ws, row);
  }

  rPlusKey(pull) {
    return `${pull.github}#${pull.number}`;
  }

  hasMissingRPlus(pull) {
    return `${pull.status || ""} ${pull.detail || ""}`.toLowerCase().includes("missing r+");
  }

  rPlusState(pull) {
    return this.rPlusPosts()[this.rPlusKey(pull)] || "";
  }

  async postRPlus(pull) {
    const key = this.rPlusKey(pull);
    if (this.rPlusPosts()[key]) return;
    this.rPlusPosts.set({ ...this.rPlusPosts(), [key]: "posting" });
    const posted = await this.code.postRPlus(pull.github, pull.number);
    const next = { ...this.rPlusPosts() };
    if (posted) next[key] = "posted";
    else delete next[key];
    this.rPlusPosts.set(next);
  }

  // fetch + rebase this checkout's branch (its repo entry) onto its base
  rebaseCheckout(r) {
    if (r.entry) this.rebaseRepo(r.entry);
  }

  isBaseBranch(branch) {
    return BASE_BRANCH_RE.test(branch);
  }

  // run a menu action then close the checkout's actions menu
  menuAct(fn) {
    this.menuId.set("");
    fn();
  }

  touchActivity() {
    this.config.workspace(this.props.ws.id)?.touchActivity();
  }

  // prompt for a message (the shared textarea editor — also used by the dirty
  // badge's own Commit entry and CommitsDialog's reword affordance) then stage
  // everything and commit with it
  async commitDialog(r) {
    const message = await editCommitMessage(this.dialogs, {
      title: `Commit — ${r.repo}`,
      okLabel: "Commit",
    });
    if (!message) return;
    this.touchActivity();
    return this.code.commit(r.path, r.repo, message);
  }

  wipCommit(r) {
    this.touchActivity();
    return this.code.wipCommit(r.path, r.repo);
  }

  // the row's subject line is a summary only (branchRepos never fetches commit
  // bodies up front) — fetch the full message on demand for an edit/amend dialog's
  // prefill, so a multi-line message isn't silently truncated to its first line;
  // falls back to the subject alone if the fetch fails
  async _fullCommitMessage(r) {
    try {
      return await this.code.commitMessage(r.path, r.sha);
    } catch {
      return r.subject;
    }
  }

  // stage all changes and fold them into HEAD with a (possibly edited) message
  async amendDialog(r) {
    const message = await editCommitMessage(this.dialogs, {
      title: `Amend commit — ${r.repo}`,
      initialMessage: await this._fullCommitMessage(r),
      okLabel: "Amend",
    });
    if (!message) return;
    this.touchActivity();
    return this.code.amendCommit(r.path, r.repo, message);
  }

  discard(r) {
    this.touchActivity();
    return this.code.discard(r.path, r.repo);
  }

  // the PR's GitHub state for the pill: open / draft / closed / merged (the
  // runbot/CI signal lives in the workspace header, not per card)
  prState(pr) {
    return pr.draft && pr.state === "open" ? "draft" : pr.state;
  }
}
