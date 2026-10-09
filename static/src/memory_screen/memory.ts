import { Component, onPatched, onWillUnmount, usePlugin, signal, xml } from "@odoo/owl";
import { MemoryPlugin } from "./memory_plugin.ts";
import { ICONS, loadScript, m } from "../core/common.ts";
import { Panel } from "../core/panel.ts";

// lazy-load Chart.js + its zoom/pan plugin (both vendored, not a CDN) on first
// use. Wheel-zooms and drag-pans; no pinch (that needs hammer.js too, and this
// is a desktop dev tool).
let _chartJsReady: Promise<void> | null = null;

function loadChartJs(): Promise<void> {
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

// options.plugins.zoom config: wheel-zoom + drag-to-pan, double-click to reset
const CHART_ZOOM_OPTIONS = {
  pan: { enabled: true, mode: "x" },
  zoom: {
    wheel: { enabled: true },
    drag: { enabled: true, modifierKey: "shift" },
    mode: "x",
  },
};

// categorical palette for the Chart.js datasets (Tableau-10-ish)
const CHART_COLORS = [
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

// the slice of a Chart.js instance this screen touches (window.Chart itself is untyped)
interface MemoryChart {
  destroy(): void;
  resetZoom(): void;
}

// the tooltip context Chart.js passes the label callback (the fields read here)
interface TooltipContext {
  dataset: { label: string };
  parsed: { y: number };
}

export class MemoryScreen extends Component {
  static components = { Panel };
  static template = xml`
    <section class="mem-screen">
      <Panel title="'Memory'">
        <t t-set-slot="title-extra">
          <div class="panel-inline-actions">
            <button class="pbtn primary" t-att-disabled="this.memory.loading() || !this.hasUrls()" t-on-click="() => this.draw()">
              <t t-out="this.memory.loading() ? 'Loading…' : 'Draw graph'"/>
            </button>
            <label class="toggle" t-att-class="{on: this.memory.withMobile()}" t-on-click="() => this.toggleMobile()">
              <span class="switch"/> With mobile
            </label>
            <span t-if="this.memory.error()" class="form-error" t-out="this.memory.error()"/>
          </div>
        </t>
      </Panel>
      <div class="content mem-content">
        <div class="mem-sidebar" t-att-class="{collapsed: this.sidebarCollapsed()}">
          <button class="mem-sidebar-toggle" t-att-class="{collapsed: this.sidebarCollapsed()}"
                  t-att-title="this.sidebarCollapsed() ? 'Show build list' : 'Hide build list'"
                  t-on-click="() => this.toggleSidebar()">
            <t t-out="this.chevronIcon"/>
          </button>
          <t t-if="!this.sidebarCollapsed()">
            <div class="mem-batch-section">
              <div class="mem-batch-input-row">
                <input type="text" class="mem-url-input" placeholder="batch URL, e.g. https://runbot.odoo.com/runbot/batch/1/build/1"
                       t-att-value="this.memory.batchUrl()" t-on-input="ev => this.memory.setBatchUrl(ev.target.value)"
                       t-on-keydown="ev => this.onBatchKeydown(ev)"/>
                <button class="pbtn" t-att-disabled="!this.memory.batchUrl().trim() || this.memory.batchLoading()" t-on-click="() => this.fetchBatch()">
                  <t t-out="this.memory.batchLoading() ? 'Fetching…' : 'Fetch builds'"/>
                </button>
              </div>
              <span t-if="this.memory.batchError()" class="form-error" t-out="this.memory.batchError()"/>
            </div>
            <div class="mem-builds">
              <div class="mem-build-row" t-foreach="this.memory.builds()" t-as="b" t-key="b_index">
                <input type="text" class="mem-label-input" placeholder="label (e.g. master)"
                       t-att-value="b.label" t-on-input="ev => this.memory.updateBuild(b_index, 'label', ev.target.value)"/>
                <input t-if="!b.fileName" type="text" class="mem-url-input" placeholder="log URL (e.g. https://runbot…/logs/test_only.txt)"
                       t-att-value="b.url" t-on-input="ev => this.memory.updateBuild(b_index, 'url', ev.target.value)"/>
                <span t-if="b.fileName" class="mem-file-chip" t-att-class="{stale: !b.content}"
                      t-att-title="b.content ? b.fileName : b.fileName + ' — content lost on reload, please re-upload'">
                  <t t-out="b.fileName"/>
                  <button type="button" class="mem-file-clear" title="Remove file" t-on-click="() => this.memory.clearBuildFile(b_index)">✕</button>
                </span>
                <label class="mem-upload-btn" title="Upload log file from disk">
                  <t t-out="this.uploadIcon"/>
                  <input type="file" class="mem-file-input" accept=".txt,.log,text/plain"
                         t-on-change="ev => this.onFilePicked(b_index, ev)"/>
                </label>
                <button class="drop-btn" t-on-click="() => this.memory.removeBuild(b_index)">✕</button>
              </div>
              <button class="pbtn" t-on-click="() => this.addBuild()">Add build</button>
            </div>
          </t>
        </div>
        <div class="mem-chart-wrap">
          <div t-if="!this.memory.data().length &amp;&amp; !this.memory.loading() &amp;&amp; !this.memory.error()" class="dim mem-hint">
            Enter build log URLs or upload log files on the left, then click "Draw graph".
          </div>
          <div t-if="this.memory.data().length" class="mem-chart-hint dim">Scroll to zoom · shift-drag to zoom a range · double-click to reset</div>
          <canvas t-ref="this.canvas" t-on-dblclick="() => this.resetZoom()"/>
        </div>
      </div>
    </section>`;

  memory = usePlugin(MemoryPlugin);
  canvas = signal.ref(HTMLElement);
  chevronIcon = m(ICONS.chevron);
  uploadIcon = m(ICONS.push);
  _chart: MemoryChart | null = null;
  _focusRowIndex = -1; // index to focus on the next patch, once its DOM exists
  sidebarCollapsed = signal(false);

  setup(): void {
    loadChartJs()
      .then(() => this._redraw())
      .catch(() => {});
    onWillUnmount(() => {
      if (this._chart) this._chart.destroy();
    });
    // onPatched runs after the DOM reflects the new row (a signal.set()'s effect
    // isn't visible in the DOM yet at the point addBuild() returns, so focusing
    // straight away — even via requestAnimationFrame — can hit the previous
    // last row instead of the one just added)
    onPatched(() => {
      if (this._focusRowIndex < 0) return;
      const idx = this._focusRowIndex;
      this._focusRowIndex = -1;
      this._focusRow(idx);
    });
  }

  hasUrls(): boolean {
    return this.memory.builds().some((b) => b.url.trim() || b.content);
  }

  toggleSidebar(): void {
    this.sidebarCollapsed.set(!this.sidebarCollapsed());
  }

  _focusRow(idx: number): void {
    const rows = document.querySelectorAll<HTMLInputElement>(".mem-build-row .mem-label-input");
    rows[idx]?.focus();
  }

  addBuild(): void {
    const builds = this.memory.builds();
    const emptyIdx = builds.findIndex((b) => !b.label.trim() && !b.url.trim() && !b.fileName);
    if (emptyIdx !== -1) {
      // an empty row already exists (e.g. the initial placeholder) — reuse it
      // instead of piling up another one; its DOM is already there, so focus now
      this._focusRow(emptyIdx);
      return;
    }
    this.memory.addBuild();
    this._focusRowIndex = builds.length; // the new row lands right after the old ones
  }

  onFilePicked(idx: number, ev: Event): void {
    const input = ev.target as HTMLInputElement; // the row's <input type="file">
    const file = input.files?.[0];
    input.value = ""; // allow re-picking the same file later
    if (!file) return;
    const reader = new FileReader();
    // readAsText() below: the result is the file's text
    reader.onload = () => this.memory.setBuildFile(idx, file.name, reader.result as string);
    reader.readAsText(file);
  }

  toggleMobile(): void {
    this.memory.withMobile.set(!this.memory.withMobile());
  }

  async fetchBatch(): Promise<void> {
    await this.memory.fetchBatch();
  }

  onBatchKeydown(ev: KeyboardEvent): void {
    if (ev.key === "Enter") this.fetchBatch();
  }

  async draw(): Promise<void> {
    await this.memory.load();
    this._redraw();
  }

  _redraw(): void {
    if (!window.Chart || !this.canvas()) return;
    if (this._chart) {
      this._chart.destroy();
      this._chart = null;
    }
    const data = this.memory.data();
    if (!data.length) return;
    const builds = Object.keys(data[0]).filter((k) => k !== "suite");
    const datasets = builds.map((build, i) => ({
      label: build,
      data: data.map((d) => {
        const used = d[build] as number | undefined; // every key but "suite" is a build's used bytes
        return used != null ? Math.round((used / 1024 / 1024) * 100) / 100 : null;
      }),
      borderColor: CHART_COLORS[i % CHART_COLORS.length],
      backgroundColor: CHART_COLORS[i % CHART_COLORS.length] + "33",
      borderWidth: 1.5,
      pointRadius: 1.5,
      spanGaps: false,
    }));
    this._chart = new window.Chart(this.canvas(), {
      type: "line",
      data: { labels: data.map((d) => d.suite), datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { position: "top" },
          tooltip: {
            callbacks: {
              label: (ctx: TooltipContext) => `${ctx.dataset.label}: ${ctx.parsed.y} MB`,
            },
          },
          zoom: CHART_ZOOM_OPTIONS,
        },
        scales: {
          x: { ticks: { maxRotation: 90, font: { size: 10 } } },
          y: { title: { display: true, text: "Memory (MB after GC)" } },
        },
      },
    });
  }

  resetZoom(): void {
    this._chart?.resetZoom();
  }
}
