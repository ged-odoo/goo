// Configuration presets, applied from the Config tab's "Presets" dialog. Each
// preset is a bundle of goo's persisted localStorage entries (same shape as an
// export/import file): applying one wipes the current config and writes these
// (see ConfigPlugin.applyPreset). An empty `data` means "pure DEFAULT_CONFIG".
//
//   - Normal — the built-in defaults (generic Odoo dev setup, no venv).
//   - Simple — the defaults with the PRs/Reviews/Tests tabs hidden, no venv.
//   - GED    — Géry's personal config (repos incl. owl, his targets/links, venv).

// Simple: the default config plus a tabs override hiding prs/reviews/tests/assets.
// Only the override is stored; everything else falls back to DEFAULT_CONFIG.
const SIMPLE_TABS = [
  { id: "dashboard", visible: true },
  { id: "targets", visible: true },
  { id: "server", visible: true },
  { id: "tests", visible: false },
  { id: "branches", visible: true },
  { id: "prs", visible: false },
  { id: "reviews", visible: false },
  { id: "assets", visible: false },
  { id: "addons", visible: true },
  { id: "databases", visible: true },
  { id: "config", visible: true },
];

// GED: a full config override. venv_activate is included (his setup needs it) even
// though it wasn't in the raw export, where it relied on the old hardcoded default.
const GED_CONFIG = {
  venv_activate: "source /home/odoo/work/env20/bin/activate",
  auto_open_event_log: true,
  repos: [
    {
      id: "community",
      path: "/home/odoo/work/community",
      github: "odoo/odoo",
      autoreload: false,
      favorite: true,
    },
    {
      id: "enterprise",
      path: "/home/odoo/work/enterprise",
      github: "odoo/enterprise",
      autoreload: false,
      favorite: true,
    },
    {
      id: "tutorials",
      path: "/home/odoo/work/tutorials",
      github: "odoo/tutorials",
      autoreload: false,
      favorite: false,
    },
    {
      id: "owl",
      path: "/home/odoo/work/owl",
      github: "odoo/owl",
      autoreload: false,
      external: true, // not on mergebot/runbot — skip those scrapes
      favorite: false,
    },
  ],
  targets: [
    {
      id: "master-enterprise",
      name: "master (enterprise)",
      favorite: true,
      config: [
        { repo: "community", branch: "master" },
        { repo: "enterprise", branch: "master" },
      ],
      db: "master-enterprise",
      on_create_args: "-i sale_management",
    },
    {
      name: "master",
      favorite: false,
      config: [{ repo: "community", branch: "master" }],
      db: "master",
      on_create_args: "-i sale_management",
      id: "master",
    },
    {
      name: "19.0",
      favorite: false,
      config: [
        { repo: "community", branch: "19.0" },
        { repo: "enterprise", branch: "19.0" },
      ],
      db: "19.0",
      on_create_args: "-i sale_management",
      id: "19-0-e",
    },
    {
      id: "6d97bcd9-87c5-4bef-a397-ada7b6a16d5e",
      name: "master-owl-update-again-ged",
      favorite: true,
      config: [{ repo: "community", branch: "master-owl-update-again-ged" }],
      db: "master-owl-update-again-ged",
      on_create_args: "-i sale_management",
    },
  ],
  links: [
    { label: "/odoo", href: "http://localhost:8069/dev/autologin?to=%2Fodoo%3Fdebug%3Dassets" },
    {
      label: "/web/tests",
      href: "http://localhost:8069/dev/autologin?to=%2Fweb%2Ftests%3Fdebug%3Dassets%26timeout%3D500000%26manual%3Dtrue%26preset%3Ddesktop",
    },
    { label: "🦉 docs", href: "https://odoo.github.io/owl/documentation/v3/owl/" },
    { label: "🦉 playground", href: "https://odoo.github.io/owl/playground/" },
    { label: "🦉 github", href: "https://github.com/odoo/owl" },
    {
      label: "misc",
      children: [
        { label: "myprs", href: "https://github.com/pulls/authored" },
        { label: "runbot", href: "https://runbot.odoo.com" },
        { label: "mergebot", href: "https://mergebot.odoo.com" },
        { label: "odoo/odoo", href: "https://github.com/odoo/odoo/tree/master" },
        { label: "odoo/enterprise", href: "https://github.com/odoo/enterprise/tree/master" },
        { label: "odoo/tutorials", href: "https://github.com/odoo/tutorials/tree/master" },
        { label: "goo", href: "https://github.com/ged-odoo/goo" },
        { label: "documentation", href: "https://www.odoo.com/documentation/master/" },
      ],
    },
  ],
  tabs: [
    { id: "dashboard", visible: true },
    { id: "targets", visible: true },
    { id: "server", visible: true },
    { id: "worktree", visible: true },
    { id: "tests", visible: true },
    { id: "branches", visible: true },
    { id: "prs", visible: true },
    { id: "reviews", visible: true },
    { id: "addons", visible: true },
    { id: "databases", visible: true },
    { id: "config", visible: true },
  ],
};

export const PRESETS = [
  {
    id: "normal",
    label: "Normal — standard Odoo dev setup",
    data: {}, // empty → pure DEFAULT_CONFIG
    clearDataFile: true, // back to browser storage (unset the Storage file field)
  },
  {
    id: "simple",
    label: "Simple — no PRs/Reviews/Tests tabs, no venv",
    data: { "oo-config": JSON.stringify({ tabs: SIMPLE_TABS }) },
    clearDataFile: true, // back to browser storage (unset the Storage file field)
  },
  {
    id: "ged",
    label: "GED — Géry's full config",
    data: {
      "oo-config": JSON.stringify(GED_CONFIG),
      "oo-prs-favorites": JSON.stringify(["master-owl-update"]),
      "oo-last-target": "6d97bcd9-87c5-4bef-a397-ada7b6a16d5e",
      "oo-test-history": JSON.stringify([
        "/web:WebSuite[@web/core/checkbox]",
        "/web:WebSuite[@web_tour/tour_automatic/Step Tour validity]",
        "@web_tour/tour_automatic/Step Tour validity",
        "/account:TestUi.test_add_section_from_product_catalog_on_invoice_tour",
        ":TestUi.test_add_section_from_product_catalog_on_invoice_tour",
        "/web:WebSuite[@web/core/py_js/py_parser]",
        "/web:WebSuite[@web/core/checkbox/indeterminate style attribute renders a visible dash]",
        "/web:WebSuite[@web/core]",
        "/web:WebSuite[@web]",
        "/web:WebSuite[@web/core/py_js/py_parse]",
      ]),
    },
  },
];
