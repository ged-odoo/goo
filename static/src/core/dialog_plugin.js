// Dialog system. A single app-level plugin owns the list of open dialogs; a
// minimal container component (mounted once as an Owl "root" at a location the
// main app exposes via t-ref) renders them. Because it is a plugin, *any*
// plugin or component can open a dialog — `usePlugin(DialogPlugin)` then
// `.add(Component, props)` (or the `.open(spec)` / `.openComponent(C, props)`
// promise-based conveniences).

import {
  Plugin,
  Component,
  xml,
  usePlugin,
  signal,
  useApp,
  useEffect,
  onMounted,
  onWillUnmount,
  useProps,
  t,
} from "@odoo/owl";

let _seq = 0;

// ─────────────────────────── Dialog plugin ───────────────────────────

export class DialogPlugin extends Plugin {
  dialogs = signal.Array([]);
  // the mount location for the dialog container. Owned here; the main app binds
  // it with t-ref (via `usePlugin(DialogPlugin).root`) to a DOM node, and the
  // effect below mounts the container there once it exists.
  root = signal.ref(HTMLElement);

  setup() {
    const app = useApp();
    // once the host node exists (the app's t-ref has populated the signal),
    // mount the container as a root there. useEffect re-runs when root() changes
    // and tears the root down via the returned cleanup (on re-run and on destroy).
    useEffect(() => {
      const target = this.root();
      if (!target) return;
      const root = app.createRoot(DialogContainer);
      root.mount(target);
      return () => root.destroy();
    });
  }

  // low-level: mount component `C` with `props`. Returns a handle whose
  // `close()` removes the dialog. Each dialog gets a unique id.
  add(C, props = {}) {
    const id = ++_seq;
    const close = () => this.dialogs.set(this.dialogs().filter((d) => d.id !== id));
    this.dialogs.set([...this.dialogs(), { id, Component: C, props }]);
    return { id, close };
  }

  // promise-based: mount `C`, inject a `done(result)` prop that closes the
  // dialog and resolves the promise with `result`.
  openComponent(C, props = {}) {
    return new Promise((resolve) => {
      const handle = this.add(C, {
        ...props,
        done: (result) => {
          handle.close();
          resolve(result);
        },
      });
    });
  }

  // the common case: a form/message dialog (see Dialog's spec shape below).
  // Resolves to the field values on OK, or null when discarded/escaped.
  open(spec) {
    return this.openComponent(Dialog, { spec });
  }
}

// ─────────────────────────── Container ───────────────────────────

// Mounted once as a root; renders every open dialog. `dialog.Component` is a
// component class, so t-component uses it directly (no static.components needed).
class DialogContainer extends Component {
  static template = xml`
    <div>
      <t t-foreach="this.dialogs()" t-as="dialog" t-key="dialog.id">
        <t t-component="dialog.Component" t-props="dialog.props"/>
      </t>
    </div>`;

  dialogs = usePlugin(DialogPlugin).dialogs;
}

// ─────────────────────────── Generic dialog ───────────────────────────

// A form/message modal. Spec: { title, message?, okLabel?, cancelLabel?, cls?,
// validate?(values) => errorString, fields: [{ key, type: "text"|"checkbox"|
// "select"|"check-select", label, value, placeholder?, options?, onChange?,
// default? }] }. A "check-select" is a checkbox with an inline select that shows
// only when ticked; its value is "" (off) or the chosen option, seeded from
// default(values) on tick. validate() runs
// live: a non-empty result disables the OK button (and, once the user has edited a
// field, shows the message), so an invalid form can't be submitted. cancelLabel:
// null hides the Discard button (e.g. for a plain message/alert). Closes itself by
// calling the `done(result)` prop injected by openComponent().

