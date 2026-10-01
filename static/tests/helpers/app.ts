// Mounts the whole goo app — the real App component with every real plugin — into
// jsdom, against a fake backend. A test describes the backend as routes
// (`"/api/databases": { ok: true, databases: [...] }`, or a function of the request
// body), then asserts what the user would see (rendered DOM) and what the app asked
// the backend for (the recorded calls).
import { vi } from "vitest";
import { App } from "../../src/core/app.ts";
import { loadServerConfig } from "../../src/core/config_plugin.ts";
import { PLUGINS } from "../../src/plugins.ts";
import { DEFAULT_CONFIG, type Config } from "../../src/core/config.ts";

export interface BackendCall {
  method: string;
  url: string; // path + query, e.g. "/api/workspace/logs?id=w1"
  path: string; // path only
  body: unknown; // the parsed JSON body (POST), or undefined
}

// a route answers with JSON (or a full Response for status codes / errors)
export type RouteReply = unknown;
export type Route = RouteReply | ((body: unknown, call: BackendCall) => RouteReply);

export interface MountAppOptions {
  // fake backend, keyed by path ("/api/databases") over empty BACKGROUND_ROUTES; an
  // unrouted path answers `{}` but fails the test at destroy()
  routes?: Record<string, Route>;
  // the server-owned config the app boots with (merged over DEFAULT_CONFIG)
  config?: Partial<Config>;
  state?: Record<string, unknown>;
  // the screen to open on (a SECTIONS id, e.g. "databases")
  section?: string;
}

export interface MountedApp {
  root: HTMLElement;
  calls: BackendCall[];
  // paths the app requested that no route answered (answered `{}`)
  unhandled: string[];
  // let renders, effects and pending fetches run until the DOM is stable
  settle(): Promise<void>;
  navigate(section: string): Promise<void>;
  // the calls made to one path (POST bodies are parsed)
  callsTo(path: string): BackendCall[];
  destroy(): void;
}

const BACKGROUND_ROUTES: Record<string, Route> = {
  "/api/goo/update": { ok: true, checked: true, behind: 0 },
  "/api/status": { id: "main", state: "stopped" },
  "/api/event": { ok: true },
  "/api/workspace/list": { servers: {} },
  "/api/workspace/logs": { lines: [] },
  "/api/databases": { ok: true, databases: [] },
  "/api/code/branches": { repos: [] },
  "/api/prs": { repos: [] },
  "/api/runbot": { states: {} },
  "/api/mergebot": { states: {} },
};

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function flush(): Promise<void> {
  // a macrotask lets pending fetch promises resolve; a frame lets owl's scheduler
  // (requestAnimationFrame-driven) flush the renders they triggered
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => requestAnimationFrame(() => r(null)));
}

export async function mountApp(opts: MountAppOptions = {}): Promise<MountedApp> {
  const calls: BackendCall[] = [];
  const unhandled: string[] = [];
  const routes: Record<string, Route> = {
    // the background reads every screen makes (update check, server status, event
    // log, the observed git/PR/CI state) — empty by default, i.e. "nothing to show";
    // a test overrides the ones it's about. Anything else must be routed explicitly.
    ...BACKGROUND_ROUTES,
    "/api/config": {
      ok: true,
      rev: 1,
      config: { ...DEFAULT_CONFIG, ...opts.config },
      state: opts.state ?? {},
    },
    ...opts.routes,
  };

  const fetchFake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const path = url.split("?")[0];
    const method = (init?.method ?? "GET").toUpperCase();
    const raw = init?.body;
    const body = typeof raw === "string" && raw ? JSON.parse(raw) : undefined;
    const call: BackendCall = { method, url, path, body };
    calls.push(call);
    if (!(path in routes)) {
      unhandled.push(path);
      return json({});
    }
    const route = routes[path];
    const reply = typeof route === "function" ? route(body, call) : route;
    return reply instanceof Response ? reply : json(reply);
  };
  vi.stubGlobal("fetch", vi.fn(fetchFake));

  location.hash = opts.section ?? "";
  await loadServerConfig();

  const root = document.createElement("div");
  document.body.appendChild(root);
  // owl's App isn't in the curated @odoo/owl shim (the app only ever calls mount());
  // tests need the App itself to destroy it afterwards — same as plugin_harness.ts
  const app = new globalThis.owl.App({ plugins: PLUGINS, test: true });
  await app.createRoot(App).mount(root);

  const settle = async (): Promise<void> => {
    // until a full flush changes nothing — no DOM change and no new backend request
    // (a request mid-flush means a fetch chain is still running). Bounded: a test
    // must not hang.
    let html = "";
    let sent = -1;
    for (let i = 0; i < 30 && (root.innerHTML !== html || calls.length !== sent); i++) {
      html = root.innerHTML;
      sent = calls.length;
      await flush();
    }
  };
  await settle();

  return {
    root,
    calls,
    unhandled,
    settle,
    async navigate(section: string) {
      location.hash = section;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await settle();
    },
    callsTo: (path: string) => calls.filter((c) => c.path === path),
    destroy() {
      app.destroy();
      root.remove();
      vi.unstubAllGlobals();
      location.hash = "";
      // a request no route answered got `{}` — a test must not pass on that default
      if (unhandled.length)
        throw new Error(
          `unrouted backend calls (add a route): ${[...new Set(unhandled)].join(", ")}`,
        );
    },
  };
}
