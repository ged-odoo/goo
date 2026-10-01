import { afterEach, describe, expect, it } from "vitest";
import { Component, signal, useProps, t, xml } from "@odoo/owl";
import { RecordList, recordset, type FieldSpec } from "../../src/core/recordset.ts";

interface Row {
  id: string;
  name: string;
  repo: string;
  count: number;
  done: boolean;
  owner: { id: string; name?: () => string } | null;
}

const ROWS: Row[] = [
  {
    id: "1",
    name: "alpha",
    repo: "community",
    count: 1,
    done: false,
    owner: { id: "u1", name: () => "Ana" },
  },
  { id: "2", name: "", repo: "enterprise", count: 2, done: true, owner: { id: "u2" } },
  { id: "3", name: "gamma", repo: "community", count: 3, done: false, owner: null },
];

// a rich cell component (FieldSpec.component)
class Badge extends Component {
  static template = xml`<b class="badge" t-out="this.props.text"/>`;
  props = useProps({ text: t.string() });
}

let rows = signal<Row[]>([]);
let rs: ReturnType<typeof recordset<Row>>; // the mounted list's recordset
let el: HTMLElement;
let app: InstanceType<typeof globalThis.owl.App> | null = null;
afterEach(() => {
  app?.destroy();
  app = null;
  el?.remove();
});

const frame = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => requestAnimationFrame(() => r(null)));
};

async function mountList(listProps: Record<string, unknown>, Host?: typeof Component) {
  rows = signal(ROWS.map((r) => ({ ...r })));
  const fields: FieldSpec<Row>[] = [
    { name: "name", get: (r) => r.name, title: (r) => `row ${r.id}` },
    {
      name: "count",
      type: "number",
      label: "Count",
      sortable: true,
      get: (r) => r.count,
      set: (r, v) =>
        rows.set(rows().map((x) => (x.id === r.id ? { ...x, count: v as number } : x))),
    },
    {
      name: "done",
      type: "bool",
      label: "",
      get: (r) => r.done,
      set: (r, v) =>
        rows.set(rows().map((x) => (x.id === r.id ? { ...x, done: v as boolean } : x))),
    },
    { name: "owner", type: "relation", get: (r) => r.owner },
    { name: "badge", class: "wide", component: Badge, cellProps: (r) => ({ text: r.repo }) },
  ];
  rs = recordset(() => rows(), fields);
  class DefaultHost extends Component {
    static components = { RecordList };
    static template = xml`<RecordList t-props="this.listProps"/>`;
    listProps = { recordset: rs, ...listProps };
  }
  el = document.createElement("div");
  document.body.appendChild(el);
  app = new globalThis.owl.App({});
  const Root = Host ?? DefaultHost;
  await app.createRoot(Root).mount(el);
  await frame();
}

const cellTexts = () =>
  [...el.querySelectorAll("tr.rl-row")].map((tr) =>
    [...tr.querySelectorAll("td")].map((td) => td.textContent),
  );

describe("RecordList — flat", () => {
  it("renders a header per field and one row per record, by cell kind", async () => {
    await mountList({ rowClass: (r: Row) => ({ active: r.id === "1" }) });
    expect([...el.querySelectorAll("th")].map((th) => th.textContent)).toEqual([
      "name",
      "Count",
      "",
      "owner",
      "badge",
    ]);
    expect(el.querySelector(".rl-group-head")).toBeNull();
    // read-only text ("—" when empty), relation name or id ("—" when unset), the component
    expect(cellTexts().map((c) => [c[0], c[3], c[4]])).toEqual([
      ["alpha", "Ana", "community"],
      ["—", "u2", "enterprise"],
      ["gamma", "—", "community"],
    ]);
    const first = el.querySelector("tr.rl-row")!;
    expect(first.classList.contains("active")).toBe(true);
    expect(first.querySelector("td")!.getAttribute("title")).toBe("row 1");
    expect(first.querySelectorAll("td")[4].className).toBe("rec-char wide");
    expect(first.querySelector<HTMLInputElement>("input[type=number]")!.value).toBe("1");
    expect(el.querySelectorAll<HTMLInputElement>("input[type=checkbox]")[1].checked).toBe(true);
  });

  it("editable cells write through their FieldSpec set() and re-render", async () => {
    await mountList({});
    const num = el.querySelector<HTMLInputElement>("input[type=number]")!;
    num.value = "42";
    num.dispatchEvent(new Event("input"));
    const box = el.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await frame();
    expect(rows()[0]).toMatchObject({ count: 42, done: true });
    expect(el.querySelector<HTMLInputElement>("input[type=checkbox]")!.checked).toBe(true);
  });

  it("sortable headers toggle the screen-owned sort and show the active arrow", async () => {
    const key = signal("count");
    const dir = signal("asc");
    const toggled: string[] = [];
    const sort = {
      key,
      dir,
      toggle: (name: string) => {
        toggled.push(name);
        dir.set(dir() === "asc" ? "desc" : "asc");
      },
    };
    await mountList({ sort });
    const [nameTh, countTh] = [...el.querySelectorAll<HTMLElement>("th")];
    expect(countTh.classList.contains("br-sort")).toBe(true);
    expect(countTh.textContent).toBe("Count ▲");
    expect(nameTh.classList.contains("br-sort")).toBe(false);
    nameTh.click(); // not sortable: ignored
    countTh.click();
    await frame();
    expect(toggled).toEqual(["count"]);
    expect(countTh.textContent).toBe("Count ▼");
    key.set("name");
    await frame();
    expect(countTh.textContent).toBe("Count");
  });
});

