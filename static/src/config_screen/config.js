import {
  Component,
  onMounted,
  onWillUnmount,
  usePlugin,
  useProps,
  signal,
  t,
  xml,
} from "@odoo/owl";
import { PRESETS } from "../core/presets.js";
import { ConfigPlugin, newWorkspaceId } from "../core/config_plugin.js";
import { DialogPlugin } from "../core/dialog_plugin.js";
import { EventLogPlugin } from "../core/event_log_plugin.js";
import { UpdatePlugin } from "../core/update_plugin.js";
import { ICONS, NAV, m, mergedTabIds } from "../core/common.js";
import { startRowDrag, dropIndex } from "../core/drag.js";
import { postJSON, repoBranchList } from "../core/utils.js";
import { Panel } from "../core/panel.js";

export class ListEditor extends Component {
  static template = xml`
    <div class="config-block">
      <h2 class="subtitle" t-out="this.spec.title"/>
      <div class="rows" data-form-type="other" t-ref="this.rowsEl">
        <t t-if="this.spec.card">
          <div t-foreach="this.rows()" t-as="row" t-key="row_index" class="edit-card">
            <button class="row-remove edit-card-remove" title="remove" t-on-click="() => this.removeRow(row_index)">✕</button>
            <div t-foreach="this.cardRows" t-as="fields" t-key="fields_index" class="edit-card-row">
              <t t-foreach="fields" t-as="f" t-key="f.key">
                <label t-if="f.type === 'checkbox'" class="edit-check" t-att-title="f.title || f.name">
                  <input type="checkbox" t-att-checked="row[f.key]" t-on-change="ev => { row[f.key] = ev.target.checked; this.saveAuto(); }"/>
                  <t t-out="f.name"/>
                </label>
                <label t-else="" class="edit-field" t-att-class="f.className" t-att-title="f.title">
                  <span class="edit-field-name" t-out="f.name"/>
                  <input t-att-placeholder="f.placeholder" t-att-value="row[f.key]"
                         t-on-input="ev => row[f.key] = ev.target.value"
                         t-on-change="() => this.saveAuto()"/>
                </label>
              </t>
            </div>
          </div>
        </t>
        <div t-if="!this.spec.card" t-foreach="this.rows()" t-as="row" t-key="row_index" class="edit-row"
             t-att-class="{dragging: this.dragIndex() === row_index}">
          <span t-if="this.spec.reorderable" class="row-handle" title="drag to reorder"
                t-on-pointerdown="ev => this.onDragStart(ev, row_index)">⠿</span>
          <t t-foreach="this.spec.fields" t-as="f" t-key="f.key">
            <label t-if="f.type === 'checkbox'" class="edit-check" t-att-title="f.title || f.name">
              <input type="checkbox" t-att-checked="row[f.key]" t-on-change="ev => { row[f.key] = ev.target.checked; this.saveAuto(); }"/>
              <t t-out="f.name"/>
            </label>
            <input t-else="" t-att-class="f.className" t-att-placeholder="f.placeholder"
                   t-att-title="f.title" t-att-value="row[f.key]"
                   t-on-input="ev => row[f.key] = ev.target.value"
                   t-on-change="() => this.saveAuto()"/>
          </t>
          <button class="row-remove" title="remove" t-on-click="() => this.removeRow(row_index)">✕</button>
        </div>
      </div>
      <div class="config-actions">
        <button t-on-click="() => this.addRow()" t-out="'Add ' + this.spec.itemName"/>
        <span t-att-class="this.msgCls()" t-out="this.msgText()"/>
      </div>
    </div>`;

  props = useProps({ kind: t.string() });
  config = usePlugin(ConfigPlugin);
  spec = SPECS[this.props.kind];
  rows = signal([]);
  rowsEl = signal.ref(HTMLElement);
  msgText = signal("");
  msgCls = signal("");
  dragIndex = signal(-1); // row being dragged (-1 = none); only set for reorderable specs
  setup() {
    this.load();
    // never leak the drag ghost / window listeners if we unmount mid-drag
    onWillUnmount(() => this._dragStop?.(true));
  }

  // card layout: the spec's fields grouped by their `row` (default 1), order kept
  get cardRows() {
    const rows = new Map();
    for (const f of this.spec.fields) {
      const r = f.row || 1;
      if (!rows.has(r)) rows.set(r, []);
      rows.get(r).push(f);
    }
    return [...rows.values()];
  }

  // shared pointer drag (core/drag.js): ghost follows the cursor, the dimmed
  // row live-reorders under it; drop persists, Escape restores the grab order
  onDragStart(ev, i) {
    const original = this.rows(); // grab-time order, restored on Escape
    const stop = startRowDrag(ev, {
      row: ev.target.closest(".edit-row"),
      onMove: (e) => this._dragMove(e),
      onEnd: (commit) => {
        this._dragStop = null;
        this.dragIndex.set(-1);
        if (commit) this.saveAuto();
        else this.rows.set(original);
      },
    });
    if (!stop) return;
    this._dragStop = stop;
    this.dragIndex.set(i);
  }

