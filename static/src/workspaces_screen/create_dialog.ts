// The New workspace dialog: a source picker on top (a template, an Odoo version, a
// local or remote branch, a runbot bundle, a pull request) whose pick prefills the
// form below — the workspace's own settings, in two columns. Loading a source
// (fetching its branches, looking up its runbot dumps) is the caller's
// `loadSource`; this component owns the form: its values, the fields derived from
// one another, and validation. Resolves `done` with the form's values, or null
// when discarded.

import {
  Component,
  onMounted,
  onWillUnmount,
  signal,
  t,
  usePlugin,
  useProps,
  xml,
} from "@odoo/owl";
import type { Type } from "@odoo/owl";
import { baseBranchOf, defaultDemoData } from "../core/config.ts";
import type { TemplateConfig } from "../core/config.ts";
import { CodePlugin } from "../core/code_plugin.ts";
import { ConfigPlugin } from "../core/config_plugin.ts";
import { DatabasePlugin, dumpLabel } from "../core/database_plugin.ts";
import type { RunbotDump } from "../core/database_plugin.ts";
import { errorMessage, postJSON, repoBranchList } from "../core/utils.ts";

export type SourceKind = "template" | "version" | "bundle" | "local" | "remote" | "pr";

const SOURCES: { kind: SourceKind; label: string }[] = [
  { kind: "template", label: "Template" },
  { kind: "version", label: "Odoo version" },
  { kind: "local", label: "Local branch" },
  { kind: "remote", label: "Remote branch" },
  { kind: "bundle", label: "Runbot bundle" },
  { kind: "pr", label: "Pull request" },
];

// the values a source decides — what picking (or loading) one replaces.
// `verifiedRepos`: a source attaching existing branches (createBranches: false)
// only fetched a branch for those repos — anything ticked beyond has no confirmed
// branch to attach. `dumps`: the runbot databases "Restore runbot database" offers.
export interface SourceValues {
  template: string;
  name: string;
  repos: string[];
  config: string;
  db: string;
  addons: string[]; // the modules to install (-i) when goo creates the database
  args: string; // the other odoo-bin args for that first start
  category: string;
  demoData: boolean;
  createBranches: boolean; // fork new branches (template / version) vs. attach the source's
  verifiedRepos: string[] | null;
  dumps: RunbotDump[];
}

// everything the form submits. `db` is the database the workspace runs on: the new
// one's name when `newDb`, else the existing one picked (`existingDb`) — see ok()
export interface CreateForm extends SourceValues {
  location: string;
  newDb: boolean;
  existingDb: string;
  cloneDb: string; // "" = don't clone, else the database to clone from
  restoreDump: string; // "" = don't restore, else the dump URL
  activate: boolean; // set by the button that submitted the form
  createVenv: boolean;
}

// a branch picked in the combobox: the repos it was found in, and for the ones
// that only have it on a remote, the git remote to fetch it from
export interface BranchPick {
  branch: string;
  repos: string[];
  remoteByRepo: Record<string, string>;
}

export type SourceRequest =
  | { kind: "template"; id: string }
  | { kind: "version"; version: string }
  | { kind: "bundle"; url: string }
  | { kind: "local" | "remote"; pick: BranchPick }
  | { kind: "pr"; url: string };

// the Config string for a set of ticked repo ids. Forking fresh branches (the
// common "new task" case): every repo gets the same new branch name, so a
// full stomp from `branch` is correct even for repos already in `currentConfig`.
// Attaching existing branches (bundle / branch / pull request sources,
// `preserveExisting`): a repo's real, already-fetched branch must survive
// toggling an unrelated repo's checkbox or editing the name — only a repo with
// no config entry yet (the user manually ticking one beyond what was fetched)
// gets `branch` stamped as a best-effort guess.
export const configFromRepos = (
  repoIds: string[],
  branch: string,
  currentConfig = "",
  preserveExisting = false,
): string => {
  const existing = preserveExisting
    ? Object.fromEntries(repoBranchList.parse(currentConfig).map((c) => [c.repo, c.branch]))
    : ({} as Record<string, string>); // an empty repo -> branch map
  return repoBranchList.format(repoIds.map((repo) => ({ repo, branch: existing[repo] ?? branch })));
};

// Split a workspace's start args ("-i sale,crm --dev xml") into the modules they
// install and the rest — the form edits the two apart (Addons / Start args).
export function splitStartArgs(args: string): { addons: string[]; extra: string } {
  const addons: string[] = [];
  const extra: string[] = [];
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const list =
      tok === "-i" || tok === "--init"
        ? tokens[++i]
        : tok.startsWith("--init=")
          ? tok.slice("--init=".length)
          : null;
    if (list === null) extra.push(tok);
    else
      for (const name of (list || "").split(","))
        if (name && !addons.includes(name)) addons.push(name);
  }
  return { addons, extra: extra.join(" ") };
}

