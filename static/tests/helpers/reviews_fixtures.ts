// A realistic Reviews-screen backend: four tracked PRs in three tasks.
//   18.0-task-x  odoo/odoo#1 (open, to review) + odoo/enterprise#2 (open, reviewed)
//   17.0-fix-y   odoo/odoo#3 (merged by mergebot, one forward port: odoo/odoo#30 open)
//   ext-branch   other/lib#4 (open, r+'d, repo not configured locally)
import type { Route } from "./app.ts";
import type { ReviewEntry } from "../../src/core/config.ts";

export const REVIEWS: ReviewEntry[] = [
  { id: "odoo/odoo#1", github: "odoo/odoo", number: 1 },
  { id: "odoo/enterprise#2", github: "odoo/enterprise", number: 2 },
  { id: "odoo/odoo#3", github: "odoo/odoo", number: 3, important: true },
  { id: "other/lib#4", github: "other/lib", number: 4 },
];

export const prWire = (github: string, number: number, branch: string, extra = {}) => ({
  github,
  number,
  branch,
  title: `Title ${number}`,
  url: `https://github.com/${github}/pull/${number}`,
  state: "open",
  draft: false,
  ...extra,
});

export const PR_INFO = {
  prs: [
    prWire("odoo/odoo", 1, "18.0-task-x"),
    prWire("odoo/enterprise", 2, "18.0-task-x", { draft: true }),
    prWire("odoo/odoo", 3, "17.0-fix-y", { state: "closed" }),
    prWire("other/lib", 4, "ext-branch"),
  ],
};

export const REVIEW_STATUS = {
  statuses: {
    "odoo/odoo#1": "to_review",
    "odoo/enterprise#2": "reviewed",
    "odoo/odoo#3": "reviewed",
    "other/lib#4": "to_review",
    "odoo/odoo#30": "to_review",
  },
};

export const FW_PORTS = {
  "odoo/odoo#3": [
    {
      branch: "18.0",
      cells: [
        {
          repository: "odoo/odoo",
          pulls: [{ github: "odoo/odoo", number: 30, status: "", detail: "", category: "pending" }],
        },
      ],
    },
    { branch: "saas-18.1", cells: [{ repository: "odoo/odoo", pulls: [] }] },
  ],
};

export const MERGEBOT = {
  states: { "odoo/odoo#3": "merged", "other/lib#4": "ready", "odoo/odoo#30": "blocked" },
  details: { "odoo/odoo#30": "Review" },
  forward_ports: FW_PORTS,
};

// like the backend, each route answers only for the PRs it was asked about
type Asked = { prs?: { github: string; number: number }[] } | undefined;
const askedKeys = (body: unknown): Set<string> =>
  new Set(((body as Asked)?.prs || []).map((p) => `${p.github}#${p.number}`));
const pick = <T>(rec: Record<string, T>, keys: Set<string>): Record<string, T> =>
  Object.fromEntries(Object.entries(rec).filter(([k]) => keys.has(k)));

export const mergebotRoute =
  (mb: typeof MERGEBOT = MERGEBOT) =>
  (body: unknown) => {
    const keys = askedKeys(body);
    return {
      states: pick(mb.states, keys),
      details: pick(mb.details, keys),
      forward_ports: pick(mb.forward_ports, keys),
    };
  };

export const REVIEW_ROUTES: Record<string, Route> = {
  "/api/prs/info": (body: unknown) => {
    const keys = askedKeys(body);
    return { prs: PR_INFO.prs.filter((p) => keys.has(`${p.github}#${p.number}`)) };
  },
  "/api/prs/review-status": (body: unknown) => ({
    statuses: pick(REVIEW_STATUS.statuses, askedKeys(body)),
  }),
  "/api/mergebot": mergebotRoute(),
  "/api/runbot": { states: {} },
  "/api/workspace/claude/history": { items: [], state: "idle" },
};