  _dragMove(ev) {
    const from = this.dragIndex();
    if (from < 0) return;
    const others = [...(this.rowsEl()?.querySelectorAll(".edit-row") || [])].filter(
      (r) => !r.classList.contains("dragging"),
    );
    const to = dropIndex(ev, others);
    if (to === from) return;
    const next = [...this.rows()];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    this.rows.set(next); // in memory only — persisted once, on drop
    this.dragIndex.set(to);
  }

  load() {
    this.rows.set(
      this.config.config[this.spec.key].map((item) => {
        const r = {};
        for (const f of this.spec.fields)
          r[f.key] =
            f.type === "checkbox"
              ? !!item[f.key]
              : f.format
                ? f.format(item[f.key])
                : item[f.key] || "";
        // non-edited keys that must survive a round-trip (e.g. a record id)
        for (const k of this.spec.carry || []) r[k] = item[k];
        return r;
      }),
    );
  }

  addRow() {
    const r = {};
    for (const f of this.spec.fields) r[f.key] = f.default ?? "";
    this.rows.set([...this.rows(), r]);
  }

  removeRow(i) {
    this.rows.set(this.rows().filter((_, j) => j !== i));
    this.saveAuto();
  }

  flash(text, isError) {
    this.msgText.set(text);
    this.msgCls.set(isError ? "error" : "ok");
    if (!isError) setTimeout(() => this.msgText.set(""), 2000);
  }

  // auto-save: silently skips rows with incomplete required fields so mid-edit
  // keystrokes don't flash errors; still surfaces spec-level errors (e.g. missing
  // "community" repo) and duplicate-key errors.
  saveAuto() {
    const items = [];
    const seen = new Set();
    for (const row of this.rows()) {
      const raw = {};
      for (const f of this.spec.fields)
        raw[f.key] = f.type === "checkbox" ? !!row[f.key] : (row[f.key] || "").trim();
      if (this.spec.fields.every((f) => !raw[f.key])) continue; // skip blank rows
      if (this.spec.fields.some((f) => !f.optional && !raw[f.key])) continue; // skip incomplete rows silently
      const keyVal = raw[this.spec.fields[0].key];
      if (seen.has(keyVal)) return; // duplicate — abort silently
      seen.add(keyVal);
      const item = {};
      for (const f of this.spec.fields) item[f.key] = f.parse ? f.parse(raw[f.key]) : raw[f.key];
      for (const k of this.spec.carry || []) if (row[k]) item[k] = row[k];
      if (this.spec.prepare) this.spec.prepare(item);
      items.push(item);
    }
    const err = this.spec.validate(items, this.config.config);
    if (err) return this.flash(err, true);
    this.msgText.set("");
    this.config.updateConfig({ [this.spec.key]: items });
  }
}

// Show/hide and reorder the sidebar tabs. Stored in config.tabs as [{id, visible}]
// in display order; NAV is the source of tab metadata (label/icon) and defaults.

export class TabsEditor extends Component {
  static template = xml`
    <div class="config-block">
      <h2 class="subtitle">Tabs</h2>
      <p class="dim">Show, hide and reorder the sidebar tabs (drag the handle to reorder).</p>
      <div class="rows" data-form-type="other" t-ref="this.rowsEl">
        <div t-foreach="this.viewRows" t-as="row" t-key="row.id" class="edit-row"
             t-att-class="{dragging: this.dragId() === row.id}">
          <span class="row-handle" title="drag to reorder"
                t-on-pointerdown="ev => this.onDragStart(ev, row)">⠿</span>
          <label class="tab-row">
            <input type="checkbox" t-att-checked="row.visible" t-att-disabled="row.id === 'config'"
                   t-att-title="row.id === 'config' ? 'the Configuration tab is always shown' : ''"
                   t-on-change="ev => this.toggle(row.id, ev.target.checked)"/>
            <t t-out="row.label"/>
          </label>
        </div>
      </div>
    </div>`;

  config = usePlugin(ConfigPlugin);
  rowsEl = signal.ref(HTMLElement);
  dragId = signal(""); // id of the tab row being dragged ("" = none)
  // drag-time order override: `rows` derives from config, which must only be
  // written once (on drop) — during the drag the template renders this instead
  dragRows = signal(null);

  setup() {
    onWillUnmount(() => this._dragStop?.(true));
  }

  get viewRows() {
    return this.dragRows() || this.rows;
  }