// the start args the form's addons + extra args make — what the workspace stores
export function startArgs(addons: string[], extra: string): string {
  return [addons.length ? `-i ${addons.join(",")}` : "", extra.trim()].filter(Boolean).join(" ");
}

// one module the Addons combobox offers (/api/addons)
interface AddonOption {
  name: string;
  repo: string;
  summary: string;
  application: boolean;
}

// A multi-select combobox of modules: the picked ones as removable chips, then a
// search box listing the matching modules (apps first). Arrow keys move through
// the results, Enter or a click adds one — or, with no match, the typed name as
// is; Backspace in an empty box removes the last chip.
export class AddonsCombobox extends Component {
  static template = xml`
    <div class="branch-cb addons-cb">
      <div class="addons-cb-box" t-on-click="() => this.inputEl()?.focus()">
        <span t-foreach="this.props.value" t-as="name" t-key="name" class="addons-cb-chip">
          <t t-out="name"/>
          <button type="button" class="addons-cb-remove" t-att-title="'remove ' + name"
                  t-on-click.stop="() => this.remove(name)">×</button>
        </span>
        <input type="text" class="addons-cb-input" t-ref="this.inputEl"
               t-att-placeholder="this.props.value.length ? '' : 'type to search the modules…'"
               t-att-value="this.query()"
               t-on-input="(ev) => this.onInput(ev.target.value)"
               t-on-keydown="(ev) => this.onKey(ev)"
               t-on-focus="() => this.open.set(true)"
               t-on-blur="() => this.open.set(false)"/>
      </div>
      <div t-if="this.open() and this.query().trim()" class="rbd-results branch-cb-list" t-ref="this.listEl">
        <div t-if="!this.rows.length" class="rbd-status">No matching module — Enter adds it as typed.</div>
        <div t-foreach="this.rows" t-as="m" t-key="m.name"
             class="rbd-row" t-att-class="{selected: m_index === this.active()}"
             t-on-mousedown.prevent="() => this.add(m.name)">
          <span class="rbd-branch" t-out="m.name"/>
          <span class="rbd-repos">
            <span t-if="m.application" class="rbd-repo-tag local">app</span>
            <span class="addons-cb-summary" t-out="m.summary"/>
          </span>
        </div>
      </div>
    </div>`;

  props = useProps({
    value: t.any() as Type<string[]>, // the picked module names — not validated at runtime
    options: t.any() as Type<AddonOption[]>,
    onChange: t.function<[string[]], void>(),
  });

  query = signal("");
  open = signal(false);
  active = signal(0);
  inputEl = signal.ref(HTMLElement);
  listEl = signal.ref(HTMLElement);

  // the modules matching the query, not picked yet — apps first, then by name
  get rows(): AddonOption[] {
    const q = this.query().trim().toLowerCase();
    if (!q) return [];
    const picked = new Set(this.props.value);
    return this.props.options
      .filter(
        (m) => !picked.has(m.name) && (m.name.includes(q) || m.summary.toLowerCase().includes(q)),
      )
      .sort(
        (a, b) =>
          Number(b.name.startsWith(q)) - Number(a.name.startsWith(q)) ||
          Number(b.application) - Number(a.application) ||
          a.name.localeCompare(b.name),
      )
      .slice(0, 50);
  }

  onInput(val: string): void {
    this.query.set(val);
    this.open.set(true);
    this.active.set(0);
  }

  // highlight row `i`, scrolling the list to keep it visible
  highlight(i: number): void {
    this.active.set(i);
    this.listEl()?.querySelectorAll(".rbd-row")[i]?.scrollIntoView({ block: "nearest" });
  }

  onKey(ev: KeyboardEvent): void {
    const n = this.rows.length;
    if (ev.key === "ArrowDown" && n) {
      ev.preventDefault();
      this.highlight((this.active() + 1) % n);
    } else if (ev.key === "ArrowUp" && n) {
      ev.preventDefault();
      this.highlight((this.active() - 1 + n) % n);
    } else if (ev.key === "Enter") {
      ev.stopPropagation(); // picks a module, never submits the form
      const name = this.rows[this.active()]?.name || this.query().trim();
      if (name) this.add(name);
    } else if (ev.key === "Backspace" && !this.query() && this.props.value.length) {
      this.remove(this.props.value[this.props.value.length - 1]);
    } else if (ev.key === "Escape" && this.open() && this.query().trim()) {
      ev.stopPropagation(); // close the list, not the dialog
      this.open.set(false);
    }
  }

  add(name: string): void {
    if (!this.props.value.includes(name)) this.props.onChange([...this.props.value, name]);
    this.query.set("");
    this.active.set(0);
  }

  remove(name: string): void {
    this.props.onChange(this.props.value.filter((n) => n !== name));
  }
}

// one repo a searched branch was found in: locally (attach as-is) or only on a
// remote (`remote` = the git remote to fetch it from)
interface BranchHitRepo {
  id: string;
  local: boolean;
  remote?: string;
}

