import { Component, onWillUnmount, usePlugin, signal, useEffect, xml } from "@odoo/owl";
import { NightlyPlugin } from "./nightly_plugin.js";
import { ICONS, loadScript, m } from "../core/common.js";
import { Panel } from "../core/panel.js";

export let _chartJsReady = null;

export function loadChartJs() {
  if (!_chartJsReady) {
    _chartJsReady = loadScript("/static/lib/chart/chart.umd.min.js", () => window.Chart)
      .then(() =>
        loadScript("/static/lib/chart/chartjs-plugin-zoom.min.js", () => window.ChartZoom),
      )
      .then(() => window.Chart.register(window.ChartZoom))
      .catch((e) => {
        _chartJsReady = null; // allow retry
        throw e;
      });
  }
  return _chartJsReady;
}

// options.plugins.zoom config shared by every chart: wheel-zoom + drag-to-pan,
// double-click to reset

export const CHART_ZOOM_OPTIONS = {
  pan: { enabled: true, mode: "x" },
  zoom: {
    wheel: { enabled: true },
    drag: { enabled: true, modifierKey: "shift" },
    mode: "x",
  },
};

// shared categorical palette for Chart.js datasets (Tableau-10-ish)

export const CHART_COLORS = [
  "#4e79a7",
  "#f28e2b",
  "#e15759",
  "#76b7b2",
  "#59a14f",
  "#edc948",
  "#b07aa1",
  "#ff9da7",
  "#9c755f",
  "#bab0ac",
];

// attach an xterm terminal to `el`, backed by the WebSocket at `wsUrl` (bytes
// both ways, JSON resize messages). Returns a dispose() that tears it all down.
// Shared by the floating TerminalPanel (/api/terminal) and TerminalDialog (/api/shell).

export const GRAPH_METRICS = [
  { id: "ok", label: "Passing builds", fmt: (v) => String(Math.round(v)) },
  { id: "warning", label: "Warning builds", fmt: (v) => String(Math.round(v)) },
  { id: "failed", label: "Failed builds", fmt: (v) => String(Math.round(v)) },
  {
    id: "tests",
    label: "Tests",
    fmt: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`),
  },
  {
    id: "assertions",
    label: "Assertions",
    fmt: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`),
  },
  { id: "avg_mem", label: "Avg memory", fmt: (v) => `${Math.round(v / 1024 / 1024)} MB` },
  { id: "max_mem", label: "Max memory", fmt: (v) => `${Math.round(v / 1024 / 1024)} MB` },
  {
    id: "time",
    label: "Test time",
    fmt: (v) => (v >= 60 ? `${Math.floor(v / 60)}m ${Math.round(v % 60)}s` : `${Math.round(v)}s`),
  },
];

export const NB_COUNT_METRICS = new Set(["ok", "warning", "failed"]);

