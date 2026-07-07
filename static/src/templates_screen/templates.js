// The Templates screen: manage the presets the New-workspace dialog offers. A
// template is just {name, checkouts, db, on_create_args, demo_data} — no physical
// identity (location/port/favorite), no activation; workspaces are created FROM
// them on the Workspaces screen (or the dashboard). Successor of the retired
// Targets screen — same table mechanics (inline edit, drag reorder), minus
// everything workspace-shaped.

import { Component, plugin, signal, xml } from "@odoo/owl";
import { ConfigPlugin, newTargetId } from "../core/config_plugin.js";
import { DialogPlugin } from "../core/dialog_plugin.js";
import { EventLogPlugin } from "../core/event_log_plugin.js";
import { ICONS, appBus, m } from "../core/common.js";
import { Panel } from "../core/panel.js";
import { repoBranchList } from "../core/utils.js";

export class TemplatesScreen extends Component {
  static components = { Panel };
  static template = xml`
    <section>
      <Panel title="'Templates'">
        <t t-set-slot="bottom-left">
          <button class="pbtn primary" t-on-click="() => this.startCreate()">New template</button>
          <span class="dash-subtitle">Templates prefill the New-workspace dialog — a bundle of branches, a database and start args.</span>
          <span t-if="this.error()" class="form-error" t-out="this.error()"/>
        </t>
        <t t-set-slot="bottom-right">
          <span class="row-count" t-out="this.count"/>
        </t>
      </Panel>
      <div class="content br-fill">
        <div>
          <div t-if="!this.templates.length" class="dim br-empty">No templates yet — create one, or let the New-workspace dialog start blank.</div>
          <div t-else="" class="br-card">
            <div class="brg-table">
            <table class="br-table brg-flat">
              <thead>
                <tr><th>Name</th><th>Config</th><th>Database</th><th>Start args</th><th>Demo data</th><th/></tr>
              </thead>
              <tbody>
                <tr t-foreach="this.templates" t-as="tpl" t-key="tpl.id" t-att-class="{'br-editing': this.editId() === tpl.id, dragging: this.dragId() === tpl.id, 'drag-over': this.dragOverId() === tpl.id}" t-on-dragover="ev => this.onDragOver(ev, tpl)" t-on-drop="ev => this.onDrop(ev, tpl)">
                  <t t-if="this.editId() === tpl.id">
                    <td><input type="text" class="cell-input" t-att-value="this.draftName()" placeholder="name" t-on-input="ev => this.draftName.set(ev.target.value)" t-on-keydown="ev => this.onEditKey(ev)"/></td>
                    <td><input type="text" class="cell-input wide" t-att-value="this.draftConfig()" placeholder="community:master,enterprise:master" t-on-input="ev => this.draftConfig.set(ev.target.value)" t-on-keydown="ev => this.onEditKey(ev)"/></td>
                    <td><input type="text" class="cell-input" t-att-value="this.draftDb()" placeholder="database" t-on-input="ev => this.draftDb.set(ev.target.value)" t-on-keydown="ev => this.onEditKey(ev)"/></td>
                    <td><input type="text" class="cell-input" t-att-value="this.draftArgs()" placeholder="-i sale_management" t-on-input="ev => this.draftArgs.set(ev.target.value)" t-on-keydown="ev => this.onEditKey(ev)"/></td>
                    <td><input type="checkbox" class="br-select" t-att-checked="tpl.demo_data" t-on-change="() => this.toggleDemoData(tpl.id)" title="load demo data when a workspace created from this template makes its database"/></td>
                    <td>
                      <div class="br-act">
                        <button class="drop-btn pr-close" t-on-click="() => this.saveEdit()">Save</button>
                        <button class="drop-btn" t-on-click="() => this.cancelEdit()">Cancel</button>
                      </div>
                    </td>
                  </t>
                  <t t-else="">
                    <td class="tgt-name-handle" draggable="true" title="drag to reorder" t-on-dragstart="ev => this.onDragStart(ev, tpl)" t-on-dragend="() => this.onDragEnd()" t-out="tpl.name"/>
                    <td class="dim"><div class="br-ellip" t-att-title="this.fmtConfig(tpl)" t-out="this.fmtConfig(tpl)"/></td>
                    <td t-out="tpl.db"/>
                    <td class="dim"><div class="br-ellip" t-att-title="tpl.on_create_args" t-out="tpl.on_create_args || '—'"/></td>
                    <td><input type="checkbox" class="br-select" t-att-checked="tpl.demo_data" t-on-change="() => this.toggleDemoData(tpl.id)" title="load demo data when a workspace created from this template makes its database"/></td>
                    <td>
                      <div class="br-act">
                        <button class="dash-kebab" title="template actions"
                                t-on-click.stop="(ev) => this.openRowMenu(ev, tpl)"><t t-out="this.kebabIcon"/></button>
                      </div>
                    </td>
                  </t>
                </tr>
              </tbody>
            </table>
            </div>
          </div>
        </div>
      </div>
    </section>`;

  config = plugin(ConfigPlugin);
  dialogs = plugin(DialogPlugin);
  eventLog = plugin(EventLogPlugin);
  kebabIcon = m(ICONS.kebab);
  editId = signal(""); // id of the row being edited inline ("" = none)
  draftName = signal("");
  draftConfig = signal("");
  draftDb = signal("");
  draftArgs = signal("");
  error = signal(""); // inline-edit validation error
  dragId = signal(""); // id of the template currently being dragged ("" = none)
  dragOverId = signal(""); // id of the row the drag is hovering over

  get templates() {
    return this.config.config.templates || [];
  }

  get count() {
    const n = this.templates.length;
    return `${n} template${n === 1 ? "" : "s"}`;
  }