interface BranchHit {
  branch: string;
  repos: BranchHitRepo[];
}

// /api/code/remote-branches/search's response
interface RemoteBranchSearch {
  ok: boolean;
  results: { repo: string; branch: string; remote: string }[];
}

// A branch search box with its results listed under it. "local" searches the
// branches already checked out somewhere (instant, from code.groups() — no
// network); "remote" searches GitHub (debounced, /api/code/remote-branches/search).
// Arrow keys move through the results, Enter or a click picks one (`onPick`).
export class BranchCombobox extends Component {
  static template = xml`
    <div class="branch-cb">
      <input type="text" class="branch-cb-input" t-ref="this.inputEl"
             t-att-placeholder="this.props.mode === 'local' ? 'type to search your local branches…' : 'type to search the branches on GitHub…'"
             t-att-value="this.query()"
             t-on-input="(ev) => this.onInput(ev.target.value)"
             t-on-keydown="(ev) => this.onKey(ev)"
             t-on-focus="() => this.open.set(true)"
             t-on-blur="() => this.open.set(false)"/>
      <div t-if="this.open() and this.query().trim()" class="rbd-results branch-cb-list" t-ref="this.listEl">
        <div t-if="this.searching()" class="rbd-status">Searching…</div>
        <div t-elif="!this.rows().length" class="rbd-status">No matching branches found.</div>
        <div t-foreach="this.rows()" t-as="r" t-key="r.branch"
             class="rbd-row" t-att-class="{selected: r_index === this.active()}"
             t-on-mousedown.prevent="() => this.pick(r)">
          <span class="rbd-branch" t-out="r.branch"/>
          <span class="rbd-repos">
            <t t-foreach="r.repos" t-as="rr" t-key="rr.id">
              <span class="rbd-repo-tag" t-att-class="rr.local ? 'local' : 'remote'" t-out="rr.id"/>
            </t>
          </span>
        </div>
      </div>
    </div>`;

  props = useProps({
    mode: t.any() as Type<"local" | "remote">, // not validated at runtime
    onPick: t.function<[BranchPick], void>(),
  });

  config = usePlugin(ConfigPlugin);
  code = usePlugin(CodePlugin);
  query = signal("");
  rows = signal<BranchHit[]>([]);
  searching = signal(false);
  open = signal(false);
  active = signal(0); // the highlighted row
  inputEl = signal.ref(HTMLElement);
  listEl = signal.ref(HTMLElement);
  _timer?: ReturnType<typeof setTimeout>;

  setup(): void {
    onMounted(() => this.inputEl()?.focus());
    onWillUnmount(() => clearTimeout(this._timer));
  }

  onInput(val: string): void {
    this.query.set(val);
    this.open.set(true);
    this.active.set(0);
    clearTimeout(this._timer);
    const query = val.trim();
    if (!query) {
      this.rows.set([]);
      this.searching.set(false);
    } else if (this.props.mode === "local") {
      this._searchLocal(query);
    } else {
      this.searching.set(true);
      this._timer = setTimeout(() => this._searchRemote(query), 300);
    }
  }

  // the branches in the same {branch, rows: [{repo, ...}]} groups the Branches
  // screen already holds in memory
  _searchLocal(query: string): void {
    const rows: BranchHit[] = [];
    for (const g of this.code.groups().list) {
      if (!g.branch.includes(query)) continue;
      const repos = g.rows.map((r) => ({ id: r.repo, local: true }));
      if (repos.length) rows.push({ branch: g.branch, repos });
    }
    this.rows.set(rows);
  }

