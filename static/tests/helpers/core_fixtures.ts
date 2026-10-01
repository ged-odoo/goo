// Fixtures for testing core plugins over a fake backend: a recording EventSource (to
// push SSE events into the plugin that opened it), a fetch stub, and a workspace.
import { vi } from "vitest";
import type { WorkspaceConfig } from "../../src/core/config.ts";

type Handler = (e: { data: string }) => void;

// records the EventSource the plugin opens, so a test can push events through it
export class RecordingEventSource {
  static last: RecordingEventSource;
  url: string;
  listeners: Record<string, Handler[]> = {};
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    RecordingEventSource.last = this;
  }

  addEventListener(type: string, cb: Handler): void {
    (this.listeners[type] ??= []).push(cb);
  }

  close(): void {}
  emit(type: string, data: unknown): void {
    for (const cb of this.listeners[type] || []) cb({ data: JSON.stringify(data) });
  }
}

export function workspace(
  id: string,
  name: string,
  branch = "master",
  extra: Partial<WorkspaceConfig> = {},
): WorkspaceConfig {
  return {
    id,
    name,
    created_at: "2026-01-01T00:00:00.000Z",
    last_activity: "2026-01-01T00:00:00.000Z",
    favorite: false,
    category: "",
    parent: "",
    notes: "",
    db: "db1",
    on_create_args: "",
    demo_data: false,
    location: "main",
    worktree: null,
    port: null,
    checkouts: [{ repo: "community", branch }],
    ...extra,
  };
}

export interface Call {
  path: string;
  body: unknown;
}

// a fake backend: `replies` per path (a Response for an error), every call recorded
export function stubBackend(replies: Record<string, unknown> = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input).split("?")[0];
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const r = replies[path];
      if (r instanceof Response) return r;
      return new Response(JSON.stringify(r ?? { ok: true }), { status: 200 });
    }),
  );
  return calls;
}
