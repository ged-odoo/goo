import { Component, plugin, props, signal, t, xml } from "@odoo/owl";
import { formatBytes, timeAgo } from "../utils.js";
import { AssetsPlugin } from "../plugins/assets_plugin.js";
import { DatabasePlugin } from "../plugins/database_plugin.js";
import { ICONS, SearchBox, m } from "./common.js";

export class BundleNode extends Component {
  static template = xml`
    <div class="bnode">
      <div class="bnode-row" t-att-class="{leaf: !this.props.node.children.length}" t-att-style="'padding-left:' + (this.props.depth * 14 + 10) + 'px'" t-on-click="() => this.toggle()">
        <span class="bnode-caret" t-out="this.props.node.children.length ? (this.open() ? '▾' : '▸') : ''"/>
        <span class="bnode-name" t-out="this.props.node.name"/>
        <span class="bnode-size" t-out="this.fmt(this.props.node.size)"/>
      </div>
      <t t-if="this.open()">
        <BundleNode t-foreach="this.props.node.children" t-as="c" t-key="c.name" node="c" depth="this.props.depth + 1"/>
      </t>
    </div>`;

  props = props({ node: t.any(), depth: t.any() });
  open = signal(false);

  setup() {
    if (this.props.depth === 0) this.open.set(true);
  }

  toggle() {
    if (this.props.node.children.length) this.open.set(!this.open());
  }

  fmt(n) {
    return formatBytes(n);
  }
}
BundleNode.components = { BundleNode };

// Inspect a database's asset bundles: pick a db, list its /web/assets/* attachments
// (ir_attachment in the db/filestore), force a fresh pregeneration, and analyze one
// bundle's per-file size breakdown (click a bundle name).