  // configured order, with any NAV tab missing from config slotted in at its
  // natural position (see mergedTabIds, so a newly-added tab shows up next to its
  // neighbours). Config is always visible; new tabs default to visible.
  get rows() {
    const meta = Object.fromEntries(NAV.map((n) => [n.id, n]));
    const configured = this.config.config.tabs || [];
    const cfg = Object.fromEntries(configured.map((t) => [t.id, t]));
    // unconfigured tabs default visible, except opt-in ones (Worktrees) which start off
    return mergedTabIds(configured).map((id) => ({
      id,
      label: meta[id].label,
      visible: id === "config" ? true : cfg[id] ? cfg[id].visible !== false : !meta[id].optIn,
    }));
  }

  _save(rows) {
    this.config.updateConfig({ tabs: rows.map((r) => ({ id: r.id, visible: r.visible })) });
  }

  toggle(id, visible) {
    if (id === "config") return; // can't hide Config (no way back otherwise)
    this._save(this.rows.map((r) => (r.id === id ? { ...r, visible } : r)));
  }

  // shared pointer drag (core/drag.js): ghost follows the cursor, the dimmed
  // row live-reorders under it; drop writes the order to config once
  onDragStart(ev, row) {
    const stop = startRowDrag(ev, {
      row: ev.target.closest(".edit-row"),
      onMove: (e) => this._dragMove(e),
      onEnd: (commit) => {
        this._dragStop = null;
        const rows = this.dragRows();
        this.dragId.set("");
        this.dragRows.set(null);
        if (commit && rows) this._save(rows);
      },
    });
    if (!stop) return;
    this._dragStop = stop;
    this.dragRows.set(this.rows);
    this.dragId.set(row.id);
  }

  _dragMove(ev) {
    const cur = this.dragRows();
    if (!cur) return;
    const others = [...(this.rowsEl()?.querySelectorAll(".edit-row") || [])].filter(
      (r) => !r.classList.contains("dragging"),
    );
    const to = dropIndex(ev, others);
    const from = cur.findIndex((r) => r.id === this.dragId());
    if (from < 0 || from === to) return;
    const next = [...cur];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    this.dragRows.set(next);
  }
}

// Navbar links editor — a depth-1 tree. Top-level rows are links or menus; a menu
// holds links. Drag the handle to reorder within a level, drop a link onto a menu's
// body to move it inside (or onto a row to place it before that row). Saved to
// config.links as [{label, href} | {label, children:[{label, href}]}]. Editor-only
// `_id`s give drag/drop a stable identity and are stripped on save.

export class LinksEditor extends Component {
  static template = xml`
    <div class="config-block links-editor">
      <h2 class="subtitle">Navbar links</h2>
      <p class="dim">Drag the handle to reorder. Drop a link onto a menu to put it inside. Menus show as dropdowns in the top bar.</p>
      <div class="links-tree" data-form-type="other">
        <t t-foreach="this.items()" t-as="it" t-key="it._id">
          <div t-if="this.isMenu(it)" class="link-menu">
            <div class="edit-row link-menu-head" t-att-data-id="it._id"
                 t-att-class="{dragging: this.dragId() === it._id, 'drag-over': this.overId() === it._id}">
              <span class="row-handle" title="drag to reorder"
                    t-on-pointerdown="ev => this.onDragStart(ev, it._id)">⠿</span>
              <span class="link-menu-caret">▾</span>
              <input class="w-flex" placeholder="menu name" t-att-value="it.label"
                     t-on-input="ev => this.edit(it, 'label', ev.target.value)" t-on-change="() => this.save()"/>
              <span class="link-menu-tag">menu</span>
              <button class="row-remove" title="remove menu" t-on-click="() => this.remove(it._id)">✕</button>
            </div>
            <div class="link-menu-body" t-att-data-menu-id="it._id" t-att-class="{'drag-over': this.overInto() === it._id}">
              <div t-foreach="it.children" t-as="c" t-key="c._id" class="edit-row link-child" t-att-data-id="c._id"
                   t-att-class="{dragging: this.dragId() === c._id, 'drag-over': this.overId() === c._id}">
                <span class="row-handle" title="drag to move"
                      t-on-pointerdown="ev => this.onDragStart(ev, c._id)">⠿</span>
                <input class="w-name" placeholder="label" t-att-value="c.label"
                       t-on-input="ev => this.edit(c, 'label', ev.target.value)" t-on-change="() => this.save()"/>
                <input class="w-flex" placeholder="href (https://…)" t-att-value="c.href"
                       t-on-input="ev => this.edit(c, 'href', ev.target.value)" t-on-change="() => this.save()"/>
                <button class="row-remove" title="remove" t-on-click="() => this.remove(c._id)">✕</button>
              </div>
              <button class="link-add-child" t-on-click="() => this.addLink(it._id)">+ link</button>
            </div>
          </div>
          <div t-else="" class="edit-row link-row" t-att-data-id="it._id"
               t-att-class="{dragging: this.dragId() === it._id, 'drag-over': this.overId() === it._id}">
            <span class="row-handle" title="drag to reorder / into a menu"
                  t-on-pointerdown="ev => this.onDragStart(ev, it._id)">⠿</span>
            <input class="w-name" placeholder="label" t-att-value="it.label"
                   t-on-input="ev => this.edit(it, 'label', ev.target.value)" t-on-change="() => this.save()"/>
            <input class="w-flex" placeholder="href (https://…)" t-att-value="it.href"
                   t-on-input="ev => this.edit(it, 'href', ev.target.value)" t-on-change="() => this.save()"/>
            <button class="row-remove" title="remove" t-on-click="() => this.remove(it._id)">✕</button>
          </div>
        </t>
        <div t-if="this.dragId()" class="links-drop-end" t-att-class="{'drag-over': this.overEnd()}">move here for top level</div>
      </div>
      <div class="config-actions">
        <button t-on-click="() => this.addLink(null)">Add link</button>
        <button t-on-click="() => this.addMenu()">Add menu</button>
      </div>
    </div>`;

