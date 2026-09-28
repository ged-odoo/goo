"""The event bus: the main-server log ring buffer + the SSE fan-out to every
browser tab."""

import collections
import queue
import threading
import time
from typing import Any

from .effects import TAG

LOG_BUFFER_SIZE = 2000


class EventBus:
    def __init__(self, maxlen: int = LOG_BUFFER_SIZE) -> None:
        self._lock = threading.Lock()
        self._buffer: collections.deque[str] = collections.deque(maxlen=maxlen)
        self._subscribers: list[queue.Queue[tuple[str, Any]]] = []

    def _broadcast(self, event: str, payload: Any) -> None:
        """Fan one (event, payload) out to every subscribed client queue."""
        with self._lock:
            subscribers = list(self._subscribers)
        for q in subscribers:
            q.put((event, payload))

    def publish_log(self, line: str, server: str = "main") -> None:
        """Stream one server's log line to the browser (SSE 'log', {server, line}).
        Only the MAIN server's lines feed the shared backlog ring buffer (replayed on
        SSE connect); other servers keep per-entry scrollback in WorkspaceManager,
        primed on selection via /api/workspace/logs."""
        # buffer append + subscriber snapshot under ONE lock: a client subscribing
        # in between would otherwise see the line twice (backlog + live)
        with self._lock:
            if server == "main":
                self._buffer.append(line)
            subscribers = list(self._subscribers)
        for q in subscribers:
            q.put(("log", {"server": server, "line": line}))

    def publish_server(self, snapshot: dict[str, Any] | None) -> None:
        """Push one server snapshot to the browser (SSE 'server'), keyed by
        snapshot["id"] ("main" | target id). Both the main OdooManager and the
        per-target WorktreeManager publish through here — one event, one shape — so
        the frontend folds them into a single `servers` map."""
        self._broadcast("server", snapshot)

    def publish_event(
        self, text: str, level: str = "", event_id: str = "", status: str = ""
    ) -> None:
        """A business event: logged to the goo server stdout and pushed to the
        browser event log via an SSE 'event' message (level "error" tints it).

        A long-running event can be tracked across its lifetime by passing a
        stable `event_id` plus a `status` of "start" then "done"/"error": the
        browser shows an animated "..." next to the line while it runs and
        appends "ok" (or "failed") when it finishes. Omit both for a plain
        one-off line (the default)."""
        print(f"{TAG} {time.strftime('%H:%M:%S')} • {text}", flush=True)
        payload = {"text": text, "level": level}
        if event_id:
            payload["id"] = event_id
            payload["status"] = status
        self._broadcast("event", payload)

    def publish_goo_update(self, status: dict[str, Any]) -> None:
        """Push the recomputed goo-update status to the browser (SSE 'goo_update')
        so the navbar update badge appears live when the hourly check finds new
        commits — not only on reload / the next 30-min poll / a manual check."""
        self._broadcast("goo_update", status)

    def publish_config(self, payload: dict[str, Any]) -> None:
        """Broadcast the new {rev, config, state} to every tab (SSE 'config') after a
        config/state write, so all open tabs stay in lockstep — the multi-tab
        consistency the server-owned config buys over per-browser localStorage."""
        self._broadcast("config", payload)

    def publish_run(self, snapshot: dict[str, Any]) -> None:
        """Push one-shot run state to the browser (SSE 'run'): a RunSnapshot as it
        goes running → done/failed. The Tests/Addons screens watch these instead of
        keeping their own runActive/sawRun flags; the backend also owns resume-after,
        so the run survives a mid-run reload."""
        self._broadcast("run", snapshot)

    def publish_claude(self, payload: dict[str, Any]) -> None:
        """Stream one Claude chat item for a worktree to the browser (SSE 'claude').
        payload is {workspace, role, ...}: role 'assistant'/'tool'/'result'/'error' as a
        headless `claude -p` run produces text, tool activity and its final result.
        Per-target history lives in ClaudeManager and is primed via /api/workspace/
        claude/history — this only pushes the live increments."""
        self._broadcast("claude", payload)

    def subscribe(self) -> tuple[queue.Queue[tuple[str, Any]], list[str]]:
        """Register a client queue. Returns (queue, log backlog) atomically so
        no line is lost between the backlog replay and the live stream."""
        q: queue.Queue[tuple[str, Any]] = queue.Queue()
        with self._lock:
            backlog = list(self._buffer)
            self._subscribers.append(q)
        return q, backlog

    def unsubscribe(self, q: queue.Queue[tuple[str, Any]]) -> None:
        with self._lock:
            try:
                self._subscribers.remove(q)
            except ValueError:
                pass
