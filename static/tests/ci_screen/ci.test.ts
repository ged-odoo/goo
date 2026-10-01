import { afterEach, describe, expect, it, vi } from "vitest";
import { mountApp, type MountedApp } from "../helpers/app.ts";
import { byText } from "../helpers/screen_fixtures.ts";
import type { CiDay } from "../../src/ci_screen/ci_plugin.ts";

const day = (date: string, extra: Partial<CiDay> = {}): CiDay => ({
  date,
  batches: 0,
  merged: 0,
  failed: 0,
  killed: 0,
  pending: 0,
  prs_merged: 0,
  ...extra,
});

// "today" is pinned at 12:00 UTC so today's PR/hour divides by 12 elapsed hours
const NOW = new Date("2026-03-04T12:00:00Z");

let app: MountedApp;
afterEach(() => {
  app?.destroy();
  vi.useRealTimers();
});

async function mountCi(reply: unknown): Promise<void> {
  // fake only Date: settle() still needs real timers
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  app = await mountApp({ section: "ci", routes: { "/api/ci/merge-stats": reply as object } });
}

const cells = (tr: Element) => [...tr.querySelectorAll("td")].map((td) => td.textContent?.trim());

describe("CI screen", () => {
  it("shows one row per day, today first, with totals, rates and the queue ETA", async () => {
    await mountCi({
      ok: true,
      awaiting: 36,
      days: [
        day("2026-03-04", { batches: 5, merged: 3, failed: 1, pending: 1, prs_merged: 24 }),
        day("2026-03-03", { batches: 10, merged: 8, killed: 2, prs_merged: 48 }),
      ],
    });
    expect(app.callsTo("/api/ci/merge-stats")[0].body).toEqual({ refresh: false, days: 14 });
    const rows = [...app.root.querySelectorAll(".ci-table tbody tr")];
    expect(rows).toHaveLength(2);
    expect(rows[0].classList).toContain("ci-today");
    expect(rows[0].textContent).toContain("today");
    expect(rows[0].textContent).toContain("Wed");
    // today: 24 PRs over the 12 hours elapsed → 2.0/h; a past day: 48/24 → 2.0/h
    expect(cells(rows[0]).slice(1)).toEqual(["5", "3", "1", "·", "1", "24", "2.0"]);
    expect(cells(rows[1]).slice(1)).toEqual(["10", "8", "·", "2", "·", "48", "2.0"]);
    const total = app.root.querySelector(".ci-total")!;
    // 72 PRs over 36 hours → 2.0/h
    expect(cells(total)).toEqual(["14-day total", "15", "11", "1", "2", "1", "72", "2.0"]);
    // 36 awaiting at 2 PR/h → ~18h, both on average and at today's rate
    const queue = app.root.querySelector(".ci-queue")!.textContent!;
    expect(queue).toContain("36 awaiting");
    expect(queue).toContain("~18h to drain (14d avg)");
    expect(queue).toContain("~18h (today)");
    expect(app.root.textContent).toContain("updated ");
  });

  it("formats the ETA as <1h or in days, and omits it with no merges", async () => {
    await mountCi({
      ok: true,
      awaiting: 1,
      days: [day("2026-03-04", { prs_merged: 24 })],
    });
    expect(app.root.querySelector(".ci-queue")!.textContent).toContain("<1h");
    app.destroy();

    await mountCi({
      ok: true,
      awaiting: 500,
      days: [day("2026-03-04", { prs_merged: 12 }), day("2026-03-03", { prs_merged: 0 })],
    });
    // 12 PRs over 36h → 0.33/h shown as 0.3 → 500/0.3 ≈ 69d; today 1/h → ~21d
    const q = app.root.querySelector(".ci-queue")!.textContent!;
    expect(q).toContain("~69d to drain");
    expect(q).toContain("~21d (today)");
    app.destroy();

    await mountCi({ ok: true, awaiting: 4, days: [day("2026-03-04")] });
    const idle = app.root.querySelector(".ci-queue")!.textContent!;
    expect(idle).toContain("4 awaiting");
    expect(idle).not.toContain("drain");
  });

  it("hides the queue when the awaiting count is unknown, and totals an empty window", async () => {
    await mountCi({ ok: true, days: [] });
    expect(app.root.querySelector(".ci-queue")).toBeNull();
    expect(app.root.querySelectorAll(".ci-table tbody tr")).toHaveLength(0);
    expect(cells(app.root.querySelector(".ci-total")!).at(-1)).toBe("0.0");
  });

  it("shows the load error", async () => {
    await mountCi(new Response(JSON.stringify({ error: "mergebot unreachable" }), { status: 502 }));
    expect(app.root.querySelector(".ci-status")?.textContent).toContain(
      "Failed to load: mergebot unreachable",
    );
    expect(app.root.querySelector(".ci-table")).toBeNull();
  });

  it("Refresh re-fetches bypassing the server cache and shows the new data", async () => {
    let days = [day("2026-03-04", { batches: 1 })];
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    app = await mountApp({
      section: "ci",
      routes: { "/api/ci/merge-stats": () => ({ ok: true, days }) },
    });
    days = [day("2026-03-04", { batches: 7 })];
    byText(app.root, "Refresh").click();
    await app.settle();
    expect(app.callsTo("/api/ci/merge-stats").map((c) => c.body)).toEqual([
      { refresh: false, days: 14 },
      { refresh: true, days: 14 },
    ]);
    expect(cells(app.root.querySelector(".ci-table tbody tr")!)[1]).toBe("7");
  });

  it("shows a loading message until the first reply arrives", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    app = await mountApp({
      section: "databases",
      routes: {
        "/api/databases": { ok: true, databases: [] },
        "/api/ci/merge-stats": { ok: true, days: [day("2026-03-04", { batches: 2 })] },
      },
    });
    // hold the backend's merge-stats reply until released
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => (release = r));
    const backend = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("merge-stats")) await gate;
      return backend(input, init);
    });
    await app.navigate("ci");
    expect(app.root.textContent).toContain("Loading merge-queue data…");
    expect(byText(app.root, "Refresh").disabled).toBe(true);
    release(null);
    await app.settle();
    expect(app.root.textContent).not.toContain("Loading merge-queue data…");
    expect(app.root.querySelectorAll(".ci-table tbody tr")).toHaveLength(1);
  });
});
