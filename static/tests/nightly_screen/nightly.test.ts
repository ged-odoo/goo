import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountApp, type MountedApp, type Route } from "../helpers/app.ts";
import { installFakeChart, liveCharts } from "../helpers/chart_fixtures.ts";

const day = (offset: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return d.toISOString().slice(0, 10);
};

const build = (id: number, status: string, counts?: [number, number, number]) => ({
  status,
  url: `/runbot/build/${id}`,
  ...(counts
    ? {
        counts: {
          total: counts[0] + counts[1] + counts[2],
          ok: counts[0],
          warning: counts[1],
          failed: counts[2],
        },
      }
    : {}),
});

// two nights, newest first; saas-18.4 had no enterprise build last night
const NIGHTS = {
  versions: ["master", "saas-18.4"],
  nights: [
    {
      date: day(0),
      versions: {
        master: {
          community: build(11, "success", [10, 0, 0]),
          enterprise: build(12, "danger", [8, 1, 1]),
        },
        "saas-18.4": { community: build(13, "warning") },
      },
    },
    {
      date: day(1),
      versions: {
        master: {
          community: build(21, "info", [9, 0, 0]),
          enterprise: build(22, "success", [10, 0, 0]),
        },
      },
    },
  ],
};

const MB = 1024 * 1024;
const ERRORS: Record<string, unknown> = {
  "/runbot/build/12": {
    errors: [
      {
        test_name: "web.test_form",
        status: "danger",
        timeout: false,
        known: true,
        assignee: "jpp",
        url: "/runbot/build/120",
      },
      {
        test_name: "web.test_list",
        status: "warning",
        timeout: false,
        known: false,
        assignee: "",
        url: "/runbot/build/121",
      },
      {
        test_name: "web.test_slow",
        status: "danger",
        timeout: true,
        known: false,
        assignee: "",
        url: "/runbot/build/122",
      },
    ],
    metrics: {
      "Mobile suite": {
        avg_mem: 300 * MB,
        max_mem: 400 * MB,
        time: 30,
        count: 2,
        tests: null,
        assertions: null,
      },
      Desktop: {
        avg_mem: 100 * MB,
        max_mem: 200 * MB,
        time: 125,
        count: 3,
        tests: 1500,
        assertions: 9000,
      },
    },
  },
};

const errorsRoute = (body: unknown) =>
  ERRORS[(body as { url: string }).url] ?? { errors: [], metrics: {} };

let app: MountedApp;
// (a block body: a function returned from beforeEach would be run as its teardown)
beforeEach(() => {
  installFakeChart();
});
afterEach(() => app?.destroy());

const mount = (routes: Record<string, Route> = {}) =>
  mountApp({
    section: "nightly",
    routes: { "/api/nightly": NIGHTS, "/api/nightly/errors": errorsRoute, ...routes },
  });

const text = (el: Element | null | undefined): string =>
  el?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const button = (label: string): HTMLButtonElement =>
  [...app.root.querySelectorAll<HTMLButtonElement>("button")].find((b) => text(b) === label)!;
// a badge's letter + its three counts, space-separated
const badgeText = (el: Element): string => [...el.querySelectorAll("span")].map(text).join(" ");
const badges = (row: number): HTMLElement[] => [
  ...app.root.querySelectorAll<HTMLElement>(`.nb-table tbody tr:nth-child(${row}) .nb-build`),
];
async function click(el: Element): Promise<void> {
  (el as HTMLElement).click();
  await app.settle();
}
const floatPopover = (): HTMLElement | null => app.root.querySelector(".nb-popover-float");

