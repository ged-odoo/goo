// The workspace's Task tab: the odoo.com task its branch / PR names, read-only, for
// documentation — main fields, description and chatter (opt-in, see TasksPlugin).

import { Component, usePlugin, useProps, useEffect, xml, t } from "@odoo/owl";
import { stageClass } from "../core/task_button.ts";
import { TASK_FRAME_SANDBOX, odooDate, taskDocument } from "../core/task_document.ts";
import { TasksPlugin } from "../core/tasks_plugin.ts";
import type { TaskDetailState } from "../core/tasks_plugin.ts";
import { taskUrl } from "../core/utils.ts";

export class TaskPane extends Component {
  props = useProps({ id: t.string() });
  tasks = usePlugin(TasksPlugin);
  sandbox = TASK_FRAME_SANDBOX;
  static template = xml`
    <div class="task-pane">
      <div t-if="this.state.task" class="task-head">
        <b class="task-title" t-out="this.state.task.name"/>
        <span t-if="this.state.task.stage" class="dash-pr-state" t-att-class="this.stageCls" t-out="'Odoo: ' + this.state.task.stage"/>
        <span class="wt-sp"/>
        <button class="pbtn ghost" t-on-click="() => this.tasks.loadDetail(this.props.id, true)">Refresh</button>
        <a class="pbtn ghost" target="_blank" rel="noopener" t-att-href="this.url">Open on odoo.com ↗</a>
      </div>
      <div t-if="this.state.task" class="task-facts">
        <t t-foreach="this.facts" t-as="fact" t-key="fact[0]">
          <span class="dim" t-out="fact[0]"/><span t-out="fact[1]"/>
        </t>
      </div>
      <iframe t-if="this.state.task" class="task-doc" t-att-sandbox="this.sandbox" t-att-srcdoc="this.doc"/>
      <div t-elif="this.state.error" class="ws-pane-hint dim">
        <span t-out="this.state.error"/>
        <button class="pbtn" t-on-click="() => this.tasks.loadDetail(this.props.id, true)">Retry</button>
      </div>
      <div t-else="" class="ws-pane-hint dim">Loading the task…</div>
    </div>`;

  setup(): void {
    useEffect(() => {
      this.tasks.loadDetail(this.props.id);
    });
  }

  get state(): TaskDetailState {
    return this.tasks.details()[this.props.id] || {};
  }

  get url(): string {
    return taskUrl(this.props.id);
  }

  get stageCls(): string {
    return stageClass(this.state.task?.stage ?? "");
  }

  get doc(): string {
    return this.state.task ? taskDocument(this.state.task) : "";
  }

  // the main fields, the empty ones left out
  get facts(): [string, string][] {
    const task = this.state.task;
    if (!task) return [];
    const facts: [string, string][] = [
      ["Project", task.project],
      ["Assigned to", task.assignees.join(", ")],
      ["Customer", task.customer],
      ["Deadline", odooDate(task.deadline)],
      ["Priority", task.priority],
      ["Tags", task.tags.join(", ")],
      ["Parent task", task.parent],
      ["Created", [odooDate(task.created), task.created_by].filter(Boolean).join(" · by ")],
      ["Updated", odooDate(task.updated)],
    ];
    return facts.filter(([, value]) => value);
  }
}