export class NightlyScreen extends Component {
  static components = { Panel };
  static template = xml`
    <section class="nb-screen">
      <Panel title="'Nightly builds'">
        <t t-set-slot="top-right">
          <span class="meta" t-out="this.stamp"/>
          <button class="pbtn" t-att-class="{active: this.graphMode()}" t-on-click="() => this.toggleGraph()">
            <t t-out="this.graphIcon"/> Graph
          </button>
          <button class="pbtn" t-att-disabled="this.nightly.loading()" t-on-click="() => this.refresh()">
            <t t-out="this.refreshIcon"/> Refresh
          </button>
        </t>
      </Panel>
      <div class="content nb-content">
        <div t-if="this.nightly.loading() and !this.visibleNights.length" class="dim nb-status">Loading nightly build data…</div>
        <div t-elif="this.nightly.error()" class="dim nb-status">Failed to load: <t t-out="this.nightly.error()"/></div>
        <div t-elif="this.graphMode()" class="nb-graph-view">
          <div class="nb-graph-sidebar">
            <div class="nb-graph-group">
              <div class="nb-graph-label">Versions</div>
              <label class="nb-graph-check" t-foreach="this.nightly.versions()" t-as="v" t-key="v">
                <input type="checkbox" t-att-checked="this.graphVersionSel().has(v)" t-on-change="() => this.toggleGraphVersion(v)"/>
                <t t-out="this.shortVersion(v)"/>
              </label>
            </div>
            <div class="nb-graph-group">
              <div class="nb-graph-label">Series</div>
              <label class="nb-graph-check">
                <input type="checkbox" t-att-checked="this.graphShowCommunity()" t-on-change="ev => this.graphShowCommunity.set(ev.target.checked)"/>
                Community
              </label>
              <label class="nb-graph-check">
                <input type="checkbox" t-att-checked="this.graphShowEnterprise()" t-on-change="ev => this.graphShowEnterprise.set(ev.target.checked)"/>
                Enterprise
              </label>
            </div>
            <div class="nb-graph-group">
              <div class="nb-graph-label">Metrics</div>
              <label class="nb-graph-check" t-foreach="this.graphMetrics" t-as="gm" t-key="gm.id">
                <input type="checkbox" t-att-checked="this.graphMetricSel().has(gm.id)" t-on-change="() => this.toggleGraphMetric(gm.id)"/>
                <t t-out="gm.label"/>
              </label>
            </div>
          </div>
          <div class="nb-graph-main">
            <div t-if="!this.activeGraphMetrics.length" class="nb-graph-empty">Select at least one metric.</div>
            <t t-else="">
              <div class="nb-graph-chart" t-foreach="this.activeGraphMetrics" t-as="gm" t-key="gm.id">
                <div class="nb-graph-chart-title" t-out="gm.label"/>
                <canvas t-ref="this.chartRef(gm.id)"/>
              </div>
              <div t-if="this.graphNeedsDetailedMetrics" class="nb-graph-note dim">Older nights load on popover open.</div>
            </t>
            <div class="nb-graph-footer">
              <button class="pbtn" t-on-click="() => this.loadMoreGraphNights()">Load older nights</button>
            </div>
          </div>
        </div>
        <div t-elif="!this.visibleNights.length" class="dim nb-status">No nightly build data found.</div>
        <div t-else="" class="nb-grid-wrap">
          <table class="nb-table">
            <thead>
              <tr>
                <th class="nb-th-date">Night</th>
                <th t-foreach="this.nightly.versions()" t-as="v" t-key="v" class="nb-th-ver" t-att-title="v"><t t-out="this.shortVersion(v)"/></th>
              </tr>
            </thead>
            <tbody>
              <tr t-foreach="this.visibleNights" t-as="night" t-key="night.date">
                <td class="nb-td-date" t-out="night.date"/>
                <td t-foreach="this.nightly.versions()" t-as="v" t-key="v" class="nb-td-ver">
                  <div t-if="this.cellKinds(night, v)" class="nb-td-ver-stack">
                    <t t-foreach="this.cellKinds(night, v)" t-as="c" t-key="c.kind">
                      <button t-if="c.build" class="nb-build" t-att-class="this.badgeCls(c.build)"
                              t-on-click="ev => this.openPopover(ev, c.build.url, this.shortVersion(v) + ' ' + c.label + ' — ' + night.date)">
                        <span class="nb-letter" t-out="c.letter"/>
                        <t t-if="c.build.counts">
                          <span class="nb-ct nb-ct-ok" t-out="c.build.counts.ok"/>
                          <span class="nb-ct nb-ct-warn" t-out="c.build.counts.warning"/>
                          <span class="nb-ct nb-ct-fail" t-out="c.build.counts.failed"/>
                        </t>
                        <t t-else="">
                          <span class="nb-ct nb-ct-dim">?</span>
                          <span class="nb-ct nb-ct-dim">?</span>
                          <span class="nb-ct nb-ct-dim">?</span>
                        </t>
                      </button>
                      <span t-else="" class="nb-build nb-none">
                        <span class="nb-letter" t-out="c.letter"/>
                        <span class="nb-ct nb-ct-dim">—</span>
                        <span class="nb-ct nb-ct-dim">—</span>
                        <span class="nb-ct nb-ct-dim">—</span>
                      </span>
                    </t>
                  </div>
                  <span t-else="" class="nb-no-data">—</span>
                </td>
              </tr>
            </tbody>
          </table>
          <div class="nb-table-footer">
            <button class="pbtn" t-att-disabled="this.nightly.loading()" t-on-click="() => this.loadMoreNights()">
              <t t-out="this.nightly.loading() ? 'Loading…' : 'Load more'"/>
            </button>
          </div>
        </div>
      </div>

      <div t-if="this.popover()" class="nb-popover nb-popover-float"
           t-att-style="'top:' + this.popover().top + 'px; left:' + this.popover().left + 'px'">
        <div class="nb-pop-head">
          <span class="nb-pop-label" t-out="this.popover().label"/>
          <a class="nb-pop-ext" t-att-href="'https://runbot.odoo.com' + this.popover().url" target="_blank" rel="noopener" title="View this build on runbot"><t t-out="this.extIcon"/></a>
          <button class="nb-pop-btn" t-on-click="() => this.pin()"><t t-out="this.pinIcon"/></button>
        </div>
        <div t-if="this.popover().metrics.length" class="nb-pop-metrics">
          <t t-foreach="this.popover().metrics" t-as="m" t-key="m.suite">
            <div class="nb-pop-metric-row">
              <span class="nb-pop-metric-suite" t-out="m.label"/>
              <span class="nb-pop-metric-val" t-out="this.fmtMem(m.avg_mem)"/><span class="nb-pop-metric-lbl">avg</span>
              <span class="nb-pop-metric-sep">·</span>
              <span class="nb-pop-metric-val" t-out="this.fmtMem(m.max_mem)"/><span class="nb-pop-metric-lbl">max</span>
              <span class="nb-pop-metric-sep">·</span>
              <span class="nb-pop-metric-val" t-out="this.fmtTime(m.time)"/>
              <span class="nb-pop-metric-n" t-out="m.count + ' builds'"/>
            </div>
            <div t-if="m.tests != null" class="nb-pop-metric-row nb-pop-metric-row2">
              <span class="nb-pop-metric-suite"/>
              <span class="nb-pop-metric-val" t-out="m.tests"/><span class="nb-pop-metric-lbl">tests</span>
              <span class="nb-pop-metric-sep">·</span>
              <span class="nb-pop-metric-val" t-out="m.assertions"/><span class="nb-pop-metric-lbl">assertions</span>
            </div>
          </t>
        </div>
        <div class="nb-pop-body">
          <div t-if="this.popover().loading" class="nb-pop-info dim">Loading…</div>
          <div t-elif="this.popover().error" class="nb-pop-info dim">Failed: <t t-out="this.popover().error"/></div>
          <div t-elif="!this.popover().errors.length" class="nb-pop-info dim">No specific test failures found.</div>
          <ul t-else="" class="nb-pop-list">
            <li t-foreach="this.popover().errors" t-as="err" t-key="err_index"
                class="nb-pop-item" t-att-class="'nb-pop-' + err.status + (err.timeout ? ' nb-pop-timeout' : '')">
              <t t-out="err.timeout ? this.timeoutIcon : (err.status === 'danger' ? this.errIcon : this.warnIcon)"/>
              <span class="nb-pop-name" t-out="err.test_name"/>
              <span t-if="err.known || err.assignee" class="nb-pop-known" t-out="err.assignee || 'known'"/>
              <a class="nb-pop-link" t-att-href="'https://runbot.odoo.com' + err.url" target="_blank" rel="noopener"><t t-out="this.extIcon"/></a>
            </li>
          </ul>
        </div>
      </div>
      <div t-foreach="this.pinnedPopovers()" t-as="pp" t-key="pp.id" class="nb-popover nb-popover-pinned"
           t-att-style="'top:' + pp.top + 'px; left:' + pp.left + 'px'">
        <div class="nb-pop-drag nb-pop-head" t-on-mousedown="ev => this._startDrag(ev, pp.id)">
          <span class="nb-pop-label" t-out="pp.label"/>
          <a class="nb-pop-ext" t-att-href="'https://runbot.odoo.com' + pp.url" target="_blank" rel="noopener" title="View this build on runbot"><t t-out="this.extIcon"/></a>
          <button class="nb-pop-btn" t-on-click="() => this.unpin(pp.id)"><t t-out="this.closeIcon"/></button>
        </div>
        <div t-if="pp.metrics.length" class="nb-pop-metrics">
          <t t-foreach="pp.metrics" t-as="m" t-key="m.suite">
            <div class="nb-pop-metric-row">
              <span class="nb-pop-metric-suite" t-out="m.label"/>
              <span class="nb-pop-metric-val" t-out="this.fmtMem(m.avg_mem)"/><span class="nb-pop-metric-lbl">avg</span>
              <span class="nb-pop-metric-sep">·</span>
              <span class="nb-pop-metric-val" t-out="this.fmtMem(m.max_mem)"/><span class="nb-pop-metric-lbl">max</span>
              <span class="nb-pop-metric-sep">·</span>
              <span class="nb-pop-metric-val" t-out="this.fmtTime(m.time)"/>
              <span class="nb-pop-metric-n" t-out="m.count + ' builds'"/>
            </div>
            <div t-if="m.tests != null" class="nb-pop-metric-row nb-pop-metric-row2">
              <span class="nb-pop-metric-suite"/>
              <span class="nb-pop-metric-val" t-out="m.tests"/><span class="nb-pop-metric-lbl">tests</span>
              <span class="nb-pop-metric-sep">·</span>
              <span class="nb-pop-metric-val" t-out="m.assertions"/><span class="nb-pop-metric-lbl">assertions</span>
            </div>
          </t>
        </div>
        <div class="nb-pop-body">
          <div t-if="pp.loading" class="nb-pop-info dim">Loading…</div>
          <div t-elif="pp.error" class="nb-pop-info dim">Failed: <t t-out="pp.error"/></div>
          <div t-elif="!pp.errors.length" class="nb-pop-info dim">No specific test failures found.</div>
          <ul t-else="" class="nb-pop-list">
            <li t-foreach="pp.errors" t-as="err" t-key="err_index"
                class="nb-pop-item" t-att-class="'nb-pop-' + err.status + (err.timeout ? ' nb-pop-timeout' : '')">
              <t t-out="err.timeout ? this.timeoutIcon : (err.status === 'danger' ? this.errIcon : this.warnIcon)"/>
              <span class="nb-pop-name" t-out="err.test_name"/>
              <span t-if="err.known || err.assignee" class="nb-pop-known" t-out="err.assignee || 'known'"/>
              <a class="nb-pop-link" t-att-href="'https://runbot.odoo.com' + err.url" target="_blank" rel="noopener"><t t-out="this.extIcon"/></a>
            </li>
          </ul>
        </div>
      </div>
    </section>`;