  config = usePlugin(ConfigPlugin);
  items = signal([]); // [{label, href, _id} | {label, children:[{label, href, _id}], _id}]
  dragId = signal(0); // _id of the dragged row (0 = none)
  overId = signal(0); // row hovered as a "drop before" target
  overInto = signal(0); // menu whose body is hovered (drop inside)
  overEnd = signal(false); // trailing "top level" zone hovered
  _nextId = 1;

  setup() {
    this.load();
    // never leak the drag ghost / window listeners if we unmount mid-drag
    onWillUnmount(() => this._dragStop?.(true));
  }

  isMenu(n) {
    return Array.isArray(n.children);
  }

  load() {
    this._nextId = 1;
    this.items.set(
      (this.config.config.links || []).map((n) => {
        const node = { ...n, _id: this._nextId++ };
        if (this.isMenu(n)) node.children = n.children.map((c) => ({ ...c, _id: this._nextId++ }));
        return node;
      }),
    );
  }

  // mutate a node field in place (no re-render → no cursor jump); persisted on change
  edit(node, key, value) {
    node[key] = value;
  }

  addLink(menuId) {
    const items = this.items();
    const link = { label: "", href: "", _id: this._nextId++ };
    if (menuId) {
      const menu = items.find((n) => n._id === menuId && this.isMenu(n));
      if (menu) menu.children.push(link);
    } else {
      items.push(link);
    }
    this.items.set([...items]);
  }

  addMenu() {
    this.items.set([...this.items(), { label: "", children: [], _id: this._nextId++ }]);
  }

  remove(id) {
    const items = this.items();
    const loc = this._locate(items, id);
    if (loc) loc.container.splice(loc.index, 1);
    this.items.set([...items]);
    this.save();
  }

  // {container, index, node} for the row with `id`, searching the top level then
  // every menu's children; null if not found
  _locate(items, id) {
    const i = items.findIndex((n) => n._id === id);
    if (i >= 0) return { container: items, index: i, node: items[i] };
    for (const it of items) {
      if (this.isMenu(it)) {
        const ci = it.children.findIndex((c) => c._id === id);
        if (ci >= 0) return { container: it.children, index: ci, node: it.children[ci] };
      }
    }
    return null;
  }

  // Shared pointer drag (core/drag.js): the grabbed row lifts into a ghost
  // that follows the cursor. Unlike the flat editors there's no live reorder —
  // three distinct drop targets exist (before a row, into a menu's body, the
  // trailing top-level zone), so moving keeps the highlight semantics: the
  // pointer is hit-tested (the ghost is pointer-events:none, so
  // elementFromPoint sees through it) and the drop dispatches on what's lit.
  onDragStart(ev, id) {
    const stop = startRowDrag(ev, {
      row: ev.target.closest(".edit-row"),
      onMove: (e) => this._dragMove(e),
      onEnd: (commit) => this._dragEnd(commit),
    });
    if (!stop) return;
    this._dragStop = stop;
    this.dragId.set(id);
  }

  _dragMove(ev) {
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    // a row wins over the menu body that contains it (the old stopPropagation)
    const row = el?.closest(".edit-row");
    const rowId = row ? Number(row.dataset.id || 0) : 0;
    if (rowId && rowId !== this.dragId()) {
      this.overId.set(rowId);
      this.overInto.set(0);
      this.overEnd.set(false);
      return;
    }
    const body = rowId ? null : el?.closest(".link-menu-body");
    if (body) {
      this.overInto.set(Number(body.dataset.menuId || 0));
      this.overId.set(0);
      this.overEnd.set(false);
      return;
    }
    this.overEnd.set(!rowId && !!el?.closest(".links-drop-end"));
    this.overId.set(0);
    this.overInto.set(0);
  }

