/* global Terminal, FitAddon */
import { Component, onWillUnmount, plugin, props, signal, t, useEffect, xml } from "@odoo/owl";
import { TerminalPlugin } from "./terminal_plugin.js";
import { useDragResize } from "./common.js";

export let _xtermReady = null;

export function loadXterm() {
  if (!_xtermReady) {
    _xtermReady = new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/static/lib/xterm/xterm.css";
      document.head.appendChild(link);
      const s1 = document.createElement("script");
      s1.src = "/static/lib/xterm/xterm.js";
      s1.onload = () => {
        const s2 = document.createElement("script");
        s2.src = "/static/lib/xterm/addon-fit.js";
        s2.onload = resolve;
        s2.onerror = reject;
        document.head.appendChild(s2);
      };
      s1.onerror = reject;
      document.head.appendChild(s1);
    });
  }
  return _xtermReady;
}

// lazy-load a <script> and resolve once it has run (or already has, e.g. Chart.js
// itself once both the Nightly and Memory panel have asked for it)

export async function attachXterm(el, wsUrl, focusOnOpen = false) {
  await loadXterm();
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "var(--mono, monospace)",
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  // rAF lets the browser lay out xterm's DOM so FitAddon reads non-zero cells
  await new Promise((r) => requestAnimationFrame(r));
  fit.fit();
  if (focusOnOpen) term.focus();
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";
  const sendSize = () => {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  };
  ws.onopen = sendSize;
  ws.onmessage = (e) => term.write(new Uint8Array(e.data));
  const onData = term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data));
  });
  const ro = new ResizeObserver(() => {
    fit.fit();
    sendSize();
  });
  ro.observe(el);
  return () => {
    ro.disconnect();
    onData.dispose?.();
    try {
      ws.close();
    } catch {
      /* already closing */
    }
    term.dispose();
  };
}

// ─────────────────────────── Terminal panel ───────────────────────────

// draggable + resizable floating-window behaviour shared by the terminal windows.
// Call from setup() and bind the returned `handle` to the panel root via t-ref.
// Position is written straight to the DOM (not through a reactive style binding),
// so the window paints centered on the very first frame — no reposition flash —
// and dragging mutates the element directly instead of re-rendering per mousemove.
// `place(w, h) => {x, y}` overrides the default (centered) first position — e.g.
// the event log anchors bottom-right. x/y persist in the closure so a dragged
// window keeps its spot when reshown.

export class TerminalPanel extends Component {
  static template = xml`
    <div t-if="this.term.open()" class="term-panel" t-ref="this.drag.handle">
      <div class="term-panel-head" t-on-mousedown="this.drag.onDragStart">
        <span class="term-panel-title">Terminal</span>
        <button class="event-log-x" t-on-click="() => this.term.toggle()" title="close">✕</button>
      </div>
      <div class="term-panel-body" t-ref="this.container"/>
      <div class="term-panel-resize" t-on-mousedown="this.drag.onResizeStart"/>
    </div>`;

  term = plugin(TerminalPlugin);
  container = signal.ref(HTMLElement);
  _dispose = null;
  _termOpen = false; // guard against double-open on re-renders

  setup() {
    this.drag = useDragResize();
    onWillUnmount(() => this._closeTerminal());
    useEffect(() => {
      const el = this.container();
      if (el) {
        this._openTerminal(el);
      } else {
        this._closeTerminal();
      }
    });
  }

  async _openTerminal(el) {
    if (this._termOpen) return;
    this._termOpen = true;
    try {
      const dispose = await attachXterm(el, `ws://${location.host}/api/terminal`);
      if (this.container() !== el) {
        dispose(); // container swapped/gone while loading
        return;
      }
      this._dispose = dispose;
    } catch (e) {
      this._termOpen = false;
    }
  }

  _closeTerminal() {
    if (!this._termOpen) return;
    this._termOpen = false;
    this._dispose?.();
    this._dispose = null;
  }
}

// ─────────────────────────── Terminal dialog ───────────────────────────
// A draggable, resizable floating terminal running bash in a given directory
// (opened from the workspace Code tab). Backed by /api/shell, so it works
// regardless of the Odoo server; shares the term-panel chrome + useDragResize
// with the server-tab TerminalPanel.

export class TerminalDialog extends Component {
  static template = xml`
    <div class="term-panel" t-ref="this.drag.handle">
      <div class="term-panel-head" t-on-mousedown="this.drag.onDragStart">
        <span class="term-panel-title" t-att-title="this.props.path" t-out="this.label"/>
        <button class="event-log-x" title="close" t-on-click="() => this.done(null)">✕</button>
      </div>
      <div class="term-panel-body" t-ref="this.container"/>
      <div class="term-panel-resize" t-on-mousedown="this.drag.onResizeStart"/>
    </div>`;

  props = props({ done: t.function(), path: t.string(), label: t.string() });
  container = signal.ref(HTMLElement);
  _dispose = null;

  setup() {
    this.drag = useDragResize();
    useEffect(() => {
      const el = this.container();
      if (!el) return;
      let live = true;
      const url = `ws://${location.host}/api/shell?cwd=${encodeURIComponent(this.props.path)}`;
      attachXterm(el, url, true).then((dispose) => (live ? (this._dispose = dispose) : dispose()));
      return () => {
        live = false;
        this._dispose?.();
        this._dispose = null;
      };
    });
    const onKey = (e) => {
      // let a focused terminal handle Escape itself (vim, readline, …); only
      // close the dialog when focus is outside the terminal
      if (e.key !== "Escape") return;
      const el = this.container();
      if (el && el.contains(document.activeElement)) return;
      this.done(null);
    };
    document.addEventListener("keydown", onKey);
    onWillUnmount(() => document.removeEventListener("keydown", onKey));
  }

  get label() {
    return this.props.label || this.props.path;
  }

  done(result) {
    this.props.done(result);
  }
}

// ─────────────────────────── Commits dialog ───────────────────────────
// A draggable, resizable floating window listing the last commits on a repo's
// current branch (opened from the workspace Code tab). Shares the term-panel
// chrome + useDragResize with the terminal windows.
