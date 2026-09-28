"""The headless Claude chat: one `claude -p` conversation per workspace, with
its persisted review versions on disk."""

import json
import os
import re
import subprocess
import tempfile
import threading
from typing import Any

from . import effects, services
from .effects import TAG
from .events import EventBus
from .processes import terminate_process


def _review_dir(reviews_dir: str, target: str) -> str:
    """The directory holding every persisted review version for <target>. Workspace
    ids are already filesystem-safe slugs (see WorkspacePlugin._newId in the
    frontend), but sanitize defensively since this builds a path from
    client-supplied data."""
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", target).strip("-.") or "workspace"
    return os.path.join(reviews_dir, safe)


def _review_versions(reviews_dir: str, target: str) -> list[int]:
    """Every persisted version number for <target>, oldest first."""
    matches = (
        re.fullmatch(r"(\d+)\.md", name)
        for name in effects.list_dir(_review_dir(reviews_dir, target))
    )
    return sorted(int(m.group(1)) for m in matches if m)


def _review_path(reviews_dir: str, target: str, version: int) -> str:
    return os.path.join(_review_dir(reviews_dir, target), f"{version}.md")


def _summarize_tool(name: str, inp: dict[str, Any] | None) -> str:
    """A short human label for a Claude tool call, shown as one activity line in the
    chat (e.g. Edit -> the file's basename, Bash -> the command). Empty when the tool
    has no useful one-liner — the frontend then shows just the tool name."""
    inp = inp or {}
    if name in ("Edit", "Write", "Read", "MultiEdit"):
        return os.path.basename(inp.get("file_path", "")) or inp.get("file_path", "")
    if name == "NotebookEdit":
        return os.path.basename(inp.get("notebook_path", ""))
    if name == "Bash":
        return " ".join((inp.get("command") or "").split())[:120]
    if name in ("Grep", "Glob"):
        return inp.get("pattern", "")
    if name == "Task":
        return inp.get("description", "")
    if name == "WebFetch":
        return inp.get("url", "")
    return ""


