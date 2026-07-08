import { Component, onMounted, onWillUnmount, plugin, signal, xml } from "@odoo/owl";
import { BASE_BRANCH_RE } from "../core/config.js";
import { timeAgo } from "../core/utils.js";
import { CodePlugin } from "../core/code_plugin.js";
import { ConfigPlugin } from "../core/config_plugin.js";
import { DialogPlugin } from "../core/dialog_plugin.js";
import { EventLogPlugin } from "../core/event_log_plugin.js";
import { ServerPlugin } from "../core/server_plugin.js";
import { DirtyBadge, ICONS, m } from "../core/common.js";
import { Panel } from "../core/panel.js";
import { CommitsDialog } from "../core/dialogs.js";
import { pushBranchesDialog } from "../core/dialogs.js";
import { TerminalDialog } from "../core/terminal.js";

export class CodeScreen extends Component {
  static components = { DirtyBadge, Panel };
  static template = xml`
    <section>
      <Panel title="'Code'">
        <t t-set-slot="top-right">
          <span class="meta" t-out="this.stamp"/>
          <button class="pbtn" t-on-click="() => this._load(true)"><t t-out="this.refreshIcon"/>Refresh</button>
        </t>
        <t t-set-slot="bottom-left">
          <span class="dash-subtitle">Manage the main repository checkouts — switch branches, rebase, push and open them.</span>
        </t>
      </Panel>
      <div class="content">
        <div t-att-class="{busy: this.code.busy()}">
          <div t-foreach="this.errors" t-as="e" t-key="e.id" class="dim" t-out="e.id + ': ' + e.error"/>
          <div class="dash-layout">
          <!-- repositories sync strip: the repo list collapses to one row of chips,
               each carrying its sync health (up to date / N behind). Per-repo actions
               live in the chip's menu. -->
          <div t-if="this.favRepos.length" class="dash-repos">
            <div class="dash-repos-label">
              <span class="dash-repos-icon"><t t-out="this.addonsIcon"/></span>
              <span>Repos</span>
            </div>
            <div class="dash-repos-chips">
              <div t-foreach="this.favRepos" t-as="r" t-key="r.id" class="dash-chip" t-att-class="this.chipClass(r)" t-att-title="this.commitTip(r)" t-on-click.stop="() => this.toggleMenu('repo:' + r.id)">
                <span class="dash-chip-name" t-out="r.id"/>
                <span class="dash-chip-branch" t-att-title="r.current" t-out="r.current || '—'"/>
                <DirtyBadge t-if="r.dirty" path="r.path" repo="r.id"/>
                <span class="dash-chip-div"/>
                <span class="dash-chip-sync" t-att-title="this.syncTitle(r)"><span class="dash-chip-dot"/><t t-out="this.syncText(r)"/></span>
                <button t-if="r.behind and this.canRebaseRepo(r)" class="dash-chip-rebase" t-att-title="this.rebaseRepoTitle(r)" t-on-click.stop="() => this.rebaseRepo(r)">Rebase</button>
                <div class="dash-kebab-wrap">
                  <span class="dash-chip-caret" t-att-class="{open: this.menuId() === 'repo:' + r.id}"><t t-out="this.chevronIcon"/></span>
                  <div t-if="this.menuId() === 'repo:' + r.id" class="dash-menu">
                    <button class="dash-menu-item" t-att-disabled="!this.canRebaseRepo(r)" t-att-title="this.rebaseRepoTitle(r)" t-on-click="() => this.rebaseRepo(r)">Fetch &amp; rebase</button>
                    <button class="dash-menu-item" t-att-disabled="!this.canPushRepo(r)" t-att-title="this.pushRepoTitle(r)" t-on-click="() => this.pushRepo(r)">Push</button>
                    <button class="dash-menu-item" t-att-disabled="!this.canPushRepo(r)" t-att-title="this.pushRepoTitle(r)" t-on-click="() => this.pushForceRepo(r)">Push (force)</button>
                    <button t-if="r.canPr" class="dash-menu-item" t-on-click="() => this.openPr(r)">Open PR</button>
                    <button class="dash-menu-item" t-att-disabled="!r.path" t-on-click="() => this.openTerminal(r)">Open in terminal</button>
                    <button class="dash-menu-item" t-att-disabled="!r.path" t-on-click="() => this.code.openEditor(r.path, r.id)">Open with editor</button>
                    <button class="dash-menu-item" t-att-disabled="!r.path" t-on-click="() => this.openCommits(r)">See commits</button>
                    <button t-if="r.dirty" class="dash-menu-item" t-on-click="() => this.code.wipCommit(r.path, r.id)">WIP commit</button>
                    <button t-if="r.dirty" class="dash-menu-item danger" t-on-click="() => this.code.discard(r.path, r.id)">Discard changes</button>
                  </div>
                </div>
              </div>
            </div>
            <div class="dash-repos-actions">
              <button class="dash-rebase" t-att-disabled="!this.editorPaths.length" t-att-title="this.editAllTitle()" t-on-click="() => this.openAllEditors()">
                <t t-out="this.codeIcon"/>Edit
              </button>
              <button class="dash-rebase" t-att-disabled="!this.canRebaseAll()" t-att-title="this.rebaseAllTitle()" t-on-click="() => this.rebaseAll()">
                <t t-out="this.refreshIcon"/>Fetch &amp; rebase all
              </button>
            </div>
          </div>
          <div t-elif="this.code.error()" class="dim" t-out="'Failed to load: ' + this.code.error()"/>
          <div t-else="" class="dim">No repositories — mark repos as favorite in the Configuration tab to manage them here.</div>
          </div><!-- /.dash-layout -->
        </div>
      </div>
    </section>`;

