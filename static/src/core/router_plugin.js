// Hash-based section routing.

import { SECTIONS } from "./config.js";

import { Plugin, signal } from "@odoo/owl";

// retired section ids → their successor (stale bookmarks/links keep working)
// retired sections redirect: old bookmarks/bundles keep working
const ALIASES = {
  worktree: "workspaces",
  server: "workspaces", // the loaded workspace's Server-logs tab superseded it
  code: "workspaces", // the repo sync strip moved to the workspace's Code tab
  targets: "config", // template management lives on the Configuration screen
  templates: "config",
  tests: "workspaces",
  assets: "workspaces",
  addons: "workspaces",
};

export class RouterPlugin extends Plugin {
  static sequence = 1;
  section = signal(this._fromHash());
  setup() {
    window.addEventListener("hashchange", () => this.section.set(this._fromHash()));
  }

  _fromHash() {
    const raw = location.hash.replace("#", "");
    const s = ALIASES[raw] || raw;
    return SECTIONS.includes(s) ? s : "dashboard";
  }

  go(section) {
    location.hash = section;
  }
}
