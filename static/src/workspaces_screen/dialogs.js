// The shared workspace dialogs: the unified create form (template picker +
// location), create-from-remote-branch, and delete-with-cleanup. Used by the
// Workspaces screen and the dashboard cards. Every write goes to the canonical
// `workspaces` key (full records spread — the legacy `targets` view drops the
// stable ports).

import { BASE_BRANCH_RE } from "../core/config.js";
import { newWorkspaceId } from "../core/config_plugin.js";
import { RemoteBranchDialog } from "../core/dialogs.js";
import { postJSON, repoBranchList } from "../core/utils.js";

// the canonical base branch a work branch's name derives from: 16.0-owl-fix →
// 16.0, saas-19.4-x → saas-19.4, anything else → master
const baseBranchOf = (branch) =>
  (/^(saas-\d+\.\d+|\d+\.\d+|master)/.exec(branch) || ["", "master"])[1];

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
        value: prefill.config ?? "",
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
      { key: "fav", type: "checkbox", label: "Favorite", value: false },
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
      favorite: !!res.fav,
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
    favorite: !!res.fav,
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
  const pathByRepo = code.groups().pathByRepo;
  for (const repoId of repos) {
    const path = pathByRepo[repoId];
    if (!path) continue;
    await postJSON("/api/code/remote-branch/fetch", { path, branch });
  }
  await startCreateWorkspace(plugins, {
    name: branch,
    config: repos.map((r) => `${r}:${branch}`).join(","),
    db: branch,
    template: "",
    createBranches: false,
  });
}

// Delete a main-located workspace via a confirmation dialog that can also
// (optionally) delete its local/remote branches (non-base ones that exist),
// close its open PRs and drop its database. Shared by the Workspaces screen and
// the dashboard card menu. (Worktree workspaces go through wt.remove — the
// backend owns their on-disk cleanup.)
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
      label: "…also on the remote (odoo-dev)",
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
