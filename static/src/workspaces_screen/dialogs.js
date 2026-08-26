// The shared workspace dialogs and actions: the unified create form (template
// picker + location), create-from-remote-branch, adopt-current-checkout, and
// delete-with-cleanup. Used by the Workspaces screen. Every write goes to the
// canonical `workspaces` key (full records spread — the legacy `targets` view
// drops the stable ports).

import { ARCHIVED_CATEGORY, BASE_BRANCH_RE, baseBranchOf } from "../core/config.js";
import { newWorkspaceId } from "../core/config_plugin.js";
import { RemoteBranchDialog } from "../core/dialogs.js";
import { postJSON, repoBranchList, descendantWorkspaces } from "../core/utils.js";
import { cascadeRemoveDescendants } from "../core/workspace_plugin.js";

import { Component, onMounted, onWillUnmount, signal, t, useProps, xml } from "@odoo/owl";

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

// the Config string for a set of ticked repo ids. Forking fresh branches (the
// common "new task" case): every repo gets the same new branch name, so a
// full stomp from `branch` is correct even for repos already in `currentConfig`.
// Attaching existing branches (bundle / remote-branch / forward-port sources,
// `preserveExisting`): a repo's real, already-fetched branch must survive
// toggling an unrelated repo's checkbox or editing the name — only a repo with
// no config entry yet (the user manually ticking one beyond what was fetched)
// gets `branch` stamped as a best-effort guess.
const configFromRepos = (repoIds, branch, currentConfig = "", preserveExisting = false) => {
  const existing = preserveExisting
    ? Object.fromEntries(repoBranchList.parse(currentConfig).map((c) => [c.repo, c.branch]))
    : {};
  return repoBranchList.format(repoIds.map((repo) => ({ repo, branch: existing[repo] ?? branch })));
};

