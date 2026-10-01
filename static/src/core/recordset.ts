// Generic components over the model layer — the capstone of the ORM rewrite (design
// doc §"Later: generic components over the models"). The insight: a generic view
// (list, form) shouldn't bind to a Model or an ORM Table, but to a *recordset* — a
// reactive list of rows + per-field column metadata. A computed view-model
// (BranchGroup) satisfies that interface by hand via `recordset()` below; binding
// to the interface, not the Table, is what lets a derived aggregate render
// without being materialized into a synced table.
//
//   Recordset  = { records(): Row[] (reactive), fields: FieldSpec[] }
//   FieldSpec  = { name, type?, label?, get?(row), set?(row, v), comodel?,
//                  component?, cellProps?(row), class?, title?(row), sortable? }
//              — `set` present ⇒ the cell is editable; a joined view can read one
//                model and write another (e.g. a star column reads a group, writes
//                AppState) — which a Table-bound component can't express.
//              — `component` (an Owl component class) renders a rich cell (links,
//                badges, action kebabs) via t-component; `cellProps(row)` builds its
//                props (default `{ row }`). It wins over get/set rendering.
//
// RecordList renders a recordset flat (one row per record, like an Odoo list view)
// or grouped: pass `groupBy` (row => group key) and each group renders under a
// group-header row — a natural home for group-level actions via the scoped
// `group-header` slot — with its records slightly indented beneath. Groups can be
// collapsible, the open/closed set persisted per `stateKey` in localStorage (a
// browser-side view preference, like the Workspaces categories).

import { Component, signal, xml, useProps, t } from "@odoo/owl";
import type { ComponentConstructor, Type } from "@odoo/owl";

// the row shape RecordList itself relies on: a stable id (the default row key)
export interface RecordRow {
  readonly id?: string | number;
}

// one column (see the FieldSpec description above). Methods (not arrow-typed
// properties) so a FieldSpec<SomeRow> is usable where a FieldSpec<RecordRow> is.
export interface FieldSpec<R = RecordRow> {
  name: string;
  type?: string; // "char" (default) | "bool" | "number" | "relation"
  label?: string;
  get?(row: R): unknown;
  set?(row: R, value: unknown): void;
  component?: ComponentConstructor;
  cellProps?(row: R): object;
  class?: string;
  title?(row: R): string;
  sortable?: boolean;
}

export interface Recordset<R = RecordRow> {
  records: () => R[];
  fields: FieldSpec<R>[];
}

// a relation cell's value: the target record (name() when it has one)
interface RelationValue {
  name?: () => unknown;
  id?: unknown;
}

// one rendered group: grouped mode's per-key bucket, or the single flat one
interface RecordGroup {
  key: string;
  label: string;
  rows: RecordRow[];
  collapsed: boolean;
}

// screen-owned header sorting state (see the `sort` prop below)
interface SortState {
  key: () => string;
  dir: () => string;
  toggle: (name: string) => void;
}

// ── adapters ──────────────────────────────────────────────────────────────────

// Hand-built recordset over a computed list of view-models (rows are plain objects
// with a stable `.id` + getters). The author supplies each FieldSpec fully — a `get`
// reading the underlying model signals (so reactivity is free), and an optional `set`
// that may write a *different* record than the row (config on a derived view).
export function recordset<R>(recordsFn: () => R[], specs: FieldSpec<R>[]): Recordset<R> {
  return { records: recordsFn, fields: specs };
}

// collapsed-group persistence (shared shape with the Workspaces categories: a
// plain JSON array of group keys under one localStorage key)
function savedCollapsed(stateKey: string | undefined): Set<string> {
  if (!stateKey) return new Set();
  try {
    const stored = JSON.parse(localStorage.getItem(stateKey) as string); // null parses to null
    return new Set(Array.isArray(stored) ? stored : []);
  } catch {
    return new Set();
  }
}

// ── the generic list component ─────────────────────────────────────────────────

