"""goo - GED Odoo Overseer: the HTTP server and request handlers.

The implementation of goo; the repo-root `goo.py` is a thin launcher that calls
main() here. The frontend (static/) holds the configuration and posts it with each
start request; the backend is stateless apart from the server-side caches.
"""

import argparse
import atexit
import base64
import collections
import fcntl
import hashlib
import json
import mimetypes
import os
import pty
import queue
import re
import shlex
import signal
import socket
import struct
import subprocess
import sys
import termios
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import effects, services
from .cache import TTLCache

# the IO seam (effects) and the services layer over it; the server's remaining
# subprocess calls (kill_port, the goo self-update probes) go through run().
from .effects import TAG, run
from .models import RunSnapshot, ServerSnapshot

HOST = "127.0.0.1"
PORT = 8068
ODOO_PORT = 8069
READY_MARKER = "odoo.registry: Registry loaded"
# the repo root (parent of this backend/ package) — goo's own git checkout, and where
# static/ and addons/ live. Used for the self-update git, the launcher re-exec, etc.
GOO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(GOO_DIR, "static")
ADDONS_DIR = os.path.join(GOO_DIR, "addons")
LOG_BUFFER_SIZE = 2000


# =============================================================================
# Event bus: log ring buffer + SSE fan-out
# =============================================================================


class EventBus:
    def __init__(self, maxlen=LOG_BUFFER_SIZE):
        self._lock = threading.Lock()
        self._buffer = collections.deque(maxlen=maxlen)
        self._subscribers = []

    def publish_log(self, line, server="main"):
        """Stream one server's log line to the browser (SSE 'log', {server, line}).
        Only the MAIN server's lines feed the shared backlog ring buffer (replayed on
        SSE connect); other servers keep per-entry scrollback in WorkspaceManager,
        primed on selection via /api/workspace/logs."""
        with self._lock:
            if server == "main":
                self._buffer.append(line)
            subscribers = list(self._subscribers)
        for q in subscribers:
            q.put(("log", {"server": server, "line": line}))

    def publish_server(self, snapshot):
        """Push one server snapshot to the browser (SSE 'server'), keyed by
        snapshot["id"] ("main" | target id). Both the main OdooManager and the
        per-target WorktreeManager publish through here — one event, one shape — so
        the frontend folds them into a single `servers` map."""
        with self._lock:
            subscribers = list(self._subscribers)
        for q in subscribers:
            q.put(("server", snapshot))

    def publish_event(self, text, level="", event_id="", status=""):
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
        with self._lock:
            subscribers = list(self._subscribers)
        for q in subscribers:
            q.put(("event", payload))

    def publish_goo_update(self, status):
        """Push the recomputed goo-update status to the browser (SSE 'goo_update')
        so the navbar update badge appears live when the hourly check finds new
        commits — not only on reload / the next 30-min poll / a manual check."""
        with self._lock:
            subscribers = list(self._subscribers)
        for q in subscribers:
            q.put(("goo_update", status))

    def publish_config(self, payload):
        """Broadcast the new {rev, config, state} to every tab (SSE 'config') after a
        config/state write, so all open tabs stay in lockstep — the multi-tab
        consistency the server-owned config buys over per-browser localStorage."""
        with self._lock:
            subscribers = list(self._subscribers)
        for q in subscribers:
            q.put(("config", payload))

    def publish_run(self, snapshot):
        """Push one-shot run state to the browser (SSE 'run'): a RunSnapshot as it
        goes running → done/failed. The Tests/Addons screens watch these instead of
        keeping their own runActive/sawRun flags; the backend also owns resume-after,
        so the run survives a mid-run reload."""
        with self._lock:
            subscribers = list(self._subscribers)
        for q in subscribers:
            q.put(("run", snapshot))

    def publish_claude(self, payload):
        """Stream one Claude chat item for a worktree to the browser (SSE 'claude').
        payload is {workspace, role, ...}: role 'assistant'/'tool'/'result'/'error' as a
        headless `claude -p` run produces text, tool activity and its final result.
        Per-target history lives in ClaudeManager and is primed via /api/workspace/
        claude/history — this only pushes the live increments."""
        with self._lock:
            subscribers = list(self._subscribers)
        for q in subscribers:
            q.put(("claude", payload))

    def subscribe(self):
        """Register a client queue. Returns (queue, log backlog) atomically so
        no line is lost between the backlog replay and the live stream."""
        q = queue.Queue()
        with self._lock:
            backlog = list(self._buffer)
            self._subscribers.append(q)
        return q, backlog

    def unsubscribe(self, q):
        with self._lock:
            try:
                self._subscribers.remove(q)
            except ValueError:
                pass


# =============================================================================
# Helpers
# =============================================================================


def free_port():
    """An OS-assigned free TCP port, so a CLI test run can use its own http /
    gevent ports and not clash with the running server's."""
    with socket.socket() as s:
        s.bind((HOST, 0))
        return s.getsockname()[1]


def port_busy(port):
    try:
        with socket.create_connection((HOST, port), timeout=0.3):
            return True
    except OSError:
        return False


def port_is_free(port):
    """Whether we can actually bind the port — used to honor a workspace's stable
    port with a safe fallback when a stale process still holds it."""
    try:
        with socket.socket() as s:
            s.bind((HOST, port))
            return True
    except OSError:
        return False


