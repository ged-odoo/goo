// Rich cells for the Reviews list (see reviews.ts) — each receives { row, screen }.
// `row` is a tracked PR (see ReviewsScreen.rows) and `screen` is the ReviewsScreen
// instance (row actions live there). ActionsCell is deliberately NOT redefined
// here — branches_screen/cells.ts's version only needs screen.hasRowMenu /
// screen.openRowMenu, which are row-shape agnostic, so reviews.ts imports it as-is.

import { Component, usePlugin, xml, useProps, t } from "@odoo/owl";
import type { Type } from "@odoo/owl";
import { CodePlugin } from "../core/code_plugin.ts";
import type { PrRef } from "../core/code_plugin.ts";
import type { ForwardPortPull, ForwardPortRow } from "../core/observed_models.ts";
import { ReviewsPlugin } from "./reviews_plugin.ts";
import type { ReviewStatus } from "./reviews_plugin.ts";
import type { ReviewsScreen } from "./reviews.ts";
import { mbIsRPlus } from "../core/common.ts";

// one tracked PR as the Reviews list shows it (ReviewsScreen.allRows): the
// config.reviews entry enriched with its fetched PR info + review status
export interface ReviewRow {
  id: string; // "github#number"
  github: string;
  number: number;
  branch: string; // the PR's head branch, or `id` until its info has loaded
  title: string;
  url: string;
  state: string; // GitHub's: open | closed | merged ("" until loaded)
  draft: boolean;
  loaded: boolean;
  reviewStatus: ReviewStatus | undefined;
  important: boolean;
}

// the slice of CodePlugin's mergebot store taskFullyMerged reads (forward-port
// cells/pulls may be missing on a partial matrix)
export interface MergebotView {
  mergebot(): Record<string, string>;
  mbForwardPorts(): Record<string, { cells?: { pulls?: PrRef[] }[] }[] | null>;
}

// Odoo's mergebot merges by pushing directly to the target branch and closing
// the PR — it never uses GitHub's own merge button — so GitHub's PR `state`
// for an actually-merged PR is "closed", not "merged". mergebot's own scraped
// state is the one source that gets this right; GitHub's state is only a
// (rare, e.g. someone merged by hand) fallback.
export function isMerged(row: { state?: string }, mbState: string): boolean {
  return row.state === "merged" || mbState === "merged";
}

// PR: "#number" link + title + open/closed/merged/draft state badge (a dash
// placeholder while the tracked pair's info hasn't loaded yet).
export class PrCell extends Component {
  // { row, screen } — ReviewsScreen._cell (neither validated at runtime)
  props = useProps({
    row: t.any() as Type<ReviewRow>,
    screen: t.any() as Type<ReviewsScreen>,
  });

  code = usePlugin(CodePlugin);
  static template = xml`
    <span class="rev-pr">
      <t t-if="this.row.loaded">
        <a class="pr-link" target="_blank" t-att-href="this.row.url" t-out="'#' + this.row.number"/>
        <span class="rev-pr-title" t-out="this.row.title"/>
        <span class="pr-state" t-att-class="this.state" t-out="this.state"/>
      </t>
      <span t-else="" class="dim" t-out="'#' + this.row.number + '…'"/>
    </span>`;

  get row(): ReviewRow {
    return this.props.row;
  }

  get state(): string {
    if (isMerged(this.row, this.code.mergebot()[`${this.row.github}#${this.row.number}`] || ""))
      return "merged";
    return this.row.draft && this.row.state === "open" ? "draft" : this.row.state;
  }
}

// Status: the one primary indicator — merged > r+'d > reviewed > to-review —
// folding mergebot's r+ acknowledgement (mbIsRPlus, common.ts) and the review-
// status fetch (ReviewsPlugin) into a single pill, in the existing dash-pr-state
// category palette (blocked/progress/ready/merged) so it matches the rest of the app.
// Exported as a pure function (not just the cell) so the screen's group-level
// rollup can reuse the exact same precedence.
export const STATUS_META: Record<StatusKey, { label: string; cls: string }> = {
  merged: { label: "Merged", cls: "merged" },
  rplus: { label: "R+'d", cls: "ready" },
  reviewed: { label: "Reviewed", cls: "progress" },
  to_review: { label: "To review", cls: "blocked" },
};

// "merged" outranks everything else. mbIsRPlus also returns true for a
// "merged" mbState, so merged must be caught here first or it'd be misfiled
// as "rplus" instead.
export type StatusKey = "merged" | "rplus" | "reviewed" | "to_review";

export function statusKey(
  row: { state?: string; reviewStatus?: ReviewStatus },
  mbState: string,
  mbDetail: string,
): StatusKey {
  if (isMerged(row, mbState)) return "merged";
  if (mbIsRPlus(mbState, mbDetail)) return "rplus";
  if (row.reviewStatus === "reviewed") return "reviewed";
  return "to_review";
}