export class Dialog extends Component {
  static template = xml`
    <div class="dialog-backdrop" t-on-click="() => this.done(null)">
      <div class="dialog" t-att-class="this.spec.cls || ''" t-on-click.stop="() => {}">
        <h2 class="dialog-title" t-out="this.spec.title"/>
        <div class="dialog-body" data-form-type="other">
          <p t-if="this.spec.message" class="dialog-msg" t-out="this.spec.message"/>
          <div t-foreach="this.spec.fields || []" t-as="f" t-key="f.key" class="dialog-field">
            <label t-if="f.type === 'checkbox'" class="edit-check">
              <input type="checkbox" t-att-checked="this.values()[f.key]" t-on-change="(ev) => this.setVal(f.key, ev.target.checked)"/>
              <t t-out="f.label"/>
            </label>
            <t t-elif="f.type === 'select'">
              <label t-out="f.label"/>
              <select t-on-change="(ev) => this.setVal(f.key, ev.target.value)">
                <option value=""><t t-out="f.placeholder || '— none —'"/></option>
                <t t-foreach="f.options || []" t-as="opt" t-key="opt.value">
                  <option t-att-value="opt.value" t-att-selected="this.values()[f.key] === opt.value" t-out="opt.label"/>
                </t>
              </select>
            </t>
            <div t-elif="f.type === 'check-select'" class="dialog-check-select">
              <label class="edit-check">
                <input type="checkbox" t-att-checked="!!this.values()[f.key]" t-on-change="(ev) => this.toggleCheckSelect(f, ev.target.checked)"/>
                <t t-out="f.label"/>
              </label>
              <select t-if="this.values()[f.key]" t-on-change="(ev) => this.setVal(f.key, ev.target.value)">
                <t t-foreach="f.options || []" t-as="opt" t-key="opt.value">
                  <option t-att-value="opt.value" t-att-selected="this.values()[f.key] === opt.value" t-out="opt.label"/>
                </t>
              </select>
            </div>
            <t t-else="">
              <label t-out="f.label"/>
              <input type="text" t-att-value="this.values()[f.key]" t-att-placeholder="f.placeholder || ''" t-on-input="(ev) => this.setVal(f.key, ev.target.value)" t-on-keydown="(ev) => this.onKey(ev)"/>
            </t>
          </div>
        </div>
        <div class="dialog-foot">
          <span t-if="this.touched() and this.liveError" class="form-error" t-out="this.liveError"/>
          <button class="pbtn primary" t-att-disabled="!!this.liveError" t-on-click="() => this.ok()" t-out="this.spec.okLabel || 'OK'"/>
          <button t-if="this.spec.cancelLabel !== null" class="pbtn" t-on-click="() => this.done(null)" t-out="this.spec.cancelLabel || 'Discard'"/>
        </div>
      </div>
    </div>`;

  props = useProps({ spec: t.any(), done: t.function() });
  values = signal({});
  touched = signal(false); // has the user edited a field? (gates the inline error)

  get spec() {
    return this.props.spec;
  }

  // the current form's validation error ("" when valid). Reactive on `values`, so
  // it both disables the primary button and (once edited) shows the message —
  // an invalid form (e.g. a duplicate target name) can't be submitted at all.
  get liveError() {
    return this.spec.validate ? this.spec.validate(this.values()) : "";
  }

  setup() {
    const vals = {};
    for (const f of this.spec.fields || [])
      vals[f.key] = f.value ?? (f.type === "checkbox" ? false : "");
    this.values.set(vals);
    const onKey = (e) => {
      if (e.key === "Escape") this.done(null);
    };
    document.addEventListener("keydown", onKey);
    onWillUnmount(() => document.removeEventListener("keydown", onKey));
    onMounted(() => {
      // focus + select the first text field once rendered
      const inp = document.querySelector(".dialog input[type=text]");
      if (inp) {
        inp.focus();
        inp.select();
      }
    });
  }

  done(result) {
    this.props.done(result);
  }

  setVal(key, v) {
    const oldValues = this.values();
    let values = { ...oldValues, [key]: v };
    const field = this.spec.fields.find((f) => f.key === key);
    if (field && field.onChange) {
      const updates = field.onChange(v, values, oldValues);
      if (updates) values = { ...values, ...updates };
    }
    this.values.set(values);
    this.touched.set(true);
  }

  // a "check-select" field's value is "" (unchecked) or the selected option. Ticking
  // it on seeds a sensible choice — field.default(values), else the first option — so
  // the revealed select isn't empty; unticking clears it back to "".
  toggleCheckSelect(field, checked) {
    if (!checked) return this.setVal(field.key, "");
    const seed = typeof field.default === "function" ? field.default(this.values()) : field.default;
    this.setVal(field.key, seed || field.options?.[0]?.value || "");
  }

  onKey(ev) {
    if (ev.key === "Enter") this.ok();
  }

  ok() {
    // Enter can still reach here while invalid (the button is disabled, not the
    // keystroke) — guard, and reveal the message if it was hidden.
    if (this.liveError) return this.touched.set(true);
    this.done({ ...this.values() });
  }
}
