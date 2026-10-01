import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApp, type MountedApp, type Route } from "../helpers/app.ts";
import { installFakeChart, liveCharts } from "../helpers/chart_fixtures.ts";

const MB = 1024 * 1024;
const DATA = {
  data: [
    { suite: "web", master: 100 * MB, "18.0": 90 * MB },
    { suite: "mail", master: 150.555 * MB },
  ],
};

let app: MountedApp;
// (a block body: a function returned from beforeEach would be run as its teardown)
beforeEach(() => {
  installFakeChart();
});
afterEach(() => app?.destroy());

const mount = (routes: Record<string, Route> = {}) =>
  mountApp({ section: "memory", routes: { "/api/memory/fetch": DATA, ...routes } });

const text = (e: Element | null | undefined): string => e?.textContent?.trim() ?? "";
const button = (label: string): HTMLButtonElement =>
  [...app.root.querySelectorAll<HTMLButtonElement>("button")].find((b) => text(b) === label)!;
const buildRows = (): HTMLElement[] => [
  ...app.root.querySelectorAll<HTMLElement>(".mem-build-row"),
];
async function type(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value;
  input.dispatchEvent(new Event("input"));
  await app.settle();
}
async function click(el: Element): Promise<void> {
  (el as HTMLElement).click();
  await app.settle();
}

