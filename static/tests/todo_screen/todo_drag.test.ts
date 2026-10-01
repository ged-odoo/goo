// The Todo screen's pointer drags: reordering todos and projects, moving kanban
// cards between columns, and the main | details splitter. jsdom has no layout, so
// each test gives the rows/columns the boxes the drag hit-tests against.
import { afterEach, describe, expect, it } from "vitest";
import { mountApp, type MountedApp } from "../helpers/app.ts";
import { pointer, setRect } from "../helpers/screen_fixtures.ts";

const KEY = "oo-todos";
const WIDTH_KEY = "oo-todo-main-width";
type Todo = { id: string; title: string; done?: boolean; status?: string };
const stored = (): { lists: { id: string; name: string; todos: Todo[] }[] } =>
  JSON.parse(localStorage.getItem(KEY) || "null");
const seed = (lists: { id: string; name: string; mode?: string; todos: Todo[] }[]) =>
  localStorage.setItem(KEY, JSON.stringify({ lists, selected: lists[0].id }));

let app: MountedApp;
afterEach(() => app?.destroy());

const escape = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
const titles = () =>
  [...app.root.querySelectorAll(".todo-row .todo-title")].map((b) => b.textContent);
// stack elements vertically, 40px each
const stack = (els: Iterable<Element>) =>
  [...els].forEach((el, i) => setRect(el, { top: i * 40, height: 40 }));

