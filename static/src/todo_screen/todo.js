import { Component, onMounted, onWillUnmount, usePlugin, signal, useEffect, xml } from "@odoo/owl";
import { ICONS, m } from "../core/common.js";
import { DialogPlugin } from "../core/dialog_plugin.js";
import { startRowDrag, dropIndex } from "../core/drag.js";
import { Panel } from "../core/panel.js";

const STORAGE_KEY = "oo-todos";

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

// stored shape:
//   { lists: [{ id, name, mode, todos: [{ id, title, done, status, starred, description }] }], selected }.
// The original flat todos array (one implicit list) migrates into a single
// "Todo" list on first read; anything unreadable falls back to one empty list.
// `starred`/`description`/`status` and a list's `mode` are absent on records
// created before those fields existed — treat missing as the default (falsy /
// empty / "backlog" / "list") rather than backfilling on read.
const KANBAN_STAGES = ["backlog", "ongoing", "done"];
function storedState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    const cleanTodos = (todos) =>
      (Array.isArray(todos) ? todos : []).filter(
        (item) => item && typeof item.id === "string" && typeof item.title === "string",
      );
    const cleanList = (l) => ({
      id: l.id,
      name: l.name,
      mode: l.mode === "kanban" ? "kanban" : "list",
      todos: cleanTodos(l.todos),
    });
    if (Array.isArray(raw)) {
      const list = { ...cleanList({ id: uid(), name: "Todo" }), todos: cleanTodos(raw) };
      return { lists: [list], selected: list.id };
    }
    if (raw && Array.isArray(raw.lists)) {
      const lists = raw.lists
        .filter((l) => l && typeof l.id === "string" && typeof l.name === "string")
        .map(cleanList);
      if (lists.length) {
        const selected = lists.some((l) => l.id === raw.selected) ? raw.selected : lists[0].id;
        return { lists, selected };
      }
    }
  } catch {
    // corrupted storage — start fresh below
  }
  const list = { id: uid(), name: "Todo", mode: "list", todos: [] };
  return { lists: [list], selected: list.id };
}