  // each hit carries the git remote to fetch it from (the upstream `pull_remote`,
  // or a fork's `push_remote` — see GitHubService.search_branches), so the caller
  // never guesses the wrong one
  async _searchRemote(query: string): Promise<void> {
    const repos = this.config.config.repos
      .filter((r) => r.github)
      .map((r) => ({
        id: r.id,
        github: r.github,
        path: r.path,
        push_remote: r.push_remote,
        pull_remote: r.pull_remote,
      }));
    try {
      const res = await fetch("/api/code/remote-branches/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repos, query }),
      });
      const data: RemoteBranchSearch = await res.json();
      if (query !== this.query().trim() || !data.ok) return; // input moved on — drop it
      const byBranch = new Map<string, BranchHitRepo[]>();
      for (const { repo, branch, remote } of data.results) {
        if (!byBranch.has(branch)) byBranch.set(branch, []);
        byBranch.get(branch)!.push({ id: repo, local: false, remote }); // set just above
      }
      this.rows.set([...byBranch].map(([branch, repos]) => ({ branch, repos })));
    } finally {
      if (query === this.query().trim()) this.searching.set(false);
    }
  }

  onKey(ev: KeyboardEvent): void {
    const n = this.rows().length;
    if (ev.key === "ArrowDown" && n) {
      ev.preventDefault();
      this.open.set(true);
      this.highlight((this.active() + 1) % n);
    } else if (ev.key === "ArrowUp" && n) {
      ev.preventDefault();
      this.highlight((this.active() - 1 + n) % n);
    } else if (ev.key === "Enter") {
      const row = this.open() ? this.rows()[this.active()] : undefined;
      if (row) this.pick(row);
    } else if (ev.key === "Escape" && this.open() && this.query().trim()) {
      ev.stopPropagation(); // close the list, not the dialog
      this.open.set(false);
    }
  }

  // highlight row `i`, scrolling the list to keep it visible (the rows are already
  // rendered — only their highlight changes)
  highlight(i: number): void {
    this.active.set(i);
    this.listEl()?.querySelectorAll(".rbd-row")[i]?.scrollIntoView({ block: "nearest" });
  }

  pick(row: BranchHit): void {
    this.query.set(row.branch);
    this.open.set(false);
    this.props.onPick({
      branch: row.branch,
      repos: row.repos.map((r) => r.id),
      // a local repo needs no fetch — it's already there
      remoteByRepo: Object.fromEntries(
        row.repos.filter((r) => !r.local && r.remote).map((r) => [r.id, r.remote!]), // filtered
      ),
    });
  }
}

// the "Load" step of a URL source: the trimmed URL that was loaded, per source
interface Loaded {
  kind: SourceKind;
  key: string;
}