  nightly = usePlugin(NightlyPlugin);
  graphMetrics = GRAPH_METRICS;

  refreshIcon = m(ICONS.refresh);
  // self-contained (explicit size/fill), unlike ICONS.external which relies on
  // ambient CSS (e.g. .nav-item svg) that doesn't reach the popover
  extIcon = m(
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><path d="M7 17 17 7M9 7h8v8"/></svg>`,
  );

  graphIcon = m(
    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="1,13 5,7 9,10 15,3"/><line x1="1" y1="15" x2="15" y2="15"/></svg>`,
  );

  errIcon = m(
    `<svg viewBox="0 0 12 12" fill="currentColor" width="12" height="12"><path d="M6 1a5 5 0 1 0 0 10A5 5 0 0 0 6 1zm.75 7.5h-1.5V7h1.5v1.5zm0-3h-1.5v-3h1.5v3z"/></svg>`,
  );

  warnIcon = m(
    `<svg viewBox="0 0 12 12" fill="currentColor" width="12" height="12"><path d="M6 .5.5 11h11L6 .5zm-.75 4h1.5v3H5.25v-3zm0 4h1.5v1.5H5.25V8.5z"/></svg>`,
  );

  timeoutIcon = m(
    `<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M6 2v6l4 4-4 4v6h12v-6l-4-4 4-4V2H6zm10 14.5V20H8v-3.5l4-4 4 4zm-4-5-4-4V4h8v3.5l-4 4z"/></svg>`,
  );

