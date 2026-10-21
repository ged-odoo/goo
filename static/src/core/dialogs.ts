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
import { DialogPlugin } from "./dialog_plugin.ts";
import { ICONS, editCommitMessage, m, useDragResize } from "./common.ts";
import type { DragResize } from "./common.ts";
import type { PluginInstance } from "@odoo/owl";

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
