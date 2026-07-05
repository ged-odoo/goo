import { Component, onPatched, onWillUnmount, plugin, signal, xml } from "@odoo/owl";
import { MemoryPlugin } from "../plugins/memory_plugin.js";
import { ICONS, m } from "./common.js";
import { CHART_COLORS, CHART_ZOOM_OPTIONS, loadChartJs } from "./nightly.js";

export class MemoryScreen extends Component {
  static template = xml`
    <section class="mem-screen">
      <div class="panel">
        <div class="panel-top"><h1>Memory</h1></div>
        <div class="panel-actions">
          <button class="pbtn primary" t-att-disabled="this.memory.loading() || !this.hasUrls()" t-on-click="() => this.draw()">
            <t t-out="this.memory.loading() ? 'Loading…' : 'Draw graph'"/>
          </button>
          <label class="toggle" t-att-class="{on: this.memory.withMobile()}" t-on-click="() => this.toggleMobile()">
            <span class="switch"/> With mobile
          </label>
          <span t-if="this.memory.error()" class="form-error" t-out="this.memory.error()"/>
        </div>
      </div>
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
                <input type="text" class="mem-url-input" placeholder="log URL (e.g. https://runbot…/logs/test_only.txt)"
                       t-att-value="b.url" t-on-input="ev => this.memory.updateBuild(b_index, 'url', ev.target.value)"/>
                <button class="drop-btn" t-on-click="() => this.memory.removeBuild(b_index)">✕</button>
              </div>
              <button class="pbtn" t-on-click="() => this.addBuild()">Add build</button>
            </div>
          </t>
        </div>
        <div class="mem-chart-wrap">
          <div t-if="!this.memory.data().length &amp;&amp; !this.memory.loading() &amp;&amp; !this.memory.error()" class="dim mem-hint">
            Enter one or more build log URLs on the left and click "Draw graph".
          </div>
          <div t-if="this.memory.data().length" class="mem-chart-hint dim">Scroll to zoom · shift-drag to zoom a range · double-click to reset</div>
          <canvas t-ref="this.canvas" t-on-dblclick="() => this.resetZoom()"/>
        </div>
      </div>
    </section>`;

  memory = plugin(MemoryPlugin);
  canvas = signal.ref(HTMLElement);
  chevronIcon = m(ICONS.chevron);
  _chart = null;
  _focusRowIndex = -1; // index to focus on the next patch, once its DOM exists
  sidebarCollapsed = signal(false);

  setup() {
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

  hasUrls() {
    return this.memory.builds().some((b) => b.url.trim());
  }

  toggleSidebar() {
    this.sidebarCollapsed.set(!this.sidebarCollapsed());
  }

  _focusRow(idx) {
    const rows = document.querySelectorAll(".mem-build-row .mem-label-input");
    rows[idx]?.focus();
  }

  addBuild() {
    const builds = this.memory.builds();
    const emptyIdx = builds.findIndex((b) => !b.label.trim() && !b.url.trim());
    if (emptyIdx !== -1) {
      // an empty row already exists (e.g. the initial placeholder) — reuse it
      // instead of piling up another one; its DOM is already there, so focus now
      this._focusRow(emptyIdx);
      return;
    }
    this.memory.addBuild();
    this._focusRowIndex = builds.length; // the new row lands right after the old ones
  }

  toggleMobile() {
    this.memory.withMobile.set(!this.memory.withMobile());
  }

  async fetchBatch() {
    await this.memory.fetchBatch();
  }

  onBatchKeydown(ev) {
    if (ev.key === "Enter") this.fetchBatch();
  }

  async draw() {
    await this.memory.load();
    this._redraw();
  }

  _redraw() {
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
      data: data.map((d) =>
        d[build] != null ? Math.round((d[build] / 1024 / 1024) * 100) / 100 : null,
      ),
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
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y} MB` } },
          zoom: CHART_ZOOM_OPTIONS,
        },
        scales: {
          x: { ticks: { maxRotation: 90, font: { size: 10 } } },
          y: { title: { display: true, text: "Memory (MB after GC)" } },
        },
      },
    });
  }

  resetZoom() {
    this._chart?.resetZoom();
  }
}

// ─────────────────────────── Root ───────────────────────────
