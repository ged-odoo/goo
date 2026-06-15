// A detached, manually-managed log element. Lines are appended as plain DOM
// (never through Owl) so streaming thousands of rows is cheap and the content
// survives screen mount/unmount — the element lives on the owning plugin and a
// console component just hosts it while mounted.

import { buildLogRow } from "./utils.js";

const { signal } = owl;

const MAX_LINES = 2000;

export class LogBuffer {
  constructor() {
    this.el = document.createElement("div");
    this.el.className = "log-scroll";
    this.count = signal(0);
    this.autoScroll = signal(true); // true == "following the tail"
    this.savedScroll = 0; // scrollTop preserved across detach/re-host
    // scrolling away from the bottom stops following; scrolling back resumes it
    this.el.addEventListener("scroll", () => {
      const atBottom = this.el.scrollTop + this.el.clientHeight >= this.el.scrollHeight - 4;
      if (atBottom !== this.autoScroll()) this.autoScroll.set(atBottom);
    });
  }
  append(line) {
    this.el.appendChild(buildLogRow(line));
    while (this.el.childElementCount > MAX_LINES) this.el.firstElementChild.remove();
    this.count.set(this.el.childElementCount);
    if (this.autoScroll()) this.toBottom();
  }
  clear() {
    this.el.replaceChildren();
    this.count.set(0);
  }
  toBottom() {
    this.el.scrollTop = this.el.scrollHeight;
  }
  // called by the host console on (re)mount to restore the scroll position,
  // since detaching the element resets scrollTop
  restore() {
    if (this.autoScroll()) this.toBottom();
    else this.el.scrollTop = this.savedScroll;
  }
}
