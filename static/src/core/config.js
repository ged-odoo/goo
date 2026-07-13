// app version — shown in the navbar. Keep in sync with package.json "version".
export const VERSION = "1.2.0";

// The single source of truth for all initial data. Anything edited in the
// Config tab is stored in localStorage (via ConfigPlugin) and overrides these
// values; "Reset to initial config" wipes those overrides to come back here.
export const DEFAULT_CONFIG = {
  work_dir: "/home/odoo/work",
  venv_activate: "", // optional; when set, prefixed before the start command (source … && odoo-bin)
  // path to the odoo-bin executable; goo cd's into the community checkout and runs
  // it. Empty = use <community-path>/odoo-bin. Worktree servers always run their own.
  server_path: "/home/odoo/work/community/odoo-bin",
  // where per-target git worktrees are created: <worktree_dir>/<slug>/<repo>
  worktree_dir: "/home/odoo/work-trees",
  db_user: "odoo",
  db_password: "odoo",
  // Odoo's filestore root; a db's attachments live in <filestore>/<dbname>. goo
  // keeps it in lockstep with the db on drop/rename/clone. Empty = leave it alone.
  filestore: "/home/odoo/.local/share/Odoo/filestore/",
  editor: "code", // command used by the "Open with editor" actions
  auto_open_event_log: false, // open the event log overlay when new events arrive
  // launch Odoo with RUST_BUNDLER=1 so the rust_bundler addon uses Goo's in-tree
  // native extension (installed explicitly from the Configuration screen)
  rust_bundler: false,
  // automatic goo self-update check (git fetch of origin/master at startup +
  // hourly, driving the navbar badge). The manual check button always works.
  update_check: true,
  repos: [
    {
      id: "community",
      path: "/home/odoo/work/community",
      github: "odoo/odoo",
      pull_remote: "origin",
      push_remote: "dev",
      favorite: true,
    },
    {
      id: "enterprise",
      path: "/home/odoo/work/enterprise",
      github: "odoo/enterprise",
      pull_remote: "origin",
      push_remote: "dev",
      favorite: true,
    },
  ],
  // First-class targets — what you actually work with. This is just the initial
  // set; each carries a stable `id` (used internally so renaming `name` is safe),
  // its checkout list (repo:branch pairs), a `kind`, database, args and favorite flag.
  targets: [
    {
      id: "master",
      name: "master",
      favorite: true,
      kind: "plain",
      checkouts: [{ repo: "community", branch: "master" }],
      db: "master",
      on_create_args: "-i sale_management",
    },
    {
      id: "master-e",
      name: "master(e)",
      favorite: false,
      kind: "plain",
      checkouts: [
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
      kind: "plain",
      checkouts: [{ repo: "community", branch: "19.0" }],
      db: "19.0",
      on_create_args: "-i sale_management",
    },
    {
      id: "19.0-e",
      name: "19.0(e)",
      favorite: false,
      kind: "plain",
      checkouts: [
        { repo: "community", branch: "19.0" },
        { repo: "enterprise", branch: "19.0" },
      ],
      db: "19.0-e",
      on_create_args: "-i sale_management",
    },
  ],
  // Workspaces + templates — the successors of targets (see the workspaces roadmap).
  // Both MUST default empty: a stored legacy config has no `workspaces` key, and the
  // one-time targets→workspaces migration only triggers on an empty list (a non-empty
  // default merged in at read would defeat it). On a fresh boot the migration derives
  // them from the default `targets` above.
  workspaces: [],
  templates: [],
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
  "workspaces",
  "branches",
  "prs",
  "reviews",
  "todo",
  "databases",
  "nightly",
  "memory",
  "config",
];
export const RUNBOT = "https://runbot.odoo.com";
export const MERGEBOT = "https://mergebot.odoo.com";
export const BASE_BRANCH_RE = /^(master|\d+\.\d+|saas-\d+\.\d+)$/;
