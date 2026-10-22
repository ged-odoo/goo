// The commit-history editor for one checkout (CodePane's "See commits" view):
// browse the branch's commits + diffs, and rewrite the "ahead" segment — reorder
// (drag), squash, drop, and edit messages — as one pending plan that only touches
// git when applied (a single interactive rebase via code.rewriteHistory).
//
// The parent (CodePane.openHistory) loads the commits + head diff BEFORE mounting
// this component — the first frame is complete, never an empty skeleton — and
// remounts it (t-key) with a fresh payload after every apply/abort reload.

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
import type { Type } from "@odoo/owl";
import { CodePlugin } from "../core/code_plugin.ts";
import type { Commit, RebasePlanStep, RewriteHistoryError } from "../core/code_plugin.ts";
import { DialogPlugin } from "../core/dialog_plugin.ts";
import { ICONS, SearchBox, m } from "../core/common.ts";
import { TerminalDialog } from "../core/terminal.ts";
import { startRowDrag, dropIndex } from "../core/drag.ts";
import { errorMessage, timeAgo } from "../core/utils.ts";
import type { CheckoutRow } from "./code_pane.ts";

// a pending commit-message edit (title + body), keyed by sha in historyMessageEdits
interface MessageEdit {
  subject: string;
  body: string;
}

// one rendered diff line: its old/new line numbers and +/- sign (shown in the
// unselectable margin; "" where they don't apply) and the code without the sign
interface DiffLine {
  id: number | string;
  text: string;
  cls: string;
  oldNum: number | "";
  newNum: number | "";
  sign: string;
  // a hunk header's unchanged new-side lines hidden above it (start..end, inclusive;
  // old = new + delta): revealed downward from the previous hunk and upward from
  // this one. The file's closing row carries the gap after its last hunk, whose end
  // (the file's last line) is only known once the content is loaded (end: 0).
  gap?: { start: number; end: number; delta: number; trailing?: boolean };
  // set on a row that still hides lines: its key in historyExpanded, and the
  // directions it can reveal
  expand?: { key: string; up: boolean; down: boolean };
}

// lines revealed per click on an expand button
const EXPAND_STEP = 15;

interface DiffFile {
  id: number;
  path: string;
  lines: DiffLine[];
  // width of the line-number columns, in digits
  digits: number;
  // the path the copy button copies (the new one for a rename)
  copyPath: string;
  added: number;
  deleted: number;
}

export class CommitHistory extends Component {
  static components = { SearchBox };
  static template = xml`
    <div class="ws-history">
      <div class="ws-history-head">
        <button class="ws-history-back" title="back to checkouts" t-on-click="() => this.props.onClose()">←</button>
        <span class="ws-repo-tag" t-out="this.props.row.repo"/>
        <span class="ws-branch" t-out="this.props.row.branch"/>
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
            <t t-else="">
              <div class="ws-history-diff-tools">
                <SearchBox value="this.historyFileFilter" placeholder="'Filter files…'"/>
                <button class="pbtn ghost" t-att-disabled="!this.historyShownFiles.some((file) => this.historyCollapsedFiles().has(file.id))"
                        t-on-click="() => this.collapseAllDiffFiles(false)">Expand all</button>
                <button class="pbtn ghost" t-att-disabled="this.historyShownFiles.every((file) => this.historyCollapsedFiles().has(file.id))"
                        t-on-click="() => this.collapseAllDiffFiles(true)">Collapse all</button>
              </div>
              <div t-if="!this.historyShownFiles.length" class="ws-history-diff-state dim">No file matches this filter.</div>
              <div class="ws-history-diff">
                <div t-foreach="this.historyShownFiles" t-as="file" t-key="file.id" class="ws-history-diff-file">
                  <div class="ws-history-diff-file-head" t-att-class="{open: !this.historyCollapsedFiles().has(file.id)}">
                    <button class="ws-history-diff-file-toggle" t-att-aria-expanded="!this.historyCollapsedFiles().has(file.id)"
                            t-on-click="() => this.toggleDiffFile(file.id)">
                      <span class="rl-caret" t-att-class="{collapsed: this.historyCollapsedFiles().has(file.id)}"/>
                      <span class="ws-history-diff-file-path" t-out="file.path"/>
                    </button>
                    <button class="ws-sec-copy" t-att-title="'copy ' + file.copyPath"
                            t-on-click="() => this.copyDiffPath(file)">
                      <t t-if="this.historyCopiedFile() === file.id">copied</t><t t-out="this.copyIcon"/>
                    </button>
                    <span class="ws-history-diffstats">
                      <span class="add" t-out="'+' + file.added"/>
                      <span class="del" t-out="'-' + file.deleted"/>
                    </span>
                  </div>
                  <div t-if="!this.historyCollapsedFiles().has(file.id)" class="ws-history-diff-body">
                    <div class="ws-history-diff-lines" t-att-style="'--diff-digits: ' + file.digits">
                      <div t-foreach="file.lines" t-as="line" t-key="line.id"
                           class="ws-history-diff-line" t-att-class="line.cls">
                        <span class="ws-history-diff-margin">
                          <span t-if="line.expand" class="ws-history-diff-expanders">
                            <button t-if="line.expand.down" class="ws-history-diff-expand down"
                                    t-att-disabled="this.historyFileLoading().has(this.historySelected() + ':' + file.copyPath)"
                                    title="Show more lines below" t-on-click="() => this.expandDiffHunk(file, line.expand.key, 'down')">
                              <t t-out="this.expandIcon"/>
                            </button>
                            <button t-if="line.expand.up" class="ws-history-diff-expand up"
                                    t-att-disabled="this.historyFileLoading().has(this.historySelected() + ':' + file.copyPath)"
                                    title="Show more lines above" t-on-click="() => this.expandDiffHunk(file, line.expand.key, 'up')">
                              <t t-out="this.expandIcon"/>
                            </button>
                          </span>
                          <t t-else="">
                            <span class="ws-history-diff-num" t-out="line.oldNum"/>
                            <span class="ws-history-diff-num" t-out="line.newNum"/>
                          </t>
                          <span class="ws-history-diff-sign" t-out="line.sign"/>
                        </span>
                        <span class="ws-history-diff-code" t-out="line.text"/>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </t>
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
    </div>`;

