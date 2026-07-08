// Run `odoo-bin --test-tags …` against a workspace's server slot. State is kept
// PER SLOT ("main" | a worktree workspace id): each slot has its own console
// buffer, status badge and capture window, so a worktree run and a main run can
// stream concurrently without corrupting each other. The Workspaces screen's
// Tests pane passes a workspace to address its slot.

import { ConfigPlugin } from "./config_plugin.js";
import { StorePlugin } from "./store_plugin.js";
import { ServerPlugin } from "./server_plugin.js";
import { EventLogPlugin } from "./event_log_plugin.js";
import { LogBuffer } from "./log_buffer.js";
import { postJSON } from "./utils.js";

import { Plugin, plugin, useEffect, signal } from "@odoo/owl";

const HISTORY_MAX = 10;

// the server slot a workspace's runs occupy
export function slotFor(ws) {
  return ws && ws.location === "worktree" ? ws.id : "main";
}

// goo's worktree orchestration echoes in the MAIN log (another workspace's server
// starting/stopping) — kept out of the main-slot test/addons consoles
export const WT_ECHO_RE = /\[goo\] (starting|stopping|error stopping) worktree/;

export class TestsPlugin extends Plugin {
  static sequence = 3;

  config = plugin(ConfigPlugin);
  store = plugin(StorePlugin); // one-shot runs live in the shared store's runs map
  server = plugin(ServerPlugin);
  eventLog = plugin(EventLogPlugin);
  history = signal(this._readHistory()); // last test tags run, most recent first (global)
  _failSeq = 0; // monotonic id source for failure-row anchors (global, never reset)
  _slots = new Map(); // slotId -> per-slot run/console state

  // the per-slot state record, lazily created
  slot(id = "main") {
    if (!this._slots.has(id)) {
      this._slots.set(id, {
        output: new LogBuffer(),
        status: signal(""),
        pending: signal(false), // optimistic "run starting", until the "run" event lands
        capturing: false, // whether this slot's lines are mirrored to its console
        finished: false, // guard: "test suite finished" is logged once per run
        tags: "", // current run's tags (for the deferred "running tests" log)
        cutOnChrome: false, // WebSuite runs end the console window at chrome teardown
        result: "", // "success" | "fail" — derived from the HOOT result lines
        announced: null, // run id we've logged "running tests" for (once per run)
        finishedRun: null, // run id we've finalized (once per run)
      });
    }
    return this._slots.get(id);
  }

  // main-slot console alias — the event log's [jump] pins its autoscroll
  get output() {
    return this.slot("main").output;
  }

  runningFor(slotId) {
    return this.currentRun(slotId)?.state === "running";
  }

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

  // the current/last test run on a slot (backend-minted, from the shared store)
  currentRun(slotId = "main") {
    return this.store.latestRunOfKind("test", slotId);
  }

  // a test run is active on a slot — optimistically true between clicking Run and
  // the backend's first "run" event, then driven by the run's state
  runActive(slotId = "main") {
    return this.slot(slotId).pending() || this.currentRun(slotId)?.state === "running";
  }

  setup() {
    // per-slot run dispatch: react to the LATEST test run of every slot that has
    // one (dispatching per raw record would re-finalize superseded runs — the
    // finishedRun guard holds one id per slot)
    useEffect(() => {
      const slots = new Set(
        this.store
          .runs()
          .filter((d) => d.kind === "test")
          .map((d) => d.server ?? "main"),
      );
      for (const s of slots) this._onRun(s, this.currentRun(s));
    });
    // both output streams feed the same capture pipeline: the main server's log
    // lines, and each worktree server's own stream (keyed by workspace id). For a
    // worktree slot this mirrors lines already going to its Server-logs buffer —
    // intentionally, like the main test console mirrors the main server log.
    this.server.onLine((line) => this._capture("main", line));
    this.server.onWorktreeLog(({ target, line }) => this._capture(target, line));
  }

