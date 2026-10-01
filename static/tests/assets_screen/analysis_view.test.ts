// The bundle-analysis view, mounted on its own over the real plugins: the Assets
// plugin's analyze() asks the (fake) backend for a bundle's per-file breakdown and
// the view renders it as a size tree or a flat list.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssetsAnalysis } from "../../src/assets_screen/analysis.ts";
import { AssetsPlugin } from "../../src/assets_screen/assets_plugin.ts";
import { PLUGINS } from "../../src/plugins.ts";
import type { App } from "@odoo/owl";

const BREAKDOWN = {
  js: [
    ["web/static/src/core/a.js", 3000],
    ["web/static/src/core/b.js", 1000],
    ["web/static/src/views/list.js", 5000],
  ],
  css: [["web/static/src/scss/main.scss", 2048]],
  xml: [
    ["web.ListView", 100],
    ["web.ListView", 50], // a template + its extension share a name
  ],
};

let app: App | undefined;
let el: HTMLElement;
afterEach(() => {
  app?.destroy();
  el?.remove();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  }
};

async function mountAnalysis(breakdown: (body: unknown) => Response | object) {
  const calls: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url === "/api/assets/breakdown") {
        calls.push(body);
        const r = breakdown(body);
        return r instanceof Response ? r : new Response(JSON.stringify(r));
      }
      return new Response("{}");
    }),
  );
  el = document.createElement("div");
  document.body.appendChild(el);
  app = new globalThis.owl.App({ plugins: PLUGINS, test: true }) as App;
  await app.createRoot(AssetsAnalysis).mount(el);
  const assets = app.pluginManager.plugins[AssetsPlugin.id] as unknown as InstanceType<
    typeof AssetsPlugin
  >;
  assets.selectedDb.set("master");
  return { assets, calls };
}

const text = (e: Element | null | undefined): string => e?.textContent?.trim() ?? "";
const rows = (): string[] =>
  [...el.querySelectorAll(".bnode-row")].map(
    (r) => `${text(r.querySelector(".bnode-name"))} ${text(r.querySelector(".bnode-size"))}`,
  );
const button = (label: string): HTMLButtonElement =>
  [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => text(b) === label)!;

describe("AssetsAnalysis", () => {
  it("shows the bundle as a size tree, largest first, expandable by folder", async () => {
    const { assets, calls } = await mountAnalysis(() => BREAKDOWN);
    await assets.analyze("web.assets_web", "js");
    await flush();
    expect(calls[0]).toMatchObject({ db: "master", bundle: "web.assets_web", kind: "js" });
    expect(text(el.querySelector(".assets-analysis-title"))).toBe("web.assets_web.min.js");
    expect(text(el.querySelector(".assets-analysis-bar .meta"))).toMatch(/minified$/);
    // top level open by default: js (9000) > css (2048) > xml (150)
    expect(rows().map((r) => r.split(" ")[0])).toEqual([
      "js",
      "web",
      "css",
      "web",
      "xml",
      "web.ListView",
    ]);

    // drill into js → web → static → src: views (5000) before core (4000)
    const open = async (name: string): Promise<void> => {
      const row = [...el.querySelectorAll<HTMLElement>(".bnode-row")].find(
        (r) => text(r.querySelector(".bnode-name")) === name,
      )!;
      row.click();
      await flush();
    };
    await open("web");
    await open("static");
    await open("src");
    const names = rows().map((r) => r.split(" ")[0]);
    expect(names.slice(0, 6)).toEqual(["js", "web", "static", "src", "views", "core"]);
    // a leaf doesn't toggle; a folder collapses again
    await open("web");
    expect(
      rows()
        .map((r) => r.split(" ")[0])
        .slice(0, 3),
    ).toEqual(["js", "web", "css"]);
  });

  it("the flat view merges duplicate paths and the search filters both views", async () => {
    const { assets } = await mountAnalysis(() => BREAKDOWN);
    await assets.analyze("web.assets_web", "css");
    await flush();
    expect(text(el.querySelector(".assets-analysis-title"))).toBe("web.assets_web.min.css");
    button("Flat").click();
    await flush();
    const flat = [...el.querySelectorAll(".bflat-row .bnode-name")].map(text);
    expect(flat).toEqual([
      "web/static/src/views/list.js",
      "web/static/src/core/a.js",
      "web/static/src/scss/main.scss",
      "web/static/src/core/b.js",
      "web.ListView",
    ]);
    expect(el.querySelectorAll(".bflat-row")).toHaveLength(5); // the two web.ListView merged

    const search = el.querySelector<HTMLInputElement>(".search-box input")!;
    search.value = "CORE";
    search.dispatchEvent(new Event("input"));
    await flush();
    expect([...el.querySelectorAll(".bflat-row .bnode-name")].map(text)).toEqual([
      "web/static/src/core/a.js",
      "web/static/src/core/b.js",
    ]);
    button("Aggregate").click();
    await flush();
    expect(rows().map((r) => r.split(" ")[0])).toEqual(["js", "web"]);

    search.value = "nothing-matches";
    search.dispatchEvent(new Event("input"));
    await flush();
    expect(text(el.querySelector(".br-empty"))).toBe("No files in this bundle.");
  });

  it("reports a failed analysis, and Back closes the view", async () => {
    const { assets } = await mountAnalysis(
      () => new Response(JSON.stringify({ ok: false, error: "bundle not found" }), { status: 404 }),
    );
    await assets.analyze("web.assets_web");
    await flush();
    expect(text(el.querySelector(".br-empty"))).toBe("Analysis failed: bundle not found");
    button("← Back").click();
    await flush();
    expect(assets.bundleData()).toBeNull();
    expect(text(el.querySelector(".assets-analysis-title"))).toBe("");
  });
});
