import { Component, onMounted, onWillUnmount, usePlugin, signal, xml } from "@odoo/owl";
import { ICONS, m } from "../core/common.js";
import { DialogPlugin } from "../core/dialog_plugin.js";
import { Panel } from "../core/panel.js";

const STORAGE_KEY = "oo-todos";

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

// stored shape: { lists: [{ id, name, todos: [{ id, title, done }] }], selected }.
// The original flat todos array (one implicit list) migrates into a single
// "Todo" list on first read; anything unreadable falls back to one empty list.
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
          <form class="todo-form" t-on-submit.prevent="() => this.add()">
            <input t-ref="this.newTodo" type="text" t-att-value="this.draft()"
                   t-on-input="ev => this.draft.set(ev.target.value)"
                   placeholder="What needs to be done?" autocomplete="off" aria-label="New todo"/>
            <button type="submit" class="pbtn" t-att-disabled="!this.draft().trim()">Add todo</button>
          </form>
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
            <button class="todo-rail-add" t-on-click="() => this.addList()">+ New list</button>
          </div>
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
            <div t-else="" class="todo-list">
              <div t-foreach="this.list.todos" t-as="todo" t-key="todo.id" class="todo-row"
                   t-att-class="{done: todo.done}">
                <label class="todo-check">
                  <input type="checkbox" t-att-checked="todo.done" t-on-change="() => this.toggle(todo.id)"/>
                  <span t-out="todo.title"/>
                </label>
                <button class="todo-delete" t-on-click="() => this.remove(todo.id)" title="Delete todo" aria-label="Delete todo">×</button>
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
  newTodo = signal.ref(HTMLInputElement);
  todoIcon = m(ICONS.todo);
  kebabIcon = m(ICONS.kebab);

  setup() {
    // close the list-actions menu on any outside click
    const closeMenu = () => this.menuOpen() && this.menuOpen.set(false);
    onMounted(() => document.addEventListener("click", closeMenu));
    onWillUnmount(() => document.removeEventListener("click", closeMenu));
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
    const res = await this._nameDialog("New list", "Create", "");
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

  // ── todos (on the selected list) ───────────────────────────────────────────
  add() {
    const title = this.draft().trim();
    if (!title) return;
    this._updateTodos((todos) => [...todos, { id: uid(), title, done: false }]);
    this.draft.set("");
    this.newTodo()?.focus();
  }

  toggle(id) {
    this._updateTodos((todos) =>
      todos.map((todo) => (todo.id === id ? { ...todo, done: !todo.done } : todo)),
    );
  }

  remove(id) {
    this._updateTodos((todos) => todos.filter((todo) => todo.id !== id));
  }

  clearCompleted() {
    this._updateTodos((todos) => todos.filter((todo) => !todo.done));
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