describe("Nightly screen — the build grid", () => {
  it("shows one row per night with a C/E badge per version", async () => {
    app = await mount();
    expect(text(app.root.querySelector("h1"))).toBe("Nightly builds");
    expect([...app.root.querySelectorAll(".nb-th-ver")].map(text)).toEqual(["master", "18.4"]);
    const rows = app.root.querySelectorAll(".nb-table tbody tr");
    expect([...rows].map((r) => text(r.querySelector(".nb-td-date")))).toEqual([day(0), day(1)]);

    const [mc, me, sc, se] = badges(1);
    expect(mc.classList.contains("nb-ok")).toBe(true);
    expect(badgeText(mc)).toBe("C 10 0 0");
    expect(me.classList.contains("nb-fail")).toBe(true);
    expect(badgeText(me)).toBe("E 8 1 1");
    // counts not known yet → question marks; a missing build → dashes, not a button
    expect(sc.classList.contains("nb-warn")).toBe(true);
    expect(badgeText(sc)).toBe("C ? ? ?");
    expect(se.tagName).toBe("SPAN");
    expect(badgeText(se)).toBe("E — — —");
    // a version absent that night is a plain dash
    expect(text(rows[1].querySelectorAll(".nb-td-ver")[1])).toBe("—");
    expect(badges(2)[0].classList.contains("nb-run")).toBe(true);
    expect(text(app.root.querySelector(".panel-top-right .meta"))).toBe("just loaded");
    expect(app.callsTo("/api/nightly")).toHaveLength(1);
    expect(app.callsTo("/api/nightly")[0].body).toEqual({ refresh: false, max_nights: 7 });
  });

  it("shows the empty and error states", async () => {
    app = await mount({ "/api/nightly": { versions: [], nights: [] } });
    expect(text(app.root.querySelector(".nb-status"))).toBe("No nightly build data found.");
    app.destroy();
    app = await mount({
      "/api/nightly": () =>
        new Response(JSON.stringify({ ok: false, error: "runbot down" }), { status: 502 }),
    });
    expect(text(app.root.querySelector(".nb-status"))).toBe("Failed to load: runbot down");
  });

  it("re-fetches with refresh when the latest night is stale", async () => {
    let calls = 0;
    app = await mount({
      "/api/nightly": () => {
        calls++;
        return calls === 1
          ? { ...NIGHTS, nights: [{ ...NIGHTS.nights[0], date: day(5) }] }
          : NIGHTS;
      },
    });
    const bodies = app.callsTo("/api/nightly").map((c) => c.body);
    expect(bodies).toEqual([
      { refresh: false, max_nights: 7 },
      { refresh: true, max_nights: 7 },
    ]);
    expect(text(app.root.querySelector(".nb-td-date"))).toBe(day(0));
  });

  it("Refresh forces a reload; Load more asks for seven more nights", async () => {
    app = await mount();
    await click(button("Refresh"));
    expect(app.callsTo("/api/nightly").at(-1)?.body).toEqual({ refresh: true, max_nights: 7 });
    await click(button("Load more"));
    expect(app.callsTo("/api/nightly").at(-1)?.body).toEqual({ refresh: false, max_nights: 9 });
  });
});

