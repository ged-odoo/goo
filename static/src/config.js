// app version — shown in the navbar. Keep in sync with package.json "version".
export const VERSION = "1.0.0";

// The single source of truth for all initial data. Anything edited in the
// Config tab is stored in localStorage (via ConfigPlugin) and overrides these
// values; "Reset to initial config" wipes those overrides to come back here.
export const DEFAULT_CONFIG = {
  work_dir: "/home/odoo/work",
  venv_activate: "source /home/odoo/work/env20/bin/activate",
  start_cmd: "cd /home/odoo/work/community && ./odoo-bin",
  db_user: "odoo",
  db_password: "odoo",
  editor: "code", // command used by the dashboard's "Open with editor" action
  auto_open_event_log: false, // open the event log overlay when new events arrive
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
  // set; each carries a stable `id` (used internally so renaming `name` is safe),
  // its own config (repo:branch pairs), database, args and favorite flag.
  targets: [
    {
      id: "master",
      name: "master",
      favorite: true,
      config: [{ repo: "community", branch: "master" }],
      db: "master",
      on_create_args: "-i sale_management",
    },
    {
      id: "master-e",
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
      id: "19.0",
      name: "19.0",
      favorite: false,
      config: [{ repo: "community", branch: "19.0" }],
      db: "19.0",
      on_create_args: "-i sale_management",
    },
    {
      id: "19.0-e",
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
  // navbar links (editable in the Config tab). /odoo + /web/tests go through the
  // autologin addon (?to=<url-encoded target>) and only work while the server is up.
  links: [
    { label: "/odoo", href: "http://localhost:8069/dev/autologin?to=%2Fodoo%3Fdebug%3Dassets" },
    {
      label: "/web/tests",
      href: "http://localhost:8069/dev/autologin?to=%2Fweb%2Ftests%3Fdebug%3Dassets%26timeout%3D500000%26manual%3Dtrue",
    },
    { label: "owl docs", href: "https://odoo.github.io/owl/documentation/v3/owl/" },
    { label: "owl playground", href: "https://odoo.github.io/owl/playground/" },
    { label: "owl github", href: "https://github.com/odoo/owl" },
    { label: "runbot", href: "https://runbot.odoo.com" },
    { label: "mergebot", href: "https://mergebot.odoo.com" },
  ],
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
