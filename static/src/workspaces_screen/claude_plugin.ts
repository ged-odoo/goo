// A headless Claude conversation per worktree target. "Send" spawns `claude -p` on
// the backend with the worktree's checkout as its cwd (full autonomy — it edits and
// runs commands there, never touching the main tree), and its assistant text + tool
// activity stream back live over the "claude" SSE event (relayed by ServerPlugin).
// Per-target transcripts are kept here (and mirrored on the backend so a page reload
// re-primes them via /api/workspace/claude/history). The backend owns the resumable
// session id, so a conversation just continues turn after turn.

import { ConfigPlugin } from "../core/config_plugin.ts";
import { ServerPlugin } from "../core/server_plugin.ts";
import { WorkspacePlugin } from "../core/workspace_plugin.ts";
import { EventLogPlugin } from "../core/event_log_plugin.ts";
import { DialogPlugin } from "../core/dialog_plugin.ts";
import type { ClaudeEvent } from "../core/server_plugin.ts";
import type { WorkspaceLike } from "../core/workspace_plugin.ts";
import { postJSON, parseReviewScore, errorMessage } from "../core/utils.ts";

import { Plugin, usePlugin, signal } from "@odoo/owl";

// the model dropdown's choices. "" = don't pass --model, so the backend inherits the
// claude CLI's default (the user's global Claude Code model). The rest are CLI
// aliases understood by `claude --model`; each resolves to the latest model of its
// family, so the labels name the family, not a version.
export const CLAUDE_MODELS = [
  { value: "", label: "Default model" },
  { value: "fable", label: "Fable" },
  { value: "opus[1m]", label: "Opus · 1M" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

// one transcript entry: a "user" prompt (added here), or an SSE-relayed
// "assistant" / "tool" / "error" item (a ClaudeEvent as-is)
export interface ChatItem {
  role?: string;
  text?: string;
  tool?: string;
  [key: string]: unknown;
}

// one target's conversation; state is "idle" | "running" (the backend's string)
interface Convo {
  items: ChatItem[];
  state: string;
}

// /api/workspace/claude/history's reply
interface HistoryReply {
  items?: ChatItem[];
  state?: string;
}

// /api/workspace/claude/review's reply (fields absent when nothing is saved)
interface ReviewReply {
  text?: string;
  version?: number | null;
  versions?: number[];
  created?: number | null;
}

// fetchReview's normalized result
export interface ReviewVersion {
  text: string;
  version: number | null;
  versions: number[];
  created: number | null;
}

// where a Claude run works: its cwd + the extra allowed dirs
interface ClaudeDirs {
  cwd: string;
  addDirs: string[];
}

export class ClaudePlugin extends Plugin {
  static sequence = 6; // after WorkspacePlugin (5), whose wtRepos() it reuses

  config = usePlugin(ConfigPlugin);
  server = usePlugin(ServerPlugin);
  worktree = usePlugin(WorkspacePlugin);
  eventLog = usePlugin(EventLogPlugin);
  dialogs = usePlugin(DialogPlugin);
  convos = signal<Record<string, Convo>>({}); // targetId -> { items: [...], state: "idle"|"running" }
  models = CLAUDE_MODELS;
  model = signal(this.config.getState("claude_model", "")); // chosen model, persisted
  _primed = new Set<string>(); // targets whose transcript we've fetched from the backend

  setup(): void {
    this.server.onClaude((d) => this.apply(d));
  }

  setModel(v: string | null | undefined): void {
    this.model.set(v || "");
    this.config.setState("claude_model", v || "");
  }

  _get(id: string): Convo {
    return this.convos()[id] || { items: [], state: "idle" };
  }

  _set(id: string, next: Convo): void {
    this.convos.set({ ...this.convos(), [id]: next });
  }

  _append(id: string, item: ChatItem): void {
    const c = this._get(id);
    this._set(id, { ...c, items: [...c.items, item] });
  }

  items(id: string): ChatItem[] {
    return this._get(id).items;
  }

  running(id: string): boolean {
    return this._get(id).state === "running";
  }

  // the merge-readiness score (0-100) Claude reported at the end of a review
  // turn, if any — parsed from the conversation's own assistant text. A review
  // run always ends its prompt with a fixed, non-editable instruction to report
  // one as "Score: N/100" (see REVIEW_SCORE_INSTRUCTION, workspaces_screen/
  // dialogs.ts), so this needs no dedicated backend field. Returns the LAST one
  // found across the conversation (a later re-review after changes wins), or
  // null if none was ever reported (an older review, a non-review chat, or
  // Claude just didn't comply).
  reviewScore(id: string): number | null {
    let score: number | null = null;
    for (const item of this.items(id)) {
      if (item.role !== "assistant" || !item.text) continue;
      const s = parseReviewScore(item.text);
      if (s !== null) score = s;
    }
    return score;
  }

  // a live chat item pushed from the backend (assistant text, tool activity, result,
  // or error). The final "result" ends the turn — flip back to idle.
  apply(d: ClaudeEvent | null | undefined): void {
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
  async prime(id: string | null | undefined): Promise<void> {
    if (!id || this._primed.has(id)) return;
    this._primed.add(id);
    if (this._get(id).items.length) return;
    try {
      const res = await postJSON<HistoryReply>("/api/workspace/claude/history", { workspace: id });
      this._set(id, { items: res.items || [], state: res.state || "idle" });
    } catch {
      /* leave empty */
    }
  }

  // the persisted review markdown for <id> at <version> (backend's
  // ClaudeManager.review_text), plus that version's number, every version number
  // saved for <id> (oldest first), and that version's file mtime (epoch seconds, or
  // null) — straight from disk regardless of in-memory conversation state, used by
  // the Reviews screen's review panel (including its version pager and "reviewed
  // on" date). `version` omitted (or no longer on disk) falls back to the latest.
  // Always re-fetched (no once-guard like prime()), since this is opened on demand
  // rather than primed for every visible task.
  async fetchReview(id: string, version?: number | null): Promise<ReviewVersion> {
    try {
      const body: { workspace: string; version?: number } = { workspace: id };
      if (version != null) body.version = version;
      const res = await postJSON<ReviewReply>("/api/workspace/claude/review", body);
      return {
        text: res.text || "",
        version: res.version ?? null,
        versions: res.versions || [],
        created: res.created ?? null,
      };
    } catch {
      return { text: "", version: null, versions: [], created: null };
    }
  }

  // where Claude works for <tgt>: a worktree workspace's own checkout copies, or —
  // for a main-located workspace (the screen only offers it when loaded) — the REAL
  // main checkout paths. Returns { cwd, addDirs } or null (error already shown).
  // Note: removing a main-located workspace never CLAUDE.forgets its transcript
  // (only /api/workspace/remove does) — a harmless stale in-memory convo.
  _dirsFor(tgt: WorkspaceLike): ClaudeDirs | null {
    const mainRepoId = this.config.config.main_repo_id || "community";
    if (this.worktree.isWorktree(tgt)) {
      const repos = this.worktree.wtRepos(tgt);
      const main = repos.find((r) => r.repo === mainRepoId);
      if (!main) {
        this.dialogs.error("Cannot run Claude", "this worktree has no main repo checkout");
        return null;
      }
      // (the backend materializes its own ephemeral Odoo-dev .claude/ context per
      // conversation — see ClaudeManager.send in server.py — rather than relying on
      // the worktree's persisted one, so it isn't threaded through here)
      return {
        cwd: main.worktreePath,
        addDirs: repos.filter((r) => r.repo !== mainRepoId).map((r) => r.worktreePath),
      };
    }
    const pathById = Object.fromEntries(this.config.config.repos.map((r) => [r.id, r.path]));
    const cwd = pathById[mainRepoId];
    if (!cwd) {
      this.dialogs.error("Cannot run Claude", "no main repo configured");
      return null;
    }
    const addDirs = (tgt.checkouts || [])
      .filter((c) => c.repo !== mainRepoId)
      .map((c) => pathById[c.repo])
      .filter((p): p is string => Boolean(p));
    return { cwd, addDirs };
  }

  // send a task to Claude for <tgt>, running in its checkout (worktree copies, or
  // the main checkout for a loaded main-located workspace) with the workspace's
  // other repos added as extra allowed dirs. `review: true` (a review run — see
  // dialogs.ts's runClaudeReview) tells the backend to save this turn's reply to
  // disk on completion, so it survives a goo restart (an ordinary chat turn stays
  // in-memory only, as before).
  async send(
    tgt: WorkspaceLike,
    prompt: string | null | undefined,
    { review = false }: { review?: boolean } = {},
  ): Promise<void> {
    const text = (prompt || "").trim();
    if (!text || this.running(tgt.id)) return;
    const dirs = this._dirsFor(tgt);
    if (!dirs) return;
    this.config.workspace(tgt.id)?.touchActivity();
    this._append(tgt.id, { role: "user", text }); // optimistic; backend keeps its own copy
    this._set(tgt.id, { ...this._get(tgt.id), state: "running" });
    try {
      await postJSON("/api/workspace/claude", {
        workspace: tgt.id,
        prompt: text,
        cwd: dirs.cwd,
        addDirs: dirs.addDirs,
        model: this.model() || undefined,
        review,
      });
    } catch (e) {
      this._append(tgt.id, { role: "error", text: errorMessage(e) });
      this._set(tgt.id, { ...this._get(tgt.id), state: "idle" });
    }
  }

  async stop(tgt: WorkspaceLike): Promise<void> {
    try {
      await postJSON("/api/workspace/claude/stop", { workspace: tgt.id });
    } catch {
      /* the SSE result will reconcile the state */
    }
    this._set(tgt.id, { ...this._get(tgt.id), state: "idle" });
  }
}