export class CreateWorkspaceDialog extends Component {
  static components = { BranchCombobox, AddonsCombobox };
  static template = xml`
    <div class="dialog-backdrop cwd-backdrop" t-on-click="() => this.done(null)">
      <div class="dialog cwd" t-on-click.stop="() => {}">
        <h2 class="dialog-title">New workspace</h2>
        <div class="dialog-body" data-form-type="other">
          <t t-if="this.props.pickSource">
            <div class="cwd-sources" role="radiogroup">
              <label t-foreach="this.sources" t-as="s" t-key="s.kind" class="cwd-source"
                     t-att-class="{selected: this.source() === s.kind}">
                <input type="radio" name="cwd-source" t-att-value="s.kind"
                       t-att-checked="this.source() === s.kind" t-on-change="() => this.pickSource(s.kind)"/>
                <t t-out="s.label"/>
              </label>
            </div>
            <div class="dialog-field cwd-source-input">
              <t t-if="this.source() === 'template'">
                <label>Template</label>
                <select t-on-change="(ev) => this.pickTemplate(ev.target.value)">
                  <option value="" t-att-selected="!this.templateId()">— start blank —</option>
                  <option t-foreach="this.templates" t-as="tpl" t-key="tpl.id" t-att-value="tpl.id"
                          t-att-selected="this.templateId() === tpl.id" t-out="tpl.name"/>
                </select>
              </t>
              <t t-elif="this.source() === 'version'">
                <label>Odoo version</label>
                <select t-if="this.versions().length" t-on-change="(ev) => this.pickVersion(ev.target.value)">
                  <option t-foreach="this.versions()" t-as="v" t-key="v" t-att-value="v"
                          t-att-selected="this.version() === v" t-out="v"/>
                </select>
                <div t-if="this.versionsError()" class="form-error" t-out="this.versionsError()"/>
              </t>
              <t t-elif="this.source() === 'bundle' or this.source() === 'pr'">
                <label t-out="this.source() === 'bundle' ? 'Bundle URL' : 'Pull request URL'"/>
                <div class="cwd-url-row">
                  <input type="text" t-att-value="this.url()"
                         t-att-placeholder="this.source() === 'bundle' ? 'https://runbot.odoo.com/runbot/bundle/…' : 'https://github.com/odoo/odoo/pull/…'"
                         t-on-input="(ev) => this.url.set(ev.target.value)"
                         t-on-keydown="(ev) => ev.key === 'Enter' &amp;&amp; this.loadUrl()"/>
                  <button class="pbtn" t-att-disabled="!this.url().trim() or this.loading()"
                          t-on-click="() => this.loadUrl()">Load</button>
                </div>
                <div t-if="this.source() === 'bundle'" class="dialog-field-hint">paste the bundle's address from your browser, e.g. …/runbot/bundle/master-fix-x-525170 — goo fetches its branches locally. An address with only the id (…/bundle/525170) can't be read: copy it after runbot has redirected it to the name form.</div>
                <div t-else="" class="dialog-field-hint">a GitHub (or mergebot) pull request — goo fetches its head branch locally</div>
              </t>
              <t t-else="">
                <label>Branch</label>
                <BranchCombobox t-key="this.source()" mode="this.source()" onPick="(p) => this.pickBranch(p)"/>
              </t>
              <div t-if="this.loading()" class="dialog-field-hint cwd-loading">Loading…</div>
            </div>
          </t>
          <div class="dialog-field">
            <label>Repositories</label>
            <div class="cwd-repos">
              <label t-foreach="this.repoRows" t-as="r" t-key="r.id" class="edit-check cwd-repo">
                <input type="checkbox" t-att-checked="r.branch !== null" t-on-change="(ev) => this.toggleRepo(r.id, ev.target.checked)"/>
                <span class="cwd-repo-id" t-out="r.id"/>
                <t t-if="r.branch">
                  <span class="cwd-repo-branch" t-out="r.branch"/>
                  <span class="cwd-repo-action" t-att-class="{attach: r.attach}" t-out="r.attach ? 'attach existing' : 'fork from ' + r.base"/>
                </t>
              </label>
            </div>
          </div>
          <div class="cwd-grid">
            <div class="cwd-col">
              <div class="dialog-field">
                <label>Name</label>
                <input type="text" t-ref="this.nameEl" t-att-value="this.form().name" placeholder="name (e.g. master-mytask)"
                       t-on-input="(ev) => this.setName(ev.target.value)" t-on-keydown="(ev) => this.onKey(ev)"/>
              </div>
              <div t-if="this.props.categories" class="dialog-field">
                <label>Category</label>
                <select t-on-change="(ev) => this.set({category: ev.target.value})">
                  <option value="">— none —</option>
                  <option t-foreach="this.props.categories" t-as="c" t-key="c.value" t-att-value="c.value"
                          t-att-selected="this.form().category === c.value" t-out="c.label"/>
                </select>
              </div>
            </div>
            <div class="cwd-col">
              <div class="dialog-field">
                <label>Location</label>
                <select t-on-change="(ev) => this.set({location: ev.target.value})">
                  <option value="main" t-att-selected="this.form().location === 'main'">Main checkout (one loaded at a time)</option>
                  <option value="worktree" t-att-selected="this.form().location === 'worktree'" t-out="this.worktreeLabel"/>
                </select>
              </div>
              <div t-if="this.launchMode === 'local' and this.form().location === 'worktree'" class="dialog-field">
                <label class="edit-check">
                  <input type="checkbox" t-att-checked="this.form().createVenv" t-on-change="(ev) => this.set({createVenv: ev.target.checked})"/>
                  Create a venv from requirements.txt
                </label>
              </div>
            </div>
          </div>
          <div class="cwd-grid cwd-sections">
            <div class="cwd-col">
              <t t-if="this.launchMode !== 'external'">
                <div class="cwd-section-title">First start</div>
                <div class="dialog-field">
                  <label>Addons</label>
                  <AddonsCombobox value="this.form().addons" options="this.addonOptions()" onChange="(names) => this.set({addons: names})"/>
                </div>
                <div class="dialog-field">
                  <label>Start args</label>
                  <input type="text" t-att-value="this.form().args" placeholder="--dev xml"
                         t-on-input="(ev) => this.set({args: ev.target.value})" t-on-keydown="(ev) => this.onKey(ev)"/>
                </div>
                <div class="dialog-field">
                  <code class="cwd-command" t-out="this.commandArgs"/>
                  <div t-if="!this.creatingDb" class="dialog-field-hint">an existing database: the addons and start args only apply to one goo creates</div>
                </div>
              </t>
            </div>
            <div class="cwd-col">
              <div class="cwd-section-title">Database</div>
              <div t-if="this.dbNames.length" class="dialog-field">
                <label class="edit-check">
                  <input type="checkbox" t-att-checked="this.form().newDb" t-on-change="(ev) => this.set({newDb: ev.target.checked})"/>
                  Create new database
                </label>
              </div>
              <div t-if="!this.creatingDb" class="dialog-field">
                <label>Database</label>
                <select t-on-change="(ev) => this.set({existingDb: ev.target.value})">
                  <option t-foreach="this.dbNames" t-as="name" t-key="name" t-att-value="name"
                          t-att-selected="this.form().existingDb === name" t-out="name"/>
                </select>
              </div>
              <t t-if="this.creatingDb">
                <div class="dialog-field">
                  <label>Database name</label>
                  <input type="text" t-att-value="this.form().db" placeholder="database name"
                         t-on-input="(ev) => this.set({db: ev.target.value})" t-on-keydown="(ev) => this.onKey(ev)"/>
                </div>
                <div t-if="this.dbNames.length" class="dialog-field">
                  <div class="dialog-check-select">
                    <label class="edit-check">
                      <input type="checkbox" t-att-checked="!!this.form().cloneDb" t-on-change="(ev) => this.set({cloneDb: ev.target.checked ? this.cloneDefault : ''})"/>
                      Clone database
                    </label>
                    <select t-if="this.form().cloneDb" t-on-change="(ev) => this.set({cloneDb: ev.target.value})">
                      <option t-foreach="this.dbNames" t-as="name" t-key="name" t-att-value="name"
                              t-att-selected="this.form().cloneDb === name" t-out="name"/>
                    </select>
                  </div>
                </div>
                <div t-if="this.form().dumps.length" class="dialog-field">
                  <div class="dialog-check-select">
                    <label class="edit-check">
                      <input type="checkbox" t-att-checked="!!this.form().restoreDump" t-on-change="(ev) => this.set({restoreDump: ev.target.checked ? this.dumpDefault : ''})"/>
                      Restore runbot database
                    </label>
                    <select t-if="this.form().restoreDump" t-on-change="(ev) => this.set({restoreDump: ev.target.value})">
                      <option t-foreach="this.form().dumps" t-as="d" t-key="d.url" t-att-value="d.url"
                              t-att-selected="this.form().restoreDump === d.url" t-out="this.dumpLabel(d)"/>
                    </select>
                  </div>
                  <div t-if="this.form().restoreDump" class="dialog-field-hint">downloaded from runbot and restored after the workspace is created — this can take a while</div>
                </div>
                <div t-if="this.launchMode !== 'external'" class="dialog-field">
                  <label class="edit-check">
                    <input type="checkbox" t-att-checked="this.form().demoData" t-on-change="(ev) => this.set({demoData: ev.target.checked})"/>
                    Demo data
                  </label>
                </div>
              </t>
            </div>
          </div>
        </div>
        <div class="dialog-foot">
          <span t-if="this.touched() and this.error" class="form-error" t-out="this.error"/>
          <button t-if="this.canActivate" class="pbtn primary" t-att-disabled="!!this.error or this.loading()" t-on-click="() => this.ok(true)">Create and activate</button>
          <button class="pbtn" t-att-class="{primary: !this.canActivate}" t-att-disabled="!!this.error or this.loading()" t-on-click="() => this.ok()">Create</button>
          <button class="pbtn" t-on-click="() => this.done(null)">Discard</button>
        </div>
      </div>
    </div>`;