  // row: the checkout row being edited; commits/diff/conflict: the pre-loaded
  // payload (head commit selected, its diff, any already-stuck-rebase message);
  // onClose: back to the checkout grid; reload: re-fetch + remount after a rewrite
  // (all t.any(): not validated at runtime — the types name what CodePane passes)
  props = useProps({
    row: t.any() as Type<CheckoutRow>,
    commits: t.any() as Type<Commit[]>,
    diff: t.any() as Type<string>,
    conflict: t.any() as Type<string>,
    onClose: t.any() as Type<() => void>,
    reload: t.any() as Type<() => Promise<unknown> | undefined>,
  });

  code = usePlugin(CodePlugin);
  dialogs = usePlugin(DialogPlugin);
  kebabIcon = m(ICONS.kebab);
  copyIcon = m(ICONS.copy);
  expandIcon = m(ICONS.chevron);
  historySelected = signal("");
  historyDiff = signal("");
  historyDiffLoading = signal(false);
  historyDiffError = signal("");
  // the diff's file filter (a case-insensitive part of the path), kept across commits
  historyFileFilter = signal("");
  // ids (historyDiffFiles' `id`) of the collapsed file blocks of the shown diff
  historyCollapsedFiles = signal(new Set<number>());
  // the shown commit's context expansion: lines revealed per hunk header (keyed
  // `<file id>:<line id>`), the new-side file contents they come from (by path),
  // and the `<sha>:<path>` contents being fetched
  historyExpanded = signal<Record<string, { up: number; down: number }>>({});
  historyFileContents = signal<Record<string, string[]>>({});
  historyFileLoading = signal(new Set<string>());
  // id of the file whose path was just copied (its copy button reads "copied")
  historyCopiedFile = signal<number | null>(null);
  _copiedTimer = 0;
  // the reorder/squash plan, kept purely client-side until "Apply": historyPlanIds
  // is the desired order of "ahead" shas in DISPLAY order (newest-first, same as
  // props.commits); historySquashSet marks a sha as folding into whichever entry
  // ends up directly BELOW it (older) once historyPlanIds is applied. Nothing here
  // touches git until applyHistoryPlan() sends the whole thing as one rebase.
  historyPlanIds = signal<string[]>([]);
  historySquashSet = signal(new Set<string>());
  historyDropSet = signal(new Set<string>());
  // sha -> {subject, body}; only entries that differ from git are retained.
  // Message edits travel with the reorder/squash plan and are applied by the
  // same interactive rebase, so editing never invalidates the pending shas.
  historyMessageEdits = signal<Record<string, MessageEdit>>({});
  historyMenuSha = signal("");
  historyDragSha = signal(""); // sha of the row being dragged ("" = none)
  historyApplying = signal(false);
  // set only when applyHistoryPlan's rebase conflicted and was left mid-flight,
  // OR the parent's open found one already stuck from a previous session — the
  // error message, "" once resolved
  historyConflict = signal("");
  historyListEl = signal.ref(HTMLElement);
  _diffSequence = 0;
  _diffFilesCache: { inputs: unknown[]; files: DiffFile[] } | null = null;
  _historyActionActive = false;