  code = plugin(CodePlugin);
  config = plugin(ConfigPlugin);
  server = plugin(ServerPlugin);
  dialogs = plugin(DialogPlugin);
  eventLog = plugin(EventLogPlugin);
  refreshIcon = m(ICONS.refresh);
  addonsIcon = m(ICONS.addons); // "Repos" sync-strip label icon
  codeIcon = m(ICONS.code); // "Edit" (open all repos in the editor)
  chevronIcon = m(ICONS.chevron); // the repo chip's dropdown caret
  menuId = signal(""); // id of the repo chip whose action menu is open ("" = none)

  setup() {
    this._load(false);
    // close the chip menu on any outside click
    const closeMenu = () => this.menuId() && this.menuId.set("");
    onMounted(() => document.addEventListener("click", closeMenu));
    onWillUnmount(() => document.removeEventListener("click", closeMenu));
  }

  toggleMenu(id) {
    this.menuId.set(this.menuId() === id ? "" : id);
  }

  get stamp() {
    if (this.code.loading()) return "refreshing…";
    return this.code.at() ? `updated ${timeAgo(new Date(this.code.at()).toISOString())}` : "";
  }

  get errors() {
    return this.code.groups().errors;
  }

  // repo ids shown by the strip — favorite repos plus the current workspace's repos.
  // Narrow both the branch and PR fetch to these (the only repos this screen shows).
  _repoIds() {
    const ids = new Set(this.config.config.repos.filter((r) => r.favorite).map((r) => r.id));
    const current = (this.config.config.workspaces || []).find(
      (w) => w.id === this.server.lastWorkspace(),
    );
    for (const c of current?.checkouts || []) ids.add(c.repo);
    return ids;
  }

  _load(force) {
    const ids = this._repoIds();
    this.code.load(force, ids, ids);
  }

  // repositories shown in the strip: union of the active workspace's repos and the
  // favorite repositories, in config order
  get favRepos() {
    const byId = Object.fromEntries(this.code.branchRepos().map((r) => [r.id, r]));
    const groups = this.code.groups();
    const currentTarget = (this.config.config.workspaces || []).find(
      (w) => w.id === this.server.lastWorkspace(),
    );
    const visibleIds = new Set([
      ...(currentTarget?.checkouts || []).map((c) => c.repo),
      ...this.config.config.repos.filter((r) => r.favorite).map((r) => r.id),
    ]);
    return this.config.config.repos
      .filter((r) => visibleIds.has(r.id))
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

  // commit tooltip: the last-commit date before the title
  commitTip(row) {
    const subject = row.subject || "—";
    return row.date ? `${timeAgo(row.date)} · ${subject}` : subject;
  }

  // sync-strip chip: state class + health text. "behind" (needs a rebase onto its
  // base) is the headline; missing/unreadable repos read as an error, and a repo we
  // have no branch data for yet stays neutral rather than claiming "up to date".
  chipClass(r) {
    if (r.error) return "chip-err";
    if (!r.current) return "chip-unknown";
    return r.behind ? "chip-behind" : "chip-ok";
  }

  syncText(r) {
    if (r.error) return "error";
    if (!r.current) return "—";
    return r.behind ? `${r.behind} behind` : "up to date";
  }

  syncTitle(r) {
    if (r.error) return r.error;
    if (!r.current) return "branch state not loaded yet";
    if (r.behind) {
      const ahead = r.ahead ? ` · ${r.ahead} ahead` : "";
      return `${r.behind} commit${r.behind === 1 ? "" : "s"} behind ${r.base}${ahead}`;
    }
    return `up to date with ${r.base}`;
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

  // push a single repo's current branch to the dev remote
  canPushRepo(r) {
    return !!r.current && !r.error && !!r.github && !!r.path;
  }

  pushRepoTitle(r) {
    if (r.error) return r.error;
    if (!r.github || !r.path) return "no canonical repo configured for this repository";
    return `push ${r.current} to the dev remote (odoo-dev)`;
  }

  pushRepo(r) {
    if (!this.canPushRepo(r)) return;
    return pushBranchesDialog(this.code, this.dialogs, [{ path: r.path, branch: r.current }], {
      title: `Push "${r.current}"?`,
      message: `Push ${r.current} (${r.id}) to the dev remote (odoo-dev)?`,
    });
  }

  pushForceRepo(r) {
    if (!this.canPushRepo(r)) return;
    return pushBranchesDialog(this.code, this.dialogs, [{ path: r.path, branch: r.current }], {
      title: `Force-push "${r.current}"?`,
      message: `Force-push ${r.current} (${r.id}) to the dev remote (odoo-dev) with --force-with-lease? This overwrites the remote branch.`,
      force: true,
    });
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
    if (!n)
      return "nothing to rebase — repositories are dirty, missing, or have no canonical remote";
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

  // local checkout folders of every shown repo, for "Edit" (open them all at once)
  get editorPaths() {
    return this.favRepos.map((r) => r.path).filter(Boolean);
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
    if (paths.length) this.code.openEditorPaths(paths, "all repositories");
  }

  // open a modal bash terminal in this repo's directory
  openTerminal(r) {
    if (!r.path) return;
    this.dialogs.openComponent(TerminalDialog, { path: r.path, label: r.id });
  }

  // show the last commits on this repo's current branch
  openCommits(r) {
    if (!r.path) return;
    this.dialogs.openComponent(CommitsDialog, {
      path: r.path,
      ref: r.current || "",
      label: `${r.id} · ${r.current || "?"}`,
      github: r.github || "",
    });
  }

  // open GitHub's PR-creation page for this repo's current branch
  openPr(r) {
    this.eventLog.add(`opening PR for ${r.current} (${r.id})`);
    window.open(this.code.prCreateUrl(r.github, r.current), "_blank");
  }
}

// ─────────────────────────── Server screen ───────────────────────────