describe("Nightly screen — build popovers", () => {
  it("opens a build's errors and per-suite metrics, flags timeouts, and closes", async () => {
    app = await mount();
    await click(badges(1)[1]); // master enterprise
    const pop = floatPopover()!;
    expect(text(pop.querySelector(".nb-pop-label"))).toBe(`master Enterprise — ${day(0)}`);
    expect(pop.querySelector<HTMLAnchorElement>(".nb-pop-ext")!.href).toBe(
      "https://runbot.odoo.com/runbot/build/12",
    );
    // Desktop sorts before Mobile
    const metricRows = [...pop.querySelectorAll(".nb-pop-metric-row:not(.nb-pop-metric-row2)")].map(
      text,
    );
    expect(metricRows).toEqual([
      "Desktop100.00 MBavg·200.00 MBmax·2m 5s3 builds",
      "Mobile300.00 MBavg·400.00 MBmax·30s2 builds",
    ]);
    expect(text(pop.querySelector(".nb-pop-metric-row2"))).toBe("1500tests·9000assertions");
    const items = [...pop.querySelectorAll(".nb-pop-item")];
    expect(items.map((li) => text(li.querySelector(".nb-pop-name")))).toEqual([
      "web.test_form",
      "web.test_list",
      "web.test_slow",
    ]);
    expect(text(items[0].querySelector(".nb-pop-known"))).toBe("jpp");
    expect(items[1].classList.contains("nb-pop-warning")).toBe(true);
    expect(items[2].classList.contains("nb-pop-timeout")).toBe(true);
    // the build with a timeout gets its own badge color
    expect(badges(1)[1].classList.contains("nb-timeout")).toBe(true);

    // clicking the same badge toggles it closed; Escape and outside clicks close too
    await click(badges(1)[1]);
    expect(floatPopover()).toBeNull();
    await click(badges(1)[0]);
    expect(text(floatPopover()!.querySelector(".nb-pop-info"))).toBe(
      "No specific test failures found.",
    );
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await app.settle();
    expect(floatPopover()).toBeNull();
    await click(badges(1)[0]);
    await click(app.root.querySelector("h1")!);
    expect(floatPopover()).toBeNull();
    // re-opening a build uses the session memo (no second fetch)
    await click(badges(1)[1]);
    expect(
      app
        .callsTo("/api/nightly/errors")
        .filter((c) => (c.body as { url: string }).url === "/runbot/build/12"),
    ).toHaveLength(1);
  });

  it("shows a fetch failure inside the popover", async () => {
    app = await mount({
      "/api/nightly/errors": () =>
        new Response(JSON.stringify({ ok: false, error: "build gone" }), { status: 404 }),
    });
    await click(badges(1)[0]);
    expect(text(floatPopover()!.querySelector(".nb-pop-info"))).toBe("Failed: build gone");
  });

  it("pins a popover, drags it by its header, and unpins it", async () => {
    app = await mount();
    await click(badges(1)[1]);
    await click(floatPopover()!.querySelector(".nb-pop-btn")!);
    expect(floatPopover()).toBeNull();
    const pinned = (): HTMLElement | null => app.root.querySelector(".nb-popover-pinned");
    expect(text(pinned()!.querySelector(".nb-pop-label"))).toBe(`master Enterprise — ${day(0)}`);
    expect(pinned()!.querySelectorAll(".nb-pop-item")).toHaveLength(3);
    expect(pinned()!.querySelectorAll(".nb-pop-metric-row2")).toHaveLength(1);

    const head = pinned()!.querySelector(".nb-pop-drag")!;
    const { top, left } = pinned()!.style;
    head.dispatchEvent(new MouseEvent("mousedown", { clientX: 0, clientY: 0, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 50, clientY: 30 }));
    document.dispatchEvent(new MouseEvent("mouseup"));
    await app.settle();
    expect(pinned()!.style.left).toBe(`${parseFloat(left) + 50}px`);
    expect(pinned()!.style.top).toBe(`${parseFloat(top) + 30}px`);
    // after mouseup, moving no longer drags
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 500, clientY: 500 }));
    await app.settle();
    expect(pinned()!.style.left).toBe(`${parseFloat(left) + 50}px`);

    await click(pinned()!.querySelector(".nb-pop-btn")!);
    expect(pinned()).toBeNull();
  });
});

