// The shared workspace dialogs and actions: the unified create form (template
// picker + location), create-from-remote-branch, adopt-current-checkout, and
// delete-with-cleanup. Used by the Workspaces screen. Every write goes to the
// canonical `workspaces` key (full records spread — the legacy `targets` view
// drops the stable ports).

import { BASE_BRANCH_RE } from "../core/config.js";
import { newWorkspaceId } from "../core/config_plugin.js";
import { RemoteBranchDialog } from "../core/dialogs.js";
import { postJSON, repoBranchList } from "../core/utils.js";

import { Component, onMounted, onWillUnmount, signal, t, useProps, xml } from "@odoo/owl";

// the canonical base branch a work branch's name derives from: 16.0-owl-fix →
// 16.0, saas-19.4-x → saas-19.4, anything else → master
const baseBranchOf = (branch) =>
  (/^(saas-\d+\.\d+|\d+\.\d+|master)/.exec(branch) || ["", "master"])[1];

// the reserved category: archived workspaces group here, always rendered as the
// LAST list group (even when categories are disabled). Not part of the
// configurable workspace_categories order.
export const ARCHIVED_CATEGORY = "archived";

// the Category select options for the create/edit dialogs (shown only when the
// workspace-categories setting is on; the empty placeholder = uncategorized).
// "archived" is always offered last, so an archived workspace's Edit dialog can
// show — and keep — its real category.
export function categoryOptions(config) {
  const opts = (config.config.workspace_categories || []).map((c) => ({
    value: c.id,
    label: c.id,
  }));
  if (!opts.some((o) => o.value === ARCHIVED_CATEGORY))
    opts.push({ value: ARCHIVED_CATEGORY, label: ARCHIVED_CATEGORY });
  return opts;
}

// the Config string for a set of ticked repo ids, all forking the same branch
// (the common case — a task branch of the same name across every repo it touches)
const configFromRepos = (repoIds, branch) =>
  repoBranchList.format(repoIds.map((repo) => ({ repo, branch })));

// The values a template prefills into the create form (also the payload its
// select's onChange used to produce, before the source moved to the wizard's
// first step): named after its enterprise/community branch, its checkouts as
// the config, plus db / args / demo data.
export function templatePrefill(tpl) {
  if (!tpl) return {};
  const branch =
    tpl.checkouts.find((c) => c.repo === "enterprise")?.branch ||
    tpl.checkouts.find((c) => c.repo === "community")?.branch ||
    "";
  return {
    template: tpl.id,
    name: branch,
    config: repoBranchList.format(tpl.checkouts),
    db: tpl.db || "",
    args: tpl.on_create_args || "",
    demoData: tpl.demo_data ?? true,
  };
}

// The wizard's FIRST step: pick the workspace's source — a template (or blank),
// or a runbot bundle URL (a colleague's branches + PRs). The bundle lookup runs
// here so its errors show in place; resolves to
// { source: "template", template } | { source: "bundle", info } | null.
export class WorkspaceSourceDialog extends Component {
  static template = xml`
    <div class="dialog-backdrop" t-on-click="() => this.done(null)">
      <div class="dialog ws-wiz" t-on-click.stop="() => {}">
        <h2 class="dialog-title">New workspace</h2>
        <div class="dialog-body">
          <label class="ws-wiz-option" t-att-class="{selected: this.source() === 'template'}">
            <input type="radio" name="ws-source" value="template" t-att-checked="this.source() === 'template'" t-on-change="() => this.source.set('template')"/>
            <span class="ws-wiz-opt-body">
              <span class="ws-wiz-opt-title">From a template</span>
              <span class="ws-wiz-opt-hint dim">fork fresh branches from one of your templates — or start blank</span>
              <select class="ws-wiz-select" t-att-disabled="this.source() !== 'template'"
                      t-on-change="(ev) => this.template.set(ev.target.value)">
                <option t-foreach="this.props.templates" t-as="tpl" t-key="tpl.id" t-att-value="tpl.id" t-att-selected="this.template() === tpl.id" t-out="tpl.name"/>
                <option value="" t-att-selected="!this.template()">— start blank —</option>
              </select>
            </span>
          </label>
          <label class="ws-wiz-option" t-att-class="{selected: this.source() === 'bundle'}">
            <input type="radio" name="ws-source" value="bundle" t-att-checked="this.source() === 'bundle'" t-on-change="() => this.source.set('bundle')"/>
            <span class="ws-wiz-opt-body">
              <span class="ws-wiz-opt-title">From a runbot bundle</span>
              <span class="ws-wiz-opt-hint dim">paste a bundle URL (e.g. a colleague's work) — goo fetches its branches locally</span>
              <input type="text" class="ws-wiz-url" placeholder="https://runbot.odoo.com/runbot/bundle/…"
                     t-att-value="this.url()" t-att-disabled="this.source() !== 'bundle'"
                     t-on-input="(ev) => this.url.set(ev.target.value)"
                     t-on-keydown="(ev) => ev.key === 'Enter' &amp;&amp; this.continue_()"/>
            </span>
          </label>
          <div t-if="this.error()" class="form-error" t-out="this.error()"/>
        </div>
        <div class="dialog-foot">
          <button class="pbtn primary" t-att-disabled="!this.canContinue" t-on-click="() => this.continue_()">
            <t t-if="this.busy()">Reading bundle…</t><t t-else="">Continue</t>
          </button>
          <button class="pbtn" t-on-click="() => this.done(null)">Cancel</button>
        </div>
      </div>
    </div>`;