describe("Todo screen — reordering", () => {
  const three = [
    { id: "a", title: "alpha" },
    { id: "b", title: "beta" },
    { id: "c", title: "gamma" },
  ];

  it("drags a todo to the top, persisting the order on drop", async () => {
    seed([{ id: "l1", name: "Work", todos: three }]);
    app = await mountApp({ section: "todo" });
    const rows = app.root.querySelectorAll(".todo-row");
    stack(rows);
    pointer("pointerdown", 10, 90, rows[2].querySelector(".row-handle")!);
    await app.settle();
    expect(rows[2].classList).toContain("dragging");
    expect(document.querySelector(".drag-ghost")).not.toBeNull();
    pointer("pointermove", 10, 5);
    await app.settle();
    expect(titles()).toEqual(["gamma", "alpha", "beta"]);
    expect(stored().lists[0].todos.map((t) => t.id)).toEqual(["a", "b", "c"]); // not yet saved
    pointer("pointerup", 10, 5);
    await app.settle();
    expect(document.querySelector(".drag-ghost")).toBeNull();
    expect(stored().lists[0].todos.map((t) => t.id)).toEqual(["c", "a", "b"]);
  });

  it("Escape cancels a todo drag and restores the order", async () => {
    seed([{ id: "l1", name: "Work", todos: three }]);
    app = await mountApp({ section: "todo" });
    const rows = app.root.querySelectorAll(".todo-row");
    stack(rows);
    pointer("pointerdown", 10, 5, rows[0].querySelector(".row-handle")!);
    pointer("pointermove", 10, 200);
    await app.settle();
    expect(titles()).toEqual(["beta", "gamma", "alpha"]);
    escape();
    await app.settle();
    expect(titles()).toEqual(["alpha", "beta", "gamma"]);
    expect(stored().lists[0].todos.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("drags a project in the rail", async () => {
    seed([
      { id: "l1", name: "One", todos: [] },
      { id: "l2", name: "Two", todos: [] },
    ]);
    app = await mountApp({ section: "todo" });
    const items = app.root.querySelectorAll(".todo-rail-item");
    stack(items);
    pointer("pointerdown", 10, 50, items[1].querySelector(".todo-rail-handle")!);
    pointer("pointermove", 10, 5);
    await app.settle();
    expect(items[1].classList).toContain("dragging");
    pointer("pointerup", 10, 5);
    await app.settle();
    const names = [...app.root.querySelectorAll(".todo-rail-name")].map((s) => s.textContent);
    expect(names).toEqual(["Two", "One"]);
    expect(stored().lists.map((l) => l.id)).toEqual(["l2", "l1"]);
    // the click on the handle doesn't select the project
    expect(app.root.querySelector(".todo-rail-item.active")!.textContent).toContain("One");
  });

  it("Escape cancels a project drag", async () => {
    seed([
      { id: "l1", name: "One", todos: [] },
      { id: "l2", name: "Two", todos: [] },
    ]);
    app = await mountApp({ section: "todo" });
    const items = app.root.querySelectorAll(".todo-rail-item");
    stack(items);
    pointer("pointerdown", 10, 50, items[1].querySelector(".todo-rail-handle")!);
    pointer("pointermove", 10, 5);
    await app.settle();
    escape();
    await app.settle();
    const names = [...app.root.querySelectorAll(".todo-rail-name")].map((s) => s.textContent);
    expect(names).toEqual(["One", "Two"]);
  });
});

describe("Todo screen — kanban drag", () => {
  async function board(todos: Todo[]) {
    seed([{ id: "l1", name: "Work", mode: "kanban", todos }]);
    app = await mountApp({ section: "todo" });
    // three 100px-wide columns side by side
    app.root
      .querySelectorAll(".kanban-col")
      .forEach((c, i) => setRect(c, { left: i * 100, width: 100, height: 400 }));
  }
  const column = (stage: string) =>
    [...app.root.querySelectorAll(`.kanban-col[data-stage=${stage}] .kanban-card-title`)].map(
      (t) => t.textContent,
    );
  const card = (id: string) =>
    app.root.querySelector<HTMLElement>(`.kanban-card[data-todo-id="${id}"] .kanban-card-title`)!;

  it("moves a card to another column on drop", async () => {
    await board([
      { id: "a", title: "alpha" },
      { id: "b", title: "beta", status: "ongoing" },
    ]);
    pointer("pointerdown", 50, 10, card("a"));
    pointer("pointermove", 150, 10); // into Ongoing
    await app.settle();
    // jsdom gives beta no height, so the pointer is "below" it: alpha lands after
    expect(column("ongoing")).toEqual(["beta", "alpha"]);
    expect(app.root.querySelector(".kanban-col.drag-target")!.getAttribute("data-stage")).toBe(
      "ongoing",
    );
    pointer("pointermove", 250, 500); // on to Done, below its cards
    await app.settle();
    expect(column("done")).toEqual(["alpha"]);
    pointer("pointerup", 250, 500);
    await app.settle();
    expect(app.root.querySelector(".kanban-col.drag-target")).toBeNull();
    const a = stored().lists[0].todos.find((t) => t.id === "a")!;
    // Done only flips the flag — the stage it came from is what it had at grab time
    expect([a.done, a.status]).toEqual([true, undefined]);
  });

  it("past the board's edge, the nearest column wins", async () => {
    await board([{ id: "a", title: "alpha", status: "ongoing" }]);
    pointer("pointerdown", 150, 10, card("a"));
    pointer("pointermove", -300, 10);
    pointer("pointerup", -300, 10);
    await app.settle();
    expect(column("backlog")).toEqual(["alpha"]);
    expect(stored().lists[0].todos[0]).toMatchObject({ done: false, status: "backlog" });
  });

  it("places a card before another one in the target column", async () => {
    await board([
      { id: "a", title: "alpha" },
      { id: "b", title: "beta", status: "ongoing" },
      { id: "c", title: "gamma", status: "ongoing" },
    ]);
    // the Ongoing cards stacked at y 0-40 and 40-80
    stack(app.root.querySelectorAll(".kanban-col[data-stage=ongoing] .kanban-card"));
    pointer("pointerdown", 50, 10, card("a"));
    pointer("pointermove", 150, 50); // below beta's midline, above gamma's
    pointer("pointerup", 150, 50);
    await app.settle();
    expect(column("ongoing")).toEqual(["beta", "alpha", "gamma"]);
    expect(stored().lists[0].todos.map((t) => t.id)).toEqual(["b", "a", "c"]);
  });

  it("Escape puts the card back", async () => {
    await board([{ id: "a", title: "alpha" }]);
    pointer("pointerdown", 50, 10, card("a"));
    pointer("pointermove", 250, 10);
    await app.settle();
    expect(column("done")).toEqual(["alpha"]);
    escape();
    await app.settle();
    expect(column("backlog")).toEqual(["alpha"]);
    expect(stored().lists[0].todos[0].done).toBeUndefined();
  });

  it("a press without travel is a click: it opens the card's details", async () => {
    await board([{ id: "a", title: "alpha" }]);
    pointer("pointerdown", 50, 10, card("a"));
    pointer("pointermove", 52, 11); // within the click slop
    pointer("pointerup", 52, 11);
    await app.settle();
    expect(app.root.querySelector<HTMLInputElement>(".todo-details-title")!.value).toBe("alpha");
    expect(app.root.querySelector(".kanban-card.selected")).not.toBeNull();
  });
});

describe("Todo screen — details splitter", () => {
  async function withDetails() {
    seed([{ id: "l1", name: "Work", todos: [{ id: "a", title: "alpha" }] }]);
    app = await mountApp({ section: "todo" });
    app.root.querySelector<HTMLButtonElement>(".todo-title")!.click();
    await app.settle();
    setRect(app.root.querySelector(".todo-layout")!, { width: 1200 });
    setRect(app.root.querySelector(".todo-rail")!, { width: 100 });
    setRect(app.root.querySelector(".todo-main")!, { width: 500 });
    return app.root.querySelector<HTMLElement>(".todo-resizer")!;
  }
  const mainStyle = () => app.root.querySelector<HTMLElement>(".todo-main")!.getAttribute("style");

  it("drags the splitter (clamped) and remembers the width; double-click resets it", async () => {
    const resizer = await withDetails();
    expect(mainStyle()).toBeFalsy(); // the stylesheet default
    pointer("pointerdown", 600, 0, resizer);
    await app.settle();
    expect(resizer.classList).toContain("dragging");
    pointer("pointermove", 700, 0);
    await app.settle();
    expect(mainStyle()).toContain("flex: 0 0 600px");
    // the details pane keeps its minimum: 1200 - 100 rail - 300 - 48 = 752 at most
    pointer("pointermove", 5000, 0);
    await app.settle();
    expect(mainStyle()).toContain("flex: 0 0 752px");
    pointer("pointermove", -5000, 0);
    await app.settle();
    expect(mainStyle()).toContain("flex: 0 0 320px");
    pointer("pointerup", -5000, 0);
    await app.settle();
    expect(localStorage.getItem(WIDTH_KEY)).toBe("320");
    expect(resizer.classList).not.toContain("dragging");

    resizer.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await app.settle();
    // back to the stylesheet's width (jsdom's CSSOM can't remove the `flex`
    // shorthand's longhands, so check the max-width override that goes with it)
    expect(app.root.querySelector<HTMLElement>(".todo-main")!.style.maxWidth).toBe("");
    expect(localStorage.getItem(WIDTH_KEY)).toBeNull();
  });

  it("Escape abandons a splitter drag", async () => {
    localStorage.setItem(WIDTH_KEY, "400");
    const resizer = await withDetails();
    expect(mainStyle()).toContain("flex: 0 0 400px"); // restored from storage
    pointer("pointerdown", 600, 0, resizer);
    pointer("pointermove", 700, 0);
    await app.settle();
    escape();
    await app.settle();
    expect(mainStyle()).toContain("flex: 0 0 400px");
    expect(localStorage.getItem(WIDTH_KEY)).toBe("400");
  });
});