// Fetch a remote branch into a local one of the same name — the shared step
// every "attach existing branch" source (bundle, remote-branch search,
// forward-port) starts from. A plain non-fast-forward rejection means the
// local branch already exists here and has diverged from the remote (it was
// rebased/force-pushed since goo last fetched it) — ask before overwriting the
// local copy rather than just failing the whole flow outright. Returns
// {ok, error?}.
async function fetchRemoteBranch(dialogs, { path, branch, pull_remote }) {
  const attempt = (force) =>
    postJSON("/api/code/remote-branch/fetch", { path, branch, pull_remote, force });
  try {
    await attempt(false);
    return { ok: true };
  } catch (e) {
    if (!e.data?.non_ff) return { ok: false, error: e.message };
    const proceed = await dialogs.open({
      title: "Branch has diverged",
      message: `the local ${branch} has diverged from ${pull_remote || "origin"} (it was likely rebased or force-pushed) — overwrite the local copy with the remote's?`,
      okLabel: "Overwrite",
      cancelLabel: "Skip",
    });
    if (!proceed) return { ok: false, error: e.message };
    try {
      await attempt(true);
      return { ok: true };
    } catch (e2) {
      return { ok: false, error: e2.message };
    }
  }
}

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
    category: tpl.category || "",
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
  // odoo-dev/odoo and odoo/odoo both mean the "odoo/odoo" config repo. Skips
  // "owl": it never carries per-feature branches (goo always forks it itself from
  // the exact vendored commit — see _api_workspace_create in server.py), unlike
  // "documentation", which real doc work sometimes *does* push alongside a
  // feature — the backend tries that branch first and only falls back to forking
  // from the base series when it doesn't actually exist there.
  const matches = [];
  for (const { github, branch } of info.branches || []) {
    const repoName = github.split("/")[1];
    const r = (config.config.repos || []).find((x) => (x.github || "").split("/")[1] === repoName);
    if (!r || !r.path || r.id === "owl") continue;
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
      const r = await fetchRemoteBranch(dialogs, {
        path: m.repo.path,
        branch: m.branch,
        pull_remote: m.remote,
      });
      eventLog.finish(eid, r.ok ? "done" : "error");
      return { ...m, ...r };
    }),
  );
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    dialogs.error(
      "Fetching bundle branches failed",
      failed.map((f) => `${f.repo.id}: ${f.error}`).join("\n"),
    );
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
// config, db, args, demoData, template, category, createBranches, parent }.
// `parent` isn't a form field — it's implicit from how the create flow was
// invoked (e.g. a forward-port row's "sub workspace" button) and is passed
// straight into the created workspace.
export async function startCreateWorkspace(plugins, prefill = {}) {
  const { config, dialogs, db, code, eventLog, wt } = plugins;
  await db.load(); // populate the "Clone db" select
  const templates = config.config.templates || [];
  const tpl = templates.find((t) => t.id === prefill.template) || null;
  const existing = config.config.workspaces || [];
  const dbNames = new Set(db.databases().map((d) => d.name));
  // best-effort refresh so a branch created/fetched moments ago (e.g. in
  // another tab) isn't reported stale by the hint/fork-set logic below. Reads
  // live off `code.branchRepos()` (not a snapshot) so it also picks up a
  // branch the "Search branches…" action just fetched, while the form is
  // still open.
  code.loadBranches();
  const hasLocalBranch = (repo, branch) =>
    code
      .branchRepos()
      .find((r) => r.id === repo)
      ?.branches.some((b) => b.name === branch) ?? false;
  const dbOptions = db.databases().map((d) => ({ value: d.name, label: d.name }));
  const repoOptions = (config.config.repos || []).map((r) => ({ value: r.id, label: r.id }));
  // ticked by default: whatever the prefilled config already covers, else every
  // non-external configured repo (a new task branch usually spans all of them;
  // external repos, e.g. odoo/owl, are outside the CI ecosystem and rarely need
  // a matching branch, so leave them for the user to opt into)
  const prefillRepoIds = prefill.config
    ? repoBranchList.parse(prefill.config).map((c) => c.repo)
    : (config.config.repos || []).filter((r) => !r.external).map((r) => r.id);
  // bundle / remote-branch / forward-port sources (createBranches: false) only
  // fetched a branch for `prefillRepoIds` — anything the user ticks beyond that
  // has no confirmed branch to attach; git worktree add for it fails with
  // "invalid reference" and takes the whole creation down (see the check below,
  // right before checkouts are used).
  const verifiedRepos = prefill.createBranches === false ? new Set(prefillRepoIds) : null;
  const res = await dialogs.open({
    title: tpl ? `New workspace — from template "${tpl.name}"` : "New workspace",
    okLabel: "Create",
    validate: (v) => {
      const name = (v.name || "").trim();
      if (!name) return "a name is required";
      if (existing.some((w) => w.name === name))
        return `a workspace named "${name}" already exists`;
      if (!repoBranchList.parse((v.config || "").trim()).length) return "a config is required";
      if ((v.cloneDb || "") && !(v.db || "").trim())
        return "set a database name to clone the selected database into";
      if (v.location === "worktree" && v.cloneDb && dbNames.has((v.db || "").trim()))
        return `database "${(v.db || "").trim()}" already exists — pick a new name to clone into`;
      if (v.createVenv && v.location !== "worktree")
        return 'a venv needs Location set to "Own worktree + port"';
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
          {
            value: "worktree",
            // "+ port" only promises something goo actually manages — under
            // hide_start_controls an externally-launched server owns its own
            // port goo has no say in (see workspace_plugin.js's port()/_baseUrl)
            label: config.config.hide_start_controls
              ? "Own worktree (runs concurrently)"
              : "Own worktree + port (runs concurrently)",
          },
        ],
      },
      {
        key: "name",
        type: "text",
        label: "Name",
        value: prefill.name ?? "",
        placeholder: "name (e.g. master-mytask)",
        onChange: (newName, currentValues, oldValues) => {
          const updates = {
            config: configFromRepos(
              currentValues.repos || [],
              newName.trim(),
              currentValues.config,
              currentValues.createBranches === false,
            ),
          };
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
          config: configFromRepos(
            repoIds,
            (currentValues.name || "").trim(),
            currentValues.config,
            currentValues.createBranches === false,
          ),
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
        // per-repo "will attach / will fork" preview, live off real local git
        // state — the same ground truth forkRepos is computed from below, so
        // this always matches what Create will actually do
        hint: (values) => {
          const checkouts = repoBranchList.parse((values.config || "").trim());
          if (!checkouts.length) return null;
          return checkouts
            .map((c) =>
              hasLocalBranch(c.repo, c.branch)
                ? `${c.repo}: attach existing "${c.branch}"`
                : `${c.repo}: fork new from ${baseBranchOf(c.branch)}`,
            )
            .join(" · ");
        },
      },
      {
        key: "branchSearch",
        type: "action",
        label: "Search local/remote branches…",
        run: async (values) => {
          const res = await dialogs.openComponent(RemoteBranchDialog, { repoIds: values.repos });
          if (!res) return null;
          const { pathByRepo, pullRemoteByRepo } = code.groups();
          const toFetch = res.repos.filter((r) => !hasLocalBranch(r, res.branch) && pathByRepo[r]);
          const fetchedNow = [];
          for (const repoId of toFetch) {
            const r = await fetchRemoteBranch(dialogs, {
              path: pathByRepo[repoId],
              branch: res.branch,
              pull_remote: pullRemoteByRepo[repoId],
            });
            if (r.ok) fetchedNow.push(repoId);
            else dialogs.error("Fetching branch failed", `${repoId}: ${r.error}`);
          }
          if (fetchedNow.length) await code.refreshBranches(new Set(fetchedNow));
          const repos = [...new Set([...values.repos, ...res.repos])];
          // the searched branch applies to the repos it matched; any other
          // already-ticked repo keeps whatever branch it already had
          const currentByRepo = Object.fromEntries(
            repoBranchList.parse(values.config || "").map((c) => [c.repo, c.branch]),
          );
          const config = repoBranchList.format(
            repos.map((repo) => ({
              repo,
              branch: res.repos.includes(repo) ? res.branch : (currentByRepo[repo] ?? res.branch),
            })),
          );
          return { name: res.branch, repos, config };
        },
      },
      {
        key: "db",
        type: "text",
        label: "Database",
        value: prefill.db ?? "",
        placeholder: "database name",
      },
      // Start args only ever reach backend/server.py's odoo-bin launch command —
      // unused when goo never launches the server itself (hide_start_controls)
      ...(config.config.hide_start_controls
        ? []
        : [
            {
              key: "args",
              type: "text",
              label: "Start args",
              value: prefill.args ?? "",
              placeholder: "-i sale_management",
            },
          ]),
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
      // same story as Start args: only feeds the --without-demo flag on goo's own
      // launch (backend/server.py) — unused under hide_start_controls
      ...(config.config.hide_start_controls
        ? []
        : [
            {
              key: "demoData",
              type: "checkbox",
              label: "Demo data",
              value: prefill.demoData ?? true,
            },
          ]),
      {
        key: "createBranches",
        type: "checkbox",
        label: "Create branches",
        // true (the default, e.g. from a template): per repo, fork fresh unless
        // that exact branch already exists locally (then attach it instead —
        // see the hasLocalBranch-based forkRepos computation below). false
        // (bundle / remote branch / forward-port prefills): the checkouts are
        // already-existing local branches from an earlier fetch — attach them
        // as-is, except any the source didn't actually confirm (see
        // "Unconfirmed branch" below), which still fork from their base.
        value: prefill.createBranches ?? true,
      },
      { key: "activate", type: "checkbox", label: "Activate it (main)", value: true },
      // the venv is only ever consulted at launch by goo's own subprocess
      // (workspace_plugin.js createWorktree) — a Docker container brings its own
      // Python env, so this is unused under hide_start_controls
      ...(config.config.hide_start_controls
        ? []
        : [
            {
              key: "createVenv",
              type: "checkbox",
              label: "Create venv from requirements.txt (worktree)",
              value: prefill.createVenv ?? false,
            },
          ]),
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

  // Per-repo attach-vs-fork, from real local git state (hasLocalBranch) — not
  // just the narrow "unverified bundle repo" case below. When createBranches
  // is true (the manual/template default), forking blindly used to hit a hard
  // git failure the moment the typed/picked branch already existed locally
  // (worktree_add/create_branch both refuse to recreate one) — attach it
  // instead, and only fork what's genuinely new.
  const forkRepos = new Set();
  if (res.createBranches) {
    for (const c of checkouts) if (!hasLocalBranch(c.repo, c.branch)) forkRepos.add(c.repo);
  } else if (verifiedRepos) {
    // a repo ticked beyond what was actually fetched (createBranches still
    // false, e.g. "upgrade" isn't part of the bundle) has no real branch to
    // attach — ask before sending it: attaching a nonexistent branch fails the
    // whole creation, possibly after other repos' worktrees already landed on
    // disk. Forking it fresh from its base instead (same fallback as any
    // template-uncovered repo, above) still gives the user a usable checkout
    // there.
    const unverified = checkouts.filter((c) => !verifiedRepos.has(c.repo));
    if (unverified.length) {
      const names = unverified.map((c) => c.repo).join(", ");
      const many = unverified.length > 1;
      const proceed = await dialogs.open({
        title: "Unconfirmed branch",
        message: `${names} ${many ? "weren't" : "wasn't"} part of the fetched branches — attaching ${many ? "them" : "it"} would likely fail (the branch may not exist there). Fork ${many ? "them" : "it"} fresh from ${many ? "their bases" : "its base"} (${unverified.map((c) => `${c.repo}:${startPointByRepo[c.repo]}`).join(", ")}) instead, and create the workspace?`,
        okLabel: "Fork from base & create",
        cancelLabel: "Cancel",
      });
      if (!proceed) return;
      for (const c of unverified) forkRepos.add(c.repo);
    }
  }

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
      parent: prefill.parent || "",
      createVenv: !!res.createVenv,
      forkRepos,
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
    parent: prefill.parent || "",
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
  // fork exactly the checkouts forkRepos flagged above (new branches, or a
  // bundle/remote-branch/forward-port source's unverified repos) — everything
  // else there is a real branch already fetched/existing, adopted as-is (no
  // git needed for a main-located workspace).
  const toFork = checkouts.filter((c) => forkRepos.has(c.repo));
  if (toFork.length) {
    const pathByRepo = Object.fromEntries(config.config.repos.map((r) => [r.id, r.path]));
    await code.createBranches(
      toFork.map((c) => ({
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
// already created the local branches. A repo whose fetch fails (or has no
// path) is reported and left out of the prefill entirely — never handed to
// the create form as if it had a real local branch to attach.
export async function createWorkspaceFromRemoteBranch(plugins) {
  const { code, dialogs } = plugins;
  const res = await dialogs.openComponent(RemoteBranchDialog);
  if (!res) return;
  const { branch, repos } = res;
  const { pathByRepo, pullRemoteByRepo } = code.groups();
  const fetched = [];
  for (const repoId of repos) {
    const path = pathByRepo[repoId];
    if (!path) continue;
    const r = await fetchRemoteBranch(dialogs, {
      path,
      branch,
      pull_remote: pullRemoteByRepo[repoId],
    });
    if (r.ok) fetched.push(repoId);
    else dialogs.error("Fetching branch failed", `${repoId}: ${r.error}`);
  }
  if (!fetched.length) return;
  await startCreateWorkspace(plugins, {
    name: branch,
    config: fetched.map((r) => `${r}:${branch}`).join(","),
    db: branch,
    template: "",
    createBranches: false,
  });
}

// An existing sub-workspace already spawned from `parentWs` for this forward-port row
// (matched by parent + the row's branch — that pair is what a prior click of the
// button created). Exported so the button can label itself "Open" instead of
// "Create" and so a re-click jumps to the existing workspace instead of duplicating it.
// A forward-port sub-workspace checks out fw-bot's head branch, which is named
// `<target>-<source>-<n>-fw` (e.g. master-saas-19.4-…-fw) — not the matrix's bare
// target label (`row.branch` = "master"). So match a child of this parent whose
// checkout branch is a forward port onto this row's target.
export function findSubWorkspace(config, parentWs, row) {
  const isFwOnto = (branch) =>
    typeof branch === "string" && branch.startsWith(`${row.branch}-`) && branch.endsWith("-fw");
  return (
    (config.config.workspaces || []).find(
      (w) => w.parent === parentWs.id && (w.checkouts || []).some((c) => isFwOnto(c.branch)),
    ) || null
  );
}

// Resolve + fetch each {repo, pull: {github, number}} target's real head branch
// (via /api/prs/head — a PR's head isn't always the bare branch name a caller
// already knows, e.g. a forward-port's is fw-bot's `<target>-<source>-<n>-fw`),
// refresh the affected repos' local branch state, and report any per-repo
// failures. A repo whose branch doesn't exist upstream yet just fails its own
// fetch — the flow proceeds with whichever succeeded. Returns the successfully-
// fetched {repo, branch} entries, or null if every target failed.
async function resolvePrBranches(plugins, targets) {
  const { code, dialogs, eventLog } = plugins;
  const results = await Promise.all(
    targets.map(async ({ repo, pull }) => {
      const eid = eventLog.begin(`fetching PR #${pull.number} (${repo.id})`);
      try {
        const head = await postJSON("/api/prs/head", { repo: pull.github, number: pull.number });
        const branch = head.branch;
        if (!branch) throw new Error("could not resolve the PR's head branch");
        const r = await fetchRemoteBranch(dialogs, {
          path: repo.path,
          branch,
          pull_remote: repo.push_remote || "dev",
        });
        if (!r.ok) throw new Error(r.error);
        eventLog.finish(eid, "done");
        return { repo, branch, ok: true };
      } catch (e) {
        eventLog.finish(eid, "error");
        return { repo, ok: false, error: e.message };
      }
    }),
  );
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    dialogs.error(
      "Fetching PR branch failed",
      failed.map((f) => `${f.repo.id}: ${f.error}`).join("\n"),
    );
  }
  const got = results.filter((r) => r.ok);
  if (!got.length) return null;
  await code.refreshBranches(new Set(got.map((g) => g.repo.id)));
  return got;
}

// Create a sub-workspace for one forward-port row: fetch the row's branch across every
// repo the row lists (resolved from each cell's github slug → a configured repo, matched
// against ALL configured repos, not just parentWs's own checkouts — a forward-port row
// can name a repo the parent workspace doesn't itself check out), then open the
// prefilled create form with `parent` set to the spawning workspace's id. If a
// sub-workspace was already created for this row, this just opens it instead.
// plugins: { config, dialogs, db, code, eventLog, wt }. parentWs: the workspace (plain
// blob) the button was clicked from. row: a forwardPortChains row — { branch, cells }.
export async function createSubWorkspaceFromForwardPort(plugins, parentWs, row) {
  const { config, dialogs, wt } = plugins;
  const existing = findSubWorkspace(config, parentWs, row);
  if (existing) {
    wt.select(existing.id);
    return;
  }
  const repoFor = (slug) => {
    const exact = (config.config.repos || []).find((r) => r.github === slug);
    if (exact) return exact;
    const name = slug.split("/")[1];
    return (config.config.repos || []).find((r) => (r.github || "").split("/")[1] === name) || null;
  };
  // one {repo, pull} per cell that both maps to a configured repo and has a PR (a
  // "waiting" cell — no PR yet — is skipped)
  const targets = [];
  for (const cell of row.cells || []) {
    const repo = repoFor(cell.repository);
    const pull = (cell.pulls || [])[0];
    if (repo && repo.path && pull) targets.push({ repo, pull });
  }
  if (!targets.length) {
    return dialogs.open({
      title: "Create sub workspace",
      message: `no forward-port PR here maps to a configured repo (${(row.cells || []).map((c) => c.repository).join(", ") || "none"})`,
      okLabel: "OK",
      cancelLabel: null,
    });
  }
  const got = await resolvePrBranches(plugins, targets);
  if (!got) return;
  const name = got[0].branch; // the fw branch — unambiguous; editable in the form
  return startCreateWorkspace(plugins, {
    name,
    config: repoBranchList.format(got.map((g) => ({ repo: g.repo.id, branch: g.branch }))),
    db: name,
    template: "",
    createBranches: false,
    parent: parentWs.id,
    category: parentWs.category || "",
  });
}

// Create a fresh (non-sub) workspace directly from one or more tracked review
// PRs that share a branch name across repos — the same cross-repo convention a
// "task" groups by in the Reviews screen — so the resolved checkouts are exactly
// that task's linked branches. Same branch-resolution dance as a forward-port
// sub-workspace, minus the parent: this always creates a new top-level workspace.
// targets: [{repo, pull: {github, number}}], one per repo the task spans.
export async function createWorkspaceFromPRs(plugins, targets) {
  const got = await resolvePrBranches(plugins, targets);
  if (!got) return;
  const name = got[0].branch;
  return startCreateWorkspace(plugins, {
    name,
    config: repoBranchList.format(got.map((g) => ({ repo: g.repo.id, branch: g.branch }))),
    db: name,
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
    const activeId = server.loadedWorkspaceId();
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
  { config, code, db, eventLog, repoMap, isActive, dialogs, wt, server },
) {
  if (isActive) return; // the loaded workspace cannot be deleted
  const descendants = descendantWorkspaces(config.config.workspaces || [], ws.id);
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
    message:
      "The workspace will be removed from your list. This cannot be undone." +
      (descendants.length
        ? ` This also removes ${descendants.length} sub-workspace${descendants.length === 1 ? "" : "s"} spawned from it.`
        : ""),
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
  const { skipped } = await cascadeRemoveDescendants({ config, wt, eventLog, server }, ws);
  if (skipped.length) {
    await dialogs.open({
      title: "Some sub-workspaces were kept",
      message: skipped
        .map(
          (w) =>
            `"${w.name}" is still busy (its server is running, or it's the loaded workspace) — kept, no longer linked to the deleted parent.`,
        )
        .join("\n"),
      okLabel: "OK",
      cancelLabel: null,
    });
  }
}