export class AssetsScreen extends Component {
  static components = { SearchBox, BundleNode };
  static template = xml`
    <section>
      <div class="panel">
        <div class="panel-top has-filters">
          <h1>Assets</h1>
          <div class="panel-filters">
            <SearchBox value="this.search"/>
            <label class="assets-chk"><input type="checkbox" t-att-checked="this.showJs()" t-on-change="() => this.showJs.set(!this.showJs())"/>js</label>
            <label class="assets-chk"><input type="checkbox" t-att-checked="this.showCss()" t-on-change="() => this.showCss.set(!this.showCss())"/>css</label>
            <label class="assets-chk"><input type="checkbox" t-att-checked="this.showOther()" t-on-change="() => this.showOther.set(!this.showOther())"/>other</label>
          </div>
          <div class="panel-top-right">
            <span class="meta" t-out="this.stamp"/>
            <button class="pbtn" t-att-disabled="!this.assets.selectedDb() or this.assets.busy()" t-on-click="() => this.assets.load(true)"><t t-out="this.refreshIcon"/>Refresh</button>
          </div>
        </div>
        <div class="panel-actions">
          <select t-att-value="this.assets.selectedDb()" t-on-change="ev => this.assets.selectDb(ev.target.value)" title="database to inspect">
            <option value="">Select a database…</option>
            <option t-foreach="this.dbOptions" t-as="d" t-key="d" t-att-value="d" t-out="d"/>
          </select>
          <button class="pbtn" t-att-disabled="!this.assets.selectedDb() or this.assets.busy()" t-on-click="() => this.assets.generate()">Generate asset bundles</button>
          <span t-if="this.assets.selectedDb()" class="row-count" t-out="this.count"/>
        </div>
      </div>
      <div class="content br-fill">
        <t t-if="this.assets.bundleData()">
          <div class="assets-analysis">
            <div class="assets-analysis-bar">
              <button class="pbtn" t-on-click="() => this.assets.closeAnalysis()">← Back</button>
              <span class="assets-analysis-title" t-out="this.analysisTitle"/>
              <span class="meta" t-out="this.analysisTotal"/>
              <div class="assets-analysis-views">
                <SearchBox value="this.treeSearch"/>
                <button class="pbtn" t-att-class="{active: this.view() === 'tree'}" t-on-click="() => this.view.set('tree')">Aggregate</button>
                <button class="pbtn" t-att-class="{active: this.view() === 'flat'}" t-on-click="() => this.view.set('flat')">Flat</button>
              </div>
            </div>
            <div class="assets-tree">
              <div t-if="this.assets.analyzing()" class="dim br-empty">Analyzing…</div>
              <div t-elif="this.assets.analyzeError()" class="dim br-empty" t-out="'Analysis failed: ' + this.assets.analyzeError()"/>
              <div t-elif="!this.flat.length" class="dim br-empty">No files in this bundle.</div>
              <div t-else="" class="assets-tree-inner">
                <t t-if="this.view() === 'tree'">
                  <BundleNode t-foreach="this.tree" t-as="n" t-key="n.name" node="n" depth="0"/>
                </t>
                <t t-else="">
                  <div t-foreach="this.flat" t-as="f" t-key="f.path" class="bflat-row">
                    <span class="bnode-name" t-out="f.path"/>
                    <span class="bnode-size" t-out="this.fmtSize(f.bytes)"/>
                  </div>
                </t>
              </div>
            </div>
          </div>
        </t>
        <t t-else="">
        <div t-att-class="{busy: this.assets.busy()}">
          <div t-if="!this.assets.selectedDb()" class="dim br-empty">Select a database to list its asset bundles.</div>
          <div t-elif="this.assets.error()" class="dim br-empty" t-out="'Failed to load: ' + this.assets.error()"/>
          <div t-elif="this.assets.loading() and !this.rows().length" class="dim br-empty">Loading…</div>
          <div t-elif="!this.rows().length" class="dim br-empty">No asset bundles in this database.</div>
          <div t-else="" class="br-card">
            <div class="brg-table">
              <table class="br-table brg-flat">
                <thead>
                  <tr>
                    <th class="br-sort" t-on-click="() => this.sort('name')">Bundle<span class="br-arrow" t-out="this.sortArrow('name')"/></th>
                    <th class="br-sort" t-on-click="() => this.sort('size')">Size<span class="br-arrow" t-out="this.sortArrow('size')"/></th>
                  </tr>
                </thead>
                <tbody>
                  <tr t-foreach="this.rows()" t-as="b" t-key="b.id">
                    <td class="addon-name">
                      <button class="assets-name" t-att-title="'analyze ' + this.bundleBase(b.name) + '.min bundle'" t-on-click="() => this.analyze(b)" t-out="b.name"/>
                      <button class="assets-copy" t-att-title="'copy ' + b.url" t-on-click="() => this.copyUrl(b)" t-out="this.copiedId() === b.id ? 'copied' : 'copy url'"/>
                    </td>
                    <td t-out="this.fmtSize(b.size)"/>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
        </t>
      </div>
    </section>`;

  assets = plugin(AssetsPlugin);
  db = plugin(DatabasePlugin);
  refreshIcon = m(ICONS.refresh);
  view = signal("tree"); // analysis view: "tree" (aggregate) | "flat"
  treeSearch = signal(""); // filter files within the analysis
  copiedId = signal(null); // id of the row whose url was just copied (transient label)
  sortKey = signal("size"); // "name" | "size"
  sortDir = signal("desc"); // "asc" | "desc" — default: largest bundle first
  search = signal("");
  showJs = signal(true); // include .js bundles
  showCss = signal(true); // include .css bundles
  showOther = signal(true); // include non-js/non-css assets (fonts, source maps, xml…)

  setup() {
    this.db.load(); // populate the database selector
    if (!this.assets.selectedDb()) {
      const d = this.assets.defaultDb();
      if (d) this.assets.selectDb(d);
    }
  }

  get dbOptions() {
    return this.db.databases().map((d) => d.name);
  }

  get stamp() {
    if (this.assets.generating()) return "generating…";
    if (this.assets.loading()) return "loading…";
    return this.assets.at() ? `updated ${timeAgo(new Date(this.assets.at()).toISOString())}` : "";
  }

