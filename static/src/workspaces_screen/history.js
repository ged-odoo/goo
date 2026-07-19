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
import { CodePlugin } from "../core/code_plugin.js";
import { DialogPlugin } from "../core/dialog_plugin.js";
import { ICONS, m } from "../core/common.js";
import { TerminalDialog } from "../core/terminal.js";
import { startRowDrag, dropIndex } from "../core/drag.js";
import { timeAgo } from "../core/utils.js";

export class CommitHistory extends Component {
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
    </div>`;

  // row: the checkout row being edited; commits/diff/conflict: the pre-loaded
  // payload (head commit selected, its diff, any already-stuck-rebase message);
  // onClose: back to the checkout grid; reload: re-fetch + remount after a rewrite
  props = useProps({
    row: t.any(),
    commits: t.any(),
    diff: t.any(),
    conflict: t.any(),
    onClose: t.any(),
    reload: t.any(),
  });

  code = usePlugin(CodePlugin);
  dialogs = usePlugin(DialogPlugin);
  kebabIcon = m(ICONS.kebab);
  historySelected = signal("");
  historyDiff = signal("");
  historyDiffLoading = signal(false);
  historyDiffError = signal("");
  // the reorder/squash plan, kept purely client-side until "Apply": historyPlanIds
  // is the desired order of "ahead" shas in DISPLAY order (newest-first, same as
  // props.commits); historySquashSet marks a sha as folding into whichever entry
  // ends up directly BELOW it (older) once historyPlanIds is applied. Nothing here
  // touches git until applyHistoryPlan() sends the whole thing as one rebase.
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
  // OR the parent's open found one already stuck from a previous session — the
  // error message, "" once resolved
  historyConflict = signal("");
  historyListEl = signal.ref(HTMLElement);
  _diffSequence = 0;
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
    const onKeydown = (ev) => {
      if (ev.key !== "Escape") return;
      if (this.historyMenuSha()) this.historyMenuSha.set("");
      else this.props.onClose();
    };
    onMounted(() => document.addEventListener("click", closeMenu));
    onMounted(() => document.addEventListener("keydown", onKeydown));
    onWillUnmount(() => {
      this._diffSequence++;
      document.removeEventListener("click", closeMenu);
      document.removeEventListener("keydown", onKeydown);
    });
  }

  toggleHistoryMenu(sha) {
    this.historyMenuSha.set(this.historyMenuSha() === sha ? "" : sha);
  }

  async selectHistoryCommit(commit) {
    if (!commit || (commit.sha === this.historySelected() && this.historyDiff())) return;
    this.historySelected.set(commit.sha);
    this.historyDiff.set("");
    this.historyDiffError.set("");
    this.historyDiffLoading.set(true);
    const sequence = ++this._diffSequence;
    try {
      const diff = await this.code.commitDiff(this.props.row.path, commit.sha);
      if (sequence === this._diffSequence) this.historyDiff.set(diff);
    } catch (e) {
      if (sequence === this._diffSequence) this.historyDiffError.set(e.message);
    } finally {
      if (sequence === this._diffSequence) this.historyDiffLoading.set(false);
    }
  }

  get historyCommit() {
    return this.props.commits.find((commit) => commit.sha === this.historySelected()) || null;
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

  // ── reorder / squash ─────────────────────────────────────────────────────────
  // the ahead ("own", reorderable) commits in their pending historyPlanIds
  // order, followed by the frozen inherited tail in its original (untouched)
  // order — ahead commits are always the top segment of props.commits, so
  // this only ever reshuffles within that segment, never past it
  get historyOrderedCommits() {
    const byId = new Map(this.props.commits.map((c) => [c.sha, c]));
    const tail = this.props.commits.filter((c) => !c.ahead);
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
    const original = this.props.commits.filter((c) => c.ahead).map((c) => c.sha);
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

  resetHistoryPlan() {
    this.historyPlanIds.set(this.props.commits.filter((c) => c.ahead).map((c) => c.sha));
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
    const row = this.props.row;
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
      // a rebase changes shas/subjects the checkout card also shows — the parent
      // reload refreshes this repo's branch state and remounts us with the new
      // commits, so "back to checkouts" isn't stale
      await this.props.reload();
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
    this.historyApplying.set(true);
    try {
      await this.code.abortRebase(this.props.row.path);
      this.historyConflict.set("");
      await this.props.reload();
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
    const row = this.props.row;
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
}