class ClaudeManager:
    """One headless Claude conversation per workspace. A message spawns
    `claude -p <prompt> --output-format stream-json` with the worktree checkout as
    cwd, streaming its assistant text + tool activity to the browser (SSE 'claude')
    and keeping a per-target transcript so a reload can re-prime the chat. The
    session id from the first turn is stashed and passed as --resume on the next, so
    each target is a continuing conversation. One run per target at a time.

    Full autonomy by design: --permission-mode bypassPermissions, so Claude edits
    files and runs commands unattended — the worktree is a throwaway checkout on its
    own branch, so a task never touches the user's main tree.
    """

    HISTORY_MAX = 400  # chat items kept per target so a reload re-primes the transcript

    def __init__(self, bus: EventBus, reviews_dir: str) -> None:
        self.bus = bus
        self.reviews_dir = reviews_dir  # persisted review versions (see _review_dir)
        self.lock = threading.Lock()
        self.convos: dict[str, dict[str, Any]] = {}  # target_id -> entry dict

    def _entry(self, target: str) -> dict[str, Any]:
        e = self.convos.get(target)
        if e is None:
            e = {
                "state": "idle",
                "session": None,
                "process": None,
                "history": [],
                "ctx_dir": None,  # this conversation's ephemeral Odoo-dev context (see send())
            }
            self.convos[target] = e
        return e

    def _emit(self, target: str, item: dict[str, Any]) -> None:
        """Record one chat item in the target's transcript and push it to the browser.
        `item` is a {role, ...} dict (assistant/tool/result/error); user prompts are
        stored (for re-prime) but not re-pushed — the sending client shows them
        optimistically."""
        with self.lock:
            e = self._entry(target)
            e["history"].append(item)
            del e["history"][: -self.HISTORY_MAX]
            # tally how many items the in-flight review turn has produced so far (see
            # send()/_persist_review) — counted rather than recorded as a fixed index
            # into history, since the HISTORY_MAX trim above can shift/drop earlier
            # indices out from under a long turn.
            if e.get("review"):
                e["review_count"] = e.get("review_count", 0) + 1
        if item.get("role") != "user":
            self.bus.publish_claude({"workspace": target, **item})

    def send(
        self,
        target: str,
        prompt: str,
        cwd: str,
        add_dirs: list[str] | None = None,
        model: str | None = None,
        review: bool = False,
        *,
        git: services.GitService,
    ) -> tuple[bool, Any]:
        """Spawn a Claude turn for <target> in <cwd> (its worktree checkout), resuming
        the target's session when one exists. `model` (a CLI alias/name, e.g. "sonnet"
        or "opus[1m]") overrides the CLI's default when set. `review=True` marks this
        turn's assistant reply for persistence to disk on completion (see
        _persist_review) — so a review survives a goo restart, unlike an ordinary chat
        turn. Returns (ok, detail)."""
        if not target or not (prompt or "").strip():
            return False, "missing workspace or prompt"
        # expanduser everything up front: effects.is_dir/GitService._git already do
        # this internally for their own checks, but subprocess.Popen below takes cwd
        # literally (no shell involved to expand a leading "~" itself) — a
        # worktree_dir setting like "~/Coding/worktrees" would otherwise pass the
        # is_dir check (which expands) and then fail Popen with ENOENT on the raw,
        # unexpanded path.
        cwd = os.path.expanduser(cwd)
        add_dirs = [os.path.expanduser(d) for d in (add_dirs or []) if d]
        if not effects.is_dir(cwd):
            return False, f"worktree checkout not found: {cwd}"
        with self.lock:
            e = self._entry(target)
            if e["state"] == "running":
                return False, "already_running"
            session = e["session"]
            ctx_dir = e["ctx_dir"]
        if not session and not ctx_dir:
            # fresh conversation: materialize a one-shot Odoo-dev context (CLAUDE.md +
            # skills) into a throwaway temp dir, matching <cwd>'s *current* branch.
            # Regenerated per conversation rather than reused from the worktree's
            # persisted .claude/ (see GitService._create_worktree_claude_md/_skills):
            # always reflects goo's latest skill templates, and also covers a
            # main-located target, which has no worktree parent dir of its own.
            ctx_dir = tempfile.mkdtemp(prefix="goo-claude-ctx-")
            branch = git.current_branch(cwd)
            git.write_dev_context(ctx_dir, cwd, branch)
            with self.lock:
                self._entry(target)["ctx_dir"] = ctx_dir
        cmd = [
            "claude",
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            "bypassPermissions",
        ]
        if model:
            cmd += ["--model", model]
        if session:
            cmd += ["--resume", session]
        for d in [*add_dirs, ctx_dir]:
            if d:
                cmd += ["--add-dir", d]
        self._emit(target, {"role": "user", "text": prompt})
        with self.lock:
            e = self._entry(target)
            e["review"] = review
            e["review_count"] = 0
        self.bus.publish_log(f"{TAG} claude ({target}) in {cwd}: {' '.join(cmd)}")
        effects.trace("run", " ".join(cmd))
        # --add-dir dirs auto-load their .claude/skills/ (a documented exception), but
        # NOT their CLAUDE.md unless this is set — needed for ctx_dir's CLAUDE.md to
        # surface too.
        env = {**os.environ, "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "1"}
        try:
            process = subprocess.Popen(
                cmd,
                cwd=cwd,
                env=env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                preexec_fn=os.setsid,
            )
        except (FileNotFoundError, OSError) as ex:
            # `claude` not on PATH is the usual cause
            self._emit(target, {"role": "error", "text": f"could not launch claude: {ex}"})
            self._emit(target, {"role": "result", "ok": False})
            return False, str(ex)
        with self.lock:
            e = self._entry(target)
            e["state"] = "running"
            e["process"] = process
        # feed the prompt on stdin (avoids any arg-length / escaping limit) then close
        assert process.stdin is not None  # stdin=PIPE
        try:
            process.stdin.write(prompt)
            process.stdin.close()
        except (BrokenPipeError, OSError):
            pass
        threading.Thread(target=self._reader, args=(target, process), daemon=True).start()
        return True, {"state": "running"}

    def _reader(self, target: str, process: subprocess.Popen[str]) -> None:
        """Drain the stream-json output: forward each assistant text / tool call as a
        chat item, capture the session id, and finalize on the result line (or on an
        unexpected exit, surfacing whatever non-JSON output we saw as the error)."""
        stray = []
        got_result = False
        assert process.stdout is not None  # stdout=PIPE (see send())
        for line in process.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                stray.append(line)
                continue
            sid = obj.get("session_id")
            if sid:
                with self.lock:
                    self._entry(target)["session"] = sid
            if self._handle(target, obj):
                got_result = True
        process.stdout.close()
        ret = process.wait()
        with self.lock:
            e = self.convos.get(target)
            # stop() or a newer turn now owns the entry (its process handle differs) —
            # don't clobber its state or emit a spurious error for an interrupted turn
            if not e or e["process"] is not process:
                return
            e["state"] = "idle"
            e["process"] = None
        if not got_result:
            detail = "\n".join(stray[-12:]).strip() or f"claude exited (code {ret}) with no result"
            self._emit(target, {"role": "error", "text": detail})
            self._emit(target, {"role": "result", "ok": False})

    def _handle(self, target: str, obj: dict[str, Any]) -> bool:
        """Turn one stream-json event into chat items. Returns True on the final
        result event (which ends the turn)."""
        t = obj.get("type")
        if t == "assistant":
            for block in obj.get("message", {}).get("content", []):
                if block.get("type") == "text" and block.get("text", "").strip():
                    self._emit(target, {"role": "assistant", "text": block["text"].strip()})
                elif block.get("type") == "tool_use":
                    name = block.get("name", "")
                    self._emit(
                        target,
                        {
                            "role": "tool",
                            "tool": name,
                            "text": _summarize_tool(name, block.get("input")),
                        },
                    )
        elif t == "result":
            # the turn is over at the result — flip to idle now (not only once stdout
            # hits EOF a moment later) so a reload in between doesn't prime a stuck run.
            # Safe without a process guard: state is still "running" here, so no newer
            # turn can have started yet (send() refuses while running).
            with self.lock:
                e = self.convos.get(target)
                if e:
                    e["state"] = "idle"
            ok = not obj.get("is_error")
            item = {"role": "result", "ok": ok, "cost": obj.get("total_cost_usd")}
            if not ok:
                item["error"] = obj.get("result") or obj.get("error") or "claude reported an error"
            if ok:
                # saved before the result goes out, so once a turn is reported
                # finished its review can already be read
                self._persist_review(target)
            self._emit(target, item)
            return True
        return False

    def _persist_review(self, target: str) -> None:
        """If this turn was started with review=True (see send()), save its assistant
        text to disk as markdown — so it's still there after a goo restart, when this
        in-memory transcript is gone. Written as a new numbered version alongside any
        earlier reviews for this target (see _review_versions), never overwriting."""
        with self.lock:
            e = self.convos.get(target)
            if not e or not e.get("review"):
                return
            # tail slice by count (see _emit), not a fixed index: history may have
            # been trimmed to HISTORY_MAX mid-turn, which would shift/invalidate a
            # remembered start index but leaves a from-the-end count still correct.
            count = e.get("review_count") or 0
            turn = list(e["history"][-count:]) if count else []
            e["review"] = False
            e["review_count"] = 0
        text = "\n\n".join(
            it["text"].strip() for it in turn if it.get("role") == "assistant" and it.get("text")
        ).strip()
        if text:
            versions = _review_versions(self.reviews_dir, target)
            next_version = versions[-1] + 1 if versions else 1
            effects.write_text(_review_path(self.reviews_dir, target, next_version), text)

    def stop(self, target: str) -> tuple[bool, str]:
        """Interrupt a running Claude turn (idempotent)."""
        with self.lock:
            e = self.convos.get(target)
            if e and e["state"] == "running" and e["process"] is None:
                # a stop is already killing this turn — let it finish the job
                return True, "stopping"
            process = e["process"] if e and e["state"] == "running" else None
            if e and process is not None:
                # release the turn before killing it: the reader sees it no longer
                # owns the entry and doesn't report the kill as a failed turn
                e["process"] = None
        if process is not None:
            self.bus.publish_log(f"{TAG} stopping claude ({target})...")
            try:
                terminate_process(process)
            except Exception as ex:
                self.bus.publish_log(f"{TAG} error stopping claude ({target}): {ex}")
        with self.lock:
            e = self.convos.get(target)
            if e and e["process"] is not None:
                # a newer turn started while the kill was running (the old turn
                # reached its result mid-kill): it's not ours to reset
                return True, "stopped"
            if e:
                e["state"] = "idle"
        self.bus.publish_claude({"workspace": target, "role": "result", "ok": True})
        return True, "stopped"

    def history_for(self, target: str) -> dict[str, Any]:
        """The transcript + live state for one target, to re-prime the chat on load.
        Falls back to the on-disk persisted review's latest version (see
        send()/_persist_review) when memory holds nothing and no turn is running —
        e.g. right after a goo restart, the usual case this covers, since the
        in-memory transcript doesn't survive one."""
        with self.lock:
            e = self.convos.get(target)
            state = e["state"] if e else "idle"
            items = list(e["history"]) if e else []
        if not items and state != "running":
            persisted = self.review_text(target)["text"]
            if persisted:
                items = [{"role": "assistant", "text": persisted}]
        return {"items": items, "state": state}

    def review_text(self, target: str, version: int | None = None) -> dict[str, Any]:
        """The persisted review markdown for <target> at <version> (see
        _persist_review) as {text, version, versions, created}: which version number
        that is, every version number on disk (oldest first), and that version's
        file mtime (epoch seconds, or None) — "" / None / [] / None if none was ever
        saved. <version> defaults (or falls back, if it names a version that no
        longer exists) to the latest. Straight from disk regardless of the in-memory
        conversation state — unlike history_for's fallback, this is for a UI that
        wants one finished review's text, not a chat transcript to re-prime."""
        versions = _review_versions(self.reviews_dir, target)
        if not versions:
            return {"text": "", "version": None, "versions": [], "created": None}
        v = version if version in versions else versions[-1]
        path = _review_path(self.reviews_dir, target, v)
        return {
            "text": effects.read_text(path) or "",
            "version": v,
            "versions": versions,
            "created": effects.mtime(path),
        }

    def forget(self, target: str) -> None:
        """Drop a workspace's conversation (its worktree was removed) and every review
        version persisted for it."""
        self.stop(target)
        with self.lock:
            e = self.convos.pop(target, None)
        if e and e.get("ctx_dir"):
            effects.remove_tree(e["ctx_dir"])
        effects.remove_tree(_review_dir(self.reviews_dir, target))

    def shutdown(self) -> None:
        """Stop every running turn (goo exit / restart), and clean up every
        conversation's ephemeral context dir (see send())."""
        with self.lock:
            targets = [t for t, e in self.convos.items() if e["state"] == "running"]
            ctx_dirs = [e["ctx_dir"] for e in self.convos.values() if e.get("ctx_dir")]
        for t in targets:
            self.stop(t)
        for d in ctx_dirs:
            effects.remove_tree(d)
