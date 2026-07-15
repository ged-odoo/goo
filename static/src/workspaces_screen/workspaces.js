import {
  Component,
  onMounted,
  onWillUnmount,
  usePlugin,
  useProps,
  signal,
  t,
  untrack,
  useEffect,
  xml,
} from "@odoo/owl";
import { ClaudePlugin } from "./claude_plugin.js";
import { CodePlugin } from "../core/code_plugin.js";
import { ConfigPlugin } from "../core/config_plugin.js";
import { DatabasePlugin } from "../core/database_plugin.js";
import { DialogPlugin } from "../core/dialog_plugin.js";
import { EventLogPlugin } from "../core/event_log_plugin.js";
import { ServerPlugin } from "../core/server_plugin.js";
import { StorePlugin } from "../core/store_plugin.js";
import { WorkspacePlugin } from "../core/workspace_plugin.js";
import { BASE_BRANCH_RE } from "../core/config.js";
import {
  DirtyBadge,
  ICONS,
  LogConsole,
  SearchBox,
  appBus,
  editCommitMessage,
  m,
  mbCategory,
} from "../core/common.js";
import { CommitsDialog, pushBranchesDialog } from "../core/dialogs.js";
import { TerminalDialog, attachXterm } from "../core/terminal.js";
import { branchKey } from "../core/models.js";
import { repoBranchList, timeAgo } from "../core/utils.js";
import {
  adoptCurrentCheckout,
  categoryOptions,
  deleteWorkspaceDialog,
  startCreateWorkspace,
} from "./dialogs.js";
import { AddonsPane, AssetsPane, TestsPane } from "./panes.js";

export class ClaudeChat extends Component {
  static template = xml`
    <div class="cchat">
      <div class="cchat-msgs" t-ref="this.scroll">
        <div t-if="!this.items.length" class="cchat-hint dim">
          <t t-if="this.props.inMain">
            Send a task to Claude. <b>Caution:</b> it runs with full autonomy in your
            MAIN checkout — it edits the real working tree this workspace shares.
          </t>
          <t t-else="">
            Send a task to Claude. It runs in this worktree's checkout with full autonomy —
            it can edit files and run commands here without touching your main tree.
          </t>
        </div>
        <t t-foreach="this.items" t-as="m" t-key="m_index">
          <div t-if="m.role === 'user'" class="cmsg cmsg-user"><div class="cmsg-body" t-out="m.text"/></div>
          <div t-elif="m.role === 'assistant'" class="cmsg cmsg-asst"><div class="cmsg-body" t-out="m.text"/></div>
          <div t-elif="m.role === 'tool'" class="cmsg-tool">
            <span class="cmsg-tool-name" t-out="m.tool"/>
            <span t-if="m.text" class="cmsg-tool-text" t-out="m.text"/>
          </div>
          <div t-elif="m.role === 'error'" class="cmsg cmsg-error"><div class="cmsg-body" t-out="m.text"/></div>
        </t>
        <div t-if="this.running" class="cchat-working"><span class="spin"/>Claude is working…</div>
      </div>
      <div class="cchat-input">
        <div class="cchat-toolbar">
          <span class="cchat-model-label dim">Model</span>
          <select class="cchat-model" t-on-change="(ev) => this.claude.setModel(ev.target.value)">
            <option t-foreach="this.claude.models" t-as="opt" t-key="opt.value"
                    t-att-value="opt.value" t-att-selected="opt.value === this.claude.model()" t-out="opt.label"/>
          </select>
        </div>
        <div class="cchat-row">
          <textarea t-ref="this.ta" class="cchat-ta" rows="2"
                    placeholder="Describe a task —  Enter to send, Shift+Enter for a newline"
                    t-att-disabled="this.running" t-on-keydown="(ev) => this.onKey(ev)"/>
          <button t-if="!this.running" class="pbtn primary cchat-send" t-on-click="() => this.send()">Send</button>
          <button t-else="" class="pbtn stop cchat-send" t-on-click="() => this.stop()"><span class="ic square"/>Stop</button>
        </div>
      </div>
    </div>`;

  props = useProps({ target: t.any(), inMain: t.boolean().optional() });
  claude = usePlugin(ClaudePlugin);
  scroll = signal.ref(HTMLElement);
  ta = signal.ref(HTMLElement);

