// Hardcoded configuration. Will move to localStorage later — keep this the
// single source of truth: the backend receives it with each start request.
const CONFIG = {
  work_dir: "/home/odoo/work",
  venv_activate: "source /home/odoo/work/env20/bin/activate",
  db_user: "odoo",
  db_password: "odoo",
  repos: [
    { id: "community", path: "/home/odoo/work/community" },
    { id: "enterprise", path: "/home/odoo/work/enterprise" },
    { id: "tutorials", path: "/home/odoo/work/tutorials" },
  ],
  start: {
    repos: ["community"],
    db: "test_db",
    on_create_args: "-i sale_management",
    other_args: "--dev all",
  },
};
