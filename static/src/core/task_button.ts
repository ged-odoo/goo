// The "Task" button: a link to the odoo.com task a branch / PR names (the first
// reference found in `texts`, see taskId), plus the task's stage when the optional
// Odoo task integration is on (TasksPlugin). Renders nothing when no task is named.

import { Component, usePlugin, useProps, useEffect, xml, t } from "@odoo/owl";
import type { Type } from "@odoo/owl";
import { TasksPlugin } from "./tasks_plugin.ts";
import type { TaskInfo } from "./tasks_plugin.ts";
import { taskId, taskUrl } from "./utils.ts";

// the pill's colour from the stage's name; Odoo stages are free text, so unknown ones stay plain
export function stageClass(stage: string): string {
  if (/cancel|refus|reject/i.test(stage)) return "merged";
  if (/done|closed|resolved|deliver|complete/i.test(stage)) return "ready";
  if (/progress|develop|dev\b|review|test|doing|ongoing/i.test(stage)) return "progress";
  if (/block|wait|hold/i.test(stage)) return "blocked";
  return "other";
}

export class TaskButton extends Component {
  // `ci`: drawn like the runbot / mergebot pills of the Workspaces header (a dot, no padding change)
  props = useProps({
    texts: t.any() as Type<(string | undefined)[]>,
    ci: t.boolean().optional(),
  });

  tasks = usePlugin(TasksPlugin);
  static template = xml`
    <a t-if="this.id" class="rev-task" t-att-class="this.cls" target="_blank" rel="noopener" t-att-href="this.url" t-att-title="this.title" t-on-click.stop=""><span t-if="this.props.ci" class="dash-ci-dot"/><t t-out="this.label"/><span class="rev-task-arrow">↗</span></a>`;

  setup(): void {
    useEffect(() => {
      if (this.id) this.tasks.want(this.id);
    });
  }

  get id(): string {
    return taskId(...this.props.texts);
  }

  get url(): string {
    return taskUrl(this.id);
  }

  get info(): TaskInfo | undefined {
    return this.tasks.tasks()[this.id];
  }

  // "Odoo: <stage>" once the stage is known, so it is not mistaken for the GitHub status
  get label(): string {
    if (this.info) return `Odoo: ${this.info.stage}`;
    return this.tasks.keyRejected() ? "Odoo: key expired?" : "Odoo task";
  }

  get cls(): string {
    const category = this.info
      ? stageClass(this.info.stage)
      : this.tasks.keyRejected()
        ? "blocked"
        : "other";
    return `${this.props.ci ? "dash-ci dash-mb" : "dash-pr-state"} ${category}`;
  }

  get title(): string {
    if (this.info) return `${this.info.name} — open the task on odoo.com`;
    if (this.tasks.keyRejected()) {
      return "Odoo rejects the API key (expired? odoo.com keys last 90 days at most): create a new one, see Configuration. Click to open the task on odoo.com";
    }
    return "open the task on odoo.com";
  }
}
