// Globals the page gets from classic <script> tags (static/index.html, or loaded on
// demand), not from imports.

declare global {
  // static/lib/owl.js — typed by the published @odoo/owl package of the same version
  var owl: typeof import("@odoo/owl");

  // xterm.js + its fit addon (static/lib/xterm/, loaded by core/terminal.ts) and
  // Chart.js + its zoom plugin (static/lib/chart/, loaded by the memory
  // screen). Vendored UMD builds with no type package in the repo: `any` is
  // deliberate — the few calls goo makes are covered where they're used.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  var Terminal: any;
  var FitAddon: any;
  interface Window {
    Chart?: any;
    ChartZoom?: any;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

export {};
