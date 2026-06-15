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
    this.autoScroll = signal(true);
  }
  append(line) {
    this.el.appendChild(buildLogRow(line));
    while (this.el.childElementCount > MAX_LINES) this.el.firstElementChild.remove();
    this.count.set(this.el.childElementCount);
    if (this.autoScroll()) this.el.scrollTop = this.el.scrollHeight;
  }
  clear() {
    this.el.replaceChildren();
    this.count.set(0);
  }
}