export class TodoScreen extends Component {
  static components = { Panel };
  static template = xml`
    <section>
      <Panel title="'Todo'">
        <t t-set-slot="title-extra">
          <div class="panel-inline-actions">
            <button class="pbtn" t-on-click="() => this.addList()">New Project</button>
            <span class="sub" t-out="this.summary"/>
            <button t-if="this.completedCount" class="pbtn" t-on-click="() => this.clearCompleted()">Clear completed</button>
          </div>
        </t>
        <t t-set-slot="top-right">
          <div class="todo-mode" role="group" aria-label="View mode">
            <button class="todo-mode-btn" t-att-class="{on: this.mode === 'list'}" title="List view" t-on-click="() => this.setMode('list')"><t t-out="this.listIcon"/>List</button>
            <button class="todo-mode-btn" t-att-class="{on: this.mode === 'kanban'}" title="Kanban board" t-on-click="() => this.setMode('kanban')"><t t-out="this.kanbanIcon"/>Kanban</button>
          </div>
        </t>
      </Panel>
      <div class="content todo-content">
        <div class="todo-layout">
          <div class="todo-rail" t-ref="this.railEl">
            <button t-foreach="this.lists()" t-as="l" t-key="l.id" class="todo-rail-item"
                    t-att-data-list-id="l.id"
                    t-att-class="{active: l.id === this.selected(), dragging: this.listDragId() === l.id}"
                    t-on-click="() => this.select(l.id)">
              <span class="row-handle todo-rail-handle" title="Drag to reorder"
                    t-on-pointerdown.stop="ev => this.onListDragStart(ev, l)"
                    t-on-click.stop="() => {}">⠿</span>
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
              <t t-if="this.mode === 'kanban'">
                <div class="kanban-board" t-ref="this.boardEl">
                  <div t-foreach="this.kanbanColumns" t-as="col" t-key="col.stage" class="kanban-col"
                       t-att-data-stage="col.stage" t-att-class="{'drag-target': this.dragOverStage() === col.stage}">
                    <div class="kanban-col-head">
                      <span class="kanban-col-title" t-out="col.label"/>
                      <span class="kanban-col-count" t-out="col.todos.length"/>
                    </div>
                    <div class="kanban-col-body">
                      <div t-foreach="col.todos" t-as="todo" t-key="todo.id" class="kanban-card"
                           t-att-data-todo-id="todo.id"
                           t-att-class="{done: todo.done, dragging: this.dragId() === todo.id, selected: this.detailTodoId() === todo.id}"
                           t-att-title="this.createdTitle(todo)"
                           t-on-pointerdown="ev => this.onCardDragStart(ev, todo)">
                        <span class="kanban-card-title" t-out="todo.title"/>
                        <button class="todo-star" t-att-class="{on: todo.starred}"
                                t-att-title="todo.starred ? 'unstar' : 'star'" t-on-click.stop="() => this.toggleStar(todo.id)">★</button>
                        <button class="todo-delete" t-on-click.stop="() => this.remove(todo.id)" title="Delete todo" aria-label="Delete todo">×</button>
                      </div>
                      <div t-if="!col.todos.length" class="kanban-col-empty dim">Drop here</div>
                    </div>
                  </div>
                </div>
              </t>
              <t t-else="">
                <div t-if="!this.list.todos.length" class="todo-empty">
                  <span class="todo-empty-icon"><t t-out="this.todoIcon"/></span>
                  <span>No todos yet.</span>
                </div>
                <div t-else="" class="todo-list" t-ref="this.listEl">
                  <div t-foreach="this.list.todos" t-as="todo" t-key="todo.id" class="todo-row"
                       t-att-class="{done: todo.done, dragging: this.dragId() === todo.id, selected: this.detailTodoId() === todo.id}"
                       t-att-title="this.createdTitle(todo)">
                    <span class="row-handle" title="drag to reorder"
                          t-on-pointerdown="ev => this.onDragStart(ev, todo)">⠿</span>
                    <div class="todo-check">
                      <input type="checkbox" class="todo-checkbox" t-att-checked="todo.done" t-on-change="() => this.toggle(todo.id)"/>
                      <button type="button" class="todo-title" t-on-click="() => this.openTodo(todo.id)" t-out="todo.title"/>
                    </div>
                    <button class="todo-star" t-att-class="{on: todo.starred}"
                            t-att-title="todo.starred ? 'unstar' : 'star'" t-on-click.stop="() => this.toggleStar(todo.id)">★</button>
                    <button class="todo-delete" t-on-click="() => this.remove(todo.id)" title="Delete todo" aria-label="Delete todo">×</button>
                  </div>
                </div>
              </t>
            </div>
          </div>
          <aside t-if="this.detailTodo" class="todo-details">
            <div class="todo-details-head">
              <div class="todo-details-heading">
                <span class="todo-details-project" t-out="this.list.name"/>
                <input type="text" class="todo-details-title" aria-label="Todo title"
                       t-att-value="this.detailTodo.title"
                       t-on-change="ev => this.updateTitle(this.detailTodo.id, ev)"
                       t-on-keydown="ev => this.onTitleKeydown(ev)"/>
              </div>
              <button type="button" class="todo-details-close" title="Close details"
                      aria-label="Close details" t-on-click="() => this.closeTodo()">×</button>
            </div>
            <label class="todo-details-label" for="todo-description">Description</label>
            <textarea id="todo-description" class="todo-details-description"
                      t-att-value="this.detailTodo.description || ''"
                      t-on-input="ev => this.updateDescription(this.detailTodo.id, ev.target.value)"
                      placeholder="Add a description…"/>
            <div class="todo-details-foot">
              <span t-out="this.createdTitle(this.detailTodo)"/>
              <span>Saved automatically</span>
            </div>
          </aside>
        </div>
      </div>
    </section>`;

  dialogs = usePlugin(DialogPlugin);
  _stored = storedState(); // read once — lists + selected must come from the same snapshot
  lists = signal(this._stored.lists);
  selected = signal(this._stored.selected);
  draft = signal("");
  menuOpen = signal(false);
  detailTodoId = signal("");
  listDragId = signal("");
  dragId = signal(""); // id of the todo being dragged ("" = none)
  dragOverStage = signal(""); // kanban column the dragged card is currently over
  newTodo = signal.ref(HTMLInputElement);
  railEl = signal.ref(HTMLElement);
  listEl = signal.ref(HTMLElement);
  boardEl = signal.ref(HTMLElement); // the kanban board (column hit-testing on drag)
  todoIcon = m(ICONS.todo);
  kebabIcon = m(ICONS.kebab);
  listIcon = m(ICONS.list);
  kanbanIcon = m(ICONS.kanban);

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

