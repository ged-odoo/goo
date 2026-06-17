// Default configuration. Anything edited in the Config tab is stored in
// localStorage (via ConfigPlugin) and overrides these values.
export const DEFAULT_CONFIG = {
  work_dir: "/home/odoo/work",
  venv_activate: "source /home/odoo/work/env20/bin/activate",
  db_user: "odoo",
  db_password: "odoo",
  repos: [
    { id: "community", path: "/home/odoo/work/community", github: "odoo/odoo", favorite: true },
    {
      id: "enterprise",
      path: "/home/odoo/work/enterprise",
      github: "odoo/enterprise",
      favorite: true,
    },
    { id: "tutorials", path: "/home/odoo/work/tutorials", github: "odoo/tutorials" },
  ],
  // First-class targets — what you actually work with. This is just the initial
  // set; each carries its own config (repo:branch pairs), database, args and
  // favorite flag, and new ones can be created from any existing one.
  targets: [
    {
      name: "master",
      favorite: true,
      config: [{ repo: "community", branch: "master" }],
      db: "master",
      on_create_args: "-i sale_management",
    },
    {
      name: "master(e)",
      favorite: false,
      config: [
        { repo: "community", branch: "master" },
        { repo: "enterprise", branch: "master" },
      ],
      db: "master-e",
      on_create_args: "-i sale_management",
    },
    {
      name: "19.0",
      favorite: false,
      config: [{ repo: "community", branch: "19.0" }],
      db: "19.0",
      on_create_args: "-i sale_management",
    },
    {
      name: "19.0(e)",
      favorite: false,
      config: [
        { repo: "community", branch: "19.0" },
        { repo: "enterprise", branch: "19.0" },
      ],
      db: "19.0-e",
      on_create_args: "-i sale_management",
    },
  ],
  start: {
    repos: ["community"],
    db: "test_db",
    on_create_args: "-i sale_management",
    other_args: "--dev all",
  },
};

export const SECTIONS = [
  "dashboard",
  "server",
  "branches",
  "prs",
  "tests",
  "addons",
  "databases",
  "targets",
  "config",
];
export const RUNBOT = "https://runbot.odoo.com";
export const MERGEBOT = "https://mergebot.odoo.com";
export const BASE_BRANCH_RE = /^(master|\d+\.\d+|saas-\d+\.\d+)$/;
export const CACHE_TTL = 10 * 60 * 1000;
