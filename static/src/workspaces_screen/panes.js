// The Workspaces screen's Tests / Addons / Assets tab panes — per-workspace,
// addressing the plugins' per-slot state ("main" for a main-located workspace,
// the workspace id for a worktree). These replaced the standalone Tests / Addons
// / Assets screens in Phase 5.

import { Component, plugin, props, signal, t, untrack, useEffect, xml } from "@odoo/owl";
import { AddonsPlugin } from "../addons_screen/addons_plugin.js";
import { AssetsPlugin } from "../assets_screen/assets_plugin.js";
import { ConfigPlugin } from "../core/config_plugin.js";
import { ServerPlugin } from "../core/server_plugin.js";
import { TestsPlugin, slotFor } from "../core/tests_plugin.js";
import { WorkspacePlugin } from "../core/workspace_plugin.js";
import { AssetsAnalysis, bundleBase } from "../assets_screen/analysis.js";
import { ICONS, LogConsole, SearchBox, m } from "../core/common.js";
import { formatBytes } from "../core/utils.js";

// ─────────────────────────── Tests pane ───────────────────────────

export class TestsPane extends Component {
  static components = { LogConsole };
  static template = xml`
    <div class="ws-run-pane">
      <form class="test-form" t-on-submit.prevent="() => this.run()">
        <select class="preset-select" t-on-change="(ev) => this.onPreset(ev)" title="presets and recent test tags">
          <option value="" selected="selected" hidden="hidden">Presets</option>
          <optgroup t-if="this.presets.length" label="Presets">
            <option t-foreach="this.presets" t-as="p" t-key="p_index" t-att-value="p.tags" t-out="p.tags"/>
          </optgroup>
          <optgroup t-if="this.tests.history().length" label="Recent">
            <option t-foreach="this.tests.history()" t-as="h" t-key="h_index" t-att-value="h" t-out="h"/>
          </optgroup>
        </select>
        <input type="text" t-att-value="this.tags()" t-on-input="ev => this.tags.set(ev.target.value)" autocomplete="off"
               placeholder="--test-tags, e.g. my_module, :TestClass, /module_tour"/>
        <button t-if="this.slotId === 'main'" type="button" class="tool-btn" t-att-disabled="!this.tags().trim()"
                title="Copy a 'goo --test-tags …' command for these tags — run it on this machine (e.g. hand it to an agent) to run the test from the CLI"
                t-on-click="() => this.copyCommand()"><t t-out="this.copyIcon"/></button>
        <button type="submit" t-att-disabled="this.tests.runActive(this.slotId) or !this.tags().trim()"><span class="play"/>Run</button>
        <button type="button" class="stop" t-att-disabled="!this.tests.runningFor(this.slotId)" t-on-click="() => this.stop()"><span class="ic square"/>Stop</button>
        <span t-if="this.badge" class="test-badge" t-att-class="this.badge.cls" t-out="this.badge.label"/>
        <div class="log-controls">
          <label class="toggle" t-att-class="{on: this.slot.output.autoScroll()}" t-on-click="() => this.toggleAuto()"><span class="switch"/>Autoscroll</label>
          <button type="button" class="tool-btn" t-on-click="() => this.slot.output.clear()"><t t-out="this.clearIcon"/>Clear</button>
        </div>
      </form>
      <div t-if="!this.slot.output.count() and !this.tests.runActive(this.slotId)" class="ws-empty-note dim">
        No test output yet — pick a preset or type <code>--test-tags</code>, then hit Run.
        The run uses this workspace's database and checkout.
      </div>
      <LogConsole t-key="this.props.ws.id" title="'Test output'" buffer="this.slot.output" bare="true"/>
    </div>`;

  props = props({ ws: t.any() });
  tests = plugin(TestsPlugin);
  server = plugin(ServerPlugin);
  config = plugin(ConfigPlugin);
  wt = plugin(WorkspacePlugin);
  clearIcon = m(ICONS.clear);
  copyIcon = m(ICONS.copy);
  tags = signal("");

  // copy a `goo --test-tags …` command for the current tags (single-quoted so the
  // shell doesn't mangle globs). Main slot only — the CLI runs against the ACTIVE
  // workspace, which is wrong for a worktree workspace's pane.
  copyCommand() {
    const tags = this.tags().trim();
    if (!tags) return;
    navigator.clipboard?.writeText(`goo --test-tags '${tags.replace(/'/g, "'\\''")}'`);
  }