  props = useProps({ done: t.function(), templates: t.any() });
  source = signal("template");
  template = signal("");
  url = signal("");
  busy = signal(false);
  error = signal("");

  setup() {
    this.template.set(this.props.templates[0]?.id ?? "");
    const onKey = (e) => {
      if (e.key === "Escape") this.done(null);
    };
    onMounted(() => document.addEventListener("keydown", onKey));
    onWillUnmount(() => document.removeEventListener("keydown", onKey));
  }

  done(result) {
    this.props.done(result);
  }

  get canContinue() {
    if (this.busy()) return false;
    return this.source() === "template" || !!this.url().trim();
  }

  async continue_() {
    if (!this.canContinue) return;
    if (this.source() === "template") {
      return this.done({ source: "template", template: this.template() });
    }
    this.busy.set(true);
    this.error.set("");
    try {
      const info = await postJSON("/api/runbot/bundle-info", { url: this.url().trim() });
      this.done({ source: "bundle", info });
    } catch (e) {
      this.error.set(e.message);
    } finally {
      this.busy.set(false);
    }
  }
}

// The wizard: step 1 picks the source, step 2 is the create form prefilled from
// it. A bundle source first fetches the bundle's branches into the local repos
// (from the remote that carries them — the canonical repo, or the shared dev
// fork for colleagues' work), so the form opens with everything in place and
// "Create branches" off.
export async function startNewWorkspaceWizard(plugins) {
  const { config, dialogs, code, eventLog } = plugins;
  const res = await dialogs.openComponent(WorkspaceSourceDialog, {
    templates: config.config.templates || [],
  });
  if (!res) return;
  if (res.source === "template") {
    const tpl = (config.config.templates || []).find((x) => x.id === res.template);
    return startCreateWorkspace(plugins, templatePrefill(tpl));
  }
  const info = res.info;
  // map the bundle's github repos onto the configured ones by repo name —
  // odoo-dev/odoo and odoo/odoo both mean the "odoo/odoo" config repo
  const matches = [];
  for (const { github, branch } of info.branches || []) {
    const repoName = github.split("/")[1];
    const r = (config.config.repos || []).find((x) => (x.github || "").split("/")[1] === repoName);
    if (!r || !r.path) continue;
    // canonical repo → its pull remote; anything else is the shared dev fork,
    // which is what the configured push remote points at
    const remote = github === r.github ? r.pull_remote || "origin" : r.push_remote || "dev";
    matches.push({ repo: r, branch, remote });
  }
  if (!matches.length) {
    dialogs.open({
      title: "Workspace from bundle",
      message: `none of the bundle's repositories (${(info.branches || []).map((b) => b.github).join(", ") || "none listed"}) match your configured repos`,
      okLabel: "OK",
      cancelLabel: null,
    });
    return;
  }
  // fetch every branch concurrently, each as a timed event-log row
  const results = await Promise.all(
    matches.map(async (m) => {
      const eid = eventLog.begin(`fetching ${m.branch} (${m.repo.id}) from ${m.remote}`);
      try {
        await postJSON("/api/code/remote-branch/fetch", {
          path: m.repo.path,
          branch: m.branch,
          pull_remote: m.remote,
        });
        eventLog.finish(eid, "done");
        return { ...m, ok: true };
      } catch (e) {
        eventLog.finish(eid, "error");
        return { ...m, ok: false, error: e.message };
      }
    }),
  );
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    dialogs.open({
      title: "Fetching bundle branches failed",
      message: failed.map((f) => `${f.repo.id}: ${f.error}`).join("\n"),
      cls: "dialog-error",
      okLabel: "OK",
      cancelLabel: null,
    });
    if (failed.length === results.length) return;
  }
  const got = results.filter((r) => r.ok);
  // the fetched branches must show up in the form's world (branch pickers, the
  // created workspace's presence checks) — refresh just those repos
  await code.refreshBranches(new Set(got.map((m) => m.repo.id)));
  return startCreateWorkspace(plugins, {
    name: info.name,
    config: repoBranchList.format(got.map((m) => ({ repo: m.repo.id, branch: m.branch }))),
    db: info.name,
    template: "",
    createBranches: false,
  });
}

