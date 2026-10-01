// The bundle-analysis view: one bundle's per-file minified-size breakdown, as an
// aggregated tree (path segments, sizes summed) or a flat largest-first list, with
// a search filter. Extracted from the retired standalone Assets screen; rendered
// by the Workspaces screen's Assets pane when a bundle is clicked. State lives on
// the (db-scoped) AssetsPlugin — this is just the view.

import { Component, usePlugin, useProps, signal, t, xml } from "@odoo/owl";
import type { StaticComponentProperties, Type } from "@odoo/owl";
import { AssetsPlugin } from "./assets_plugin.ts";
import type { BundleFile } from "./assets_plugin.ts";
import { SearchBox } from "../core/common.ts";
import { formatBytes } from "../core/utils.ts";

// a finalized tree node: a path segment (or the js/css/xml top level) + its summed size
export interface TreeNode {
  name: string;
  size: number;
  children: TreeNode[];
}

// a tree node while it's being built: children keyed by path segment
interface BuildNode {
  name: string;
  size: number;
  children: Record<string, BuildNode>;
}

// one row of the flat view: a file path + its (merged) minified size
interface FlatFile {
  path: string;
  bytes: number;
}

// One node of the tree: a path segment (folder) or a leaf file, with its
// aggregated minified size. Recursive; top-level (depth 0) nodes open by default.
export class BundleNode extends Component {
  declare static components: StaticComponentProperties["components"]; // set below (recursive)
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

  // not validated at runtime
  props = useProps({ node: t.any() as Type<TreeNode>, depth: t.any() as Type<number> });
  open = signal(false);

  setup(): void {
    if (this.props.depth === 0) this.open.set(true);
  }

  toggle(): void {
    if (this.props.node.children.length) this.open.set(!this.open());
  }

  fmt(n: number): string {
    return formatBytes(n);
  }
}
BundleNode.components = { BundleNode };

// the bundle base name an attachment belongs to, e.g. "web.assets_web.min.js" or
// "web.assets_web.css.map" -> "web.assets_web"
export function bundleBase(name: string): string {
  return name.replace(/\.map$/, "").replace(/(\.min)?\.(js|css|xml)$/, "");
}

export class AssetsAnalysis extends Component {
  static components = { BundleNode, SearchBox };
  static template = xml`
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
    </div>`;

  assets = usePlugin(AssetsPlugin);
  view = signal("tree"); // "tree" (aggregate) | "flat"
  treeSearch = signal(""); // filter files within the analysis

  // the analyzed attachment's name, e.g. "web.assets_web.min.js" — the .min asset
  // the breakdown was scoped to, so it reads as the row that was clicked
  get analysisTitle(): string {
    const d = this.assets.bundleData();
    if (!d) return "";
    return `${d.name}.min.${d.kind === "css" ? "css" : "js"}`;
  }

  // total minified size across the analyzed bundle's js + css + xml
  get analysisTotal(): string {
    const d = this.assets.bundleData();
    if (!d) return "";
    const all = [...(d.js || []), ...(d.css || []), ...(d.xml || [])];
    return `${formatBytes(all.reduce((s, [, n]) => s + n, 0))} minified`;
  }

  // the analyzed bundle's files as a flat list ({path, bytes}), search-filtered,
  // largest first. Same path can occur more than once (e.g. a template and its
  // registerTemplateExtension share their base template's name) — merge those into
  // one row (sizes summed), matching how the tree view aggregates by path already.
  get flat(): FlatFile[] {
    const d = this.assets.bundleData();
    if (!d) return [];
    const q = this.treeSearch().trim().toLowerCase();
    const byPath = new Map<string, number>();
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
  get tree(): TreeNode[] {
    const d = this.assets.bundleData();
    if (!d) return [];
    const q = this.treeSearch().trim().toLowerCase();
    const top: BuildNode[] = [];
    const groups: [string, BundleFile[]][] = [
      ["js", d.js],
      ["css", d.css],
      ["xml", d.xml],
    ];
    for (const [label, files] of groups) {
      const matched = (files || []).filter(([p]) => !q || p.toLowerCase().includes(q));
      if (!matched.length) continue;
      const root: BuildNode = { name: label, size: 0, children: {} };
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
    const finalize = (n: BuildNode): TreeNode => ({
      name: n.name,
      size: n.size,
      children: Object.values(n.children)
        .map(finalize)
        .sort((a, b) => b.size - a.size),
    });
    return top.map(finalize).sort((a, b) => b.size - a.size);
  }

  fmtSize(n: number): string {
    return formatBytes(n || 0);
  }
}
