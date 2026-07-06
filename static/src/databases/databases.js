import { Component, computed, plugin, signal, xml } from "@odoo/owl";
import { formatBytes, timeAgo } from "../core/utils.js";
import { DatabasePlugin } from "../core/database_plugin.js";
import { DialogPlugin } from "../core/dialog_plugin.js";
import { ICONS, appBus, m } from "../core/common.js";

export class DatabasesScreen extends Component {
  static template = xml`
    <section>
      <div class="panel">
        <div class="panel-top">
          <h1>Databases</h1>
          <div class="panel-top-right">
            <span class="meta" t-out="this.stamp"/>
            <button class="pbtn" t-on-click="() => this.db.load(true)"><t t-out="this.refreshIcon"/>Refresh</button>
          </div>
        </div>
        <div class="panel-actions">
          <button t-if="this.selectedCount" class="pbtn danger" t-on-click="() => this.dropSelected()">Drop <t t-out="this.selectedCount"/></button>
          <span class="row-count" t-out="this.count"/>
        </div>
      </div>
      <div class="content br-fill">
        <div t-att-class="{busy: this.db.dropping()}">
          <div t-if="this.db.error()" class="dim br-empty" t-out="'Failed to load: ' + this.db.error()"/>
          <div t-elif="!this.db.databases().length" class="dim br-empty">No databases.</div>
          <div t-else="" class="br-card">
            <!-- full-width card = scroll container (scrollbar on the right); the
                 wrapper sizes the table to its natural width, like the Branches list -->
            <div class="brg-table">
            <table class="br-table brg-flat">
              <thead>
                <tr><th><input type="checkbox" class="br-select" t-att-checked="this.allSelected" t-on-change="() => this.toggleSelectAll()" title="select all databases"/></th><th>Name</th><th>Odoo version</th><th>Size</th><th>Created</th><th>Last activity</th><th/></tr>
              </thead>
              <tbody>
                <tr t-foreach="this.rows()" t-as="d" t-key="d.name" t-att-class="{active: d.active, 'row-sel': this.selected().has(d.name)}">
                  <td>
                    <input t-if="!d.active" type="checkbox" class="br-select" t-att-checked="this.selected().has(d.name)" t-on-change="() => this.toggleSelect(d.name)" title="select this database for batch actions"/>
                  </td>
                  <td t-att-class="{'active-name': d.active, 'select-toggle': !d.active}"
                      t-on-click="() => d.active || this.toggleSelect(d.name)">
                    <span class="br-branch" t-out="d.name"/>
                    <span t-if="d.active" class="db-badge"><span class="pulse"/>Active</span>
                  </td>
                  <td t-att-class="{dim: !d.version}"><t t-out="d.version || '—'"/><t t-if="d.enterprise"> (ent)</t></td>
                  <td class="br-when" t-att-class="{dim: !d.size}" t-out="d.size || '—'"/>
                  <td class="br-when" t-att-title="d.createdTitle" t-out="d.created ? d.createdAgo : '—'"/>
                  <td class="br-when" t-att-title="d.lastTitle" t-out="d.last ? d.lastAgo : '—'"/>
                  <td>
                    <div class="br-act">
                      <button class="dash-kebab" title="database actions"
                              t-on-click.stop="(ev) => this.openRowMenu(ev, d)"><t t-out="this.kebabIcon"/></button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
            </div>
          </div>
        </div>
      </div>
    </section>`;

  db = plugin(DatabasePlugin);
  dialogs = plugin(DialogPlugin);
  refreshIcon = m(ICONS.refresh);
  kebabIcon = m(ICONS.kebab);
  selected = signal(new Set()); // database names ticked for batch actions
  // sorted, view-ready rows — recomputed only when the db list / active db change
  rows = computed(() => {
    const activeDb = this.db.activeDb;
    return [...this.db.databases()]
      .sort((a, b) => (Date.parse(b.last_update) || 0) - (Date.parse(a.last_update) || 0))
      .map((d) => ({
        name: d.name,
        active: d.name === activeDb,
        version: d.odoo_version,
        enterprise: d.enterprise,
        created: d.created,
        createdAgo: d.created && timeAgo(d.created),
        createdTitle: d.created ? `${d.created} (UTC)` : "",
        last: d.last_update,
        lastAgo: d.last_update && timeAgo(d.last_update),
        lastTitle: d.last_update ? `${d.last_update} (UTC)` : "",
        size: formatBytes(d.size),
      }));
  });

  setup() {
    this.db.load();
  }

  get stamp() {
    if (this.db.loading()) return "refreshing…";
    return this.db.at() ? `updated ${timeAgo(new Date(this.db.at()).toISOString())}` : "";
  }

  get count() {
    const n = this.rows().length;
    return `${n} database${n === 1 ? "" : "s"}`;
  }

  toggleSelect(name) {
    const sel = new Set(this.selected());
    sel.has(name) ? sel.delete(name) : sel.add(name);
    this.selected.set(sel);
  }

