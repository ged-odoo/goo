// Rich cells for the merged Branches & PRs list (see branches.js) — each is a
// FieldSpec `component` rendered by the generic RecordList. All receive
// `{ row, screen }`: `row` is the union row (kind "local" = a per-repo local
// branch, kind "pr" = an authored PR with no local branch) and `screen` is the
// BranchesScreen instance (row actions live there).

import { Component, usePlugin, xml, useProps, t } from "@odoo/owl";
import { CodePlugin } from "../core/code_plugin.js";
import { DirtyBadge, ICONS, m, mbCategory } from "../core/common.js";

// Repository: a GitHub branch link (+ dirty badge) for pushed local branches,
// a plain label otherwise (dim for PR-only rows — there's no local branch).
export class RepoCell extends Component {
  static components = { DirtyBadge };
  props = useProps({ row: t.any(), screen: t.any() });
  code = usePlugin(CodePlugin);
  externalIcon = m(ICONS.external);
  static template = xml`
    <span class="brg-repo">
      <a t-if="this.linked" class="br-repo-link" target="_blank"
         t-att-href="this.code.remoteBranchUrl(this.row.repo, this.row.github, this.row.branch)"
         t-att-title="'open the ' + this.row.repo + ' branch on GitHub'"><t t-out="this.row.repo"/><t t-out="this.externalIcon"/></a>
      <span t-else="" t-att-class="{dim: this.row.kind === 'pr'}" t-out="this.row.repo"/>
      <DirtyBadge t-if="this.row.dirty" path="this.row.path" repo="this.row.repo"/>
    </span>`;

  get row() {
    return this.props.row;
  }

  get linked() {
    return this.row.kind === "local" && this.row.remote && this.row.github;
  }
}

// PR: "#number" link + state badge, or a dash for local branches without a PR.
export class PrCell extends Component {
  props = useProps({ row: t.any(), screen: t.any() });
  static template = xml`
    <span class="brg-pr">
      <t t-if="this.pr">
        <a class="pr-link" target="_blank" t-att-href="this.pr.url" t-out="'#' + this.pr.number"/>
        <span class="pr-state" t-att-class="this.state" t-out="this.state"/>
      </t>
      <span t-else="" class="brg-dash">—</span>
    </span>`;

  get pr() {
    return this.props.row.pr;
  }

  get state() {
    return this.pr.draft && this.pr.state === "open" ? "draft" : this.pr.state;
  }
}

// Mergebot: the scraped state as a badge linking to the mergebot page, with the
// unmet requirements ("Review, CI") in the tooltip when blocked.
export class MergebotCell extends Component {
  props = useProps({ row: t.any(), screen: t.any() });
  code = usePlugin(CodePlugin);
  static template = xml`
    <span class="brg-pr">
      <a t-if="this.state" class="dash-pr-state" t-att-class="this.cls" target="_blank"
         t-att-href="this.code.mergebotUrl(this.pr.github, this.pr.number)"
         t-att-title="'mergebot: ' + this.state + (this.detail ? ' — missing: ' + this.detail : '')"
         t-out="this.state"/>
      <span t-else="" class="brg-dash">—</span>
    </span>`;

  get pr() {
    return this.props.row.pr;
  }

  get state() {
    return this.pr ? this.code.mergebot()[`${this.pr.github}#${this.pr.number}`] || "" : "";
  }

  get detail() {
    return this.pr ? this.code.mbDetails()[`${this.pr.github}#${this.pr.number}`] || "" : "";
  }

  get cls() {
    return mbCategory(this.state);
  }
}

// Actions: the row kebab, opening the shared floating ActionMenu (built by the
// screen — local rows get the full branch menu, PR-only rows just Close PR).
export class ActionsCell extends Component {
  props = useProps({ row: t.any(), screen: t.any() });
  kebabIcon = m(ICONS.kebab);
  static template = xml`
    <span class="brg-act">
      <button t-if="this.props.screen.hasRowMenu(this.props.row)" class="dash-kebab"
              t-att-title="this.props.row.kind === 'local' ? 'branch actions' : 'PR actions'"
              t-on-click.stop="(ev) => this.props.screen.openRowMenu(ev, this.props.row)"><t t-out="this.kebabIcon"/></button>
    </span>`;
}