// Create a workspace through the unified form — the wizard's SECOND step (the
// source — template or runbot bundle — was chosen in step one and arrives here
// as `prefill`; the form itself no longer has a template field).
// plugins: { config, dialogs, db, code, eventLog, wt }. `prefill`: { name,
// config, db, args, demoData, template, category, createBranches }.
export async function startCreateWorkspace(plugins, prefill = {}) {
  const { config, dialogs, db, code, eventLog, wt } = plugins;
  await db.load(); // populate the "Clone db" select
  const templates = config.config.templates || [];
  const tpl = templates.find((t) => t.id === prefill.template) || null;
  const existing = config.config.workspaces || [];
  const dbNames = new Set(db.databases().map((d) => d.name));
  const dbOptions = db.databases().map((d) => ({ value: d.name, label: d.name }));
  const repoOptions = (config.config.repos || []).map((r) => ({ value: r.id, label: r.id }));
  // ticked by default: whatever the prefilled config already covers, else every
  // non-external configured repo (a new task branch usually spans all of them;
  // external repos, e.g. odoo/owl, are outside the CI ecosystem and rarely need
  // a matching branch, so leave them for the user to opt into)
  const prefillRepoIds = prefill.config
    ? repoBranchList.parse(prefill.config).map((c) => c.repo)
    : (config.config.repos || []).filter((r) => !r.external).map((r) => r.id);
  const res = await dialogs.open({
    title: tpl ? `New workspace — from template "${tpl.name}"` : "New workspace",
    okLabel: "Create",
    validate: (v) => {
      const name = (v.name || "").trim();
      if (!name) return "a name is required";
      if (existing.some((w) => w.name === name))
        return `a workspace named "${name}" already exists`;
      if (!repoBranchList.parse((v.config || "").trim()).length) return "a config is required";
      if (v.location === "worktree" && !tpl)
        return "a worktree workspace needs a template — go back and pick one as the source";
      if ((v.cloneDb || "") && !(v.db || "").trim())
        return "set a database name to clone the selected database into";
      if (v.location === "worktree" && v.cloneDb && dbNames.has((v.db || "").trim()))
        return `database "${(v.db || "").trim()}" already exists — pick a new name to clone into`;
      return "";
    },
    fields: [
      {
        key: "location",
        type: "select",
        label: "Location",
        value: "main",
        options: [
          { value: "main", label: "Main checkout (one loaded at a time)" },
          { value: "worktree", label: "Own worktree + port (runs concurrently)" },
        ],
      },
      {
        key: "name",
        type: "text",
        label: "Name",
        value: prefill.name ?? "",
        placeholder: "name (e.g. master-mytask)",
        onChange: (newName, currentValues, oldValues) => {
          const updates = { config: configFromRepos(currentValues.repos || [], newName.trim()) };
          // only string-replace db when there was a previous name to replace —
          // replaceAll("", newName) on the very first keystroke would otherwise
          // splice newName between every character
          if (oldValues.name)
            updates.db = (currentValues.db || "").replaceAll(oldValues.name, newName);
          return updates;
        },
      },
      {
        key: "repos",
        type: "repo-checks",
        label: "Repositories",
        value: prefillRepoIds,
        options: repoOptions,
        onChange: (repoIds, currentValues) => ({
          config: configFromRepos(repoIds, (currentValues.name || "").trim()),
        }),
      },
      {
        key: "config",
        type: "text",
        label: "Config",
        value:
          prefill.config ??
          (prefill.name ? configFromRepos(prefillRepoIds, prefill.name.trim()) : ""),
        placeholder: "community:master,enterprise:master",
      },
      {
        key: "db",
        type: "text",
        label: "Database",
        value: prefill.db ?? "",
        placeholder: "database name",
      },
      {
        key: "args",
        type: "text",
        label: "Start args",
        value: prefill.args ?? "",
        placeholder: "-i sale_management",
      },
      ...(config.config.workspace_categories_enabled
        ? [
            {
              key: "category",
              type: "select",
              label: "Category",
              placeholder: "— none —",
              options: categoryOptions(config),
              value: prefill.category ?? "",
            },
          ]
        : []),
      {
        key: "cloneDb",
        type: "check-select",
        label: "Clone db",
        options: dbOptions,
        value: "",
        default: () => {
          if (tpl?.db && dbNames.has(tpl.db)) return tpl.db;
          return dbOptions[0]?.value || "";
        },
      },
      {
        key: "demoData",
        type: "checkbox",
        label: "Demo data",
        value: prefill.demoData ?? true,
      },
      {
        key: "createBranches",
        type: "checkbox",
        label: "Create branches (main)",
        value: prefill.createBranches ?? true,
      },
      { key: "activate", type: "checkbox", label: "Activate it (main)", value: true },
    ],
  });
  if (!res) return;
  const checkouts = repoBranchList.parse(res.config.trim());
  const startPointByRepo = Object.fromEntries(
    (tpl?.checkouts || []).map((c) => [c.repo, c.branch]),
  );
  // a repo the template doesn't cover (or no template at all) forks from the base
  // its branch name derives from — 16.0-owl-fix → 16.0. Both create paths resolve
  // the start point on the canonical remote (fresh fetch → fork from FETCH_HEAD),
  // so no up-to-date local base branch is needed.
  for (const c of checkouts)
    if (!startPointByRepo[c.repo]) startPointByRepo[c.repo] = baseBranchOf(c.branch);

  if (res.location === "worktree") {
    await wt.createWorktree({
      name: res.name.trim(),
      dbName: (res.db || "").trim(),
      cloneSource: res.cloneDb || "",
      checkouts,
      startPointByRepo,
      baseId: tpl?.id || "",
      on_create_args: (res.args || "").trim(),
      demo_data: !!res.demoData,
      favorite: false,
      category: res.category || "",
    });
    return;
  }

  // main-located: persist canonically (the workspaces key — spread the existing
  // array so stable ports survive), then branches / activation / db clone
  const now = new Date().toISOString();
  const ws = {
    id: newWorkspaceId(),
    name: res.name.trim(),
    created_at: now,
    last_activity: now,
    favorite: false,
    category: res.category || "",
    db: (res.db || "").trim(),
    on_create_args: (res.args || "").trim(),
    demo_data: !!res.demoData,
    location: "main",
    worktree: null,
    port: null,
    checkouts,
  };
  eventLog.add(`creating workspace ${ws.name}`);
  config.updateConfig({ workspaces: [...config.config.workspaces, ws] });
  if (res.createBranches) {
    const pathByRepo = Object.fromEntries(config.config.repos.map((r) => [r.id, r.path]));
    await code.createBranches(
      checkouts.map((c) => ({
        path: pathByRepo[c.repo],
        name: c.branch,
        startPoint: startPointByRepo[c.repo],
        freshStart: true,
      })),
    );
  }
  if (res.activate) await config.workspace(ws.id)?.activate();
  if (res.cloneDb && ws.db && res.cloneDb !== ws.db) {
    await db.cloneStoppingServer(res.cloneDb, ws.db);
  }
  wt.select(ws.id);
}