  setup() {
    onMounted(() => this.claude.prime(this.props.target.id));
    // follow the tail as items stream in (owl3's useEffect tracks the body itself —
    // the items/running reads below are what re-run it)
    useEffect(() => {
      (void this.items.length, this.running);
      const el = this.scroll();
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  get items() {
    return this.claude.items(this.props.target.id);
  }

  get running() {
    return this.claude.running(this.props.target.id);
  }

  onKey(ev) {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      this.send();
    }
  }

  send() {
    const el = this.ta();
    const text = el ? el.value : "";
    if (!text.trim() || this.running) return;
    this.claude.send(this.props.target, text);
    if (el) el.value = "";
  }

  stop() {
    this.claude.stop(this.props.target);
  }
}

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
    <div class="ws-code">
      <div class="ws-sec">
        <span>Checkouts</span>
        <button class="pbtn ghost ws-tool" t-att-disabled="!this.editorPaths.length" t-att-title="this.editAllTitle()" t-on-click="() => this.openAllEditors()"><t t-out="this.codeIcon"/>Editor</button>
        <button class="pbtn ghost ws-tool" t-att-disabled="!this.canRebaseAll()" t-att-title="this.rebaseAllTitle()" t-on-click="() => this.rebaseAll()"><span class="restart"/>Fetch &amp; rebase all</button>
        <button class="pbtn ghost ws-tool" t-att-disabled="!this.canPushAll()" t-att-title="this.pushAllTitle()" t-on-click="() => this.pushAll()"><t t-out="this.pushIcon"/>Push all</button>
        <button class="pbtn ghost ws-tool" t-att-disabled="!this.canPushAll()" t-att-title="this.pushAllForceTitle()" t-on-click="() => this.pushAllForce()"><t t-out="this.pushIcon"/>Push all (force)</button>
        <button class="pbtn ghost ws-tool" t-att-disabled="this.code.loading()" t-att-title="this.refreshTitle()" t-on-click="() => this.load(true)">
          <span t-if="this.code.loading()" class="ws-refresh-spin"/>Refresh
        </button>
      </div>

      <div t-if="!this.checkoutRows.length" class="dim ws-empty-note">This workspace has no checkouts.</div>

      <div class="ws-co-grid">
        <div class="ws-co-card" t-foreach="this.checkoutRows" t-as="r" t-key="r.key">
          <div class="ws-co-head">
            <span class="ws-repo-tag" t-out="r.repo"/>
            <a t-if="r.remote and r.github" class="ws-branch ws-co-branch branch-link" target="_blank"
               t-att-href="this.code.remoteBranchUrl(r.repo, r.github, r.branch)" t-att-title="'open ' + r.branch + ' on GitHub'" t-out="r.branch"/>
            <span t-else="" class="ws-branch ws-co-branch" t-att-title="r.branch" t-out="r.branch"/>
            <span class="wt-sp"/>
            <div class="dash-kebab-wrap" t-if="r.entry">
              <button class="dash-kebab" t-att-class="{open: this.menuId() === r.key}" title="more actions" t-on-click.stop="() => this.toggleMenu(r.key)"><t t-out="this.kebabIcon"/></button>
              <div t-if="this.menuId() === r.key" class="dash-menu" t-on-click.stop="">
                <button t-if="r.checkedOut" class="dash-menu-item" t-att-disabled="!r.canRebase" t-att-title="this.rebaseRepoTitle(r.entry)" t-on-click="() => this.menuAct(() => this.rebaseRepo(r.entry))">Fetch &amp; rebase</button>
                <button class="dash-menu-item" t-att-disabled="!r.canPush" t-att-title="this.pushRowTitle(r)" t-on-click="() => this.menuAct(() => this.pushRow(r))">Push</button>
                <button class="dash-menu-item" t-att-disabled="!r.canPush" t-att-title="this.pushRowTitle(r)" t-on-click="() => this.menuAct(() => this.pushForceRow(r))">Push (force)</button>
                <button t-if="r.entry.canPr" class="dash-menu-item" t-on-click="() => this.menuAct(() => this.openPr(r.entry))">Open PR</button>
                <button class="dash-menu-item" t-att-disabled="!r.path" t-on-click="() => this.menuAct(() => this.openRepoEditor(r))">Open with editor</button>
                <button class="dash-menu-item" t-att-disabled="!r.path" t-on-click="() => this.menuAct(() => this.openTerminal(r.entry))">Open in terminal</button>
                <button class="dash-menu-item" t-att-disabled="!r.path" t-on-click="() => this.menuAct(() => this.openCommits(r.entry))">See commits</button>
                <button t-if="r.dirty" class="dash-menu-item" t-on-click="() => this.menuAct(() => this.commitDialog(r))">Commit</button>
                <button t-if="r.dirty" class="dash-menu-item" t-on-click="() => this.menuAct(() => this.wipCommit(r))">WIP commit</button>
                <button t-if="r.dirty" class="dash-menu-item danger" t-on-click="() => this.menuAct(() => this.discard(r))">Discard changes</button>
              </div>
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
          <div t-if="r.subject" class="ws-commit dim ws-co-sec" t-att-class="{editable: r.sha and r.path}"
               t-att-title="r.sha and r.path ? 'click to edit this commit message' : ''"
               t-on-click="() => this.editCommit(r)">
            <t t-out="r.subject"/><t t-if="r.when"> · <t t-out="r.when"/></t>
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
            </div>
          </div>
        </div>
      </t>
    </div>`;

  props = useProps({ ws: t.any() });
  code = usePlugin(CodePlugin);
  store = usePlugin(StorePlugin);
  config = usePlugin(ConfigPlugin);
  dialogs = usePlugin(DialogPlugin);
  eventLog = usePlugin(EventLogPlugin);
  codeIcon = m(ICONS.code); // "Editor" toolbar button
  kebabIcon = m(ICONS.kebab); // the per-checkout actions menu
  pushIcon = m(ICONS.push); // the "Push all" toolbar button
  menuId = signal(""); // key of the checkout whose action menu is open ("" = none)
  rPlusPosts = signal({}); // "github#number" -> "posting" | "posted"

  setup() {
    // close the repo chip menu on any outside click
    const closeMenu = () => this.menuId() && this.menuId.set("");
    onMounted(() => document.addEventListener("click", closeMenu));
    onWillUnmount(() => document.removeEventListener("click", closeMenu));
  }

  load(force) {
    const ids = new Set((this.props.ws.checkouts || []).map((c) => c.repo));
    if (!ids.size) return;
    // a manual Refresh re-scrapes only THIS workspace's runbot bundles + mergebot
    // PRs (the one-shot scope) — not every other workspace's badges
    const scope = force ? this._statusScope() : null;
    return this.code.loadWorkspace(this.props.ws.id, ids, force, scope);
  }

  // the workspace's runbot branch names + mergebot PR keys: each checkout's
  // configured branch plus whatever is actually checked out (the sync strip
  // badges the live branch), skipping external repos (never scraped)
  _statusScope() {
    const byId = Object.fromEntries(this.code.branchRepos().map((r) => [r.id, r]));
    const groups = this.code.groups();
    const branches = new Set();
    const prs = new Set();
    for (const c of this.props.ws.checkouts || []) {
      const github = groups.githubByRepo[c.repo] || "";
      if (this.code.isExternalRepo(github)) continue;
      for (const branch of new Set([c.branch, byId[c.repo]?.current].filter(Boolean))) {
        branches.add(branch);
        const pr = groups.prIndex[branchKey(c.repo, branch)];
        if (pr && github) prs.add(`${github}#${pr.number}`);
      }
    }
    return { branches, prs };
  }

  refreshTitle() {
    const ids = new Set((this.props.ws.checkouts || []).map((c) => c.repo));
    const at = this.code.workspaceRefreshedAt(ids);
    const last = at ? timeAgo(new Date(at).toISOString()) : "never";
    return `refresh branches + pull requests · last refreshed ${last}`;
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

  canRebaseAll() {
    return this.rebasableRepos.length > 0;
  }

  rebaseAllTitle() {
    const repos = this.rebasableRepos;
    if (!repos.length)
      return "nothing to rebase — repositories are dirty, missing, or have no local path";
    // spell out each repo's pull remote — checkouts may fetch from different remotes
    return `fetch and rebase ${repos
      .map((r) => `${r.current} (${r.id}) onto ${r.pull_remote}/${this._baseBranch(r.current)}`)
      .join(", ")}`;
  }

  // fetch + rebase every shown repo's current branch onto its base, in one call
  async rebaseAll() {
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

  // show the last commits on this repo's current branch
  openCommits(r) {
    if (!r.path) return;
    this.touchActivity();
    this.dialogs.openComponent(CommitsDialog, {
      path: r.path,
      ref: r.current || "",
      label: `${r.id} · ${r.current || "?"}`,
      github: r.github || "",
      base: r.base || "",
      pullRemote: r.pull_remote || "",
    });
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

  discard(r) {
    this.touchActivity();
    return this.code.discard(r.path, r.repo);
  }

  // click the commit line on a checkout card to reword its head commit (the
  // same shared textarea editor + reword call as CommitsDialog's edit button)
  async editCommit(r) {
    if (!r.sha || !r.path) return;
    const message = await editCommitMessage(this.dialogs, {
      title: `Edit commit message — ${r.repo}`,
      initialMessage: r.subject,
      okLabel: "Save",
    });
    if (!message) return;
    try {
      await this.code.rewordCommit(r.path, r.sha, message, {
        base: r.base,
        pullRemote: r.entry?.pull_remote || "",
      });
      this.touchActivity();
      await this.load(true);
    } catch (e) {
      this.dialogs.open({
        title: "Edit commit message failed",
        message: e.message,
        cls: "dialog-error",
        okLabel: "OK",
        cancelLabel: null,
      });
    }
  }

  // the PR's GitHub state for the pill: open / draft / closed / merged (the
  // runbot/CI signal lives in the workspace header, not per card)
  prState(pr) {
    return pr.draft && pr.state === "open" ? "draft" : pr.state;
  }
}

// ─────────────────────────── Terminal pane ───────────────────────────

// An xterm attached to a workspace server's PTY (Phase-2 backend:
// /api/terminal?workspace=<id>). The parent gates the URL — it only renders this
// component when the target PTY actually belongs to the selected workspace.

export class TerminalPane extends Component {
  static template = xml`<div class="ws-term" t-ref="this.host"/>`;

  props = useProps({ url: t.string() });
  host = signal.ref(HTMLElement);
  _dispose = null;

  setup() {
    useEffect(
      () => {
        const el = this.host();
        if (!el) return;
        let live = true;
        attachXterm(el, this.props.url, true).then((dispose) =>
          live ? (this._dispose = dispose) : dispose(),
        );
        return () => {
          live = false;
          this._dispose?.();
          this._dispose = null;
        };
      },
      () => [this.props.url],
    );
  }
}

// ─────────────────────────── Workspaces screen ───────────────────────────

// The primary work surface: every workspace (main-located and worktree) in one
// searchable list; the selected one's detail — status, per-location server
// controls, and the Code / Server logs / Claude / Terminal tabs. A main-located
// workspace shares the primary checkout (one loaded at a time — Start loads it,
// i.e. checks out its branches, then starts the main server on :8069); a worktree
// workspace runs concurrently from its own checkout on its own stable port.

const WORKSPACE_ORDER_KEY = "goo-workspace-order";
const WORKSPACE_ORDER_OPTIONS = [
  { value: "config", label: "Configured order", short: "Configured" },
  { value: "name", label: "Name (A–Z)", short: "Name" },
  { value: "created", label: "Creation date (newest)", short: "Created" },
  { value: "recent", label: "Most recent activity", short: "Recent" },
  { value: "mergebot", label: "Mergebot (blocked first)", short: "Mergebot" },
];
const WORKSPACE_ORDERS = new Set(WORKSPACE_ORDER_OPTIONS.map((option) => option.value));

function savedWorkspaceOrder() {
  try {
    const value = localStorage.getItem(WORKSPACE_ORDER_KEY) || "config";
    return WORKSPACE_ORDERS.has(value) ? value : "config";
  } catch {
    return "config";
  }
}

// collapsed category groups (a browser-side view preference, like the ordering)
const WORKSPACE_COLLAPSED_KEY = "goo-workspace-collapsed-categories";

function savedCollapsedGroups() {
  try {
    const stored = JSON.parse(localStorage.getItem(WORKSPACE_COLLAPSED_KEY));
    return new Set(Array.isArray(stored) ? stored : []);
  } catch {
    return new Set();
  }
}

export class WorkspacesScreen extends Component {
  static components = {
    LogConsole,
    ClaudeChat,
    CodePane,
    TerminalPane,
    TestsPane,
    AddonsPane,
    AssetsPane,
    SearchBox,
  };

  static template = xml`
    <section>
      <div class="content wt-content">
        <div class="wt-list">
          <div class="wt-list-head">
            <SearchBox value="this.query"/>
            <button class="wt-new primary" title="New workspace — a bundle of branches, a database and a server" t-on-click="() => this.create()">+</button>
            <button class="wt-new" t-att-disabled="this.refreshingStatuses()" title="refresh every workspace's runbot / mergebot status" t-on-click="() => this.refreshStatuses()">
              <span t-if="this.refreshingStatuses()" class="wt-refresh-spin"/>
              <t t-else="" t-out="this.refreshIcon"/>
            </button>
            <div class="wt-order-wrap">
              <button class="wt-order" t-att-class="{open: this.orderMenuOpen()}" t-att-title="'order workspaces: ' + this.orderLabel" t-on-click.stop="() => this.orderMenuOpen.set(!this.orderMenuOpen())">
                <t t-out="this.sortIcon"/><span class="wt-order-caret">▾</span>
              </button>
              <div t-if="this.orderMenuOpen()" class="dash-menu wt-order-menu" t-on-click.stop="">
                <button t-foreach="this.orderOptions" t-as="option" t-key="option.value" class="dash-menu-item" t-att-class="{selected: option.value === this.order()}" t-on-click="() => this.chooseOrder(option.value)">
                  <span class="wt-order-check"><t t-if="option.value === this.order()" t-out="this.checkIcon"/></span><t t-out="option.label"/>
                </button>
              </div>
            </div>
          </div>
          <div class="wt-list-items">
            <div t-if="!this.list.length" class="wt-empty dim">
              <t t-if="this.query()">No workspace matches.</t>
              <div t-else="" class="wt-empty-cta">
                <p>No workspaces yet.</p>
                <button class="pbtn primary" title="turn the branches currently checked out in your repos into a workspace — no form, one click" t-on-click="() => this.adoptCheckout()">Adopt current checkout</button>
                <button class="pbtn" t-on-click="() => this.create()">New workspace…</button>
              </div>
            </div>
            <div t-foreach="this.listGroups" t-as="grp" t-key="grp.id" class="wt-group">
              <button t-if="grp.name" class="wt-group-head" t-att-title="(this.isCollapsed(grp.id) ? 'expand' : 'collapse') + ' ' + grp.name" t-on-click="() => this.toggleGroup(grp.id)">
                <span class="wt-group-caret" t-out="this.isCollapsed(grp.id) ? '▸' : '▾'"/>
                <span class="wt-group-name" t-out="grp.name"/>
                <span class="wt-sp"/>
                <span class="wt-group-count" t-out="grp.items.length"/>
              </button>
              <t t-if="!grp.name || !this.isCollapsed(grp.id)">
                <button t-foreach="grp.items" t-as="ws" t-key="ws.id" class="wt-item"
                        t-att-class="{selected: ws.id === this.wt.selectedId()}" t-on-click="() => this.wt.select(ws.id)"
                        t-att-title="this.branchOf(ws) + ' · ' + (ws.db || '') + (this.isDrifted(ws) ? ' · checkout drifted' : '')">
                  <span class="wt-dot" t-att-class="this.listDotClass(ws)"/>
                  <span class="wt-item-name" t-out="ws.name"/>
                  <span t-if="this.isDrifted(ws)" class="wt-badge wt-badge-drift" title="checkout drifted — the main checkout no longer matches this workspace">drift</span>
                  <span t-if="this.isWt(ws)" class="wt-badge" title="worktree workspace">wt</span>
                  <span class="wt-sp"/>
                  <span class="wt-status-dot" t-att-class="this.ciDotClass(ws)" t-att-title="this.ciDotTitle(ws)"/>
                  <span class="wt-status-dot" t-att-class="this.mbDotClass(ws)" t-att-title="this.mbDotTitle(ws)"/>
                </button>
              </t>
            </div>
          </div>
        </div>
        <div class="wt-detail">
          <t t-if="this.sel">
            <div class="wt-detail-top">
            <div class="wt-detail-head">
              <div class="wt-head-row">
                <h2 t-out="this.sel.name" title="double-click to edit this workspace" t-on-dblclick="() => this.edit(this.sel)"/>
                <t t-set="ci" t-value="this.wsCiStatus(this.sel)"/>
                <t t-if="ci">
                  <t t-set="rbUrl" t-value="this.runbotUrl(this.sel)"/>
                  <a t-if="rbUrl" class="dash-ci" t-att-class="ci.cls" target="_blank" t-att-href="rbUrl" t-att-title="ci.checks ? '' : ('runbot: ' + ci.title)" t-on-mouseenter="(ev) => this.showCiMenu(ev, ci.checks)" t-on-mouseleave="() => this.hideCiMenu()">
                    <span class="dash-ci-dot"/><t t-out="ci.label"/>
                    <span t-if="ci.running" class="dash-ci-run" title="some checks still running"/>
                  </a>
                  <span t-else="" class="dash-ci" t-att-class="ci.cls" t-att-title="ci.checks ? '' : ('runbot: ' + ci.title)" t-on-mouseenter="(ev) => this.showCiMenu(ev, ci.checks)" t-on-mouseleave="() => this.hideCiMenu()">
                    <span class="dash-ci-dot"/><t t-out="ci.label"/>
                    <span t-if="ci.running" class="dash-ci-run" title="some checks still running"/>
                  </span>
                </t>
                <t t-set="mb" t-value="this.mbStatus(this.sel)"/>
                <a t-if="mb" class="dash-ci dash-mb" t-att-class="mb.cls" target="_blank" t-att-href="mb.url" t-on-mouseenter="(ev) => this.showMbMenu(ev, mb.rows)" t-on-mouseleave="() => this.hideMbMenu()">
                  <span class="dash-ci-dot"/><t t-out="mb.label"/>
                </a>
                <span t-if="this.stateOf(this.sel) !== 'stopped'" class="wt-state" t-att-class="this.dotClass(this.sel)" t-out="this.stateOf(this.sel)"/>
                <span class="wt-sp"/>
                <button class="pbtn ghost" t-att-disabled="!this.isRunning" title="open /odoo (autologin)" t-on-click="() => this.openWorkspaceUrl(this.sel, this.odooUrl(this.sel))"><t t-out="this.externalIcon"/>/odoo</button>
                <button class="pbtn ghost" t-att-disabled="!this.isRunning" title="open /web/tests (autologin)" t-on-click="() => this.openWorkspaceUrl(this.sel, this.testsUrl(this.sel))"><t t-out="this.externalIcon"/>/web/tests</button>
                <div class="dash-kebab-wrap">
                  <button class="dash-kebab" t-att-class="{open: this.menuOpen()}" title="more actions" t-on-click.stop="() => this.menuOpen.set(!this.menuOpen())"><t t-out="this.kebabIcon"/></button>
                  <div t-if="this.menuOpen()" class="dash-menu" t-on-click.stop="">
                    <button class="dash-menu-item" title="edit name / branches / database / args" t-on-click="() => this.headMenu(() => this.edit(this.sel))">Edit workspace…</button>
                    <button class="dash-menu-item danger" t-att-disabled="!this.canDropDb(this.sel)" t-att-title="this.dropDbTitle(this.sel)" t-on-click="() => this.headMenu(() => this.dropDb(this.sel))">Drop database</button>
                    <button class="dash-menu-item danger" t-att-disabled="this.removeBlocked(this.sel)" t-att-title="this.removeTitle(this.sel)" t-on-click="() => this.headMenu(() => this.remove(this.sel))">Remove workspace</button>
                  </div>
                </div>
              </div>
              <div class="wt-meta">
                <!-- one primary slot: a main-located workspace that isn't loaded offers
                     Activate (check out its branches first); once loaded — and always
                     for worktrees — the slot is the Start/Stop toggle -->
                <button t-if="!this.isWt(this.sel) and !this.isLoaded(this.sel)" class="pbtn primary" t-att-disabled="!this.canActivate(this.sel)" t-att-title="this.activateTitle(this.sel)" t-on-click="() => this.activate(this.sel)">Activate</button>
                <t t-else="">
                  <button t-if="!this.isLive(this.sel)" class="pbtn primary" t-att-disabled="!this.canStart(this.sel)" t-att-title="this.startTitle(this.sel)" t-on-click="() => this.start(this.sel)"><span class="play"/><t t-out="this.startLabel"/></button>
                  <button t-else="" class="pbtn stop" t-on-click="() => this.stop(this.sel)"><span class="ic square"/>Stop</button>
                </t>
                <t t-set="br" t-value="this.branchSummary(this.sel)"/>
                <span t-att-title="br.title"><t t-out="br.label"/> <b t-out="br.value"/></span>
                <span>db <b t-out="this.sel.db || '—'"/></span>
                <span t-if="this.portOf(this.sel)">port <b t-out="this.portOf(this.sel)"/></span>
              </div>
            </div>
            <div class="wt-tabs">
                <button class="wt-tab" t-att-class="{on: this.pane() === 'code'}" t-on-click="() => this.pane.set('code')"><t t-out="this.icons.code"/>Code</button>
                <button class="wt-tab" t-att-class="{on: this.pane() === 'log'}" t-on-click="() => this.pane.set('log')"><t t-out="this.icons.journal"/>Server logs</button>
                <button class="wt-tab" t-att-class="{on: this.pane() === 'tests'}" t-on-click="() => this.pane.set('tests')"><t t-out="this.icons.tests"/>Tests</button>
                <button class="wt-tab" t-att-class="{on: this.pane() === 'addons'}" t-on-click="() => this.pane.set('addons')"><t t-out="this.icons.addons"/>Addons</button>
                <button class="wt-tab" t-att-class="{on: this.pane() === 'assets'}" t-on-click="() => this.pane.set('assets')"><t t-out="this.icons.assets"/>Assets</button>
                <button class="wt-tab" t-att-class="{on: this.pane() === 'claude'}" t-on-click="() => this.pane.set('claude')"><t t-out="this.icons.claude"/>Claude</button>
                <button class="wt-tab" t-att-class="{on: this.pane() === 'terminal'}" t-on-click="() => this.openTerminalPane(this.sel)"><t t-out="this.icons.terminal"/>Terminal</button>
                <button class="wt-tab" t-att-class="{on: this.pane() === 'details'}" t-on-click="() => this.pane.set('details')"><t t-out="this.icons.info"/>Details</button>
              </div>
            </div>
            <div class="wt-panes">
              <div class="wt-pane ws-code-pane" t-if="this.pane() === 'code'">
                <div t-if="this.isDrifted(this.sel)" class="ws-drift-strip">
                  <span class="ws-drift-text">checkout drift: <t t-out="this.driftText(this.sel)"/></span>
                  <span class="wt-sp"/>
                  <button class="pbtn" t-att-disabled="!!this.restoreBlocked(this.sel)" t-att-title="this.restoreTitle(this.sel)" t-on-click="() => this.restore(this.sel)">Restore branches</button>
                  <t t-set="adopt" t-value="this.adoptTarget(this.sel)"/>
                  <button t-if="adopt" class="pbtn" t-att-title="'the current checkout matches ' + adopt.name + ' — make it the loaded workspace instead'" t-on-click="() => this.switchToMatch(adopt)" t-out="'Switch to ' + adopt.name"/>
                  <button t-else="" class="pbtn" title="the terminal detour is the new truth — rewrite this workspace's branches to what is actually checked out" t-on-click="() => this.adopt(this.sel)">Adopt current branches</button>
                  <button class="pbtn" title="keep this workspace as is and save the currently checked-out branches as a new workspace" t-on-click="() => this.saveDriftAsWorkspace(this.sel)">Save as new workspace…</button>
                </div>
                <CodePane t-key="this.sel.id" ws="this.sel"/>
              </div>
              <div class="wt-pane" t-elif="this.pane() === 'log'">
                <t t-if="this.isWt(this.sel)">
                  <LogConsole t-key="this.sel.id" title="'Server log'" buffer="this.wt.logBuffer(this.sel.id)" bare="true"/>
                </t>
                <t t-elif="this.isLoaded(this.sel)">
                  <LogConsole t-key="this.sel.id" title="'Server log'" buffer="this.server.output" bare="true"/>
                </t>
                <div t-else="" class="ws-pane-hint dim">This workspace isn't loaded — Start it to see its server log.</div>
              </div>
              <div class="wt-pane" t-elif="this.pane() === 'tests'">
                <TestsPane t-if="this.canRunHere(this.sel)" t-key="this.sel.id" ws="this.sel"/>
                <div t-else="" class="ws-pane-hint dim" t-out="this.runHint(this.sel, 'This workspace is not loaded — Start it first to run tests against its database and checkout.')"/>
              </div>
              <div class="wt-pane" t-elif="this.pane() === 'addons'">
                <AddonsPane t-if="this.canRunHere(this.sel)" t-key="this.sel.id" ws="this.sel"/>
                <div t-else="" class="ws-pane-hint dim" t-out="this.runHint(this.sel, 'This workspace is not loaded — Start it first to browse and install its modules.')"/>
              </div>
              <div class="wt-pane" t-elif="this.pane() === 'assets'">
                <AssetsPane t-if="this.sel.db" t-key="this.sel.id" ws="this.sel"/>
                <div t-else="" class="ws-pane-hint dim">This workspace has no database.</div>
              </div>
              <div class="wt-pane" t-elif="this.pane() === 'claude'">
                <ClaudeChat t-if="this.canRunHere(this.sel)" t-key="this.sel.id" target="this.sel" inMain="!this.isWt(this.sel)"/>
                <div t-else="" class="ws-pane-hint dim" t-out="this.runHint(this.sel, 'This workspace is not loaded — load it first, or use a worktree workspace to let Claude work in isolation.')"/>
              </div>
              <div class="wt-pane" t-elif="this.pane() === 'terminal'">
                <TerminalPane t-if="this.termUrl" t-key="this.sel.id" url="this.termUrl"/>
                <div t-else="" class="ws-pane-hint dim" t-out="this.termHint"/>
              </div>
              <div class="wt-pane ws-details-pane" t-elif="this.pane() === 'details'" t-key="this.sel.id">
                <div class="ws-details-grid">
                  <span class="dim">Created</span>
                  <span t-out="this.fmtWhen(this.sel.created_at)"/>
                  <span class="dim">Last activity</span>
                  <span t-out="this.fmtWhen(this.sel.last_activity)"/>
                </div>
                <label class="ws-notes-label dim" for="ws-notes">Notes</label>
                <textarea id="ws-notes" class="ws-notes" placeholder="Anything worth remembering about this workspace — context, findings, next steps…"
                          t-att-value="this.sel.notes || ''"
                          t-on-change="ev => this.config.workspace(this.sel.id)?.setNotes(ev.target.value)"/>
              </div>
            </div>
          </t>
          <div t-else="" class="wt-detail-empty dim">Select a workspace on the left, or create one.</div>
        </div>
      </div>
    </section>`;

  wt = usePlugin(WorkspacePlugin);
  config = usePlugin(ConfigPlugin);
  code = usePlugin(CodePlugin);
  db = usePlugin(DatabasePlugin);
  dialogs = usePlugin(DialogPlugin);
  eventLog = usePlugin(EventLogPlugin);
  server = usePlugin(ServerPlugin);
  store = usePlugin(StorePlugin);
  externalIcon = m(ICONS.external);
  kebabIcon = m(ICONS.kebab);
  sortIcon = m(ICONS.sort);
  checkIcon = m(ICONS.check);
  refreshIcon = m(ICONS.refresh);
  refreshingStatuses = signal(false); // the list's status-refresh spinner
  orderOptions = WORKSPACE_ORDER_OPTIONS;
  icons = {
    code: m(ICONS.code),
    journal: m(ICONS.journal),
    tests: m(ICONS.tests),
    addons: m(ICONS.addons),
    assets: m(ICONS.assets),
    claude: m(ICONS.claude),
    terminal: m(ICONS.terminal),
    info: m(ICONS.info),
  };

  // which detail pane is shown: code | log | tests | addons | assets | claude | terminal
  pane = signal("code");
  query = signal(""); // the list search
  order = signal(savedWorkspaceOrder()); // config | name | created | recent | mergebot
  orderMenuOpen = signal(false);
  menuOpen = signal(false); // the header's Edit/Remove overflow menu
  collapsedGroups = signal(savedCollapsedGroups()); // collapsed category ids

  setup() {
    this.db.load(); // cache-aware; warms the clone-source list for the create dialog
    // close the header overflow menu on any outside click
    const closeMenu = () => {
      if (this.menuOpen()) this.menuOpen.set(false);
      if (this.orderMenuOpen()) this.orderMenuOpen.set(false);
    };
    onMounted(() => document.addEventListener("click", closeMenu));
    onWillUnmount(() => document.removeEventListener("click", closeMenu));
    // An explicit cross-screen jump wins once; an ordinary return starts on the
    // first workspace in the user's saved ordering rather than reviving the last
    // selection from a previous visit.
    const requested = this.wt.requestedSelection();
    const selected = requested && this.list.find((ws) => ws.id === requested);
    const first = selected || this.list[0];
    if (first) this.wt.select(first.id);
    this.wt.requestedSelection.set("");
    // A jump can target Workspaces while this screen is already mounted (setting
    // the same hash does not remount it). Consume that request reactively too so
    // it cannot leak into the next ordinary visit.
    useEffect(() => {
      const id = this.wt.requestedSelection();
      if (!id) return;
      if (this.list.some((ws) => ws.id === id)) this.wt.select(id);
      this.wt.requestedSelection.set("");
    });
    // Load the selected workspace's code state (drives the Start guard, checkout
    // badges and Code pane), keyed by the selection + its repo set. The effect
    // tracks `this.sel` — i.e. the config records — so it re-runs on EVERY config
    // write, including ones that change nothing here: an activity timestamp (each
    // test run touches it) or another tab's edit echoed over SSE (applyBroadcast
    // rebuilds all records). Without the key guard each of those re-runs called
    // loadWorkspace, and once its 10-minute freshness lapsed every config write
    // re-scanned git in every open tab (see the `loadedIds` pattern below).
    // Keep the loader itself untracked: it reads and then rewrites the shared store.
    let loadedWsKey = "";
    useEffect(() => {
      const ws = this.sel;
      if (!ws) return;
      const ids = new Set((ws.checkouts || []).map((c) => c.repo));
      const key = `${ws.id}:${[...ids].sort().join(",")}`;
      if (!ids.size || key === loadedWsKey) return;
      loadedWsKey = key;
      untrack(() => this.code.loadWorkspace(ws.id, ids));
    });
    // consume the event log's one-shot pane request (its [jump] selects the
    // workspace and sets this before navigating here — the plugin holds it so it
    // survives this screen not being mounted at dispatch time)
    useEffect(() => {
      const pane = this.wt.requestedPane();
      if (!pane) return;
      this.pane.set(pane);
      this.wt.requestedPane.set(""); // one re-run with "" then settles
    });
    // badge data for the whole list, in two effects with different loop-safety.
    //
    // (1) PRs + branches for every workspace's repos. code.load() may NOT be
    // tracked by the effect: it rewrites branchRepos/groups (git reads are
    // volatile — every load yields fresh objects), so tracking its internal reads
    // would re-trigger the effect forever. The body therefore only tracks the
    // config read (_listRepoIds), guards on the repo-set key so unrelated config
    // touches don't reload, and untracks the load() call itself.
    let loadedIds = "";
    useEffect(() => {
      const ids = this._listRepoIds();
      const key = [...ids].sort().join(",");
      if (!ids.size || key === loadedIds) return;
      loadedIds = key;
      untrack(() => this.code.load(false, ids, ids));
    });
    // (2) runbot (bundle branches without a PR CI rollup) + mergebot (their PRs)
    // — body-tracked so it re-runs as branches/PRs stream in. Safe: both loaders
    // dedup against what's already held/in-flight (CodePlugin's `have` pattern), so
    // once everything is fetched they no-op and the effect settles.
    useEffect(() => {
      const branches = this._runbotBranches();
      if (branches.length) this.code.loadRunbot(branches);
      const prs = this._prs();
      if (prs.length) this.code.loadMergebot(prs);
    });
  }

  // every repo referenced by any workspace's checkouts (for the list-wide load)
  _listRepoIds() {
    const ids = new Set();
    for (const ws of this.config.config.workspaces || [])
      for (const c of ws.checkouts || []) ids.add(c.repo);
    return ids;
  }

  // ── list badges (runbot/CI + mergebot), scoped to a workspace's checkouts ────
  // one row per checkout with its local + remote/PR state
  wsRows(ws) {
    const repos = this.repoMap;
    const groups = this.code.groups();
    return (ws.checkouts || []).map(({ repo, branch }) => {
      const r = repos[repo];
      const b = r && r.branches.get(branch);
      return {
        repo,
        branch,
        github: groups.githubByRepo[repo] || "",
        present: !!b,
        synced: !!b && b.synced, // local tip matches the remote ref (has a real bundle)
        pr: groups.prIndex[branchKey(repo, branch)] || null,
      };
    });
  }

  // branches needing the scraped runbot fallback: present, ours, pushed (or a base
  // branch), and not already covered by a PR's GitHub CI rollup
  _runbotBranches() {
    const seen = new Set();
    for (const ws of this.config.config.workspaces || [])
      for (const row of this.wsRows(ws)) {
        if (!row.present || this.code.isExternalRepo(row.github)) continue;
        if (!BASE_BRANCH_RE.test(row.branch) && !row.synced) continue;
        const ci = row.pr && row.pr.ci;
        if (ci && ci.checks && ci.checks.length) continue;
        seen.add(row.branch);
      }
    return [...seen];
  }

  // the unique {github, number} of every PR across the list (for mergebot)
  _prs() {
    const seen = new Set();
    const prs = [];
    for (const ws of this.config.config.workspaces || [])
      for (const row of this.wsRows(ws)) {
        if (!row.pr || !row.github || this.code.isExternalRepo(row.github)) continue;
        const key = `${row.github}#${row.pr.number}`;
        if (seen.has(key)) continue;
        seen.add(key);
        prs.push({ github: row.github, number: row.pr.number });
      }
    return prs;
  }

  // the list header's ⟳: force-refresh every workspace's runbot/mergebot status,
  // spinning until both re-scrapes land (badges stay visible, update in place)
  async refreshStatuses() {
    if (this.refreshingStatuses()) return;
    this.refreshingStatuses.set(true);
    try {
      await this.code.refreshStatuses(this._runbotBranches(), this._prs());
    } finally {
      this.refreshingStatuses.set(false);
    }
  }

  // a bundle is per branch name (shared across a workspace's repos): prefer the
  // feature (non-base) branch, else the base
  bundleBranch(ws) {
    const branches = (ws.checkouts || []).map((c) => c.branch).filter(Boolean);
    return branches.find((b) => !BASE_BRANCH_RE.test(b)) || branches[0] || "";
  }

  // the present row representing the workspace's bundle (bundle-branch row, else the
  // first present one) — drives the single CI badge
  bundleRow(ws) {
    const present = this.wsRows(ws).filter((r) => r.present);
    const branch = this.bundleBranch(ws);
    return present.find((r) => r.branch === branch) || present[0] || null;
  }

  // the workspace's runbot/CI badge. Prefers the PR's GitHub CI rollup; falls back
  // to the scraped runbot bundle.
  wsCiStatus(ws) {
    const row = this.bundleRow(ws);
    if (!row) return null;
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
      badge.running = pending && (ci.overall === "success" || ci.overall === "failure");
      badge.checks = ci.checks;
      return badge;
    }
    // fallback: scraped runbot bundle status
    const s = this.code.runbot()[row.branch] || null;
    const result = (s && s.result) || "";
    const running = !!(s && s.running);
    let badge;
    if (result === "success") badge = { cls: "pass", label: "ok", title: "passing" };
    else if (result === "failure") badge = { cls: "fail", label: "ko", title: "failing" };
    else if (running) badge = { cls: "run", label: "running", title: "running" };
    else badge = { cls: "unknown", label: "—", title: "unknown" };
    badge.running = running && !!result;
    if (badge.running) badge.title += " — still running";
    return badge;
  }

  // aggregate mergebot status for a workspace: the most-blocking state across its PRs
  // that have a scraped state. The rows drive the per-repository hover breakdown.
  mbStatus(ws) {
    const rows = [];
    const RANK = { blocked: 0, progress: 1, ready: 2, merged: 3, other: 4 };
    for (const row of this.wsRows(ws)) {
      if (!row.pr || !row.github) continue;
      const state = this.code.mergebot()[`${row.github}#${row.pr.number}`] || "";
      if (!state) continue;
      rows.push({
        repo: row.repo,
        state,
        detail: this.code.mbDetails()[`${row.github}#${row.pr.number}`] || "",
        cls: mbCategory(state),
        url: this.code.mergebotUrl(row.github, row.pr.number),
      });
    }
    if (!rows.length) return null;
    const worst = rows.reduce((a, b) => (RANK[a.cls] <= RANK[b.cls] ? a : b));
    return { cls: worst.cls, label: worst.state, url: rows[0].url, rows };
  }

  runbotUrl(ws) {
    const branch = this.bundleBranch(ws);
    const scraped = branch && this.code.runbot()[branch]?.url;
    if (scraped) return scraped;
    const checks = this.bundleRow(ws)?.pr?.ci?.checks || [];
    return checks.find((c) => c.context === "ci/runbot")?.url || "";
  }

  showCiMenu(ev, checks) {
    if (!checks || !checks.length) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    appBus.dispatchEvent(new CustomEvent("ci-menu", { detail: { rect, checks } }));
  }

  hideCiMenu() {
    appBus.dispatchEvent(new CustomEvent("ci-menu-hide"));
  }

  showMbMenu(ev, rows) {
    if (!rows || !rows.length) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    appBus.dispatchEvent(new CustomEvent("mb-menu", { detail: { rect, rows } }));
  }

  hideMbMenu() {
    appBus.dispatchEvent(new CustomEvent("mb-menu-hide"));
  }

  // the two trailing status dots: a colour class per status (empty = neutral/unknown)
  ciDotClass(ws) {
    const s = this.wsCiStatus(ws);
    return s ? "s-" + s.cls : "";
  }

  mbDotClass(ws) {
    const s = this.mbStatus(ws);
    return s ? "s-" + s.cls : "";
  }

  ciDotTitle(ws) {
    const s = this.wsCiStatus(ws);
    return s ? "runbot: " + s.title : "runbot: no status";
  }

  mbDotTitle(ws) {
    const s = this.mbStatus(ws);
    return s ? "mergebot: " + s.label : "mergebot: no status";
  }

  // ── list / selection ─────────────────────────────────────────────────────────
  setOrder(value) {
    value = WORKSPACE_ORDERS.has(value) ? value : "config";
    this.order.set(value);
    try {
      localStorage.setItem(WORKSPACE_ORDER_KEY, value);
    } catch {
      /* browser storage can be disabled; the in-memory preference still works */
    }
  }

  chooseOrder(value) {
    this.setOrder(value);
    this.orderMenuOpen.set(false);
    const first = this.list[0];
    if (first) this.wt.select(first.id);
  }

  get orderLabel() {
    return (
      WORKSPACE_ORDER_OPTIONS.find((option) => option.value === this.order())?.short || "Order"
    );
  }

  // reads the canonical `workspaces` array — it carries `location` and the stable
  // `port` (the legacy `targets` view drops both by design)
  get list() {
    const all = this.config.config.workspaces || []; // every workspace, config order
    const q = this.query().trim().toLowerCase();
    const rows = (
      q
        ? all.filter((ws) =>
            `${ws.name} ${this.branchOf(ws)} ${ws.db || ""}`.toLowerCase().includes(q),
          )
        : all
    ).map((ws, index) => ({ ws, index }));
    const order = this.order();
    if (order === "name") {
      rows.sort(
        (a, b) =>
          a.ws.name.localeCompare(b.ws.name, undefined, { numeric: true, sensitivity: "base" }) ||
          a.index - b.index,
      );
    } else if (order === "created" || order === "recent") {
      const field = order === "created" ? "created_at" : "last_activity";
      rows.sort((a, b) => {
        const aTime = Date.parse(a.ws[field] || a.ws.created_at || "") || 0;
        const bTime = Date.parse(b.ws[field] || b.ws.created_at || "") || 0;
        return bTime - aTime || a.index - b.index;
      });
    } else if (order === "mergebot") {
      const rank = { blocked: 0, progress: 1, ready: 2, merged: 3, other: 4 };
      const statusRank = new Map(rows.map(({ ws }) => [ws.id, rank[this.mbStatus(ws)?.cls] ?? 5]));
      rows.sort((a, b) => statusRank.get(a.ws.id) - statusRank.get(b.ws.id) || a.index - b.index);
    }
    return rows.map(({ ws }) => ws);
  }

  get categoriesEnabled() {
    return !!this.config.config.workspace_categories_enabled;
  }

  // the list partitioned into category groups (config order, uncategorized last),
  // preserving the chosen sort within each group. With categories disabled, one
  // anonymous group — the template renders a header only for named groups.
  get listGroups() {
    const list = this.list;
    if (!this.categoriesEnabled) return [{ id: "", name: "", items: list }];
    const cats = (this.config.config.workspace_categories || []).map((c) => c.id);
    const byCat = new Map(cats.map((c) => [c, []]));
    const rest = []; // no category, or one that was removed from the list
    for (const ws of list) {
      if (byCat.has(ws.category)) byCat.get(ws.category).push(ws);
      else rest.push(ws);
    }
    const groups = cats.map((c) => ({ id: c, name: c, items: byCat.get(c) }));
    if (rest.length) groups.push({ id: "\0none", name: "uncategorized", items: rest });
    return groups.filter((g) => g.items.length);
  }

  isCollapsed(id) {
    return this.collapsedGroups().has(id);
  }

  toggleGroup(id) {
    const next = new Set(this.collapsedGroups());
    if (!next.delete(id)) next.add(id);
    this.collapsedGroups.set(next);
    try {
      localStorage.setItem(WORKSPACE_COLLAPSED_KEY, JSON.stringify([...next]));
    } catch {
      /* browser storage can be disabled; the in-memory preference still works */
    }
  }

  get sel() {
    return (this.config.config.workspaces || []).find((w) => w.id === this.wt.selectedId()) || null;
  }

  isWt(ws) {
    return ws.location === "worktree";
  }

  branchOf(ws) {
    return (ws.checkouts && ws.checkouts[0] && ws.checkouts[0].branch) || "";
  }

  // Details tab timestamps: absolute local date-time + relative ("2 days ago")
  fmtWhen(ts) {
    const t = Date.parse(ts || "");
    if (!t) return "—";
    const abs = new Date(t).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    return `${abs} · ${timeAgo(ts)}`;
  }

  // the header's branch chip: the shared branch name when every checkout agrees
  // (the usual convention), else just the distinct-name count — one label can't
  // honestly name two branches (the Code tab's cards carry the per-repo detail).
  // The tooltip always spells out the full repo:branch mapping.
  branchSummary(ws) {
    const names = [...new Set((ws.checkouts || []).map((c) => c.branch))];
    const title = (ws.checkouts || []).map((c) => `${c.repo}:${c.branch}`).join(", ");
    if (names.length <= 1) return { label: "branch", value: names[0] || "—", title };
    return { label: "", value: `${names.length} branches`, title };
  }

  // ── per-location server state ────────────────────────────────────────────────
  // the workspace occupying the main checkout: the running main server's, else the
  // last activated one (a browser-side fact — see targets_screen isActive)
  get activeId() {
    const s = this.server.status();
    return s.state === "running" || s.state === "starting"
      ? s.workspace
      : this.server.lastWorkspace();
  }

  isLoaded(ws) {
    return !this.isWt(ws) && ws.id === this.activeId;
  }

  // ── checkout drift (intent vs reality, loaded main-located workspaces only) ──
  // the loaded workspace claims the main checkout; a manual `git checkout` in a
  // terminal silently breaks that claim. driftOf lists the mismatched checkouts.
  driftOf(ws) {
    return this.isLoaded(ws) ? this.store.drift(ws) : [];
  }

  isDrifted(ws) {
    return this.driftOf(ws).length > 0;
  }

  driftText(ws) {
    return this.driftOf(ws)
      .map((c) => `${c.repo} is on ${c.current || "?"}, expected ${c.branch}`)
      .join(" · ");
  }

  // whether runs (tests/addons) and Claude can act on this workspace here: a
  // worktree always (its own checkout), a main-located one only when loaded AND
  // not drifted — running against code that isn't the workspace's would mislead
  canRunHere(ws) {
    return this.isWt(ws) || (this.isLoaded(ws) && !this.isDrifted(ws));
  }

  // the hint shown in a gated pane (tests / addons / claude) when it can't run here
  runHint(ws, hint) {
    if (this.isDrifted(ws))
      return "The main checkout no longer matches this workspace — Restore its branches first (see the drift banner on the Code tab).";
    return hint;
  }

  // serverFor: the main slot when it runs this workspace, else its own entry
  stateOf(ws) {
    return this.store.serverFor(ws)?.state || "stopped";
  }

  portOf(ws) {
    if (this.isWt(ws)) return this.wt.port(ws) || ws.port || null;
    return this.stateOf(ws) !== "stopped" ? 8069 : null;
  }

  dotClass(ws) {
    return "wt-dot-" + this.stateOf(ws);
  }

  // the list-row dot: a starting/running server keeps its live colour; a
  // worktree workspace or the loaded (active) one gets a solid black dot, and any
  // other (stopped, inactive) workspace stays faint. Checkout drift no longer
  // recolours the dot — it surfaces as a "drift" badge next to the name instead.
  listDotClass(ws) {
    if (this.isLive(ws)) return this.dotClass(ws);
    if (this.isWt(ws) || this.isLoaded(ws)) return "wt-dot-active";
    return this.dotClass(ws);
  }

  isLive(ws) {
    const s = this.stateOf(ws);
    return s === "running" || s === "starting";
  }

  get isRunning() {
    return !!this.sel && this.stateOf(this.sel) === "running";
  }

  get startLabel() {
    return this.sel && this.stateOf(this.sel) === "starting" ? "Starting…" : "Start";
  }

  // repo id -> { current, dirty, branches } from the live git state (Start guard)
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

  // why Start is blocked for a main-located workspace ("" = it can start). The
  // loaded workspace can always (re)start; switching to another one requires all
  // its branches locally + clean working trees (activate() silently no-ops else).
  _startBlocked(ws) {
    if (this.isLive(ws)) return "already running";
    if (this.isDrifted(ws))
      return "the main checkout drifted away from this workspace — Restore its branches first";
    if (this.isWt(ws) || this.isLoaded(ws)) return "";
    const repos = this.repoMap;
    const cos = ws.checkouts || [];
    if (!cos.every(({ repo, branch }) => repos[repo]?.branches.has(branch)))
      return "some of this workspace's branches are missing locally";
    if (cos.some(({ repo }) => repos[repo]?.dirty))
      return "commit or stash changes first — the working tree is dirty";
    return "";
  }

  canStart(ws) {
    return !this._startBlocked(ws);
  }

  startTitle(ws) {
    const blocked = this._startBlocked(ws);
    if (blocked) return blocked;
    if (this.isWt(ws)) return "start this workspace's server on its own port";
    return this.isLoaded(ws)
      ? "start the main server"
      : "load this workspace (check out its branches) and start the main server";
  }

  // ── activation (load without starting) ───────────────────────────────────────
  // main-located only: check out this workspace's branches + make it the loaded
  // workspace, without starting the main server. Blocked for the same reasons a
  // cold Start is (missing/dirty branches), and a no-op once it's the loaded one.
  _activateBlocked(ws) {
    if (this.isWt(ws)) return "worktree workspaces don't share the main checkout";
    if (this.isLoaded(ws)) return "already the loaded workspace";
    const repos = this.repoMap;
    const cos = ws.checkouts || [];
    if (!cos.every(({ repo, branch }) => repos[repo]?.branches.has(branch)))
      return "some of this workspace's branches are missing locally";
    if (cos.some(({ repo }) => repos[repo]?.dirty))
      return "commit or stash changes first — the working tree is dirty";
    return "";
  }

  canActivate(ws) {
    return !this._activateBlocked(ws);
  }

  activateTitle(ws) {
    return (
      this._activateBlocked(ws) ||
      "check out this workspace's branches and make it the loaded workspace (without starting the server)"
    );
  }

  async activate(ws) {
    if (!this.canActivate(ws)) return;
    await this.config.workspace(ws.id)?.activate();
  }

  // ── drift reconciliation (the strip's Restore / Adopt buttons) ────────────────
  // Restore: the workspace is right, the terminal detour was temporary — re-check
  // out its branches (stopping the server if it runs). Same guards as activate.
  restoreBlocked(ws) {
    const repos = this.repoMap;
    const cos = ws.checkouts || [];
    if (!cos.every(({ repo, branch }) => repos[repo]?.branches.has(branch)))
      return "some of this workspace's branches are missing locally";
    if (cos.some(({ repo }) => repos[repo]?.dirty))
      return "commit or stash changes first — a working tree is dirty";
    return "";
  }

  restoreTitle(ws) {
    return (
      this.restoreBlocked(ws) ||
      (this.isLive(ws)
        ? "stop the server and check out this workspace's branches again"
        : "check out this workspace's branches again")
    );
  }

  async restore(ws) {
    if (this.restoreBlocked(ws)) return;
    await this.config.workspace(ws.id)?.activate({ restore: true });
  }

  // Adopt: what's checked out is the new truth. If it exactly matches another
  // main-located workspace, switching to that one is the honest move; otherwise
  // rewrite this workspace's checkouts to the actual branches.
  adoptTarget(ws) {
    const repos = this.repoMap;
    return (
      (this.config.config.workspaces || []).find(
        (w) =>
          w.id !== ws.id &&
          w.location !== "worktree" &&
          (w.checkouts || []).length > 0 &&
          (w.checkouts || []).every(({ repo, branch }) => repos[repo]?.current === branch),
      ) || null
    );
  }

  switchToMatch(other) {
    return this.config.workspace(other.id)?.activate();
  }

  adopt(ws) {
    const repos = this.repoMap;
    this.config.workspace(ws.id)?.applyEdit({
      name: ws.name,
      db: ws.db || "",
      on_create_args: ws.on_create_args || "",
      checkouts: (ws.checkouts || []).map(({ repo, branch }) => ({
        repo,
        branch: repos[repo]?.current || branch,
      })),
    });
  }

  // Save-as: keep this workspace untouched and open the create dialog prefilled
  // with the ACTUAL checked-out branches — the terminal detour becomes its own
  // workspace. Named after the drifted feature branch; "create branches" defaults
  // off (the branches exist — they're checked out). Activating it (the dialog's
  // default) also resolves the drift: the new workspace matches reality.
  saveDriftAsWorkspace(ws) {
    const repos = this.repoMap;
    const checkouts = (ws.checkouts || []).map(({ repo, branch }) => ({
      repo,
      branch: repos[repo]?.current || branch,
    }));
    const feature =
      checkouts.map((c) => c.branch).find((b) => !BASE_BRANCH_RE.test(b)) ||
      checkouts[0]?.branch ||
      "";
    return startCreateWorkspace(this._dialogPlugins(), {
      name: feature,
      config: repoBranchList.format(checkouts),
      db: feature,
      template: "",
      createBranches: false,
    });
  }

  // ── actions ──────────────────────────────────────────────────────────────────
  async start(ws) {
    if (!this.canStart(ws)) return;
    if (this.isWt(ws)) return this.wt.startServer(ws);
    // loading = today's activate flow: checks out the branches, records the
    // workspace as active, stopping the previous server if needed (no-op when
    // this workspace is already the loaded one)
    await this.config.workspace(ws.id)?.activate();
    await this.server.start(ws.id);
  }

  stop(ws) {
    return this.isWt(ws) ? this.wt.stopServer(ws) : this.server.stop();
  }

  openTerminalPane(ws) {
    this.pane.set("terminal");
    if (this.termUrl) this.config.workspace(ws.id)?.touchActivity();
  }

  odooUrl(ws) {
    if (this.isWt(ws)) return this.wt.odooUrl(ws);
    return `http://localhost:8069/dev/autologin?to=${encodeURIComponent("/odoo?debug=assets")}`;
  }

  testsUrl(ws) {
    if (this.isWt(ws)) return this.wt.testsUrl(ws);
    return `http://localhost:8069/dev/autologin?to=${encodeURIComponent(
      "/web/tests?debug=assets&timeout=500000&manual=true",
    )}`;
  }

  open(url) {
    if (url) window.open(url, "_blank", "noopener");
  }

  openWorkspaceUrl(ws, url) {
    if (!url) return;
    this.config.workspace(ws.id)?.touchActivity();
    this.open(url);
  }

  // run a header-menu action then close the overflow menu
  headMenu(fn) {
    this.menuOpen.set(false);
    fn();
  }

  // ── drop the workspace's database (header ⋮ menu) ─────────────────────────────
  // guarded: the db must exist and the workspace's server must be stopped — the
  // server runs ON that database, so dropping under it is forbidden rather than
  // silently stopping it
  dbExists(ws) {
    return !!ws.db && this.db.databases().some((d) => d.name === ws.db);
  }

  canDropDb(ws) {
    return this.dbExists(ws) && !this.isLive(ws);
  }

  dropDbTitle(ws) {
    if (!ws.db) return "no database set for this workspace";
    if (!this.dbExists(ws)) return `database "${ws.db}" does not exist`;
    if (this.isLive(ws)) return "stop the server first — it is running on this database";
    return `drop database "${ws.db}"`;
  }

  async dropDb(ws) {
    if (!this.canDropDb(ws)) return;
    const res = await this.dialogs.open({
      title: `Drop "${ws.db}"?`,
      message: "This permanently deletes the database. This cannot be undone.",
      okLabel: "Drop",
    });
    if (!res) return;
    const error = await this.db.drop(ws.db);
    if (error)
      await this.dialogs.open({
        title: "Drop failed",
        message: error,
        okLabel: "OK",
        cancelLabel: null,
      });
  }

  removeBlocked(ws) {
    if (this.isWt(ws)) return this.isLive(ws);
    return this.isLoaded(ws);
  }

  removeTitle(ws) {
    if (this.isWt(ws))
      return this.isLive(ws) ? "stop the server first" : "remove the worktree + workspace";
    return this.isLoaded(ws) ? "the loaded workspace cannot be removed" : "remove the workspace";
  }

  async remove(ws) {
    if (this.removeBlocked(ws)) return;
    if (this.isWt(ws)) return this.wt.remove(ws);
    // main-located: the shared delete dialog (branches / PRs / db cleanup)
    const ids = new Set((ws.checkouts || []).map((c) => c.repo));
    await Promise.all([this.code.load(false, ids, ids), this.db.load()]);
    return deleteWorkspaceDialog(ws, {
      config: this.config,
      code: this.code,
      db: this.db,
      eventLog: this.eventLog,
      repoMap: this.repoMap,
      isActive: this.isLoaded(ws),
      dialogs: this.dialogs,
    });
  }

  // ── terminal gating: never show another workspace's server PTY ───────────────
  get termUrl() {
    const ws = this.sel;
    if (!ws) return "";
    if (this.isWt(ws)) {
      // the backend entry (and its PTY) exists only once the server has run
      return this.stateOf(ws) === "stopped"
        ? ""
        : `ws://${location.host}/api/terminal?workspace=${encodeURIComponent(ws.id)}`;
    }
    return this.isLoaded(ws) ? `ws://${location.host}/api/terminal?workspace=main` : "";
  }

  get termHint() {
    if (this.isWt(this.sel)) return "Start this workspace's server to attach a terminal.";
    return "This workspace isn't loaded — the main terminal belongs to the loaded workspace.";
  }

  // ── edit dialog (both locations) ─────────────────────────────────────────────
  async edit(ws) {
    const res = await this.dialogs.open({
      title: `Edit "${ws.name}"`,
      okLabel: "Save",
      validate: (v) => {
        const name = (v.name || "").trim();
        if (!name) return "a name is required";
        if ((this.config.config.workspaces || []).some((w) => w.name === name && w.id !== ws.id))
          return `a workspace named "${name}" already exists`;
        if (!repoBranchList.parse((v.config || "").trim()).length) return "a config is required";
        return "";
      },
      fields: [
        { key: "name", type: "text", label: "Name", value: ws.name },
        {
          key: "config",
          type: "text",
          label: "Config",
          value: repoBranchList.format(ws.checkouts),
          placeholder: "community:master,enterprise:master",
        },
        { key: "db", type: "text", label: "Database", value: ws.db || "" },
        { key: "args", type: "text", label: "Start args", value: ws.on_create_args || "" },
        ...(this.categoriesEnabled
          ? [
              {
                key: "category",
                type: "select",
                label: "Category",
                placeholder: "— none —",
                options: categoryOptions(this.config),
                value: ws.category || "",
              },
            ]
          : []),
      ],
    });
    if (!res) return;
    this.config.workspace(ws.id)?.applyEdit({
      name: res.name.trim(),
      checkouts: repoBranchList.parse(res.config.trim()),
      db: (res.db || "").trim(),
      on_create_args: (res.args || "").trim(),
      ...(this.categoriesEnabled ? { category: res.category || "" } : {}),
    });
  }

  // ── new workspace (unified: template picker + location) ─────────────────────
  _dialogPlugins() {
    return {
      config: this.config,
      dialogs: this.dialogs,
      db: this.db,
      code: this.code,
      eventLog: this.eventLog,
      wt: this.wt,
      server: this.server,
    };
  }

  create() {
    return startCreateWorkspace(this._dialogPlugins());
  }

  adoptCheckout() {
    return adoptCurrentCheckout(this._dialogPlugins());
  }
}

// ─────────────────────────── Databases screen ───────────────────────────