  get slotId() {
    return slotFor(this.props.ws);
  }

  get slot() {
    return this.tests.slot(this.slotId);
  }

  get presets() {
    return (this.config.config.test_presets || []).filter((p) => (p.tags || "").trim());
  }

  get badge() {
    const s = this.slot.status();
    if (s === "passed") return { label: "success", cls: "ok" };
    if (s.startsWith("failed")) return { label: "fail", cls: "fail" };
    if (s === "running…" || s === "starting…") return { label: "running", cls: "run" };
    return null;
  }

  run() {
    this.tests.run(this.tags(), this.props.ws);
  }

  // stopping the slot's server kills the run; the backend finalizes it and
  // resumes the server the run had interrupted
  stop() {
    if (this.slotId === "main") this.server.stop();
    else this.wt.stopServer(this.props.ws);
  }

  onPreset(ev) {
    const v = ev.target.value;
    ev.target.value = "";
    if (v) this.tags.set(v);
  }

  toggleAuto() {
    const b = this.slot.output;
    b.autoScroll.set(!b.autoScroll());
    if (b.autoScroll()) b.toBottom();
  }
}

// ─────────────────────────── Addons pane ───────────────────────────

export class AddonsPane extends Component {
  static components = { LogConsole, SearchBox };
  static template = xml`
    <div class="ws-run-pane">
      <div class="ws-pane-toolbar">
        <SearchBox value="this.addons.filter"/>
        <button class="pbtn" t-att-class="{active: this.addons.stateFilter() === 'installed'}" t-on-click="() => this.toggleState('installed')">Installed</button>
        <button class="pbtn" t-att-class="{active: this.addons.stateFilter() === 'uninstalled'}" t-on-click="() => this.toggleState('uninstalled')">Uninstalled</button>
        <button class="pbtn" t-att-class="{active: this.addons.appOnly()}" t-on-click="() => this.addons.appOnly.set(!this.addons.appOnly())">Apps</button>
        <button class="pbtn" title="reload the module list" t-on-click="() => this.addons.load(this.props.ws)"><span class="restart"/></button>
        <span t-if="this.slot.status()" class="dim ws-sec-meta" t-out="this.slot.status()"/>
        <span class="dim ws-sec-meta ws-pane-count" t-out="this.count"/>
      </div>
      <div t-if="this.slot.loading()" class="dim ws-empty-note">Loading modules…</div>
      <div t-elif="this.slot.error()" class="ws-empty-note form-error" t-out="this.slot.error()"/>
      <div t-elif="!this.view.total" class="dim ws-empty-note">No modules match — check the filters, or the database may not exist yet.</div>
      <div t-else="" class="ws-addons-scroll">
        <table class="br-table brg-flat">
          <thead>
            <tr><th>Module</th><th>Summary</th><th>Repository</th><th>State</th><th/></tr>
          </thead>
          <tbody>
            <tr t-foreach="this.view.shown" t-as="mod" t-key="mod.name">
              <td class="addon-name" t-att-title="mod.summary" t-out="mod.name"/>
              <td class="dim"><div class="br-ellip" t-att-title="mod.summary" t-out="mod.summary || '—'"/></td>
              <td class="dim" t-out="mod.repo"/>
              <td><span class="addon-state" t-att-class="this.stateClass(mod)" t-out="mod.state || 'not installed'"/></td>
              <td>
                <div class="br-act">
                  <button class="addon-btn" t-att-disabled="this.addons.runActive(this.slotId) or mod.installable === false"
                          t-on-click="() => this.addons.run(mod.state === 'installed' ? 'upgrade' : 'install', mod.name, this.props.ws)"
                          t-out="mod.state === 'installed' ? 'Upgrade' : 'Install'"/>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div t-if="this.view.total > this.view.shown.length" class="dim addons-more"
             t-out="'Showing ' + this.view.shown.length + ' of ' + this.view.total + ' — refine the filter to see more.'"/>
      </div>
      <LogConsole t-if="this.addons.runActive(this.slotId) or this.addons.runningFor(this.slotId)"
                  t-key="this.props.ws.id" title="'Install / upgrade output'" buffer="this.slot.output" extraClass="'addons-console'"/>
    </div>`;