// Search for a remote branch across the repos, fetch it locally, then open the
// create dialog prefilled with it. "Create branches" defaults off — the fetch
// already created the local branches.
export async function createWorkspaceFromRemoteBranch(plugins) {
  const { code, dialogs } = plugins;
  const res = await dialogs.openComponent(RemoteBranchDialog);
  if (!res) return;
  const { branch, repos } = res;
  const { pathByRepo, pullRemoteByRepo } = code.groups();
  for (const repoId of repos) {
    const path = pathByRepo[repoId];
    if (!path) continue;
    await postJSON("/api/code/remote-branch/fetch", {
      path,
      branch,
      pull_remote: pullRemoteByRepo[repoId],
    });
  }
  await startCreateWorkspace(plugins, {
    name: branch,
    config: repos.map((r) => `${r}:${branch}`).join(","),
    db: branch,
    template: "",
    createBranches: false,
  });
}

// Adopt the current checkout: turn whatever is checked out in the main server
// repos (community/enterprise — the ones a workspace may launch) into a
// main-located workspace, one click, no form. The checkout already matches by
// construction, so "activating" is just recording it as the loaded workspace —
// no git, no dirty-tree guard (nothing gets checked out). If a workspace for
// these exact branches already exists, it is selected instead of duplicated.
export async function adoptCurrentCheckout(plugins) {
  const { config, dialogs, code, eventLog, wt, server } = plugins;
  const fail = (message) =>
    dialogs.open({ title: "Adopt current checkout", message, okLabel: "OK", cancelLabel: null });

  // fresh local git state, scoped to the server repos (no PR/runbot/mergebot)
  await code.loadBranches(new Set(["community", "enterprise"]));
  const byId = Object.fromEntries(code.branchRepos().map((r) => [r.id, r]));
  const checkouts = [];
  for (const id of ["community", "enterprise"]) {
    const cur = byId[id]?.current;
    if (cur && cur !== "(detached)") checkouts.push({ repo: id, branch: cur });
  }
  if (!checkouts.some((c) => c.repo === "community")) {
    const why = code.error() ? ` (${code.error()})` : " (detached HEAD?)";
    return fail(`couldn't read the community checkout${why} — check out a branch there first`);
  }

  // make `ws` the loaded workspace without touching git; a main server running
  // another workspace must stop first (same semantics as activate())
  const makeLoaded = async (ws) => {
    const s = server.status();
    const busy = s.state === "running" || s.state === "starting";
    const activeId = busy ? s.workspace : server.lastWorkspace();
    if (ws.id === activeId) return;
    if (busy) {
      const running = (config.config.workspaces || []).find((w) => w.id === activeId);
      const ok = await dialogs.open({
        title: "Adopt current checkout",
        message: `The main server is running${running ? ` workspace "${running.name}"` : ""} — stop it and make "${ws.name}" the loaded workspace?`,
        okLabel: "Stop & adopt",
      });
      if (!ok) return;
      await server.stop();
    }
    server.setLastWorkspace(ws.id);
    config.workspace(ws.id)?.touchActivity();
  };

  // an existing main-located workspace already describing this exact checkout —
  // switching to it is the honest move (same predicate as the drift strip's Adopt)
  const existing = config.config.workspaces || [];
  const match = existing.find(
    (w) =>
      w.location !== "worktree" &&
      (w.checkouts || []).length > 0 &&
      (w.checkouts || []).every(({ repo, branch }) => byId[repo]?.current === branch),
  );
  if (match) {
    eventLog.add(`adopting current checkout → existing workspace ${match.name}`);
    await makeLoaded(match);
    wt.select(match.id);
    return;
  }

  // named after the feature branch (16.0-owl-fix beats its 16.0 base); a name
  // collision with different checkouts gets a numeric suffix
  const feature =
    checkouts.map((c) => c.branch).find((b) => !BASE_BRANCH_RE.test(b)) || checkouts[0].branch;
  let name = feature;
  const names = new Set(existing.map((w) => w.name));
  for (let i = 2; names.has(name); i++) name = `${feature}-${i}`;

  const now = new Date().toISOString();
  const ws = {
    id: newWorkspaceId(),
    name,
    created_at: now,
    last_activity: now,
    favorite: false,
    db: name,
    on_create_args: "",
    demo_data: true,
    location: "main",
    worktree: null,
    port: null,
    checkouts,
  };
  eventLog.add(`creating workspace ${ws.name} from the current checkout`);
  config.updateConfig({ workspaces: [...existing, ws] });
  await makeLoaded(ws);
  wt.select(ws.id);
}

