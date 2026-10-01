import { afterEach, describe, expect, it } from "vitest";
import { mountApp, type MountedApp } from "../helpers/app.ts";
import { answer, byText, check, dialog, type } from "../helpers/screen_fixtures.ts";

interface StoredTodo {
  id: string;
  title: string;
  done?: boolean;
  status?: string;
  starred?: boolean;
  description?: string;
  created?: number;
}
interface StoredList {
  id: string;
  name: string;
  mode?: string;
  todos: StoredTodo[];
}

const KEY = "oo-todos";
const stored = (): { lists: StoredList[]; selected: string } =>
  JSON.parse(localStorage.getItem(KEY) || "null");
const seed = (lists: StoredList[], selected = lists[0].id) =>
  localStorage.setItem(KEY, JSON.stringify({ lists, selected }));

let app: MountedApp;
afterEach(() => app?.destroy());

const open = () => mountApp({ section: "todo" });
const titles = () =>
  [...app.root.querySelectorAll(".todo-row .todo-title")].map((b) => b.textContent);
const rowOf = (title: string) =>
  [...app.root.querySelectorAll<HTMLElement>(".todo-row")].find(
    (r) => r.querySelector(".todo-title")?.textContent === title,
  )!;
const rail = () =>
  [...app.root.querySelectorAll(".todo-rail-item .todo-rail-name")].map((s) => s.textContent);
const summary = () => app.root.querySelector(".panel-inline-actions .sub")?.textContent;

async function addTodo(title: string): Promise<void> {
  type(app.root.querySelector<HTMLInputElement>(".todo-form input")!, title, false);
  await app.settle();
  app.root
    .querySelector<HTMLFormElement>(".todo-form")!
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await app.settle();
}

describe("Todo screen — todos", () => {
  it("starts with one empty list", async () => {
    app = await open();
    expect(rail()).toEqual(["Todo"]);
    expect(app.root.textContent).toContain("No todos yet.");
    expect(summary()).toBe("0 open · 0 total");
    // nothing typed → Add is disabled
    expect(byText(app.root, "Add todo").disabled).toBe(true);
  });

  it("adds todos newest-first, opens the new one's details and persists them", async () => {
    app = await open();
    await addTodo("first");
    await addTodo("  second  ");
    expect(titles()).toEqual(["second", "first"]);
    expect(summary()).toBe("2 open · 2 total");
    expect(app.root.querySelector<HTMLInputElement>(".todo-form input")!.value).toBe("");
    // the details pane shows the todo just added
    expect(app.root.querySelector<HTMLInputElement>(".todo-details-title")!.value).toBe("second");
    expect(app.root.querySelector(".todo-details")!.textContent).toContain("created ");
    const list = stored().lists[0];
    expect(list.todos.map((t) => [t.title, t.done, t.status])).toEqual([
      ["second", false, "backlog"],
      ["first", false, "backlog"],
    ]);
    // the blank draft is ignored
    await addTodo("   ");
    expect(titles()).toHaveLength(2);
  });

  it("checks, stars, clears completed and deletes todos", async () => {
    seed([
      {
        id: "l1",
        name: "Work",
        todos: [
          { id: "a", title: "alpha" },
          { id: "b", title: "beta" },
          { id: "c", title: "gamma" },
        ],
      },
    ]);
    app = await open();
    expect(byText.bind(null, app.root, "Clear completed")).toThrow(); // nothing done yet
    check(rowOf("alpha").querySelector<HTMLInputElement>(".todo-checkbox")!);
    await app.settle();
    expect(rowOf("alpha").classList).toContain("done");
    expect(summary()).toBe("2 open · 3 total");
    expect(app.root.querySelector(".todo-rail-count")?.textContent).toBe("2");

    rowOf("beta").querySelector<HTMLButtonElement>(".todo-star")!.click();
    await app.settle();
    expect(rowOf("beta").querySelector(".todo-star")!.classList).toContain("on");
    expect(stored().lists[0].todos.find((t) => t.id === "b")!.starred).toBe(true);

    rowOf("gamma").querySelector<HTMLButtonElement>(".todo-delete")!.click();
    await app.settle();
    expect(titles()).toEqual(["alpha", "beta"]);

    // open the done one's details, then clear completed: it goes, and the pane closes
    rowOf("alpha").querySelector<HTMLButtonElement>(".todo-title")!.click();
    await app.settle();
    expect(app.root.querySelector(".todo-details")).not.toBeNull();
    byText(app.root, "Clear completed").click();
    await app.settle();
    expect(titles()).toEqual(["beta"]);
    expect(app.root.querySelector(".todo-details")).toBeNull();
    expect(stored().lists[0].todos.map((t) => t.id)).toEqual(["b"]);
  });

  it("edits a todo's title and description in the details pane", async () => {
    seed([{ id: "l1", name: "Work", todos: [{ id: "1700000000000-x", title: "draft" }] }]);
    app = await open();
    rowOf("draft").querySelector<HTMLButtonElement>(".todo-title")!.click();
    await app.settle();
    const details = app.root.querySelector(".todo-details")!;
    expect(details.querySelector(".todo-details-project")!.textContent).toBe("Work");
    // an older todo without `created` takes its timestamp from its id
    expect(details.textContent).toContain("created ");

    const title = details.querySelector<HTMLInputElement>(".todo-details-title")!;
    type(title, "  final  ");
    await app.settle();
    expect(titles()).toEqual(["final"]);
    expect(title.value).toBe("final");
    // a blank title is refused: the input reverts, the todo keeps its title
    type(title, "   ");
    await app.settle();
    expect(title.value).toBe("final");
    expect(stored().lists[0].todos[0].title).toBe("final");
    // Escape abandons the edit in progress
    title.value = "oops";
    title.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(title.value).toBe("final");
    title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    const desc = details.querySelector<HTMLTextAreaElement>(".todo-details-description")!;
    type(desc, "some notes", false);
    await app.settle();
    expect(stored().lists[0].todos[0].description).toBe("some notes");

    details.querySelector<HTMLButtonElement>(".todo-details-close")!.click();
    await app.settle();
    expect(app.root.querySelector(".todo-details")).toBeNull();
  });

  it("deletes the open todo from its details pane", async () => {
    seed([{ id: "l1", name: "Work", todos: [{ id: "a", title: "alpha" }] }]);
    app = await open();
    rowOf("alpha").querySelector<HTMLButtonElement>(".todo-title")!.click();
    await app.settle();
    app.root.querySelector<HTMLButtonElement>(".todo-details-delete")!.click();
    await app.settle();
    expect(app.root.querySelector(".todo-details")).toBeNull();
    expect(app.root.textContent).toContain("No todos yet.");
    expect(stored().lists[0].todos).toEqual([]);
  });
});