  // per-database actions in the floating kebab menu (shared ActionMenu). Clone,
  // rename and drop all need the source db to have no active connections. Rename
  // and drop stay disabled on the active db; Clone is allowed — it stops the
  // server (releasing connections), clones, then restarts.
  openRowMenu(ev, d) {
    const rect = ev.currentTarget.getBoundingClientRect();
    const busyTitle = d.active ? "stop the server first (no active connections allowed)" : "";
    const actions = [
      {
        label: "Clone",
        title: d.active ? "stops the server to clone, then restarts it" : "",
        onClick: () => this.cloneDb(d),
      },
      {
        label: "Rename",
        disabled: d.active,
        title: busyTitle,
        onClick: () => this.renameDb(d),
      },
      {
        label: "Drop",
        danger: true,
        disabled: d.active,
        title: d.active ? "in use by the running server" : "",
        onClick: () => this.dropDb(d),
      },
    ];
    appBus.dispatchEvent(new CustomEvent("action-menu", { detail: { rect, actions } }));
  }

  get _selectableDbs() {
    return this.rows().filter((d) => !d.active);
  }

  get allSelected() {
    const sel = this.selected();
    const selectable = this._selectableDbs;
    return selectable.length > 0 && selectable.every((d) => sel.has(d.name));
  }

  toggleSelectAll() {
    this.selected.set(
      this.allSelected ? new Set() : new Set(this._selectableDbs.map((d) => d.name)),
    );
  }

  get selectedCount() {
    return this.rows().filter((d) => this.selected().has(d.name) && !d.active).length;
  }

  async dropSelected() {
    const dbs = this._selectableDbs.filter((d) => this.selected().has(d.name));
    if (!dbs.length) return;
    const n = dbs.length;
    const res = await this.dialogs.open({
      title: `Drop ${n} database${n === 1 ? "" : "s"}?`,
      message: "This permanently deletes the selected databases. This cannot be undone.",
      okLabel: "Drop",
    });
    if (!res) return;
    for (const d of dbs) await this.db.drop(d.name);
    this.selected.set(new Set());
  }

  // confirm via the dialog, then drop; report any failure in a dialog too
  async dropDb(d) {
    const res = await this.dialogs.open({
      title: `Drop "${d.name}"?`,
      message: "This permanently deletes the database. This cannot be undone.",
      okLabel: "Drop",
    });
    if (!res) return;
    const error = await this.db.drop(d.name);
    if (error)
      await this.dialogs.open({
        title: "Drop failed",
        message: error,
        okLabel: "OK",
        cancelLabel: null,
      });
  }

  // valid db name: letters/digits then letters/digits/._- (mirrors the backend)
  _badName(name) {
    if (!name) return "a name is required";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
      return "use letters, digits, . _ - (not starting with -)";
    if (this.db.databases().some((x) => x.name === name))
      return `a database named "${name}" already exists`;
    return "";
  }

  // ask for a target name, then clone; report any failure in a dialog. Cloning the
  // active db requires exclusive access (postgres createdb -T), so the server is
  // stopped first and restarted afterwards.
  async cloneDb(d) {
    const res = await this.dialogs.open({
      title: `Clone "${d.name}"`,
      message: d.active
        ? "This database is in use by the running server. goo will stop the server to clone it, then restart it."
        : "",
      fields: [
        {
          key: "target",
          type: "text",
          label: "New database name",
          value: `${d.name}-copy`,
          placeholder: "new database name",
        },
      ],
      okLabel: "Clone",
      validate: (v) => this._badName((v.target || "").trim()),
    });
    if (!res) return;
    // cloneStoppingServer frees the source by stopping the server when it's the
    // active db (the clone needs exclusive access), then resumes it
    const error = await this.db.cloneStoppingServer(d.name, res.target.trim());
    if (error)
      await this.dialogs.open({
        title: "Clone failed",
        message: error,
        okLabel: "OK",
        cancelLabel: null,
      });
  }

  // ask for a new name, then rename; report any failure in a dialog
  async renameDb(d) {
    const res = await this.dialogs.open({
      title: `Rename "${d.name}"`,
      fields: [
        {
          key: "name",
          type: "text",
          label: "New name",
          value: d.name,
          placeholder: "new database name",
        },
      ],
      okLabel: "Rename",
      validate: (v) => {
        const t = (v.name || "").trim();
        if (t === d.name) return "choose a different name";
        return this._badName(t);
      },
    });
    if (!res) return;
    const error = await this.db.rename(d.name, res.name.trim());
    if (error)
      await this.dialogs.open({
        title: "Rename failed",
        message: error,
        okLabel: "OK",
        cancelLabel: null,
      });
  }
}

// ─────────────────────────── Targets screen ───────────────────────────

// First-class targets: name, favorite flag, config (repo:branch pairs), db and
// start args. Rows are edited inline; "New target" opens a dialog form.

// After remote branches have been fetched locally, open a prefilled
// target-creation dialog (no "Create branches" step — they already exist).
