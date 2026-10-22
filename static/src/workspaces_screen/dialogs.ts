// The shared workspace dialogs and actions: the unified create form (source —
// template / blank / runbot bundle — + location), create-from-remote-branch, adopt-current-checkout, and
// delete-with-cleanup. Used by the Workspaces screen. Every write goes to the
// canonical `workspaces` key (full records spread — the legacy `targets` view
// drops the stable ports).

import {
  ARCHIVED_CATEGORY,
  BASE_BRANCH_RE,
  baseBranchOf,
  defaultDemoData,
} from "../core/config.ts";
import { newWorkspaceId } from "../core/config_plugin.ts";
import {
  errorMessage,
  postJSON,
  repoBranchList,
  descendantWorkspaces,
  fetchReviewPrompt,
} from "../core/utils.ts";
import { cascadeRemoveDescendants } from "../core/workspace_plugin.ts";
import type {
  CheckoutConfig,
  RepoConfig,
  TemplateConfig,
  WorkspaceConfig,
} from "../core/config.ts";
import type { ConfigPlugin } from "../core/config_plugin.ts";
import type { CodePlugin } from "../core/code_plugin.ts";
import type { DatabasePlugin, RunbotDump } from "../core/database_plugin.ts";
import type { DialogField, DialogPlugin } from "../core/dialog_plugin.ts";
import type { EventLogPlugin } from "../core/event_log_plugin.ts";
import type { BranchInfo, ForwardPortRow } from "../core/observed_models.ts";
import type { ServerPlugin } from "../core/server_plugin.ts";
import type { PullRequest } from "../core/models.ts";
import type { WorkspaceLike, WorkspacePlugin } from "../core/workspace_plugin.ts";
import type { ClaudePlugin } from "./claude_plugin.ts";
import {
  CreateWorkspaceDialog,
  configFromRepos,
  splitStartArgs,
  startArgs,
} from "./create_dialog.ts";
import type { BranchFetch, CreateForm, SourceRequest, SourceValues } from "./create_dialog.ts";

import type { PluginInstance } from "@odoo/owl";

// the plugin bundle the create/delete flows drive (a screen's _dialogPlugins());
// each flow takes the Pick of it that it actually uses
export interface WorkspacePlugins {
  config: PluginInstance<typeof ConfigPlugin>;
  dialogs: PluginInstance<typeof DialogPlugin>;
  db: PluginInstance<typeof DatabasePlugin>;
  code: PluginInstance<typeof CodePlugin>;
  eventLog: PluginInstance<typeof EventLogPlugin>;
  wt: PluginInstance<typeof WorkspacePlugin>;
}

// one PR to resolve + fetch into a configured repo ({repo, pull: {github, number}})
export interface PrTarget {
  repo: Pick<RepoConfig, "id" | "path">;
  pull: { github: string; number: number };
}

// a resolvePrBranches success: the PR's head branch, fetched into `repo`
export interface ResolvedPrBranch {
  repo: Pick<RepoConfig, "id" | "path">;
  branch: string;
  ok: true;
}

// what the create form opens prefilled with (startCreateWorkspace)
export interface CreatePrefill {
  name?: string;
  config?: string; // repoBranchList-formatted checkouts
  db?: string;
  args?: string;
  demoData?: boolean;
  template?: string;
  category?: string;
  createBranches?: boolean;
  parent?: string;
  location?: string;
  createVenv?: boolean;
  dumps?: RunbotDump[];
}

// /api/runbot/bundle-info's reply
interface BundleInfo {
  name: string;
  branches?: { github: string; branch: string }[];
  prs?: { github: string; number: number }[];
  dumps?: RunbotDump[];
}

// _fetchWithOverwritePrompt's outcome
interface FetchOutcome {
  ok: boolean;
  error?: string;
}

// a postJSON rejection whose reply flagged a non-fast-forward fetch
function isNonFf(e: unknown): boolean {
  const data: unknown = e instanceof Error && "data" in e ? e.data : undefined;
  return typeof data === "object" && data !== null && "non_ff" in data && !!data.non_ff;
}

// the Category select options for the create/edit dialogs (shown only when the
// workspace-categories setting is on; the empty placeholder = uncategorized).
// "archived" is always offered last, so an archived workspace's Edit dialog can
// show — and keep — its real category.
export function categoryOptions(config: {
  config: { workspace_categories?: { id: string }[] };
}): { value: string; label: string }[] {
  const opts = (config.config.workspace_categories || []).map((c) => ({
    value: c.id,
    label: c.id,
  }));
  if (!opts.some((o) => o.value === ARCHIVED_CATEGORY))
    opts.push({ value: ARCHIVED_CATEGORY, label: ARCHIVED_CATEGORY });
  return opts;
}