  props = props({ ws: t.any() });
  addons = plugin(AddonsPlugin);

  setup() {
    // load (and reload when the workspace's db changes) while mounted
    useEffect(() => {
      const db = this.props.ws.db;
      if (db && db !== this.slot.loadedDb() && db !== this.slot.erroredDb() && !this.slot.loading())
        this.addons.load(this.props.ws);
    });
  }

  get slotId() {
    return slotFor(this.props.ws);
  }

  get slot() {
    return this.addons.slot(this.slotId);
  }

  get view() {
    return this.slot.filtered();
  }

  get count() {
    const n = this.view.total;
    return `${n} module${n === 1 ? "" : "s"}`;
  }

  toggleState(value) {
    this.addons.stateFilter.set(this.addons.stateFilter() === value ? "" : value);
  }

  stateClass(mod) {
    return (mod.state || "none").replace(/\s+/g, "-");
  }
}

// ─────────────────────────── Assets pane ───────────────────────────

// A slim bundle list for the workspace's db (name + size + Generate). The full
// analysis view stays on the standalone Assets screen until Phase 5. Note: the
// assets plugin is db-scoped with ONE selected db — the pane forces it to the
// workspace's db, so it and the standalone screen share the selection (accepted
// quirk while both exist).

export class AssetsPane extends Component {
  static components = { AssetsAnalysis, SearchBox };
  static template = xml`
    <div class="ws-run-pane">
      <AssetsAnalysis t-if="this.assets.bundleData()"/>
      <t t-else="">
        <div class="ws-pane-toolbar">
          <span class="dim ws-sec-meta">db <b t-out="this.props.ws.db"/></span>
          <SearchBox value="this.search"/>
          <label class="assets-chk"><input type="checkbox" t-att-checked="this.showJs()" t-on-change="() => this.showJs.set(!this.showJs())"/>js</label>
          <label class="assets-chk"><input type="checkbox" t-att-checked="this.showCss()" t-on-change="() => this.showCss.set(!this.showCss())"/>css</label>
          <label class="assets-chk"><input type="checkbox" t-att-checked="this.showOther()" t-on-change="() => this.showOther.set(!this.showOther())"/>other</label>
          <button class="pbtn" title="reload the bundle list" t-on-click="() => this.assets.load(true)"><span class="restart"/></button>
          <button class="pbtn" t-att-disabled="this.assets.generating()" title="pregenerate all bundles (odoo-bin shell, this workspace's checkout)"
                  t-on-click="() => this.assets.generate(this.wsForGenerate)" t-out="this.assets.generating() ? 'Generating…' : 'Generate'"/>
          <span class="dim ws-sec-meta ws-pane-count" t-out="this.meta"/>
        </div>
        <div t-if="this.assets.loading()" class="dim ws-empty-note">Loading bundles…</div>
        <div t-elif="this.assets.error()" class="ws-empty-note form-error" t-out="this.assets.error()"/>
        <div t-elif="this.mismatch" class="dim ws-empty-note">Loading this workspace's bundles…</div>
        <div t-elif="!this.bundles.length" class="dim ws-empty-note">No bundle matches — check the filters, or Generate builds them all (the database may not exist yet).</div>
        <div t-else="" class="ws-addons-scroll">
          <table class="br-table brg-flat">
            <thead>
              <tr>
                <th class="br-sort" t-on-click="() => this.sort('name')">Bundle<span class="br-arrow" t-out="this.sortArrow('name')"/></th>
                <th class="br-sort ws-num" t-on-click="() => this.sort('size')">Size<span class="br-arrow" t-out="this.sortArrow('size')"/></th>
              </tr>
            </thead>
            <tbody>
              <tr t-foreach="this.bundles" t-as="b" t-key="b.id">
                <td class="addon-name">
                  <button class="assets-name" t-att-title="'analyze ' + this.base(b.name) + '.min bundle'" t-on-click="() => this.analyze(b)" t-out="b.name"/>
                  <button class="assets-copy" t-att-title="'copy ' + b.url" t-on-click="() => this.copyUrl(b)" t-out="this.copiedId() === b.id ? 'copied' : 'copy url'"/>
                </td>
                <td class="ws-num" t-out="this.size(b)"/>
              </tr>
            </tbody>
          </table>
        </div>
      </t>
    </div>`;

