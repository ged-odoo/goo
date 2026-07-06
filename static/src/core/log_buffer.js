// A detached, manually-managed log element. Lines are appended as plain DOM
// (never through Owl) so streaming thousands of rows is cheap and the content
// survives screen mount/unmount — the element lives on the owning plugin and a
// console component just hosts it while mounted.

import { buildLogRow } from "./utils.js";

import { signal } from "@odoo/owl";

const MAX_LINES = 2000;

export class LogBuffer {
  constructor() {
    this.el = document.createElement("div");
    this.el.className = "log-scroll";
    this.count = signal(0);
    this.autoScroll = signal(true); // true == "following the tail"
    this.savedScroll = 0; // scrollTop preserved across detach/re-host
    this._scrollQueued = false; // a tail-follow scroll is scheduled for next frame
    this._lastTop = 0; // last seen scrollTop, to tell a user scroll-up from growth
    this.el.addEventListener("scroll", () => {
      const top = this.el.scrollTop;
      const atBottom = top + this.el.clientHeight >= this.el.scrollHeight - 4;
      // Re-follow once the user is back at the bottom; stop following only on an
      // actual upward scroll. Content growing past the viewport (or our own
      // batched toBottom landing a frame late) leaves us "not at bottom" without
      // a user scroll — that must NOT disable autoscroll.
      if (atBottom) {
        if (!this.autoScroll()) this.autoScroll.set(true);
      } else if (top < this._lastTop - 4) {
        if (this.autoScroll()) this.autoScroll.set(false);
      }
      this._lastTop = top;
    });
  }

  // `id` (optional) tags the row's DOM element so callers can scroll/link to it
  append(line, id) {
    const row = buildLogRow(line);
    if (id) row.id = id;
    this.el.appendChild(row);
    while (this.el.childElementCount > MAX_LINES) this.el.firstElementChild.remove();
    this.count.set(this.el.childElementCount);
    if (this.autoScroll()) this._queueScroll();
  }

  // Coalesce tail-following into one scroll per animation frame. Calling
  // toBottom() on every appended line interleaves a scrollHeight read with each
  // DOM mutation, forcing a synchronous reflow per line (layout thrashing). A
  // burst of appends now triggers a single reflow on the next frame instead.
  _queueScroll() {
    if (this._scrollQueued) return;
    this._scrollQueued = true;
    requestAnimationFrame(() => {
      this._scrollQueued = false;
      if (this.autoScroll()) this.toBottom();
    });
  }

  clear() {
    this.el.replaceChildren();
    this.count.set(0);
  }

  toBottom() {
    this.el.scrollTop = this.el.scrollHeight;
    this._lastTop = this.el.scrollTop; // ours, not a user scroll
  }

  // called by the host console on (re)mount to restore the scroll position,
  // since detaching the element resets scrollTop
  restore() {
    if (this.autoScroll()) this.toBottom();
    else this.el.scrollTop = this.savedScroll;
    this._lastTop = this.el.scrollTop;
  }
}
