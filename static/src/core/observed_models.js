// The observed family as owl-orm models — read-only snapshots of external systems
// (git branches, GitHub PRs, runbot, mergebot) the backend fetches + caches. Second
// state conversion of the ORM rewrite: StorePlugin holds these as records instead of
// plain Maps, but keeps its accessors (repoStatusList / prReposList / mergebot /
// mbDetails / runbot) and the step-4 merge semantics, so CodePlugin and ReviewPlugin
// are unchanged. Nested collections (a repo's branches, a repo's PRs) are json fields
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
  fetchedAt = fields.number(); // request-start stamp — the step-4 "latest wins" key
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

export const OBSERVED_MODELS = [RepoStatus, PrRepo, MergebotStatus, RunbotStatus];