// Renders any Recordset as a table: a column per FieldSpec, a row per record. A cell
// renders its FieldSpec `component` when set; else an input/checkbox when the field
// is editable (`set` present), else read-only text (a relation column shows the
// target record's name/id). Reactive for free — the getters read model signals, so
// an edit (or an upstream change) re-renders.
//
// Optional props:
//   rowKey      (row) => string    stable row identity (default: row.id)
//   rowClass    (row) => object    extra t-att-class on the row ({active, row-sel})
//   groupBy     (row) => key       grouped mode: one group per distinct key
//   groupLabel  (key, rows) => s   group-header fallback text (default: the key)
//   groupSort   (a, b) => number   comparator on {key, label, rows} (default:
//                                  first-occurrence order of records())
//   collapsible boolean            group headers get a caret; rows hide when closed
//   stateKey    string             localStorage key persisting the collapsed keys
//   sort        {key(), dir(), toggle(name)}  screen-owned header sorting: fields
//               with `sortable: true` render a clickable header + active arrow
//   slots       group-header       scoped slot (receives `g` = {key, label, rows,
//               collapsed}) replacing the label — the home for group actions
export class RecordList extends Component {
  // the t.any() props are typed for this class only — owl doesn't validate them
  props = useProps({
    recordset: t.any() as Type<Recordset>,
    rowKey: (t.any() as Type<(row: RecordRow) => string>).optional(),
    rowClass: (t.any() as Type<(row: RecordRow) => object | string>).optional(),
    groupBy: (t.any() as Type<(row: RecordRow) => unknown>).optional(),
    groupLabel: (t.any() as Type<(key: string, rows: RecordRow[]) => string>).optional(),
    groupSort: (t.any() as Type<(a: RecordGroup, b: RecordGroup) => number>).optional(),
    collapsible: t.boolean().optional(),
    stateKey: t.string().optional(),
    sort: (t.any() as Type<SortState>).optional(),
    slots: t.any().optional(),
  });

  static template = xml`
    <table class="br-table rl-table" t-att-class="{'rl-grouped': this.grouped}">
      <thead>
        <tr>
          <th t-foreach="this.fields" t-as="f" t-key="f.name"
              t-att-class="{'br-sort': this.sortable(f)}"
              t-on-click="() => this.onHeaderClick(f)">
            <t t-out="this.label(f)"/><span t-if="this.sortable(f)" class="br-arrow" t-out="this.sortArrow(f)"/>
          </th>
        </tr>
      </thead>
      <tbody t-foreach="this.groups" t-as="g" t-key="g.key" class="rl-group">
        <tr t-if="this.grouped" class="rl-group-head">
          <td t-att-colspan="this.fields.length">
            <div class="rl-group-cell">
              <button t-if="this.props.collapsible" class="rl-caret" t-att-class="{collapsed: g.collapsed}"
                      t-att-title="g.collapsed ? 'expand' : 'collapse'"
                      t-on-click="() => this.toggleGroup(g.key)"/>
              <t t-slot="group-header" g="g">
                <span class="rl-group-label" t-out="g.label"/>
                <span class="rl-group-count" t-out="'(' + g.rows.length + ')'"/>
              </t>
            </div>
          </td>
        </tr>
        <t t-if="!g.collapsed">
          <tr t-foreach="g.rows" t-as="row" t-key="this.rowKey(row)" class="rl-row" t-att-class="this.rowClass(row)">
            <td t-foreach="this.fields" t-as="f" t-key="f.name"
                t-att-class="this.cellClass(f)" t-att-title="f.title ? f.title(row) : undefined">
              <t t-if="f.component" t-component="f.component" t-props="this.cellProps(f, row)"/>
              <input t-elif="f.set and f.type === 'bool'" type="checkbox"
                     t-att-checked="this.val(f, row)"
                     t-on-change="(ev) => this.write(f, row, ev.target.checked)"/>
              <input t-elif="f.set" t-att-type="f.type === 'number' ? 'number' : 'text'"
                     t-att-value="this.val(f, row)"
                     t-on-input="(ev) => this.write(f, row, ev.target.value)"/>
              <span t-else="" t-out="this.display(f, row)"/>
            </td>
          </tr>
        </t>
      </tbody>
    </table>`;