  fmtConfig(tpl) {
    return (tpl.checkouts || []).map((c) => `${c.repo}:${c.branch}`).join(", ");
  }

  // every mutation goes through one canonical array write — reconcileTemplates
  // (order-aware) turns it into record updates
  _write(templates) {
    this.config.updateConfig({ templates });
  }

  // ── create / duplicate / delete ──────────────────────────────────────────────
  async startCreate() {
    const res = await this.dialogs.open({
      title: "New template",
      okLabel: "Create",
      validate: (v) => {
        const name = (v.name || "").trim();
        if (!name) return "a name is required";
        if (this.templates.some((t) => t.name === name))
          return `a template named "${name}" already exists`;
        if (!repoBranchList.parse((v.config || "").trim()).length) return "a config is required";
        return "";
      },
      fields: [
        { key: "name", type: "text", label: "Name", placeholder: "name (e.g. master)" },
        {
          key: "config",
          type: "text",
          label: "Config",
          placeholder: "community:master,enterprise:master",
        },
        { key: "db", type: "text", label: "Database", placeholder: "database name" },
        { key: "args", type: "text", label: "Start args", placeholder: "-i sale_management" },
        { key: "demoData", type: "checkbox", label: "Demo data", value: true },
      ],
    });
    if (!res) return;
    const tpl = {
      id: newTargetId(),
      name: res.name.trim(),
      checkouts: repoBranchList.parse(res.config.trim()),
      db: (res.db || "").trim(),
      on_create_args: (res.args || "").trim(),
      demo_data: !!res.demoData,
    };
    this.eventLog.add(`creating template ${tpl.name}`);
    this._write([...this.templates, tpl]);
  }

  duplicate(tpl) {
    const names = new Set(this.templates.map((t) => t.name));
    let name = tpl.name;
    for (let i = 2; names.has(name); i++) name = `${tpl.name} (${i})`;
    this._write([...this.templates, { ...tpl, id: newTargetId(), name }]);
  }

  async remove(tpl) {
    const ok = await this.dialogs.open({
      title: `Delete "${tpl.name}"?`,
      message:
        "The template will be removed from the New-workspace dialog. Existing workspaces are not affected.",
      okLabel: "Delete",
    });
    if (!ok) return;
    this.eventLog.add(`deleting template ${tpl.name}`);
    this._write(this.templates.filter((t) => t.id !== tpl.id));
  }

  // ── kebab menu (shared ActionMenu) ───────────────────────────────────────────
  openRowMenu(ev, tpl) {
    const rect = ev.currentTarget.getBoundingClientRect();
    const actions = [
      { label: "Edit", onClick: () => this.startEdit(tpl) },
      { label: "Duplicate", onClick: () => this.duplicate(tpl) },
      { label: "Delete", danger: true, onClick: () => this.remove(tpl) },
    ];
    appBus.dispatchEvent(new CustomEvent("action-menu", { detail: { rect, actions } }));
  }

  // ── inline edit ──────────────────────────────────────────────────────────────
  startEdit(tpl) {
    this.draftName.set(tpl.name);
    this.draftConfig.set(repoBranchList.format(tpl.checkouts));
    this.draftDb.set(tpl.db || "");
    this.draftArgs.set(tpl.on_create_args || "");
    this.error.set("");
    this.editId.set(tpl.id);
  }

  saveEdit() {
    const id = this.editId();
    const name = this.draftName().trim();
    if (!name) return this.error.set("a name is required");
    if (this.templates.some((t) => t.name === name && t.id !== id))
      return this.error.set(`a template named "${name}" already exists`);
    const checkouts = repoBranchList.parse(this.draftConfig().trim());
    if (!checkouts.length) return this.error.set("a config is required");
    this._write(
      this.templates.map((t) =>
        t.id === id
          ? {
              ...t,
              name,
              checkouts,
              db: this.draftDb().trim(),
              on_create_args: this.draftArgs().trim(),
            }
          : t,
      ),
    );
    this.cancelEdit();
  }

  cancelEdit() {
    this.editId.set("");
    this.error.set("");
  }

  // Enter saves the inline edit, Escape cancels it
  onEditKey(ev) {
    if (ev.key === "Enter") this.saveEdit();
    else if (ev.key === "Escape") this.cancelEdit();
  }

  toggleDemoData(id) {
    this._write(this.templates.map((t) => (t.id === id ? { ...t, demo_data: !t.demo_data } : t)));
  }

  // ── drag reorder (by the name handle) ────────────────────────────────────────
  onDragStart(ev, tpl) {
    this.dragId.set(tpl.id);
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", tpl.id); // some browsers need data to start a drag
  }

  onDragOver(ev, tpl) {
    if (!this.dragId()) return; // ignore drags that didn't start on a name handle
    ev.preventDefault(); // mark this row as a valid drop target
    ev.dataTransfer.dropEffect = "move";
    if (this.dragOverId() !== tpl.id) this.dragOverId.set(tpl.id);
  }

  onDrop(ev, tpl) {
    ev.preventDefault();
    this.reorder(this.dragId(), tpl.id);
    this.onDragEnd();
  }

  onDragEnd() {
    this.dragId.set("");
    this.dragOverId.set("");
  }

  // move the dragged template to sit immediately before the drop target
  reorder(fromId, toId) {
    if (!fromId || fromId === toId) return;
    const templates = [...this.templates];
    const from = templates.findIndex((t) => t.id === fromId);
    if (from < 0) return;
    const [moved] = templates.splice(from, 1);
    const to = templates.findIndex((t) => t.id === toId);
    if (to < 0) return;
    templates.splice(to, 0, moved);
    this._write(templates);
  }
}