  _dragEnd(commit) {
    this._dragStop = null;
    const drag = this.dragId();
    const target = { row: this.overId(), into: this.overInto(), end: this.overEnd() };
    this.dragId.set(0);
    this.overId.set(0);
    this.overInto.set(0);
    this.overEnd.set(false);
    if (!commit || !drag) return;
    if (target.row) this._moveBefore(drag, target.row);
    else if (target.into) this._moveInto(drag, target.into);
    else if (target.end) this._moveEnd(drag);
  }

  // place the dragged node immediately before the target row, in the target's
  // container (top level or a menu). Menus can't nest (depth 1).
  _moveBefore(dragId, targetId) {
    if (!dragId || dragId === targetId) return;
    const items = this.items();
    const src = this._locate(items, dragId);
    const tgt = this._locate(items, targetId);
    if (!src || !tgt) return;
    if (this.isMenu(src.node) && tgt.container !== items) return; // no menu inside a menu
    src.container.splice(src.index, 1);
    const t = this._locate(items, targetId); // re-locate: removal may have shifted indices
    t.container.splice(t.index, 0, src.node);
    this.items.set([...items]);
    this.save();
  }

  // move the dragged link into a menu (appended); ignored for menus (depth 1)
  _moveInto(dragId, menuId) {
    if (!dragId) return;
    const items = this.items();
    const src = this._locate(items, dragId);
    const menu = items.find((n) => n._id === menuId && this.isMenu(n));
    if (!src || !menu || this.isMenu(src.node)) return;
    src.container.splice(src.index, 1);
    menu.children.push(src.node);
    this.items.set([...items]);
    this.save();
  }

  // move the dragged node to the end of the top level
  _moveEnd(dragId) {
    if (!dragId) return;
    const items = this.items();
    const src = this._locate(items, dragId);
    if (!src) return;
    src.container.splice(src.index, 1);
    items.push(src.node);
    this.items.set([...items]);
    this.save();
  }

  // persist to config.links: strip _id, trim, drop blank top-level links and blank
  // child links (a menu is kept even when empty so a freshly-added one sticks)
  save() {
    const links = this.items()
      .map((it) => {
        if (this.isMenu(it)) {
          return {
            label: (it.label || "").trim(),
            children: it.children
              .map((c) => ({ label: (c.label || "").trim(), href: (c.href || "").trim() }))
              .filter((c) => c.label && c.href),
          };
        }
        return { label: (it.label || "").trim(), href: (it.href || "").trim() };
      })
      .filter((it) => it.children || it.label || it.href);
    this.config.updateConfig({ links });
  }
}

// scalar config fields editable in the Config tab's Settings block

export const SETTINGS_FIELDS = [
  { key: "venv_activate", name: "venv activate (optional)" },
  { key: "server_path", name: "odoo-bin path" },
  { key: "worktree_dir", name: "worktree dir" },
  { key: "db_user", name: "database user" },
  { key: "db_password", name: "database password" },
  { key: "filestore", name: "filestore path" },
  { key: "editor", name: "editor command" },
];