  pinIcon = m(
    `<svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M4.146 14.354a.5.5 0 0 0 .708 0L8 11.207l3.146 3.147a.5.5 0 0 0 .708-.708L8.707 10.5l2.647-2.646A3 3 0 0 0 12 5.5V2h.5a.5.5 0 0 0 0-1h-9a.5.5 0 0 0 0 1H4v3.5a3 3 0 0 0 .646 1.854L7.293 10.5l-3.147 3.146a.5.5 0 0 0 0 .708z"/></svg>`,
  );

  closeIcon = m(
    `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" width="12" height="12"><path d="M1 1l10 10M11 1L1 11"/></svg>`,
  );

  popover = signal(null);
  pinnedPopovers = signal([]);
  _badgeRect = null;
  _drag = null;

  graphMode = signal(false);
  graphVersionSel = signal(new Set());
  graphShowCommunity = signal(true);
  graphShowEnterprise = signal(true);
  graphMetricSel = signal(new Set());
  graphCacheBust = signal(0); // bumped to force the chart-sync effect to re-run
  chartJsReady = signal(false);
  _charts = new Map(); // metric id -> live Chart.js instance
  _chartRefs = new Map(); // metric id -> signal.ref()

  setup() {
    this.nightly.load().then(() => this._checkFreshness());
    loadChartJs()
      .then(() => this.chartJsReady.set(true))
      .catch(() => {});
    document.addEventListener("click", this._closePopover);
    document.addEventListener("keydown", this._onKey);
    document.addEventListener("mousemove", this._onMouseMove);
    document.addEventListener("mouseup", this._onMouseUp);
    onWillUnmount(() => {
      document.removeEventListener("click", this._closePopover);
      document.removeEventListener("keydown", this._onKey);
      document.removeEventListener("mousemove", this._onMouseMove);
      document.removeEventListener("mouseup", this._onMouseUp);
      for (const chart of this._charts.values()) chart.destroy();
      this._charts.clear();
    });
    // keeps every active metric's Chart.js instance in sync with the current
    // selection/data; useEffect has no deps array, it just re-runs whenever a
    // signal read inside it changes (graphMode, the version/metric/series
    // selections, the fetched nights, or graphCacheBust after a popover load)
    useEffect(() => {
      const metrics = this.graphMode() ? this.activeGraphMetrics : [];
      const activeIds = new Set(metrics.map((gm) => gm.id));
      for (const [id, chart] of this._charts) {
        if (!activeIds.has(id)) {
          chart.destroy();
          this._charts.delete(id);
        }
      }
      if (!this.chartJsReady() || !metrics.length) return;
      for (const gm of metrics) {
        const canvas = this.chartRef(gm.id)();
        if (!canvas) continue;
        const { labels, datasets } = this._chartData(gm);
        let chart = this._charts.get(gm.id);
        if (chart) {
          chart.data.labels = labels;
          chart.data.datasets = datasets;
          chart.update();
        } else {
          this._charts.set(
            gm.id,
            new window.Chart(canvas, this._chartConfig(gm, labels, datasets)),
          );
        }
      }
    });
  }