describe("Todo screen — stored state", () => {
  it("migrates the legacy flat array into one list, dropping malformed records", async () => {
    localStorage.setItem(KEY, JSON.stringify([{ id: "a", title: "legacy" }, { id: 3 }, "junk"]));
    app = await open();
    expect(rail()).toEqual(["Todo"]);
    expect(titles()).toEqual(["legacy"]);
  });

  it("falls back to a fresh list on corrupted storage", async () => {
    localStorage.setItem(KEY, "{not json");
    app = await open();
    expect(rail()).toEqual(["Todo"]);
    expect(app.root.textContent).toContain("No todos yet.");
  });

  it("restores the selected list, or the first when the selection is gone", async () => {
    const lists = [
      { id: "l1", name: "One", todos: [{ id: "a", title: "in one" }] },
      { id: "l2", name: "Two", todos: [{ id: "b", title: "in two" }] },
      { id: 5, name: "bad list" } as unknown as StoredList,
    ];
    seed(lists, "l2");
    app = await open();
    expect(rail()).toEqual(["One", "Two"]);
    expect(titles()).toEqual(["in two"]);
    app.destroy();

    seed(lists, "missing");
    app = await open();
    expect(titles()).toEqual(["in one"]);
  });
});

describe("Todo screen — lists", () => {
  it("creates a project (validated, cancellable) and switches to it", async () => {
    app = await open();
    byText(app.root, "New Project").click();
    await app.settle();
    expect(dialog()!.textContent).toContain("New project");
    await answer(app, false);
    expect(rail()).toEqual(["Todo"]);

    byText(app.root, "New Project").click();
    await app.settle();
    const ok = dialog()!.querySelector<HTMLButtonElement>(".pbtn.primary")!;
    expect(ok.disabled).toBe(true); // a name is required
    type(dialog()!.querySelector<HTMLInputElement>("input[type=text]")!, " Side ");
    await app.settle();
    await answer(app, true);
    expect(rail()).toEqual(["Todo", "Side"]);
    expect(app.root.querySelector(".todo-rail-item.active")!.textContent).toContain("Side");
    expect(app.root.querySelector(".todo-card-title")!.textContent).toBe("Side");
    const s = stored();
    expect(s.lists.map((l) => l.name)).toEqual(["Todo", "Side"]);
    expect(s.selected).toBe(s.lists[1].id);

    // switching back through the rail
    app.root.querySelector<HTMLButtonElement>(".todo-rail-item")!.click();
    await app.settle();
    expect(app.root.querySelector(".todo-card-title")!.textContent).toBe("Todo");
    expect(stored().selected).toBe(s.lists[0].id);
  });

  it("renames the list from its kebab menu", async () => {
    seed([{ id: "l1", name: "Old", todos: [] }]);
    app = await open();
    app.root.querySelector<HTMLButtonElement>(".todo-card-head .dash-kebab")!.click();
    await app.settle();
    // the last list can't be deleted
    expect(byText(app.root, "Delete list").disabled).toBe(true);
    byText(app.root, "Rename").click();
    await app.settle();
    expect(app.root.querySelector(".todo-card-head .dash-menu")).toBeNull();
    const input = dialog()!.querySelector<HTMLInputElement>("input[type=text]")!;
    expect(input.value).toBe("Old");
    type(input, "New");
    await app.settle();
    await answer(app, true);
    expect(rail()).toEqual(["New"]);
    expect(stored().lists[0].name).toBe("New");
  });

  it("closes the list menu on an outside click", async () => {
    app = await open();
    app.root.querySelector<HTMLButtonElement>(".todo-card-head .dash-kebab")!.click();
    await app.settle();
    expect(app.root.querySelector(".todo-card-head .dash-menu")).not.toBeNull();
    document.body.click();
    await app.settle();
    expect(app.root.querySelector(".todo-card-head .dash-menu")).toBeNull();
  });

  it("deletes a list: an empty one at once, one with todos after confirmation", async () => {
    seed(
      [
        { id: "l1", name: "Keep", todos: [] },
        { id: "l2", name: "Busy", todos: [{ id: "a", title: "x" }] },
        { id: "l3", name: "Empty", todos: [] },
      ],
      "l3",
    );
    app = await open();
    const del = async () => {
      app.root.querySelector<HTMLButtonElement>(".todo-card-head .dash-kebab")!.click();
      await app.settle();
      byText(app.root, "Delete list").click();
      await app.settle();
    };
    await del();
    expect(dialog()).toBeNull();
    expect(rail()).toEqual(["Keep", "Busy"]);

    [...app.root.querySelectorAll<HTMLButtonElement>(".todo-rail-item")][1].click();
    await app.settle();
    await del();
    expect(dialog()!.textContent).toContain('Delete "Busy" and its 1 todo?');
    await answer(app, false);
    expect(rail()).toEqual(["Keep", "Busy"]);
    await del();
    await answer(app, true);
    expect(rail()).toEqual(["Keep"]);
    expect(stored().lists.map((l) => l.id)).toEqual(["l1"]);
  });
});