describe("Nightly screen — graph mode", () => {
  const checkbox = (label: string): HTMLInputElement =>
    [...app.root.querySelectorAll<HTMLLabelElement>(".nb-graph-check")]
      .find((l) => text(l) === label)!
      .querySelector("input")!;
  async function toggle(label: string): Promise<void> {
    const cb = checkbox(label);
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event("change"));
    await app.settle();
  }

  it("draws one chart per selected metric from the nights' counts", async () => {
    app = await mount();
    await click(button("Graph"));
    expect(checkbox("master").checked).toBe(true); // master preselected
    expect(checkbox("18.4").checked).toBe(false);
    expect(text(app.root.querySelector(".nb-graph-empty"))).toBe("Select at least one metric.");
    expect(liveCharts()).toHaveLength(0);

    await toggle("Passing builds");
    expect(liveCharts()).toHaveLength(1);
    const [chart] = liveCharts();
    expect(chart.config.type).toBe("line");
    expect(chart.data.labels).toEqual([day(1).slice(5), day(0).slice(5)]); // chronological
    expect(chart.data.datasets.map((d) => [d.label, d.data])).toEqual([
      ["master Community", [9, 10]],
      ["master Enterprise", [10, 8]],
    ]);
    expect(app.root.querySelector(".nb-graph-chart-title")?.textContent).toBe("Passing builds");

    // series + version toggles update the same chart in place
    await toggle("Enterprise");
    expect(chart.data.datasets.map((d) => d.label)).toEqual(["master Community"]);
    expect(chart.updates).toBeGreaterThan(0);
    await toggle("Community");
    expect(chart.data.datasets).toEqual([]);
    await toggle("Community");
    await toggle("18.4"); // no counts for 18.4 → no dataset
    expect(chart.data.datasets.map((d) => d.label)).toEqual(["master Community"]);

    // unselecting the metric destroys its chart
    await toggle("Passing builds");
    expect(chart.destroyed).toBe(true);
    expect(liveCharts()).toHaveLength(0);
  });

  it("plots the detailed metrics the graph mode loads for recent builds", async () => {
    app = await mount();
    await click(button("Graph"));
    // entering graph mode fetched every recent build's metrics
    const asked = app.callsTo("/api/nightly/errors").map((c) => (c.body as { url: string }).url);
    expect(asked.sort()).toEqual([
      "/runbot/build/11",
      "/runbot/build/12",
      "/runbot/build/13",
      "/runbot/build/21",
      "/runbot/build/22",
    ]);
    await toggle("Tests");
    await toggle("Max memory");
    expect(text(app.root.querySelector(".nb-graph-note"))).toBe(
      "Older nights load on popover open.",
    );
    const byTitle = Object.fromEntries(
      liveCharts().map((c) => [
        (c.config.options.scales as { y: { title: { text: string } } }).y.title.text,
        c,
      ]),
    );
    expect(Object.keys(byTitle).sort()).toEqual(["Max memory", "Tests"]);
    // only build 12 (master enterprise, last night) reports suites
    expect(byTitle.Tests.data.datasets.map((d) => [d.label, d.data])).toEqual([
      ["master Enterprise", [null, 1500]],
    ]);
    expect(byTitle["Max memory"].data.datasets[0].data).toEqual([null, 400 * MB]);
    // the axis/tooltip formatting goes through the metric's formatter
    const y = (
      byTitle["Max memory"].config.options.scales as {
        y: { ticks: { callback: (v: number) => string } };
      }
    ).y;
    expect(y.ticks.callback(400 * MB)).toBe("400 MB");
    const tooltip = (
      byTitle.Tests.config.options.plugins as {
        tooltip: { callbacks: { label: (c: unknown) => string } };
      }
    ).tooltip;
    expect(
      tooltip.callbacks.label({ dataset: { label: "master Enterprise" }, parsed: { y: 1500 } }),
    ).toBe("master Enterprise: 1.5k");

    // leaving graph mode destroys the charts
    await click(button("Graph"));
    expect(liveCharts()).toHaveLength(0);
    expect(app.root.querySelector(".nb-table")).not.toBeNull();
  });

  it("Load older nights fetches more nights and their metrics", async () => {
    let n = 0;
    app = await mount({
      "/api/nightly": () => {
        n++;
        if (n === 1) return NIGHTS;
        return {
          ...NIGHTS,
          nights: [
            ...NIGHTS.nights,
            { date: day(2), versions: { master: { community: build(31, "success", [7, 0, 0]) } } },
          ],
        };
      },
    });
    await click(button("Graph"));
    await toggle("Passing builds");
    await click(button("Load older nights"));
    expect(app.callsTo("/api/nightly").at(-1)?.body).toEqual({ refresh: false, max_nights: 9 });
    expect(
      app
        .callsTo("/api/nightly/errors")
        .some((c) => (c.body as { url: string }).url === "/runbot/build/31"),
    ).toBe(true);
    expect(liveCharts()[0].data.datasets[0].data).toEqual([7, 9, 10]);
  });
});