  _closePopover = (ev) => {
    if (this.popover() && !ev.target.closest(".nb-popover-float, .nb-build"))
      this.popover.set(null);
  };

  _onKey = (ev) => {
    if (ev.key === "Escape") this.popover.set(null);
  };

  _startDrag = (ev, id) => {
    const p = this.pinnedPopovers().find((pp) => pp.id === id);
    if (!p) return;
    this._drag = { id, offsetX: ev.clientX - p.left, offsetY: ev.clientY - p.top };
  };

  _onMouseMove = (ev) => {
    if (!this._drag) return;
    const { id, offsetX, offsetY } = this._drag;
    this.pinnedPopovers.set(
      this.pinnedPopovers().map((p) =>
        p.id === id ? { ...p, left: ev.clientX - offsetX, top: ev.clientY - offsetY } : p,
      ),
    );
  };

  _onMouseUp = () => {
    this._drag = null;
  };

  _checkFreshness() {
    const nights = this.nightly.nights();
    if (!nights.length) return;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (new Date(nights[0].date) < yesterday) this.nightly.load(true, 7);
  }

  _clampPopover() {
    const el = document.querySelector(".nb-popover-float");
    const p = this.popover();
    if (!el || !p) return;
    const rect = el.getBoundingClientRect();
    let { top, left } = p;
    if (rect.right > window.innerWidth) left -= rect.right - window.innerWidth + 8;
    if (left < 8) left = 8;
    if (rect.bottom > window.innerHeight) top = (this._badgeRect?.top || top) - rect.height - 6;
    if (top < 8) top = 8;
    if (top !== p.top || left !== p.left) this.popover.set({ ...p, top, left });
  }

