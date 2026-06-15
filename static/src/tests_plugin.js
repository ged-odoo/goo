// Run `odoo-bin --test-tags …` against a target (via the shared process).

import { ServerPlugin } from "./server_plugin.js";
import { LogBuffer } from "./log_buffer.js";
import { postJSON } from "./utils.js";

const { Plugin, plugin, effect, signal } = owl;

export class TestsPlugin extends Plugin {
  static sequence = 3;

  server = plugin(ServerPlugin);
  output = new LogBuffer();
  status = signal("");
  runActive = signal(false);
  sawRun = signal(false);

  setup() {
    effect(() => this._onStatus(this.server.status()));
    this.server.onLine((line) => {
      if (this.runActive()) this.output.append(line);
    });
  }

  _onStatus(status) {
    const active = status.state === "starting" || status.state === "running";
    const testing = active && status.mode === "test";
    if (testing) {
      this.sawRun.set(true);
      this.status.set("running…");
    } else if (this.runActive() && this.sawRun() && status.state === "stopped") {
      this.runActive.set(false);
      this.sawRun.set(false);
      this.status.set(
        status.exited_unexpectedly
          ? status.returncode
            ? `failed — exit ${status.returncode}`
            : "passed"
          : "stopped",
      );
    }
  }

  get running() {
    const s = this.server.status();
    return (s.state === "starting" || s.state === "running") && s.mode === "test";
  }

  async run(targetId, tags) {
    const cfg = this.server.buildStartConfig(targetId);
    if (!cfg) return this.server.log(`[oo] no such target: "${targetId}"`);
    if (!tags.trim()) return;
    cfg.start.test_tags = tags.trim();
    this.output.clear();
    this.runActive.set(true);
    this.sawRun.set(false);
    this.status.set("starting…");
    try {
      await postJSON("/api/tests/run", cfg);
    } catch (e) {
      this.runActive.set(false);
      this.status.set(`failed to start: ${e.message}`);
    }
  }
}
