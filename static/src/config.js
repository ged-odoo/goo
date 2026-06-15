// Default configuration. Anything edited in the Config tab is stored in
// localStorage (via ConfigPlugin) and overrides these values.
export const DEFAULT_CONFIG = {
  work_dir: "/home/odoo/work",
  venv_activate: "source /home/odoo/work/env20/bin/activate",
  db_user: "odoo",
  db_password: "odoo",
  repos: [
    { id: "community", path: "/home/odoo/work/community", github: "odoo/odoo" },
    { id: "enterprise", path: "/home/odoo/work/enterprise", github: "odoo/enterprise" },
    { id: "tutorials", path: "/home/odoo/work/tutorials", github: "odoo/tutorials" },
  ],
  targets: [
    { id: "community", repos: ["community"], db: "test_db", on_create_args: "-i sale_management" },
    {
      id: "enterprise",
      repos: ["community", "enterprise"],
      db: "test_db_e",
      on_create_args: "-i sale_management",
    },
    { id: "19.0", repos: ["community"], db: "test_db_19", on_create_args: "-i sale_management" },
    {
      id: "19.0e",
      repos: ["community", "enterprise"],
      db: "test_db_19e",
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

export const SECTIONS = ["server", "code", "branches", "tests", "databases", "addons", "config"];
export const RUNBOT = "https://runbot.odoo.com";
export const BASE_BRANCH_RE = /^(master|\d+\.\d+|saas-\d+\.\d+)$/;
export const CACHE_TTL = 10 * 60 * 1000;
