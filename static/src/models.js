// The wire contract mirrored client-side — the one place a server response is
// folded into a canonical client object. Backend dataclasses (backend/models.py)
// define the field names; these normalizers consume exactly those (snake_case on
// the wire) and expose the camelCase properties the components read.

// canonical identities
export const prKey = (github, number) => `${github}#${number}`;
export const branchKey = (repo, name) => `${repo}:${name}`;

// A pull request, normalized from either source (`/api/prs` authored,
// `/api/reviews` reviewed) into one shape. Both wire shapes are already unified
// server-side (see GitHubService); this maps snake_case → the camelCase props the
// UI reads and attaches the canonical `key`.
export const PullRequest = {
  from(raw) {
    return {
      github: raw.github || "",
      number: raw.number,
      title: raw.title || "",
      url: raw.url || "",
      state: (raw.state || "").toLowerCase(), // open | closed | merged
      draft: !!raw.draft,
      branch: raw.branch || "",
      relation: raw.relation || "", // authored | reviewed
      createdAt: raw.created_at || "",
      updatedAt: raw.updated_at || "",
      ci: raw.ci || null,
      key: prKey(raw.github || "", raw.number),
    };
  },
};
