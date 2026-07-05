// Hash-based section routing.

import { SECTIONS } from "./config.js";

import { Plugin, signal } from "@odoo/owl";

export class RouterPlugin extends Plugin {
  static sequence = 1;
  section = signal(this._fromHash());
  setup() {
    window.addEventListener("hashchange", () => this.section.set(this._fromHash()));
  }

  _fromHash() {
    const s = location.hash.replace("#", "");
    return SECTIONS.includes(s) ? s : "dashboard";
  }

  go(section) {
    location.hash = section;
  }
}
