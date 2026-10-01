// TerminalDialog against stand-ins for the browser-only pieces
// (xterm.js + its fit addon — normally lazy <script>s —, WebSocket, ResizeObserver):
// the assertions are what the user gets — a terminal opened in the panel's body,
// wired to the right websocket, torn down when closed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalDialog } from "../../src/core/terminal.ts";
import { DialogPlugin } from "../../src/core/dialog_plugin.ts";
import { mountCore, waitFor, type MountedCore } from "../helpers/core_ui_fixtures.ts";

class FakeTerminal {
  static all: FakeTerminal[] = [];
  el: HTMLElement | null = null;
  disposed = false;
  focused = false;
  written: Uint8Array[] = [];
  cols = 80;
  rows = 24;
  onDataCb: ((d: string) => void) | null = null;
  constructor() {
    FakeTerminal.all.push(this);
  }

  loadAddon() {}
  open(el: HTMLElement) {
    this.el = el;
  }

  focus() {
    this.focused = true;
  }

  write(d: Uint8Array) {
    this.written.push(d);
  }

  onData(cb: (d: string) => void) {
    this.onDataCb = cb;
    return { dispose: () => (this.onDataCb = null) };
  }

  dispose() {
    this.disposed = true;
  }
}

class FakeWebSocket {
  static OPEN = 1;
  static all: FakeWebSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  closed = false;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.all.push(this);
  }

  send(d: unknown) {
    this.sent.push(
      typeof d === "string" ? JSON.parse(d) : new TextDecoder().decode(d as Uint8Array),
    );
  }

  close() {
    this.closed = true;
  }

  // the server accepted the connection
  accept() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
}

class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  disconnected = false;
  constructor(public cb: () => void) {
    FakeResizeObserver.all.push(this);
  }

  observe() {}
  disconnect() {
    this.disconnected = true;
  }
}

let core: MountedCore | null = null;
beforeEach(() => {
  FakeTerminal.all = [];
  FakeWebSocket.all = [];
  FakeResizeObserver.all = [];
});
afterEach(() => {
  core?.destroy();
  core = null;
});

async function mount(C: typeof TerminalDialog | null) {
  core = await mountCore(C);
  // after mountCore's own stubs (it stubs fetch; destroy() unstubs all globals)
  vi.stubGlobal("Terminal", FakeTerminal);
  vi.stubGlobal("FitAddon", {
    FitAddon: class {
      fit() {}
    },
  });
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  return core;
}

// the lazy xterm <script>s finish loading (only the first test ever adds them —
// the load promise is module-level and cached)
function finishXtermLoad() {
  const s1 = document.head.querySelector<HTMLScriptElement>('script[src$="xterm/xterm.js"]');
  s1?.onload?.(new Event("load"));
  const s2 = document.head.querySelector<HTMLScriptElement>('script[src$="addon-fit.js"]');
  s2?.onload?.(new Event("load"));
}


describe("TerminalDialog", () => {
  it("opens a focused shell in the repo, and closes on ✕", async () => {
    const c = await mount(null);
    const done = c
      .plugin(DialogPlugin)
      .openComponent(TerminalDialog, { path: "/src/my repo", label: "community" });
    await c.settle();
    finishXtermLoad();
    expect(c.el.querySelector(".term-panel-title")!.textContent).toBe("community");
    await waitFor(c.settle, () => FakeWebSocket.all.length === 1);
    expect(FakeWebSocket.all[0].url).toBe(
      `ws://${location.host}/api/shell?cwd=${encodeURIComponent("/src/my repo")}`,
    );
    expect(FakeTerminal.all[0].focused).toBe(true);
    c.el.querySelector<HTMLElement>(".term-panel .event-log-x")!.click();
    expect(await done).toBeNull();
    await c.settle();
    expect(FakeTerminal.all[0].disposed).toBe(true);
    expect(FakeWebSocket.all[0].closed).toBe(true);
  });

  it("runs a workspace's odoo shell; Escape inside the terminal is the terminal's", async () => {
    const c = await mount(null);
    const done = c
      .plugin(DialogPlugin)
      .openComponent(TerminalDialog, { workspace: "w 1", label: "" });
    await c.settle();
    finishXtermLoad();
    await waitFor(c.settle, () => FakeWebSocket.all.length === 1);
    expect(FakeWebSocket.all[0].url).toBe(`ws://${location.host}/api/shell?workspace=w%201`);
    const container = c.el.querySelector<HTMLElement>(".term-panel-body")!;
    const input = document.createElement("textarea");
    container.appendChild(input);
    input.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    await c.settle();
    expect(c.el.querySelector(".term-panel")).not.toBeNull(); // still open
    input.blur();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(await done).toBeNull();
  });

  it("disposes a terminal that finishes opening after the dialog closed", async () => {
    const c = await mount(null);
    const done = c.plugin(DialogPlugin).openComponent(TerminalDialog, { path: "/src", label: "x" });
    await c.settle(); // mounted; xterm is attaching (waiting a frame to fit)
    finishXtermLoad();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(await done).toBeNull();
    await waitFor(c.settle, () => FakeTerminal.all.length === 1 && FakeTerminal.all[0].disposed);
  });
});