// Shared "try, then on a non-fast-forward rejection offer to overwrite" dance —
// the local branch already exists here and has diverged from the remote (it was
// rebased/force-pushed since goo last fetched it); ask before overwriting the
// local copy rather than just failing the whole flow outright. `source` is only
// used in the confirmation message (a remote name, or a "owner/repo" slug).
// `attempt(force)` does the actual fetch. Returns {ok, error?}.
async function _fetchWithOverwritePrompt(
  dialogs: PluginInstance<typeof DialogPlugin>,
  branch: string,
  source: string,
  attempt: (force: boolean) => Promise<unknown>,
): Promise<FetchOutcome> {
  try {
    await attempt(false);
    return { ok: true };
  } catch (e) {
    if (!isNonFf(e)) return { ok: false, error: errorMessage(e) };
    const proceed = await dialogs.open({
      title: "Branch has diverged",
      message: `the local ${branch} has diverged from ${source} (it was likely rebased or force-pushed) — overwrite the local copy with the remote's?`,
      okLabel: "Overwrite",
      cancelLabel: "Skip",
    });
    if (!proceed) return { ok: false, error: errorMessage(e) };
    try {
      await attempt(true);
      return { ok: true };
    } catch (e2) {
      return { ok: false, error: errorMessage(e2) };
    }
  }
}

// Fetch a remote branch into a local one of the same name, by bare branch name —
// the shared step every non-PR "attach existing branch" source (bundle,
// remote-branch search) starts from. Only works when the branch actually lives
// on `pull_remote` itself — see fetchPrHead for PR targets, where that isn't
// guaranteed.
async function fetchRemoteBranch(
  dialogs: PluginInstance<typeof DialogPlugin>,
  { path, branch, pull_remote }: { path: string; branch: string; pull_remote: string },
): Promise<FetchOutcome> {
  return _fetchWithOverwritePrompt(dialogs, branch, pull_remote || "origin", (force) =>
    postJSON("/api/code/remote-branch/fetch", { path, branch, pull_remote, force }),
  );
}

// Fetch a PR's head via GitHub's refs/pull/<number>/head, straight from the PR's
// own repo (github, e.g. "odoo/odoo") — the shared step every PR-based "attach
// existing branch" source (resolvePrBranches, so createWorkspaceFromPRs/
// createReviewWorkspace/createSubWorkspaceFromForwardPort) starts from. Unlike
// fetchRemoteBranch (by bare branch name off a locally-configured remote), this
// doesn't depend on any local repo's pull_remote/push_remote happening to point
// at the exact repo the PR lives on — which isn't guaranteed for a contributor's
// fork, a forward-port opened against the canonical repo while the local
// checkout points at a company fork, or a colleague's WIP pushed to a shared
// staging remote instead of the repo itself.
async function fetchPrHead(
  dialogs: PluginInstance<typeof DialogPlugin>,
  {
    path,
    github,
    number,
    branch,
  }: { path: string; github: string; number: number; branch: string },
): Promise<FetchOutcome> {
  return _fetchWithOverwritePrompt(dialogs, branch, github, (force) =>
    postJSON("/api/code/remote-branch/fetch-pr", { path, github, number, branch, force }),
  );
}

// Bring an EXISTING review workspace's checkouts up to date with their tracked PRs'
// current heads before re-running a review — "Review again" (reviews.ts _rerunReview)
// must see commits pushed since the workspace was created (or since the last review),
// not just replay the same diff Claude already saw. Unlike fetchPrHead (used once, at
// workspace-creation time), this can't fetch onto the branch ref by name: that branch is
// already checked out in the workspace's own worktree, and git refuses to move a ref
// that's checked out elsewhere. So it fetches + hard-resets in place, in the worktree's
// own directory (backend GitService.sync_pr_worktree). Best-effort per repo — one repo
// failing to sync is reported but doesn't block the others or the review itself.
// targets: [{repo, pull: {github, number}}], same shape resolvePrBranches consumes.
export async function syncReviewWorktree(
  plugins: Pick<WorkspacePlugins, "dialogs" | "wt" | "eventLog">,
  ws: WorkspaceLike,
  targets: PrTarget[],
): Promise<void> {
  const { dialogs, wt, eventLog } = plugins;
  const worktreeByRepo = Object.fromEntries(wt.wtRepos(ws).map((r) => [r.repo, r]));
  const failed: string[] = [];
  await Promise.all(
    targets.map(async ({ repo, pull }) => {
      const wtr = worktreeByRepo[repo.id];
      if (!wtr) return;
      const eid = eventLog.begin(`syncing PR #${pull.number} (${repo.id})`);
      try {
        const r = await postJSON<{ ok: boolean; error?: string }>(
          "/api/code/remote-branch/sync-pr",
          {
            path: wtr.worktreePath,
            github: pull.github,
            number: pull.number,
            repo: repo.id,
          },
        );
        eventLog.finish(eid, r.ok ? "done" : "error");
        if (!r.ok) failed.push(`${repo.id}: ${r.error}`);
      } catch (e) {
        eventLog.finish(eid, "error");
        failed.push(`${repo.id}: ${errorMessage(e)}`);
      }
    }),
  );
  if (failed.length) dialogs.error("Syncing PR update failed", failed.join("\n"));
}

// the template fields the prefill reads (a full TemplateConfig, or a partial one)
type TemplateLike = Pick<TemplateConfig, "id" | "checkouts"> & Partial<TemplateConfig>;

