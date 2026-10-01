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
import { timeAgo } from "./utils.ts";
import { CodePlugin } from "./code_plugin.ts";
import { ConfigPlugin } from "./config_plugin.ts";
import { DialogPlugin } from "./dialog_plugin.ts";
import { ICONS, editCommitMessage, m, useDragResize } from "./common.ts";
import type { DragResize } from "./common.ts";
import type { PluginInstance, Type } from "@odoo/owl";

// one repo a searched branch was found in: locally (attach as-is) or only on a
// remote (`remote` = the git remote to fetch it from)
interface BranchHitRepo {
  id: string;
  local: boolean;
  remote?: string;
}

// one result row: a branch name + the repos it exists in
interface BranchHit {
  branch: string;
  repos: BranchHitRepo[];
}

// what RemoteBranchDialog resolves with (null when cancelled)
export interface RemoteBranchPick {
  branch: string;
  repos: string[];
  remoteByRepo: Record<string, string>; // remote-only repos → the remote to fetch from
}

// /api/code/remote-branches/search's response
interface RemoteBranchSearch {
  ok: boolean;
  results: { repo: string; branch: string; remote: string }[];
}

// Searches BOTH branches you already have locally (instant, from the Branches
// screen's own in-memory data — code.groups(), no network) and branches on
// GitHub you don't (debounced, /api/code/remote-branches/search). Rows are
// merged by branch name so a repo present in both shows once, tagged "local"
// (attach as-is, no fetch needed) vs. "remote" (needs a fetch first). `repoIds`
// (optional array) scopes both searches to a create form's ticked repos —
// omitted, it searches every repo with a path (local) or a github slug (remote).
export class RemoteBranchDialog extends Component {
  static template = xml`
    <div class="dialog-backdrop" t-on-click="() => this.done(null)">
      <div class="dialog rbd" t-on-click.stop="() => {}">
        <h2 class="dialog-title">Search branches</h2>
        <div class="dialog-body">
          <div class="dialog-field">
            <label>Branch name</label>
            <input type="text" class="rbd-input" t-ref="this.inputEl"
                   placeholder="type to search local + remote…"
                   t-on-input="(ev) => this.onInput(ev.target.value)"
                   t-on-keydown="(ev) => this.onKey(ev)"/>
          </div>
          <div class="rbd-results">
            <div t-if="this.searching()" class="rbd-status">Searching remote…</div>
            <div t-elif="this.searched() and !this.rows().length" class="rbd-status">No matching branches found.</div>
            <div t-foreach="this.rows()" t-as="r" t-key="r.branch"
                 class="rbd-row" t-att-class="{selected: this.sel() === r.branch}"
                 t-on-click="() => this.sel.set(r.branch)">
              <span class="rbd-branch" t-out="r.branch"/>
              <span class="rbd-repos">
                <t t-foreach="r.repos" t-as="rr" t-key="rr.id">
                  <span class="rbd-repo-tag" t-att-class="rr.local ? 'local' : 'remote'" t-out="rr.id"/>
                </t>
              </span>
            </div>
          </div>
        </div>
        <div class="dialog-foot">
          <button class="pbtn primary" t-att-disabled="!this.sel()" t-on-click="() => this.ok()">Continue</button>
          <button class="pbtn" t-on-click="() => this.done(null)">Cancel</button>
        </div>
      </div>
    </div>`;

  props = useProps({
    done: t.function<[RemoteBranchPick | null], void>(),
    repoIds: (t.any() as Type<string[]>).optional(), // not validated at runtime
  });

  config = usePlugin(ConfigPlugin);
  code = usePlugin(CodePlugin);
  searching = signal(false); // the remote (network) half only — local is instant
  searched = signal(false);
  rows = signal<BranchHit[]>([]);
  sel = signal("");
  inputEl = signal.ref(HTMLElement);
  _timer?: ReturnType<typeof setTimeout>;
  _query = "";

  setup() {
    onMounted(() => this.inputEl()?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.done(null);
    };
    document.addEventListener("keydown", onKey);
    onWillUnmount(() => {
      document.removeEventListener("keydown", onKey);
      clearTimeout(this._timer);
    });
  }

  done(result: RemoteBranchPick | null) {
    this.props.done(result);
  }

  get repoIds(): Set<string> | null {
    return this.props.repoIds ? new Set(this.props.repoIds) : null;
  }

  onInput(val: string) {
    this.sel.set("");
    clearTimeout(this._timer);
    this._query = val.trim();
    if (!this._query) {
      this.searching.set(false);
      this.searched.set(false);
      this.rows.set([]);
      return;
    }
    this._searchLocal(this._query); // instant, no debounce — it's already in memory
    this.searching.set(true);
    this._timer = setTimeout(() => this._searchRemote(this._query), 300);
  }

