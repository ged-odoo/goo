// Generic components over the model layer — the capstone of the ORM rewrite (design
// doc §"Later: generic components over the models"). The insight: a generic view
// (list, form) shouldn't bind to a Model or an ORM Table, but to a *recordset* — a
// reactive list of rows + per-field column metadata. A real owl-orm Model is the
// canonical recordset (auto-adapter below), but a computed view-model (BranchGroup,
// TargetView) satisfies the same interface by hand — so the same component renders
// both. Binding to the interface, not the Table, is what lets a derived aggregate
// render without being materialized into a synced table.
//
//   Recordset  = { records(): Row[] (reactive), fields: FieldSpec[] }
//   FieldSpec  = { name, type, label?, get(row), set?(row, v), comodel? }
//              — `set` present ⇒ the cell is editable; a joined view can read one
//                model and write another (e.g. a star column reads a group, writes
//                AppState) — which a Table-bound component can't express.
//
// This pass ships the interface + adapters + one generic RecordList, exercised
// standalone (over a real Model recordset AND a view-model recordset). Wiring it into
// the production screens — and promoting the observed/runtime json payloads to real
// fields so their screens render through here — is the follow-on.

const { Component, xml, props, t } = owl;

// ── adapters ──────────────────────────────────────────────────────────────────

// Auto-adapter over a real owl-orm model: rows are the model's records, and each
// FieldSpec's get/set default to the field accessor (`row.name()` / `row.name.set`).
// A spec can override get/set, mark itself readonly, or set a type/label/comodel.
// `specs` items: { name, type?, label?, get?, set?, readonly?, comodel? }.
export function modelRecordset(orm, Model, specs) {
  return {
    records: () => orm.records(Model),
    fields: specs.map((s) => {
      const name = s.name;
      const field = {
        name,
        type: s.type || "char",
        label: s.label ?? name,
        comodel: s.comodel,
        get: s.get || ((row) => row[name]()),
      };
      // editable unless explicitly readonly or a custom getter (a derived column):
      // an explicit `set` always wins.
      if (s.set) field.set = s.set;
      else if (!s.readonly && !s.get) field.set = (row, v) => row[name].set(v);
      return field;
    }),
  };
}

// Hand-built recordset over a computed list of view-models (rows are plain objects
// with a stable `.id` + getters). The author supplies each FieldSpec fully — a `get`
// reading the underlying model signals (so reactivity is free), and an optional `set`
// that may write a *different* record than the row (config on a derived view).
export function recordset(recordsFn, specs) {
  return { records: recordsFn, fields: specs };
}

// ── the generic list component ─────────────────────────────────────────────────

// Renders any Recordset as a table: a column per FieldSpec, a row per record. A cell
// is an input/checkbox when the field is editable (`set` present), else read-only
// text; a relation column shows the target record's name/id. Reactive for free — the
// getters read model signals, so an edit (or an upstream change) re-renders.
export class RecordList extends Component {
  props = props({ recordset: t.any() });
  static template = xml`
    <table class="rec-table">
      <thead>
        <tr><th t-foreach="this.fields" t-as="f" t-key="f.name" t-out="f.label"/></tr>
      </thead>
      <tbody>
        <tr t-foreach="this.rows" t-as="row" t-key="row.id">
          <td t-foreach="this.fields" t-as="f" t-key="f.name" t-att-class="'rec-' + f.type">
            <input t-if="f.set and f.type === 'bool'" type="checkbox"
                   t-att-checked="this.val(f, row)"
                   t-on-change="(ev) => this.write(f, row, ev.target.checked)"/>
            <input t-elif="f.set" t-att-type="f.type === 'number' ? 'number' : 'text'"
                   t-att-value="this.val(f, row)"
                   t-on-input="(ev) => this.write(f, row, ev.target.value)"/>
            <span t-else="" t-out="this.display(f, row)"/>
          </td>
        </tr>
      </tbody>
    </table>`;

  get fields() {
    return this.props.recordset.fields;
  }

  get rows() {
    return this.props.recordset.records();
  }

  val(f, row) {
    return f.get(row);
  }

  // read-only cell text — a relation shows the target's name (or id), else the value
  display(f, row) {
    const v = f.get(row);
    if (f.type === "relation") return v ? (v.name ? v.name() : (v.id ?? "")) : "—";
    if (v === null || v === undefined || v === "") return "—";
    return v;
  }

  write(f, row, raw) {
    f.set(row, f.type === "number" ? Number(raw) : raw);
  }
}
