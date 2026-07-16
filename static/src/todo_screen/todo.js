import { Component, onMounted, onWillUnmount, usePlugin, signal, useEffect, xml } from "@odoo/owl";
import { ICONS, m } from "../core/common.js";
import { DialogPlugin } from "../core/dialog_plugin.js";
import { startRowDrag, dropIndex } from "../core/drag.js";
import { Panel } from "../core/panel.js";

const STORAGE_KEY = "oo-todos";

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

// stored shape: { lists: [{ id, name, todos: [{ id, title, done, starred, description }] }], selected }.
// The original flat todos array (one implicit list) migrates into a single
// "Todo" list on first read; anything unreadable falls back to one empty list.
// `starred`/`description` are absent on todos created before those fields
// existed — treat missing as falsy/empty rather than backfilling on read.
function storedState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    const cleanTodos = (todos) =>
      (Array.isArray(todos) ? todos : []).filter(
        (item) => item && typeof item.id === "string" && typeof item.title === "string",
      );
    if (Array.isArray(raw)) {
      const list = { id: uid(), name: "Todo", todos: cleanTodos(raw) };
      return { lists: [list], selected: list.id };
    }
    if (raw && Array.isArray(raw.lists)) {
      const lists = raw.lists
        .filter((l) => l && typeof l.id === "string" && typeof l.name === "string")
        .map((l) => ({ id: l.id, name: l.name, todos: cleanTodos(l.todos) }));
      if (lists.length) {
        const selected = lists.some((l) => l.id === raw.selected) ? raw.selected : lists[0].id;
        return { lists, selected };
      }
    }
  } catch {
    // corrupted storage — start fresh below
  }
  const list = { id: uid(), name: "Todo", todos: [] };
  return { lists: [list], selected: list.id };
}

export class TodoScreen extends Component {
  static components = { Panel };
  static template = xml`
    <section>
      <Panel title="'Todo'">
        <t t-set-slot="bottom-left">
          <button class="pbtn" t-on-click="() => this.addList()">New Project</button>
        </t>
        <t t-set-slot="bottom-right">
          <span class="row-count" t-out="this.summary"/>
          <button t-if="this.completedCount" class="pbtn" t-on-click="() => this.clearCompleted()">Clear completed</button>
        </t>
      </Panel>
      <div class="content todo-content">
        <div class="todo-layout">
          <div class="todo-rail">
            <button t-foreach="this.lists()" t-as="l" t-key="l.id" class="todo-rail-item"
                    t-att-class="{active: l.id === this.selected()}" t-on-click="() => this.select(l.id)">
              <span class="todo-rail-name" t-out="l.name"/>
              <span t-if="this.openCount(l)" class="todo-rail-count" t-out="this.openCount(l)"/>
            </button>
          </div>
          <div class="todo-main">
            <form class="todo-form" t-on-submit.prevent="() => this.add()">
              <input t-ref="this.newTodo" type="text" t-att-value="this.draft()"
                     t-on-input="ev => this.draft.set(ev.target.value)"
                     placeholder="What needs to be done?" autocomplete="off" aria-label="New todo"/>
              <button type="submit" class="pbtn" t-att-disabled="!this.draft().trim()">Add todo</button>
            </form>
            <div class="todo-card">
              <div class="todo-card-head">
                <span class="todo-card-title" t-out="this.list.name"/>
                <div class="dash-kebab-wrap">
                  <button class="dash-kebab" t-att-class="{open: this.menuOpen()}" title="list actions" t-on-click.stop="() => this.menuOpen.set(!this.menuOpen())"><t t-out="this.kebabIcon"/></button>
                  <div t-if="this.menuOpen()" class="dash-menu" t-on-click.stop="">
                    <button class="dash-menu-item" t-on-click="() => this.menuAct(() => this.renameList())">Rename</button>
                    <button class="dash-menu-item danger" t-att-disabled="this.lists().length === 1"
                            t-att-title="this.lists().length === 1 ? 'the last list cannot be deleted' : ''"
                            t-on-click="() => this.menuAct(() => this.deleteList())">Delete list</button>
                  </div>
                </div>
              </div>
              <div t-if="!this.list.todos.length" class="todo-empty">
                <span class="todo-empty-icon"><t t-out="this.todoIcon"/></span>
                <span>No todos yet.</span>
              </div>
              <div t-else="" class="todo-list" t-ref="this.listEl">
                <div t-foreach="this.list.todos" t-as="todo" t-key="todo.id" class="todo-row"
                     t-att-class="{done: todo.done, dragging: this.dragId() === todo.id}"
                     t-att-title="this.createdTitle(todo)">
                  <span class="row-handle" title="drag to reorder"
                        t-on-pointerdown="ev => this.onDragStart(ev, todo)">⠿</span>
                  <div class="todo-check">
                    <input type="checkbox" class="todo-checkbox" t-att-checked="todo.done" t-on-change="() => this.toggle(todo.id)"/>
                    <button type="button" class="todo-title" t-on-click="() => this.editNote(todo)" t-out="todo.title"/>
                  </div>
                  <button class="todo-star" t-att-class="{on: todo.starred}"
                          t-att-title="todo.starred ? 'unstar' : 'star'" t-on-click.stop="() => this.toggleStar(todo.id)">★</button>
                  <button class="todo-delete" t-on-click="() => this.remove(todo.id)" title="Delete todo" aria-label="Delete todo">×</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>`;