  props = useProps({
    done: t.function<[CreateForm | null], void>(),
    initial: t.any() as Type<CreateForm>, // not validated at runtime
    blank: t.any() as Type<SourceValues>, // the values with no source: what a URL/branch source starts from
    pickSource: t.boolean(),
    loadSource: t.function<[SourceRequest], Promise<SourceValues | null>>(),
    categories: t.any() as Type<{ value: string; label: string }[] | null>, // null: categories off
  });

  config = usePlugin(ConfigPlugin);
  code = usePlugin(CodePlugin);
  db = usePlugin(DatabasePlugin);
  sources = SOURCES;
  dumpLabel = dumpLabel;

  form = signal<CreateForm>({} as CreateForm); // set from props.initial in setup()
  source = signal<SourceKind>("template");
  templateId = signal("");
  url = signal(""); // the bundle / pull request URL being typed
  versions = signal<string[]>([]); // runbot's starred series, newest first (read once)
  version = signal("");
  versionsError = signal("");
  loaded = signal<Loaded | null>({ kind: "template", key: "" });
  loading = signal(false);
  touched = signal(false); // has the user edited the form? (gates the inline error)
  nameEl = signal.ref(HTMLElement);
  addonOptions = signal<AddonOption[]>([]); // every module of the configured repos
  _seq = 0; // only the latest source load may land its values

