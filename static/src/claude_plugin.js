// A headless Claude conversation per worktree target. "Send" spawns `claude -p` on
// the backend with the worktree's checkout as its cwd (full autonomy — it edits and
// runs commands there, never touching the main tree), and its assistant text + tool
// activity stream back live over the "claude" SSE event (relayed by ServerPlugin).
// Per-target transcripts are kept here (and mirrored on the backend so a page reload
// re-primes them via /api/worktree/claude/history). The backend owns the resumable
// session id, so a conversation just continues turn after turn.

import { ConfigPlugin } from "./config_plugin.js";
import { ServerPlugin } from "./server_plugin.js";
import { WorktreePlugin } from "./worktree_plugin.js";
import { EventLogPlugin } from "./event_log_plugin.js";
import { DialogPlugin } from "./dialog_plugin.js";
import { postJSON } from "./utils.js";

const { Plugin, plugin, signal } = owl;

// the model dropdown's choices. "" = don't pass --model, so the backend inherits the
// claude CLI's default (the user's global Claude Code model). The rest are CLI
// aliases understood by `claude --model`.
export const CLAUDE_MODELS = [
  { value: "", label: "Default model" },
  { value: "opus[1m]", label: "Opus 4.8 · 1M" },
  { value: "opus", label: "Opus 4.8" },
  { value: "sonnet", label: "Sonnet 5" },
  { value: "haiku", label: "Haiku 4.5" },
];

export class ClaudePlugin extends Plugin {
  static sequence = 6; // after WorktreePlugin (5), whose wtRepos() it reuses

  config = plugin(ConfigPlugin);
  server = plugin(ServerPlugin);
  worktree = plugin(WorktreePlugin);
  eventLog = plugin(EventLogPlugin);
  dialogs = plugin(DialogPlugin);
  convos = signal({}); // targetId -> { items: [...], state: "idle"|"running" }
  models = CLAUDE_MODELS;
  model = signal(this.config.getState("claude_model", "")); // chosen model, persisted
  _primed = new Set(); // targets whose transcript we've fetched from the backend

  setup() {
    this.server.onClaude((d) => this.apply(d));
  }

  setModel(v) {
    this.model.set(v || "");
    this.config.setState("claude_model", v || "");
  }

  _get(id) {
    return this.convos()[id] || { items: [], state: "idle" };
  }

  _set(id, next) {
    this.convos.set({ ...this.convos(), [id]: next });
  }

  _append(id, item) {
    const c = this._get(id);
    this._set(id, { ...c, items: [...c.items, item] });
  }

  items(id) {
    return this._get(id).items;
  }

  running(id) {
    return this._get(id).state === "running";
  }

  // a live chat item pushed from the backend (assistant text, tool activity, result,
  // or error). The final "result" ends the turn — flip back to idle.
  apply(d) {
    if (!d || !d.target) return;
    const id = d.target;
    if (d.role === "result") {
      const c = this._get(id);
      if (!d.ok && d.error) this._set(id, { ...c, items: [...c.items, d], state: "idle" });
      else this._set(id, { ...c, state: "idle" });
      return;
    }
    this._append(id, d);
  }

  // fetch the transcript once per target (after a reload the backend still holds it);
  // skip if we already have live items so an in-flight turn isn't clobbered
  async prime(id) {
    if (!id || this._primed.has(id)) return;
    this._primed.add(id);
    if (this._get(id).items.length) return;
    try {
      const res = await postJSON("/api/worktree/claude/history", { target: id });
      this._set(id, { items: res.items || [], state: res.state || "idle" });
    } catch {
      /* leave empty */
    }
  }

  // send a task to Claude for <tgt>, running in its worktree's community checkout with
  // the target's other repos added as extra allowed dirs
  async send(tgt, prompt) {
    const text = (prompt || "").trim();
    if (!text || this.running(tgt.id)) return;
    const repos = this.worktree.wtRepos(tgt);
    const community = repos.find((r) => r.repo === "community");
    if (!community) {
      this._error("Cannot run Claude", "this worktree has no community repo");
      return;
    }
    const addDirs = repos.filter((r) => r.repo !== "community").map((r) => r.worktreePath);
    this._append(tgt.id, { role: "user", text }); // optimistic; backend keeps its own copy
    this._set(tgt.id, { ...this._get(tgt.id), state: "running" });
    try {
      await postJSON("/api/worktree/claude", {
        target: tgt.id,
        prompt: text,
        cwd: community.worktreePath,
        addDirs,
        model: this.model() || undefined,
      });
    } catch (e) {
      this._append(tgt.id, { role: "error", text: e.message });
      this._set(tgt.id, { ...this._get(tgt.id), state: "idle" });
    }
  }

  async stop(tgt) {
    try {
      await postJSON("/api/worktree/claude/stop", { target: tgt.id });
    } catch {
      /* the SSE result will reconcile the state */
    }
    this._set(tgt.id, { ...this._get(tgt.id), state: "idle" });
  }

  _error(title, message) {
    this.dialogs.open({ title, message, cls: "dialog-error", okLabel: "OK", cancelLabel: null });
  }
}