def kill_port(port):
    """Kill any process listening on the given port."""
    try:
        # -sTCP:LISTEN so we only kill the process *listening* on the port, not
        # every process that merely has a client connection open to it (a browser,
        # psql, or goo itself) — plain `lsof -ti :PORT` matches those too.
        result = run(
            ["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        for pid_str in result.stdout.strip().split("\n"):
            if pid_str.strip():
                try:
                    os.kill(int(pid_str.strip()), signal.SIGKILL)
                except (ProcessLookupError, ValueError, OSError):
                    pass
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass


def terminate_process(process):
    """Signal-escalate a process group until it exits: graceful SIGTERM, then a
    second SIGTERM (odoo needs a second signal to force shutdown when graceful
    hangs), then SIGKILL as a last resort. Safe on an already-gone process."""
    if process is None:
        return
    try:
        pgid = os.getpgid(process.pid)
    except (ProcessLookupError, OSError):
        return
    for sig, wait in ((signal.SIGTERM, 4), (signal.SIGTERM, 3), (signal.SIGKILL, 3)):
        try:
            os.killpg(pgid, sig)
        except (ProcessLookupError, OSError):
            return  # already gone
        try:
            process.wait(timeout=wait)
            return
        except subprocess.TimeoutExpired:
            continue


def open_in_editor(editor, paths):
    """Launch the configured editor (e.g. `code`) on one or more repo directories,
    detached so it outlives goo and isn't part of its process group. The editor
    string may carry flags (`code --reuse-window`), so it's run through bash with
    each path quoted; passing several dirs (`code repo1 repo2`) opens them in one
    window. `paths` may be a single string or a list. Returns (ok, error).

    A missing/failing editor command exits quickly with a non-zero code — we wait
    briefly to catch that and return its stderr (so the UI shows why it failed,
    e.g. `code: command not found`). A GUI editor that keeps running past the
    grace period is taken as a successful launch."""
    editor = (editor or "").strip()
    if isinstance(paths, str):
        paths = [paths]
    dirs = [os.path.expanduser(p) for p in (paths or []) if p]
    if not editor:
        return False, "no editor configured"
    if not dirs:
        return False, "no path"
    for path in dirs:
        if not os.path.isdir(path):
            return False, f"not a directory: {path}"
    cmd = f"{editor} {' '.join(shlex.quote(p) for p in dirs)}"
    effects.trace("run", cmd)
    try:
        proc = subprocess.Popen(
            cmd,
            shell=True,
            executable="/bin/bash",
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            start_new_session=True,
            text=True,
        )
    except OSError as e:
        return False, str(e)
    try:
        _, stderr = proc.communicate(timeout=2)
    except subprocess.TimeoutExpired:
        return True, None  # still running → launched OK
    if proc.returncode:
        err = (stderr or "").strip() or f"editor exited with code {proc.returncode}"
        print(f"$ {cmd}\n{err}", flush=True)  # log the raw failure to the goo log too
        return False, err
    return True, None


def _git_goo(*args, timeout=10):
    """Run a git command in goo's own checkout. Returns the CompletedProcess, or
    None if git is missing / times out."""
    try:
        # probes for the update check — a non-zero exit (no repo / no origin/master)
        # is an expected outcome, not an error to log
        return run(
            ["git", "-C", GOO_DIR, *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            quiet=True,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None


def goo_update_status():
    """How goo's checkout compares to (the already-fetched) origin/master — no
    network. Returns {checked, is_repo, branch, behind, ahead, dirty,
    can_fast_forward}. `behind` = commits on origin/master missing locally; `ahead`
    = local commits not on origin/master (the user's own work). A fast-forward is
    only offered when behind>0, ahead==0 and the tree is clean."""
    base = {
        "checked": True,
        "is_repo": False,
        "branch": "",
        "behind": 0,
        "ahead": 0,
        "dirty": False,
        "can_fast_forward": False,
    }
    inside = _git_goo("rev-parse", "--is-inside-work-tree")
    if not inside or inside.returncode != 0 or inside.stdout.strip() != "true":
        return base
    base["is_repo"] = True
    branch = _git_goo("rev-parse", "--abbrev-ref", "HEAD")
    base["branch"] = branch.stdout.strip() if branch and branch.returncode == 0 else ""
    # need origin/master to compare against (populated by the startup fetch)
    om = _git_goo("rev-parse", "--verify", "--quiet", "origin/master")
    if not om or om.returncode != 0:
        return base
    behind = _git_goo("rev-list", "--count", "HEAD..origin/master")
    ahead = _git_goo("rev-list", "--count", "origin/master..HEAD")
    dirty = _git_goo("status", "--porcelain")
    base["behind"] = int(behind.stdout.strip()) if behind and behind.returncode == 0 else 0
    base["ahead"] = int(ahead.stdout.strip()) if ahead and ahead.returncode == 0 else 0
    base["dirty"] = bool(dirty.stdout.strip()) if dirty and dirty.returncode == 0 else False
    base["can_fast_forward"] = base["behind"] > 0 and base["ahead"] == 0 and not base["dirty"]
    return base


def check_goo_update():
    """Fetch origin/master, then record how goo's checkout compares and announce it
    when new commits appear. Silent on anything unusual (not a git repo, no origin
    remote, offline) — never nags on failure. Only re-announces when `behind` grows,
    so the hourly re-check (see goo_update_loop) doesn't spam an unchanged state.
    Returns True when the fetch + recompute succeeded (used by the manual check)."""
    global GOO_UPDATE
    inside = _git_goo("rev-parse", "--is-inside-work-tree")
    if not inside or inside.returncode != 0 or inside.stdout.strip() != "true":
        return False
    remotes = _git_goo("remote")
    if not remotes or remotes.returncode != 0 or "origin" not in remotes.stdout.split():
        return False
    fetch = _git_goo("fetch", "origin", "master", timeout=30)
    if not fetch or fetch.returncode != 0:
        return False  # offline / no such branch — stay quiet
    prev_behind = GOO_UPDATE.get("behind", 0)
    GOO_UPDATE = goo_update_status()
    n = GOO_UPDATE["behind"]
    if n != prev_behind:  # state changed → push it so the navbar badge stays in sync
        BUS.publish_goo_update({**GOO_UPDATE, "boot": BOOT_ID})
    if n > prev_behind:  # new commits since we last looked
        msg = f"goo update available — {n} commit{'s' if n != 1 else ''} behind origin/master"
        if GOO_UPDATE["ahead"]:
            m = GOO_UPDATE["ahead"]
            msg += f", {m} local commit{'s' if m != 1 else ''} ahead"
        BUS.publish_event(msg)
    return True


def goo_update_loop():
    """Check for a goo update at startup and then hourly, so a permanently running
    goo keeps surfacing new commits on origin/master. Skipped (but still ticking,
    so re-enabling needs no restart) when the update check is turned off in the
    config's Miscellaneous section."""
    while True:
        if (CONFIG.get()["config"] or {}).get("update_check", True) is not False:
            check_goo_update()
        time.sleep(3600)


def goo_fast_forward():
    """Fast-forward goo onto origin/master, but only when it's still provably safe
    (re-validated to avoid a TOCTOU race). Returns (ok, error)."""
    status = goo_update_status()
    if not status["can_fast_forward"]:
        if status["ahead"]:
            return False, "local commits on top of master — update manually (git pull --rebase)"
        if status["dirty"]:
            return False, "the working tree is dirty — commit or stash first"
        return False, "nothing to fast-forward"
    r = _git_goo("merge", "--ff-only", "origin/master", timeout=30)
    if not r:
        return False, "git not available or timed out"
    if r.returncode != 0:
        msg = (r.stderr.strip() or r.stdout.strip()).split("\n")[-1]
        return False, msg or "git merge --ff-only failed"
    return True, None


def restart_goo():
    """Restart goo in place (re-exec) so a just-applied update is loaded. Stops the
    managed odoo processes first — execv keeps the same PID but does NOT run atexit
    handlers, and the new goo starts with a fresh WORKSPACES that wouldn't know
    about leftover children. The listening socket is close-on-exec, so the new
    process rebinds the port. `--open` is dropped so no extra browser tab opens
    (the client reloads its existing tab)."""
    WORKSPACES.shutdown()
    CLAUDE.shutdown()
    args = [a for a in sys.argv[1:] if a != "--open"]
    os.execv(sys.executable, [sys.executable, os.path.join(GOO_DIR, "goo.py"), *args])


class AutoReloader:
    """Fetches master for opted-in repos every INTERVAL seconds, in the background.
    The repo set is read from the server's own config each tick (`repos_getter`, which
    returns the config's `autoreload`-flagged repos) — no frontend push. Each repo's
    first fetch is one interval after it is first seen, so starting goo never triggers
    a fetch storm."""

    INTERVAL = 4 * 3600

    def __init__(self, repos_getter):
        self._repos_getter = repos_getter  # () -> [{id, path, github}, …]
        self._next = {}  # path -> earliest next fetch time
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while True:
            time.sleep(60)
            now = time.time()
            repos = [r for r in self._repos_getter() if r.get("path")]
            due = []
            for r in repos:
                nxt = self._next.setdefault(r["path"], now + self.INTERVAL)
                if now >= nxt:
                    self._next[r["path"]] = now + self.INTERVAL
                    due.append(r)
            for r in due:
                GIT.fetch_master(r)


def _filestore(body):
    """The filestore root from a request body, or None when absent/blank. Lets the
    database endpoints keep each db's <filestore>/<db> directory in lockstep."""
    fs = (body or {}).get("filestore")
    return fs if isinstance(fs, str) and fs.strip() else None


def build_odoo_cmd(config):
    """Build the odoo-bin shell command from a client config.

    Returns (cmd, db, is_new_db). Raises ValueError on invalid config.
    """
    start = config.get("start") or {}
    db = start.get("db")
    if not db:
        raise ValueError("no database configured (start.db)")

    repo_map = {
        r["id"]: {**r, "path": os.path.expanduser(r["path"])}
        for r in config.get("repos", [])
        if isinstance(r, dict) and "id" in r and "path" in r
    }
    community = repo_map.get("community")
    if not community:
        raise ValueError("no 'community' repo defined in repos")
    community_path = community["path"]

    addons_parts = []
    for repo_id in start.get("repos", []):
        repo = repo_map.get(repo_id)
        if not repo:
            raise ValueError(f"unknown repo '{repo_id}' in start.repos")
        if repo_id == "community":
            addons_parts.append("addons")
        else:
            addons_parts.append(os.path.relpath(repo["path"], community_path))
    if not addons_parts:
        raise ValueError("no repos selected in start.repos")
    addons_parts.append(ADDONS_DIR)  # goo's own addons (autologin, auto-installed)
    addons_path = ",".join(addons_parts)

    db_user = config.get("db_user", "odoo")
    db_password = config.get("db_password", "odoo")
    venv_activate = config.get("venv_activate", "")
    # the odoo-bin executable; goo cd's into the community checkout and appends the
    # dynamic args. Defaults to that checkout's own odoo-bin, so a worktree start
    # config — which passes the worktree's community path — automatically runs the
    # worktree's odoo-bin without any extra wiring.
    server_path = config.get("server_path") or os.path.join(community_path, "odoo-bin")

    parts = []
    if venv_activate:
        parts.append(venv_activate)
    rust = "RUST_BUNDLER=1 " if config.get("rust_bundler") else ""
    parts.append(f"cd {community_path} && {rust}{server_path}")
    cmd = " && ".join(parts)
    without_demo = "false" if start.get("demo_data", True) else "all"
    cmd += (
        f" -r {db_user} -w {db_password} -d {db} "
        f"--database {db} --no-database-list --without-demo {without_demo} "
        f"--addons-path {addons_path}"
    )

    # test mode: run the given --test-tags and exit, skipping the server-only
    # extras (other_args / on_create_args), mirroring the old odev behaviour
    test_tags = start.get("test_tags")
    if test_tags:
        # quote so shell globbing can't mangle hoot params, e.g.
        # /web:WebSuite[@web/core/commands] (the [..] is a bash glob).
        # --dev all turns on the dev features (access/qweb/reload/xml). NOTE: it
        # does NOT de-minify the headless HOOT JS bundle — minification is decided
        # by `session.debug` (set only from the `debug=assets` URL param), and
        # test_js.py hardcodes the test URL without it (browser_js adds it only in
        # non-headless "watch" mode). To read non-minified JS stacks, open the
        # failing test via the "[open in hoot]" link in the log (debug=assets).
        cmd += f" --test-tags {shlex.quote(test_tags)} --dev all --stop-after-init"
        # if the db was never set up (target created but server never started),
        # initialize it in the same run by applying the target's on_create_args
        # (e.g. `-i <modules>`) — odoo then installs the modules AND runs the
        # tests, instead of failing against an empty/missing database
        is_new = not DATABASE.db_initialized(db)
        on_create_args = start.get("on_create_args", "")
        if is_new and on_create_args:
            cmd += f" {on_create_args}"
        return cmd, db, is_new

    # install / upgrade modules and exit
    install, upgrade = start.get("install"), start.get("upgrade")
    if install or upgrade:
        if install:
            cmd += f" -i {install}"
        if upgrade:
            cmd += f" -u {upgrade}"
        cmd += " --stop-after-init"
        return cmd, db, False

    other_args = start.get("other_args", "")
    if other_args:
        cmd += f" {other_args}"

    is_new = not DATABASE.db_initialized(db)
    on_create_args = start.get("on_create_args", "")
    if is_new and on_create_args:
        cmd += f" {on_create_args}"
    return cmd, db, is_new


def warn_if_rust_bundler_missing(config, bus, context=""):
    """goo auto-installs the rust_bundler addon in every database it launches, but
    the speedup only happens when the rust_bundler config key is on AND Goo's
    native Rust extension is current in the instance's venv — otherwise
    the addon falls back to the slow Python bundler and its only warning lands in
    the odoo log, easy to miss. When the feature is on, probe the venv in the
    background and explain in the goo log when the extension is missing. Returns
    the probe thread (callers may ignore it; tests join it), or None when off."""
    if not (config or {}).get("rust_bundler"):
        return None  # feature off — the addon won't engage, nothing to warn about

    def check():
        status = RUST_BUNDLER.status(config)
        if not status.get("current"):
            where = f" ({context})" if context else ""
            detail = "not installed"
            if status.get("installed"):
                detail = (
                    f"version {status.get('version')} is stale "
                    f"(expected {status.get('expected_version')})"
                )
            bus.publish_log(
                f"{TAG} rust_bundler{where}: Goo's native extension is {detail}; "
                "JS asset bundling stays on the Python path. Use Configuration > "
                "Build / update Rust bundler, then restart Odoo."
            )

    thread = threading.Thread(target=check, daemon=True)
    thread.start()
    return thread


def build_shell_cmd(config, db):
    """Build an `odoo-bin shell -d <db>` command (Python read from its stdin) for a
    one-off task like pregenerating assets. Mirrors build_odoo_cmd's venv prefix and
    addons-path, but spans ALL configured repos (not just start.repos) so whatever
    is installed in <db> can load. Raises ValueError on invalid config/db name."""
    if not services._valid_db_name(db):
        raise ValueError("invalid database name")
    repo_map = {
        r["id"]: {**r, "path": os.path.expanduser(r["path"])}
        for r in config.get("repos", [])
        if isinstance(r, dict) and "id" in r and "path" in r
    }
    community = repo_map.get("community")
    if not community:
        raise ValueError("no 'community' repo defined in repos")
    community_path = community["path"]
    addons_parts = [
        "addons" if rid == "community" else os.path.relpath(repo["path"], community_path)
        for rid, repo in repo_map.items()
    ]
    addons_parts.append(ADDONS_DIR)  # goo's own addons
    addons_path = ",".join(addons_parts)

    db_user = config.get("db_user", "odoo")
    db_password = config.get("db_password", "odoo")
    venv_activate = config.get("venv_activate", "")
    server_path = config.get("server_path") or os.path.join(community_path, "odoo-bin")

    parts = []
    if venv_activate:
        parts.append(venv_activate)
    rust = "RUST_BUNDLER=1 " if config.get("rust_bundler") else ""
    parts.append(f"cd {community_path} && {rust}{server_path}")
    cmd = " && ".join(parts)
    cmd += (
        f" shell -d {db} --no-http --no-database-list"
        f" -r {db_user} -w {db_password} --addons-path {addons_path} --log-level=warn"
    )
    return cmd


# =============================================================================
# WebSocket helpers (no external deps — only stdlib hashlib/base64/struct)
# =============================================================================

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
RAW_BUF_MAX = 256 * 1024  # raw PTY byte ring buffer for terminal replay


def _ws_accept_key(key):
    digest = hashlib.sha1((key + _WS_GUID).encode()).digest()
    return base64.b64encode(digest).decode()


def _ws_send_frame(sock, payload, opcode=2):
    """Send one unmasked WebSocket frame (server→client). opcode 2 = binary."""
    n = len(payload)
    if n < 126:
        header = bytes([0x80 | opcode, n])
    elif n < 65536:
        header = bytes([0x80 | opcode, 126]) + struct.pack(">H", n)
    else:
        header = bytes([0x80 | opcode, 127]) + struct.pack(">Q", n)
    sock.sendall(header + (payload if isinstance(payload, bytes) else bytes(payload)))


def _ws_recv_frame(sock):
    """Receive one WebSocket frame (client→server, always masked).
    Returns (opcode, payload_bytes). Raises OSError on disconnect."""

    def _recv(n):
        buf = b""
        while len(buf) < n:
            chunk = sock.recv(n - len(buf))
            if not chunk:
                raise OSError("WebSocket disconnected")
            buf += chunk
        return buf

    b0, b1 = _recv(2)
    opcode = b0 & 0x0F
    masked = bool(b1 & 0x80)
    length = b1 & 0x7F
    if length == 126:
        length = struct.unpack(">H", _recv(2))[0]
    elif length == 127:
        length = struct.unpack(">Q", _recv(8))[0]
    mask = _recv(4) if masked else b""
    payload = bytearray(_recv(length))
    if masked:
        for i in range(len(payload)):
            payload[i] ^= mask[i % 4]
    return opcode, bytes(payload)


# =============================================================================
# Workspace process manager
# =============================================================================


class _Entry:
    """The full per-workspace server state — one per workspace id. Every entry has
    the complete kit: a PTY (terminal channel), a one-shot run slot with
    resume-after, per-server log scrollback, and its own port bookkeeping ("main"
    keeps port None — odoo's implicit default)."""

    LOG_TAIL = 500  # lines kept per server so a freshly-selected workspace has scrollback

    def __init__(self, wsid):
        self.id = wsid
        # process/lifecycle: stopped -> starting -> running -> stopping -> stopped
        self.state = "stopped"
        self.process = None
        self.master_fd = None
        self.reader_thread = None
        self.db = None
        self.workspace = None  # the workspace this server runs
        self.cmd = None
        self.mode = "server"  # server | test | install | upgrade
        self.started_at = None
        self.exited_unexpectedly = False
        self.returncode = None
        self.port = None  # None for "main" (odoo default); the bound http port otherwise
        self.gport = None
        # one-shot Run occupying the slot (test/install/upgrade) — None for a plain
        # server or when stopped; kept as the last finished snapshot until superseded.
        # resume-after: the config of the server interrupted to run the one-shot.
        self.run = None
        self.server_config = None
        self.resume_config = None
        # per-server log tail (worktree screens prime their scrollback from it)
        self.log = collections.deque(maxlen=self.LOG_TAIL)
        # raw PTY byte ring buffer: replayed to each new terminal WebSocket client
        # so xterm.js can reconstruct the current terminal state on connect
        self.raw_buf = bytearray()
        self.raw_lock = threading.Lock()
        self.ws_clients = set()  # set of queue.Queue, one per terminal WS connection


class WorkspaceManager:
    """Owns every workspace's odoo server — the permanent "main" entry (the primary
    checkout's server, on odoo's default port) plus one entry per worktree
    workspace, each on its own stable port, all running concurrently. Each entry
    carries a PTY terminal channel, readiness detection, a one-shot run slot with
    backend-owned resume-after, and per-server log routing on the single 'log'
    {server, line} SSE stream (main lines also feed the shared backlog ring; other
    servers keep a bounded per-entry tail).

    Locking: `self.lock` guards the entries dict and every entry's lifecycle
    fields; each entry's `raw_lock` guards only its raw_buf/ws_clients (terminal
    fan-out never contends with lifecycle ops). Lock order: lock -> raw_lock,
    never the reverse. build_odoo_cmd (psql probe) and status()'s odoo_info are
    never called under `self.lock`.
    """

    def __init__(self, bus):
        self.bus = bus
        self.lock = threading.Lock()
        self.entries = {"main": _Entry("main")}  # wsid -> _Entry; entries never removed
        self._run_seq = 0  # manager-level so run ids stay unique across workspaces

    # ── snapshots ────────────────────────────────────────────────────────────────

    def status(self):
        """The enriched "main" snapshot (GET /api/status + SSE priming)."""
        with self.lock:
            e = self.entries["main"]
            active = e.state in ("starting", "running")
            snap = ServerSnapshot(
                id="main",
                state=e.state,
                terminal=True,  # the main server owns the default PTY/xterm channel
                pid=e.process.pid if (active and e.process) else None,
                db=e.db if active else None,
                workspace=e.workspace if active else None,
                cmd=e.cmd if active else None,
                mode=e.mode if active else None,
                started_at=e.started_at if active else None,
                exited_unexpectedly=e.exited_unexpectedly,
                returncode=e.returncode if e.exited_unexpectedly else None,
            )
        # asdict → every field present (odoo_version/enterprise/exists = None here),
        # so the client's spread-merge behaves as a full replace for "main"
        status = asdict(snap)
        status["odoo_port_busy"] = port_busy(ODOO_PORT)
        if status["db"]:
            version, enterprise, _demo_data, _ = DATABASE.odoo_info(status["db"])
            status["odoo_version"] = version
            status["enterprise"] = enterprise
        return status

    def _public(self, entry):
        """The SSE/JSON-safe view of a non-main entry. `exists` is dropped here:
        it's a client-facing on-disk fact added only by status_for on bootstrap, so
        the live SSE stream carries just state/port and the client's spread-merge
        preserves the bootstrapped `exists` rather than clobbering it with null.
        terminal=True: every entry has carried its own PTY channel since the
        manager unification (the synthesized never-started snapshot in status_for
        keeps False — no entry, no PTY yet)."""
        snap = asdict(
            ServerSnapshot(
                id=entry.id,
                state=entry.state,
                terminal=True,
                workspace=entry.id,
                db=entry.db,
                port=entry.port,
            )
        )
        del snap["exists"]
        return snap

    def _echo(self, entry, line):
        """An orchestration message (port fallback, stopping, errors) on a non-main
        server's own log stream, recorded in its scrollback deque like process
        output so /api/workspace/logs replays it."""
        entry.log.append(line)
        self.bus.publish_log(line, server=entry.id)

    def _snapshot(self, wsid, public):
        """The wire snapshot for a publish: main's enriched status() (must run
        outside self.lock — psql), else the `public` view computed under it."""
        return self.status() if wsid == "main" else public

    def public_snapshots(self):
        """One wire snapshot per known entry, main first — for SSE priming."""
        with self.lock:
            others = [self._public(e) for w, e in self.entries.items() if w != "main"]
        return [self.status()] + others

    def run_snapshot(self, wsid="main"):
        """One workspace's current/last one-shot run, or None."""
        with self.lock:
            e = self.entries.get(wsid)
            return dict(e.run) if e and e.run else None

    def run_snapshots(self):
        """Every workspace's current/last run — primed on SSE connect."""
        with self.lock:
            return [dict(e.run) for e in self.entries.values() if e.run]

    def server_config(self, wsid):
        """The config of a workspace's last plain-server start, for resume-after."""
        with self.lock:
            e = self.entries.get(wsid)
            return e.server_config if e else None

    def entry_for_terminal(self, wsid):
        """The entry whose PTY a terminal WebSocket attaches to, or None."""
        with self.lock:
            return self.entries.get(wsid)

    # ── lifecycle ────────────────────────────────────────────────────────────────

    def _db_conflict(self, wsid, db):
        """The refusal message when `db` is held by another active workspace, else
        None (two odoo processes on one db corrupt it). Called under self.lock."""
        for other, e in self.entries.items():
            if other == wsid or e.state not in ("starting", "running"):
                continue
            if e.db != db:
                continue
            if other == "main":
                return f"database '{db}' is in use by the main server"
            if wsid == "main":
                return f"database '{db}' is in use by the '{other}' workspace server"
            return f"database '{db}' is in use by another workspace's server"
        return None

    def start(self, wsid, config, resume_config=None):
        """Launch a workspace's odoo process. A one-shot (test/install/upgrade) is
        minted as a first-class Run occupying the slot; `resume_config` (set by
        oneshot() when a running server was interrupted) is the server config to
        restart when the run ends. "main" runs on odoo's default ports; other
        workspaces on their stable cfg["worktree_port"] when set and free, else an
        OS-assigned one. Returns (ok, detail): detail is {"cmd", "port"} on
        success, else an error code."""
        if not wsid:
            return False, "missing workspace"
        main = wsid == "main"
        # build the command before taking the lock — it runs a psql probe
        # (db_initialized) that must never stall the other workspaces
        try:
            cmd, db, is_new = build_odoo_cmd(config)
        except ValueError as e:
            return False, f"invalid_config: {e}"
        with self.lock:
            entry = self.entries.get(wsid)
            if entry is None:
                entry = self.entries[wsid] = _Entry(wsid)
            if entry.state != "stopped":
                return False, "already_running"
            conflict = self._db_conflict(wsid, db)
            if conflict:
                return False, conflict

            entry.exited_unexpectedly = False
            entry.returncode = None
            entry.db = db
            entry.workspace = config.get("workspace")
            s = config.get("start") or {}
            entry.mode = (
                "test"
                if s.get("test_tags")
                else "install"
                if s.get("install")
                else "upgrade"
                if s.get("upgrade")
                else "server"
            )
            entry.started_at = time.time()
            if main:
                entry.port = None
                entry.gport = None
                full_cmd = cmd
            else:
                wanted = config.get("worktree_port")
                if wanted and port_is_free(wanted):
                    port = wanted
                else:
                    if wanted:
                        self._echo(
                            entry,
                            f"{TAG} port {wanted} is busy — falling back to a free port",
                        )
                    port = free_port()
                entry.port = port
                entry.gport = free_port()
                full_cmd = f"{cmd} --http-port {port} --gevent-port {entry.gport}"
            entry.cmd = full_cmd
            # a plain server clears any active run and is remembered so a later run can
            # resume it; a one-shot run is minted as a Run and records its resume config
            if entry.mode == "server":
                entry.run = None
                entry.server_config = config
                entry.resume_config = None
            else:
                self._run_seq += 1
                spec = (
                    {"tags": s.get("test_tags")}
                    if entry.mode == "test"
                    else {"module": s.get("install") or s.get("upgrade")}
                )
                entry.run = asdict(
                    RunSnapshot(
                        id=f"run-{self._run_seq}",
                        kind=entry.mode,
                        state="running",
                        server=wsid,
                        workspace=entry.workspace,
                        db=db,
                        spec=spec,
                        resume=bool(resume_config),
                        started_at=entry.started_at,
                    )
                )
                entry.resume_config = resume_config
            if main:
                if is_new:
                    self.bus.publish_log(
                        f"{TAG} database '{db}' not initialized, applying on_create_args"
                    )
                self.bus.publish_log(f"{TAG} starting odoo: {full_cmd}")
                warn_if_rust_bundler_missing(config, self.bus)
            else:
                # the workspace's own stream — its log pane shows the exact launch cmd
                self.bus.publish_log(f"{TAG} starting odoo: {full_cmd}", server=wsid)
                warn_if_rust_bundler_missing(config, self.bus, context=f"workspace {wsid}")

            entry.log.clear()
            with entry.raw_lock:
                entry.raw_buf.clear()

            effects.trace("run", full_cmd)
            master_fd, slave_fd = pty.openpty()
            entry.process = subprocess.Popen(
                full_cmd,
                shell=True,
                executable="/bin/bash",
                stdout=slave_fd,
                stderr=slave_fd,
                stdin=slave_fd,
                preexec_fn=os.setsid,
            )
            os.close(slave_fd)
            entry.master_fd = master_fd
            entry.state = "starting"
            entry.reader_thread = threading.Thread(
                target=self._reader,
                args=(wsid, master_fd, entry.process),
                daemon=True,
            )
            entry.reader_thread.start()
            run = entry.run
            port_out = entry.port
            public = None if main else self._public(entry)
        self.bus.publish_server(self._snapshot(wsid, public))
        if run:
            self.bus.publish_run(dict(run))  # a fresh one-shot run went "running"
        return True, {"cmd": full_cmd, "port": port_out}

    def stop(self, wsid):
        """Stop a workspace's server. Idempotent; frees its port (for "main", only
        as a fallback when something still holds the default odoo port — orphans,
        external servers)."""
        main = wsid == "main"
        with self.lock:
            entry = self.entries.get(wsid)
            if not entry:
                return True, "stopped"  # unknown workspace — nothing to do
            if entry.state == "stopping":
                # someone else is finishing the job; main keeps its historical
                # refusal (the UI disables Stop on it), workspaces stay idempotent
                return (False, "already_stopping") if main else (True, "stopped")
            was_active = entry.state in ("starting", "running")
            process = entry.process
            reader = entry.reader_thread
            port = entry.port
            if was_active:
                entry.state = "stopping"

        if was_active:
            if main:
                self.bus.publish_server(self.status())
                self.bus.publish_log(f"{TAG} stopping odoo...")
            else:
                self._echo(entry, f"{TAG} stopping odoo...")
            # never let an exception leave us stuck in "stopping" (the guard
            # above would then refuse every future stop until goo restarts)
            try:
                terminate_process(process)
            except Exception as e:
                if main:
                    self.bus.publish_log(f"{TAG} error while stopping: {e}")
                else:
                    self._echo(entry, f"{TAG} error while stopping: {e}")
            # terminate_process already SIGKILLed odoo's whole process group, so the
            # port is normally free now — the lsof kill is the orphan fallback ("main"
            # only when something still listens; workspaces always, as before)
            if main:
                if port_busy(ODOO_PORT):
                    kill_port(ODOO_PORT)
            elif port:
                kill_port(port)
            if reader:
                reader.join(timeout=2)
            with self.lock:
                entry.state = "stopped"
                entry.process = None
                entry.master_fd = None
                if main:
                    entry.db = None
                    entry.workspace = None
                    entry.cmd = None
                    entry.started_at = None
                public = None if main else self._public(entry)
            if main:
                self.bus.publish_log(f"{TAG} odoo stopped")
        else:
            if main and port_busy(ODOO_PORT):
                kill_port(ODOO_PORT)
                self.bus.publish_log(f"{TAG} killed process on port {ODOO_PORT}")
            elif not main and port:
                kill_port(port)
            with self.lock:
                public = None if main else self._public(entry)

        self.bus.publish_server(self._snapshot(wsid, public))
        return True, "stopped"

    def restart(self, wsid, config):
        ok, detail = self.stop(wsid)
        if not ok:
            return ok, detail
        return self.start(wsid, config)

    def oneshot(self, wsid, config):
        """Run a one-shot (tests/install/upgrade) on a workspace's slot: interrupt
        its plain server if one is running (remembering its config so the run's end
        restarts it — resume-after, owned server-side), then start the one-shot."""
        with self.lock:
            entry = self.entries.get(wsid)
            active = entry and entry.state in ("starting", "running")
            resume = entry.server_config if (active and entry.mode == "server") else None
        self.stop(wsid)
        return self.start(wsid, config, resume_config=resume)

    def stop_and_finalize(self, wsid):
        """Stop a workspace's server; if that manually killed an active one-shot
        run, finalize it (returncode None → failed) and resume the server it had
        interrupted — the mirror of the reader thread's natural-finish path (which
        bails out on manual stops because stop() owns the exit)."""
        ok, detail = self.stop(wsid)
        if ok:
            resume = self.finish_run(wsid, None)
            if resume:
                self.start(wsid, resume)
        return ok, detail

    def finish_run(self, wsid, returncode):
        """Finalize a workspace's active run (if any) and return the server config
        to resume, or None. `returncode` is the process exit code, or None when the
        run was stopped manually. Publishes the finished run. The caller holds no
        lock and, if a config is returned, restarts the server via start()."""
        with self.lock:
            entry = self.entries.get(wsid)
            run = entry.run if entry else None
            if not run or run.get("state") != "running":
                return None
            if returncode is None:  # manually stopped mid-run
                run["state"] = "failed"
                run["ok"] = False
            else:
                run["state"] = "failed" if returncode else "done"
                run["ok"] = returncode == 0
            run["returncode"] = returncode
            snapshot = dict(run)
            resume = entry.resume_config
            entry.resume_config = None
        self.bus.publish_run(snapshot)
        return resume

    def shutdown(self):
        """Cleanup on goo exit/restart: stop every server we started, but never
        touch an external odoo we didn't start."""
        with self.lock:
            active = [w for w, e in self.entries.items() if e.state in ("starting", "running")]
        for w in active:
            self.stop(w)

    # ── output plumbing ──────────────────────────────────────────────────────────

    def _emit_raw(self, entry, data):
        """Append raw PTY bytes to the entry's ring buffer and fan out to its
        terminal WS clients."""
        with entry.raw_lock:
            entry.raw_buf += data
            if len(entry.raw_buf) > RAW_BUF_MAX:
                entry.raw_buf = entry.raw_buf[-RAW_BUF_MAX:]
            clients = list(entry.ws_clients)
        for q in clients:
            q.put(data)

    def _reader(self, wsid, fd, process):
        """Read a workspace's PTY, fan lines out, detect readiness and unexpected
        exit. One thread per running entry."""
        entry = self.entries[wsid]
        buf = b""
        while True:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            self._emit_raw(entry, data)
            buf += data
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                self._handle_line(wsid, process, raw.decode("utf-8", errors="replace").rstrip("\r"))
        if buf:
            self._handle_line(wsid, process, buf.decode("utf-8", errors="replace").rstrip("\r"))
        try:
            os.close(fd)
        except OSError:
            pass

        ret = process.wait()
        main = wsid == "main"
        with self.lock:
            # stop() owns intentional exits; a stale reader (post-restart)
            # must not touch the new process state
            if entry.state == "stopping" or entry.process is not process:
                return
            entry.state = "stopped"
            entry.process = None
            entry.master_fd = None
            if main:
                entry.db = None
                entry.workspace = None
                entry.cmd = None
                entry.started_at = None
            entry.exited_unexpectedly = True
            entry.returncode = ret
            public = None if main else self._public(entry)
        if main:
            self.bus.publish_log(f"{TAG} odoo exited unexpectedly (code {ret})")
        else:
            self.bus.publish_event(
                f"workspace server ({wsid}) exited unexpectedly (code {ret})", level="error"
            )
        self.bus.publish_server(self._snapshot(wsid, public))
        # a one-shot run just ended on its own: finalize it and, if it had interrupted
        # a server, bring that server back (resume-after, owned here so it survives a
        # mid-run reload). start() runs a fresh process + reader thread.
        resume = self.finish_run(wsid, ret)
        if resume:
            self.start(wsid, resume)

    def _handle_line(self, wsid, process, line):
        """Route one output line to its server's log stream (SSE 'log'
        {server, line}; main's lines also feed the shared backlog ring) and flip
        starting→running on the ready marker. A stale process's lines are dropped."""
        entry = self.entries.get(wsid)
        main = wsid == "main"
        with self.lock:
            if not entry or entry.process is not process:
                return
            entry.log.append(line)
            ready = READY_MARKER in line and entry.state == "starting"
            if ready:
                entry.state = "running"
            public = None if main else self._public(entry)
        self.bus.publish_log(line, server=wsid)
        if ready:
            self.bus.publish_server(self._snapshot(wsid, public))

    # ── bootstrap reads ──────────────────────────────────────────────────────────

    def logs_for(self, wsid):
        """The buffered log tail (list of lines) for one workspace server, or []."""
        with self.lock:
            entry = self.entries.get(wsid)
            return list(entry.log) if entry else []

    def status_for(self, workspaces):
        """workspaces: [{"id", "dirPath"}]. Returns {id: ServerSnapshot-dict}, merging
        each workspace's on-disk worktree existence with its live server state (or
        a stopped snapshot when no server has run yet)."""
        with self.lock:
            servers = {w: self._public(e) for w, e in self.entries.items() if w != "main"}
        out = {}
        for t in workspaces:
            tid = t.get("id")
            if not tid:
                continue
            snap = servers.get(tid) or asdict(
                ServerSnapshot(id=tid, state="stopped", terminal=False, workspace=tid)
            )
            snap["exists"] = effects.is_dir(t.get("dirPath", ""))
            out[tid] = snap
        return out


def _summarize_tool(name, inp):
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

    def __init__(self, bus):
        self.bus = bus
        self.lock = threading.Lock()
        self.convos = {}  # target_id -> entry dict

    def _entry(self, target):
        e = self.convos.get(target)
        if e is None:
            e = {"state": "idle", "session": None, "process": None, "history": []}
            self.convos[target] = e
        return e

    def _emit(self, target, item):
        """Record one chat item in the target's transcript and push it to the browser.
        `item` is a {role, ...} dict (assistant/tool/result/error); user prompts are
        stored (for re-prime) but not re-pushed — the sending client shows them
        optimistically."""
        with self.lock:
            e = self._entry(target)
            e["history"].append(item)
            del e["history"][: -self.HISTORY_MAX]
        if item.get("role") != "user":
            self.bus.publish_claude({"workspace": target, **item})

    def send(self, target, prompt, cwd, add_dirs=None, model=None):
        """Spawn a Claude turn for <target> in <cwd> (its worktree checkout), resuming
        the target's session when one exists. `model` (a CLI alias/name, e.g. "sonnet"
        or "opus[1m]") overrides the CLI's default when set. Returns (ok, detail)."""
        if not target or not (prompt or "").strip():
            return False, "missing workspace or prompt"
        if not effects.is_dir(cwd):
            return False, f"worktree checkout not found: {cwd}"
        with self.lock:
            e = self._entry(target)
            if e["state"] == "running":
                return False, "already_running"
            session = e["session"]
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
        for d in add_dirs or []:
            if d:
                cmd += ["--add-dir", d]
        self._emit(target, {"role": "user", "text": prompt})
        self.bus.publish_log(f"{TAG} claude ({target}) in {cwd}: {' '.join(cmd)}")
        effects.trace("run", " ".join(cmd))
        try:
            process = subprocess.Popen(
                cmd,
                cwd=cwd,
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
        try:
            process.stdin.write(prompt)
            process.stdin.close()
        except (BrokenPipeError, OSError):
            pass
        threading.Thread(target=self._reader, args=(target, process), daemon=True).start()
        return True, {"state": "running"}

    def _reader(self, target, process):
        """Drain the stream-json output: forward each assistant text / tool call as a
        chat item, capture the session id, and finalize on the result line (or on an
        unexpected exit, surfacing whatever non-JSON output we saw as the error)."""
        stray = []
        got_result = False
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

    def _handle(self, target, obj):
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
            self._emit(target, item)
            return True
        return False

    def stop(self, target):
        """Interrupt a running Claude turn (idempotent)."""
        with self.lock:
            e = self.convos.get(target)
            process = e["process"] if e and e["state"] == "running" else None
        if process is not None:
            self.bus.publish_log(f"{TAG} stopping claude ({target})...")
            try:
                terminate_process(process)
            except Exception as ex:
                self.bus.publish_log(f"{TAG} error stopping claude ({target}): {ex}")
        with self.lock:
            e = self.convos.get(target)
            if e:
                e["state"] = "idle"
                e["process"] = None
        self.bus.publish_claude({"workspace": target, "role": "result", "ok": True})
        return True, "stopped"

    def history_for(self, target):
        """The transcript + live state for one target, to re-prime the chat on load."""
        with self.lock:
            e = self.convos.get(target)
            if not e:
                return {"items": [], "state": "idle"}
            return {"items": list(e["history"]), "state": e["state"]}

    def forget(self, target):
        """Drop a workspace's conversation (its worktree was removed)."""
        self.stop(target)
        with self.lock:
            self.convos.pop(target, None)

    def shutdown(self):
        """Stop every running turn (goo exit / restart)."""
        with self.lock:
            targets = [t for t, e in self.convos.items() if e["state"] == "running"]
        for t in targets:
            self.stop(t)


BUS = EventBus()
WORKSPACES = WorkspaceManager(BUS)
CLAUDE = ClaudeManager(BUS)
# services layer over the IO seam (effects): external state fetched + parsed +
# cached server-side. TTLs: PRs 10 min, runbot/mergebot 5 min, databases 1 min.
# A `refresh` flag on the read endpoints bypasses the cache (the UI's manual Refresh).
GITHUB = services.GitHubService(effects, TTLCache(600))
RUNBOT = services.RunbotService(effects, TTLCache(300))
MERGEBOT = services.MergebotService(effects, TTLCache(8 * 3600))  # 8h TTL (states change slowly)
DATABASE = services.DatabaseService(effects, TTLCache(60))
# git on the user's repos — uncached (branch reads are volatile + fast); notify
# routes the fetch/rebase progress phases to the browser event log
GIT = services.GitService(effects, notify=BUS.publish_event)
ADDONS = services.AddonsService(effects)
ASSETS = services.AssetsService(effects, TTLCache(30))
RUST_BUNDLER = services.RustBundlerService(
    effects,
    os.path.join(ADDONS_DIR, "rust_bundler", "native"),
    notify=BUS.publish_event,
)
# 24h is just a safety net for the versions/night-index keys (refresh=True bypasses
# them); per-build detail keys are never invalidated — see NightlyService's docstring.
NIGHTLY = services.NightlyService(effects, TTLCache(24 * 3600))
MEMORY = services.MemoryService(effects)


def _default_config_path():
    """goo's server-owned config file, outside the checkout (so the --ff-only
    self-updater never touches it). Honors XDG_CONFIG_HOME. Overridable with
    `goo --config <path>` (resolved in main())."""
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "goo", "config.json")


# the server-owned config: {rev, config, state}. The frontend owns the schema and
# mirrors this file; the CLI / auto-reloader / update-check read it directly. `.path`
# may be reassigned in main() from --config before any request/loop reads it.
CONFIG_PATH = _default_config_path()
CONFIG = services.ConfigStore(effects, CONFIG_PATH, notify=BUS.publish_config)


def _autoreload_repos():
    """The config's repos opted into the 4h background `git fetch master`."""
    cfg = CONFIG.get()["config"] or {}
    return [
        {"id": r.get("id"), "path": r.get("path"), "github": r.get("github")}
        for r in (cfg.get("repos") or [])
        if r.get("autoreload") and r.get("path")
    ]


AUTORELOAD = AutoReloader(_autoreload_repos)
# how goo's own checkout compares to origin/master (filled by check_goo_update at
# startup; the navbar reads it via GET /api/goo/update)
GOO_UPDATE = {
    "checked": False,
    "is_repo": False,
    "branch": "",
    "behind": 0,
    "ahead": 0,
    "dirty": False,
    "can_fast_forward": False,
}
# per-process boot id (changes on every (re-)exec) so the client can tell a
# restarted goo apart from the still-shutting-down old one when it polls
BOOT_ID = time.time()


# =============================================================================
# HTTP server
# =============================================================================


class Handler(BaseHTTPRequestHandler):
    # the origins a browser is allowed to drive goo from — goo's own UI. Anything
    # else with an Origin header is a cross-site request (CSRF) and is refused.
    ALLOWED_ORIGINS = frozenset(f"http://{host}:{PORT}" for host in ("127.0.0.1", "localhost"))

    def log_message(self, format, *args):
        pass  # keep the terminal quiet

    def _origin_ok(self):
        """Reject cross-site requests. goo exposes shell-equivalent endpoints on
        localhost; localhost is not an auth boundary against the user's own
        browser, so a malicious page could POST/WS to us without this check.
        Browsers attach Origin to every cross-origin POST and WebSocket handshake,
        so an Origin outside our allowlist is a CSRF attempt. A missing Origin is a
        non-browser client (curl, the --test-tags CLI) and carries no CSRF risk."""
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        return origin in self.ALLOWED_ORIGINS

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/":
            self._serve_static("index.html")
        elif path.startswith("/static/"):
            self._serve_static(path[len("/static/") :])
        elif path == "/api/status":
            self._send_json(200, WORKSPACES.status())
        elif path == "/api/goo/update":
            self._send_json(200, {**GOO_UPDATE, "boot": BOOT_ID})
        elif path == "/api/rust-bundler":
            config = CONFIG.get().get("config") or {}
            self._send_json(200, {"ok": True, **RUST_BUNDLER.status(config)})
        elif path == "/api/databases":
            refresh = "refresh" in urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try:
                self._send_json(200, {"ok": True, "databases": DATABASE.databases(refresh=refresh)})
            except RuntimeError as e:
                self._send_json(500, {"ok": False, "error": str(e)})
        elif path == "/api/reviews":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            refresh = "refresh" in qs
            days = int((qs.get("days") or ["14"])[0])
            result = GITHUB.reviewed(days=days, refresh=refresh)
            if result.get("error"):
                return self._send_json(500, {"ok": False, "error": result["error"]})
            self._send_json(
                200,
                {"ok": True, "prs": result["prs"], "days": days, "capped": result.get("capped")},
            )
        elif path == "/api/events":
            self._handle_events()
        elif path == "/api/terminal":
            self._handle_terminal()
        elif path == "/api/shell":
            self._handle_shell()
        elif path == "/api/config":
            self._send_json(200, {"ok": True, **CONFIG.get()})
        else:
            self._send_json(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        if not self._origin_ok():
            return self._send_json(403, {"ok": False, "error": "cross-origin request refused"})
        path = self.path.split("?", 1)[0]
        if path == "/api/start":
            self._action_start(lambda cfg: WORKSPACES.start("main", cfg))
        elif path == "/api/restart":
            self._action_start(lambda cfg: WORKSPACES.restart("main", cfg))
        elif path in ("/api/tests/run", "/api/addons/run"):
            self._action_oneshot()
        elif path == "/api/config":
            self._save_config()
        elif path == "/api/rust-bundler/install":
            config = CONFIG.get().get("config") or {}
            ok, result = RUST_BUNDLER.install(config)
            status = 200 if ok else 409 if "already in progress" in result.get("error", "") else 500
            self._send_json(status, {"ok": ok, **result})
        elif path == "/api/cli/test":
            self._handle_cli_test()
        elif path == "/api/stop":
            ok, detail = WORKSPACES.stop_and_finalize("main")
            if ok:
                self._send_json(200, {"ok": True, "state": "stopped"})
            else:
                self._send_json(409, {"ok": False, "error": detail})
        elif path == "/api/code/branches":
            body, err = self._read_json()
            repos = (body or {}).get("repos")
            if err or not isinstance(repos, list):
                return self._send_json(400, {"ok": False, "error": "missing repos list"})
            self._send_json(200, {"ok": True, "repos": GIT.branches(repos)})
        elif path == "/api/prs":
            body, err = self._read_json()
            repos = (body or {}).get("repos")
            if err or not isinstance(repos, list):
                return self._send_json(400, {"ok": False, "error": "missing repos list"})
            prs = GITHUB.prs(repos, refresh=bool((body or {}).get("refresh")))
            self._send_json(200, {"ok": True, "repos": prs})
        elif path == "/api/mergebot":
            body, err = self._read_json()
            prs = (body or {}).get("prs")
            if err or not isinstance(prs, list):
                return self._send_json(400, {"ok": False, "error": "missing prs list"})
            states, details, forward_ports, unsupported = MERGEBOT.statuses(
                prs, refresh=bool((body or {}).get("refresh"))
            )
            self._send_json(
                200,
                {
                    "ok": True,
                    "states": states,
                    "details": details,
                    "forward_ports": forward_ports,
                    "unsupported": unsupported,
                },
            )
        elif path == "/api/runbot":
            body, err = self._read_json()
            branches = (body or {}).get("branches")
            if err or not isinstance(branches, list):
                return self._send_json(400, {"ok": False, "error": "missing branches list"})
            states = RUNBOT.statuses(branches, refresh=bool((body or {}).get("refresh")))
            self._send_json(200, {"ok": True, "states": states})
        elif path == "/api/nightly":
            body, _ = self._read_json()
            data = body or {}
            refresh = bool(data.get("refresh", False))
            max_nights = min(max(int(data.get("max_nights", 14)), 7), 84)
            self._send_json(
                200, {"ok": True, **NIGHTLY.builds(refresh=refresh, max_nights=max_nights)}
            )
        elif path == "/api/nightly/errors":
            body, err = self._read_json()
            url = (body or {}).get("url", "")
            if err or not re.match(r"^/runbot/batch/\d+/build/\d+$", url):
                return self._send_json(400, {"ok": False, "error": "invalid url"})
            self._send_json(200, {"ok": True, **NIGHTLY.build_errors(url)})
        elif path == "/api/memory/batch":
            body, err = self._read_json()
            url = (body or {}).get("url", "")
            if err or not url:
                return self._send_json(400, {"ok": False, "error": "missing url"})
            self._send_json(200, {"ok": True, "builds": NIGHTLY.batch_builds(url)})
        elif path == "/api/memory/fetch":
            body, err = self._read_json()
            builds = (body or {}).get("builds")
            if err or not isinstance(builds, list):
                return self._send_json(400, {"ok": False, "error": "missing builds list"})
            with_mobile = bool((body or {}).get("with_mobile", False))
            self._send_json(
                200, {"ok": True, "data": MEMORY.fetch(builds, with_mobile=with_mobile)}
            )
        elif path == "/api/addons":
            body, err = self._read_json()
            repos = (body or {}).get("repos")
            db = (body or {}).get("db")
            if err or not isinstance(repos, list):
                return self._send_json(400, {"ok": False, "error": "missing repos list"})
            mods = ADDONS.modules(repos)
            state = DATABASE.installed_modules(db) if db else {}
            for m in mods:
                m["state"] = state.get(m["name"])
            self._send_json(200, {"ok": True, "modules": mods, "db": db})
        elif path == "/api/assets":
            body, err = self._read_json()
            db = (body or {}).get("db")
            if err or not isinstance(db, str) or not db:
                return self._send_json(400, {"ok": False, "error": "missing db"})
            bundles = ASSETS.bundles(db, refresh=bool((body or {}).get("refresh")))
            self._send_json(200, {"ok": True, "db": db, "bundles": bundles})
        elif path == "/api/assets/generate":
            body, err = self._read_json()
            db = (body or {}).get("db")
            if err or not isinstance(db, str) or not db:
                return self._send_json(400, {"ok": False, "error": "missing db"})
            try:
                # the shell cmd is built from the server's own config; an optional
                # `workspace` resolves through the launch builder so a worktree
                # workspace's bundles are generated with ITS checkout's code
                cfg = CONFIG.get()["config"]
                wsid = (body or {}).get("workspace")
                if wsid:
                    cfg = services.build_start_config(cfg, wsid) or cfg
                cmd = build_shell_cmd(cfg, db)
            except ValueError as e:
                return self._send_json(400, {"ok": False, "error": str(e)})
            ok, error = ASSETS.generate(cmd, db)
            self._send_json(200 if ok else 400, {"ok": ok, "error": error})
        elif path == "/api/assets/breakdown":
            body, err = self._read_json()
            db = (body or {}).get("db")
            bundle = (body or {}).get("bundle")
            if (
                err
                or not isinstance(db, str)
                or not db
                or not isinstance(bundle, str)
                or not bundle
            ):
                return self._send_json(400, {"ok": False, "error": "missing db or bundle"})
            # read straight from the stored bundle attachment — no odoo process; the
            # configured filestore root locates <filestore>/<db>/<store_fname>. kind
            # scopes to the clicked asset ("js"/"css"); anything else reads both.
            kind = (body or {}).get("kind")
            if kind not in ("js", "css"):
                kind = None
            data, error = ASSETS.breakdown(db, bundle, _filestore(body), kind)
            if data is None:
                return self._send_json(400, {"ok": False, "error": error})
            self._send_json(200, {"ok": True, "bundle": bundle, **data})
        elif path == "/api/code/branches/delete":
            body, err = self._read_json()
            repo_path = (body or {}).get("path")
            branch = (body or {}).get("branch")
            if err or not repo_path or not branch:
                return self._send_json(400, {"ok": False, "error": "missing path or branch"})
            ok, error, remote_error = GIT.delete_branch(
                repo_path, branch, bool((body or {}).get("delete_remote"))
            )
            if ok:
                self._send_json(200, {"ok": True, "remote_error": remote_error})
            else:
                self._send_json(400, {"ok": False, "error": error})
        elif path == "/api/code/branches/create":
            body, err = self._read_json()
            branches = (body or {}).get("branches")
            if err or not isinstance(branches, list):
                return self._send_json(400, {"ok": False, "error": "missing branches list"})

            # create each branch in parallel — independent working trees, so a
            # multi-repo target's branches are created in one create's time, not the sum
            def mk(b):
                ok, error = GIT.create_branch(
                    b.get("path"),
                    b.get("name"),
                    b.get("start_point"),
                    fresh_start=bool(b.get("fresh_start")),
                    github=b.get("github"),
                    repo=b.get("repo", ""),
                )
                return {"name": b.get("name"), "ok": ok, "error": error}

            if branches:
                with ThreadPoolExecutor(max_workers=min(8, len(branches))) as pool:
                    results = list(pool.map(mk, branches))
            else:
                results = []
            self._send_json(200, {"ok": True, "results": results})
        elif path == "/api/open-editor":
            body, err = self._read_json()
            paths = (body or {}).get("paths") or (body or {}).get("path")
            if err or not paths:
                return self._send_json(400, {"ok": False, "error": "missing path"})
            ok, error = open_in_editor((body or {}).get("editor"), paths)
            self._send_json(200 if ok else 400, {"ok": ok, "error": error})
        elif path == "/api/goo/update":
            global GOO_UPDATE
            ok, error = goo_fast_forward()
            if ok:
                GOO_UPDATE = goo_update_status()
            self._send_json(200 if ok else 400, {"ok": ok, "error": error})
        elif path == "/api/goo/check":
            # on-demand re-check (the "Check for update" button) — fetches + recomputes
            ok = check_goo_update()
            self._send_json(200, {"ok": ok, **GOO_UPDATE, "boot": BOOT_ID})
        elif path == "/api/goo/restart":
            # reply first, then re-exec from a short-delayed thread so the response
            # reaches the client before the process is replaced
            self._send_json(200, {"ok": True})
            threading.Thread(target=lambda: (time.sleep(0.5), restart_goo()), daemon=True).start()
        elif path == "/api/code/checkout":
            body, err = self._read_json()
            repos = (body or {}).get("repos")
            if err or not isinstance(repos, list):
                return self._send_json(400, {"ok": False, "error": "missing repos list"})

            # check out each repo in parallel — independent working trees, so a
            # multi-repo target switches in one checkout's time, not the sum
            def co(r):
                ok, error = GIT.checkout(r.get("path"), r.get("branch"), r.get("repo", ""))
                return {"branch": r.get("branch"), "ok": ok, "error": error}

            if repos:
                with ThreadPoolExecutor(max_workers=min(8, len(repos))) as pool:
                    results = list(pool.map(co, repos))
            else:
                results = []
            self._send_json(200, {"ok": True, "results": results})
        elif path == "/api/code/rebase":
            body, err = self._read_json()
            repos = (body or {}).get("repos")
            if err or not isinstance(repos, list):
                return self._send_json(400, {"ok": False, "error": "missing repos list"})

            # fetch + rebase each repo in parallel — independent working trees, so the
            # slow network fetches overlap instead of running back-to-back (each phase
            # reports under its own event id, so the progress log stays unambiguous)
            def fr(r):
                ok, error = GIT.fetch_rebase(
                    r.get("path"), r.get("base"), r.get("github"), r.get("repo")
                )
                return {"repo": r.get("repo"), "ok": ok, "error": error}

            if repos:
                with ThreadPoolExecutor(max_workers=min(8, len(repos))) as pool:
                    results = list(pool.map(fr, repos))
            else:
                results = []
            self._send_json(200, {"ok": True, "results": results})
        elif path == "/api/workspace/create":
            # add a git worktree per repo (the frontend computes every path); git
            # creates the parent <worktree_dir>/<target>/ folder on the first add
            body, err = self._read_json()
            repos = (body or {}).get("repos")
            if err or not isinstance(repos, list) or not repos:
                return self._send_json(400, {"ok": False, "error": "missing repos list"})
            results = []
            for r in repos:
                ok, error = GIT.worktree_add(
                    r.get("mainPath"),
                    r.get("worktreePath"),
                    r.get("newBranch") or r.get("branch"),
                    r.get("repo", ""),
                    new_branch=bool(r.get("newBranch")),
                    start_point=r.get("startPoint"),
                    fresh_start=True,
                    github=r.get("github"),
                )
                results.append({"repo": r.get("repo"), "ok": ok, "error": error})
            self._send_json(200, {"ok": all(x["ok"] for x in results), "results": results})
        elif path == "/api/workspace/start":
            body, err = self._read_json()
            target = (body or {}).get("workspace")
            if err or not target:
                return self._send_json(400, {"ok": False, "error": "missing workspace"})
            cfg = self._build_launch(body)  # server builds the worktree launch config
            if cfg is None:
                return self._send_json(400, {"ok": False, "error": "unknown workspace"})
            ok, detail = WORKSPACES.start(target, cfg)
            if ok:
                self._send_json(200, {"ok": True, "port": detail["port"]})
            else:
                code = 400 if str(detail).startswith("invalid_config") else 409
                self._send_json(code, {"ok": False, "error": detail})
        elif path == "/api/workspace/stop":
            body, err = self._read_json()
            target = (body or {}).get("workspace")
            if err or not target:
                return self._send_json(400, {"ok": False, "error": "missing workspace"})
            # stop_and_finalize: a stop mid-run finalizes the run + resumes the
            # server it interrupted, exactly like /api/stop does for main
            ok, detail = WORKSPACES.stop_and_finalize(target)
            self._send_json(200 if ok else 409, {"ok": ok, "error": None if ok else detail})
        elif path == "/api/workspace/remove":
            body, err = self._read_json()
            repos = (body or {}).get("repos")
            dir_path = (body or {}).get("dirPath")
            if err or not isinstance(repos, list):
                return self._send_json(400, {"ok": False, "error": "missing repos list"})
            results = []
            for r in repos:
                ok, error = GIT.worktree_remove(
                    r.get("mainPath"), r.get("worktreePath"), r.get("repo", "")
                )
                results.append({"repo": r.get("repo"), "ok": ok, "error": error})
            if dir_path:
                effects.remove_tree(dir_path)  # sweep the now-empty parent folder
            target = (body or {}).get("workspace")
            if target:
                CLAUDE.forget(target)  # its checkout is gone; drop the chat + any run
            self._send_json(200, {"ok": all(x["ok"] for x in results), "results": results})
        elif path == "/api/workspace/list":
            body, err = self._read_json()
            workspaces = (body or {}).get("workspaces")
            if err or not isinstance(workspaces, list):
                return self._send_json(400, {"ok": False, "error": "missing workspaces list"})
            self._send_json(200, {"ok": True, "servers": WORKSPACES.status_for(workspaces)})
        elif path == "/api/workspace/logs":
            body, err = self._read_json()
            target = (body or {}).get("workspace")
            if err or not target:
                return self._send_json(400, {"ok": False, "error": "missing workspace"})
            self._send_json(200, {"ok": True, "lines": WORKSPACES.logs_for(target)})
        elif path == "/api/workspace/claude":
            body, err = self._read_json()
            target = (body or {}).get("workspace")
            prompt = (body or {}).get("prompt")
            cwd = (body or {}).get("cwd")
            add_dirs = (body or {}).get("addDirs") or []
            model = (body or {}).get("model")
            if err or not target or not prompt or not cwd:
                return self._send_json(
                    400, {"ok": False, "error": "missing workspace, prompt or cwd"}
                )
            ok, detail = CLAUDE.send(target, prompt, cwd, add_dirs, model=model)
            if ok:
                self._send_json(200, {"ok": True, "state": detail["state"]})
            else:
                code = 409 if detail == "already_running" else 400
                self._send_json(code, {"ok": False, "error": detail})
        elif path == "/api/workspace/claude/stop":
            body, err = self._read_json()
            target = (body or {}).get("workspace")
            if err or not target:
                return self._send_json(400, {"ok": False, "error": "missing workspace"})
            ok, detail = CLAUDE.stop(target)
            self._send_json(200, {"ok": ok, "error": None if ok else detail})
        elif path == "/api/workspace/claude/history":
            body, err = self._read_json()
            target = (body or {}).get("workspace")
            if err or not target:
                return self._send_json(400, {"ok": False, "error": "missing workspace"})
            self._send_json(200, {"ok": True, **CLAUDE.history_for(target)})
        elif path == "/api/databases/drop":
            body, err = self._read_json()
            name = (body or {}).get("name")
            if err or not name or not isinstance(name, str):
                return self._send_json(400, {"ok": False, "error": "missing database name"})
            ok, error = DATABASE.drop(name, _filestore(body))
            if ok:
                self._send_json(200, {"ok": True})
            else:
                self._send_json(400, {"ok": False, "error": error})
        elif path == "/api/databases/clone":
            body, err = self._read_json()
            source = (body or {}).get("source")
            target = (body or {}).get("dest")
            if (
                err
                or not isinstance(source, str)
                or not isinstance(target, str)
                or not source
                or not target
            ):
                return self._send_json(400, {"ok": False, "error": "missing source or dest"})
            ok, error = DATABASE.clone(source, target, _filestore(body))
            self._send_json(200 if ok else 400, {"ok": ok, "error": error})
        elif path == "/api/databases/rename":
            body, err = self._read_json()
            name = (body or {}).get("name")
            new_name = (body or {}).get("new_name")
            if (
                err
                or not isinstance(name, str)
                or not isinstance(new_name, str)
                or not name
                or not new_name
            ):
                return self._send_json(400, {"ok": False, "error": "missing name or new_name"})
            ok, error = DATABASE.rename(name, new_name, _filestore(body))
            self._send_json(200 if ok else 400, {"ok": ok, "error": error})
        elif path == "/api/prs/close":
            body, err = self._read_json()
            repo = (body or {}).get("repo")
            number = (body or {}).get("number")
            if err or not repo or not number:
                return self._send_json(400, {"ok": False, "error": "missing repo or number"})
            ok, error = GITHUB.close_pr(repo, number)
            if ok:
                self._send_json(200, {"ok": True})
            else:
                self._send_json(400, {"ok": False, "error": error})
        elif path == "/api/code/branch/remote":
            body, err = self._read_json()
            repo_path = (body or {}).get("path")
            branch = (body or {}).get("branch")
            if err or not repo_path or not branch:
                return self._send_json(400, {"ok": False, "error": "missing path or branch"})
            exists, error = GIT.remote_branch_exists(repo_path, branch)
            if error:
                self._send_json(400, {"ok": False, "error": error})
            else:
                self._send_json(200, {"ok": True, "exists": exists})
        elif path == "/api/code/branch/push":
            body, err = self._read_json()
            repo_path = (body or {}).get("path")
            branch = (body or {}).get("branch")
            if err or not repo_path or not branch:
                return self._send_json(400, {"ok": False, "error": "missing path or branch"})
            ok, error = GIT.push_branch(repo_path, branch, bool((body or {}).get("force")))
            if ok:
                self._send_json(200, {"ok": True})
            else:
                self._send_json(400, {"ok": False, "error": error})
        elif path == "/api/code/remote-branches/search":
            body, err = self._read_json()
            repos = (body or {}).get("repos", [])
            query = (body or {}).get("query", "")
            if err or not query or not isinstance(repos, list):
                return self._send_json(400, {"ok": False, "error": "missing query or repos"})
            results = GITHUB.search_branches(repos, query)
            self._send_json(200, {"ok": True, "results": results})
        elif path == "/api/code/remote-branch/fetch":
            body, err = self._read_json()
            repo_path = (body or {}).get("path")
            branch = (body or {}).get("branch")
            if err or not repo_path or not branch:
                return self._send_json(400, {"ok": False, "error": "missing path or branch"})
            ok, error = GIT.fetch_remote_branch(repo_path, branch)
            self._send_json(200 if ok else 400, {"ok": ok, "error": error})
        elif path == "/api/code/wip-commit":
            body, err = self._read_json()
            repo_path = (body or {}).get("path")
            if err or not repo_path:
                return self._send_json(400, {"ok": False, "error": "missing path"})
            ok, error = GIT.wip_commit(repo_path)
            self._send_json(200 if ok else 400, {"ok": ok, "error": error})
        elif path == "/api/code/discard":
            body, err = self._read_json()
            repo_path = (body or {}).get("path")
            if err or not repo_path:
                return self._send_json(400, {"ok": False, "error": "missing path"})
            ok, error = GIT.discard(repo_path)
            self._send_json(200 if ok else 400, {"ok": ok, "error": error})
        elif path == "/api/code/log":
            body, err = self._read_json()
            repo_path = (body or {}).get("path")
            if err or not repo_path:
                return self._send_json(400, {"ok": False, "error": "missing path"})
            count = int((body or {}).get("count") or 20)
            ref = (body or {}).get("ref") or ""
            commits, error = GIT.log(repo_path, count, ref)
            self._send_json(
                200 if error is None else 400,
                {"ok": error is None, "commits": commits or [], "error": error},
            )
        elif path == "/api/event":
            body, err = self._read_json()
            text = (body or {}).get("text")
            if err or not text:
                return self._send_json(400, {"ok": False, "error": "missing text"})
            # mirror the frontend event log on the goo terminal
            print(f"{TAG} {time.strftime('%H:%M:%S')} • {text}", flush=True)
            self._send_json(200, {"ok": True})
        else:
            self._send_json(404, {"ok": False, "error": "not_found"})

    # --- API helpers ---

    def _build_launch(self, body):
        """Resolve a thin {workspace, overrides} launch request against the server's
        own config into the dict build_odoo_cmd consumes (handles main + worktree
        workspaces). Returns None if the workspace is missing/unknown."""
        target = (body or {}).get("workspace")
        if not target:
            return None
        overrides = (body or {}).get("overrides") or {}
        return services.build_start_config(CONFIG.get()["config"], target, overrides)

    def _action_start(self, action):
        body, err = self._read_json()
        if err:
            return self._send_json(400, {"ok": False, "error": err})
        cfg = self._build_launch(body)
        if cfg is None:
            return self._send_json(400, {"ok": False, "error": "unknown workspace"})
        ok, detail = action(cfg)
        if ok:
            self._send_json(200, {"ok": True, "state": "starting", "cmd": detail["cmd"]})
        else:
            code = 400 if detail.startswith("invalid_config") else 409
            self._send_json(code, {"ok": False, "error": detail})

    def _action_oneshot(self):
        """Start a one-shot run (tests / install / upgrade) on a workspace's server
        slot — `body["slot"]` (default "main"). The slot's own server is stopped
        first; if a real server was interrupted, its config is handed to the run so
        the backend restarts it when the run ends (resume-after, owned server-side)."""
        body, err = self._read_json()
        if err:
            return self._send_json(400, {"ok": False, "error": err})
        cfg = self._build_launch(body)
        if cfg is None:
            return self._send_json(400, {"ok": False, "error": "unknown workspace"})
        wsid = (body or {}).get("slot") or "main"
        ok, detail = WORKSPACES.oneshot(wsid, cfg)
        if ok:
            self._send_json(200, {"ok": True, "state": "starting", "cmd": detail["cmd"]})
        else:
            code = 400 if detail.startswith("invalid_config") else 409
            self._send_json(code, {"ok": False, "error": detail})

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError
            return data, None
        except (ValueError, OSError):
            return None, "invalid_config: bad JSON body"

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # --- static files ---

    def _serve_static(self, name):
        path = os.path.normpath(os.path.join(STATIC_DIR, name))
        if not path.startswith(STATIC_DIR + os.sep):
            return self._send_json(404, {"ok": False, "error": "not_found"})
        try:
            with open(path, "rb") as f:
                body = f.read()
        except OSError:
            return self._send_json(404, {"ok": False, "error": "not_found"})
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    # --- WebSocket terminal ---

    def _handle_terminal(self):
        """Upgrade to WebSocket, replay a workspace server's PTY ring buffer, then
        proxy live PTY bytes to the browser and browser keystrokes to the PTY. The
        workspace is picked with ?workspace=<id> (default "main")."""
        if not self._origin_ok():
            return self._send_json(403, {"ok": False, "error": "cross-origin request refused"})
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        wsid = (qs.get("workspace") or ["main"])[0]
        entry = WORKSPACES.entry_for_terminal(wsid)
        if entry is None:
            return self._send_json(404, {"ok": False, "error": "unknown workspace"})
        key = self.headers.get("Sec-WebSocket-Key", "")
        if not key:
            return self._send_json(400, {"ok": False, "error": "missing WS key"})

        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", _ws_accept_key(key))
        self.end_headers()
        self.wfile.flush()

        sock = self.connection
        q = queue.Queue()

        # snapshot buffer + register atomically so no bytes are lost
        with entry.raw_lock:
            replay = bytes(entry.raw_buf)
            entry.ws_clients.add(q)

        try:
            if replay:
                _ws_send_frame(sock, replay)

            def _sender():
                while True:
                    chunk = q.get()
                    if chunk is None:
                        break
                    try:
                        _ws_send_frame(sock, chunk)
                    except OSError:
                        break

            sender = threading.Thread(target=_sender, daemon=True)
            sender.start()

            while True:
                opcode, payload = _ws_recv_frame(sock)
                if opcode == 8:  # close
                    break
                fd = entry.master_fd  # re-read per frame — a restart swaps the PTY
                if fd is None:
                    continue
                if opcode == 1:  # text: JSON control message (resize)
                    try:
                        msg = json.loads(payload)
                        if msg.get("type") == "resize":
                            rows = max(1, int(msg.get("rows", 24)))
                            cols = max(1, int(msg.get("cols", 80)))
                            fcntl.ioctl(
                                fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0)
                            )
                    except (json.JSONDecodeError, OSError, ValueError):
                        pass
                elif opcode == 2:  # binary: raw terminal input bytes
                    try:
                        os.write(fd, payload)
                    except OSError:
                        pass
        except OSError:
            pass
        finally:
            entry.ws_clients.discard(q)
            q.put(None)  # stop the sender thread

    def _handle_shell(self):
        """Upgrade to WebSocket and proxy an interactive bash shell running in
        the requested directory. One shell process per connection, killed on
        disconnect. Independent of the Odoo server PTY."""
        if not self._origin_ok():
            return self._send_json(403, {"ok": False, "error": "cross-origin request refused"})
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        cwd = os.path.expanduser((qs.get("cwd") or [""])[0])
        if not cwd or not os.path.isdir(cwd):
            return self._send_json(400, {"ok": False, "error": "invalid cwd"})
        key = self.headers.get("Sec-WebSocket-Key", "")
        if not key:
            return self._send_json(400, {"ok": False, "error": "missing WS key"})

        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", _ws_accept_key(key))
        self.end_headers()
        self.wfile.flush()

        sock = self.connection
        master_fd, slave_fd = pty.openpty()

        def _preexec():
            os.setsid()
            fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)  # pty becomes controlling tty

        effects.trace("run", f"/bin/bash -i (cwd: {cwd})")
        proc = subprocess.Popen(
            ["/bin/bash", "-i"],
            cwd=cwd,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            preexec_fn=_preexec,
        )
        os.close(slave_fd)

        # one thread pumps PTY output to the socket; the main loop pumps client
        # input (and resize messages) into the PTY. Only this thread writes to
        # the socket, so there is no concurrent-write hazard.
        def _pty_to_ws():
            try:
                while True:
                    data = os.read(master_fd, 4096)
                    if not data:
                        break
                    _ws_send_frame(sock, data)
            except OSError:
                pass
            finally:
                try:
                    _ws_send_frame(sock, b"", opcode=8)  # close frame
                except OSError:
                    pass

        threading.Thread(target=_pty_to_ws, daemon=True).start()

        try:
            while True:
                opcode, payload = _ws_recv_frame(sock)
                if opcode == 8:  # close
                    break
                if opcode == 1:  # text: JSON control message (resize)
                    try:
                        msg = json.loads(payload)
                        if msg.get("type") == "resize":
                            rows = max(1, int(msg.get("rows", 24)))
                            cols = max(1, int(msg.get("cols", 80)))
                            fcntl.ioctl(
                                master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0)
                            )
                    except (json.JSONDecodeError, OSError, ValueError):
                        pass
                elif opcode == 2:  # binary: raw terminal input bytes
                    try:
                        os.write(master_fd, payload)
                    except OSError:
                        pass
        except OSError:
            pass
        finally:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except OSError:
                pass
            try:
                os.close(master_fd)
            except OSError:
                pass

    # --- SSE ---

    def _handle_events(self):
        q, backlog = BUS.subscribe()
        print(
            f"{TAG} {time.strftime('%H:%M:%S')} client connected ({self.client_address[0]})",
            flush=True,
        )
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()  # no Content-Length: HTTP/1.0 read-until-close
            # prime every workspace server (main first, enriched) + every run, so a
            # fresh tab reflects the whole runtime without extra bootstrap calls
            for snap in WORKSPACES.public_snapshots():
                self._send_event("server", snap)
            for run in WORKSPACES.run_snapshots():
                self._send_event("run", run)
            self._send_event("config", CONFIG.get())
            for line in backlog:
                self._send_event("log", {"server": "main", "line": line})
            while True:
                try:
                    event, payload = q.get(timeout=15)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                self._send_event(event, payload)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass  # client gone
        finally:
            BUS.unsubscribe(q)

    def _save_config(self):
        """Persist a config and/or state write from the browser, rev-checked. Body:
        {rev, config?, state?}. On success replies {ok, rev, config, state} (rev
        bumped) and broadcasts the new config to every tab (SSE 'config'); a stale
        rev replies 409 with the current {rev, config, state} so the client can
        reconcile; a write failure replies 500."""
        body, err = self._read_json()
        if err or "rev" not in (body or {}):
            return self._send_json(400, {"ok": False, "error": "missing rev"})
        kw = {}
        if "config" in body:
            kw["config"] = body["config"]
        if "state" in body:
            kw["state"] = body["state"]
        ok, result = CONFIG.save(body["rev"], **kw)
        if ok:
            return self._send_json(200, {"ok": True, **result})
        if result.get("conflict"):
            return self._send_json(409, {"ok": False, **result})
        return self._send_json(500, {"ok": False, "error": result.get("error", "write failed")})

    def _handle_cli_test(self):
        """Run a one-shot test (triggered by the `goo --test-tags` CLI) as its own
        odoo process — on free ports, so a running server is left untouched — and
        stream the log back as plain text. Announces the run on the server log +
        the browser event log, using the server's own config + active workspace."""
        body, err = self._read_json()
        tags = ((body or {}).get("test_tags") or "").strip()
        if err or not tags:
            return self._send_json(400, {"ok": False, "error": "missing test_tags"})
        snapshot = CONFIG.get()
        config = snapshot.get("config")
        state = snapshot.get("state") or {}
        active = state.get("active_workspace")
        cfg = (
            services.build_start_config(config, active, {"test_tags": tags})
            if config and active
            else None
        )
        if not cfg:
            return self._send_json(
                409,
                {
                    "ok": False,
                    "error": "no workspace yet — open the goo UI (with a workspace configured) once",
                },
            )
        try:
            cmd, _db, _is_new = build_odoo_cmd(cfg)
        except ValueError as e:
            return self._send_json(400, {"ok": False, "error": str(e)})
        # run on free ports so a running server (on the default ports) is undisturbed
        cmd += f" --http-port {free_port()} --gevent-port {free_port()}"

        BUS.publish_event(f"CLI test run (tags: {tags})")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(f"{TAG} running tests (tags: {tags})\n".encode())
        self.wfile.flush()
        effects.trace("run", cmd)
        proc = subprocess.Popen(
            cmd,
            shell=True,
            executable="/bin/bash",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            preexec_fn=os.setsid,
        )
        try:
            for line in proc.stdout:
                self.wfile.write(line.encode("utf-8", "replace"))
                self.wfile.flush()
            rc = proc.wait()
            BUS.publish_event(
                f"CLI test {'passed' if rc == 0 else f'failed (exit {rc})'} (tags: {tags})",
                "" if rc == 0 else "error",
            )
            self.wfile.write(f"{TAG} test run finished (exit {rc})\n".encode())
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            try:  # CLI client gone — don't leave the test running orphaned
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except OSError:
                pass

    def _send_event(self, event, payload):
        # json.dumps guarantees a single-line data field
        msg = f"event: {event}\ndata: {json.dumps(payload)}\n\n"
        self.wfile.write(msg.encode("utf-8"))
        self.wfile.flush()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        # the client closed the connection before we finished writing (page
        # reload, aborted fetch, SSE reconnect, a superseded refresh). Harmless
        # — don't dump a traceback. Real errors still propagate.
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


def run_cli_test(tags):
    """Client mode (`goo --test-tags …`): ask the already-running goo server to
    run a test against its current target and stream the log to stdout. Exits with
    the test's return code so agents can gate on pass/fail."""
    url = f"http://{HOST}:{PORT}/api/cli/test"
    req = urllib.request.Request(
        url,
        data=json.dumps({"test_tags": tags}).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=None) as resp:  # streams until the run ends
            exit_code = 0
            for raw in resp:
                line = raw.decode("utf-8", "replace").rstrip("\n")
                print(line, flush=True)
                m = re.search(r"test run finished \(exit (-?\d+)\)", line)
                if m:
                    exit_code = int(m.group(1))
            return 0 if exit_code == 0 else 1
    except urllib.error.HTTPError as e:
        print(f"{TAG} {e.read().decode('utf-8', 'replace')}", file=sys.stderr)
        return 2
    except urllib.error.URLError as e:
        print(f"{TAG} cannot reach goo at {url} — is goo running? ({e.reason})", file=sys.stderr)
        return 2


def main():
    parser = argparse.ArgumentParser(description="odoo development helper (web UI)")
    parser.add_argument("--open", action="store_true", help="open the UI in the default browser")
    parser.add_argument(
        "--test-tags",
        dest="test_tags",
        metavar="TAGS",
        help="run a test with these --test-tags on the running goo server and stream the log",
    )
    parser.add_argument(
        "--config",
        dest="config",
        metavar="PATH",
        help="path to goo's config file (default: $XDG_CONFIG_HOME/goo/config.json, "
        "i.e. ~/.config/goo/config.json). Kept outside the checkout so the self-updater "
        "never touches it.",
    )
    parser.add_argument(
        "--trace",
        action="store_true",
        help="log every external operation goo runs to the goo terminal: each "
        "subprocess (git, psql, dropdb, gh, odoo-bin, the shell terminal, …) and "
        "each filesystem read/write/move/copy. Network requests are always logged. "
        "Verbose — handy for seeing exactly what goo does under the hood.",
    )
    args = parser.parse_args()

    # point the config store at --config before anything (the CLI run, the loops,
    # or the first request) reads it. Reassigning .path is safe: nothing has been
    # loaded/cached yet at startup.
    if args.config:
        CONFIG.path = os.path.expanduser(args.config)

    # turn on tracing before any work (incl. the one-shot --test-tags run) happens
    if args.trace:
        effects.set_trace(True)

    if args.test_tags:
        return run_cli_test(args.test_tags)

    try:
        httpd = Server((HOST, PORT), Handler)
    except OSError as e:
        print(f"{TAG} cannot bind {HOST}:{PORT}: {e}")
        return 1

    url = f"http://{HOST}:{PORT}"
    print(f"{TAG} running at {url}", flush=True)
    if args.open:
        webbrowser.open(url)

    signal.signal(signal.SIGTERM, lambda signum, frame: sys.exit(0))
    atexit.register(WORKSPACES.shutdown)
    atexit.register(CLAUDE.shutdown)
    # check whether goo's checkout is behind origin/master — at startup, then hourly
    threading.Thread(target=goo_update_loop, daemon=True).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print(f"\n{TAG} shutting down...")
    finally:
        WORKSPACES.shutdown()
        CLAUDE.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