  get detailTodo() {
    return this.list.todos.find((todo) => todo.id === this.detailTodoId());
  }

  // ── view mode (per project) ──────────────────────────────────────────────────
  get mode() {
    return this.list.mode === "kanban" ? "kanban" : "list";
  }

  setMode(mode) {
    if (this.mode === mode) return;
    this._updateList(this.list.id, (l) => ({ ...l, mode }));
  }

  // a todo's kanban column: done drives "done"; the rest split on `status`, which
  // defaults to backlog (so pre-status todos and new ones land there)
  stageOf(todo) {
    if (todo.done) return "done";
    return todo.status === "ongoing" ? "ongoing" : "backlog";
  }

  // the three columns, each with the selected list's todos for that stage in array
  // order (so kanban and list share one ordering)
  get kanbanColumns() {
    const labels = { backlog: "Backlog", ongoing: "Ongoing", done: "Done" };
    return KANBAN_STAGES.map((stage) => ({
      stage,
      label: labels[stage],
      todos: this.list.todos.filter((todo) => this.stageOf(todo) === stage),
    }));
  }

  // the field patch that moves a todo to a stage. "done" only flips the flag,
  // leaving `status` so unchecking in list mode restores the prior stage.
  _stageFields(stage) {
    if (stage === "done") return { done: true };
    return { done: false, status: stage };
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
    this.detailTodoId.set("");
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
    const todo = {
      id: uid(),
      title,
      done: false,
      status: "backlog",
      created: Date.now(),
      starred: false,
      description: "",
    };
    this._updateTodos((todos) => [todo, ...todos]);
    this.openTodo(todo.id);
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

  openTodo(id) {
    this.detailTodoId.set(id);
  }

  closeTodo() {
    this.detailTodoId.set("");
  }

  updateDescription(id, description) {
    this._updateTodos((todos) =>
      todos.map((todo) => (todo.id === id ? { ...todo, description } : todo)),
    );
  }

  updateTitle(id, ev) {
    const title = ev.target.value.trim();
    if (!title) {
      ev.target.value = this.detailTodo?.title || "";
      return;
    }
    ev.target.value = title;
    this._updateTodos((todos) => todos.map((todo) => (todo.id === id ? { ...todo, title } : todo)));
  }

  onTitleKeydown(ev) {
    if (ev.key === "Enter") {
      ev.preventDefault();
      ev.currentTarget.blur();
    } else if (ev.key === "Escape") {
      ev.currentTarget.value = this.detailTodo?.title || "";
      ev.currentTarget.blur();
    }
  }

  remove(id) {
    if (this.detailTodoId() === id) this.closeTodo();
    this._updateTodos((todos) => todos.filter((todo) => todo.id !== id));
  }

  clearCompleted() {
    if (this.detailTodo?.done) this.closeTodo();
    this._updateTodos((todos) => todos.filter((todo) => !todo.done));
  }

  // ── drag-and-drop resequencing ───────────────────────────────────────────────
  // Projects use the same live-reordering interaction as todo rows. Their order
  // is only persisted on drop; Escape restores the grab-time order.
  onListDragStart(ev, list) {
    const original = this.lists();
    const stop = startRowDrag(ev, {
      row: ev.target.closest(".todo-rail-item"),
      onMove: (e) => this._listDragMove(e, list.id),
      onEnd: (commit) => {
        this._dragStop = null;
        this.listDragId.set("");
        if (commit) this._save();
        else this.lists.set(original);
      },
    });
    if (!stop) return;
    this._dragStop = stop;
    this.listDragId.set(list.id);
  }

  _listDragMove(ev, id) {
    const rows = [...(this.railEl()?.querySelectorAll(".todo-rail-item") || [])];
    const to = dropIndex(
      ev,
      rows.filter((row) => row.dataset.listId !== id),
    );
    const lists = this.lists();
    const from = lists.findIndex((list) => list.id === id);
    if (from < 0 || from === to) return;
    const next = [...lists];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    this.lists.set(next);
  }

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

  // ── kanban drag-and-drop (move a card between columns) ───────────────────────
  // Same ghost/live-preview mechanism as the list drag, but the target is a
  // column (chosen by pointer X) rather than a row index: crossing into another
  // column live-restages the card there, and the vertical position within the
  // column reorders the shared todos array. Committed on drop, restored on Escape.
  // The whole card is the drag surface (a handle would leave most of the card
  // inert), so the card's own click can't open the details: startRowDrag calls
  // preventDefault on pointerdown, which suppresses the compatibility click.
  // Instead a press that never travels past a few pixels is treated as a click.
  onCardDragStart(ev, todo) {
    if (ev.target.closest(".todo-star, .todo-delete")) return; // their own clicks
    const original = this.list.todos; // grab-time order + stages, restored on Escape
    // the grab-time todo: every move re-derives the dragged card from THIS, so the
    // result depends only on where it lands. Deriving from the live todo instead
    // would let columns swept over on the way leave their stage behind (dragging
    // backlog → done across ongoing would strand status: "ongoing").
    this._dragOrigin = original.find((t) => t.id === todo.id);
    const from = { x: ev.clientX, y: ev.clientY };
    let moved = false;
    const stop = startRowDrag(ev, {
      row: ev.target.closest(".kanban-card"),
      onMove: (e) => {
        if (!moved && (Math.abs(e.clientX - from.x) > 4 || Math.abs(e.clientY - from.y) > 4))
          moved = true;
        if (moved) this._cardDragMove(e, todo.id);
      },
      onEnd: (commit) => {
        this._dragStop = null;
        this._dragOrigin = null;
        this.dragId.set("");
        this.dragOverStage.set("");
        if (!moved) return this.openTodo(todo.id); // a click, not a drag
        if (commit) this._save();
        else this._updateTodos(() => original);
      },
    });
    if (!stop) return;
    this._dragStop = stop;
    this.dragId.set(todo.id);
  }

  _cardDragMove(ev, id) {
    const cols = [...(this.boardEl()?.querySelectorAll(".kanban-col") || [])];
    // the column under the pointer (by X), else the nearest one so a drag that
    // strays past the board's edge still resolves to the closest column
    let col = cols.find((c) => {
      const r = c.getBoundingClientRect();
      return ev.clientX >= r.left && ev.clientX <= r.right;
    });
    if (!col && cols.length) {
      col = cols.reduce((best, c) => {
        const cx = (r) => r.left + r.width / 2;
        return Math.abs(cx(c.getBoundingClientRect()) - ev.clientX) <
          Math.abs(cx(best.getBoundingClientRect()) - ev.clientX)
          ? c
          : best;
      });
    }
    if (!col) return;
    const stage = col.dataset.stage;
    this.dragOverStage.set(stage);
    // insert index among the target column's OTHER cards (the dimmed dragged card
    // is excluded, as dropIndex expects)
    const cards = [...col.querySelectorAll(".kanban-card")].filter((c) => c.dataset.todoId !== id);
    const to = dropIndex(ev, cards);
    const todos = this.list.todos;
    const from = todos.findIndex((t) => t.id === id);
    if (from < 0) return;
    const moved = { ...(this._dragOrigin || todos[from]), ...this._stageFields(stage) };
    const without = todos.filter((t) => t.id !== id);
    // map the column-relative insert index to a global array index via the anchor
    // card it lands before (or the end of the column's run)
    const members = without.filter((t) => this.stageOf(t) === stage);
    let at;
    if (to >= members.length) {
      const last = members[members.length - 1];
      at = last ? without.findIndex((t) => t.id === last.id) + 1 : without.length;
    } else {
      at = without.findIndex((t) => t.id === members[to].id);
    }
    const next = [...without];
    next.splice(at, 0, moved);
    // skip the write when nothing actually changed (order + stage identical) — the
    // move fires on every pointermove, and a no-op set would churn the render
    const sig = (arr) => arr.map((t) => `${t.id}:${t.done ? 1 : 0}:${t.status || ""}`).join(",");
    if (sig(next) === sig(todos)) return;
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