// Delete a main-located workspace via a confirmation dialog that can also
// (optionally) delete its local/remote branches (non-base ones that exist),
// close its open PRs and drop its database. (Worktree workspaces go through
// wt.remove — the backend owns their on-disk cleanup.)
export async function deleteWorkspaceDialog(
  ws,
  { config, code, db, eventLog, repoMap, isActive, dialogs },
) {
  if (isActive) return; // the loaded workspace cannot be deleted
  const groups = code.groups();
  // deletable branches: present locally and not a base/primary branch
  const branches = (ws.checkouts || [])
    .map(({ repo, branch }) => ({ repo, branch, b: repoMap[repo]?.branches.get(branch) }))
    .filter((x) => x.b && !BASE_BRANCH_RE.test(x.branch))
    .map((x) => ({
      repo: x.repo,
      branch: x.branch,
      path: groups.pathByRepo[x.repo],
      remote: !!x.b.remote,
    }));
  // open PRs for the workspace's branches
  const prs = (ws.checkouts || [])
    .map(({ repo, branch }) => ({
      pr: groups.prIndex[`${repo}:${branch}`],
      github: groups.githubByRepo[repo],
    }))
    .filter((x) => x.pr && x.pr.state === "open" && x.github)
    .map((x) => ({ github: x.github, number: x.pr.number }));

  const fields = [];
  if (branches.length)
    fields.push({
      key: "delBranches",
      type: "checkbox",
      label: `Also delete ${branches.length === 1 ? "its branch" : `its ${branches.length} branches`}`,
      value: true,
    });
  if (branches.some((b) => b.remote))
    fields.push({
      key: "delRemote",
      type: "checkbox",
      label: "…also on the push remote",
      value: true,
    });
  if (prs.length)
    fields.push({
      key: "closePrs",
      type: "checkbox",
      label: `Close ${prs.length === 1 ? "its open pull request" : `its ${prs.length} open pull requests`}`,
      value: true,
    });
  // only offer to drop the db if it actually exists (a never-run workspace has none)
  const dbExists = ws.db && db.databases().some((d) => d.name === ws.db);
  if (dbExists)
    fields.push({
      key: "dropDb",
      type: "checkbox",
      label: `Drop database "${ws.db}"`,
      value: true,
    });

  const res = await dialogs.open({
    title: `Delete "${ws.name}"?`,
    message: "The workspace will be removed from your list. This cannot be undone.",
    okLabel: "Delete",
    fields,
  });
  if (!res) return;

  eventLog.add(`deleting workspace ${ws.name}`);
  // these are independent network/git ops (close PRs, delete branches per repo,
  // drop the db) — fire them concurrently rather than one slow await after another.
  // Each helper handles its own errors and never rejects, so Promise.all is safe.
  const ops = [];
  if (res.closePrs) for (const p of prs) ops.push(code.closePrNoConfirm(p.github, p.number));
  if (res.delBranches)
    for (const b of branches)
      ops.push(code.deleteBranchNoConfirm(b.branch, b.repo, b.path, !!res.delRemote && b.remote));
  if (res.dropDb && ws.db) ops.push(db.drop(ws.db));
  await Promise.all(ops);
  config.updateConfig({
    workspaces: config.config.workspaces.filter((w) => w.id !== ws.id),
  });
}
