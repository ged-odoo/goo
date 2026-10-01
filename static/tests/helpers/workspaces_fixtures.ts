// Fixtures for the Workspaces-screen app tests: workspace configs, the git/PR
// replies the screen loads, a capturing EventSource to push live SSE events, and
// small DOM lookups (by visible text).
import { vi } from "vitest";
import type { WorkspaceConfig } from "../../src/core/config.ts";
import type { BranchInfo, RepoStatusWire } from "../../src/core/observed_models.ts";

export function ws(over: Partial<WorkspaceConfig> & { id: string }): WorkspaceConfig {
  return {
    name: over.id,
    favorite: false,
    category: "",
    parent: "",
    notes: "",
    on_create_args: "",
    demo_data: true,
    worktree: null,
    port: null,
    created_at: "2026-09-01T10:00:00.000Z",
    last_activity: "2026-09-01T10:00:00.000Z",
    location: "main",
    db: over.id,
    checkouts: [
      { repo: "community", branch: `master-${over.id}` },
      { repo: "enterprise", branch: "master" },
    ],
    ...over,
  };
}

export function branch(name: string, over: Partial<BranchInfo> = {}): BranchInfo {
  return {
    name,
    date: "2026-09-01T10:00:00Z",
    subject: `tip of ${name}`,
    sha: "abc1234",
    remote: false,
    synced: false,
    ...over,
  };
}

export function repo(
  id: string,
  current: string,
  branches: (string | BranchInfo)[],
  over: Partial<RepoStatusWire> = {},
): RepoStatusWire {
  return {
    id,
    current,
    dirty: false,
    branches: branches.map((b) => (typeof b === "string" ? branch(b) : b)),
    ...over,
  };
}

// a /api/code/branches route answering only the asked repos from `all`
export function branchesRoute(all: RepoStatusWire[]) {
  return (body: unknown) => {
    const asked = new Set(((body as { repos?: { id: string }[] }).repos || []).map((r) => r.id));
    return { repos: all.filter((r) => asked.has(r.id)) };
  };
}

// Capture the app's EventSource (setup.ts's FakeEventSource) so a test can push
// live backend events. Call before mountApp — mountApp's destroy() unstubs it.
type Listener = (ev: MessageEvent) => void;
export interface Sse {
  emit(type: string, data: unknown): void;
}
export function captureSse(): Sse {
  const Base = globalThis.EventSource as unknown as new (url: string) => {
    listeners: Record<string, Listener[]>;
  };
  const sources: InstanceType<typeof Base>[] = [];
  class Capturing extends Base {
    constructor(url: string) {
      super(url);
      sources.push(this);
    }
  }
  vi.stubGlobal("EventSource", Capturing);
  return {
    emit(type, data) {
      for (const s of sources)
        for (const cb of s.listeners[type] || [])
          cb(new MessageEvent(type, { data: JSON.stringify(data) }));
    },
  };
}

export function byText<T extends HTMLElement = HTMLButtonElement>(
  root: ParentNode,
  selector: string,
  text: string,
): T | undefined {
  return [...root.querySelectorAll<T>(selector)].find((el) => el.textContent?.trim() === text);
}

export function mustText<T extends HTMLElement = HTMLButtonElement>(
  root: ParentNode,
  selector: string,
  text: string,
): T {
  const el = byText<T>(root, selector, text);
  if (!el) throw new Error(`no ${selector} with text "${text}"`);
  return el;
}

export function texts(root: ParentNode, selector: string): string[] {
  return [...root.querySelectorAll(selector)].map((el) => el.textContent?.trim() || "");
}

// the generic dialog currently open (DialogPlugin's form/message modal)
export function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".dialog");
}

// settle until `cond` holds, failing after a deadline (for debounced effects, e.g.
// the config save's 250ms coalescing)
export async function waitFor(
  app: { settle(): Promise<void> },
  cond: () => boolean,
  ms = 2000,
): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor: condition not met before the deadline");
    await app.settle();
    await new Promise((r) => setTimeout(r, 20));
  }
}

// the config the app last POSTed to /api/config (its debounced save)
export function lastSavedConfig(app: {
  callsTo(path: string): { method: string; body: unknown }[];
}): { workspaces: WorkspaceConfig[] } & Record<string, unknown> {
  const posts = app.callsTo("/api/config").filter((c) => c.method === "POST");
  const body = posts[posts.length - 1]?.body as { config: { workspaces: WorkspaceConfig[] } };
  return body.config;
}

// a /api/mergebot route answering only the asked PRs (like the backend), from
// `states` keyed "github#number"
export function mergebotRoute(
  states: Record<string, string>,
  details: Record<string, string> = {},
) {
  return (body: unknown) => {
    const asked = ((body as { prs?: { github: string; number: number }[] }).prs || []).map(
      (p) => `${p.github}#${p.number}`,
    );
    return {
      states: Object.fromEntries(asked.map((k) => [k, states[k] || ""])),
      details: Object.fromEntries(asked.filter((k) => details[k]).map((k) => [k, details[k]])),
      forward_ports: Object.fromEntries(asked.map((k) => [k, []])),
    };
  };
}

// a /api/runbot route answering only the asked branches
export function runbotRoute(
  states: Record<string, { result: string; running: boolean; url: string }>,
) {
  return (body: unknown) => {
    const asked = (body as { branches?: string[] }).branches || [];
    return {
      states: Object.fromEntries(asked.filter((b) => states[b]).map((b) => [b, states[b]])),
    };
  };
}

// A tiny stateful git backend: /api/code/branches reads it, /api/code/checkout
// switches each repo's current branch (like the real checkout would).
export function gitBackend(repos: RepoStatusWire[]) {
  const byId = new Map(repos.map((r) => [r.id, structuredClone(r)]));
  return {
    repos: byId,
    routes: {
      "/api/code/branches": (body: unknown) => branchesRoute([...byId.values()])(body),
      "/api/code/checkout": (body: unknown) => {
        const asked = (body as { repos: { repo: string; branch: string }[] }).repos;
        for (const { repo: id, branch: b } of asked) {
          const r = byId.get(id);
          if (r) r.current = b;
        }
        return { results: asked.map((r) => ({ ok: true, branch: r.branch })) };
      },
    },
  };
}

// a JSON Response whose body only arrives once `release()` is called — holds an
// awaited request in flight so a test can observe the UI meanwhile
export function heldResponse(data: unknown): { response: Response; release(): void } {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) });
  return {
    response: new Response(stream, { headers: { "Content-Type": "application/json" } }),
    release() {
      ctrl.enqueue(new TextEncoder().encode(JSON.stringify(data)));
      ctrl.close();
    },
  };
}

// a /api/prs route answering every asked repo (like the backend), with the given
// PRs per repo id
export function prsRoute(prsByRepo: Record<string, unknown[]> = {}) {
  return (body: unknown) => ({
    repos: ((body as { repos?: { id: string; github?: string }[] }).repos || []).map((r) => ({
      id: r.id,
      github: r.github,
      prs: prsByRepo[r.id] || [],
    })),
  });
}