  pin() {
    const p = this.popover();
    if (!p) return;
    this.pinnedPopovers.set([...this.pinnedPopovers(), { ...p, id: `${p.url}:${Date.now()}` }]);
    this.popover.set(null);
  }

  unpin(id) {
    this.pinnedPopovers.set(this.pinnedPopovers().filter((p) => p.id !== id));
  }

  async openPopover(ev, url, label) {
    ev.stopPropagation();
    if (this.popover()?.url === url) {
      this.popover.set(null);
      return;
    }
    const rect = ev.currentTarget.getBoundingClientRect();
    this._badgeRect = rect;
    this.popover.set({
      url,
      label,
      top: rect.bottom + 4,
      left: rect.left,
      errors: [],
      metrics: [],
      loading: true,
      error: "",
    });
    requestAnimationFrame(() => this._clampPopover());
    try {
      const res = await this.nightly.fetchErrors(url);
      const patch = {
        errors: res.errors,
        metrics: this._buildMetrics(res.metrics),
        loading: false,
        error: "",
      };
      if (this.popover()?.url === url) this.popover.set({ ...this.popover(), ...patch });
      this.pinnedPopovers.set(
        this.pinnedPopovers().map((p) => (p.url === url ? { ...p, ...patch } : p)),
      );
    } catch (e) {
      if (this.popover()?.url === url)
        this.popover.set({ ...this.popover(), loading: false, error: e.message });
    } finally {
      this.graphCacheBust.set(this.graphCacheBust() + 1);
    }
  }

  _buildMetrics(raw) {
    const entries = Object.entries(raw || {}).map(([suite, metric]) => ({
      suite,
      label: suite.toLowerCase().includes("mobile") ? "Mobile" : "Desktop",
      ...metric,
    }));
    entries.sort((a, b) => (a.label === b.label ? 0 : a.label === "Desktop" ? -1 : 1));
    return entries;
  }

