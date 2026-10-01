import {
  Component,
  onWillUnmount,
  useProps,
  signal,
  t,
  useEffect,
  xml,
} from "@odoo/owl";
import { useDragResize } from "./common.ts";
import type { DragResize } from "./common.ts";

// tears down an attached terminal (its websocket, observer and xterm instance)
type Dispose = () => void;

export let _xtermReady: Promise<unknown> | null = null;

export function loadXterm(): Promise<unknown> {
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

export async function attachXterm(
  el: HTMLElement,
  wsUrl: string,
  focusOnOpen = false,
): Promise<Dispose> {
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
  const onData = term.onData((data: string) => {
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

// ─────────────────────────── Terminal dialog ───────────────────────────
// A draggable, resizable floating terminal (opened from the workspace Code tab,
// or — via `workspace` instead of `path` — the Shell popup on a workspace's Start
// dropdown, running that workspace's own `odoo-bin shell` REPL). Backed by
// /api/shell, so it works regardless of the Odoo server.

export class TerminalDialog extends Component {
  static template = xml`
    <div class="term-panel" t-ref="this.drag.handle">
      <div class="term-panel-head" t-on-mousedown="this.drag.onDragStart">
        <span class="term-panel-title" t-att-title="this.label" t-out="this.label"/>
        <button class="event-log-x" title="close" t-on-click="() => this.done(null)">✕</button>
      </div>
      <div class="term-panel-body" t-ref="this.container"/>
      <div class="term-panel-resize" t-on-mousedown="this.drag.onResizeStart"/>
    </div>`;

  props = useProps({
    done: t.function<[null], void>(),
    path: t.string().optional(),
    workspace: t.string().optional(),
    label: t.string(),
  });

  container = signal.ref(HTMLElement);
  declare drag: DragResize; // set in setup()
  _dispose: Dispose | null = null;

  setup() {
    this.drag = useDragResize();
    useEffect(() => {
      const el = this.container();
      if (!el) return;
      let live = true;
      const url = this.props.workspace
        ? `ws://${location.host}/api/shell?workspace=${encodeURIComponent(this.props.workspace)}`
        : // callers pass either `workspace` or `path`
          `ws://${location.host}/api/shell?cwd=${encodeURIComponent(this.props.path!)}`;
      attachXterm(el, url, true).then((dispose) => (live ? (this._dispose = dispose) : dispose()));
      return () => {
        live = false;
        this._dispose?.();
        this._dispose = null;
      };
    });
    const onKey = (e: KeyboardEvent) => {
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

  get label(): string | undefined {
    return this.props.label || this.props.path;
  }

  done(result: null) {
    this.props.done(result);
  }
}

// ─────────────────────────── Commits dialog ───────────────────────────
// A draggable, resizable floating window listing the last commits on a repo's
// current branch (opened from the workspace Code tab). Shares the term-panel
// chrome + useDragResize with the terminal windows.
