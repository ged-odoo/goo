// app version — shown in the navbar. Keep in sync with package.json "version".
export const VERSION = "1.1.0";

// The single source of truth for all initial data. Anything edited in the
// Config tab is stored in localStorage (via ConfigPlugin) and overrides these
// values; "Reset to initial config" wipes those overrides to come back here.
export const DEFAULT_CONFIG = {
  work_dir: "/home/odoo/work",
  venv_activate: "", // optional; when set, prefixed before the start command (source … && odoo-bin)
  start_cmd: "cd /home/odoo/work/community && ./odoo-bin",
  db_user: "odoo",
  db_password: "odoo",
  // Odoo's filestore root; a db's attachments live in <filestore>/<dbname>. goo
  // keeps it in lockstep with the db on drop/rename/clone. Empty = leave it alone.
  filestore: "/home/odoo/.local/share/Odoo/filestore/",
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
  // test-tag presets offered in the Tests tab's selector (editable in the
  // Configuration tab). Each is { tags: "<--test-tags value>" }.
  test_presets: [{ tags: "/web:WebSuite[@web]" }],
  // navbar links (editable in the Config tab). /odoo + /web/tests go through the
  // autologin addon (?to=<url-encoded target>) and only work while the server is up.
  links: [
    { label: "/odoo", href: "http://localhost:8069/dev/autologin?to=%2Fodoo%3Fdebug%3Dassets" },
    {
      label: "/web/tests",
      href: "http://localhost:8069/dev/autologin?to=%2Fweb%2Ftests%3Fdebug%3Dassets%26timeout%3D500000%26manual%3Dtrue",
    },
  ],
};

export const SECTIONS = [
  "dashboard",
  "server",
  "branches",
  "prs",
  "reviews",
  "tests",
  "assets",
  "addons",
  "databases",
  "targets",
  "config",
];
export const RUNBOT = "https://runbot.odoo.com";
export const MERGEBOT = "https://mergebot.odoo.com";
export const BASE_BRANCH_RE = /^(master|\d+\.\d+|saas-\d+\.\d+)$/;