export class ConfigScreen extends Component {
  static components = { ListEditor, TabsEditor, LinksEditor, Panel };
  static template = xml`
    <section>
      <Panel title="'Configuration'">
        <t t-set-slot="title-extra">
          <div class="panel-inline-actions">
            <button class="pbtn" t-on-click="() => this.openPresets()">Presets</button>
            <button class="pbtn" t-att-disabled="this.checking()" t-on-click="() => this.checkUpdate()"><t t-out="this.refreshIcon"/><t t-out="this.checking() ? 'Checking…' : 'Check for update'"/></button>
            <span t-if="this.upToDate()" class="check-uptodate">✓ up to date</span>
          </div>
        </t>
      </Panel>
      <div class="content">
        <div class="config-block">
          <h2 class="subtitle">Odoo settings</h2>
          <div class="settings-grid" data-form-type="other">
            <t t-foreach="this.settingsFields" t-as="f" t-key="f.key">
              <label t-att-for="'setting-' + f.key" t-out="f.name"/>
              <input t-att-id="'setting-' + f.key" type="text" class="edit-input" autocomplete="off" t-att-value="this.settings()[f.key]"
                     t-on-input="ev => this.setSetting(f.key, ev.target.value)"
                     t-on-change="() => this.saveSettings()"/>
            </t>
          </div>
        </div>
        <div class="config-block">
          <h2 class="subtitle">Miscellaneous</h2>
          <div class="settings-grid" data-form-type="other">
            <label for="setting-editor">editor command</label>
            <input id="setting-editor" type="text" class="edit-input" autocomplete="off" t-att-value="this.settings().editor"
                   t-on-input="ev => this.setSetting('editor', ev.target.value)"
                   t-on-change="() => this.saveSettings()"/>
            <label for="setting-auto-open-event-log" title="When enabled, the event log overlay opens automatically whenever a new event arrives (and stays open).">auto-open event log</label>
            <input id="setting-auto-open-event-log" type="checkbox" class="settings-check" title="When enabled, the event log overlay opens automatically whenever a new event arrives (and stays open)."
                   t-att-checked="this.config.config.auto_open_event_log"
                   t-on-change="ev => this.config.updateConfig({ auto_open_event_log: ev.target.checked })"/>
            <label for="setting-rust-bundler" title="Launch Odoo with RUST_BUNDLER=1 so the rust_bundler addon uses Goo's native extension. Installation and activation are independent; activation takes effect on the next Odoo restart.">rust bundler</label>
            <div class="rust-bundler-control">
              <input id="setting-rust-bundler" type="checkbox" class="settings-check" title="Use Goo's native asset bundler on the next Odoo restart. Untick it for the Python bundler."
                     t-att-checked="this.config.config.rust_bundler"
                     t-on-change="ev => this.config.updateConfig({ rust_bundler: ev.target.checked })"/>
              <button t-att-disabled="this.rustBuilding()" t-on-click="() => this.installRustBundler()">
                <t t-out="this.rustBuilding() ? 'Building…' : 'Build / update Rust bundler'"/>
              </button>
              <span class="dim" t-att-class="{error: this.rustStatus().error}" t-out="this.rustStatusText"/>
            </div>
            <label for="setting-update-check" title="Automatically check for goo updates (git fetch of origin/master at startup and then hourly) to surface the navbar update badge. The 'Check for update' button above always works, even when this is off.">check for goo updates</label>
            <input id="setting-update-check" type="checkbox" class="settings-check" title="Automatically check for goo updates (git fetch of origin/master at startup and then hourly) to surface the navbar update badge. The 'Check for update' button above always works, even when this is off."
                   t-att-checked="this.config.config.update_check !== false"
                   t-on-change="ev => this.config.updateConfig({ update_check: ev.target.checked })"/>
            <label for="setting-ws-categories" title="Group the Workspaces list under collapsible per-category headers (see the Workspace categories section below). Each workspace picks its category in its create/edit dialog.">enable workspace categories</label>
            <input id="setting-ws-categories" type="checkbox" class="settings-check" title="Group the Workspaces list under collapsible per-category headers (see the Workspace categories section below). Each workspace picks its category in its create/edit dialog."
                   t-att-checked="this.config.config.workspace_categories_enabled"
                   t-on-change="ev => this.config.updateConfig({ workspace_categories_enabled: ev.target.checked })"/>
          </div>
        </div>
        <TabsEditor/>
        <ListEditor kind="'repos'"/>
        <ListEditor kind="'templates'"/>
        <ListEditor kind="'categories'"/>
        <ListEditor kind="'testPresets'"/>
        <LinksEditor/>
        <div class="config-block">
          <h2 class="subtitle">Backup</h2>
          <p class="dim">goo stores your config on the server (~/.config/goo/config.json). Save a copy to a file, or restore one.</p>
          <div class="config-actions">
            <button t-on-click="() => this.exportData()">Export</button>
            <button t-on-click="() => this.triggerImport()">Import</button>
            <input type="file" id="goo-import-file" accept="application/json,.json" hidden="hidden" t-on-change="(ev) => this.importData(ev)"/>
            <span t-out="this.backupMsg()"/>
          </div>
        </div>
        <div class="config-block">
          <h2 class="subtitle">Danger zone</h2>
          <p class="dim">Erase every customization (settings, repos, workspaces, templates, links, favorites, history) and restore the built-in initial config. This cannot be undone.</p>
          <div class="config-actions">
            <button class="danger" t-on-click="() => this.resetAll()">Reset to initial config</button>
          </div>
        </div>
      </div>
    </section>`;

  config = usePlugin(ConfigPlugin);
  update = usePlugin(UpdatePlugin);
  dialogs = usePlugin(DialogPlugin);
  eventLog = usePlugin(EventLogPlugin);
  refreshIcon = m(ICONS.refresh);
  checking = signal(false);
  upToDate = signal(false); // brief green check by the button when already up to date
  backupMsg = signal("");
  rustBuilding = signal(false);
  rustStatus = signal({ checking: true });
  settingsFields = SETTINGS_FIELDS.filter((f) => f.key !== "editor"); // editor lives in Miscellaneous
  settings = signal(this._loadSettings());

