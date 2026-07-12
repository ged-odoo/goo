import { Component, signal, xml } from "@odoo/owl";
import { ICONS, m } from "../core/common.js";
import { Panel } from "../core/panel.js";

const STORAGE_KEY = "oo-todos";

function storedTodos() {
  try {
    const items = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(items)
      ? items.filter(
          (item) => item && typeof item.id === "string" && typeof item.title === "string",
        )
      : [];
  } catch {
    return [];
  }
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
        <div class="todo-card">
          <div t-if="!this.todos().length" class="todo-empty">
            <span class="todo-empty-icon"><t t-out="this.todoIcon"/></span>
            <span>No todos yet.</span>
          </div>
          <div t-else="" class="todo-list">
            <div t-foreach="this.todos()" t-as="todo" t-key="todo.id" class="todo-row"
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
    </section>`;

  todos = signal(storedTodos());
  draft = signal("");
  newTodo = signal.ref(HTMLInputElement);
  todoIcon = m(ICONS.todo);

  get completedCount() {
    return this.todos().filter((todo) => todo.done).length;
  }

  get summary() {
    const total = this.todos().length;
    const open = total - this.completedCount;
    return `${open} open · ${total} total`;
  }

  add() {
    const title = this.draft().trim();
    if (!title) return;
    this._set([
      ...this.todos(),
      { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, title, done: false },
    ]);
    this.draft.set("");
    this.newTodo()?.focus();
  }

  toggle(id) {
    this._set(this.todos().map((todo) => (todo.id === id ? { ...todo, done: !todo.done } : todo)));
  }

  remove(id) {
    this._set(this.todos().filter((todo) => todo.id !== id));
  }

  clearCompleted() {
    this._set(this.todos().filter((todo) => !todo.done));
  }

  _set(todos) {
    this.todos.set(todos);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
  }
}
