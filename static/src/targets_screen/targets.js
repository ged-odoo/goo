import { Component, plugin, signal, xml } from "@odoo/owl";
import { BASE_BRANCH_RE } from "../core/config.js";
import { CodePlugin } from "../core/code_plugin.js";
import { ConfigPlugin, newTargetId } from "../core/config_plugin.js";
import { DatabasePlugin } from "../core/database_plugin.js";
import { DialogPlugin } from "../core/dialog_plugin.js";
import { EventLogPlugin } from "../core/event_log_plugin.js";
import { ServerPlugin } from "../core/server_plugin.js";
import { ICONS, appBus, m } from "../core/common.js";
import { Panel } from "../core/panel.js";
import { RemoteBranchDialog } from "../core/dialogs.js";
import { repoBranchList } from "../core/utils.js";
import { deleteWorkspaceDialog } from "../workspaces_screen/dialogs.js";

export async function createTargetFromRemoteBranch(config, eventLog, dialogs, branch, repos) {
  const existingTargets = config.config.targets;
  const configStr = repos.map((r) => `${r}:${branch}`).join(",");
  const res = await dialogs.open({
    title: "New target from remote branch",
    okLabel: "Create",
    validate: (v) => {
      const name = (v.name || "").trim();
      if (!name) return "a name is required";
      if (existingTargets.some((t) => t.name === name))
        return `a target named "${name}" already exists`;
      if (!repoBranchList.parse((v.config || "").trim()).length) return "a config is required";
      return "";
    },
    fields: [
      { key: "name", type: "text", label: "Name", value: branch, placeholder: "target name" },
      {
        key: "config",
        type: "text",
        label: "Config",
        value: configStr,
        placeholder: "community:branch,enterprise:branch",
      },
      { key: "db", type: "text", label: "Database", value: branch, placeholder: "database name" },
      { key: "args", type: "text", label: "Start args", placeholder: "-i sale_management" },
      { key: "demoData", type: "checkbox", label: "Demo data", value: true },
      { key: "fav", type: "checkbox", label: "Favorite", value: false },
    ],
  });
  if (!res) return;
  const target = {
    id: newTargetId(),
    name: res.name.trim(),
    favorite: !!res.fav,
    kind: "plain",
    checkouts: repoBranchList.parse(res.config.trim()),
    db: (res.db || "").trim(),
    on_create_args: (res.args || "").trim(),
    demo_data: !!res.demoData,
  };
  eventLog.add(`creating target ${target.name} from remote branch ${branch}`);
  config.updateConfig({ targets: [...config.config.targets, target] });
}

// Switch the working tree to a target's branches and make it the active target:
// stop the server if it's up and checkout concurrently (the checkout only swaps
// working-tree files, which the already-loaded Odoo doesn't care about), then
// record it as the last-used target. Used by the create dialog's "activate it".

export async function activateTarget(server, code, eventLog, target) {
  const pathByRepo = code.groups().pathByRepo;
  const repos = (target.checkouts || [])
    .map(({ repo, branch }) => ({ repo, path: pathByRepo[repo], branch }))
    .filter((r) => r.path);
  eventLog.add(`activating target ${target.name}`);
  const s = server.status().state;
  const stopping = s === "running" || s === "starting" ? server.stop() : null;
  await Promise.all([stopping, code.checkout(repos)]);
  server.setLastTarget(target.id);
}