  dialogs = usePlugin(DialogPlugin);
  _stored = storedState(); // read once — lists + selected must come from the same snapshot
  lists = signal(this._stored.lists);
  selected = signal(this._stored.selected);
  draft = signal("");
  menuOpen = signal(false);
  dragId = signal(""); // id of the todo being dragged ("" = none)
  newTodo = signal.ref(HTMLInputElement);
  listEl = signal.ref(HTMLElement);
  todoIcon = m(ICONS.todo);
  kebabIcon = m(ICONS.kebab);

  setup() {
    // close the list-actions menu on any outside click
    const closeMenu = () => this.menuOpen() && this.menuOpen.set(false);
    onMounted(() => document.addEventListener("click", closeMenu));
    onWillUnmount(() => document.removeEventListener("click", closeMenu));
    // never leak the drag ghost / window listeners if we unmount mid-drag
    onWillUnmount(() => this._dragStop?.(true));
    // autofocus the new-todo input: the effect tracks the ref signal, so it runs
    // once the input is mounted (and again if it's ever remounted)
    useEffect(() => {
      this.newTodo()?.focus();
    });
  }

  // the selected list (falls back to the first — a list always exists)
  get list() {
    return this.lists().find((l) => l.id === this.selected()) || this.lists()[0];
  }

  openCount(l) {
    return l.todos.filter((todo) => !todo.done).length;
  }

  get completedCount() {
    return this.list.todos.filter((todo) => todo.done).length;
  }

  get summary() {
    const total = this.list.todos.length;
    return `${total - this.completedCount} open · ${total} total`;
  }

  select(id) {
    this.selected.set(id);
    this._save();
    this.newTodo()?.focus();
  }

  menuAct(fn) {
    this.menuOpen.set(false);
    return fn();
  }

  // ── lists ──────────────────────────────────────────────────────────────────
  async addList() {
    const res = await this._nameDialog("New project", "Create", "");
    if (!res) return;
    const list = { id: uid(), name: res, todos: [] };
    this.lists.set([...this.lists(), list]);
    this.select(list.id);
  }

  async renameList() {
    const res = await this._nameDialog("Rename list", "Rename", this.list.name);
    if (!res) return;
    this._updateList(this.list.id, (l) => ({ ...l, name: res }));
  }

  async deleteList() {
    const target = this.list;
    if (this.lists().length === 1) return;
    if (target.todos.length) {
      const ok = await this.dialogs.open({
        title: "Delete list",
        message: `Delete "${target.name}" and its ${target.todos.length} todo${target.todos.length === 1 ? "" : "s"}?`,
        okLabel: "Delete",
      });
      if (!ok) return;
    }
    this.lists.set(this.lists().filter((l) => l.id !== target.id));
    this.select(this.lists()[0].id);
  }