  // collapsed group keys; seeded from localStorage when a stateKey is given
  collapsed = signal(savedCollapsed(this.props.stateKey));

  get fields(): FieldSpec[] {
    return this.props.recordset.fields;
  }

  get grouped(): boolean {
    return !!this.props.groupBy;
  }

  // the render model: grouped → [{key, label, rows, collapsed}] in first-occurrence
  // order (or props.groupSort); flat → one anonymous group holding every record
  get groups(): RecordGroup[] {
    const rows = this.props.recordset.records();
    if (!this.grouped) return [{ key: "__flat__", label: "", rows, collapsed: false }];
    const map = new Map<string, RecordRow[]>();
    for (const row of rows) {
      const key = String(this.props.groupBy!(row)); // set: this.grouped
      (map.get(key) || map.set(key, []).get(key)!).push(row);
    }
    const collapsed = this.collapsed();
    const groups = [...map.entries()].map(([key, rows]) => ({
      key,
      label: this.props.groupLabel ? this.props.groupLabel(key, rows) : key,
      rows,
      collapsed: !!this.props.collapsible && collapsed.has(key),
    }));
    if (this.props.groupSort) groups.sort(this.props.groupSort);
    return groups;
  }

  toggleGroup(key: string) {
    const next = new Set(this.collapsed());
    if (!next.delete(key)) next.add(key);
    this.collapsed.set(next);
    if (!this.props.stateKey) return;
    try {
      localStorage.setItem(this.props.stateKey, JSON.stringify([...next]));
    } catch {
      /* browser storage can be disabled; the in-memory preference still works */
    }
  }

  rowKey(row: RecordRow) {
    return this.props.rowKey ? this.props.rowKey(row) : row.id;
  }

  rowClass(row: RecordRow) {
    return this.props.rowClass ? this.props.rowClass(row) : "";
  }

  label(f: FieldSpec) {
    return f.label === undefined ? f.name : f.label;
  }

  // ── header sorting (state owned by the screen via props.sort) ──
  sortable(f: FieldSpec): boolean {
    return !!(f.sortable && this.props.sort);
  }

  onHeaderClick(f: FieldSpec) {
    if (this.sortable(f)) this.props.sort!.toggle(f.name); // sortable(f) ⇒ props.sort
  }

  // " ▲" / " ▼" for the active sort column, else ""
  sortArrow(f: FieldSpec): string {
    const sort = this.props.sort;
    if (!sort || sort.key() !== f.name) return "";
    return sort.dir() === "asc" ? " ▲" : " ▼";
  }

  // ── cells ──
  cellClass(f: FieldSpec): string {
    return `rec-${f.type || "char"}${f.class ? " " + f.class : ""}`;
  }

  cellProps(f: FieldSpec, row: RecordRow): object {
    return f.cellProps ? f.cellProps(row) : { row };
  }

  // val/display render a FieldSpec without a `component`, which always has a `get`
  val(f: FieldSpec, row: RecordRow): unknown {
    return f.get!(row);
  }

  // read-only cell text — a relation shows the target's name (or id), else the value
  display(f: FieldSpec, row: RecordRow): unknown {
    const v = f.get!(row);
    if (f.type === "relation") {
      const rel = v as RelationValue | null | undefined; // a relation's get() returns a record
      return rel ? (rel.name ? rel.name() : (rel.id ?? "")) : "—";
    }
    if (v === null || v === undefined || v === "") return "—";
    return v;
  }

  // only bound on editable cells (`f.set` present)
  write(f: FieldSpec, row: RecordRow, raw: string | boolean) {
    f.set!(row, f.type === "number" ? Number(raw) : raw);
  }
}
