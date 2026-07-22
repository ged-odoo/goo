import { Component, usePlugin, xml } from "@odoo/owl";
import { CiPlugin } from "./ci_plugin.js";
import { ICONS, m } from "../core/common.js";
import { Panel } from "../core/panel.js";

// The CI screen — mergebot merge-queue health, one row per day for the last
// 14 days. Each staging's colour is its outcome (merged / failed / killed /
// in-progress). See CiService for the scraping + immutable-day cache.

export class CiScreen extends Component {
  static components = { Panel };
  static template = xml`
    <section class="ci-screen">
      <Panel title="'CI — merge queue'">
        <t t-set-slot="title-extra">
          <span class="dim ci-sub">master · last 14 days</span>
        </t>
        <t t-set-slot="top-right">
          <span class="meta" t-if="this.stamp" t-out="this.stamp"/>
          <button class="pbtn" t-att-disabled="this.ci.loading()" t-on-click="() => this.refresh()">
            <t t-out="this.refreshIcon"/> Refresh
          </button>
        </t>
      </Panel>
      <div class="content ci-content">
        <div t-if="this.ci.loading() and !this.ci.days().length" class="dim ci-status">Loading merge-queue data…</div>
        <div t-elif="this.ci.error()" class="dim ci-status">Failed to load: <t t-out="this.ci.error()"/></div>
        <table t-else="" class="ci-table">
          <thead>
            <tr>
              <th class="ci-col-day">Day</th>
              <th class="ci-num">Stagings</th>
              <th class="ci-num ci-merged">Merged</th>
              <th class="ci-num ci-failed">Failed</th>
              <th class="ci-num ci-killed">Killed</th>
              <th class="ci-num ci-pending">In&#160;progress</th>
              <th class="ci-num ci-prs">PRs&#160;merged</th>
              <th class="ci-num ci-rate">PR/hour</th>
            </tr>
          </thead>
          <tbody>
            <tr t-foreach="this.ci.days()" t-as="d" t-key="d.date" t-att-class="{'ci-today': d_index === 0}">
              <td class="ci-col-day">
                <b t-out="this.weekday(d.date)"/><span class="dim ci-date" t-out="d.date"/>
                <span t-if="d_index === 0" class="ci-tag">today</span>
              </td>
              <td class="ci-num" t-out="d.batches"/>
              <td class="ci-num ci-merged" t-out="d.merged or '·'"/>
              <td class="ci-num ci-failed" t-out="d.failed or '·'"/>
              <td class="ci-num ci-killed" t-out="d.killed or '·'"/>
              <td class="ci-num ci-pending" t-out="d.pending or '·'"/>
              <td class="ci-num ci-prs" t-out="d.prs_merged or '·'"/>
              <td class="ci-num ci-rate" t-out="this.perHour(d, d_index)"/>
            </tr>
          </tbody>
          <tfoot>
            <tr class="ci-total">
              <td class="ci-col-day">14-day total</td>
              <td class="ci-num" t-out="this.totals.batches"/>
              <td class="ci-num ci-merged" t-out="this.totals.merged"/>
              <td class="ci-num ci-failed" t-out="this.totals.failed"/>
              <td class="ci-num ci-killed" t-out="this.totals.killed"/>
              <td class="ci-num ci-pending" t-out="this.totals.pending"/>
              <td class="ci-num ci-prs" t-out="this.totals.prs_merged"/>
              <td class="ci-num ci-rate" t-out="this.totalPerHour"/>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>`;

  ci = usePlugin(CiPlugin);
  refreshIcon = m(ICONS.refresh);

  setup() {
    this.ci.load();
  }

  refresh() {
    this.ci.load(true);
  }

  get stamp() {
    const at = this.ci.at();
    if (!at) return "";
    return "updated " + new Date(at).toLocaleTimeString();
  }

  get totals() {
    const t = { batches: 0, merged: 0, failed: 0, killed: 0, pending: 0, prs_merged: 0 };
    for (const d of this.ci.days()) for (const k in t) t[k] += d[k] || 0;
    return t;
  }

  // hours the day has run: a full 24 for a completed day, the UTC hours elapsed so
  // far for today (row 0) — so today's PR/hour is a live rate, not diluted by /24
  _hours(dIndex) {
    if (dIndex !== 0) return 24;
    const now = new Date();
    return Math.max(now.getUTCHours() + now.getUTCMinutes() / 60, 0.25);
  }

  perHour(d, dIndex) {
    return (d.prs_merged / this._hours(dIndex)).toFixed(1);
  }

  get totalPerHour() {
    const days = this.ci.days();
    if (!days.length) return "0.0";
    let prs = 0;
    let hours = 0;
    days.forEach((d, i) => {
      prs += d.prs_merged || 0;
      hours += this._hours(i);
    });
    return (prs / hours).toFixed(1);
  }

  // "Wed" from an ISO date (parsed as UTC to match the server's staged day)
  weekday(iso) {
    return new Date(iso + "T00:00:00Z").toLocaleDateString(undefined, {
      weekday: "short",
      timeZone: "UTC",
    });
  }
}