  fmtMem(bytes) {
    return bytes == null ? "" : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  fmtTime(sec) {
    if (sec == null) return "";
    const mins = Math.floor(sec / 60);
    return mins ? `${mins}m ${Math.round(sec % 60)}s` : `${Math.round(sec)}s`;
  }

  get visibleNights() {
    return this.nightly.nights();
  }

  refresh() {
    this.nightly.load(true, 7);
  }

  loadMoreNights() {
    this.nightly.load(false, this.nightly.nights().length + 7);
  }

  get stamp() {
    if (this.nightly.loading()) return "loading…";
    if (!this.nightly.at()) return "";
    const secs = Math.floor((Date.now() - this.nightly.at()) / 1000);
    if (secs < 5) return "just loaded";
    if (secs < 60) return `loaded ${secs}s ago`;
    return `loaded ${Math.floor(secs / 60)}m ago`;
  }

  statusCls(status) {
    if (status === "success") return "nb-ok";
    if (status === "warning") return "nb-warn";
    if (status === "danger") return "nb-fail";
    if (status === "info") return "nb-run";
    return "nb-none";
  }

  badgeCls(b) {
    return this.nightly.timeoutUrls().has(b.url) ? "nb-timeout" : this.statusCls(b.status);
  }

  shortVersion(v) {
    return v.startsWith("saas-") ? v.slice(5) : v;
  }

  cellKinds(night, v) {
    const vdata = night.versions[v];
    if (!vdata) return null;
    return [
      { kind: "community", letter: "C", label: "Community", build: vdata.community || null },
      { kind: "enterprise", letter: "E", label: "Enterprise", build: vdata.enterprise || null },
    ];
  }

  // ── graph mode ─────────────────────────────────────────────────────────

  toggleGraph() {
    const next = !this.graphMode();
    this.graphMode.set(next);
    if (next) {
      if (!this.graphVersionSel().size) this.graphVersionSel.set(new Set(["master"]));
      this._loadRecentGraphData();
    }
  }

  toggleGraphVersion(v) {
    const s = new Set(this.graphVersionSel());
    if (s.has(v)) s.delete(v);
    else s.add(v);
    this.graphVersionSel.set(s);
  }

  toggleGraphMetric(id) {
    const s = new Set(this.graphMetricSel());
    if (s.has(id)) s.delete(id);
    else s.add(id);
    this.graphMetricSel.set(s);
  }

  get activeGraphMetrics() {
    return GRAPH_METRICS.filter((gm) => this.graphMetricSel().has(gm.id));
  }

  get graphNeedsDetailedMetrics() {
    return this.activeGraphMetrics.some((gm) => !NB_COUNT_METRICS.has(gm.id));
  }

  chartRef(id) {
    if (!this._chartRefs.has(id)) this._chartRefs.set(id, signal.ref());
    return this._chartRefs.get(id);
  }

  async _loadRecentGraphData() {
    await this._loadGraphData(this.nightly.nights().slice(0, 7));
  }

  async loadMoreGraphNights() {
    const prevCount = this.nightly.nights().length;
    await this.nightly.load(false, prevCount + 7);
    await this._loadGraphData(this.nightly.nights().slice(prevCount));
  }

  async _loadGraphData(nights) {
    const urls = new Set();
    for (const night of nights) {
      for (const vdata of Object.values(night.versions || {})) {
        for (const kind of ["community", "enterprise"]) {
          const b = vdata[kind];
          if (b && !this.nightly._errorsCache.has(b.url)) urls.add(b.url);
        }
      }
    }
    const queue = [...urls];
    const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
      let url;
      while ((url = queue.pop()) !== undefined) {
        await this.nightly.fetchErrors(url).catch(() => {});
        this.graphCacheBust.set(this.graphCacheBust() + 1);
      }
    });
    await Promise.all(workers);
  }

  _getMetricValue(metricId, build) {
    if (NB_COUNT_METRICS.has(metricId)) return build.counts ? build.counts[metricId] : null;
    const agg = this._aggregateMetricsForBuild(build.url);
    return agg ? agg[metricId] : null;
  }

  _aggregateMetricsForBuild(url) {
    const cached = this.nightly._errorsCache.get(url);
    const suites = cached ? Object.values(cached.metrics || {}) : [];
    if (!suites.length) return null;
    return {
      tests: suites.reduce((s, m) => s + (m.tests || 0), 0),
      assertions: suites.reduce((s, m) => s + (m.assertions || 0), 0),
      time: suites.reduce((s, m) => s + (m.time || 0), 0),
      avg_mem: suites.reduce((s, m) => s + m.avg_mem, 0) / suites.length,
      max_mem: Math.max(...suites.map((m) => m.max_mem)),
    };
  }

  _chartData(gm) {
    const nights = [...this.nightly.nights()].reverse(); // chronological
    const labels = nights.map((n) => n.date.slice(5));
    const datasets = [];
    this.nightly.versions().forEach((v, vi) => {
      if (!this.graphVersionSel().has(v)) return;
      const color = CHART_COLORS[vi % CHART_COLORS.length];
      for (const [kind, enabled, dash, label] of [
        ["community", this.graphShowCommunity(), [], "Community"],
        ["enterprise", this.graphShowEnterprise(), [5, 3], "Enterprise"],
      ]) {
        if (!enabled) continue;
        const data = nights.map((n) => {
          const b = (n.versions[v] || {})[kind];
          return b ? this._getMetricValue(gm.id, b) : null;
        });
        if (data.every((d) => d == null)) continue;
        datasets.push({
          label: `${this.shortVersion(v)} ${label}`,
          data,
          borderColor: color,
          backgroundColor: color,
          borderDash: dash,
          borderWidth: 1.5,
          pointRadius: 2,
          spanGaps: false,
          tension: 0,
        });
      }
    });
    return { labels, datasets };
  }

  _chartConfig(gm, labels, datasets) {
    return {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        animation: false,
        plugins: {
          legend: { position: "top", labels: { boxWidth: 20, font: { size: 10 } } },
          tooltip: {
            callbacks: { label: (ctx) => `${ctx.dataset.label}: ${gm.fmt(ctx.parsed.y)}` },
          },
        },
        scales: {
          x: { ticks: { maxRotation: 90, font: { size: 9 } } },
          y: { title: { display: true, text: gm.label }, ticks: { callback: (v) => gm.fmt(v) } },
        },
      },
    };
  }
}

// ─────────────────────────── Memory ───────────────────────────
