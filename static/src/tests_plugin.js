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
  _resumeAfter = false; // a real server was running and got stopped to test

  // the target of the running/starting server — tests apply to it ("" if none)
  get target() {
    const s = this.server.status();
    return s.state === "running" || s.state === "starting" ? s.target || "" : "";
  }

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
      if (this._resumeAfter) {
        this._resumeAfter = false;
        this.server.resume(); // bring back the server that was stopped to test
      }
    }
  }

  get running() {
    const s = this.server.status();
    return (s.state === "starting" || s.state === "running") && s.mode === "test";
  }

  async run(tags) {
    if (!tags.trim()) return;
    const s = this.server.status();
    const cfg = this.server.buildStartConfig(this.target);
    if (!cfg) return this.server.log(`[oo] no running server target to test`);
    // a real server is up; it will be stopped for the one-shot test — resume after
    this._resumeAfter = (s.state === "running" || s.state === "starting") && s.mode === "server";
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
