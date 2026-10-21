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
  args: string;
  category: string;
  demoData: boolean;
  createBranches: boolean; // fork new branches (template / version) vs. attach the source's
  verifiedRepos: string[] | null;
  dumps: RunbotDump[];
}

// everything the form submits
export interface CreateForm extends SourceValues {
  location: string;
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
  static components = { BranchCombobox };
  static template = xml`
    <div class="dialog-backdrop" t-on-click="() => this.done(null)">
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
            <div class="cwd-col">
              <div class="dialog-field">
                <label>Database</label>
                <input type="text" t-att-value="this.form().db" placeholder="database name"
                       t-on-input="(ev) => this.set({db: ev.target.value})" t-on-keydown="(ev) => this.onKey(ev)"/>
              </div>
              <div class="dialog-field">
                <div class="dialog-check-select">
                  <label class="edit-check">
                    <input type="checkbox" t-att-checked="!!this.form().cloneDb" t-on-change="(ev) => this.set({cloneDb: ev.target.checked ? this.cloneDefault : ''})"/>
                    Clone db
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
              <div t-if="this.launchMode !== 'external'" class="dialog-field">
                <label>Start args</label>
                <input type="text" t-att-value="this.form().args" placeholder="-i sale_management"
                       t-on-input="(ev) => this.set({args: ev.target.value})" t-on-keydown="(ev) => this.onKey(ev)"/>
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
          </div>
        </div>
        <div class="dialog-foot">
          <span t-if="this.touched() and this.error" class="form-error" t-out="this.error"/>
          <button t-if="this.form().location !== 'worktree'" class="pbtn" t-att-disabled="!!this.error or this.loading()" t-on-click="() => this.ok(true)">Create and activate</button>
          <button class="pbtn primary" t-att-disabled="!!this.error or this.loading()" t-on-click="() => this.ok()">Create</button>
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
  _seq = 0; // only the latest source load may land its values

  setup(): void {
    this.form.set(this.props.initial);
    this.templateId.set(this.props.initial.template);
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

  // ticking Clone db seeds the template's database when it exists, else the first one
  get cloneDefault(): string {
    const tpl = this.templates.find((x) => x.id === this.form().template);
    if (tpl?.db && this.dbNames.includes(tpl.db)) return tpl.db;
    return this.dbNames[0] || "";
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
    const dbExists = this.dbNames.includes(db);
    if (!name) return "a name is required";
    if ((this.config.config.workspaces || []).some((w) => w.name === name))
      return `a workspace named "${name}" already exists`;
    if (!repoBranchList.parse(v.config.trim()).length) return "tick at least one repository";
    if (v.cloneDb && !db) return "set a database name to clone the selected database into";
    if (v.location === "worktree" && v.cloneDb && dbExists)
      return `database "${db}" already exists — pick a new name to clone into`;
    // both would write the same database, and the dump restore needs a fresh one
    // in every location (it replays a schema, it doesn't seed an empty shell)
    if (v.restoreDump && v.cloneDb) return "clone a database or restore the runbot dump — not both";
    if (v.restoreDump && !db) return "set a database name to restore the runbot dump into";
    if (v.restoreDump && dbExists)
      return `database "${db}" already exists — pick a new name to restore into`;
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

  onKey(ev: KeyboardEvent): void {
    if (ev.key === "Enter") this.ok();
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
    this.done({ ...this.form(), activate: activate && this.form().location !== "worktree" });
  }
}
