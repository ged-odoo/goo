// Run `odoo-bin --test-tags …` against a target (via the shared process).

import { ConfigPlugin, TEST_HISTORY_KEY } from "./config_plugin.js";
import { ServerPlugin } from "./server_plugin.js";
import { EventLogPlugin } from "./event_log_plugin.js";
import { LogBuffer } from "./log_buffer.js";
import { postJSON } from "./utils.js";

const { Plugin, plugin, useEffect, signal } = owl;

const HISTORY_MAX = 10;

export class TestsPlugin extends Plugin {
  static sequence = 3;

  config = plugin(ConfigPlugin);
  server = plugin(ServerPlugin);
  eventLog = plugin(EventLogPlugin);
  output = new LogBuffer();
  status = signal("");
  runActive = signal(false);
  sawRun = signal(false);
  history = signal(this._readHistory()); // last test tags run, most recent first
  _resumeAfter = false; // a real server was running and got stopped to test

  _readHistory() {
    try {
      const h = JSON.parse(this.config.read(TEST_HISTORY_KEY));
      return Array.isArray(h) ? h : [];
    } catch {
      return [];
    }
  }

  // record a run's tag at the front, deduped, capped at HISTORY_MAX
  _pushHistory(tag) {
    tag = tag.trim();
    if (!tag) return;
    const h = [tag, ...this.history().filter((t) => t !== tag)].slice(0, HISTORY_MAX);
    this.history.set(h);
    this.config.write(TEST_HISTORY_KEY, JSON.stringify(h));
  }

  // the target tests run against: the running/starting server's target, else
  // the last-used one, else the first configured target. Tests are a one-shot
  // run against the target's db, so they work even with the server down.
  // the active target id: the running server's, else the last-used one, else the
  // first configured target (buildStartConfig resolves it by id)
  get target() {
    const targets = this.config.config.targets;
    const candidate = this.server.status().target || this.server.lastTarget();
    if (targets.some((t) => t.id === candidate)) return candidate;
    return targets[0]?.id || "";
  }

  setup() {
    useEffect(() => this._onStatus(this.server.status()));
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
    if (!cfg) return this.server.log(`[goo] no valid target to test`);
    // a real server is up; it will be stopped for the one-shot test — resume after
    this._resumeAfter = (s.state === "running" || s.state === "starting") && s.mode === "server";
    cfg.start.test_tags = tags.trim();
    this._pushHistory(tags);
    this.eventLog.add(`running tests (tags: ${tags.trim()})`);
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
