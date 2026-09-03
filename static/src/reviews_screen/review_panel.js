// A floating side panel showing one saved version of a task's Claude review — the
// same markdown text persisted to ~/.config/goo/reviews/<workspace-id>/ (backend/
// server.py's ClaudeManager._persist_review, one numbered file per review run),
// fetched fresh on every open/navigation via ClaudePlugin.fetchReview rather than
// through the workspace's Claude tab. Opened from the Reviews screen's
// group-header button (see reviews.js's openReviewPanel) — reuses the same
// floating draggable/resizable chrome as CommitsDialog (core/dialogs.js),
// defaulting to the right edge of the screen. Always opens on the latest version;
// the pager (when more than one exists) browses older ones.

import {
  Component,
  markup,
  onMounted,
  onWillUnmount,
  signal,
  useEffect,
  useProps,
  usePlugin,
  xml,
  t,
} from "@odoo/owl";
import { ClaudePlugin } from "../workspaces_screen/claude_plugin.js";
import { WorkspacePlugin } from "../core/workspace_plugin.js";
import { RouterPlugin } from "../core/router_plugin.js";
import { ICONS, m, useDragResize } from "../core/common.js";
import { mdToHtml, parseReviewScore, reviewScoreClass } from "../core/utils.js";

export class ReviewPanel extends Component {
  static template = xml`
    <div class="term-panel review-panel" t-ref="this.drag.handle">
      <div class="term-panel-head" t-on-mousedown="this.drag.onDragStart">
        <div class="review-panel-head-left">
          <span class="term-panel-title" t-out="this.props.label"/>
          <span t-if="this.score() !== null" class="rev-score" t-att-class="this.scoreClass()" t-out="this.score()"/>
        </div>
        <button class="event-log-x" title="close" t-on-click="() => this.done(null)">✕</button>
      </div>
      <div class="review-panel-body">
        <div t-if="this.loading()" class="commits-empty">loading…</div>
        <div t-elif="!this.text()" class="commits-empty">no review saved for this task yet</div>
        <t t-else="">
          <div t-if="this.createdLabel()" class="review-panel-meta dim">Reviewed <t t-out="this.createdLabel()"/></div>
          <div t-if="this.running()" class="review-panel-working"><span class="spin"/>Claude is reviewing again…</div>
          <div class="review-panel-text md-content" t-out="this.html()"/>
        </t>
      </div>
      <div class="review-panel-foot">
        <div t-if="this.versions().length > 1" class="review-panel-pager">
          <button class="pbtn rp-pager-prev" title="older" t-att-disabled="!this.hasPrev()" t-on-click="() => this.prevVersion()"><t t-out="this.prevIcon"/></button>
          <span class="review-panel-pager-label" t-out="this.pagerLabel()"/>
          <button class="pbtn rp-pager-next" title="newer" t-att-disabled="!this.hasNext()" t-on-click="() => this.nextVersion()"><t t-out="this.nextIcon"/></button>
        </div>
        <div class="review-panel-foot-actions">
          <button class="pbtn" t-att-disabled="this.running()" t-on-click="() => this.reviewAgain()">
            <t t-if="this.running()">Reviewing…</t>
            <t t-else="">Review again</t>
          </button>
          <button class="pbtn primary" t-on-click="() => this.continueToChat()">Continue to chat with claude</button>
        </div>
      </div>
      <div class="term-panel-resize" t-on-mousedown="this.drag.onResizeStart"/>
    </div>`;

  props = useProps({
    done: t.function(),
    workspaceId: t.string(),
    label: t.string(),
    onReviewAgain: t.function(),
  });

  claude = usePlugin(ClaudePlugin);
  wt = usePlugin(WorkspacePlugin);
  router = usePlugin(RouterPlugin);
  prevIcon = m(ICONS.chevronLeft);
  nextIcon = m(ICONS.chevronRight);
  text = signal("");
  version = signal(null);
  versions = signal([]);
  created = signal(null);
  loading = signal(true);

  setup() {
    this.drag = useDragResize({
      w: 640,
      h: 620,
      place: (w, h) => ({
        x: Math.max(0, window.innerWidth - w - 16),
        y: Math.max(0, Math.floor((window.innerHeight - h) / 2)),
      }),
    });
    onMounted(() => this.load());
    // "Review again" just starts a Claude turn (see reviews.js's _rerunReview) —
    // this jumps the panel to the newly saved version once it lands, without the
    // caller needing to know when that happens.
    let wasRunning = false;
    useEffect(() => {
      const running = this.running();
      if (wasRunning && !running) this.load();
      wasRunning = running;
    });
    const onKey = (e) => {
      if (e.key === "Escape") this.done(null);
    };
    document.addEventListener("keydown", onKey);
    onWillUnmount(() => document.removeEventListener("keydown", onKey));
  }

  async load(version) {
    this.loading.set(true);
    try {
      const res = await this.claude.fetchReview(this.props.workspaceId, version);
      this.text.set(res.text);
      this.version.set(res.version);
      this.versions.set(res.versions);
      this.created.set(res.created);
    } finally {
      this.loading.set(false);
    }
  }

  // <version>'s "created" epoch seconds (the .md file's mtime on disk — see
  // backend/server.py's ClaudeManager.review_text), as a locale date/time string —
  // "" if unknown. Mainly useful once there's more than one version to tell apart,
  // but shown for a single review too.
  createdLabel() {
    const c = this.created();
    if (!c) return "";
    return new Date(c * 1000).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }

  // rendered once per text change, not cached — reviews are short enough that
  // re-parsing on every render is a non-issue, and a signal-backed getter would
  // just be more code for the same effect.
  html() {
    return markup(mdToHtml(this.text()));
  }

  // Claude's own merge-readiness guess (0-100), parsed straight from the currently
  // shown version's text — same "Score: N/100" convention as the group-header
  // badge (ClaudePlugin.reviewScore), just read off this panel's own fetched text
  // instead of the live conversation.
  score() {
    return parseReviewScore(this.text());
  }

  scoreClass() {
    return reviewScoreClass(this.score());
  }

  running() {
    return this.claude.running(this.props.workspaceId);
  }

  _pagerIndex() {
    return this.versions().indexOf(this.version());
  }

  hasPrev() {
    return this._pagerIndex() > 0;
  }

  hasNext() {
    const i = this._pagerIndex();
    return i >= 0 && i < this.versions().length - 1;
  }

  pagerLabel() {
    const i = this._pagerIndex();
    return i < 0 ? "" : `${i + 1}/${this.versions().length}`;
  }

  prevVersion() {
    const i = this._pagerIndex();
    if (i > 0) this.load(this.versions()[i - 1]);
  }

  nextVersion() {
    const i = this._pagerIndex();
    if (i >= 0 && i < this.versions().length - 1) this.load(this.versions()[i + 1]);
  }

  async reviewAgain() {
    if (this.running()) return;
    await this.props.onReviewAgain();
  }

  done(result) {
    this.props.done(result);
  }

  // jump to the workspace's own Claude tab for the full transcript (tool calls,
  // the original prompt, etc.) — this panel only ever shows one saved review
  // version's text. Closes the panel first since the dialog container stays
  // mounted across screen navigation and would otherwise keep floating there.
  continueToChat() {
    this.wt.selectOnOpen(this.props.workspaceId);
    this.wt.requestedPane.set("claude");
    this.router.go("workspaces");
    this.done(null);
  }
}