  setup() {
    onMounted(() => this.checkRustBundler());
  }

  get rustStatusText() {
    const status = this.rustStatus();
    if (status.checking) return "checking…";
    if (this.rustBuilding() || status.building) return "building in the configured environment…";
    if (status.error) return `failed: ${status.error}`;
    if (!status.installed)
      return `not installed (expected ${status.expected_version || "unknown"})`;
    if (!status.current)
      return `update required (${status.version || "unknown"} → ${status.expected_version})`;
    if (status.restart_required) return `installed ${status.version}; restart Odoo to load it`;
    return `installed ${status.version}`;
  }

  async checkRustBundler() {
    this.rustStatus.set({ checking: true });
    try {
      const response = await fetch("/api/rust-bundler", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || response.status);
      this.rustStatus.set(data);
    } catch (error) {
      this.rustStatus.set({ error: error.message });
    }
  }

  async installRustBundler() {
    if (this.rustBuilding()) return;
    this.rustBuilding.set(true);
    this.rustStatus.set({ ...this.rustStatus(), building: true, error: "" });
    try {
      const result = await postJSON("/api/rust-bundler/install");
      this.rustStatus.set(result);
    } catch (error) {
      this.rustStatus.set({ ...this.rustStatus(), building: false, error: error.message });
      this.dialogs.error("Rust bundler build failed", error.message);
    } finally {
      this.rustBuilding.set(false);
    }
  }

  // manually re-check whether goo is behind origin/master, then report the result
  async checkUpdate() {
    if (this.checking()) return;
    this.checking.set(true);
    this.upToDate.set(false);
    const r = await this.update.check();
    this.checking.set(false);
    if (r.behind > 0) {
      const n = r.behind;
      this.eventLog.add(
        `checked for updates — ${n} commit${n === 1 ? "" : "s"} behind origin/master`,
      );
      return void this.update.promptUpdate();
    }
    if (r.ok) {
      // up to date — a quiet green check next to the button rather than a dialog
      this.eventLog.add("checked for updates — goo is up to date");
      this.upToDate.set(true);
      setTimeout(() => this.upToDate.set(false), 3000);
      return;
    }
    this.eventLog.add("checked for updates — could not reach origin", "", "error");
    this.dialogs.error(
      "Couldn't check for updates",
      "Make sure goo runs from a git checkout with an 'origin' remote and that you're online.",
    );
  }

  _loadSettings() {
    const c = this.config.config;
    return Object.fromEntries(SETTINGS_FIELDS.map((f) => [f.key, c[f.key] || ""]));
  }

  setSetting(key, val) {
    this.settings.set({ ...this.settings(), [key]: val });
  }

  saveSettings() {
    const patch = {};
    for (const f of SETTINGS_FIELDS) patch[f.key] = (this.settings()[f.key] || "").trim();
    this.config.updateConfig(patch);
  }

  triggerImport() {
    document.getElementById("goo-import-file").click();
  }

  async resetAll() {
    const ok = await this.dialogs.open({
      title: "Reset the complete config to its initial state?",
      message:
        "This erases all your customizations (settings, repos, workspaces, templates, links, favorites, history) and cannot be undone.",
      okLabel: "Reset everything",
      cls: "dialog-error",
    });
    if (!ok) return;
    await this.config.resetConfig();
    location.reload();
  }

  // pick a preset (presets.js) and replace the whole config with it
  async openPresets() {
    const res = await this.dialogs.open({
      title: "Configuration presets",
      message:
        "Applying a preset replaces your current configuration (settings, repos, workspaces, templates, links, tabs, favorites). This cannot be undone.",
      fields: [
        {
          key: "preset",
          type: "select",
          label: "Preset",
          value: "normal",
          options: PRESETS.map((p) => ({ value: p.id, label: p.label })),
        },
      ],
      okLabel: "Apply",
      cancelLabel: "Cancel",
      validate: (v) => (v.preset ? "" : "Choose a preset to apply."),
    });
    if (!res) return;
    await this.config.applyPreset(res.preset);
    location.reload();
  }

