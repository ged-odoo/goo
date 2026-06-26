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

  // Begin a long-running event: appends a row with an animated "..." that finish()
  // later resolves to "ok" (or "failed"). `eid` correlates the start and the end —
  // it comes from the server (so the same token tags both SSE messages); the
  // server already logged the line, so this does not POST it back.
  start(eid, text, level = "") {
    const row = {
      id: ++this._seq,
      at: Date.now(),
      text,
      anchor: "",
      level,
      status: "pending",
      eid,
    };
    const next = [...this.entries(), row];
    this.entries.set(next.length > MAX ? next.slice(-MAX) : next);
  }

  // Begin a *client-initiated* long-running event (e.g. starting the server): same
  // pending row as start(), but it mints and returns the correlation id so the
  // caller can finish()/drop() it later. Logged on the goo server too (best-effort).
  begin(text, level = "") {
    const eid = `local-${this._seq + 1}`;
    this.start(eid, text, level);
    postJSON("/api/event", { text }).catch(() => {});
    return eid;
  }

  // Resolve a long-running event by its id: append "ok" ("done") or "failed"
  // ("error") after its dots, keeping the original text. If the start was missed
  // (e.g. the client connected mid-flight) and a text is given, fall back to
  // appending a finished row.
  finish(eid, status, text = "", level = "") {
    let found = false;
    const entries = this.entries().map((e) => {
      if (e.eid !== eid) return e;
      found = true;
      return { ...e, status, level: level || e.level };
    });
    if (found) this.entries.set(entries);
    else if (text) {
      const row = { id: ++this._seq, at: Date.now(), text, anchor: "", level, status, eid };
      const next = [...entries, row];
      this.entries.set(next.length > MAX ? next.slice(-MAX) : next);
    }
  }

  // Drop a pending event by its id (e.g. the user cancelled before it really began).
  drop(eid) {
    this.entries.set(this.entries().filter((e) => e.eid !== eid));
  }

  toggle() {
    this.open.set(!this.open());
  }

  clear() {
    this.entries.set([]);
  }
}