  // local branches, from the same {branch, rows: [{repo, ...}]} groups the
  // Branches screen already holds in memory — no network round-trip
  _searchLocal(query: string) {
    const ids = this.repoIds;
    const byBranch = new Map<string, BranchHitRepo[]>();
    for (const g of this.code.groups().list) {
      if (!g.branch.includes(query)) continue;
      const repos = g.rows
        .filter((r) => !ids || ids.has(r.repo))
        .map((r) => ({ id: r.repo, local: true }));
      if (repos.length) byBranch.set(g.branch, repos);
    }
    this.rows.set([...byBranch.entries()].map(([branch, repos]) => ({ branch, repos })));
    this.searched.set(true);
  }

  async _searchRemote(query: string) {
    const ids = this.repoIds;
    const repos = this.config.config.repos
      .filter((r) => r.github && (!ids || ids.has(r.id)))
      .map((r) => ({
        id: r.id,
        github: r.github,
        path: r.path,
        push_remote: r.push_remote,
        pull_remote: r.pull_remote,
      }));
    try {
      const res = await fetch("/api/code/remote-branches/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repos, query }),
      });
      const data: RemoteBranchSearch = await res.json();
      if (query !== this._query || !data.ok) return; // input moved on — drop this response
      const byBranch = new Map<string, Map<string, string>>();
      for (const { repo, branch, remote } of data.results) {
        if (!byBranch.has(branch)) byBranch.set(branch, new Map());
        byBranch.get(branch)!.set(repo, remote);
      }
      this._mergeRemote(byBranch);
    } finally {
      if (query === this._query) this.searching.set(false);
    }
  }

  // merge the remote results into whatever `_searchLocal` already produced,
  // tagging each repo local/remote so a repo found in both shows once (as local,
  // no fetch needed); a remote-only repo carries the git remote name to fetch it
  // from (the upstream `pull_remote`, or a fork's `push_remote` — see
  // GitHubService.search_branches), so a caller never guesses the wrong one
  _mergeRemote(remoteByBranch: Map<string, Map<string, string>>) {
    const merged = new Map(
      this.rows().map((r) => [r.branch, new Map(r.repos.map((x) => [x.id, x]))]),
    );
    for (const [branch, repoRemotes] of remoteByBranch) {
      if (!merged.has(branch)) merged.set(branch, new Map());
      // set just above when missing
      for (const [repo, remote] of repoRemotes)
        if (!merged.get(branch)!.has(repo))
          merged.get(branch)!.set(repo, { id: repo, local: false, remote });
    }
    this.rows.set(
      [...merged.entries()].map(([branch, repoMap]) => ({
        branch,
        repos: [...repoMap.values()],
      })),
    );
  }

  onKey(ev: KeyboardEvent) {
    if (ev.key === "Enter" && this.sel()) this.ok();
  }

  ok() {
    if (!this.sel()) return;
    const branch = this.sel();
    const rowRepos = this.rows().find((r) => r.branch === branch)?.repos || [];
    const repos = rowRepos.map((r) => r.id);
    // which remote to `git fetch` each remote-only repo's branch from — a local
    // repo needs none, it's already there
    const remoteByRepo: Record<string, string> = Object.fromEntries(
      rowRepos.filter((r) => !r.local && r.remote).map((r) => [r.id, r.remote!]), // filtered
    );
    this.done({ branch, repos, remoteByRepo });
  }
}

// ─────────────────────────── Event log ───────────────────────────
// A floating, toggleable panel (bottom-right) listing business events. Hidden
// by default; toggled from the sidebar. Newest entries first.

// lazy-load xterm.js + addon-fit only on first terminal open

// one commit row, as CodePlugin.commits() returns it
interface CommitRow {
  sha: string;
  date: string;
  subject: string;
  author: string;
  body?: string;
  ahead?: boolean; // this branch's own commit (editable), not inherited from its base
}

