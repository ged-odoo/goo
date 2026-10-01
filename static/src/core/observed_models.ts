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
import type { Signal } from "@odoo/owl";
import type { PullRequest, PullRequestWire } from "./models.ts";

// one local branch of a repo (backend GitService.branches)
export interface BranchInfo {
  name: string;
  date: string; // last commit date, ISO
  subject: string;
  sha: string;
  remote: boolean; // a same-named remote-tracking ref exists
  synced: boolean; // the local tip is what's on the remote
}

// one repo's branch state as /api/branches sends it (snake_case); `fetchedAt` is
// stamped client-side (the request-start time) when the caller has one
export interface RepoStatusWire {
  id: string;
  current?: string | null; // the checked-out branch, "(detached)", or null on error
  dirty?: boolean;
  head_subject?: string;
  head_date?: string;
  head_sha?: string;
  head_pushed?: boolean;
  head_remote?: boolean;
  ahead?: number;
  behind?: number;
  branches?: BranchInfo[];
  push_github?: string | null;
  error?: string | null;
  fetchedAt?: number;
}

// a RepoStatus / WorktreeRepoStatus record as StorePlugin hands it out
export interface RepoState {
  current: string;
  dirty: boolean;
  error: string | null;
  branches: BranchInfo[];
  pushGithub: string | null;
  ahead: number;
  behind: number;
  fetchedAt: number;
}

// one row of a merged PR's mergebot forward-port matrix (backend MergebotService):
// a later branch, with the PRs each repository has there
export interface ForwardPortPull {
  github: string;
  number: number;
  status: string;
  detail: string;
  category: string; // success | warning | danger | pending
}

export interface ForwardPortRow {
  branch: string;
  cells: { repository: string; pulls: ForwardPortPull[] }[];
}

// a branch's scraped runbot bundle status (backend RunbotService.statuses)
export interface RunbotBranchStatus {
  result: string;
  running: boolean;
  url: string;
}

// one repo's PR list as /api/prs sends it
export interface PrRepoWire {
  id: string;
  github?: string;
  error?: string | null;
  prs?: PullRequestWire[];
  fetchedAt?: number;
}

// the same, its PRs normalized (PullRequest.from) — what StorePlugin.mergePrRepos takes
export type PrRepoInput = Omit<PrRepoWire, "prs"> & { prs?: PullRequest[] };

export { ORM };

export class RepoStatus extends Model {
  static id = "repostatus"; // id = repo id ("community")
  current = fields.char(); // the checked-out branch
  dirty = fields.bool();
  error: Signal<string | null> = fields.json();
  branches: Signal<BranchInfo[]> = fields.json();
  pushGithub: Signal<string | null> = fields.json(); // "owner/repo" the push remote's URL resolves to, or null
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
  error: Signal<string | null> = fields.json();
  branches: Signal<BranchInfo[]> = fields.json();
  pushGithub: Signal<string | null> = fields.json();
  ahead = fields.number();
  behind = fields.number();
  fetchedAt = fields.number();
}

export class PrRepo extends Model {
  static id = "prrepo"; // id = repo id
  github = fields.char();
  error: Signal<string | null> = fields.json();
  prs: Signal<PullRequest[]> = fields.json(); // normalized, see models.ts
  fetchedAt = fields.number();
}

export class MergebotStatus extends Model {
  static id = "mergebot"; // id = "github#number"
  state = fields.char(); // "" | "merged" | blocked reason
  detail: Signal<string | null> = fields.json(); // blocked-reason detail
  forwardPorts: Signal<ForwardPortRow[] | null> = fields.json(); // subsequent mergebot matrix rows | null (not fetched)
}

export class RunbotStatus extends Model {
  static id = "runbot"; // id = branch name
  status: Signal<RunbotBranchStatus> = fields.json(); // runbot status value
}
