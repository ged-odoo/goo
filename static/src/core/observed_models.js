// The observed family as owl-orm models — read-only snapshots of external systems
// (git branches, GitHub PRs, runbot, mergebot) the backend fetches + caches. Second
// state conversion of the ORM rewrite: StorePlugin holds these as records instead of
// plain Maps, but keeps its accessors (repoStatusList / prReposList / mergebot /
// mbDetails / runbot) and the step-4 merge semantics, so CodePlugin is unchanged.
// Nested collections (a repo's branches, a repo's PRs) are json fields
// here for exact-shape fidelity + zero regression risk; promoting Branch / PullRequest
// to their own models (so branchGroups becomes a computed over records) rides the
// later generic-components pass.

import { Model, ORM, fields } from "../../../vendor/owl-orm/index.ts";

export { ORM };

export class RepoStatus extends Model {
  static id = "repostatus"; // id = repo id ("community")
  current = fields.char(); // the checked-out branch
  dirty = fields.bool();
  error = fields.json(); // null | string
  branches = fields.json(); // [{ name, date, runbot, remote, synced, subject }, …]
  pushGithub = fields.json(); // "owner/repo" the push remote's URL resolves to, or null
  ahead = fields.number(); // current branch commits not on its base (target) branch
  behind = fields.number(); // base branch commits not on the current branch
  fetchedAt = fields.number(); // request-start stamp — the step-4 "latest wins" key
}

// A worktree workspace's OWN branch state — same shape as RepoStatus, fetched
// at the worktree's own on-disk directory instead of the main checkout, and
// kept in this SEPARATE table (never repoStatusList()/branchRepos()) so it can
// never leak into the Branches & PRs screen or workspace-list badges, which
// must keep reflecting the main checkout. id = "<workspaceId>:<repoId>".
export class WorktreeRepoStatus extends Model {
  static id = "worktreerepostatus";
  current = fields.char();
  dirty = fields.bool();
  error = fields.json();
  branches = fields.json();
  pushGithub = fields.json();
  ahead = fields.number();
  behind = fields.number();
  fetchedAt = fields.number();
}

export class PrRepo extends Model {
  static id = "prrepo"; // id = repo id
  github = fields.char();
  error = fields.json();
  prs = fields.json(); // [PullRequest, …] (normalized, see models.js)
  fetchedAt = fields.number();
}

export class MergebotStatus extends Model {
  static id = "mergebot"; // id = "github#number"
  state = fields.char(); // "" | "merged" | blocked reason
  detail = fields.json(); // blocked-reason detail (string) | null
  forwardPorts = fields.json(); // subsequent mergebot matrix rows | null (not fetched)
}

export class RunbotStatus extends Model {
  static id = "runbot"; // id = branch name
  status = fields.json(); // runbot status value
}