  get count() {
    const n = this.rows().length;
    return `${n} bundle${n === 1 ? "" : "s"}`;
  }

  // the bundle base name an attachment belongs to, e.g. "web.assets_web.min.js" or
  // "web.assets_web.css.map" -> "web.assets_web"
  bundleBase(name) {
    return name.replace(/\.map$/, "").replace(/(\.min)?\.(js|css|xml)$/, "");
  }

  // analyze the bundle this row belongs to (its per-file size breakdown), scoped to
  // the clicked attachment's kind so the total matches its row size: any .css/.css.map
  // → css, everything else (.min.js, .js.map, …) → js.
  analyze(b) {
    const kind = /\.css(\.map)?$/i.test(b.name) ? "css" : "js";
    this.assets.analyze(this.bundleBase(b.name), kind);
  }

  // the analyzed attachment's name, e.g. "web.assets_web.min.js" — the .min asset the
  // breakdown was scoped to, so it reads as the row that was clicked
  get analysisTitle() {
    const d = this.assets.bundleData();
    if (!d) return "";
    return `${d.name}.min.${d.kind === "css" ? "css" : "js"}`;
  }

  // total minified size across the analyzed bundle's js + css + xml
  get analysisTotal() {
    const d = this.assets.bundleData();
    if (!d) return "";
    const all = [...(d.js || []), ...(d.css || []), ...(d.xml || [])];
    return `${formatBytes(all.reduce((s, [, n]) => s + n, 0))} minified`;
  }

  // the analyzed bundle's files as a flat list ({path, bytes}), search-filtered,
  // largest first. Same path can occur more than once (e.g. a template and its
  // registerTemplateExtension share their base template's name) — merge those into
  // one row (sizes summed), matching how the tree view aggregates by path already.
  get flat() {
    const d = this.assets.bundleData();
    if (!d) return [];
    const q = this.treeSearch().trim().toLowerCase();
    const byPath = new Map();
    for (const [path, bytes] of [...(d.js || []), ...(d.css || []), ...(d.xml || [])]) {
      byPath.set(path, (byPath.get(path) || 0) + bytes);
    }
    return [...byPath.entries()]
      .map(([path, bytes]) => ({ path, bytes }))
      .filter((f) => !q || f.path.toLowerCase().includes(q))
      .sort((a, b) => b.bytes - a.bytes);
  }

  // the analyzed bundle aggregated into a tree: top level is js/css/xml, then each
  // path segment, sizes summed up the tree; children sorted largest first
  get tree() {
    const d = this.assets.bundleData();
    if (!d) return [];
    const q = this.treeSearch().trim().toLowerCase();
    const top = [];
    for (const [label, files] of [
      ["js", d.js],
      ["css", d.css],
      ["xml", d.xml],
    ]) {
      const matched = (files || []).filter(([p]) => !q || p.toLowerCase().includes(q));
      if (!matched.length) continue;
      const root = { name: label, size: 0, children: {} };
      for (const [path, bytes] of matched) {
        root.size += bytes;
        let node = root;
        for (const part of path.split("/").filter(Boolean)) {
          node.children[part] = node.children[part] || { name: part, size: 0, children: {} };
          node = node.children[part];
          node.size += bytes;
        }
      }
      top.push(root);
    }
    const finalize = (n) => ({
      name: n.name,
      size: n.size,
      children: Object.values(n.children)
        .map(finalize)
        .sort((a, b) => b.size - a.size),
    });
    return top.map(finalize).sort((a, b) => b.size - a.size);
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
  rows() {
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

  // copy a bundle's /web/assets/… path to the clipboard, flipping its link to
  // "copied" for a moment
  copyUrl(b) {
    navigator.clipboard?.writeText(b.url);
    this.copiedId.set(b.id);
    setTimeout(() => {
      if (this.copiedId() === b.id) this.copiedId.set(null);
    }, 1400);
  }

  fmtSize(n) {
    return formatBytes(n || 0);
  }
}

// ─────────────────────────── Addons screen ───────────────────────────
