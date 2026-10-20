// The stage of the odoo.com tasks that branches / PRs name (see taskId in utils.ts).
// Opt-in (`odoo_tasks` setting): the backend (POST /api/tasks) reads them with the API
// key in its GOO_ODOO_API_KEY environment variable — the key never reaches the
// browser or the config file. Every TaskButton asks for its task with want(); the
// asks made within a few ms leave as one request.

import { ConfigPlugin } from "./config_plugin.ts";
import { errorMessage, postJSON } from "./utils.ts";

import { Plugin, usePlugin, signal, onWillDestroy } from "@odoo/owl";

export interface TaskInfo {
  name: string;
  stage: string;
}

interface TasksReply {
  ok: boolean;
  tasks?: Record<string, TaskInfo>;
  error?: string;
}

const BATCH_DELAY_MS = 30;

export class TasksPlugin extends Plugin {
  static sequence = 2; // after ConfigPlugin (1), whose `odoo_tasks` setting gates everything

  config = usePlugin(ConfigPlugin);
  tasks = signal<Record<string, TaskInfo>>({}); // task id -> its name and stage
  error = signal(""); // why the last request failed ("" when it worked)
  _asked = new Set<string>(); // ids already requested (answered or in flight)
  _queue: string[] = [];
  _timer: ReturnType<typeof setTimeout> | undefined;

  setup(): void {
    onWillDestroy(() => clearTimeout(this._timer));
  }

  get enabled(): boolean {
    return this.config.config.odoo_tasks;
  }

  // ask for a task's stage, once; a no-op when the feature is off
  want(id: string): void {
    if (!this.enabled || this._asked.has(id)) return;
    this._asked.add(id);
    this._queue.push(id);
    this._timer ??= setTimeout(() => this._flush(), BATCH_DELAY_MS);
  }

  // re-read every task asked for so far (the screens' Refresh)
  async reload(): Promise<void> {
    await this._request([...this._asked]);
  }

  // whether the backend can see the key, as the reason when it can't ("" when it can)
  async check(): Promise<string> {
    await this._request([]);
    return this.error();
  }

  // a failed request forgets its ids, so the next screen that wants them asks again
  async _flush(): Promise<void> {
    this._timer = undefined;
    const ids = this._queue.splice(0);
    if (!(await this._request(ids))) ids.forEach((id) => this._asked.delete(id));
  }

  // whether Odoo answered; an id it has no row for (unreadable, deleted) still counts as asked
  async _request(ids: string[]): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const res = await postJSON<TasksReply>("/api/tasks", { ids: ids.map(Number) });
      this.error.set(res.ok ? "" : res.error || "failed");
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