  exportData() {
    const blob = new Blob([JSON.stringify(this.config.snapshot(), null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "goo-backup.json";
    a.click();
    URL.revokeObjectURL(a.href);
    this.backupMsg.set("Exported.");
  }

  async importData(ev) {
    const file = ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data !== "object" || !data.config)
        throw new Error("not a goo config backup");
      await this.config.importSnapshot(data);
      this.backupMsg.set("Imported, reloading…");
      setTimeout(() => location.reload(), 700);
    } catch (e) {
      this.backupMsg.set(`Import failed: ${e.message}`);
    }
  }
}

// ─────────────────────────── Action menu popover ───────────────────────────

// A generic floating kebab menu. Lives at the app root and is opened via the
// appBus "action-menu" event with an anchor rect + a list of actions
// ({ label, danger?, disabled?, title?, onClick }). Positioned fixed so it
// escapes overflow-clipped containers (e.g. the scrolling branches table);
// flips above the anchor when it would run off the bottom of the viewport.

export const SPECS = {
  repos: {
    key: "repos",
    title: "Repositories",
    itemName: "repository",
    card: true, // one card per repo, fields spread over two labeled rows
    carry: ["favorite"], // legacy flag: no UI reads it anymore, but stored configs round-trip
    fields: [
      {
        key: "id",
        name: "name",
        placeholder: "community",
        className: "w-name",
        title: "short identifier used across goo (also the checkout's folder name in worktrees)",
      },
      {
        key: "path",
        name: "path",
        placeholder: "~/work/community",
        className: "w-flex",
        title: "local path of the git checkout (~ allowed)",
      },
      {
        key: "github",
        name: "github repo",
        placeholder: "odoo/odoo",
        className: "w-name",
        optional: true,
        row: 2,
        title: "canonical GitHub slug (owner/name) — used for PR, runbot and mergebot lookups",
      },
      {
        key: "pull_remote",
        name: "pull remote",
        placeholder: "origin",
        className: "w-name",
        optional: true,
        default: "origin",
        row: 2,
        title: "git remote fetched from (rebase, fresh start points, auto-reload)",
      },
      {
        key: "push_remote",
        name: "push remote",
        placeholder: "dev",
        className: "w-name",
        optional: true,
        default: "dev",
        row: 2,
        title: "git remote pushed to (push branch, delete remote branch)",
      },
      {
        key: "autoreload",
        name: "auto-reload master",
        type: "checkbox",
        optional: true,
        row: 2,
        title: "fetch master from the pull remote in the background (every 4h)",
      },
      {
        key: "external",
        name: "external",
        type: "checkbox",
        optional: true,
        row: 2,
        title:
          "a repo outside the odoo CI ecosystem (e.g. odoo/owl) — skip its mergebot/runbot lookups",
      },
    ],
    validate(repos, config) {
      if (!repos.find((r) => r.id === "community"))
        return 'a "community" repository is required (odoo-bin lives there)';
      const ids = new Set(repos.map((r) => r.id));
      for (const w of config.workspaces || []) {
        const used = (w.checkouts || []).find((c) => !ids.has(c.repo));
        if (used) return `repository "${used.repo}" is still used by workspace "${w.name}"`;
      }
      return null;
    },
  },
  templates: {
    key: "templates",
    title: "Workspace templates",
    itemName: "template",
    reorderable: true, // drag the handle to reorder how templates appear in the New-workspace dialog
    carry: ["id"], // reconcile keys templates by id — edits must not mint new records
    prepare(item) {
      if (!item.id) item.id = newWorkspaceId(); // a freshly added row
    },
    fields: [
      { key: "name", name: "name", placeholder: "name (e.g. master)", className: "w-name" },
      {
        key: "checkouts",
        name: "config",
        placeholder: "community:master,enterprise:master",
        className: "w-flex",
        format: repoBranchList.format,
        parse: repoBranchList.parse,
      },
      { key: "db", name: "database", placeholder: "database", className: "w-name", optional: true },
      {
        key: "on_create_args",
        name: "start args",
        placeholder: "-i sale_management",
        className: "w-name",
        optional: true,
      },
      {
        key: "demo_data",
        name: "demo data",
        type: "checkbox",
        optional: true,
        default: true,
        title: "load demo data when a workspace created from this template makes its database",
      },
      {
        key: "category",
        name: "category",
        placeholder: "category (e.g. dev)",
        className: "w-name",
        optional: true,
        title:
          "default category new workspaces from this template inherit (when categories are enabled)",
      },
    ],
    validate() {
      return null;
    },
  },
  categories: {
    key: "workspace_categories",
    title: "Workspace categories",
    itemName: "category",
    reorderable: true, // drag the handle to reorder how the groups appear in the Workspaces list
    fields: [
      {
        key: "id",
        name: "name",
        placeholder: "category name (e.g. dev)",
        className: "w-name",
        title: "group label shown in the Workspaces list (when categories are enabled)",
      },
    ],
    validate() {
      return null; // a category removed while still assigned just falls back to uncategorized
    },
  },
  testPresets: {
    key: "test_presets",
    title: "Test presets",
    itemName: "preset",
    reorderable: true, // drag the handle to reorder how presets appear in the Tests selector
    fields: [
      {
        key: "tags",
        name: "test tags",
        placeholder: "--test-tags, e.g. /web:WebSuite[@web]",
        className: "w-flex",
      },
    ],
    validate() {
      return null;
    },
  },
};
