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
  _capturing = false; // whether server lines are currently mirrored to the test console
  _finished = false; // guard: "test suite finished" is logged once per run
  _tags = ""; // current run's tags (for the deferred "running tests" log)
  _cutOnChrome = false; // WebSuite runs end the console window at the chrome teardown
  _result = ""; // "success" | "fail" — derived from the HOOT result lines

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
      if (!this.runActive()) return;
      // open the console window at the launch command line (the one right before the
      // test server boots) so the exact command used is shown in the tab
      if (!this._capturing && line.includes("[goo] starting odoo:")) this._capturing = true;
      if (!this._capturing) return;
      this.output.append(line);
      // remember the suite outcome as soon as HOOT reports it
      if (line.includes("[HOOT] Test suite succeeded")) this._result = "success";
      else if (line.includes("Some tests failed") || line.includes("[HOOT] Failed"))
        this._result = "fail";
      // surface each individual HOOT test failure as its own event
      const failed = line.match(/\[HOOT\] Test "(.+?)" failed/);
      if (failed) this.eventLog.add(`test failed: ${failed[1]}`);
      // for browser (WebSuite) runs the meaningful window ends when the browser is
      // torn down; everything after (thread dumps, shutdown noise) stays in the
      // Server tab only. Other test kinds keep streaming until the process stops.
      if (this._cutOnChrome && line.includes("Terminating chrome headless with pid"))
        this._finishRun();
    });
  }

  _onStatus(status) {
    const active = status.state === "starting" || status.state === "running";
    const testing = active && status.mode === "test";
    if (testing) {
      // the test server is up — announce the run. Mirroring usually already began
      // at the launch-command line (see onLine); this is a fallback if that line
      // wasn't seen. The old server's shutdown is intentionally not shown.
      if (!this.sawRun()) {
        this.sawRun.set(true);
        this.eventLog.add(`running tests (tags: ${this._tags})`);
        this._capturing = true;
      }
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
      // fallback for non-browser tests (no chrome line): use the exit code if HOOT
      // didn't report an outcome
      const byExit = status.exited_unexpectedly ? (status.returncode ? "fail" : "success") : "";
      this._finishRun(this._result || byExit);
      if (this._resumeAfter) {
        this._resumeAfter = false;
        this.server.resume(); // bring back the server that was stopped to test
      }
    }
  }

  // close the test-tab log window and log the finish event (once per run)
  _finishRun(result = this._result) {
    this._capturing = false;
    if (this._finished) return;
    this._finished = true;
    this.eventLog.add(`test run finished${result ? ` (${result})` : ""}`);
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
    // a real server is up; the one-shot run stops it first — resume after
    const serverWasUp = (s.state === "running" || s.state === "starting") && s.mode === "server";
    this._resumeAfter = serverWasUp;
    cfg.start.test_tags = tags.trim();
    this._pushHistory(tags);
    this._tags = tags.trim(); // logged once the test server is actually up
    this._cutOnChrome = this._tags.includes("web:WebSuite");
    this._result = "";
    // surface the stop as an event, but don't mirror its shutdown logs to the console
    if (serverWasUp) this.eventLog.add("stopping server to run tests");
    this.output.clear();
    this._capturing = false;
    this._finished = false;
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
