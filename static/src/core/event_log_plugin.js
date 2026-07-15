// A small log of business events (server start/stop, db drop, test runs, …),
// shown in a toggleable overlay panel. Any plugin or component can add() a
// line. It has no dependencies, so every other plugin may use it. Entries are
// persisted to localStorage (the most recent MAX) so the log survives reloads.

import { postJSON } from "./utils.js";

import { Plugin, signal } from "@odoo/owl";

const MAX = 1000; // keep the most recent N entries (in memory and in storage)
const STORAGE_KEY = "oo-event-log";

// last session's log. A row still "pending" can never resolve — its finish was
// lost with the page — so it rejoins as a plain line (status/eid stripped).
function storedLog() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (raw && Array.isArray(raw.entries)) {
      const entries = raw.entries
        .filter((e) => e && typeof e.id === "number" && typeof e.text === "string")
        .map((e) => (e.status === "pending" ? { ...e, status: "", eid: "" } : e));
      return { entries, lastReadId: raw.lastReadId || 0 };
    }
  } catch {
    // corrupted storage — start fresh below
  }
  return { entries: [], lastReadId: 0 };
}

export class EventLogPlugin extends Plugin {
  static sequence = 1;

  _stored = storedLog(); // read once — entries + read marker from the same snapshot
  entries = signal(this._stored.entries); // [{ id, at, text, anchor, level, status?, eid? }]
  open = signal(false); // overlay panel visibility
  lastReadId = signal(this._stored.lastReadId); // highest entry id seen when the panel was last open
  _seq = this._stored.entries.reduce((m, e) => Math.max(m, e.id), 0);

  // cap + set + persist — every entries mutation funnels through here
  _commit(next) {
    this.entries.set(next.length > MAX ? next.slice(-MAX) : next);
    this._persist();
  }

  _persist() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ entries: this.entries(), lastReadId: this.lastReadId() }),
      );
    } catch {
      // storage full/unavailable — the in-memory log still works
    }
  }

  // `anchor` (optional) is a DOM id of a log row the UI can scroll to. It is kept
  // client-side only — the server log still receives just the text. `level`
  // (e.g. "error") flags the entry so the UI can highlight it.
  add(text, anchor = "", level = "") {
    this._commit([...this.entries(), { id: ++this._seq, at: Date.now(), text, anchor, level }]);
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
    this._commit([...this.entries(), row]);
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
    if (found) this._commit(entries);
    else if (text) {
      const row = { id: ++this._seq, at: Date.now(), text, anchor: "", level, status, eid };
      this._commit([...entries, row]);
    }
  }

  // Drop a pending event by its id (e.g. the user cancelled before it really began).
  drop(eid) {
    this._commit(this.entries().filter((e) => e.eid !== eid));
  }

  toggle() {
    this.open.set(!this.open());
    this.markRead(); // opening or closing, everything up to now has been seen
  }

  // mark every current entry as read (clears the unread badge)
  markRead() {
    this.lastReadId.set(this._seq);
    this._persist();
  }

  // events that arrived since the panel was last open (0 while it's open)
  unread() {
    if (this.open()) return 0;
    return this.entries().filter((e) => e.id > this.lastReadId()).length;
  }

  clear() {
    this._commit([]);
  }
}