  _nameDialog(title, okLabel, value) {
    return this.dialogs
      .open({
        title,
        okLabel,
        validate: (v) => ((v.name || "").trim() ? "" : "a name is required"),
        fields: [{ key: "name", type: "text", label: "Name", value, placeholder: "list name" }],
      })
      .then((res) => (res ? res.name.trim() : ""));
  }

  // ── todos (on the selected list) ────────────────────────────────────────────
  // new todos go to the front, so the default order is last-created-first;
  // drag-and-drop (below) then lets the array order be reshuffled freely.
  add() {
    const title = this.draft().trim();
    if (!title) return;
    this._updateTodos((todos) => [
      { id: uid(), title, done: false, created: Date.now(), starred: false, description: "" },
      ...todos,
    ]);
    this.draft.set("");
    this.newTodo()?.focus();
  }

  // the row tooltip: when the todo was created. New todos store `created`;
  // older ones carry the same timestamp as their id's Date.now() prefix.
  createdTitle(todo) {
    const ts = todo.created || Number((todo.id || "").split("-")[0]);
    if (!ts) return "";
    const abs = new Date(ts).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    return `created ${abs}`;
  }

  toggle(id) {
    this._updateTodos((todos) =>
      todos.map((todo) => (todo.id === id ? { ...todo, done: !todo.done } : todo)),
    );
  }

  toggleStar(id) {
    this._updateTodos((todos) =>
      todos.map((todo) => (todo.id === id ? { ...todo, starred: !todo.starred } : todo)),
    );
  }

  async editNote(todo) {
    const res = await this.dialogs.open({
      title: todo.title,
      okLabel: "Save",
      fields: [
        {
          key: "description",
          type: "textarea",
          label: "Description",
          value: todo.description || "",
          rows: 8,
          placeholder: "description",
        },
      ],
    });
    if (!res) return;
    this._updateTodos((todos) =>
      todos.map((t) => (t.id === todo.id ? { ...t, description: res.description } : t)),
    );
  }

  remove(id) {
    this._updateTodos((todos) => todos.filter((todo) => todo.id !== id));
  }

  clearCompleted() {
    this._updateTodos((todos) => todos.filter((todo) => !todo.done));
  }

  // ── drag-and-drop resequencing ───────────────────────────────────────────────
  // Shared pointer drag (core/drag.js): the grabbed row lifts into a ghost that
  // follows the cursor, while the real row — dimmed in place — live-reorders
  // through the list as the pointer crosses its neighbours' midlines. Drop
  // persists the order; Escape restores the grab-time order.
  onDragStart(ev, todo) {
    const original = this.list.todos; // grab-time order, restored on Escape
    const stop = startRowDrag(ev, {
      row: ev.target.closest(".todo-row"),
      onMove: (e) => this._dragMove(e, todo.id),
      onEnd: (commit) => {
        this._dragStop = null;
        this.dragId.set("");
        if (commit) this._save();
        else this._updateTodos(() => original);
      },
    });
    if (!stop) return;
    this._dragStop = stop;
    this.dragId.set(todo.id);
  }

  _dragMove(ev, id) {
    const rows = [...(this.listEl()?.querySelectorAll(".todo-row") || [])];
    const to = dropIndex(
      ev,
      rows.filter((r) => !r.classList.contains("dragging")),
    );
    const todos = this.list.todos;
    const from = todos.findIndex((t) => t.id === id);
    if (from < 0 || from === to) return;
    const next = [...todos];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    // reorder in memory only — persisted once, on drop
    this.lists.set(this.lists().map((l) => (l.id === this.list.id ? { ...l, todos: next } : l)));
  }

  _updateTodos(fn) {
    this._updateList(this.list.id, (l) => ({ ...l, todos: fn(l.todos) }));
  }

  _updateList(id, fn) {
    this.lists.set(this.lists().map((l) => (l.id === id ? fn(l) : l)));
    this._save();
  }

  _save() {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ lists: this.lists(), selected: this.selected() }),
    );
  }
}