  setup(): void {
    this.form.set({ ...this.props.initial, existingDb: this.existingDefault });
    this.templateId.set(this.props.initial.template);
    this._loadAddons();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.done(null);
    };
    document.addEventListener("keydown", onKey);
    onWillUnmount(() => document.removeEventListener("keydown", onKey));
    onMounted(() => {
      const el = this.nameEl();
      if (el instanceof HTMLInputElement) {
        el.focus();
        el.select();
      }
    });
  }

  // the modules the Addons combobox offers — every repo's, read once (no database
  // needed); a failure just leaves the free-typed names
  async _loadAddons(): Promise<void> {
    const repos = (this.config.config.repos || [])
      .filter((r) => r.path)
      .map((r) => ({ id: r.id, path: r.path }));
    try {
      const res = await postJSON<{ modules?: AddonOption[] }>("/api/addons", { repos });
      this.addonOptions.set(res.modules || []);
    } catch {
      /* no list to search: names can still be typed */
    }
  }

  get templates(): TemplateConfig[] {
    return this.config.config.templates || [];
  }

  get repoIds(): string[] {
    return (this.config.config.repos || []).map((r) => r.id);
  }

  get launchMode(): string {
    return this.config.config.launch_mode;
  }

  get dbNames(): string[] {
    return this.db.databases().map((d) => d.name);
  }

  // "+ port" only promises something goo actually manages — a "local" launch is the
  // only mode where goo allocates a TCP port itself; "docker" routes by container
  // name (no port), "external" owns its own port goo has no say in (see
  // workspace_plugin.ts's port()/_baseUrl)
  get worktreeLabel(): string {
    return this.launchMode === "local"
      ? "Own worktree + port (runs concurrently)"
      : "Own worktree (runs concurrently)";
  }

  hasLocalBranch(repo: string, branch: string): boolean {
    return (
      this.code
        .branchRepos()
        .find((r) => r.id === repo)
        ?.branches.some((b) => b.name === branch) ?? false
    );
  }

  // one row per configured repo: its branch in the config (null: not ticked; ""
  // while there's no name yet) and the "will attach / will fork" preview, live off
  // real local git state — the same ground truth the create step computes its
  // fork set from. A fork starts from the base branch on the repo's pull remote
  // ("prod/master"), fetched fresh at creation.
  get repoRows(): { id: string; branch: string | null; attach: boolean; base: string }[] {
    const v = this.form();
    const remoteByRepo = Object.fromEntries(
      (this.config.config.repos || []).map((r) => [r.id, r.pull_remote || "origin"]),
    );
    const branchByRepo = Object.fromEntries(
      repoBranchList.parse(v.config.trim()).map((c) => [c.repo, c.branch]),
    );
    return this.repoIds.map((id) => {
      const branch = v.repos.includes(id) ? (branchByRepo[id] ?? "") : null;
      return {
        id,
        branch,
        attach: !!branch && this.hasLocalBranch(id, branch),
        base: branch ? `${remoteByRepo[id]}/${baseBranchOf(branch)}` : "",
      };
    });
  }

  // ticking Clone database (or picking an existing one) seeds the template's
  // database when it exists, else the first one
  get cloneDefault(): string {
    const tpl = this.templates.find((x) => x.id === this.form().template);
    if (tpl?.db && this.dbNames.includes(tpl.db)) return tpl.db;
    return this.dbNames[0] || "";
  }

  // the existing database preselected: the one named like the workspace's, else
  // the template's, else the first
  get existingDefault(): string {
    const db = (this.form().db ?? this.props.initial.db).trim();
    return this.dbNames.includes(db) ? db : this.cloneDefault;
  }

  // whether the workspace gets a new database: "Create new database" — always
  // when there's no existing one to pick (the checkbox isn't even shown then)
  get creatingDb(): boolean {
    return this.form().newDb || !this.dbNames.length;
  }

  // the odoo-bin parameters the workspace's first start gets (the database, the
  // addons to install, demo data, the extra args) — what the backend appends
  get commandArgs(): string {
    const v = this.form();
    const db = (this.creatingDb ? v.db : v.existingDb).trim() || "<database>";
    return [
      `-d ${db}`,
      startArgs(v.addons, ""),
      `--without-demo ${v.demoData ? "false" : "all"}`,
      v.args.trim(),
    ]
      .filter(Boolean)
      .join(" ");
  }

  // default to the dump matching the checkout: an enterprise workspace wants the
  // Enterprise run's db (community modules are in it too), a community-only one
  // can't even load an enterprise dump. Within a build, "all" over "base" — "base"
  // is a bare install, which is what an empty local db would give you anyway.
  get dumpDefault(): string {
    const { dumps, repos } = this.form();
    const wantsEnterprise = repos.includes("enterprise");
    const best =
      dumps.find((d) => d.db === "all" && /enterprise/i.test(d.slot) === wantsEnterprise) ||
      dumps.find((d) => d.db === "all");
    return best?.url || dumps[0]?.url || "";
  }

  // the source still waiting for its URL / branch to be loaded
  get pendingSource(): string {
    const loaded = this.loaded();
    const source = this.source();
    if (source === "template") return "";
    if (source === "bundle" || source === "pr") {
      if (loaded?.kind === source && loaded.key === this.url().trim()) return "";
      return source === "bundle" ? "load the runbot bundle first" : "load the pull request first";
    }
    if (source === "version") return loaded?.kind === source ? "" : "pick an Odoo version first";
    return loaded?.kind === source ? "" : "pick a branch first";
  }

  // the form's validation error ("" when valid) — disables Create, and shows once
  // the user has edited the form
  get error(): string {
    const pending = this.pendingSource;
    if (pending) return pending;
    const v = this.form();
    const name = v.name.trim();
    const db = v.db.trim();
    if (!name) return "a name is required";
    if ((this.config.config.workspaces || []).some((w) => w.name === name))
      return `a workspace named "${name}" already exists`;
    if (!repoBranchList.parse(v.config.trim()).length) return "tick at least one repository";
    if (!this.creatingDb) return "";
    if (!db) return "set the new database's name";
    if (this.dbNames.includes(db))
      return `database "${db}" already exists — untick "Create new database" to use it`;
    // both would write the same database
    if (v.restoreDump && v.cloneDb) return "clone a database or restore the runbot dump — not both";
    return "";
  }

  set(updates: Partial<CreateForm>): void {
    this.form.set({ ...this.form(), ...updates });
    this.touched.set(true);
  }

  setName(newName: string): void {
    const v = this.form();
    const trimmed = newName.trim();
    const forkingFresh = v.createBranches;
    const updates: Partial<CreateForm> = {
      name: newName,
      config: configFromRepos(v.repos, trimmed, v.config, !forkingFresh),
    };
    // only stomp demoData while forking a fresh branch (same gating as config
    // above) and with no template — attaching to an existing branch shouldn't
    // silently flip a checkbox the user didn't touch, and a template's own
    // demo-data setting wins over the branch-based guess
    if (forkingFresh && !v.template) updates.demoData = defaultDemoData(trimmed);
    // db stays in lockstep with name as it's typed (a blank db otherwise sails
    // through Create silently, then fails Start with "no database configured") —
    // full stomp while db is still empty or still exactly tracking the previous
    // name; once the user diverges db by hand, later name edits only best-effort
    // replace the old name within it (and only when there IS an old name —
    // replaceAll("", …) would splice the new name between every character)
    if (!v.db || v.db === v.name) updates.db = trimmed;
    else if (v.name) updates.db = v.db.replaceAll(v.name, newName);
    this.set(updates);
  }

  toggleRepo(id: string, checked: boolean): void {
    const v = this.form();
    const repos = checked ? [...v.repos, id] : v.repos.filter((r) => r !== id);
    const config = configFromRepos(repos, v.name.trim(), v.config, !v.createBranches);
    this.set({ repos, config });
  }

  // switching source empties the form for a URL / branch source (it fills in once
  // loaded), and reloads the selected template for "Template"
  pickSource(kind: SourceKind): void {
    this.source.set(kind);
    this.url.set("");
    this._seq++; // a load still running for the previous source is dropped
    this.loading.set(false);
    if (kind === "template") {
      this.load({ kind: "template", id: this.templateId() });
      return;
    }
    this.loaded.set(null);
    this.form.set({ ...this.form(), ...this.props.blank, restoreDump: "" });
    if (kind === "version") this._loadVersions();
  }

  // runbot's starred versions (its R&D page), read on first pick; the selected
  // one (else the newest) loads at once, like a template
  async _loadVersions(): Promise<void> {
    if (!this.versions().length) {
      const seq = this._seq;
      this.loading.set(true);
      try {
        const res = await postJSON<{ versions?: string[] }>("/api/runbot/sticky");
        if (!res.versions?.length) throw new Error("runbot is unreachable");
        this.versions.set(res.versions);
      } catch (e) {
        this.versionsError.set(`could not load runbot's versions: ${errorMessage(e)}`);
      } finally {
        if (seq === this._seq) this.loading.set(false);
      }
      if (seq !== this._seq) return; // switched to another source meanwhile
    }
    const version = this.version() || this.versions()[0];
    if (version) this.pickVersion(version);
  }

  pickVersion(version: string): void {
    this.version.set(version);
    this.load({ kind: "version", version });
  }

  pickTemplate(id: string): void {
    this.templateId.set(id);
    this.load({ kind: "template", id });
  }

  pickBranch(pick: BranchPick): void {
    const kind = this.source();
    if (kind === "local" || kind === "remote") this.load({ kind, pick });
  }

  loadUrl(): void {
    const url = this.url().trim();
    if (!url || this.loading()) return;
    const kind = this.source();
    if (kind === "bundle" || kind === "pr") this.load({ kind, url });
  }

  async load(req: SourceRequest): Promise<void> {
    const seq = ++this._seq;
    this.loading.set(true);
    try {
      const values = await this.props.loadSource(req);
      if (seq !== this._seq || !values) return;
      this.form.set({ ...this.form(), ...values, restoreDump: "" });
      const key = req.kind === "bundle" || req.kind === "pr" ? req.url : "";
      this.loaded.set({ kind: req.kind, key });
    } finally {
      if (seq === this._seq) this.loading.set(false);
    }
  }

  // a main-checkout workspace can be activated right away ("Create and activate",
  // the primary action); a worktree runs concurrently, with nothing to activate
  get canActivate(): boolean {
    return this.form().location !== "worktree";
  }

  // Enter does what the primary button does
  onKey(ev: KeyboardEvent): void {
    if (ev.key === "Enter") this.ok(this.canActivate);
  }

  done(result: CreateForm | null): void {
    this.props.done(result);
  }

  // `activate`: "Create and activate" — also load a main-located workspace (a
  // worktree runs concurrently from its own checkout, no activation step)
  ok(activate = false): void {
    if (this.loading()) return;
    // Enter can still reach here while invalid (the button is disabled, not the
    // keystroke) — guard, and reveal the message if it was hidden
    if (this.error) return this.touched.set(true);
    const v = this.form();
    this.done({
      ...v,
      activate: activate && this.canActivate,
      // an existing database is used as is: nothing to clone or restore into it
      newDb: this.creatingDb,
      ...(this.creatingDb ? {} : { db: v.existingDb, cloneDb: "", restoreDump: "" }),
    });
  }
}
