// Mounts one core component (or a small test host around it) inside a real owl App
// with every real plugin, against a fake backend — like helpers/app.ts's mountApp,
// but for a single widget instead of the whole shell, and exposing the plugins so a
// test can drive the API the widget is opened through (DialogPlugin.open, …).
import { vi } from "vitest";
import { Component, usePlugin, useProps, t, xml } from "@odoo/owl";
import type { ComponentConstructor, PluginConstructor } from "@odoo/owl";
import { loadServerConfig } from "../../src/core/config_plugin.ts";
import { DialogPlugin } from "../../src/core/dialog_plugin.ts";
import { DEFAULT_CONFIG, type Config } from "../../src/core/config.ts";
import { PLUGINS } from "../../src/plugins.ts";
import type { BackendCall, Route } from "./app.ts";

export interface MountedCore {
  el: HTMLElement;
  calls: BackendCall[];
  callsTo(path: string): BackendCall[];
  plugin<T extends PluginConstructor>(P: T): InstanceType<T>;
  settle(): Promise<void>;
  destroy(): void;
}

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

// hosts the component under test next to the dialog mount point (DialogPlugin
// renders its dialogs into whatever node binds its `root` ref)
class Host extends Component {
  static template = xml`
    <div>
      <t t-if="this.props.C" t-component="this.props.C" t-props="this.props.cProps"/>
      <div t-ref="this.dialogRoot"/>
    </div>`;

  props = useProps({ C: t.any(), cProps: t.any() });
  dialogRoot = usePlugin(DialogPlugin).root;
}

export async function mountCore(
  C: ComponentConstructor | null,
  {
    props = {},
    routes = {},
    config = {},
  }: { props?: object; routes?: Record<string, Route>; config?: Partial<Config> } = {},
): Promise<MountedCore> {
  const calls: BackendCall[] = [];
  const all: Record<string, Route> = {
    "/api/config": { ok: true, rev: 1, config: { ...DEFAULT_CONFIG, ...config }, state: {} },
    ...routes,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = url.split("?")[0];
      const raw = init?.body;
      const body = typeof raw === "string" && raw ? JSON.parse(raw) : undefined;
      const call = { method: (init?.method ?? "GET").toUpperCase(), url, path, body };
      calls.push(call);
      const route = all[path];
      const reply = typeof route === "function" ? route(body, call) : (route ?? {});
      return reply instanceof Response ? reply : json(reply);
    }),
  );
  await loadServerConfig();
  const el = document.createElement("div");
  document.body.appendChild(el);
  const app = new globalThis.owl.App({ plugins: PLUGINS, test: true });
  await app.createRoot(Host, { props: { C, cProps: props } }).mount(el);
  const settle = async (): Promise<void> => {
    let before = "";
    for (let i = 0; i < 20 && el.innerHTML !== before; i++) {
      before = el.innerHTML;
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
  };
  await settle();
  return {
    el,
    calls,
    callsTo: (path) => calls.filter((c) => c.path === path),
    // every PLUGINS entry is started by the App
    plugin: <T extends PluginConstructor>(P: T) =>
      app.pluginManager.getPluginById(P.id) as InstanceType<T>,
    settle,
    destroy() {
      app.destroy();
      el.remove();
      vi.unstubAllGlobals();
    },
  };
}

// the button whose text is exactly `label` (trimmed), inside `root`
export function button(root: ParentNode, label: string): HTMLButtonElement {
  const b = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (x) => x.textContent?.trim() === label,
  );
  if (!b) throw new Error(`no "${label}" button`);
  return b;
}

// type into an input/textarea the way a user does (value + input event)
export function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// settle until `cond()` holds, failing after `ms` (for real debounce/linger timers)
export async function waitFor(
  settle: () => Promise<void>,
  cond: () => boolean,
  ms = 2000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met before the deadline");
    await settle();
    await new Promise((r) => setTimeout(r, 10));
  }
}

// an EventSource stand-in that records its instances, so a test can push the live
// SSE events the backend would send (`es.emit("server", {...})`) or drop the
// connection (`es.fail()`). Install with vi.stubGlobal("EventSource", …).
export class RecordingEventSource {
  static instances: RecordingEventSource[] = [];
  listeners: Record<string, ((ev: MessageEvent) => void)[]> = {};
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    RecordingEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: MessageEvent) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }

  removeEventListener(): void {}
  close(): void {}

  emit(type: string, data: unknown): void {
    const ev = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const cb of this.listeners[type] || []) cb(ev);
  }

  fail(): void {
    this.onerror?.();
  }
}
