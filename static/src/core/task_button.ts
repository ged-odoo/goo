// The "Task" button: a link to the odoo.com task a branch / PR names (the first
// reference found in `texts`, see taskId), plus the task's stage when the optional
// Odoo task integration is on (TasksPlugin). Renders nothing when no task is named.

import { Component, usePlugin, useProps, useEffect, xml, t } from "@odoo/owl";
import type { Type } from "@odoo/owl";
import { ICONS, m } from "./common.ts";
import { TasksPlugin } from "./tasks_plugin.ts";
import type { TaskInfo } from "./tasks_plugin.ts";
import { taskId, taskUrl } from "./utils.ts";

export class TaskButton extends Component {
  props = useProps({ texts: t.any() as Type<(string | undefined)[]> });
  tasks = usePlugin(TasksPlugin);
  externalIcon = m(ICONS.external);
  static template = xml`
    <t t-if="this.id">
      <a class="pbtn ghost rev-task" target="_blank" rel="noopener" t-att-href="this.url" title="open the odoo.com task" t-on-click.stop=""><t t-out="this.externalIcon"/>Task</a>
      <span t-if="this.info" class="pr-state task-stage" t-att-title="this.info.name" t-out="this.info.stage"/>
      <span t-elif="this.tasks.keyRejected()" class="pr-state task-stage" title="Odoo rejects the API key (expired? odoo.com keys last 90 days at most): create a new one, see Configuration">key expired?</span>
    </t>`;

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
}
