// A tiny stand-in for the Chart.js global (window.Chart): it records the canvas and
// config each chart is built with, plus update/destroy/resetZoom calls, so a test can
// assert goo's labels and datasets rather than pixels. `installFakeChart()` must run
// before the screen mounts — loadChartJs() skips the <script> load once window.Chart
// (and window.ChartZoom) exist, which jsdom could never actually load.
import { vi } from "vitest";

interface ChartConfig {
  type: string;
  data: { labels: string[]; datasets: { label: string; data: unknown[] }[] };
  options: Record<string, unknown>;
}

export class FakeChart {
  static instances: FakeChart[] = [];
  static register = vi.fn();
  canvas: unknown;
  config: ChartConfig;
  data: ChartConfig["data"];
  updates = 0;
  destroyed = false;
  zoomResets = 0;

  constructor(canvas: unknown, config: ChartConfig) {
    this.canvas = canvas;
    this.config = config;
    this.data = config.data;
    FakeChart.instances.push(this);
  }

  update(): void {
    this.updates++;
  }

  destroy(): void {
    this.destroyed = true;
  }

  resetZoom(): void {
    this.zoomResets++;
  }
}

export function installFakeChart(): typeof FakeChart {
  FakeChart.instances = [];
  // a plain constructor function (not the class itself), as the UMD build exposes it
  function Chart(canvas: unknown, config: ChartConfig): FakeChart {
    return new FakeChart(canvas, config);
  }
  Chart.register = FakeChart.register;
  vi.stubGlobal("Chart", Chart);
  vi.stubGlobal("ChartZoom", {});
  return FakeChart;
}

// the charts still alive (not destroyed)
export const liveCharts = (): FakeChart[] => FakeChart.instances.filter((c) => !c.destroyed);