  props = props({ ws: t.any() });
  assets = plugin(AssetsPlugin);
  search = signal("");
  showJs = signal(true); // include .js bundles
  showCss = signal(true); // include .css bundles
  showOther = signal(true); // include non-js/non-css assets (fonts, source maps, xml…)
  sortKey = signal("size"); // "name" | "size"
  sortDir = signal("desc"); // "asc" | "desc" — default: largest bundle first
  copiedId = signal(null); // id of the row whose url was just copied (transient label)

  setup() {
    // point the (db-scoped) assets plugin at this workspace's db, closing any open
    // analysis from another workspace's pane. selectedDb is read/written UNTRACKED:
    // a t-key workspace switch briefly leaves the outgoing pane's effect alive (owl
    // destroys it deferred), and a tracked read would let the two instances
    // re-trigger each other over the shared signal forever — a microtask loop that
    // starves the event loop and freezes the page.
    useEffect(() => {
      const db = this.props.ws.db;
      if (db)
        untrack(() => {
          if (this.assets.selectedDb() === db) return;
          this.assets.closeAnalysis(); // plugin-global — don't leak across workspaces
          this.assets.selectDb(db);
        });
    });
  }

  // only pass the workspace to generate() when its checkout differs from the main
  // one (a worktree) — the backend then builds the shell cmd from its copies
  get wsForGenerate() {
    return this.props.ws.location === "worktree" ? this.props.ws : null;
  }

  get mismatch() {
    return this.assets.loadedDb() !== this.props.ws.db;
  }

  // js / css / other, from the bundle's extension. Source maps (.js.map / .css.map)
  // and everything that isn't plain js/css (fonts, xml, …) count as "other".
  kind(b) {
    if (/\.map$/i.test(b.name)) return "other";
    if (/\.css$/i.test(b.name)) return "css";
    if (/\.js$/i.test(b.name)) return "js";
    return "other";
  }

  // search- and kind-filtered bundles, sorted by the active column
  get bundles() {
    const q = this.search().trim().toLowerCase();
    const showJs = this.showJs();
    const showCss = this.showCss();
    const showOther = this.showOther();
    const dir = this.sortDir() === "asc" ? 1 : -1;
    const bySize = this.sortKey() === "size";
    return this.assets
      .bundles()
      .filter((b) => {
        const k = this.kind(b);
        if (k === "js" && !showJs) return false;
        if (k === "css" && !showCss) return false;
        if (k === "other" && !showOther) return false;
        return !q || b.name.toLowerCase().includes(q) || b.url.toLowerCase().includes(q);
      })
      .sort((a, b) =>
        bySize ? dir * ((a.size || 0) - (b.size || 0)) : dir * a.name.localeCompare(b.name),
      );
  }

  // toggle direction when re-clicking the active column, else switch column with a
  // sensible default (names ascending A→Z, sizes descending largest-first)
  sort(key) {
    if (this.sortKey() === key) {
      this.sortDir.set(this.sortDir() === "asc" ? "desc" : "asc");
    } else {
      this.sortKey.set(key);
      this.sortDir.set(key === "size" ? "desc" : "asc");
    }
  }

  // " ▲" / " ▼" for the active sort column, else ""
  sortArrow(key) {
    if (this.sortKey() !== key) return "";
    return this.sortDir() === "asc" ? " ▲" : " ▼";
  }

  base(name) {
    return bundleBase(name);
  }

  // analyze the bundle this row belongs to (its per-file size breakdown), scoped to
  // the clicked attachment's kind so the total matches its row size: any .css/.css.map
  // → css, everything else (.min.js, .js.map, …) → js.
  analyze(b) {
    const kind = /\.css(\.map)?$/i.test(b.name) ? "css" : "js";
    this.assets.analyze(bundleBase(b.name), kind);
  }

  // copy a bundle's /web/assets/… path to the clipboard, flipping its link to
  // "copied" for a moment
  copyUrl(b) {
    navigator.clipboard?.writeText(b.url);
    this.copiedId.set(b.id);
    setTimeout(() => {
      if (this.copiedId() === b.id) this.copiedId.set(null);
    }, 1400);
  }

  get meta() {
    const n = this.bundles.length;
    return this.mismatch ? "" : `${n} bundle${n === 1 ? "" : "s"}`;
  }

  size(b) {
    return formatBytes(b.size || 0);
  }
}