export class CommitsDialog extends Component {
  static template = xml`
    <div class="term-panel commits-panel" t-ref="this.drag.handle">
      <div class="term-panel-head" t-on-mousedown="this.drag.onDragStart">
        <span class="term-panel-title" t-att-title="this.props.path" t-out="this.props.label"/>
        <button class="event-log-x" title="close" t-on-click="() => this.done(null)">✕</button>
      </div>
      <div class="commits-body">
        <div t-if="this.loading()" class="commits-empty">loading…</div>
        <div t-elif="this.error()" class="commits-empty" t-out="this.error()"/>
        <div t-elif="!this.commits().length" class="commits-empty">no commits</div>
        <t t-else="">
          <t t-foreach="this.commits()" t-as="c" t-key="c.sha">
            <div class="commit-row" t-att-class="{expanded: this.isExpanded(c.sha)}" t-on-click="() => this.toggle(c.sha)">
              <span class="commit-when" t-att-title="c.date" t-out="this.when(c.date)"/>
              <span class="commit-subject" t-att-title="c.subject" t-out="c.subject"/>
              <span class="commit-author" t-out="c.author"/>
            </div>
            <div t-if="this.isExpanded(c.sha)" class="commit-detail">
              <div class="commit-detail-meta">
                <span class="commit-detail-left">
                  <a t-if="this.props.github" class="commit-detail-hash" target="_blank" t-att-href="this.commitUrl(c)" t-att-title="'open ' + c.sha + ' on GitHub'"><t t-out="c.sha"/><t t-out="this.externalIcon"/></a>
                  <span t-else="" class="commit-detail-hash" t-out="c.sha"/>
                  <span class="commit-detail-date" t-out="this.fullDate(c.date)"/>
                </span>
                <button t-if="c.ahead" class="commit-edit-btn" title="edit this commit's message" t-on-click.stop="() => this.editMessage(c)">edit</button>
              </div>
              <pre class="commit-body" t-out="this.message(c)"/>
            </div>
          </t>
        </t>
      </div>
      <div class="term-panel-resize" t-on-mousedown="this.drag.onResizeStart"/>
    </div>`;

  props = useProps({
    done: t.function<[null], void>(),
    path: t.string(),
    label: t.string(),
    ref: t.string(),
    github: t.string().optional(),
    base: t.string().optional(), // the branch's own base (e.g. "master") — gates which
    // commits are "ahead" (this branch's own, editable) vs inherited from it
    pullRemote: t.string().optional(),
  });

  code = usePlugin(CodePlugin);
  dialogs = usePlugin(DialogPlugin);
  externalIcon = m(ICONS.external);
  commits = signal<CommitRow[]>([]);
  loading = signal(true);
  error = signal("");
  expanded = signal(new Set<string>());
  declare drag: DragResize; // set in setup()

  setup() {
    this.drag = useDragResize({ w: 620, h: 460 });
    onMounted(() => this.load());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.done(null);
    };
    document.addEventListener("keydown", onKey);
    onWillUnmount(() => document.removeEventListener("keydown", onKey));
  }

  async load() {
    this.loading.set(true);
    try {
      this.commits.set(
        await this.code.commits(this.props.path, this.props.ref, {
          base: this.props.base,
          pullRemote: this.props.pullRemote,
        }),
      );
    } catch (e) {
      this.error.set((e as Error).message); // CodePlugin rejects with an Error
    } finally {
      this.loading.set(false);
    }
  }

  // open the shared textarea editor prefilled with this commit's current
  // message; on confirm, reword it server-side and reload the list
  async editMessage(c: CommitRow) {
    const message = await editCommitMessage(this.dialogs, {
      title: "Edit commit message",
      initialMessage: this.message(c),
      okLabel: "Save",
    });
    if (!message) return;
    try {
      await this.code.rewordCommit(this.props.path, c.sha, message, {
        base: this.props.base,
        pullRemote: this.props.pullRemote,
      });
      await this.load();
    } catch (e) {
      this.dialogs.error("Edit commit message failed", (e as Error).message); // see load()
    }
  }

  when(date: string) {
    return timeAgo(date);
  }

  fullDate(date: string): string {
    const d = new Date(date);
    return isNaN(d.getTime()) ? date : d.toLocaleString();
  }

  toggle(sha: string) {
    const s = new Set(this.expanded());
    if (s.has(sha)) s.delete(sha);
    else s.add(sha);
    this.expanded.set(s);
  }

  isExpanded(sha: string): boolean {
    return this.expanded().has(sha);
  }

  // full commit message (subject + body) shown when a row is expanded
  message(c: CommitRow): string {
    return c.body ? `${c.subject}\n\n${c.body}` : c.subject;
  }

  // the commit on GitHub (only linked when the repo has a github slug)
  commitUrl(c: CommitRow): string {
    return `https://github.com/${this.props.github}/commit/${c.sha}`;
  }

  done(result: null) {
    this.props.done(result);
  }
}

// one branch to push (see pushBranchesDialog)
export interface PushBranch {
  path: string;
  branch: string;
  repo: string;
  workspaceId?: string;
}

// confirm (via the app modal) then push one or more branches to the dev remote.
// branches: [{ path, branch, repo, workspaceId? }]. Shared by every "Push" affordance.
export async function pushBranchesDialog(
  code: PluginInstance<typeof CodePlugin>,
  dialogs: PluginInstance<typeof DialogPlugin>,
  branches: PushBranch[],
  { title, message, force = false }: { title: string; message?: string; force?: boolean },
): Promise<boolean> {
  if (!branches.length) return false;
  const ok = await dialogs.open({ title, message, okLabel: force ? "Force push" : "Push" });
  if (!ok) return false;
  for (const b of branches)
    await code.pushBranchNoConfirm(b.path, b.branch, b.repo, true, force, b.workspaceId || "");
  return true;
}
