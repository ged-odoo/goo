// The stage of the odoo.com tasks that branches / PRs name (see taskId in utils.ts).
// Opt-in (`odoo_tasks` setting): the backend (POST /api/tasks) reads them with the API
// key in its GOO_ODOO_API_KEY environment variable — the key never reaches the
// browser or the config file. Every TaskButton asks for its task with want(); the
// asks made within a few ms leave as one request.

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
  key_rejected?: boolean; // Odoo answered 401: the key is wrong or has expired
}

const BATCH_DELAY_MS = 30;
const RETRY_AFTER_MS = 60_000; // a failed task is not asked again before this

export class TasksPlugin extends Plugin {
  static sequence = 2; // after ConfigPlugin (1), whose `odoo_tasks` setting gates everything

  config = usePlugin(ConfigPlugin);
  eventLog = usePlugin(EventLogPlugin);
  tasks = signal<Record<string, TaskInfo>>({}); // task id -> its name and stage
  error = signal(""); // why the last request failed ("" when it worked)
  keyRejected = signal(false); // Odoo refused the key (odoo.com keys expire after 90 days)
  _warned = false; // the event log hears about a rejected key once per session
  details = signal<Record<string, TaskDetailState>>({}); // task id -> its Task tab content
  _asked = new Set<string>(); // ids already requested (answered, in flight or failed)
  _failedAt = new Map<string, number>(); // ids whose last request failed -> when
  _queue: string[] = [];
  _timer: ReturnType<typeof setTimeout> | undefined;

  setup(): void {
    onWillDestroy(() => clearTimeout(this._timer));
  }

  get enabled(): boolean {
    return this.config.config.odoo_tasks;
  }

  // ask for a task's stage, once; a no-op when the feature is off. A task whose request
  // failed is asked again only after a minute, so an outage is not hammered by every
  // re-render (a rejected key is never asked again: see _flush)
  want(id: string): void {
    if (!this.enabled) return;
    if (this._asked.has(id)) {
      const failedAt = this._failedAt.get(id);
      if (failedAt === undefined || Date.now() - failedAt < RETRY_AFTER_MS) return;
      this._failedAt.delete(id);
    }
    this._asked.add(id);
    this._queue.push(id);
    this._timer ??= setTimeout(() => this._flush(), BATCH_DELAY_MS);
  }

  // re-read every task asked for so far (the screens' Refresh)
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

  // whether the backend can see the key, as the reason when it can't ("" when it can)
  async check(): Promise<string> {
    await this._request([]);
    return this.error();
  }

  async _flush(): Promise<void> {
    this._timer = undefined;
    const ids = this._queue.splice(0);
    // (a rejected key is not worth asking again: only a new key, so a restart, changes that)
    if (!(await this._request(ids)) && !this.keyRejected()) {
      ids.forEach((id) => this._failedAt.set(id, Date.now()));
    }
  }

  // whether Odoo answered; an id it has no row for (unreadable, deleted) still counts as asked
  async _request(ids: string[]): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const res = await postJSON<TasksReply>("/api/tasks", { ids: ids.map(Number) });
      this.error.set(res.ok ? "" : res.error || "failed");
      this.keyRejected.set(!!res.key_rejected);
      if (res.key_rejected && !this._warned) {
        this._warned = true;
        this.eventLog.add(`Odoo task stages: ${res.error}`, "", "error");
      }
      if (res.tasks && Object.keys(res.tasks).length) {
        this.tasks.set({ ...this.tasks(), ...res.tasks });
      }
      return res.ok;
    } catch (e) {
      this.error.set(errorMessage(e));
      return false;
    }
  }
}