// the branch a template names itself after — its enterprise checkout's, else its
// community one's. Also what its base version (and so its runbot bundle) derives from.
export function templateBranch(tpl: Pick<TemplateConfig, "checkouts"> | null | undefined): string {
  if (!tpl) return "";
  return (
    tpl.checkouts.find((c) => c.repo === "enterprise")?.branch ||
    tpl.checkouts.find((c) => c.repo === "community")?.branch ||
    ""
  );
}

// The values a template prefills into the create form: named after its
// enterprise/community branch, its checkouts as the config, plus db / args / demo data.
export function templatePrefill(tpl: TemplateLike | null | undefined): CreatePrefill {
  if (!tpl) return {};
  const branch = templateBranch(tpl);
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

// The dumps of the bundle for a workspace's BASE version — "the runbot database
// for master / 19.0" when the workspace is forked from a template rather than
// picked up from a pasted bundle URL. Best-effort: runbot being slow or having no
// bundle for that base just means the create form doesn't offer the restore, which
// is a far better outcome than blocking the whole flow on it.
async function baseVersionDumps(branch: string): Promise<RunbotDump[]> {
  // "— start blank —" picks no template, so there's no branch to derive a base from
  const base = branch ? baseBranchOf(branch) : "";
  if (!base) return [];
  try {
    const res = await postJSON<{ dumps?: RunbotDump[] }>("/api/runbot/dumps", { branch: base });
    return res.dumps || [];
  } catch {
    return [];
  }
}

// The configured repos a runbot bundle's branches belong to, each with the remote
// that carries its branch (the canonical repo's pull remote, or the shared dev
// fork's push remote for colleagues' work); null (already explained) when none.
function bundleMatches(
  { config, dialogs }: Pick<WorkspacePlugins, "config" | "dialogs">,
  info: BundleInfo,
): { repo: RepoConfig; branch: string; remote: string }[] | null {
  // map the bundle's github repos onto the configured ones by repo name —
  // odoo-dev/odoo and odoo/odoo both mean the "odoo/odoo" config repo. Skips
  // "owl": it never carries per-feature branches, so there's nothing on the
  // bundle to match it to — leaving it out of the prefill means its Repositories
  // checkbox opens unticked, and the user opts in by ticking it themselves (the
  // backend then forks it from the exact vendored commit — see
  // _api_workspace_create in server.py). "documentation" isn't skipped: real doc
  // work sometimes *does* push alongside a feature, so a bundle branch for it
  // gets matched (and ticked) like any other repo; the backend tries that branch
  // first and only falls back to forking from the base series when it doesn't
  // actually exist there.
  const matches: { repo: RepoConfig; branch: string; remote: string }[] = [];
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
    return null;
  }
  return matches;
}

// Fetch the branches a remote / bundle / pull request source planned — at Create,
// before anything else, each as a timed event-log row (a diverged local copy asks
// before being overwritten) — then refresh those repos' branches. False when one
// failed (reported): the caller creates nothing.
async function fetchPlanned(
  plugins: Pick<WorkspacePlugins, "config" | "dialogs" | "code" | "eventLog">,
  planned: { repo: string; fetch: BranchFetch }[],
): Promise<boolean> {
  const { config, dialogs, code, eventLog } = plugins;
  const pathByRepo = Object.fromEntries(config.config.repos.map((r) => [r.id, r.path]));
  const results = await Promise.all(
    planned.map(async ({ repo, fetch }) => {
      const from = "remote" in fetch ? fetch.remote : `PR #${fetch.number}`;
      const eid = eventLog.begin(`fetching ${fetch.branch} (${repo}) from ${from}`);
      const path = pathByRepo[repo];
      const r =
        "remote" in fetch
          ? await fetchRemoteBranch(dialogs, {
              path,
              branch: fetch.branch,
              pull_remote: fetch.remote,
            })
          : await fetchPrHead(dialogs, { path, ...fetch });
      eventLog.finish(eid, r.ok ? "done" : "error");
      return { repo, ...r };
    }),
  );
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    dialogs.error(
      "Fetching branches failed — nothing was created",
      failed.map((f) => `${f.repo}: ${f.error}`).join("\n"),
    );
    return false;
  }
  await code.refreshBranches(new Set(planned.map((p) => p.repo)));
  return true;
}

// "New workspace": the create form with its Source select, opened on the first
// template (or blank, with none).
export function startNewWorkspace(plugins: WorkspacePlugins): Promise<void> {
  const tpl = (plugins.config.config.templates || [])[0];
  return startCreateWorkspace(plugins, templatePrefill(tpl), { pickSource: true });
}

// Download + restore a runbot dump into the workspace's own database, as its last
// creation step. Deliberately last, and deliberately non-fatal: it's a long network
// + psql job, and a workspace whose checkouts already landed is worth keeping even
// when its database didn't — the user can retry from the Databases screen rather
// than redo the whole creation. The plugin logs the timed row; this only adds the
// failure dialog, since nothing else would surface it (the form is already gone).
async function restoreRunbotDump(
  { db, dialogs }: Pick<WorkspacePlugins, "db" | "dialogs">,
  url: string,
  dbName: string,
): Promise<void> {
  const error = await db.restoreRunbotDump(url, dbName);
  if (error) dialogs.error("Restoring the runbot database failed", error);
}