  setup() {
    // seed from the pre-loaded payload: head commit selected, its diff shown
    this.historySelected.set(this.props.commits[0]?.sha || "");
    this.historyDiff.set(this.props.diff || "");
    this.historyConflict.set(this.props.conflict || "");
    this.resetHistoryPlan();
    const closeMenu = () => {
      if (this.historyMenuSha()) this.historyMenuSha.set("");
    };
    const onKeydown = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      if (this.historyMenuSha()) this.historyMenuSha.set("");
      else this.props.onClose();
    };
    onMounted(() => document.addEventListener("click", closeMenu));
    onMounted(() => document.addEventListener("keydown", onKeydown));
    onWillUnmount(() => {
      this._diffSequence++;
      clearTimeout(this._copiedTimer);
      document.removeEventListener("click", closeMenu);
      document.removeEventListener("keydown", onKeydown);
    });
  }

  toggleHistoryMenu(sha: string): void {
    this.historyMenuSha.set(this.historyMenuSha() === sha ? "" : sha);
  }

  async selectHistoryCommit(commit: Commit | null): Promise<void> {
    if (!commit || (commit.sha === this.historySelected() && this.historyDiff())) return;
    this.historySelected.set(commit.sha);
    this.historyDiff.set("");
    this.historyCollapsedFiles.set(new Set());
    this.historyExpanded.set({});
    this.historyFileContents.set({});
    this.historyDiffError.set("");
    this.historyDiffLoading.set(true);
    this.historyCopiedFile.set(null);
    const sequence = ++this._diffSequence;
    try {
      const diff = await this.code.commitDiff(this.props.row.path, commit.sha);
      if (sequence === this._diffSequence) this.historyDiff.set(diff);
    } catch (e) {
      if (sequence === this._diffSequence) this.historyDiffError.set(errorMessage(e));
    } finally {
      if (sequence === this._diffSequence) this.historyDiffLoading.set(false);
    }
  }

  get historyCommit(): Commit | null {
    return this.props.commits.find((commit) => commit.sha === this.historySelected()) || null;
  }

  get historyCommitEditable(): boolean {
    return this.isHistoryCommitEditable(this.historyCommit);
  }

  isHistoryCommitEditable(commit: Commit | null): boolean {
    return !!commit?.ahead && !this.isHistorySquashed(commit.sha);
  }

  historySubject(commit: Commit | null): string {
    return (
      (commit ? this.historyMessageEdits()[commit.sha] : undefined)?.subject ??
      commit?.subject ??
      ""
    );
  }

  historyBody(commit: Commit | null): string {
    return (
      (commit ? this.historyMessageEdits()[commit.sha] : undefined)?.body ?? commit?.body ?? ""
    );
  }

  updateHistoryMessage(commit: Commit | null, field: keyof MessageEdit, value: string): void {
    if (
      !commit ||
      !this.isHistoryCommitEditable(commit) ||
      this.historyApplying() ||
      this.historyConflict()
    ) {
      return;
    }
    const next: MessageEdit = {
      subject: this.historySubject(commit),
      body: this.historyBody(commit),
      [field]: value,
    };
    const edits = { ...this.historyMessageEdits() };
    if (next.subject === commit.subject && next.body === commit.body) delete edits[commit.sha];
    else edits[commit.sha] = next;
    this.historyMessageEdits.set(edits);
  }

  saveHistoryMessageOnBlur(ev: FocusEvent): void {
    // Title + body are one editing zone: tabbing/clicking from one to the other
    // must not trigger two rebases. Leaving the zone applies the pending message
    // (and any reorder/squash plan it belongs to) as one atomic history rewrite.
    if (this._historyActionActive) return;
    // currentTarget: the .ws-history-message-zone the focusout handler is bound to
    const zone = ev.currentTarget as HTMLElement;
    if (ev.relatedTarget && zone.contains(ev.relatedTarget as Node)) return;
    if (!Object.keys(this.historyMessageEdits()).length || !this.historyPlanValid) return;
    this.applyHistoryPlan();
  }

  async dropHistoryCommit(commit: Commit | null): Promise<void> {
    if (
      !commit ||
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

  shortCommitDate(date: string): string {
    return date ? timeAgo(date) : "—";
  }

  fullCommitDate(date: string): string {
    if (!date) return "—";
    const value = new Date(date);
    return Number.isNaN(value.getTime()) ? date : value.toLocaleString();
  }

  // the diff split into one block per file (at each `diff --git` header), each
  // headed by its path — `old → new` for a rename/copy. The header lines that only
  // carry a path (`diff --git`, `index`, `---`/`+++`, `rename/copy from/to`) are
  // dropped; the rest of the file header (mode, similarity) is shown as meta. Hunk
  // lines are numbered from their `@@ -old +new @@` header.
  get historyDiffFiles(): DiffFile[] {
    // parsed once per diff / loaded content / expansion state, however many times
    // the template reads it
    const inputs = [this.historyDiff(), this.historyFileContents(), this.historyExpanded()];
    const cached = this._diffFilesCache;
    if (cached && cached.inputs.every((input, i) => input === inputs[i])) return cached.files;
    const files = this.parseDiffFiles();
    this._diffFilesCache = { inputs, files };
    return files;
  }

  parseDiffFiles(): DiffFile[] {
    const files: (Pick<DiffFile, "id" | "lines"> & {
      from: string;
      to: string;
      inHunk: boolean;
      oldNum: number;
      newNum: number;
    })[] = [];
    // git C-quotes a path holding `"`, `\` or a control character: "a\"b\tc\303\251"
    const unquote = (path: string) => {
      const quoted = /^"(.*)"$/.exec(path.replace(/\t$/, ""));
      if (!quoted) return path.replace(/\t$/, "");
      const bytes: number[] = [];
      const encoder = new TextEncoder();
      const escapes: Record<string, string> = { n: "\n", t: "\t", '"': '"', "\\": "\\" };
      const chars = Array.from(quoted[1]);
      for (let i = 0; i < chars.length; i++) {
        const octal =
          chars[i] === "\\" ? /^[0-7]{3}/.exec(chars.slice(i + 1, i + 4).join("")) : null;
        if (octal) {
          bytes.push(parseInt(octal[0], 8));
          i += 3;
        } else if (chars[i] === "\\" && i + 1 < chars.length) {
          i++;
          bytes.push(...encoder.encode(escapes[chars[i]] ?? chars[i]));
        } else {
          bytes.push(...encoder.encode(chars[i]));
        }
      }
      return new TextDecoder().decode(new Uint8Array(bytes));
    };
    const side = (path: string) =>
      path === "/dev/null" ? "" : unquote(path).replace(/^[ab]\//, "");
    this.historyDiff()
      .split("\n")
      .forEach((text, id) => {
        if (!text) return; // the patch's trailing newline
        if (text.startsWith("diff --git ") || !files.length) {
          // fallback for a header-only file (mode change, binary): `a/P b/P`, or
          // both quoted
          const both = text.startsWith("diff --git ") ? text.slice("diff --git ".length) : "";
          const quoted = /^("a\/.*") ("b\/.*")$/.exec(both);
          const half = (both.length - 1) / 2;
          const same = quoted
            ? side(quoted[1]) === side(quoted[2])
              ? side(quoted[1])
              : ""
            : both.slice(2, half) === both.slice(half + 3)
              ? both.slice(2, half)
              : "";
          files.push({
            id,
            lines: [],
            from: same,
            to: same,
            inHunk: false,
            oldNum: 1,
            newNum: 1,
          });
          if (text.startsWith("diff --git ")) return;
        }
        const file = files[files.length - 1];
        const line: DiffLine = { id, text, cls: "meta", oldNum: "", newNum: "", sign: "" };
        const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
        if (hunk) {
          // an empty side (`+N,0`) sits AFTER line N: its next line is N + 1
          const oldStart = Number(hunk[1]) + (hunk[2] === "0" ? 1 : 0);
          const newStart = Number(hunk[3]) + (hunk[4] === "0" ? 1 : 0);
          line.gap = { start: file.newNum, end: newStart - 1, delta: oldStart - newStart };
          file.inHunk = true;
          file.oldNum = oldStart;
          file.newNum = newStart;
          line.cls = "hunk";
        } else if (!file.inHunk) {
          const match = /^(--- |\+\+\+ |rename from |rename to |copy from |copy to )(.*)$/.exec(
            text,
          );
          if (match) {
            const [, kind, path] = match;
            const value = kind.startsWith("---") || kind.endsWith("from ") ? "from" : "to";
            file[value] = kind.startsWith("-") || kind.startsWith("+") ? side(path) : unquote(path);
            return;
          }
          if (text.startsWith("index ")) return;
        } else if (/^[-+ ]/.test(text)) {
          // a hunk body line: the sign moves to the margin, beside the line numbers
          line.sign = text[0].trim();
          line.text = text.slice(1);
          line.cls = { "+": "add", "-": "del", " ": "" }[text[0]] ?? "";
          if (text[0] !== "+") line.oldNum = file.oldNum++;
          if (text[0] !== "-") line.newNum = file.newNum++;
        }
        file.lines.push(line);
      });
    return files
      .filter((file) => file.lines.length || file.from || file.to)
      .map(({ id, from, to, lines, oldNum, newNum }) => ({
        id,
        path: from && to && from !== to ? `${from} → ${to}` : to || from,
        lines: this.expandDiffLines(id, to, [
          ...lines,
          // after the last hunk (not for a new file, which the diff shows whole)
          ...(from && to && lines.some((line) => line.gap)
            ? [
                {
                  id: "end",
                  text: "",
                  cls: "hunk",
                  oldNum: "",
                  newNum: "",
                  sign: "",
                  gap: { start: newNum, end: 0, delta: oldNum - newNum, trailing: true },
                } as DiffLine,
              ]
            : []),
        ]),
        // the largest line number shown: the hunks' last, or the end of the file
        // once its content is loaded (old side shifted by the last delta)
        digits: String(
          Math.max(
            oldNum,
            newNum,
            (this.historyFileContents()[to]?.length ?? 0) + Math.max(oldNum - newNum, 0),
          ),
        ).length,
        copyPath: to || from,
        added: lines.filter((line) => line.cls === "add").length,
        deleted: lines.filter((line) => line.cls === "del").length,
      }));
  }

  // a file's lines with each gap's revealed context spliced in around its hunk
  // header (from the new-side file content, once loaded): the lines revealed
  // downward above the header, those revealed upward below it. A row whose gap is
  // fully revealed is dropped, the lines around it being contiguous again.
  expandDiffLines(fileId: number, to: string, lines: DiffLine[]): DiffLine[] {
    const content = to ? this.historyFileContents()[to] : undefined;
    const expanded = this.historyExpanded();
    const contextLines = (
      key: string,
      gap: NonNullable<DiffLine["gap"]>,
      from: number,
      to: number,
    ) =>
      Array.from({ length: Math.max(to - from + 1, 0) }, (_, i): DiffLine => ({
        id: `${key}:${from + i}`,
        text: content?.[from + i - 1] ?? "",
        cls: "",
        oldNum: from + i + gap.delta,
        newNum: from + i,
        sign: "",
      }));
    return lines.flatMap((line) => {
      const gap = line.gap;
      if (!gap || !to) return [line];
      const key = `${fileId}:${line.id}`;
      const end = gap.trailing ? (content ? content.length : Infinity) : gap.end;
      const size = Math.max(end - gap.start + 1, 0);
      if (!size) return gap.trailing ? [] : [line];
      const { up = 0, down = 0 } = content ? expanded[key] || {} : {};
      const shownDown = Math.min(down, size);
      const shownUp = gap.trailing ? 0 : Math.min(up, size - shownDown);
      const above = contextLines(key, gap, gap.start, gap.start + shownDown - 1);
      const below = shownUp ? contextLines(key, gap, end - shownUp + 1, end) : [];
      if (shownDown + shownUp >= size) return [...above, ...below];
      // the first hunk's gap starts at line 1, with no hunk above to expand down from
      const expand = { key, up: !gap.trailing, down: gap.trailing || gap.start > 1 };
      return [...above, { ...line, expand }, ...below];
    });
  }

  // reveal EXPAND_STEP more lines of a gap, loading the file's content as of the
  // commit first
  async expandDiffHunk(file: DiffFile, key: string, direction: "up" | "down"): Promise<void> {
    const path = file.copyPath;
    const sha = this.historySelected();
    const loadKey = `${sha}:${path}`;
    if (!this.historyFileContents()[path]) {
      if (this.historyFileLoading().has(loadKey)) return;
      this.historyFileLoading.set(new Set([...this.historyFileLoading(), loadKey]));
      try {
        const content = await this.code.commitFile(this.props.row.path, sha, path);
        if (sha !== this.historySelected()) return;
        this.historyFileContents.set({
          ...this.historyFileContents(),
          // without the empty "line" after the file's final newline
          [path]: content ? content.replace(/\n$/, "").split("\n") : [],
        });
      } catch (e) {
        if (sha === this.historySelected())
          this.dialogs.error("Could not load the file", errorMessage(e));
        return;
      } finally {
        const loading = new Set(this.historyFileLoading());
        loading.delete(loadKey);
        this.historyFileLoading.set(loading);
      }
    }
    const expanded = this.historyExpanded();
    const shown = expanded[key] || { up: 0, down: 0 };
    this.historyExpanded.set({
      ...expanded,
      [key]: { ...shown, [direction]: shown[direction] + EXPAND_STEP },
    });
  }

  toggleDiffFile(id: number): void {
    const collapsed = new Set(this.historyCollapsedFiles());
    if (!collapsed.delete(id)) collapsed.add(id);
    this.historyCollapsedFiles.set(collapsed);
  }

  copyDiffPath(file: DiffFile): void {
    navigator.clipboard?.writeText(file.copyPath);
    this.historyCopiedFile.set(file.id);
    clearTimeout(this._copiedTimer);
    this._copiedTimer = window.setTimeout(() => this.historyCopiedFile.set(null), 1400);
  }

  // the files matching the filter (both sides of a rename are searched)
  get historyShownFiles(): DiffFile[] {
    const filter = this.historyFileFilter().trim().toLowerCase();
    const files = this.historyDiffFiles;
    return filter ? files.filter((file) => file.path.toLowerCase().includes(filter)) : files;
  }

  // collapse or expand the files the filter shows; the hidden ones keep their state
  collapseAllDiffFiles(collapse: boolean): void {
    const collapsed = new Set(this.historyCollapsedFiles());
    for (const file of this.historyShownFiles) {
      if (collapse) collapsed.add(file.id);
      else collapsed.delete(file.id);
    }
    this.historyCollapsedFiles.set(collapsed);
  }

  // ── reorder / squash ─────────────────────────────────────────────────────────
  // the ahead ("own", reorderable) commits in their pending historyPlanIds
  // order, followed by the frozen inherited tail in its original (untouched)
  // order — ahead commits are always the top segment of props.commits, so
  // this only ever reshuffles within that segment, never past it
  get historyOrderedCommits(): Commit[] {
    const byId = new Map(this.props.commits.map((c) => [c.sha, c]));
    const tail = this.props.commits.filter((c) => !c.ahead);
    return [
      ...this.historyPlanIds()
        .map((sha) => byId.get(sha))
        .filter((c): c is Commit => !!c),
      ...tail,
    ];
  }

  get historyAheadCount(): number {
    return this.historyPlanIds().length;
  }

  // any commit but the oldest ahead one can squash into whatever ends up
  // directly below it
  canSquashHistory(sha: string): boolean {
    const ids = this.historyPlanIds();
    const i = ids.indexOf(sha);
    return i >= 0 && i < ids.length - 1;
  }

  isHistorySquashed(sha: string): boolean {
    return this.historySquashSet().has(sha);
  }

  toggleHistorySquash(sha: string): void {
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

  get historyDirty(): boolean {
    return this.historyStructureDirty || Object.keys(this.historyMessageEdits()).length > 0;
  }

  get historyStructureDirty(): boolean {
    const original = this.props.commits.filter((c) => c.ahead).map((c) => c.sha);
    return (
      this.historyPlanIds().join("\0") !== original.join("\0") ||
      this.historySquashSet().size > 0 ||
      this.historyDropSet().size > 0
    );
  }

  get historyPlanValid(): boolean {
    return Object.values(this.historyMessageEdits()).every((edit) => edit.subject.trim());
  }

  get historyPlanSummary(): string {
    const total = this.historyPlanIds().length;
    const squashed = this.historySquashSet().size;
    const dropped = this.historyDropSet().size;
    const edited = Object.keys(this.historyMessageEdits()).length;
    const changes: string[] = [];
    if (squashed) changes.push(`${total} commits → ${total - squashed}`);
    else if (
      this.historyPlanIds().join("\0") !==
      this.props.commits
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

  resetHistoryPlan(): void {
    this.historyPlanIds.set(this.props.commits.filter((c) => c.ahead).map((c) => c.sha));
    this.historySquashSet.set(new Set());
    this.historyDropSet.set(new Set());
    this.historyMessageEdits.set({});
  }

  // Shared pointer drag (core/drag.ts): the grabbed row lifts into a ghost that
  // follows the cursor, while the real row — dimmed in place — live-reorders
  // through the ahead rows as the pointer crosses their midlines. Drop just
  // updates the pending plan (git untouched until Apply); Escape restores it.
  onHistoryRowDragStart(ev: PointerEvent, commit: Commit): void {
    if (this.historyApplying() || this.historyConflict()) return;
    const original = this.historyPlanIds();
    const stop = startRowDrag(ev, {
      // target: the drag handle inside the row (a DOM element)
      row: (ev.target as HTMLElement).closest<HTMLElement>(".ws-history-row"),
      onMove: (e) => this._historyDragMove(e, commit.sha),
      onEnd: (didCommit) => {
        this.historyDragSha.set("");
        if (!didCommit) this.historyPlanIds.set(original);
      },
    });
    if (!stop) return;
    this.historyDragSha.set(commit.sha);
  }

  _historyDragMove(ev: PointerEvent, sha: string): void {
    const rows = [
      ...(this.historyListEl()?.querySelectorAll<HTMLElement>(".ws-history-row-ahead") || []),
    ];
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
  async applyHistoryPlan(): Promise<void> {
    if (
      this.historyApplying() ||
      this.historyConflict() ||
      !this.historyDirty ||
      !this.historyPlanValid
    ) {
      return;
    }
    const row = this.props.row;
    const edits = this.historyMessageEdits();
    const plan = [...this.historyPlanIds()].reverse().map((sha) => {
      const entry: RebasePlanStep = {
        sha,
        squash: this.historySquashSet().has(sha),
        drop: this.historyDropSet().has(sha),
      };
      const edit = edits[sha];
      if (edit) {
        entry.message = edit.body ? `${edit.subject.trim()}\n\n${edit.body}` : edit.subject.trim();
      }
      return entry;
    });
    this.historyApplying.set(true);
    try {
      await this.code.rewriteHistory(row.path, row.base, plan, row.entry?.pull_remote || "");
      // a rebase changes shas/subjects the checkout card also shows — the parent
      // reload refreshes this repo's branch state and remounts us with the new
      // commits, so "back to checkouts" isn't stale
      await this.props.reload();
    } catch (e) {
      // rewriteHistory throws a RewriteHistoryError (postJSON's error + the conflict flag)
      if ((e as RewriteHistoryError).inProgress) {
        this.historyConflict.set(errorMessage(e));
      } else {
        this.dialogs.error("Edit history failed", errorMessage(e));
      }
    } finally {
      this.historyApplying.set(false);
    }
  }

  async abortHistoryConflict(): Promise<void> {
    if (this.historyApplying()) return;
    this.historyApplying.set(true);
    try {
      await this.code.abortRebase(this.props.row.path);
      this.historyConflict.set("");
      await this.props.reload();
    } catch (e) {
      this.dialogs.error("Abort failed", errorMessage(e));
    } finally {
      this.historyApplying.set(false);
    }
  }

  // let the user resolve the conflict by hand (git status / add / rebase
  // --continue or --abort); the banner stays up until they either abort here
  // or reopen the history (which reloads and drops the banner once resolved)
  openHistoryConflictTerminal(): void {
    const row = this.props.row;
    this.dialogs.openComponent(TerminalDialog, { path: row.path, label: `${row.repo} history` });
  }

  get historyDiffStats(): { added: number; deleted: number } {
    let added = 0;
    let deleted = 0;
    for (const line of this.historyDiffFiles.flatMap((file) => file.lines)) {
      if (line.cls === "add") added++;
      else if (line.cls === "del") deleted++;
    }
    return { added, deleted };
  }
}