describe("Memory screen", () => {
  it("starts with one empty build row and Draw disabled", async () => {
    app = await mount();
    expect(text(app.root.querySelector("h1"))).toBe("Memory");
    expect(buildRows()).toHaveLength(1);
    expect(button("Draw graph").disabled).toBe(true);
    expect(text(app.root.querySelector(".mem-hint"))).toContain('click "Draw graph"');
  });

  it("draws the per-suite memory graph from the fetched logs", async () => {
    app = await mount();
    const [row] = buildRows();
    await type(row.querySelector<HTMLInputElement>(".mem-label-input")!, "master");
    await type(row.querySelector<HTMLInputElement>(".mem-url-input")!, "https://runbot/logs/a.txt");
    // "With mobile" toggle is sent along
    await click(app.root.querySelector(".toggle")!);
    expect(app.root.querySelector(".toggle.on")).not.toBeNull();
    await click(button("Draw graph"));
    expect(app.callsTo("/api/memory/fetch")[0].body).toEqual({
      builds: [{ label: "master", url: "https://runbot/logs/a.txt" }],
      with_mobile: true,
    });
    const [chart] = liveCharts();
    expect(chart.data.labels).toEqual(["web", "mail"]);
    expect(chart.data.datasets.map((d) => [d.label, d.data])).toEqual([
      ["master", [100, 150.56]],
      ["18.0", [90, null]],
    ]);
    const tooltip = (
      chart.config.options.plugins as {
        tooltip: { callbacks: { label: (c: unknown) => string } };
      }
    ).tooltip;
    expect(tooltip.callbacks.label({ dataset: { label: "master" }, parsed: { y: 100 } })).toBe(
      "master: 100 MB",
    );
    expect(text(app.root.querySelector(".mem-chart-hint"))).toContain("double-click to reset");

    // double-click resets the zoom; redrawing replaces the chart
    app.root.querySelector("canvas")!.dispatchEvent(new MouseEvent("dblclick"));
    expect(chart.zoomResets).toBe(1);
    await click(button("Draw graph"));
    expect(chart.destroyed).toBe(true);
    expect(liveCharts()).toHaveLength(1);
  });

  it("shows a fetch error", async () => {
    app = await mount({
      "/api/memory/fetch": () =>
        new Response(JSON.stringify({ ok: false, error: "log not found" }), { status: 404 }),
    });
    await type(buildRows()[0].querySelector<HTMLInputElement>(".mem-url-input")!, "https://x/log");
    await click(button("Draw graph"));
    expect(text(app.root.querySelector(".panel-inline-actions .form-error"))).toBe("log not found");
    expect(liveCharts()).toHaveLength(0);
  });

  it("adds builds (reusing an empty row) and removes them", async () => {
    app = await mount();
    await click(button("Add build")); // the empty placeholder is reused
    expect(buildRows()).toHaveLength(1);
    expect(document.activeElement).toBe(buildRows()[0].querySelector(".mem-label-input"));
    await type(buildRows()[0].querySelector<HTMLInputElement>(".mem-label-input")!, "a");
    await click(button("Add build"));
    expect(buildRows()).toHaveLength(2);
    expect(document.activeElement).toBe(buildRows()[1].querySelector(".mem-label-input"));
    await click(buildRows()[0].querySelector(".drop-btn")!);
    expect(buildRows()).toHaveLength(1);
    expect(buildRows()[0].querySelector<HTMLInputElement>(".mem-label-input")!.value).toBe("");
  });

  it("fetches a batch's builds into the list (Enter or the button)", async () => {
    app = await mount({
      "/api/memory/batch": (body: unknown) =>
        (body as { url: string }).url.includes("empty")
          ? { builds: [] }
          : {
              builds: [
                { label: "community", url: "https://runbot/c.txt" },
                { label: "enterprise", url: "https://runbot/e.txt" },
              ],
            },
    });
    const batch = app.root.querySelector<HTMLInputElement>(".mem-batch-input-row .mem-url-input")!;
    expect(button("Fetch builds").disabled).toBe(true);
    await type(batch, "https://runbot/batch/empty");
    batch.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await app.settle();
    expect(text(app.root.querySelector(".mem-batch-section .form-error"))).toBe(
      "No builds found at that URL.",
    );
    await type(batch, "https://runbot/batch/1");
    await click(button("Fetch builds"));
    // the empty placeholder row is replaced by the batch's builds
    expect(
      buildRows().map((r) => r.querySelector<HTMLInputElement>(".mem-label-input")!.value),
    ).toEqual(["community", "enterprise"]);
    expect(app.callsTo("/api/memory/batch").at(-1)?.body).toEqual({
      url: "https://runbot/batch/1",
    });
    expect(button("Draw graph").disabled).toBe(false);
  });

  it("uploads a log file for a row, and clears it", async () => {
    app = await mount();
    const input = buildRows()[0].querySelector<HTMLInputElement>(".mem-file-input")!;
    const file = new File(["[MEMINFO] web 1"], "run.log", { type: "text/plain" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change"));
    await waitForChip();
    const chip = buildRows()[0].querySelector(".mem-file-chip")!;
    expect(text(chip)).toContain("run.log");
    expect(buildRows()[0].querySelector(".mem-url-input")).toBeNull();
    await click(button("Draw graph"));
    expect(app.callsTo("/api/memory/fetch")[0].body).toMatchObject({
      builds: [{ fileName: "run.log", content: "[MEMINFO] web 1" }],
    });
    await click(chip.querySelector(".mem-file-clear")!);
    expect(buildRows()[0].querySelector(".mem-file-chip")).toBeNull();
    expect(buildRows()[0].querySelector(".mem-url-input")).not.toBeNull();
  });

  it("collapses and re-opens the build list", async () => {
    app = await mount();
    const toggle = (): HTMLButtonElement => app.root.querySelector(".mem-sidebar-toggle")!;
    expect(toggle().title).toBe("Hide build list");
    await click(toggle());
    expect(buildRows()).toHaveLength(0);
    expect(toggle().title).toBe("Show build list");
    await click(toggle());
    expect(buildRows()).toHaveLength(1);
  });
});

// FileReader completes asynchronously — wait (bounded) for the chip to render
async function waitForChip(): Promise<void> {
  await vi.waitFor(async () => {
    await app.settle();
    if (!app.root.querySelector(".mem-file-chip")) throw new Error("no chip yet");
  });
}
