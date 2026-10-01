// app version — shown in the navbar. Keep in sync with package.json "version".
export const VERSION = "1.2.0";

// ── the config blob's shape (the persisted `config`, see ConfigPlugin) ──────────

// a git checkout a workspace/template pins: one branch of one configured repo
export interface CheckoutConfig {
  repo: string;
  branch: string;
}

export interface RepoConfig {
  id: string;
  path: string;
  github: string;
  pull_remote: string;
  push_remote: string;
  favorite: boolean;
  external?: boolean; // not on mergebot/runbot — those scrapes are skipped
  autoreload?: boolean;
}

// a worktree workspace's own checkout: `dir` is frozen at creation, `venv` set once
// its dedicated venv was built
export interface WorktreeInfo {
  base?: string;
  dir?: string;
  venv?: boolean;
}

export interface WorkspaceConfig {
  id: string;
  name: string;
  created_at: string; // ISO timestamp
  last_activity: string; // ISO timestamp
  favorite: boolean;
  category: string; // a workspace_categories id ("" = uncategorized)
  parent: string; // the id of the workspace this one was spawned from ("" = root)
  notes: string;
  db: string;
  on_create_args: string;
  demo_data: boolean;
  location: string; // "main" | "worktree"
  worktree: WorktreeInfo | null;
  port: number | null; // stable server port (worktree only; null = none)
  checkouts: CheckoutConfig[];
}

export interface TemplateConfig {
  id: string;
  name: string;
  db: string;
  on_create_args: string;
  demo_data: boolean;
  category: string;
  checkouts: CheckoutConfig[];
}

// a pre-workspace stored target, as old configs/presets carry it (migration input only)
export interface LegacyTarget {
  id?: string;
  name?: string;
  favorite?: boolean;
  kind?: string; // "plain" | "worktree"
  checkouts?: CheckoutConfig[];
  config?: CheckoutConfig[]; // the checkout list's even older name
  db?: string;
  on_create_args?: string;
  demo_data?: boolean;
  worktree?: WorktreeInfo | null;
  created_at?: string;
  last_activity?: string;
}

// a version → image row (launch_mode "docker")
export interface DockerImage {
  id: string;
  label?: string;
  versions?: string[]; // branch prefixes, first match wins
  dockerfile_path?: string;
  image?: string;
  is_default?: boolean;
}

// a navbar link, or a dropdown of them
export interface NavLink {
  label: string;
  href?: string;
  children?: NavLink[];
}

export interface TabConfig {
  id: string;
  visible?: boolean; // absent in some stored configs
}

// a PR tracked for review: id = "<github>#<number>"
export interface ReviewEntry {
  id: string;
  github: string;
  number: number;
  important?: boolean;
}

export interface StartConfig {
  repos?: string[];
  db?: string;
  on_create_args?: string;
  other_args?: string;
}

export interface Config {
  work_dir: string;
  venv_activate: string;
  server_path: string;
  worktree_dir: string;
  main_repo_id: string;
  db_user: string;
  db_password: string;
  db_host: string;
  db_port: string;
  filestore: string;
  log_level: string;
  editor: string;
  auto_open_event_log: boolean;
  launch_mode: string; // "local" | "docker" | "external"
  docker_network: string;
  docker_postgres_image: string;
  docker_postgres_container: string;
  docker_postgres_port: string;
  docker_postgres_volume: string;
  docker_nginx_image: string;
  docker_nginx_container: string;
  docker_nginx_port: string;
  docker_mount_path: string;
  docker_filestore_mount: string;
  docker_container_user: string;
  docker_extra_run_args: string;
  docker_headed_browser: boolean;
  docker_images: DockerImage[];
  autologin_links: boolean;
  cleanup_enabled: boolean;
  auto_workspace_on_review: boolean;
  auto_claude_review: boolean;
  default_workspace_location: string; // "main" | "worktree"
  rust_bundler: boolean;
  update_check: boolean;
  workspace_categories_enabled: boolean;
  workspace_categories: { id: string }[];
  repos: RepoConfig[];
  targets?: LegacyTarget[]; // legacy, consumed by the targets→workspaces migration
  workspaces: WorkspaceConfig[];
  templates: TemplateConfig[];
  reviews: ReviewEntry[];
  start: StartConfig;
  test_presets: { tags: string }[];
  links: NavLink[];
  tabs?: TabConfig[];
}

