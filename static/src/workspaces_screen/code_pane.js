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
import { BASE_BRANCH_RE } from "../core/config.js";
import { DirtyBadge, ICONS, editCommitMessage, m } from "../core/common.js";
import { pushBranchesDialog } from "../core/dialogs.js";
import { TerminalDialog } from "../core/terminal.js";
import { startRowDrag, dropIndex } from "../core/drag.js";
import { branchKey } from "../core/models.js";
import { timeAgo } from "../core/utils.js";
import { createSubWorkspaceFromForwardPort, findSubWorkspace } from "./dialogs.js";

// ─────────────────────────── Code pane ───────────────────────────

// The selected workspace's code view: one unified row per checkout — repo + branch,
// sync health (with an inline Rebase when behind), last commit, its PR (number /
// state / CI) and a per-checkout actions menu (rebase, push, editor, terminal,
// commits, WIP, discard). Replaces the old repo strip + branches + PR sections
// (which showed the same facts three times). Data comes from CodePlugin, loaded
// narrowed to the workspace's repos on selection.

export class CodePane extends Component {
  static components = { DirtyBadge };
  static template = xml`
    <div class="ws-code" t-att-class="{'history-open': this.historyRow()}">
      <t t-if="this.historyRow()">
        <div class="ws-history">
          <div class="ws-history-head">
            <button class="ws-history-back" title="back to checkouts" t-on-click="() => this.closeHistory()">←</button>
            <span class="ws-repo-tag" t-out="this.historyRow().repo"/>
            <span class="ws-branch" t-out="this.historyRow().branch"/>
          </div>
          <div class="ws-history-layout">
            <aside class="ws-history-list" t-ref="this.historyListEl">
              <div t-foreach="this.historyOrderedCommits" t-as="commit" t-key="commit.sha"
                   class="ws-history-row" t-att-class="{dragging: this.historyDragSha() === commit.sha, selected: commit.sha === this.historySelected(), 'ws-history-row-ahead': commit.ahead}"
                   t-att-data-sha="commit.sha">
                <span t-if="commit.ahead and this.historyAheadCount > 1 and !this.historyConflict()" class="row-handle" title="drag to reorder"
                      t-on-pointerdown.stop="(ev) => this.onHistoryRowDragStart(ev, commit)">⠿</span>
                <span t-else="" class="row-handle-spacer"/>
                <button class="ws-history-commit" t-on-click="() => this.selectHistoryCommit(commit)">
                  <span class="ws-history-commit-date" t-att-title="this.fullCommitDate(commit.date)" t-out="this.shortCommitDate(commit.date)"/>
                  <span class="ws-history-commit-title" t-out="this.historySubject(commit)"/>
                  <span class="ws-history-commit-author" t-out="commit.author"/>
                </button>
                <button t-if="this.canSquashHistory(commit.sha) and !this.historyConflict()" class="commit-squash-btn" t-att-class="{on: this.isHistorySquashed(commit.sha)}"
                        t-att-title="this.isHistorySquashed(commit.sha) ? 'squashed into the commit below — click to undo' : 'squash into the commit below'"
                        t-on-click.stop="() => this.toggleHistorySquash(commit.sha)">↓</button>
                <span t-else="" class="commit-squash-spacer"/>
              </div>
            </aside>
            <section class="ws-history-detail">
              <t t-if="this.historyCommit">
                <div class="ws-history-message-zone" t-on-focusout="(ev) => this.saveHistoryMessageOnBlur(ev)">
                  <div class="ws-history-title-row">
                    <input t-if="this.historyCommitEditable" class="ws-history-title ws-history-title-input" type="text"
                           t-att-class="{invalid: !this.historySubject(this.historyCommit).trim()}"
                           aria-label="commit title" t-att-value="this.historySubject(this.historyCommit)"
                           t-att-disabled="this.historyApplying() or this.historyConflict()"
                           t-on-input="(ev) => this.updateHistoryMessage(this.historyCommit, 'subject', ev.target.value)"/>
                    <h2 t-else="" class="ws-history-title" t-out="this.historySubject(this.historyCommit)"/>
                    <div t-if="this.historyCommitEditable" class="dash-kebab-wrap ws-history-actions">
                      <button class="dash-kebab" t-att-class="{open: this.historyMenuSha() === this.historyCommit.sha}"
                              title="more actions" t-att-disabled="this.historyApplying() or this.historyConflict()"
                              t-on-click.stop="() => this.toggleHistoryMenu(this.historyCommit.sha)"><t t-out="this.kebabIcon"/></button>
                      <div t-if="this.historyMenuSha() === this.historyCommit.sha" class="dash-menu" t-on-click.stop="">
                        <button class="dash-menu-item danger" t-att-disabled="this.historyStructureDirty"
                                t-att-title="this.historyStructureDirty ? 'apply or reset the pending reorder/squash first' : 'drop this commit'"
                                t-on-click="() => this.dropHistoryCommit(this.historyCommit)">Drop commit</button>
                      </div>
                    </div>
                  </div>
                  <div class="ws-history-meta">
                    <div class="ws-history-meta-row">
                      <span class="ws-history-author" t-out="this.historyCommit.author"/>
                      <span class="ws-history-hash" t-out="this.historyCommit.sha"/>
                    </div>
                    <div class="ws-history-meta-row">
                      <span t-out="this.fullCommitDate(this.historyCommit.date)"/>
                      <span t-if="!this.historyDiffLoading() and !this.historyDiffError()" class="ws-history-diffstats">
                        <span class="add" t-out="'+' + this.historyDiffStats.added"/>
                        <span class="del" t-out="'-' + this.historyDiffStats.deleted"/>
                      </span>
                      <span t-else="" class="ws-history-diffstats">…</span>
                    </div>
                  </div>
                  <textarea t-if="this.historyCommitEditable" class="ws-history-body ws-history-body-input"
                            aria-label="commit message" placeholder="Commit message (optional)"
                            t-att-value="this.historyBody(this.historyCommit)"
                            t-att-disabled="this.historyApplying() or this.historyConflict()"
                            t-on-input="(ev) => this.updateHistoryMessage(this.historyCommit, 'body', ev.target.value)"/>
                  <pre t-elif="this.historyBody(this.historyCommit)" class="ws-history-body" t-out="this.historyBody(this.historyCommit)"/>
                  <span t-if="this.historyApplying() and Object.keys(this.historyMessageEdits()).length" class="ws-history-message-saving">
                    <span class="ws-refresh-spin"/>Saving commit message…
                  </span>
                </div>
                <div t-if="this.historyDiffLoading()" class="ws-history-diff-state dim"><span class="ws-refresh-spin"/>Loading diff…</div>
                <div t-elif="this.historyDiffError()" class="ws-history-diff-state form-error" t-out="this.historyDiffError()"/>
                <div t-elif="!this.historyDiff()" class="ws-history-diff-state dim">This commit has no file changes.</div>
                <div t-else="" class="ws-history-diff">
                  <div t-foreach="this.historyDiffLines" t-as="line" t-key="line.id"
                       class="ws-history-diff-line" t-att-class="line.cls" t-out="line.text || ' '"/>
                </div>
              </t>
              <div t-else="" class="ws-history-state dim">Select a commit to see its details.</div>
            </section>
          </div>
          <div t-if="this.historyConflict()" class="commits-conflict">
            <span class="commits-conflict-msg" t-out="this.historyConflict()"/>
            <span class="wt-sp"/>
            <button class="pbtn" t-att-disabled="this.historyApplying()" t-on-click="() => this.abortHistoryConflict()">Abort rebase</button>
            <button class="pbtn primary" t-on-click="() => this.openHistoryConflictTerminal()">Open terminal</button>
          </div>
          <div t-elif="this.historyStructureDirty" class="commits-foot">
            <span class="dim" t-out="this.historyPlanSummary"/>
            <span class="wt-sp"/>
            <button class="pbtn" t-att-disabled="this.historyApplying()" t-on-click="() => this.resetHistoryPlan()">Reset</button>
            <button class="pbtn primary" t-att-disabled="this.historyApplying() or !this.historyPlanValid" t-on-click="() => this.applyHistoryPlan()">
              <t t-if="this.historyApplying()">Applying…</t><t t-else="">Apply</t>
            </button>
          </div>
        </div>
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
            <a t-if="r.remote and r.github" class="ws-branch ws-co-branch branch-link" target="_blank"
               t-att-href="this.code.remoteBranchUrl(r.repo, r.github, r.branch)" t-att-title="'open ' + r.branch + ' on GitHub'" t-out="r.branch"/>
            <span t-else="" class="ws-branch ws-co-branch" t-att-title="r.branch" t-out="r.branch"/>
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
            <span t-if="r.checkedOut" class="ws-co-badge">checked out</span>
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
  historyRow = signal(null);
  historyCommits = signal([]);
  historySelected = signal("");
  historyDiff = signal("");
  historyDiffLoading = signal(false);
  historyDiffError = signal("");
  // the reorder/squash plan, kept purely client-side until "Apply": historyPlanIds
  // is the desired order of "ahead" shas in DISPLAY order (newest-first, same as
  // historyCommits()); historySquashSet marks a sha as folding into whichever
  // entry ends up directly BELOW it (older) once historyPlanIds is applied.
  // Nothing here touches git until applyHistoryPlan() sends the whole thing as
  // one rebase.
  historyPlanIds = signal([]);
  historySquashSet = signal(new Set());
  historyDropSet = signal(new Set());
  // sha -> {subject, body}; only entries that differ from git are retained.
  // Message edits travel with the reorder/squash plan and are applied by the
  // same interactive rebase, so editing never invalidates the pending shas.
  historyMessageEdits = signal({});
  historyMenuSha = signal("");
  historyDragSha = signal(""); // sha of the row being dragged ("" = none)
  historyApplying = signal(false);
  // set only when applyHistoryPlan's rebase conflicted and was left mid-flight,
  // OR openHistory found one already stuck from a previous session — the error
  // message, "" once resolved
  historyConflict = signal("");
  historyListEl = signal.ref(HTMLElement);
  _historySequence = 0;
  _diffSequence = 0;
  _historyPendingKey = "";
  _historyActionActive = false;

  setup() {
    // close the repo chip menu on any outside click
    const closeMenu = () => {
      if (this.menuId()) this.menuId.set("");
      if (this.historyMenuSha()) this.historyMenuSha.set("");
    };
    const onKeydown = (ev) => {
      if (ev.key !== "Escape" || !this.historyRow()) return;
      if (this.historyMenuSha()) this.historyMenuSha.set("");
      else this.closeHistory();
    };
    onMounted(() => document.addEventListener("click", closeMenu));
    onMounted(() => document.addEventListener("keydown", onKeydown));
    onWillUnmount(() => {
      this._historySequence++;
      this._diffSequence++;
      document.removeEventListener("click", closeMenu);
      document.removeEventListener("keydown", onKeydown);
    });
  }

  toggleMenu(id) {
    this.menuId.set(this.menuId() === id ? "" : id);
  }

  toggleHistoryMenu(sha) {
    this.historyMenuSha.set(this.historyMenuSha() === sha ? "" : sha);
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
          base: this._baseBranch(current),
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

  // the canonical base branch a branch derives from: master-owl-update -> master,
  // 19.0-some-fix -> 19.0 (defaults to master)
  _baseBranch(branch) {
    return (/^(saas-\d+\.\d+|\d+\.\d+|master)/.exec(branch) || ["", "master"])[1];
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
    return `fetch and rebase ${r.current} onto ${r.pull_remote}/${this._baseBranch(r.current)}`;
  }

  async rebaseRepo(r) {
    if (!this.canRebaseRepo(r)) return;
    this.touchActivity();
    await this.code.rebase([
      { repo: r.id, base: this._baseBranch(r.current), github: r.github, path: r.path },
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
      .map((r) => `${r.current} (${r.id}) onto ${r.pull_remote}/${this._baseBranch(r.current)}`)
      .join(", ")}`;
  }

  // fetch + rebase every shown repo's current branch onto its base, in one call
  // (guarded on wsCheckedOut: current branches == this workspace's branches)
  async rebaseAll() {
    if (!this.wsCheckedOut) return;
    const repos = this.rebasableRepos.map((r) => ({
      repo: r.id,
      base: this._baseBranch(r.current),
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
  // table, then set historyRow last as the single visibility gate. This avoids an
  // empty intermediate history render while the two git requests are in flight.
  async openHistory(r) {
    if (!r.path || !r.sha) return;
    if (this._historyPendingKey === r.key) return;
    this.touchActivity();
    this.menuId.set("");
    this.historyConflict.set("");
    this._historyPendingKey = r.key;
    const sequence = ++this._historySequence;
    ++this._diffSequence;
    try {
      const [commits, stuck, clickedDiff] = await Promise.all([
        this.code.commits(r.path, r.branch, {
          base: r.base,
          pullRemote: r.entry?.pull_remote || "",
          count: 100,
        }),
        // checked fresh every open — not just right after applyHistoryPlan's own
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

      // All history state is populated while the checkout template is still the
      // active branch. Setting historyRow last reveals a complete first frame.
      this.historyCommits.set(commits);
      this.resetHistoryPlan();
      this.historyConflict.set(stuck ? "a rebase is already in progress in this repository" : "");
      this.historySelected.set(head.sha);
      this.historyDiff.set(diff);
      this.historyDiffLoading.set(false);
      this.historyDiffError.set("");
      this.historyRow.set(r);
    } catch (e) {
      if (sequence !== this._historySequence) return;
      this.dialogs.open({
        title: "Could not load commit history",
        message: e.message,
        cls: "dialog-error",
        okLabel: "OK",
        cancelLabel: null,
      });
    } finally {
      if (sequence === this._historySequence) this._historyPendingKey = "";
    }
  }

  closeHistory() {
    this._historySequence++;
    this._diffSequence++;
    this.historyRow.set(null);
    this.historyCommits.set([]);
    this.historySelected.set("");
    this.historyDiff.set("");
    this.historyDiffLoading.set(false);
    this.historyDiffError.set("");
    this.historyPlanIds.set([]);
    this.historySquashSet.set(new Set());
    this.historyDropSet.set(new Set());
    this.historyMessageEdits.set({});
    this.historyMenuSha.set("");
    this.historyConflict.set("");
  }

  async selectHistoryCommit(commit) {
    const row = this.historyRow();
    if (!row || !commit || (commit.sha === this.historySelected() && this.historyDiff())) return;
    this.historySelected.set(commit.sha);
    this.historyDiff.set("");
    this.historyDiffError.set("");
    this.historyDiffLoading.set(true);
    const sequence = ++this._diffSequence;
    try {
      const diff = await this.code.commitDiff(row.path, commit.sha);
      if (sequence === this._diffSequence) this.historyDiff.set(diff);
    } catch (e) {
      if (sequence === this._diffSequence) this.historyDiffError.set(e.message);
    } finally {
      if (sequence === this._diffSequence) this.historyDiffLoading.set(false);
    }
  }

  get historyCommit() {
    return this.historyCommits().find((commit) => commit.sha === this.historySelected()) || null;
  }

  get historyCommitEditable() {
    return this.isHistoryCommitEditable(this.historyCommit);
  }

  isHistoryCommitEditable(commit) {
    return !!commit?.ahead && !this.isHistorySquashed(commit.sha);
  }

  historySubject(commit) {
    return this.historyMessageEdits()[commit?.sha]?.subject ?? commit?.subject ?? "";
  }

  historyBody(commit) {
    return this.historyMessageEdits()[commit?.sha]?.body ?? commit?.body ?? "";
  }

  updateHistoryMessage(commit, field, value) {
    if (!this.isHistoryCommitEditable(commit) || this.historyApplying() || this.historyConflict()) {
      return;
    }
    const next = {
      subject: this.historySubject(commit),
      body: this.historyBody(commit),
      [field]: value,
    };
    const edits = { ...this.historyMessageEdits() };
    if (next.subject === commit.subject && next.body === commit.body) delete edits[commit.sha];
    else edits[commit.sha] = next;
    this.historyMessageEdits.set(edits);
  }

  saveHistoryMessageOnBlur(ev) {
    // Title + body are one editing zone: tabbing/clicking from one to the other
    // must not trigger two rebases. Leaving the zone applies the pending message
    // (and any reorder/squash plan it belongs to) as one atomic history rewrite.
    if (this._historyActionActive) return;
    if (ev.relatedTarget && ev.currentTarget.contains(ev.relatedTarget)) return;
    if (!Object.keys(this.historyMessageEdits()).length || !this.historyPlanValid) return;
    this.applyHistoryPlan();
  }

  async dropHistoryCommit(commit) {
    if (
      !this.isHistoryCommitEditable(commit) ||
      this.historyApplying() ||
      this.historyConflict() ||
      this.historyStructureDirty
    ) {
      return;
    }
    // Opening the confirmation moves focus out of the message fields. Suppress
    // their normal blur-save while the destructive action owns that transition.
    this._historyActionActive = true;
    this.historyMenuSha.set("");
    let confirmed;
    try {
      confirmed = await this.dialogs.open({
        title: `Drop "${this.historySubject(commit)}"?`,
        message: "This permanently removes the commit and its changes from this branch.",
        okLabel: "Drop",
      });
    } finally {
      this._historyActionActive = false;
    }
    if (!confirmed) return;

    const edits = { ...this.historyMessageEdits() };
    delete edits[commit.sha];
    this.historyMessageEdits.set(edits);
    this.historyDropSet.set(new Set([commit.sha]));
    await this.applyHistoryPlan();
  }

  shortCommitDate(date) {
    return date ? timeAgo(date) : "—";
  }

  fullCommitDate(date) {
    if (!date) return "—";
    const value = new Date(date);
    return Number.isNaN(value.getTime()) ? date : value.toLocaleString();
  }

  get historyDiffLines() {
    return this.historyDiff()
      .split("\n")
      .filter((text) => !text.startsWith("diff --git ") && !text.startsWith("index "))
      .map((text, id) => {
        let cls = "";
        if (text.startsWith("+") && !text.startsWith("+++")) cls = "add";
        else if (text.startsWith("-") && !text.startsWith("---")) cls = "del";
        else if (text.startsWith("@@")) cls = "hunk";
        else if (/^(--- |\+\+\+ )/.test(text)) cls = "meta";
        return { id, text, cls };
      });
  }

  // ── history: reorder / squash ────────────────────────────────────────────────
  // the ahead ("own", reorderable) commits in their pending historyPlanIds
  // order, followed by the frozen inherited tail in its original (untouched)
  // order — ahead commits are always the top segment of historyCommits(), so
  // this only ever reshuffles within that segment, never past it
  get historyOrderedCommits() {
    const byId = new Map(this.historyCommits().map((c) => [c.sha, c]));
    const tail = this.historyCommits().filter((c) => !c.ahead);
    return [
      ...this.historyPlanIds()
        .map((sha) => byId.get(sha))
        .filter(Boolean),
      ...tail,
    ];
  }

  get historyAheadCount() {
    return this.historyPlanIds().length;
  }

  // any commit but the oldest ahead one can squash into whatever ends up
  // directly below it
  canSquashHistory(sha) {
    const ids = this.historyPlanIds();
    const i = ids.indexOf(sha);
    return i >= 0 && i < ids.length - 1;
  }

  isHistorySquashed(sha) {
    return this.historySquashSet().has(sha);
  }

  toggleHistorySquash(sha) {
    if (this.historyApplying() || this.historyConflict() || !this.canSquashHistory(sha)) return;
    const s = new Set(this.historySquashSet());
    if (s.has(sha)) s.delete(sha);
    else {
      s.add(sha);
      // A squashed commit disappears into the commit below it, so it cannot
      // retain an independent message. Avoid silently applying an invisible edit.
      const edits = { ...this.historyMessageEdits() };
      delete edits[sha];
      this.historyMessageEdits.set(edits);
    }
    this.historySquashSet.set(s);
  }

  get historyDirty() {
    return this.historyStructureDirty || Object.keys(this.historyMessageEdits()).length > 0;
  }

  get historyStructureDirty() {
    const original = this.historyCommits()
      .filter((c) => c.ahead)
      .map((c) => c.sha);
    return (
      this.historyPlanIds().join("\0") !== original.join("\0") ||
      this.historySquashSet().size > 0 ||
      this.historyDropSet().size > 0
    );
  }

  get historyPlanValid() {
    return Object.values(this.historyMessageEdits()).every((edit) => edit.subject.trim());
  }

  get historyPlanSummary() {
    const total = this.historyPlanIds().length;
    const squashed = this.historySquashSet().size;
    const dropped = this.historyDropSet().size;
    const edited = Object.keys(this.historyMessageEdits()).length;
    const changes = [];
    if (squashed) changes.push(`${total} commits → ${total - squashed}`);
    else if (
      this.historyPlanIds().join("\0") !==
      this.historyCommits()
        .filter((commit) => commit.ahead)
        .map((commit) => commit.sha)
        .join("\0")
    ) {
      changes.push("reordered");
    }
    if (dropped) changes.push(`${dropped} dropped`);
    if (edited) changes.push(`${edited} message${edited === 1 ? "" : "s"} edited`);
    return changes.join(" · ");
  }

  resetHistoryPlan() {
    this.historyPlanIds.set(
      this.historyCommits()
        .filter((c) => c.ahead)
        .map((c) => c.sha),
    );
    this.historySquashSet.set(new Set());
    this.historyDropSet.set(new Set());
    this.historyMessageEdits.set({});
  }

  // Shared pointer drag (core/drag.js): the grabbed row lifts into a ghost that
  // follows the cursor, while the real row — dimmed in place — live-reorders
  // through the ahead rows as the pointer crosses their midlines. Drop just
  // updates the pending plan (git untouched until Apply); Escape restores it.
  onHistoryRowDragStart(ev, commit) {
    if (this.historyApplying() || this.historyConflict()) return;
    const original = this.historyPlanIds();
    const stop = startRowDrag(ev, {
      row: ev.target.closest(".ws-history-row"),
      onMove: (e) => this._historyDragMove(e, commit.sha),
      onEnd: (didCommit) => {
        this.historyDragSha.set("");
        if (!didCommit) this.historyPlanIds.set(original);
      },
    });
    if (!stop) return;
    this.historyDragSha.set(commit.sha);
  }

  _historyDragMove(ev, sha) {
    const rows = [...(this.historyListEl()?.querySelectorAll(".ws-history-row-ahead") || [])];
    const to = dropIndex(
      ev,
      rows.filter((r) => !r.classList.contains("dragging")),
    );
    const ids = this.historyPlanIds();
    const from = ids.indexOf(sha);
    if (from < 0 || from === to) return;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, sha);
    this.historyPlanIds.set(next);
  }

  // send the whole pending plan as one rebase — oldest-first, as the backend
  // expects (historyPlanIds is newest-first, matching the display). A conflict
  // doesn't get the generic error dialog — it leaves the rebase mid-flight, so
  // the panel switches to a persistent banner offering to abort it or open a
  // terminal to resolve it by hand, rather than a dismissable popup that could
  // be closed while a rebase sits half-applied.
  async applyHistoryPlan() {
    if (
      this.historyApplying() ||
      this.historyConflict() ||
      !this.historyDirty ||
      !this.historyPlanValid
    ) {
      return;
    }
    const row = this.historyRow();
    if (!row) return;
    const edits = this.historyMessageEdits();
    const plan = [...this.historyPlanIds()].reverse().map((sha) => {
      const entry = {
        sha,
        squash: this.historySquashSet().has(sha),
        drop: this.historyDropSet().has(sha),
      };
      if (edits[sha]) {
        entry.message = edits[sha].body
          ? `${edits[sha].subject.trim()}\n\n${edits[sha].body}`
          : edits[sha].subject.trim();
      }
      return entry;
    });
    this.historyApplying.set(true);
    try {
      await this.code.rewriteHistory(row.path, row.base, plan, row.entry?.pull_remote || "");
      // a rebase changes shas/subjects the checkout card also shows — refresh
      // this repo's branch state so "back to checkouts" isn't stale
      await Promise.all([this.code.refreshBranches(new Set([row.repo])), this.openHistory(row)]);
    } catch (e) {
      if (e.inProgress) {
        this.historyConflict.set(e.message);
      } else {
        this.dialogs.open({
          title: "Edit history failed",
          message: e.message,
          cls: "dialog-error",
          okLabel: "OK",
          cancelLabel: null,
        });
      }
    } finally {
      this.historyApplying.set(false);
    }
  }

  async abortHistoryConflict() {
    if (this.historyApplying()) return;
    const row = this.historyRow();
    if (!row) return;
    this.historyApplying.set(true);
    try {
      await this.code.abortRebase(row.path);
      this.historyConflict.set("");
      await Promise.all([this.code.refreshBranches(new Set([row.repo])), this.openHistory(row)]);
    } catch (e) {
      this.dialogs.open({
        title: "Abort failed",
        message: e.message,
        cls: "dialog-error",
        okLabel: "OK",
        cancelLabel: null,
      });
    } finally {
      this.historyApplying.set(false);
    }
  }

  // let the user resolve the conflict by hand (git status / add / rebase
  // --continue or --abort); the banner stays up until they either abort here
  // or reopen the history (which reloads and drops the banner once resolved)
  openHistoryConflictTerminal() {
    const row = this.historyRow();
    if (!row) return;
    this.dialogs.openComponent(TerminalDialog, { path: row.path, label: `${row.repo} history` });
  }

  get historyDiffStats() {
    let added = 0;
    let deleted = 0;
    for (const line of this.historyDiff().split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) deleted++;
    }
    return { added, deleted };
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
        base: entry?.base || this._baseBranch(c.branch),
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