export async function startCreateTarget(config, eventLog, code, dialogs, db, server) {
  const existingTargets = config.config.targets;
  await db.load(); // populate the "Clone db" select with the existing databases
  const dbNames = new Set(db.databases().map((d) => d.name));
  const dbOptions = db.databases().map((d) => ({ value: d.name, label: d.name }));
  const res = await dialogs.open({
    title: "New target",
    okLabel: "Create",
    validate: (v) => {
      const name = (v.name || "").trim();
      if (!name) return "a name is required";
      if (existingTargets.some((t) => t.name === name))
        return `a target named "${name}" already exists`;
      if (!repoBranchList.parse((v.config || "").trim()).length) return "a config is required";
      if ((v.cloneDb || "") && !(v.db || "").trim())
        return "set a database name to clone the selected database into";
      return "";
    },
    fields: [
      {
        key: "template",
        type: "select",
        label: "Template",
        placeholder: "— start blank —",
        options: existingTargets.map((t) => ({ value: t.id, label: t.name })),
        value: "",
        onChange: (tplId) => {
          if (!tplId) return null;
          const tpl = existingTargets.find((t) => t.id === tplId);
          if (!tpl) return null;
          const branchName =
            tpl.checkouts.find((c) => c.repo === "enterprise")?.branch ||
            tpl.checkouts.find((c) => c.repo === "community")?.branch ||
            "";
          return {
            name: branchName,
            config: repoBranchList.format(tpl.checkouts),
            db: tpl.db || "",
            args: tpl.on_create_args || "",
            demoData: tpl.demo_data ?? true,
            fav: !!tpl.favorite,
          };
        },
      },
      {
        key: "name",
        type: "text",
        label: "Name",
        placeholder: "name (e.g. master-mytask)",
        onChange: (newName, currentValues, oldValues) => {
          const oldName = oldValues.name;
          if (!oldName) return null;
          return {
            config: (currentValues.config || "").replaceAll(oldName, newName),
            db: (currentValues.db || "").replaceAll(oldName, newName),
          };
        },
      },
      {
        key: "config",
        type: "text",
        label: "Config",
        placeholder: "community:master,enterprise:master",
      },
      { key: "db", type: "text", label: "Database", placeholder: "database name" },
      { key: "args", type: "text", label: "Start args", placeholder: "-i sale_management" },
      {
        // off by default; tick it to clone an existing db into the target's db. The
        // revealed select is seeded with the template's db (when it's on disk), else
        // the first database — see Dialog.toggleCheckSelect.
        key: "cloneDb",
        type: "check-select",
        label: "Clone db",
        options: dbOptions,
        value: "",
        default: (v) => {
          const tpl = existingTargets.find((t) => t.id === v.template);
          if (tpl?.db && dbNames.has(tpl.db)) return tpl.db;
          return dbOptions[0]?.value || "";
        },
      },
      { key: "demoData", type: "checkbox", label: "Demo data", value: true },
      { key: "fav", type: "checkbox", label: "Favorite", value: false },
      { key: "createBranches", type: "checkbox", label: "Create branches", value: true },
      { key: "activate", type: "checkbox", label: "Activate it", value: true },
    ],
  });
  if (!res) return;
  const target = {
    id: newTargetId(),
    name: res.name.trim(),
    favorite: !!res.fav,
    kind: "plain",
    checkouts: repoBranchList.parse(res.config.trim()),
    db: (res.db || "").trim(),
    on_create_args: (res.args || "").trim(),
    demo_data: !!res.demoData,
  };
  eventLog.add(`creating target ${target.name}`);
  config.updateConfig({ targets: [...config.config.targets, target] });
  if (res.createBranches && code) {
    const tpl = existingTargets.find((t) => t.id === res.template);
    const baseBranchByRepo = Object.fromEntries(
      (tpl?.checkouts || []).map((c) => [c.repo, c.branch]),
    );
    const pathByRepo = Object.fromEntries(config.config.repos.map((r) => [r.id, r.path]));
    await code.createBranches(
      target.checkouts.map((c) => ({
        path: pathByRepo[c.repo],
        name: c.branch,
        startPoint: baseBranchByRepo[c.repo],
      })),
    );
  }
  // apply the target right away (checkout its branches + make it current). Done
  // before the db clone so a clone of the active db sees the server already
  // stopped (no needless stop/resume cycle).
  if (res.activate && server) {
    await activateTarget(server, code, eventLog, target);
  }
  // clone the chosen source database into the target's database name (skip when it
  // would clone onto itself — the destination already exists in that case). When the
  // source is the active db, the server is stopped for the clone and resumed after.
  if (res.cloneDb && target.db && res.cloneDb !== target.db) {
    await db.cloneStoppingServer(res.cloneDb, target.db);
  }
}

