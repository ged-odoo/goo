// Run `odoo-bin --test-tags …` against a target (via the shared process).

import { ConfigPlugin } from "./config_plugin.js";
import { StorePlugin } from "./store_plugin.js";
import { ServerPlugin } from "./server_plugin.js";
import { EventLogPlugin } from "./event_log_plugin.js";
import { LogBuffer } from "./log_buffer.js";
import { postJSON } from "./utils.js";

import { Plugin, plugin, useEffect, signal } from "@odoo/owl";

const HISTORY_MAX = 10;

export class TestsPlugin extends Plugin {
  static sequence = 3;

  config = plugin(ConfigPlugin);
  store = plugin(StorePlugin); // one-shot runs live in the shared store's runs map
  server = plugin(ServerPlugin);
  eventLog = plugin(EventLogPlugin);
  output = new LogBuffer();
  status = signal("");
  history = signal(this._readHistory()); // last test tags run, most recent first
  _pending = signal(false); // optimistic "run starting", until the backend's "run" event lands
  _capturing = false; // whether server lines are currently mirrored to the test console
  _finished = false; // guard: "test suite finished" is logged once per run
  _tags = ""; // current run's tags (for the deferred "running tests" log)
  _cutOnChrome = false; // WebSuite runs end the console window at the chrome teardown
  _result = ""; // "success" | "fail" — derived from the HOOT result lines
  _failSeq = 0; // monotonic id source for failure-row anchors (never reset)
  _announced = null; // run id we've logged "running tests" for (once per run)
  _finishedRun = null; // run id we've finalized (once per run)

  _readHistory() {
    const h = this.config.getState("test_history", []);
    return Array.isArray(h) ? h : [];
  }

  // record a run's tag at the front, deduped, capped at HISTORY_MAX
  _pushHistory(tag) {
    tag = tag.trim();
    if (!tag) return;
    const h = [tag, ...this.history().filter((t) => t !== tag)].slice(0, HISTORY_MAX);
    this.history.set(h);
    this.config.setState("test_history", h);
  }

  // the target id tests run against: the running/starting server's target, else the
  // last-used one, else the first configured target. Tests are a one-shot run against
  // the target's db, so they work even with the server down; the run endpoint resolves
  // the launch config from this id server-side.
  get target() {
    const targets = this.config.config.targets;
    const candidate = this.server.status().target || this.server.lastTarget();
    if (targets.some((t) => t.id === candidate)) return candidate;
    return targets[0]?.id || "";
  }

  // the current/last test run (backend-minted, from the shared store)
  currentRun() {
    return this.store.latestRunOfKind("test");
  }

  // a test run is active — optimistically true between clicking Run and the backend's
  // first "run" event, then driven by the run's state (a method: components call it)
  runActive() {
    return this._pending() || this.currentRun()?.state === "running";
  }

  setup() {
    useEffect(() => this._onRun(this.currentRun()));
    this.server.onLine((line) => {
      if (!this.runActive()) return;
      // open the console window at the launch command line (the one right before the
      // test server boots) so the exact command used is shown in the tab
      if (!this._capturing && line.includes("[goo] starting odoo:")) this._capturing = true;
      if (!this._capturing) return;
      // a failing HOOT test gets a DOM anchor on its row so the event log entry
      // can scroll the console straight to it
      const failed = line.match(/\[HOOT\] Test "(.+?)" failed/);
      const anchor = failed ? `test-fail-${++this._failSeq}` : "";
      this.output.append(line, anchor);
      if (failed) this.eventLog.add(`test failed: ${failed[1]}`, anchor, "error");
      // remember the suite outcome as soon as HOOT reports it
      if (line.includes("[HOOT] Test suite succeeded")) this._result = "success";
      else if (line.includes("Some tests failed") || line.includes("[HOOT] Failed"))
        this._result = "fail";
      // for browser (WebSuite) runs the meaningful window ends when the browser is
      // torn down; everything after (thread dumps, shutdown noise) stays in the
      // Server tab only. Other test kinds keep streaming until the process stops.
      if (this._cutOnChrome && line.includes("Terminating chrome headless with pid"))
        this._finishRun();
    });
  }

  // react to the backend-minted test Run moving running → done/failed. Resume-after
  // (bringing back a server the run interrupted) is owned by the backend now, so this
  // just drives the console + event log. Announce/finalize once per run id.
  _onRun(run) {
    if (!run) return;
    if (run.state === "running") {
      this._pending.set(false); // the real run is in — drop the optimistic override
      if (this._announced !== run.id) {
        this._announced = run.id;
        // usually mirroring already began at the launch-command line (see onLine);
        // this is the fallback announce if that line wasn't seen
        this.eventLog.add(`running tests (tags: ${run.spec?.tags ?? this._tags})`);
        this._capturing = true;
      }
      this.status.set("running…");
    } else if (this._finishedRun !== run.id) {
      // done | failed. run.returncode is null when the run was stopped manually.
      this._finishedRun = run.id;
      // if we never saw it running this session (e.g. it finished before a reload),
      // don't re-announce a stale result — matches the pre-run-model reload behavior
      if (this._announced !== run.id) return;
      const stopped = run.returncode === null;
      this.status.set(
        stopped ? "stopped" : run.returncode ? `failed — exit ${run.returncode}` : "passed",
      );
      // fallback for non-browser tests (no chrome line): use the exit code if HOOT
      // didn't report an outcome
      const byExit = stopped ? "" : run.returncode ? "fail" : "success";
      this._finishRun(this._result || byExit);
    }
  }

  // close the test-tab log window and log the finish event (once per run)
  _finishRun(result = this._result) {
    this._capturing = false;
    if (this._finished) return;
    this._finished = true;
    const failed = result && String(result).includes("fail");
    this.eventLog.add(
      `test run finished${result ? ` (${result})` : ""}`,
      "",
      failed ? "error" : "",
    );
  }

  get running() {
    return this.currentRun()?.state === "running";
  }

  async run(tags) {
    if (!tags.trim()) return;
    const targetId = this.target;
    if (!targetId) return this.server.log(`[goo] no valid target to test`);
    // a real server is up; the backend stops it for the one-shot run and resumes it
    // when the run ends (resume-after is backend-owned now — no client flag)
    const s = this.server.status();
    const serverWasUp = (s.state === "running" || s.state === "starting") && s.mode === "server";
    this._pushHistory(tags);
    this._tags = tags.trim(); // logged once the test server is actually up
    this._cutOnChrome = this._tags.includes("web:WebSuite");
    this._result = "";
    // surface the stop as an event, but don't mirror its shutdown logs to the console
    if (serverWasUp) this.eventLog.add("stopping server to run tests");
    this.output.clear();
    this._capturing = false;
    this._finished = false;
    this._pending.set(true);
    this.status.set("starting…");
    try {
      // the server resolves the launch config from the target + overrides
      await postJSON("/api/tests/run", { target: targetId, overrides: { test_tags: this._tags } });
    } catch (e) {
      this._pending.set(false);
      this.status.set(`failed to start: ${e.message}`);
    }
  }
}