// the worst (least-done) of a set of status keys, in STATUS_META's precedence
// order — shared by the screen's group rollup and this file's forward-port
// per-branch rollup.
const PRECEDENCE: StatusKey[] = ["to_review", "reviewed", "rplus", "merged"];
export function worstStatusKey(keys: StatusKey[]): StatusKey {
  let worst: StatusKey = "merged";
  for (const k of keys) {
    if (PRECEDENCE.indexOf(k) < PRECEDENCE.indexOf(worst)) worst = k;
  }
  return worst;
}

// true iff every row in a task is merged AND every forward port it has opened
// is itself merged too — the bar for "safe to untrack without asking first".
// A forward-port branch with no PR opened yet fails this (the propagation
// isn't finished), same as any pull that's still open.
export function taskFullyMerged(
  rows: Pick<ReviewRow, "github" | "number" | "state">[],
  code: MergebotView,
): boolean {
  return rows.every((row) => {
    const key = `${row.github}#${row.number}`;
    const mbState = code.mergebot()[key] || "";
    if (!isMerged(row, mbState)) return false;
    return (code.mbForwardPorts()[key] || []).every((fp) => {
      const pulls = (fp.cells || []).flatMap((c) => c.pulls || []);
      if (!pulls.length) return false;
      return pulls.every((p) => code.mergebot()[`${p.github}#${p.number}`] === "merged");
    });
  });
}

export class StatusCell extends Component {
  // { row, screen } — ReviewsScreen._cell (neither validated at runtime)
  props = useProps({
    row: t.any() as Type<ReviewRow>,
    screen: t.any() as Type<ReviewsScreen>,
  });

  code = usePlugin(CodePlugin);
  static template = xml`
    <span t-if="this.row.loaded" class="dash-pr-state" t-att-class="this.meta.cls" t-out="this.meta.label"/>
    <span t-else="" class="brg-dash">—</span>`;

  get row(): ReviewRow {
    return this.props.row;
  }

  get _key(): string {
    return `${this.row.github}#${this.row.number}`;
  }

  get mbState(): string {
    return this.code.mergebot()[this._key] || "";
  }

  get mbDetail(): string {
    return this.code.mbDetails()[this._key] || "";
  }

  get meta(): { label: string; cls: string } {
    return STATUS_META[statusKey(this.row, this.mbState, this.mbDetail)];
  }
}

// Forward ports: once a tracked PR is merged, one small badge per subsequent-
// branch row from the shared mergebot forward-port matrix (CodePlugin.mbForwardPorts
// — the same data Branches & PRs' mergebot tooltip draws from). Each pull's own
// to-review/reviewed/r+'d/merged status is computed exactly like the main
// PR rows (StatusCell/statusKey) — the badge is colored and worst-of'd on that,
// not the raw mergebot cell category — and a click opens a menu (built by the
// screen, screen.openForwardPortMenu) with Create workspace / Open on GitHub /
// Open on mergebot / Send r+, one set per repo the branch spans. A branch with
// no PR opened yet renders as a plain, non-interactive placeholder.
export class ForwardPortsCell extends Component {
  // { row, screen } — ReviewsScreen._cell (neither validated at runtime)
  props = useProps({
    row: t.any() as Type<ReviewRow>,
    screen: t.any() as Type<ReviewsScreen>,
  });

  code = usePlugin(CodePlugin);
  reviews = usePlugin(ReviewsPlugin);
  static template = xml`
    <span class="rev-fwports">
      <t t-foreach="this.rows" t-as="fp" t-key="fp.branch">
        <button t-if="this.hasPull(fp)" type="button" class="dash-pr-state" t-att-class="this.cls(fp)"
                t-att-title="this.title(fp)"
                t-on-click.stop="(ev) => this.props.screen.openForwardPortMenu(ev, this.props.row, fp)"
                t-out="fp.branch"/>
        <span t-else="" class="dash-pr-state other" t-att-title="fp.branch + ': not opened yet'" t-out="fp.branch"/>
      </t>
      <span t-if="!this.rows.length" class="brg-dash">—</span>
    </span>`;

  get rows(): ForwardPortRow[] {
    const row = this.props.row;
    const key = `${row.github}#${row.number}`;
    if (!isMerged(row, this.code.mergebot()[key] || "")) return [];
    return this.code.mbForwardPorts()[key] || [];
  }

  _pulls(fp: ForwardPortRow): ForwardPortPull[] {
    return (fp.cells || []).flatMap((c) => c.pulls || []);
  }

  hasPull(fp: ForwardPortRow): boolean {
    return this._pulls(fp).length > 0;
  }

  _pullStatusKey(pull: ForwardPortPull): StatusKey {
    const key = `${pull.github}#${pull.number}`;
    const mbState = this.code.mergebot()[key] || "";
    const mbDetail = this.code.mbDetails()[key] || "";
    const reviewStatus = this.reviews.reviewStatus()[key];
    return statusKey({ reviewStatus }, mbState, mbDetail);
  }

  cls(fp: ForwardPortRow): string {
    return STATUS_META[worstStatusKey(this._pulls(fp).map((p) => this._pullStatusKey(p)))].cls;
  }

  title(fp: ForwardPortRow): string {
    return this._pulls(fp)
      .map((p) => `${p.github}#${p.number}: ${STATUS_META[this._pullStatusKey(p)].label}`)
      .join("\n");
  }
}
