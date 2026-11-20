// The stage of the odoo.com tasks that branches / PRs name (see taskId in utils.ts).
// Opt-in (`odoo_tasks` setting): the backend (POST /api/tasks) reads them with the
// odoo.com session cookie goo's browser extension pushes it (POST
// /api/odoo-session) — the session never reaches this page or the config file.
// Every TaskButton asks for its task with want(); the asks made within a few ms
// leave as one request. A task is only ever asked for once on its own (a new one
// appearing) or re-asked by an explicit Refresh — never polled or auto-retried. Its
// last-known name/stage is cached in localStorage, so a reload of the page repaints
// every already-seen task instantly, with no call to odoo.com — only a task this
// browser has genuinely never seen before triggers one, until the next Refresh.

import { ConfigPlugin } from "./config_plugin.ts";
import { EventLogPlugin } from "./event_log_plugin.ts";
import { errorMessage, postJSON } from "./utils.ts";

import { Plugin, usePlugin, signal, onWillDestroy } from "@odoo/owl";

export interface TaskInfo {
  name: string;
  stage: string;
}

// one task in full, for the workspace's Task tab (backend TaskService.detail)
export interface TaskMessage {
  id: number;
  date: string;
  author: string;
  kind: string; // the subtype: "Discussions", "Note", …
  body: string; // HTML from Odoo
}

export interface TaskDetail {
  id: number;
  name: string;
  project: string;
  stage: string;
  assignees: string[];
  tags: string[];
  customer: string;
  deadline: string;
  priority: string;
  parent: string;
  created: string;
  updated: string;
  created_by: string;
  description: string; // HTML from Odoo
  messages: TaskMessage[]; // newest first
  messages_error: string; // why the chatter could not be read ("" when it could)
  messages_cut: boolean; // older messages were left out
}

// where the detail of a task stands: loading, loaded or failed
export interface TaskDetailState {
  task?: TaskDetail;
  error?: string;
  loading?: boolean;
}

interface TasksReply {
  ok: boolean;
  tasks?: Record<string, TaskInfo>;
  error?: string;
  session_rejected?: boolean; // Odoo answered 401: the session is expired or logged out
}

const BATCH_DELAY_MS = 30;
const CACHE_KEY = "oo-tasks-cache"; // task id -> its last-known {name, stage}

export class TasksPlugin extends Plugin {
  static sequence = 2; // after ConfigPlugin (1), whose `odoo_tasks` setting gates everything

  config = usePlugin(ConfigPlugin);
  eventLog = usePlugin(EventLogPlugin);
  tasks = signal<Record<string, TaskInfo>>({}); // task id -> its name and stage
  error = signal(""); // why the last request failed ("" when it worked)
  sessionRejected = signal(false); // Odoo refused the session (expired, or logged out)
  _warned = false; // the event log hears about a rejected session once per session
  details = signal<Record<string, TaskDetailState>>({}); // task id -> its Task tab content
  _asked = new Set<string>(); // ids already requested (answered, in flight or failed)
  _queue: string[] = [];
  _timer: ReturnType<typeof setTimeout> | undefined;

  setup(): void {
    // instant paint from last session's cache; a cached id counts as already
    // asked, so want() leaves it alone until an explicit Refresh re-validates it
    const cached = this._loadCache();
    if (Object.keys(cached).length) {
      this.tasks.set(cached);
      for (const id of Object.keys(cached)) this._asked.add(id);
    }
    onWillDestroy(() => clearTimeout(this._timer));
  }

  _loadCache(): Record<string, TaskInfo> {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null");
      return parsed && typeof parsed === "object" ? (parsed as Record<string, TaskInfo>) : {};
    } catch {
      return {};
    }
  }

  get enabled(): boolean {
    return this.config.config.odoo_tasks;
  }

  // ask for a task's stage, once; a no-op when the feature is off or this id was
  // already asked (whether that answered, is still in flight, or failed) — a failed
  // one is only ever retried by the screens' explicit Refresh (reload()), never on
  // its own, so a stretch with no odoo.com session open stays quiet instead of
  // pinging odoo.com on every re-render
  want(id: string): void {
    if (!this.enabled || this._asked.has(id)) return;
    this._asked.add(id);
    this._queue.push(id);
    this._timer ??= setTimeout(() => this._flush(), BATCH_DELAY_MS);
  }

  // re-read every task asked for so far, including a previously failed one (the
  // screens' Refresh — the only way a failure is retried)
  async reload(): Promise<void> {
    await this._request([...this._asked]);
  }

  // the Task tab's content: read once per session (one request for the task and its chatter);
  // again only on `force` (the tab's Refresh / Retry) — a failure is never retried by itself
  async loadDetail(id: string, force = false): Promise<void> {
    const have = this.details()[id];
    if (!this.enabled || have?.loading || (have && !force)) return;
    const set = (state: TaskDetailState) => this.details.set({ ...this.details(), [id]: state });
    set({ ...have, loading: true });
    try {
      const res = await postJSON<{ ok: boolean; task?: TaskDetail; error?: string }>(
        "/api/tasks/detail",
        { id: Number(id) },
      );
      set(res.ok && res.task ? { task: res.task } : { error: res.error || "failed" });
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  }

  // whether the backend has a working session, as the reason when it doesn't ("" when it does)
  async check(): Promise<string> {
    await this._request([]);
    return this.error();
  }

  async _flush(): Promise<void> {
    this._timer = undefined;
    const ids = this._queue.splice(0);
    await this._request(ids);
  }

  // whether Odoo answered; an id it has no row for (unreadable, deleted) still counts as asked
  async _request(ids: string[]): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const res = await postJSON<TasksReply>("/api/tasks", { ids: ids.map(Number) });
      this.error.set(res.ok ? "" : res.error || "failed");
      this.sessionRejected.set(!!res.session_rejected);
      if (res.session_rejected && !this._warned) {
        this._warned = true;
        this.eventLog.add(`Odoo task stages: ${res.error}`, "", "error");
      }
      if (res.tasks && Object.keys(res.tasks).length) {
        const merged = { ...this.tasks(), ...res.tasks };
        this.tasks.set(merged);
        localStorage.setItem(CACHE_KEY, JSON.stringify(merged));
      }
      return res.ok;
    } catch (e) {
      this.error.set(errorMessage(e));
      return false;
    }
  }
}