// what the config entry points accept — a stored/broadcast/imported blob, an
// updateConfig patch: any key may be absent, and collection items only need their id
// (every missing field gets its default when it lands on a record)
export type RepoInput = Partial<RepoConfig> & { id: string };
export type WorkspaceInput = Partial<WorkspaceConfig> & { id: string };
export type TemplateInput = Partial<TemplateConfig> & { id: string };
export type ConfigInput = Partial<Omit<Config, "repos" | "workspaces" | "templates">> & {
  repos?: RepoInput[];
  workspaces?: WorkspaceInput[];
  templates?: TemplateInput[];
  hide_start_controls?: boolean; // pre-launch_mode boolean, a migration input only
};

// the app-recorded `state` blob
export interface AppStateBlob {
  active_workspace: string;
  claude_model: string;
  test_history: string[];
}

// a state blob as stored/broadcast: any key may be absent; `active_target` is the
// pre-workspace name of active_workspace (a migration input only)
export type StateInput = Partial<AppStateBlob> & { active_target?: string };

// The single source of truth for all initial data. Anything edited in the
// Config tab is stored in localStorage (via ConfigPlugin) and overrides these
// values; "Reset to initial config" wipes those overrides to come back here.
export const DEFAULT_CONFIG: Config = {
  work_dir: "/home/odoo/work",
  venv_activate: "", // optional; when set, prefixed before the start command (source … && odoo-bin)
  // path to the odoo-bin executable; goo cd's into the community checkout and runs
  // it. Empty = use <community-path>/odoo-bin. Worktree servers always run their own.
  server_path: "/home/odoo/work/community/odoo-bin",
  // where per-target git worktrees are created: <worktree_dir>/<slug>/<repo>
  worktree_dir: "/home/odoo/work-trees",
  // the repo id that holds odoo-bin — override if your checkouts don't use
  // goo's default "community"/"enterprise" naming
  main_repo_id: "community",
  db_user: "odoo",
  db_password: "odoo",
  // empty = connect over the local unix socket (unchanged default behavior);
  // set both when Postgres is only reachable over TCP (e.g. running in Docker)
  db_host: "",
  db_port: "",
  // Odoo's filestore root; a db's attachments live in <filestore>/<dbname>. goo
  // keeps it in lockstep with the db on drop/rename/clone. Empty = leave it alone.
  filestore: "/home/odoo/.local/share/Odoo/filestore/",
  // odoo-bin's --log-level, applied to every launch (server, test, install,
  // upgrade). Empty = odoo's own default (info) — unchanged behavior for
  // anyone who hasn't set this.
  log_level: "",
  editor: "code", // command used by the "Open with editor" actions
  auto_open_event_log: false, // open the event log overlay when new events arrive
  // how goo launches Odoo: "local" (a plain odoo-bin subprocess, the fields
  // above), "docker" (goo runs the container itself — see the docker_* fields
  // below), or "external" (goo neither launches nor stops Odoo — the Start/Stop
  // controls, port display, Terminal tab and Server-logs tab all stay hidden;
  // a passive status check only, for people who launch their servers by hand)
  launch_mode: "local",
  // ── docker_*: only read when launch_mode is "docker" ──────────────────────
  docker_network: "goo_odoo", // the Docker network every goo-managed container joins
  docker_postgres_image: "postgres:16",
  docker_postgres_container: "goo-postgres", // also the DNS name odoo containers use as --db_host
  docker_postgres_port: "5433", // host-published (not 5432, to avoid clashing with a local install)
  docker_postgres_volume: "goo-postgres-data", // a named volume, not a bind mount
  docker_nginx_image: "nginx:alpine",
  docker_nginx_container: "goo-nginx",
  docker_nginx_port: "80", // host-published; each container gets <slug>.localhost via nginx
  docker_mount_path: "/src", // in-container mount point for the worktree
  docker_filestore_mount: "/home/odoo_user/.local/share/Odoo/filestore",
  docker_container_user: "", // optional --user passthrough
  docker_extra_run_args: "", // optional raw passthrough appended to `docker run`
  // off by default: forwards the host's X11 display into the container (+ a
  // larger --shm-size and --privileged, both Chrome needs for tour/browser_js
  // tests) so a headed browser (watch=True, a debugged tour) renders directly
  // on the host desktop — no VNC. Only meaningful with a real X server to
  // forward (a headless CI-style host gets no benefit from turning this on).
  docker_headed_browser: false,
  // version → image mapping: [{id, label, versions: [prefixes], dockerfile_path?,
  // image?, is_default}] — the workspace's main-repo branch is matched against
  // each row's `versions` prefixes (first match wins), else the is_default row
  docker_images: [],
  // the /odoo and /web/tests buttons go through goo's own dev-only autologin
  // route by default (see addons/autologin) -- turn off to link the plain
  // path instead, for people who'd rather log in themselves (e.g. that addon
  // isn't installed, or just a preference)
  autologin_links: true,
  // off by default: automatically delete a worktree workspace once every
  // checkout with a PR shows it merged (and nothing is dirty/unpushed) — once
  // a day (see backend/cleanup.py). Opt-in since it deletes things on its own.
  cleanup_enabled: false,
  // off by default: when a PR is added in the Reviews screen, auto-create a
  // worktree workspace for it (and any sibling PR auto-discovered on the same
  // branch), in its own "review" category, without activating it.
  auto_workspace_on_review: false,
  // off by default, nested under auto_workspace_on_review: also auto-run a
  // Claude review in the freshly-created review workspace, using the
  // review_prompt.md template (edited in the Configuration screen). The manual
  // "Review" action in the Reviews screen works regardless of this setting.
  auto_claude_review: false,
  // the create-workspace dialog's Location field default: "main" (one loaded
  // at a time) or "worktree" (its own checkout, runs concurrently). Only the
  // dialog's own initial value — never overwrites what the user picks there.
  default_workspace_location: "main",
  // launch Odoo with RUST_BUNDLER=1 so the rust_bundler addon uses Goo's in-tree
  // native extension (installed explicitly from the Configuration screen)
  rust_bundler: false,
  // automatic goo self-update check (git fetch of origin/master at startup +
  // hourly, driving the navbar badge). The manual check button always works.
  update_check: true,
  // workspace categories: when enabled, the Workspaces list groups workspaces
  // under collapsible per-category headers (in this order); each workspace may
  // carry a `category` naming one of these ids
  workspace_categories_enabled: false,
  workspace_categories: [{ id: "dev" }, { id: "base" }],
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
  // PRs tracked for review — someone else's PR you need to review/r+/follow up
  // on until merged. Each entry is { id: "<github>#<number>", github, number }.
  reviews: [],
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
  "review-queue",
  "todo",
  "databases",
  "nightly",
  "memory",
  "ci",
  "config",
];
export const MERGEBOT = "https://mergebot.odoo.com";
export const BASE_BRANCH_RE = /^(master|\d+\.\d+|saas-\d+\.\d+)$/;

// the reserved workspace category: archived workspaces group here, always rendered
// as the LAST list group (even when categories are disabled). Not part of the
// configurable workspace_categories order.
export const ARCHIVED_CATEGORY = "archived";

// the canonical base branch a work branch's name derives from: 16.0-owl-fix →
// 16.0, saas-19.4-x → saas-19.4, anything else → master
export function baseBranchOf(branch: string): string {
  return (/^(saas-\d+\.\d+|\d+\.\d+|master)/.exec(branch) || ["", "master"])[1];
}

// mirrors upstream Odoo's own default flip on master/19.0+ (demo data off
// there; on for every earlier series, 16.0 through saas-18.x)
export function defaultDemoData(branch: string): boolean {
  const base = baseBranchOf(branch);
  return base !== "master" && !/^(19\.0|saas-19)/.test(base);
}