export class TargetsScreen extends Component {
  static components = { Panel };
  static template = xml`
    <section>
      <Panel title="'Targets'">
        <t t-set-slot="bottom-left">
          <button class="pbtn primary" t-on-click="() => this.startCreate()">New target</button>
          <button class="pbtn" t-on-click="() => this.targetFromRemoteBranch()">From remote branch</button>
          <button t-if="this.selectedCount" class="pbtn danger" t-on-click="() => this.deleteSelected()">Delete <t t-out="this.selectedCount"/></button>
          <span t-if="this.error()" class="form-error" t-out="this.error()"/>
        </t>
        <t t-set-slot="bottom-right">
          <span class="row-count" t-out="this.count"/>
        </t>
      </Panel>
      <div class="content br-fill">
        <div>
          <div t-if="!this.targets.length" class="dim br-empty">No targets.</div>
          <div t-else="" class="br-card">
            <!-- full-width card = scroll container (scrollbar on the right); the
                 wrapper sizes the table to its natural width, like the Branches list -->
            <div class="brg-table">
            <table class="br-table brg-flat">
              <thead>
                <tr><th><input type="checkbox" class="br-select" t-att-checked="this.allSelected" t-on-change="() => this.toggleSelectAll()" title="select all targets"/></th><th>Name</th><th/><th>Config</th><th>Database</th><th>Start args</th><th>Demo data</th><th/></tr>
              </thead>
              <tbody>
                <tr t-foreach="this.targets" t-as="tgt" t-key="tgt.id" t-att-class="{'br-editing': this.editId() === tgt.id, active: this.isActive(tgt), 'row-sel': this.selected().has(tgt.id), dragging: this.dragId() === tgt.id, 'drag-over': this.dragOverId() === tgt.id}" t-on-dragover="ev => this.onDragOver(ev, tgt)" t-on-drop="ev => this.onDrop(ev, tgt)">
                  <td>
                    <input type="checkbox" class="br-select" t-att-checked="this.selected().has(tgt.id)" t-on-change="() => this.toggleSelect(tgt.id)" title="select this target for batch actions"/>
                  </td>
                  <t t-if="this.editId() === tgt.id">
                    <td><input type="text" class="cell-input" t-att-value="this.draftName()" placeholder="name" t-on-input="ev => this.draftName.set(ev.target.value)" t-on-keydown="ev => this.onEditKey(ev)"/></td>
                    <td><button class="fav-star" t-att-class="{'is-fav': tgt.favorite}" title="Favorite targets show up on the Dashboard" t-on-click="() => this.toggleFavorite(tgt.id)"><t t-out="this.starIcon"/></button></td>
                    <td><input type="text" class="cell-input wide" t-att-value="this.draftConfig()" placeholder="community:master,enterprise:master" t-on-input="ev => this.draftConfig.set(ev.target.value)" t-on-keydown="ev => this.onEditKey(ev)"/></td>
                    <td><input type="text" class="cell-input" t-att-value="this.draftDb()" placeholder="database" t-on-input="ev => this.draftDb.set(ev.target.value)" t-on-keydown="ev => this.onEditKey(ev)"/></td>
                    <td><input type="text" class="cell-input" t-att-value="this.draftArgs()" placeholder="-i sale_management" t-on-input="ev => this.draftArgs.set(ev.target.value)" t-on-keydown="ev => this.onEditKey(ev)"/></td>
                    <td><input type="checkbox" class="br-select" t-att-checked="tgt.demo_data" t-on-change="() => this.toggleDemoData(tgt.id)" title="load demo data when this target creates its database"/></td>
                    <td>
                      <div class="br-act">
                        <button class="drop-btn pr-close" t-on-click="() => this.saveEdit()">Save</button>
                        <button class="drop-btn" t-on-click="() => this.cancelEdit()">Cancel</button>
                      </div>
                    </td>
                  </t>
                  <t t-else="">
                    <td class="tgt-name-handle" draggable="true" title="drag to reorder" t-on-dragstart="ev => this.onDragStart(ev, tgt)" t-on-dragend="() => this.onDragEnd()" t-out="tgt.name"/>
                    <td><button class="fav-star" t-att-class="{'is-fav': tgt.favorite}" title="Favorite targets show up on the Dashboard" t-on-click="() => this.toggleFavorite(tgt.id)"><t t-out="this.starIcon"/></button></td>
                    <td class="dim"><div class="br-ellip" t-att-title="this.fmtConfig(tgt)" t-out="this.fmtConfig(tgt)"/></td>
                    <td t-out="tgt.db"/>
                    <td class="dim"><div class="br-ellip" t-att-title="tgt.on_create_args" t-out="tgt.on_create_args || '—'"/></td>
                    <td><input type="checkbox" class="br-select" t-att-checked="tgt.demo_data" t-on-change="() => this.toggleDemoData(tgt.id)" title="load demo data when this target creates its database"/></td>
                    <td>
                      <div class="br-act">
                        <button class="dash-kebab" title="target actions"
                                t-on-click.stop="(ev) => this.openRowMenu(ev, tgt)"><t t-out="this.kebabIcon"/></button>
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
  server = plugin(ServerPlugin);
  code = plugin(CodePlugin);
  db = plugin(DatabasePlugin);
  dialogs = plugin(DialogPlugin);
  eventLog = plugin(EventLogPlugin);
  starIcon = m(ICONS.star);
  kebabIcon = m(ICONS.kebab);
  editId = signal(""); // id of the row being edited inline ("" = none)
  draftName = signal("");
  draftConfig = signal("");
  draftDb = signal("");
  draftArgs = signal("");
  error = signal(""); // inline-edit validation error
  selected = signal(new Set()); // target ids ticked for batch actions
  dragId = signal(""); // id of the target currently being dragged ("" = none)
  dragOverId = signal(""); // id of the row the drag is hovering over

  // This screen does no git/network on mount — the table is just config, and the
  // active-row highlight is browser-side (see isActive). Branch / PR / db state is
  // pulled lazily, scoped to the repos of the target(s) involved, when a kebab or
  // batch action actually needs it (see openRowMenu, _loadForDelete).

  // the deduped set of repo ids used by the given targets — to scope the lazy reads
  _repoIdsFor(targets) {
    const ids = new Set();
    for (const t of targets) for (const c of t.checkouts || []) ids.add(c.repo);
    return ids;
  }

  // branches + open PRs + the db list for the given targets' repos: what the delete
  // dialog needs to offer "also delete branches / close PRs / drop db"
  async _loadForDelete(targets) {
    const ids = this._repoIdsFor(targets);
    await Promise.all([this.code.load(false, ids, ids), this.db.load()]);
  }

  // repo id -> { current branch, dirty, branches map } — for the activate checks
  get repoMap() {
    const map = {};
    for (const repo of this.code.branchRepos()) {
      map[repo.id] = {
        current: repo.current,
        dirty: repo.dirty,
        branches: new Map((repo.branches || []).map((b) => [b.name, b])),
      };
    }
    return map;
  }

  // the active target: the explicit one (set on Activate / Start). A browser-side
  // fact — the running server's code + database belong to the last-activated target
  // regardless of what's currently checked out — so it needs no git read, which is
  // what lets this screen skip the per-repo branch scan on a passive visit. The id
  // check disambiguates overlapping targets (e.g. master vs master(e)).
  isActive(tgt) {
    const s = this.server.status();
    const id =
      s.state === "running" || s.state === "starting" ? s.target : this.server.lastTarget();
    return tgt.id === id;
  }

  _targetDirty(tgt) {
    const repos = this.repoMap;
    return (tgt.checkouts || []).some(({ repo }) => repos[repo]?.dirty);
  }

  _targetPresent(tgt) {
    const repos = this.repoMap;
    return (tgt.checkouts || []).every(({ repo, branch }) => repos[repo]?.branches.has(branch));
  }

  canActivate(tgt) {
    return !this.isActive(tgt) && this._targetPresent(tgt) && !this._targetDirty(tgt);
  }

  activateTitle(tgt) {
    if (this.isActive(tgt)) return "this target is already active";
    if (this._targetDirty(tgt)) return "commit or stash changes first — the working tree is dirty";
    if (!this._targetPresent(tgt)) return "some of this target's branches are missing locally";
    return "stop the server, switch to this target and check out its branches";
  }

  // stop the server, switch to this target, check out its branches — the action lives
  // on the Target model (it drives ServerPlugin/CodePlugin/EventLog itself)
  async activate(tgt) {
    if (!this.canActivate(tgt)) return;
    await this.config.target(tgt.id)?.activate();
  }

  // the configured order — reorderable by dragging a row's name
  get targets() {
    return this.config.config.targets;
  }

  onDragStart(ev, tgt) {
    this.dragId.set(tgt.id);
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", tgt.id); // some browsers need data to start a drag
  }

  onDragOver(ev, tgt) {
    if (!this.dragId()) return; // ignore drags that didn't start on a name handle
    ev.preventDefault(); // mark this row as a valid drop target
    ev.dataTransfer.dropEffect = "move";
    if (this.dragOverId() !== tgt.id) this.dragOverId.set(tgt.id);
  }

  onDrop(ev, tgt) {
    ev.preventDefault();
    this.reorderTargets(this.dragId(), tgt.id);
    this.onDragEnd();
  }

  onDragEnd() {
    this.dragId.set("");
    this.dragOverId.set("");
  }

  // move the dragged target to sit immediately before the drop target
  reorderTargets(fromId, toId) {
    if (!fromId || fromId === toId) return;
    const targets = [...this.config.config.targets];
    const from = targets.findIndex((t) => t.id === fromId);
    if (from < 0) return;
    const [moved] = targets.splice(from, 1);
    const to = targets.findIndex((t) => t.id === toId);
    if (to < 0) return;
    targets.splice(to, 0, moved);
    this.config.updateConfig({ targets });
  }

  get count() {
    const n = this.targets.length;
    return `${n} target${n === 1 ? "" : "s"}`;
  }

  fmtConfig(tgt) {
    return (
      this.config.target(tgt.id)?.checkoutsLabel() ??
      (tgt.checkouts || []).map((c) => `${c.repo}:${c.branch}`).join(", ")
    );
  }

  toggleFavorite(id) {
    this.config.target(id)?.toggleFavorite(); // logic + persistence live on the Target model
  }

  toggleDemoData(id) {
    this.config.target(id)?.toggleDemoData();
  }

  toggleSelect(id) {
    const sel = new Set(this.selected());
    sel.has(id) ? sel.delete(id) : sel.add(id);
    this.selected.set(sel);
  }

  get _selectableTargets() {
    return this.targets.filter((t) => !this.isActive(t));
  }

  get allSelected() {
    const sel = this.selected();
    const selectable = this._selectableTargets;
    return selectable.length > 0 && selectable.every((t) => sel.has(t.id));
  }

  toggleSelectAll() {
    this.selected.set(
      this.allSelected ? new Set() : new Set(this._selectableTargets.map((t) => t.id)),
    );
  }

  get _selectedTargets() {
    const sel = this.selected();
    return this.targets.filter((t) => sel.has(t.id) && !this.isActive(t));
  }

  get selectedCount() {
    return this._selectedTargets.length;
  }

  async deleteSelected() {
    const targets = this._selectedTargets;
    if (!targets.length) return;
    await this._loadForDelete(targets); // branches + PRs + db for the cleanup options
    const repos = this.repoMap;
    const groups = this.code.groups();

    // aggregate deletable branches across all selected targets
    const allBranches = targets.flatMap((tgt) =>
      (tgt.checkouts || [])
        .map(({ repo, branch }) => ({ repo, branch, b: repos[repo]?.branches.get(branch) }))
        .filter((x) => x.b && !BASE_BRANCH_RE.test(x.branch))
        .map((x) => ({
          repo: x.repo,
          branch: x.branch,
          path: groups.pathByRepo[x.repo],
          remote: !!x.b.remote,
        })),
    );

    // aggregate open PRs across all selected targets
    const allPrs = targets.flatMap((tgt) =>
      (tgt.checkouts || [])
        .map(({ repo, branch }) => ({
          pr: groups.prIndex[`${repo}:${branch}`],
          github: groups.githubByRepo[repo],
        }))
        .filter((x) => x.pr && x.pr.state === "open" && x.github)
        .map((x) => ({ github: x.github, number: x.pr.number })),
    );

    // aggregate existing databases across all selected targets
    const existingDbs = this.db.databases().map((d) => d.name);
    const allDbs = [
      ...new Set(targets.map((t) => t.db).filter((db) => db && existingDbs.includes(db))),
    ];

    const n = targets.length;
    const fields = [];
    if (allBranches.length)
      fields.push({
        key: "delBranches",
        type: "checkbox",
        label: `Also delete ${allBranches.length === 1 ? "their branch" : `their ${allBranches.length} branches`}`,
        value: true,
      });
    if (allBranches.some((b) => b.remote))
      fields.push({
        key: "delRemote",
        type: "checkbox",
        label: "…also on the remote (odoo-dev)",
        value: true,
      });
    if (allPrs.length)
      fields.push({
        key: "closePrs",
        type: "checkbox",
        label: `Close ${allPrs.length === 1 ? "their open pull request" : `their ${allPrs.length} open pull requests`}`,
        value: true,
      });
    if (allDbs.length)
      fields.push({
        key: "dropDbs",
        type: "checkbox",
        label: `Drop ${allDbs.length === 1 ? `database "${allDbs[0]}"` : `their ${allDbs.length} databases`}`,
        value: true,
      });

    const res = await this.dialogs.open({
      title: `Delete ${n} target${n === 1 ? "" : "s"}?`,
      message: "The targets will be removed from your list. This cannot be undone.",
      okLabel: "Delete",
      fields,
    });
    if (!res) return;

    for (const t of targets) this.eventLog.add(`deleting target ${t.name}`);
    // independent ops across all selected targets — run them concurrently (each
    // helper swallows its own errors, so Promise.all never rejects here)
    const ops = [];
    if (res.closePrs)
      for (const p of allPrs) ops.push(this.code.closePrNoConfirm(p.github, p.number));
    if (res.delBranches)
      for (const b of allBranches)
        ops.push(
          this.code.deleteBranchNoConfirm(b.branch, b.repo, b.path, !!res.delRemote && b.remote),
        );
    if (res.dropDbs) for (const db of allDbs) ops.push(this.db.drop(db));
    await Promise.all(ops);

    const deletedIds = new Set(targets.map((t) => t.id));
    this.config.updateConfig({
      targets: this.config.config.targets.filter((t) => !deletedIds.has(t.id)),
    });
    this.selected.set(new Set());
  }

  // create a new target through a dialog form (validated before it closes)
  startCreate() {
    return startCreateTarget(
      this.config,
      this.eventLog,
      this.code,
      this.dialogs,
      this.db,
      this.server,
    );
  }

  // search for a remote branch across all repos, fetch it locally, then open
  // the prefilled target creation dialog
  async targetFromRemoteBranch() {
    const res = await this.dialogs.openComponent(RemoteBranchDialog);
    if (!res) return;
    const { branch, repos } = res;
    const pathByRepo = this.code.groups().pathByRepo;
    for (const repoId of repos) {
      const path = pathByRepo[repoId];
      if (!path) continue;
      await fetch("/api/code/remote-branch/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, branch }),
      });
    }
    await createTargetFromRemoteBranch(this.config, this.eventLog, this.dialogs, branch, repos);
  }

  // regroup the per-target actions into the floating kebab menu (shared ActionMenu)
  async openRowMenu(ev, tgt) {
    const rect = ev.currentTarget.getBoundingClientRect(); // capture before the await
    // Apply's enabled state + its "dirty / missing branch" tooltip need this target's
    // checkout state — read it now, scoped to just this target's repos
    await this.code.loadBranches(this._repoIdsFor([tgt]));
    const active = this.isActive(tgt);
    const actions = [
      { label: "Edit", onClick: () => this.startEdit(tgt) },
      {
        label: "Apply",
        disabled: !this.canActivate(tgt),
        title: this.activateTitle(tgt),
        onClick: () => this.activate(tgt),
      },
      { label: "Duplicate", onClick: () => this.duplicateTarget(tgt) },
      {
        label: "Delete",
        danger: true,
        disabled: active,
        title: active ? "the active target cannot be deleted" : "",
        onClick: () => this.deleteTarget(tgt),
      },
    ];
    appBus.dispatchEvent(new CustomEvent("action-menu", { detail: { rect, actions } }));
  }

  // turn one row into inline inputs, pre-filled with the target's values
  // (only one row is editable at a time)
  startEdit(tgt) {
    this.draftName.set(tgt.name);
    this.draftConfig.set(repoBranchList.format(tgt.checkouts));
    this.draftDb.set(tgt.db || "");
    this.draftArgs.set(tgt.on_create_args || "");
    this.error.set("");
    this.editId.set(tgt.id);
  }

  // commit the inline edit back onto the target (favorite is left untouched —
  // it is toggled directly via the star)
  saveEdit() {
    const id = this.editId();
    const name = this.draftName().trim();
    if (!name) return this.error.set("a name is required");
    if (this.config.config.targets.some((t) => t.name === name && t.id !== id))
      return this.error.set(`a target named "${name}" already exists`);
    const checkouts = repoBranchList.parse(this.draftConfig().trim());
    if (!checkouts.length) return this.error.set("a config is required");
    // the edit itself lives on the Target model (favorite is left untouched)
    this.config.target(id).applyEdit({
      name,
      checkouts,
      db: this.draftDb().trim(),
      on_create_args: this.draftArgs().trim(),
    });
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

  // clone a target onto a chosen branch: ask (via a dialog) for a branch name —
  // prefilled from the first configured branch — and point every repo at it.
  // When "Create branches" is checked, also create that branch in each repo,
  // starting from the repo's branch in the original target (its base).
  async duplicateTarget(tgt) {
    const first = tgt.checkouts?.[0]?.branch || "master";
    const res = await this.dialogs.open({
      title: `Duplicate "${tgt.name}"`,
      fields: [
        {
          key: "branch",
          type: "text",
          label: "Branch name",
          value: first,
          placeholder: "branch (applied to all repos)",
        },
        { key: "create", type: "checkbox", label: "Create branches", value: true },
      ],
    });
    if (!res) return;
    const b = (res.branch || "").trim();
    if (!b) return;
    // the new target is named after the chosen branch (deduped if it collides)
    const names = new Set(this.config.config.targets.map((t) => t.name));
    let name = b;
    for (let i = 2; names.has(name); i++) name = `${b} (${i})`;
    const copy = {
      id: newTargetId(),
      name,
      favorite: !!tgt.favorite,
      kind: "plain",
      checkouts: (tgt.checkouts || []).map((c) => ({ repo: c.repo, branch: b })),
      db: b, // default the database to the branch name
      on_create_args: tgt.on_create_args || "",
      demo_data: tgt.demo_data ?? true,
    };
    this.eventLog.add(`creating target ${copy.name}`);
    this.config.updateConfig({ targets: [...this.config.config.targets, copy] });
    if (res.create) {
      const pathByRepo = Object.fromEntries(this.config.config.repos.map((r) => [r.id, r.path]));
      await this.code.createBranches(
        (tgt.checkouts || []).map((c) => ({
          path: pathByRepo[c.repo],
          name: b,
          startPoint: c.branch, // start from the base
        })),
      );
    }
  }

  async deleteTarget(tgt) {
    await this._loadForDelete([tgt]); // branches + PRs + db for the cleanup options
    return deleteWorkspaceDialog(tgt, {
      config: this.config,
      code: this.code,
      db: this.db,
      eventLog: this.eventLog,
      repoMap: this.repoMap,
      dialogs: this.dialogs,
      isActive: this.isActive(tgt),
    });
  }
}
