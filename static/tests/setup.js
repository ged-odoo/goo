// Runs static/lib/owl.js (a classic non-ESM <script>, exactly as static/index.html
// loads it) so `globalThis.owl` exists before any test module imports "@odoo/owl" —
// the vitest.config.js alias resolves that import to vendor/owl-orm/owl-global.js,
// which does `const owl = globalThis.owl` at import time. Vitest runs setupFiles
// (and awaits them) before a test file's own imports are evaluated, so this
// ordering is safe.
//
// Uses vm.runInThisContext (Script semantics), NOT `new Function` (its body is its
// own function scope — a top-level `var` there never reaches globalThis) and NOT
// indirect eval (owl.js is "use strict", and strict-mode eval code gets its own
// scope for var/function declarations too). Script semantics are the only one of
// the three where a top-level `var` under "use strict" still lands on the global
// object — the same reason the plain <script> tag in static/index.html already
// works today.
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { afterEach, vi } from "vitest";

const owlPath = path.join(process.cwd(), "static/lib/owl.js");
const owlSrc = readFileSync(owlPath, "utf8");
vm.runInThisContext(owlSrc, { filename: owlPath });

if (typeof globalThis.owl?.Plugin !== "function") {
  throw new Error("static/tests/setup.js: globalThis.owl did not populate as expected");
}

// jsdom has no EventSource. Only static/src/core/server_plugin.js constructs one
// (`new EventSource("/api/events")`) — stub it so importing/constructing that
// plugin doesn't throw. Live SSE wiring itself is out of scope for unit tests
// (see CLAUDE.md's Gotchas — same precedent as excluding the backend PTY subsystem).
class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = {};
  }
  addEventListener(type, cb) {
    (this.listeners[type] ??= []).push(cb);
  }
  removeEventListener(type, cb) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== cb);
  }
  close() {}
}
globalThis.EventSource ??= FakeEventSource;

// jsdom doesn't implement requestAnimationFrame.
globalThis.requestAnimationFrame ??= (cb) => setTimeout(cb, 0);

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});