describe("Todo screen — kanban", () => {
  it("groups the list's todos into Backlog / Ongoing / Done, per list", async () => {
    seed([
      {
        id: "l1",
        name: "Work",
        todos: [
          { id: "a", title: "new" },
          { id: "b", title: "doing", status: "ongoing" },
          { id: "c", title: "shipped", done: true, status: "ongoing" },
        ],
      },
      { id: "l2", name: "Other", todos: [] },
    ]);
    app = await open();
    byText(app.root, "Kanban").click();
    await app.settle();
    const cols = [...app.root.querySelectorAll(".kanban-col")].map((c) => ({
      title: c.querySelector(".kanban-col-title")!.textContent,
      count: c.querySelector(".kanban-col-count")!.textContent,
      cards: [...c.querySelectorAll(".kanban-card-title")].map((t) => t.textContent),
    }));
    expect(cols).toEqual([
      { title: "Backlog", count: "1", cards: ["new"] },
      { title: "Ongoing", count: "1", cards: ["doing"] },
      { title: "Done", count: "1", cards: ["shipped"] },
    ]);
    expect(stored().lists[0].mode).toBe("kanban");
    expect(byText(app.root, "Kanban").classList).toContain("on");

    // starring a card works in place
    app.root.querySelector<HTMLButtonElement>(".kanban-card-star")!.click();
    await app.settle();
    expect(stored().lists[0].todos[0].starred).toBe(true);

    // the mode is per list: the other list is still a plain list, with empty columns in kanban
    [...app.root.querySelectorAll<HTMLButtonElement>(".todo-rail-item")][1].click();
    await app.settle();
    expect(app.root.querySelector(".kanban-board")).toBeNull();
    byText(app.root, "Kanban").click();
    await app.settle();
    expect(app.root.querySelectorAll(".kanban-col-empty")).toHaveLength(3);
    byText(app.root, "List").click();
    await app.settle();
    expect(app.root.querySelector(".kanban-board")).toBeNull();
    expect(stored().lists[1].mode).toBe("list");
  });
});
