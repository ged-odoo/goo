// A headless Claude conversation per worktree target. "Send" spawns `claude -p` on
// the backend with the worktree's checkout as its cwd (full autonomy — it edits and
// runs commands there, never touching the main tree), and its assistant text + tool
// activity stream back live over the "claude" SSE event (relayed by ServerPlugin).
// Per-target transcripts are kept here (and mirrored on the backend so a page reload
// re-primes them via /api/workspace/claude/history). The backend owns the resumable
// session id, so a conversation just continues turn after turn.

import { ConfigPlugin } from "../core/config_plugin.js";
import { ServerPlugin } from "../core/server_plugin.js";
import { WorkspacePlugin } from "../core/workspace_plugin.js";
import { EventLogPlugin } from "../core/event_log_plugin.js";
import { DialogPlugin } from "../core/dialog_plugin.js";
import { postJSON } from "../core/utils.js";

import { Plugin, plugin, signal } from "@odoo/owl";

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
  static sequence = 6; // after WorkspacePlugin (5), whose wtRepos() it reuses

  config = plugin(ConfigPlugin);
  server = plugin(ServerPlugin);
  worktree = plugin(WorkspacePlugin);
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
    if (!d || !d.workspace) return;
    const id = d.workspace;
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
      const res = await postJSON("/api/workspace/claude/history", { workspace: id });
      this._set(id, { items: res.items || [], state: res.state || "idle" });
    } catch {
      /* leave empty */
    }
  }

  // where Claude works for <tgt>: a worktree workspace's own checkout copies, or —
  // for a main-located workspace (the screen only offers it when loaded) — the REAL
  // main checkout paths. Returns { cwd, addDirs } or null (error already shown).
  // Note: removing a main-located workspace never CLAUDE.forgets its transcript
  // (only /api/workspace/remove does) — a harmless stale in-memory convo.
  _dirsFor(tgt) {
    if (this.worktree.isWorktree(tgt)) {
      const repos = this.worktree.wtRepos(tgt);
      const community = repos.find((r) => r.repo === "community");
      if (!community) {
        this._error("Cannot run Claude", "this worktree has no community repo");
        return null;
      }
      return {
        cwd: community.worktreePath,
        addDirs: repos.filter((r) => r.repo !== "community").map((r) => r.worktreePath),
      };
    }
    const pathById = Object.fromEntries(this.config.config.repos.map((r) => [r.id, r.path]));
    const cwd = pathById["community"];
    if (!cwd) {
      this._error("Cannot run Claude", "no community repo configured");
      return null;
    }
    const addDirs = (tgt.checkouts || [])
      .filter((c) => c.repo !== "community")
      .map((c) => pathById[c.repo])
      .filter(Boolean);
    return { cwd, addDirs };
  }

  // send a task to Claude for <tgt>, running in its checkout (worktree copies, or
  // the main checkout for a loaded main-located workspace) with the workspace's
  // other repos added as extra allowed dirs
  async send(tgt, prompt) {
    const text = (prompt || "").trim();
    if (!text || this.running(tgt.id)) return;
    const dirs = this._dirsFor(tgt);
    if (!dirs) return;
    this._append(tgt.id, { role: "user", text }); // optimistic; backend keeps its own copy
    this._set(tgt.id, { ...this._get(tgt.id), state: "running" });
    try {
      await postJSON("/api/workspace/claude", {
        workspace: tgt.id,
        prompt: text,
        cwd: dirs.cwd,
        addDirs: dirs.addDirs,
        model: this.model() || undefined,
      });
    } catch (e) {
      this._append(tgt.id, { role: "error", text: e.message });
      this._set(tgt.id, { ...this._get(tgt.id), state: "idle" });
    }
  }

  async stop(tgt) {
    try {
      await postJSON("/api/workspace/claude/stop", { workspace: tgt.id });
    } catch {
      /* the SSE result will reconcile the state */
    }
    this._set(tgt.id, { ...this._get(tgt.id), state: "idle" });
  }

  _error(title, message) {
    this.dialogs.open({ title, message, cls: "dialog-error", okLabel: "OK", cancelLabel: null });
  }
}