  _capture(slotId, line) {
    if (!this.runActive(slotId)) return;
    if (slotId === "main" && WT_ECHO_RE.test(line)) return; // another workspace's echo
    const s = this.slot(slotId);
    // open the console window at the launch command line (main only — a worktree
    // run's launch line goes to the main log; its capture opens in _onRun when the
    // run event lands, which precedes the worktree server's first output)
    if (!s.capturing && slotId === "main" && line.includes("[goo] starting odoo:"))
      s.capturing = true;
    if (!s.capturing) return;
    // a failing HOOT test gets a DOM anchor on its row so the event log entry can
    // scroll the console straight to it (main slot only — the [jump] link opens
    // the loaded workspace's Tests pane; worktree failures get a plain error row)
    const failed = line.match(/\[HOOT\] Test "(.+?)" failed/);
    const anchor = failed && slotId === "main" ? `test-fail-${++this._failSeq}` : "";
    s.output.append(line, anchor);
    if (failed) this.eventLog.add(`test failed: ${failed[1]}`, anchor, "error");
    // remember the suite outcome as soon as HOOT reports it
    if (line.includes("[HOOT] Test suite succeeded")) s.result = "success";
    else if (line.includes("Some tests failed") || line.includes("[HOOT] Failed"))
      s.result = "fail";
    // for browser (WebSuite) runs the meaningful window ends when the browser is
    // torn down; everything after (thread dumps, shutdown noise) stays in the
    // server log only. Other test kinds keep streaming until the process stops.
    if (s.cutOnChrome && line.includes("Terminating chrome headless with pid"))
      this._finishRun(slotId);
  }

  // react to a slot's backend-minted test Run moving running → done/failed.
  // Resume-after (bringing back a server the run interrupted) is owned by the
  // backend; this just drives the console + event log. Announce/finalize once per
  // run id per slot.
  _onRun(slotId, run) {
    if (!run) return;
    const s = this.slot(slotId);
    if (run.state === "running") {
      s.pending.set(false); // the real run is in — drop the optimistic override
      if (s.announced !== run.id) {
        s.announced = run.id;
        // main: mirroring usually began at the launch-command line (see _capture);
        // this is the fallback announce. Worktree slots START capturing here — and
        // get the announce line in their console, compensating for the launch echo
        // that only the main log carries.
        this.eventLog.add(`running tests (tags: ${run.spec?.tags ?? s.tags})`);
        if (slotId !== "main" && !s.capturing)
          s.output.append(`[goo] running tests (tags: ${run.spec?.tags ?? s.tags})`);
        s.capturing = true;
      }
      s.status.set("running…");
    } else if (s.finishedRun !== run.id) {
      // done | failed. run.returncode is null when the run was stopped manually.
      s.finishedRun = run.id;
      // if we never saw it running this session (e.g. it finished before a reload),
      // don't re-announce a stale result — matches the pre-run-model reload behavior
      if (s.announced !== run.id) return;
      const stopped = run.returncode === null;
      s.status.set(
        stopped ? "stopped" : run.returncode ? `failed — exit ${run.returncode}` : "passed",
      );
      // fallback for non-browser tests (no chrome line): use the exit code if HOOT
      // didn't report an outcome
      const byExit = stopped ? "" : run.returncode ? "fail" : "success";
      this._finishRun(slotId, s.result || byExit);
    }
  }

  // close a slot's test-log window and log the finish event (once per run)
  _finishRun(slotId, result = this.slot(slotId).result) {
    const s = this.slot(slotId);
    s.capturing = false;
    if (s.finished) return;
    s.finished = true;
    const failed = result && String(result).includes("fail");
    this.eventLog.add(
      `test run finished${result ? ` (${result})` : ""}`,
      "",
      failed ? "error" : "",
    );
  }

  // run tests against a workspace's slot (the Tests pane passes its workspace)
  async run(tags, ws) {
    if (!tags.trim() || !ws) return;
    const slotId = slotFor(ws);
    const targetId = ws.id;
    const s = this.slot(slotId);
    // a real server is up on the slot; the backend stops it for the one-shot run
    // and resumes it when the run ends (resume-after is backend-owned)
    const up =
      slotId === "main"
        ? (() => {
            const st = this.server.status();
            return (st.state === "running" || st.state === "starting") && st.mode === "server";
          })()
        : ["running", "starting"].includes(this.store.server(slotId)?.state);
    this._pushHistory(tags);
    s.tags = tags.trim(); // logged once the test server is actually up
    s.cutOnChrome = s.tags.includes("web:WebSuite");
    s.result = "";
    // surface the stop as an event, but don't mirror its shutdown logs to the console
    if (up) this.eventLog.add("stopping server to run tests");
    s.output.clear();
    s.capturing = false;
    s.finished = false;
    s.pending.set(true);
    s.status.set("starting…");
    try {
      // the server resolves the launch config from the target + overrides, and
      // runs it on the given workspace slot
      await postJSON("/api/tests/run", {
        target: targetId,
        workspace: slotId,
        overrides: { test_tags: s.tags },
      });
    } catch (e) {
      s.pending.set(false);
      s.status.set(`failed to start: ${e.message}`);
    }
  }
}
