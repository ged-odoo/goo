// A small in-memory log of business events (server start/stop, db drop, test
// runs, …), shown in a toggleable overlay panel. Any plugin or component can
// add() a line. It has no dependencies, so every other plugin may use it.

import { postJSON } from "./utils.js";

const { Plugin, signal } = owl;

const MAX = 500; // keep the most recent N entries

export class EventLogPlugin extends Plugin {
  static sequence = 1;

  entries = signal([]); // [{ id, at, text }]
  open = signal(false); // overlay panel visibility
  _seq = 0;

  // `anchor` (optional) is a DOM id of a log row the UI can scroll to. It is kept
  // client-side only — the server log still receives just the text. `level`
  // (e.g. "error") flags the entry so the UI can highlight it.
  add(text, anchor = "", level = "") {
    const next = [...this.entries(), { id: ++this._seq, at: Date.now(), text, anchor, level }];
    this.entries.set(next.length > MAX ? next.slice(-MAX) : next);
    postJSON("/api/event", { text }).catch(() => {}); // also log on the goo server (best-effort)
  }

  toggle() {
    this.open.set(!this.open());
  }

  clear() {
    this.entries.set([]);
  }
}
