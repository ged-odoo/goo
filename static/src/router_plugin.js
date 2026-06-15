// Hash-based section routing.

import { SECTIONS } from "./config.js";

const { Plugin, signal } = owl;

export class RouterPlugin extends Plugin {
  static sequence = 1;
  section = signal(this._fromHash());
  setup() {
    window.addEventListener("hashchange", () => this.section.set(this._fromHash()));
  }
  _fromHash() {
    const s = location.hash.replace("#", "");
    return SECTIONS.includes(s) ? s : "server";
  }
  go(section) { location.hash = section; }
}
