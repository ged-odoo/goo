// The wire contract mirrored client-side — the one place a server response is
// folded into a canonical client object. Backend dataclasses (backend/models.py)
// define the field names; these normalizers consume exactly those (snake_case on
// the wire) and expose the camelCase properties the components read.

// canonical identities
export const prKey = (github: string, number: number): string => `${github}#${number}`;
export const branchKey = (repo: string, name: string): string => `${repo}:${name}`;

// a PR's CI status rollup (backend CiRollup); authored PRs only
export interface CiCheck {
  context: string;
  state: string; // success | failure | pending | ""
  url: string;
}

export interface CiRollup {
  overall: string; // failure if any failed, else pending, else success, else ""
  runbot: string; // the ci/runbot context's state
  checks: CiCheck[];
}

// a PR as the backend sends it (backend PullRequest dataclass, snake_case)
export interface PullRequestWire {
  github?: string;
  number: number;
  title?: string;
  url?: string;
  state?: string;
  draft?: boolean;
  branch?: string;
  relation?: string;
  created_at?: string;
  updated_at?: string;
  ci?: CiRollup | null;
}

// the normalized client-side PR (PullRequest.from)
export interface PullRequest {
  github: string;
  number: number;
  title: string;
  url: string;
  state: string; // open | closed | merged
  draft: boolean;
  branch: string;
  relation: string; // authored | head
  createdAt: string;
  updatedAt: string;
  ci: CiRollup | null;
  key: string; // prKey(github, number)
}

// A pull request, normalized from either source (`/api/prs` authored,
// `/api/prs/for-branches` head lookups) into one shape. Both wire shapes are
// already unified server-side (see GitHubService); this maps snake_case → the
// camelCase props the UI reads and attaches the canonical `key`.
export const PullRequest = {
  from(raw: PullRequestWire): PullRequest {
    return {
      github: raw.github || "",
      number: raw.number,
      title: raw.title || "",
      url: raw.url || "",
      state: (raw.state || "").toLowerCase(), // open | closed | merged
      draft: !!raw.draft,
      branch: raw.branch || "",
      relation: raw.relation || "", // authored | head
      createdAt: raw.created_at || "",
      updatedAt: raw.updated_at || "",
      ci: raw.ci || null,
      key: prKey(raw.github || "", raw.number),
    };
  },
};
