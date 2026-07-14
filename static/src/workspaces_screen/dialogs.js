// The shared workspace dialogs and actions: the unified create form (template
// picker + location), create-from-remote-branch, adopt-current-checkout, and
// delete-with-cleanup. Used by the Workspaces screen. Every write goes to the
// canonical `workspaces` key (full records spread — the legacy `targets` view
// drops the stable ports).

import { BASE_BRANCH_RE } from "../core/config.js";
import { newWorkspaceId } from "../core/config_plugin.js";
import { RemoteBranchDialog } from "../core/dialogs.js";
import { postJSON, repoBranchList } from "../core/utils.js";

// the canonical base branch a work branch's name derives from: 16.0-owl-fix →
// 16.0, saas-19.4-x → saas-19.4, anything else → master
const baseBranchOf = (branch) =>
  (/^(saas-\d+\.\d+|\d+\.\d+|master)/.exec(branch) || ["", "master"])[1];

// the Category select options for the create/edit dialogs (shown only when the
// workspace-categories setting is on; the empty placeholder = uncategorized)
export function categoryOptions(config) {
  return (config.config.workspace_categories || []).map((c) => ({ value: c.id, label: c.id }));
}

// the Config string for a set of ticked repo ids, all forking the same branch
// (the common case — a task branch of the same name across every repo it touches)
const configFromRepos = (repoIds, branch) =>
  repoBranchList.format(repoIds.map((repo) => ({ repo, branch })));

// Create a workspace through the unified dialog (validated before it closes).
// plugins: { config, dialogs, db, code, eventLog, wt }. `prefill` seeds the form
// (the remote-branch flow passes the fetched branch): { name, config, db,
// template, createBranches }.
export async function startCreateWorkspace(plugins, prefill = {}) {
  const { config, dialogs, db, code, eventLog, wt } = plugins;
  await db.load(); // populate the "Clone db" select
  const templates = config.config.templates || [];
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
    title: "New workspace",
    okLabel: "Create",
    validate: (v) => {
      const name = (v.name || "").trim();
      if (!name) return "a name is required";
      if (existing.some((w) => w.name === name))
        return `a workspace named "${name}" already exists`;
      if (!repoBranchList.parse((v.config || "").trim()).length) return "a config is required";
      if (v.location === "worktree" && !v.template)
        return "a worktree workspace needs a template — its branches fork from it";
      if ((v.cloneDb || "") && !(v.db || "").trim())
        return "set a database name to clone the selected database into";
      if (v.location === "worktree" && v.cloneDb && dbNames.has((v.db || "").trim()))
        return `database "${(v.db || "").trim()}" already exists — pick a new name to clone into`;
      return "";
    },
    fields: [
      {
        key: "template",
        type: "select",
        label: "Template",
        placeholder: "— start blank —",
        options: templates.map((t) => ({ value: t.id, label: t.name })),
        value: prefill.template ?? templates[0]?.id ?? "",
        onChange: (tplId) => {
          const tpl = templates.find((t) => t.id === tplId);
          if (!tpl) return null;
          const branch =
            tpl.checkouts.find((c) => c.repo === "enterprise")?.branch ||
            tpl.checkouts.find((c) => c.repo === "community")?.branch ||
            "";
          return {
            name: branch,
            repos: tpl.checkouts.map((c) => c.repo),
            config: repoBranchList.format(tpl.checkouts),
            db: tpl.db || "",
            args: tpl.on_create_args || "",
            demoData: tpl.demo_data ?? true,
          };
        },
      },
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
      { key: "args", type: "text", label: "Start args", placeholder: "-i sale_management" },
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
        default: (v) => {
          const tpl = templates.find((t) => t.id === v.template);
          if (tpl?.db && dbNames.has(tpl.db)) return tpl.db;
          return dbOptions[0]?.value || "";
        },
      },
      { key: "demoData", type: "checkbox", label: "Demo data", value: true },
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
  const tpl = templates.find((t) => t.id === res.template);
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