// the configured repo a GitHub slug ("odoo/odoo", "odoo-dev/enterprise") means —
// the exact repo, else one with the same repo name (a fork)
function repoForGithub(repos: RepoConfig[], slug: string): RepoConfig | null {
  const name = slug.split("/")[1];
  return (
    repos.find((r) => r.github === slug) ||
    repos.find((r) => (r.github || "").split("/")[1] === name) ||
    null
  );
}

// a pull request URL (GitHub's or mergebot's: …/<owner>/<repo>/pull/<number>)
const PR_URL_RE = /([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;

// Create a workspace through the New workspace dialog. `prefill`: { name, config,
// db, args, demoData, template, category, createBranches, parent, dumps } — what
// the caller's source (a template, a forward port's PRs, …) gives. `pickSource`
// shows the source picker on top ("New workspace"): a template, an Odoo version, a
// local or remote branch, a runbot bundle, or a pull request — picking one
// re-prefills the form from it. `parent` isn't a form field — it's implicit from how the create flow
// was invoked (e.g. a forward-port row's "sub workspace" button) and is passed
// straight into the created workspace.
export async function startCreateWorkspace(
  plugins: WorkspacePlugins,
  prefill: CreatePrefill = {},
  { pickSource = false }: { pickSource?: boolean } = {},
): Promise<void> {
  const { config, dialogs, db, code, eventLog, wt } = plugins;
  const templates = config.config.templates || [];
  const tplOf = (id: string): TemplateConfig | null => templates.find((t) => t.id === id) || null;
  await db.load(); // the existing databases (to pick, or clone)
  // a template forks off a base version, so what the form can offer to restore is
  // that version's own runbot database — looked up while the dialog is already
  // open (a bundle source brings its own dumps)
  const initialDumps = prefill.dumps
    ? null
    : baseVersionDumps(templateBranch(tplOf(prefill.template || "")));
  // best-effort refresh so a branch created/fetched moments ago (e.g. in another
  // tab) isn't reported stale by the form's attach/fork preview or the fork set below
  code.loadBranches();
  const hasLocalBranch = (repo: string, branch: string): boolean =>
    code
      .branchRepos()
      .find((r) => r.id === repo)
      ?.branches.some((b) => b.name === branch) ?? false;

  // Every value a source decides — the initial values, and what picking another
  // source replaces them with. Repos ticked by default: whatever the config
  // already covers, else every configured repo but the opt-in ones (a new task
  // branch usually spans all of them; external repos, e.g. odoo/owl, are outside
  // the CI ecosystem and rarely need a matching branch). A source attaching
  // existing branches (createBranches: false) verifies exactly the repos it fetched.
  const sourceValues = (
    p: CreatePrefill,
    sourceDumps: RunbotDump[],
    fetches: Record<string, BranchFetch> = {},
  ): SourceValues => {
    const repos = p.config
      ? repoBranchList.parse(p.config).map((c) => c.repo)
      : (config.config.repos || []).filter((r) => !r.external && !r.opt_in).map((r) => r.id);
    return {
      template: p.template ?? "",
      name: p.name ?? "",
      repos,
      config: p.config ?? (p.name ? configFromRepos(repos, p.name.trim()) : ""),
      db: p.db ?? p.name ?? "",
      // the form edits the modules a start installs apart from the other args
      addons: splitStartArgs(p.args ?? "").addons,
      args: splitStartArgs(p.args ?? "").extra,
      category: p.category ?? "",
      demoData: p.demoData ?? defaultDemoData(p.name || ""),
      createBranches: p.createBranches ?? true,
      verifiedRepos: p.createBranches === false ? repos : null,
      dumps: sourceDumps,
      fetches,
    };
  };
  // the values of a source attaching existing branches, named after `name`. A
  // branch with a planned fetch that's already local is attached as is: re-fetching
  // could overwrite (or refuse) its unpushed commits.
  const attachValues = (
    name: string,
    branches: CheckoutConfig[],
    sourceDumps: RunbotDump[],
    fetches: Record<string, BranchFetch> = {},
  ): SourceValues =>
    sourceValues(
      { name, db: name, config: repoBranchList.format(branches), createBranches: false },
      sourceDumps,
      Object.fromEntries(
        Object.entries(fetches).filter(([repo, f]) => !hasLocalBranch(repo, f.branch)),
      ),
    );

  // load what a source picked in the dialog prefills (null: nothing loaded — any
  // failure is reported by its own dialog)
  const loadSource = async (req: SourceRequest): Promise<SourceValues | null> => {
    if (req.kind === "template") {
      const tpl = tplOf(req.id);
      return sourceValues(templatePrefill(tpl), await baseVersionDumps(templateBranch(tpl)));
    }
    if (req.kind === "version") {
      // the stable branch itself, ready to be renamed into a task branch forked off it
      const { version } = req;
      return sourceValues({ name: version }, await baseVersionDumps(version));
    }
    if (req.kind === "bundle") {
      let info: BundleInfo;
      try {
        info = await postJSON<BundleInfo>("/api/runbot/bundle-info", { url: req.url });
      } catch (e) {
        dialogs.error("Reading the runbot bundle failed", errorMessage(e));
        return null;
      }
      const matches = bundleMatches(plugins, info);
      if (!matches) return null;
      // the dumps the bundle's latest batch left on runbot, already proven to
      // exist (the backend HEAD-probes them)
      const branches = matches.map((m) => ({ repo: m.repo.id, branch: m.branch }));
      const fetches = Object.fromEntries(
        matches.map((m) => [m.repo.id, { branch: m.branch, remote: m.remote }]),
      );
      return attachValues(info.name, branches, info.dumps || [], fetches);
    }
    if (req.kind === "pr") {
      const match = PR_URL_RE.exec(req.url);
      if (!match) {
        dialogs.error("Pull request", `not a pull request URL: ${req.url}`);
        return null;
      }
      const github = `${match[1]}/${match[2]}`;
      const repo = repoForGithub(config.config.repos || [], github);
      if (!repo || !repo.path) {
        dialogs.error("Pull request", `${github} isn't one of your configured repos`);
        return null;
      }
      // the PR's head branch: read-only — it's fetched at Create
      const number = Number(match[3]);
      let name: string;
      try {
        const head = await postJSON<{ branch?: string }>("/api/prs/head", { repo: github, number });
        if (!head.branch) throw new Error("could not resolve the PR's head branch");
        name = head.branch;
      } catch (e) {
        dialogs.error("Pull request", errorMessage(e));
        return null;
      }
      return attachValues(name, [{ repo: repo.id, branch: name }], await baseVersionDumps(name), {
        [repo.id]: { branch: name, github, number },
      });
    }
    // a local or remote branch, in every repo it was found in — a remote one is
    // fetched at Create
    const { branch, repos, remoteByRepo } = req.pick;
    const branches = repos.map((repo) => ({ repo, branch }));
    const fetches = Object.fromEntries(
      Object.entries(remoteByRepo).map(([repo, remote]) => [repo, { branch, remote }]),
    );
    return attachValues(branch, branches, await baseVersionDumps(branch), fetches);
  };

  const initial = sourceValues(prefill, prefill.dumps || []);
  const res = await dialogs.openComponent<CreateForm | null>(CreateWorkspaceDialog, {
    initial: {
      ...initial,
      location: prefill.location ?? (config.config.default_workspace_location || "main"),
      newDb: true,
      existingDb: "", // the dialog preselects one
      cloneDb: "",
      restoreDump: "",
      activate: false,
      createVenv: prefill.createVenv ?? false,
    } satisfies CreateForm,
    blank: sourceValues({}, []),
    pickSource,
    loadSource,
    categories: config.config.workspace_categories_enabled ? categoryOptions(config) : null,
    ...(initialDumps ? { initialDumps } : {}),
  });
  if (!res) return;
  const tpl = tplOf(res.template);
  const checkouts = repoBranchList.parse(res.config.trim());
  // the source's branches that aren't local yet: fetched now, before anything is
  // created — a failure creates nothing
  const planned = checkouts
    .map((c) => ({ repo: c.repo, fetch: res.fetches[c.repo] }))
    .filter(
      (p): p is { repo: string; fetch: BranchFetch } =>
        !!p.fetch && checkouts.some((c) => c.repo === p.repo && c.branch === p.fetch.branch),
    );
  if (planned.length && !(await fetchPlanned(plugins, planned))) return;
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
  const forkRepos = new Set<string>();
  if (res.createBranches) {
    for (const c of checkouts) if (!hasLocalBranch(c.repo, c.branch)) forkRepos.add(c.repo);
  } else if (res.verifiedRepos) {
    const verifiedRepos = new Set(res.verifiedRepos);
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
    const created = await wt.createWorktree({
      name: res.name.trim(),
      dbName: (res.db || "").trim(),
      cloneSource: res.cloneDb || "",
      checkouts,
      startPointByRepo,
      baseId: tpl?.id || "",
      on_create_args: startArgs(res.addons, res.args),
      demo_data: !!res.demoData,
      favorite: false,
      category: res.category || "",
      parent: prefill.parent || "",
      createVenv: !!res.createVenv,
      forkRepos,
    });
    // createWorktree returns the new id, or false once it has reported a failure
    if (created && res.restoreDump) {
      await restoreRunbotDump(plugins, res.restoreDump, (res.db || "").trim());
    }
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
    on_create_args: startArgs(res.addons, res.args),
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
  if (res.restoreDump && ws.db) await restoreRunbotDump(plugins, res.restoreDump, ws.db);
  wt.select(ws.id);
}

// An existing sub-workspace already spawned from `parentWs` for this forward-port row
// (matched by parent + the row's branch — that pair is what a prior click of the
// button created). Exported so the button can label itself "Open" instead of
// "Create" and so a re-click jumps to the existing workspace instead of duplicating it.
// A forward-port sub-workspace checks out fw-bot's head branch, which is named
// `<target>-<source>-<n>-fw` (e.g. master-saas-19.4-…-fw) — not the matrix's bare
// target label (`row.branch` = "master"). So match a child of this parent whose
// checkout branch is a forward port onto this row's target.
export function findSubWorkspace<
  W extends Pick<WorkspaceConfig, "id"> & { parent?: string; checkouts?: CheckoutConfig[] },
>(
  config: { config: { workspaces?: W[] } },
  parentWs: { id: string },
  row: { branch: string },
): W | null {
  const isFwOnto = (branch: unknown) =>
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
export async function resolvePrBranches(
  plugins: Pick<WorkspacePlugins, "code" | "dialogs" | "eventLog">,
  targets: PrTarget[],
): Promise<ResolvedPrBranch[] | null> {
  const { code, dialogs, eventLog } = plugins;
  const results = await Promise.all(
    targets.map(async ({ repo, pull }) => {
      const eid = eventLog.begin(`fetching PR #${pull.number} (${repo.id})`);
      try {
        const head = await postJSON<{ branch?: string }>("/api/prs/head", {
          repo: pull.github,
          number: pull.number,
        });
        const branch = head.branch;
        if (!branch) throw new Error("could not resolve the PR's head branch");
        // fetched straight from pull.github (the PR's own repo) — not any
        // locally-configured remote, which has no guarantee of pointing at that
        // exact repo (a fork, a forward-port's canonical repo differing from a
        // company-fork checkout, a colleague's staging remote, ...).
        const r = await fetchPrHead(dialogs, {
          path: repo.path,
          github: pull.github,
          number: pull.number,
          branch,
        });
        if (!r.ok) throw new Error(r.error);
        eventLog.finish(eid, "done");
        return { repo, branch, ok: true as const };
      } catch (e) {
        eventLog.finish(eid, "error");
        return { repo, ok: false as const, error: errorMessage(e) };
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
  const got = results.filter((r): r is ResolvedPrBranch => r.ok);
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
export async function createSubWorkspaceFromForwardPort(
  plugins: WorkspacePlugins,
  parentWs: WorkspaceLike,
  row: ForwardPortRow,
): Promise<unknown> {
  const { config, dialogs, wt } = plugins;
  const existing = findSubWorkspace(config, parentWs, row);
  if (existing) {
    wt.select(existing.id);
    return;
  }
  // one {repo, pull} per cell that both maps to a configured repo and has a PR (a
  // "waiting" cell — no PR yet — is skipped)
  const targets: PrTarget[] = [];
  for (const cell of row.cells || []) {
    const repo = repoForGithub(config.config.repos || [], cell.repository);
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
export async function createWorkspaceFromPRs(
  plugins: WorkspacePlugins,
  targets: PrTarget[],
): Promise<void> {
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

// Category auto-created review workspaces are tagged with (config.auto_workspace_on_review).
// Not a reserved pseudo-category like ARCHIVED_CATEGORY — it only renders as its
// own group once the user also enables workspace_categories_enabled, same as any
// other category.
export const REVIEW_CATEGORY = "review";

// Headless counterpart to createWorkspaceFromPRs — no dialog, called automatically
// when a PR (and any sibling PR auto-discovered on the same branch) is added in the
// Reviews screen (see reviews.ts addPr/discoverSiblings, gated on
// config.auto_workspace_on_review), and also by the manual "Review" action
// (reviewGroup, reviews.ts). Always a worktree workspace, category "review",
// attaching the already-fetched branches (createBranches: false) — never activated
// (worktree workspaces never go through the main-checkout "activate" step) and
// never stealing the current UI selection (select: false).
// targets: [{repo, pull: {github, number}}], one per repo the task spans.
// Returns the workspace id (new or pre-existing) on success, or a falsy value on
// failure — callers use this both as a truthy check and to resolve the record.
export async function createReviewWorkspace(
  plugins: Pick<WorkspacePlugins, "config" | "code" | "dialogs" | "eventLog" | "wt">,
  targets: PrTarget[],
): Promise<string | false | null> {
  const { config } = plugins;
  if (!targets.length) return null;
  const findExisting = (name: string) =>
    (config.config.workspaces || []).find((w) => w.category === REVIEW_CATEGORY && w.name === name);
  // Any workspace at all (not just a review one) already checked out on this
  // branch — e.g. a regular workspace someone has open on it for other reasons.
  // Its worktree is exactly what git refuses to fetch into by ref name
  // ("refusing to fetch into branch ... checked out at ..."); backend
  // fetch_pr_head already falls back to a safe in-place update for that case
  // (sync_pr_worktree), so once resolvePrBranches succeeds below there's no
  // fetch left to do — just reuse it for the review instead of attempting a
  // second worktree for the same branch, which `git worktree add` would refuse
  // outright.
  const findExistingAny = (name: string) =>
    (config.config.workspaces || []).find((w) => w.name === name);
  // Resolve just the primary target's head branch first — a read-only lookup, no
  // fetch — so a review workspace already tracking this task can be reused WITHOUT
  // ever touching git. resolvePrBranches' fetchRemoteBranch would otherwise try to
  // re-fetch a branch that's already checked out in that very workspace's
  // worktree, which git refuses ("fatal: refusing to fetch into branch ... checked
  // out at ..."). Only reachable on a re-run (the manual "Review" action clicked
  // again, or the auto-hook firing a second time) — a brand-new task has nothing
  // to find here and just falls through to the full resolve below.
  try {
    const head = await postJSON<{ branch?: string }>("/api/prs/head", {
      repo: targets[0].pull.github,
      number: targets[0].pull.number,
    });
    const existingByHead = head.branch && findExisting(head.branch);
    if (existingByHead) return existingByHead.id;
  } catch {
    /* couldn't resolve cheaply — fall through to the full resolve, which reports
       any real failure itself */
  }
  const got = await resolvePrBranches(plugins, targets);
  if (!got) return null;
  const name = got[0].branch;
  // idempotent: a branch already added once (e.g. its first PR, before a sibling
  // showed up) keeps its original workspace rather than spawning a duplicate —
  // or, if it's not a review workspace at all, whatever workspace already has
  // this branch checked out (see findExistingAny above). Upgrade it into
  // REVIEW_CATEGORY so reviews.ts's category-scoped reviewWorkspaceFor can find
  // it — without this the review still runs (ClaudePlugin is keyed by workspace
  // id, not category) but the Reviews screen's spinner/score/panel can never
  // look it back up.
  if (!(config.config.workspace_categories || []).some((c) => c.id === REVIEW_CATEGORY)) {
    config.updateConfig({
      workspace_categories: [
        ...(config.config.workspace_categories || []),
        { id: REVIEW_CATEGORY },
      ],
    });
  }
  const existing = findExistingAny(name);
  if (existing) {
    if (existing.category !== REVIEW_CATEGORY)
      config.workspace(existing.id)?.setCategory(REVIEW_CATEGORY);
    return existing.id;
  }
  const checkouts = got.map((g) => ({ repo: g.repo.id, branch: g.branch }));
  const forkRepos = new Set<string>();
  const startPointByRepo: Record<string, string> = {};
  // Claude always needs a main-repo (community) checkout to run in (its cwd —
  // see ClaudePlugin._dirsFor) — a bundle-only PR (no sibling branch in the main
  // repo, e.g. an enterprise-only change) would otherwise leave the review
  // workspace without one. Can't just attach the stable series branch it derives
  // from (18.0-foo-aab → 18.0): that branch is almost always already checked out
  // in the main community checkout itself, and git worktree refuses to check out
  // a branch that's live in another worktree. Fork a same-named branch off it
  // instead — same fallback createWorkspaceFromPRs uses for a template-uncovered
  // repo.
  const mainRepoId = config.config.main_repo_id || "community";
  if (!checkouts.some((c) => c.repo === mainRepoId)) {
    const mainRepo = (config.config.repos || []).find((r) => r.id === mainRepoId && r.path);
    if (mainRepo) {
      checkouts.push({ repo: mainRepoId, branch: name });
      forkRepos.add(mainRepoId);
      startPointByRepo[mainRepoId] = baseBranchOf(name);
    }
  }
  return plugins.wt.createWorktree({
    name,
    dbName: name,
    cloneSource: "",
    checkouts,
    startPointByRepo,
    forkRepos,
    category: REVIEW_CATEGORY,
    select: false,
  });
}

// Fixed, non-editable safety preamble prepended to every Claude review run (auto or
// manual) — Claude already runs with --permission-mode bypassPermissions for every
// conversation in this app (full bash access, no confirmation gate — see
// ClaudeManager, backend/server.py), so this is the only guardrail keeping a review
// conversation read-only-ish. Not part of the user-editable review_prompt.md, so it
// can't be accidentally edited away.
const REVIEW_SAFETY_PREAMBLE = `You are running as an automated code review assistant with full local shell access and no confirmation prompts. Stay read-only with respect to anything outside the local checkout:
- Never run "git push", or anything that publishes local commits/branches to a remote.
- Never run "gh pr comment", "gh pr review", "gh pr merge", "gh pr close", "gh pr edit", "gh pr ready", or any other command that mutates a PR/issue/repo on GitHub.
- Never take any other network-mutating action.
- Freely read files, run tests/linters, and use local git (diff, log, blame, status) to understand the change.
Report your findings as a normal reply; do not act on them beyond this conversation.`;

// Fixed, non-editable — appended after the user's template so every review reports a
// parseable merge-readiness score (ClaudePlugin.reviewScore parses "Score: N/100" out
// of the conversation to drive the Reviews screen's score badge). Kept out of the
// editable review_prompt.md for the same reason as the safety preamble: the app
// depends on this exact format, so it can't be accidentally edited away.
const REVIEW_SCORE_INSTRUCTION = `Finally, on its own line at the very end of your reply, give your honest guess of this PR's merge readiness as a score out of 100, in exactly this format: "Score: N/100" — 0 meaning there's nothing good about it yet, 100 meaning it's perfect and absolutely ready to merge as-is. This is a rough guess of how much work remains, not a rule-based checklist.`;

// Run (or continue) a Claude review in an already-resolved review workspace: fetches
// the current review_prompt.md template fresh (edited rarely — no caching needed),
// substitutes {{branch}}/{{repos}}, sandwiches it between the fixed safety preamble
// and the fixed scoring instruction, and sends it exactly as a user typing into that
// workspace's own Claude tab would (ClaudePlugin.send) — the review IS that
// conversation, nothing else to wire up. `review: true` has the backend save the
// reply to disk (backend/server.py's ClaudeManager) so it's still there — in that
// same Claude tab — after a goo restart, unlike an ordinary chat turn.
// plugins: needs a `claude` key (ClaudePlugin) alongside the usual bundle.
export async function runClaudeReview(
  plugins: { claude: PluginInstance<typeof ClaudePlugin> },
  ws: WorkspaceLike & Pick<WorkspaceConfig, "name">,
): Promise<void> {
  const template = await fetchReviewPrompt();
  const repos = (ws.checkouts || []).map((c) => c.repo).join(", ");
  const prompt = `${REVIEW_SAFETY_PREAMBLE}\n\n${template}\n\n${REVIEW_SCORE_INSTRUCTION}`
    .replaceAll("{{branch}}", ws.name)
    .replaceAll("{{repos}}", repos);
  return plugins.claude.send(ws, prompt, { review: true });
}

// Adopt the current checkout: turn whatever is checked out in the main server
// repos (community/enterprise — the ones a workspace may launch) into a
// main-located workspace, one click, no form. The checkout already matches by
// construction, so "activating" is just recording it as the loaded workspace —
// no git, no dirty-tree guard (nothing gets checked out). If a workspace for
// these exact branches already exists, it is selected instead of duplicated.
export async function adoptCurrentCheckout(
  plugins: WorkspacePlugins & { server: PluginInstance<typeof ServerPlugin> },
): Promise<unknown> {
  const { config, dialogs, code, eventLog, wt, server } = plugins;
  const fail = (message: string) =>
    dialogs.open({ title: "Adopt current checkout", message, okLabel: "OK", cancelLabel: null });

  // fresh local git state, scoped to the server repos (no PR/runbot/mergebot)
  await code.loadBranches(new Set(["community", "enterprise"]));
  const byId = Object.fromEntries(code.branchRepos().map((r) => [r.id, r]));
  const checkouts: CheckoutConfig[] = [];
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
  const makeLoaded = async (ws: Pick<WorkspaceConfig, "id" | "name">): Promise<void> => {
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
  ws: WorkspaceLike,
  {
    config,
    code,
    db,
    eventLog,
    repoMap,
    isActive,
    dialogs,
    wt,
    server,
  }: WorkspacePlugins & {
    server: PluginInstance<typeof ServerPlugin>;
    // repo id -> its local branches by name (the Workspaces screen's repoMap)
    repoMap: Record<string, { branches: Map<string, BranchInfo> } | undefined>;
    isActive: boolean;
  },
): Promise<void> {
  if (isActive) return; // the loaded workspace cannot be deleted
  const descendants = descendantWorkspaces(config.config.workspaces || [], ws.id);
  const groups = code.groups();
  // deletable branches: present locally and not a base/primary branch
  const branches = (ws.checkouts || [])
    .map(({ repo, branch }) => ({ repo, branch, b: repoMap[repo]?.branches.get(branch) }))
    .filter((x): x is typeof x & { b: BranchInfo } => !!x.b && !BASE_BRANCH_RE.test(x.branch))
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
    .filter(
      (x): x is { pr: PullRequest; github: string } =>
        !!x.pr && x.pr.state === "open" && !!x.github,
    )
    .map((x) => ({ github: x.github, number: x.pr.number }));

  const fields: DialogField[] = [];
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
      value: false,
    });
  if (prs.length)
    fields.push({
      key: "closePrs",
      type: "checkbox",
      label: `Close ${prs.length === 1 ? "its open pull request" : `its ${prs.length} open pull requests`}`,
      value: false,
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
  const ops: Promise<unknown>[] = [];
  if (res.closePrs) for (const p of prs) ops.push(code.closePrNoConfirm(p.github, p.number));
  if (res.delBranches)
    for (const b of branches)
      ops.push(code.deleteBranchNoConfirm(b.branch, b.repo, b.path, !!res.delRemote && b.remote));
  if (res.dropDb && ws.db) ops.push(db.drop(ws.db));
  await Promise.all(ops);
  // cascade the sub-workspaces while the parent still exists: once it's gone, the
  // config's dangling-parent heal demotes its children to root
  const { skipped } = await cascadeRemoveDescendants({ config, wt, eventLog, server }, ws);
  config.updateConfig({
    workspaces: config.config.workspaces.filter((w) => w.id !== ws.id),
  });
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