describe("RecordList — grouped", () => {
  it("groups rows under headers with counts, in first-occurrence order or groupSort", async () => {
    await mountList({ groupBy: (r: Row) => r.repo });
    const heads = () => [...el.querySelectorAll(".rl-group-head")].map((h) => h.textContent);
    expect(heads()).toEqual(["community(2)", "enterprise(1)"]);
    expect(el.querySelector(".rl-table")!.classList.contains("rl-grouped")).toBe(true);
    expect(el.querySelector(".rl-caret")).toBeNull(); // not collapsible
    app!.destroy();
    el.remove();

    await mountList({
      groupBy: (r: Row) => r.repo,
      groupLabel: (key: string) => key.toUpperCase(),
      groupSort: (a: { key: string }, b: { key: string }) => b.key.localeCompare(a.key),
    });
    expect(heads()).toEqual(["ENTERPRISE(1)", "COMMUNITY(2)"]);
  });

  it("collapsible groups hide their rows and persist the collapsed set", async () => {
    localStorage.setItem("rl-test", JSON.stringify(["enterprise"]));
    await mountList({ groupBy: (r: Row) => r.repo, collapsible: true, stateKey: "rl-test" });
    // seeded from storage: enterprise starts collapsed
    expect(cellTexts().map((c) => c[4])).toEqual(["community", "community"]);
    const [community] = [...el.querySelectorAll<HTMLElement>(".rl-caret")];
    expect(community.getAttribute("title")).toBe("collapse");
    community.click();
    await frame();
    expect(cellTexts()).toEqual([]);
    expect(JSON.parse(localStorage.getItem("rl-test")!).sort()).toEqual([
      "community",
      "enterprise",
    ]);
    el.querySelectorAll<HTMLElement>(".rl-caret")[1].click();
    await frame();
    expect(cellTexts().map((c) => c[4])).toEqual(["enterprise"]);
    expect(JSON.parse(localStorage.getItem("rl-test")!)).toEqual(["community"]);
  });

  it("ignores a corrupt stored state, and works without a stateKey", async () => {
    localStorage.setItem("rl-test", "{not json");
    await mountList({ groupBy: (r: Row) => r.repo, collapsible: true, stateKey: "rl-test" });
    expect(cellTexts().length).toBe(3);
    app!.destroy();
    el.remove();

    await mountList({ groupBy: (r: Row) => r.repo, collapsible: true });
    el.querySelector<HTMLElement>(".rl-caret")!.click();
    await frame();
    expect(cellTexts().length).toBe(1);
  });

  it("the group-header slot replaces the default label, receiving the group", async () => {
    class SlotHost extends Component {
      static components = { RecordList };
      static template = xml`
        <RecordList recordset="this.list" groupBy="this.groupBy">
          <t t-set-slot="group-header" t-slot-scope="s">
            <span class="custom-head" t-out="s.g.key + ':' + s.g.rows.length"/>
          </t>
        </RecordList>`;

      list = rs;
      groupBy = (r: Row) => r.repo;
    }
    await mountList({}, SlotHost);
    expect([...el.querySelectorAll(".custom-head")].map((s) => s.textContent)).toEqual([
      "community:2",
      "enterprise:1",
    ]);
    expect(el.querySelector(".rl-group-label")).toBeNull();
  });
});
