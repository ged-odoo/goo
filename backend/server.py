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

    def publish_log(self, line):
        with self._lock:
            self._buffer.append(line)
            subscribers = list(self._subscribers)
        for q in subscribers:
            q.put(("log", {"line": line}))

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

    def publish_worktree_log(self, target, line):
        """Stream one worktree server's log line to the browser (SSE 'worktree_log',
        {target, line}). Unlike publish_log this does NOT touch the shared backlog
        ring buffer — worktree scrollback is kept per-server in WorktreeManager and
        primed on selection via /api/worktree/logs."""
        with self._lock:
            subscribers = list(self._subscribers)
        for q in subscribers:
            q.put(("worktree_log", {"target": target, "line": line}))

    def publish_claude(self, payload):
        """Stream one Claude chat item for a worktree to the browser (SSE 'claude').
        payload is {target, role, ...}: role 'assistant'/'tool'/'result'/'error' as a
        headless `claude -p` run produces text, tool activity and its final result.
        Per-target history lives in ClaudeManager and is primed via /api/worktree/
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
    managed odoo process first — execv keeps the same PID but does NOT run atexit
    handlers, and the new goo starts with a fresh MANAGER that wouldn't know about
    a leftover child. The listening socket is close-on-exec, so the new process
    rebinds the port. `--open` is dropped so no extra browser tab opens (the client
    reloads its existing tab)."""
    MANAGER.shutdown()
    WORKTREES.shutdown()
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
    cmd += (
        f" -r {db_user} -w {db_password} -d {db} "
        f"--database {db} --no-database-list --without-demo all "
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
    the speedup only happens when the rust_bundler config key is on AND the
    odoo_bundler Rust extension is importable from the instance's venv — otherwise
    the addon falls back to the slow Python bundler and its only warning lands in
    the odoo log, easy to miss. When the feature is on, probe the venv in the
    background and explain in the goo log when the extension is missing. Returns
    the probe thread (callers may ignore it; tests join it), or None when off."""
    if not (config or {}).get("rust_bundler"):
        return None  # feature off — the addon won't engage, nothing to warn about
    venv_activate = (config or {}).get("venv_activate", "")
    probe = "python3 -c 'import odoo_bundler'"
    if venv_activate:
        probe = f"{venv_activate} && {probe}"

    def check():
        try:
            result = run(probe, shell=True, executable="/bin/bash", quiet=True, timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            return  # can't probe — don't guess, and never disturb the start
        if result.returncode:
            where = f" ({context})" if context else ""
            bus.publish_log(
                f"{TAG} rust_bundler{where}: odoo_bundler is not importable from the "
                f"instance's venv — JS asset bundling stays on the slow Python path. "
                f"Build it into the venv with `maturin develop --release` "
                f"(https://github.com/Goaman/odoo_bundler)."
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
# Odoo process manager
# =============================================================================


class OdooManager:
    """Owns the single odoo process. States:
    stopped -> starting -> running -> stopping -> stopped
    """

    def __init__(self, bus):
        self.bus = bus
        self.lock = threading.Lock()
        self.state = "stopped"
        self.process = None
        self.master_fd = None
        self.reader_thread = None
        self.db = None
        self.target = None
        self.cmd = None
        self.mode = "server"  # "server" or "test"
        self.started_at = None
        self.exited_unexpectedly = False
        self.returncode = None
        # one-shot Run occupying the slot (test/install/upgrade) — None for a plain
        # server or when stopped; kept as the last finished snapshot until superseded
        self.run = None
        self._run_seq = 0  # monotonic run-id source
        # resume-after: the config of the server that was interrupted to run a one-shot
        # (so we can restart it when the run ends), and the last server config we saw
        self._server_config = None
        self._resume_config = None
        # raw PTY byte ring buffer: replayed to each new terminal WebSocket client
        # so xterm.js can reconstruct the current terminal state on connect
        self._raw_buf = bytearray()
        self._raw_lock = threading.Lock()
        self._ws_clients = set()  # set of queue.Queue, one per terminal WS connection

    def status(self):
        with self.lock:
            active = self.state in ("starting", "running")
            snap = ServerSnapshot(
                id="main",
                state=self.state,
                terminal=True,  # the main server owns the PTY/xterm channel
                pid=self.process.pid if (active and self.process) else None,
                db=self.db if active else None,
                target=self.target if active else None,
                cmd=self.cmd if active else None,
                mode=self.mode if active else None,
                started_at=self.started_at if active else None,
                exited_unexpectedly=self.exited_unexpectedly,
                returncode=self.returncode if self.exited_unexpectedly else None,
            )
        # asdict → every field present (odoo_version/enterprise/exists = None here),
        # so the client's spread-merge behaves as a full replace for "main"
        status = asdict(snap)
        status["odoo_port_busy"] = port_busy(ODOO_PORT)
        if status["db"]:
            version, enterprise, _ = DATABASE.odoo_info(status["db"])
            status["odoo_version"] = version
            status["enterprise"] = enterprise
        return status

    def run_snapshot(self):
        """The current/last one-shot run (or None) — primed on SSE connect."""
        with self.lock:
            return dict(self.run) if self.run else None

    def server_config(self):
        """The config of the last plain-server start, for resume-after."""
        with self.lock:
            return self._server_config

    def _finish_run(self, returncode):
        """Finalize the active run (if any) and return the server config to resume, or
        None. `returncode` is the process exit code, or None when the run was stopped
        manually. Publishes the finished run. The caller holds no lock and, if a config
        is returned, restarts the server via start()."""
        with self.lock:
            run = self.run
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
            resume = self._resume_config
            self._resume_config = None
        self.bus.publish_run(snapshot)
        return resume

    def start(self, config, resume_config=None):
        """Launch the odoo process. A one-shot run (test/install/upgrade) is minted as
        a first-class Run occupying the slot; `resume_config` (set by _action_oneshot
        when a running server was interrupted) is the server config to restart when the
        run ends. Returns (ok, detail): detail is the command on success, else an error
        code."""
        with self.lock:
            if self.state != "stopped":
                return False, "already_running"
            try:
                cmd, db, is_new = build_odoo_cmd(config)
            except ValueError as e:
                return False, f"invalid_config: {e}"

            self.exited_unexpectedly = False
            self.returncode = None
            self.db = db
            self.target = config.get("target")
            self.cmd = cmd
            s = config.get("start") or {}
            self.mode = (
                "test"
                if s.get("test_tags")
                else "install"
                if s.get("install")
                else "upgrade"
                if s.get("upgrade")
                else "server"
            )
            self.started_at = time.time()
            # a plain server clears any active run and is remembered so a later run can
            # resume it; a one-shot run is minted as a Run and records its resume config
            if self.mode == "server":
                self.run = None
                self._server_config = config
                self._resume_config = None
            else:
                self._run_seq += 1
                spec = (
                    {"tags": s.get("test_tags")}
                    if self.mode == "test"
                    else {"module": s.get("install") or s.get("upgrade")}
                )
                self.run = asdict(
                    RunSnapshot(
                        id=f"run-{self._run_seq}",
                        kind=self.mode,
                        state="running",
                        target=self.target,
                        db=db,
                        spec=spec,
                        resume=bool(resume_config),
                        started_at=self.started_at,
                    )
                )
                self._resume_config = resume_config
            if is_new:
                self.bus.publish_log(
                    f"{TAG} database '{db}' not initialized, applying on_create_args"
                )
            self.bus.publish_log(f"{TAG} starting odoo: {cmd}")
            warn_if_rust_bundler_missing(config, self.bus)

            with self._raw_lock:
                self._raw_buf.clear()

            effects.trace("run", cmd)
            master_fd, slave_fd = pty.openpty()
            self.process = subprocess.Popen(
                cmd,
                shell=True,
                executable="/bin/bash",
                stdout=slave_fd,
                stderr=slave_fd,
                stdin=slave_fd,
                preexec_fn=os.setsid,
            )
            os.close(slave_fd)
            self.master_fd = master_fd
            self.state = "starting"
            self.reader_thread = threading.Thread(
                target=self._reader,
                args=(master_fd, self.process),
                daemon=True,
            )
            self.reader_thread.start()
            run = self.run
        self.bus.publish_server(self.status())
        if run:
            self.bus.publish_run(dict(run))  # a fresh one-shot run went "running"
        return True, cmd

    def stop(self):
        """Stop the odoo process. Idempotent; when already stopped, still
        kills whatever holds the odoo port (orphans, external servers)."""
        with self.lock:
            if self.state == "stopping":
                return False, "already_stopping"
            was_active = self.state in ("starting", "running")
            process = self.process
            reader = self.reader_thread
            if was_active:
                self.state = "stopping"

        if was_active:
            self.bus.publish_server(self.status())
            self.bus.publish_log(f"{TAG} stopping odoo...")
            # never let an exception leave us stuck in "stopping" (the guard
            # above would then refuse every future stop until goo restarts)
            try:
                self._terminate(process)
            except Exception as e:
                self.bus.publish_log(f"{TAG} error while stopping: {e}")
            # _terminate already SIGKILLed odoo's whole process group, so the port
            # is normally free now — only fall back to the (subprocess) lsof kill
            # when something is *still* holding it (a stray orphan / external server)
            if port_busy(ODOO_PORT):
                kill_port(ODOO_PORT)
            if reader:
                reader.join(timeout=2)
            with self.lock:
                self.state = "stopped"
                self.process = None
                self.master_fd = None
                self.db = None
                self.target = None
                self.cmd = None
                self.started_at = None
            self.bus.publish_log(f"{TAG} odoo stopped")
        elif port_busy(ODOO_PORT):
            kill_port(ODOO_PORT)
            self.bus.publish_log(f"{TAG} killed process on port {ODOO_PORT}")

        self.bus.publish_server(self.status())
        return True, "stopped"

    def _terminate(self, process):
        """Signal-escalate the odoo process group until it exits (see the module
        terminate_process)."""
        terminate_process(process)

    def restart(self, config):
        ok, detail = self.stop()
        if not ok:
            return ok, detail
        return self.start(config)

    def shutdown(self):
        """Cleanup on goo exit: stop our own child, but never touch an
        external odoo we didn't start."""
        with self.lock:
            active = self.state in ("starting", "running")
        if active:
            self.stop()

    def _emit_raw(self, data):
        """Append raw PTY bytes to the ring buffer and fan out to terminal WS clients."""
        with self._raw_lock:
            self._raw_buf += data
            if len(self._raw_buf) > RAW_BUF_MAX:
                self._raw_buf = self._raw_buf[-RAW_BUF_MAX:]
            clients = list(self._ws_clients)
        for q in clients:
            q.put(data)

    def _reader(self, fd, process):
        """Read the PTY, publish lines, detect readiness and unexpected exit."""
        buf = b""
        while True:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            self._emit_raw(data)
            buf += data
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                self._handle_line(raw.decode("utf-8", errors="replace").rstrip("\r"))
        if buf:
            self._handle_line(buf.decode("utf-8", errors="replace").rstrip("\r"))
        try:
            os.close(fd)
        except OSError:
            pass

        ret = process.wait()
        with self.lock:
            # stop() owns intentional exits; a stale reader (post-restart)
            # must not touch the new process state
            if self.state == "stopping" or process is not self.process:
                return
            self.state = "stopped"
            self.process = None
            self.master_fd = None
            self.db = None
            self.target = None
            self.cmd = None
            self.started_at = None
            self.exited_unexpectedly = True
            self.returncode = ret
        self.bus.publish_log(f"{TAG} odoo exited unexpectedly (code {ret})")
        self.bus.publish_server(self.status())
        # a one-shot run just ended on its own: finalize it and, if it had interrupted
        # a server, bring that server back (resume-after, owned here so it survives a
        # mid-run reload). start() runs a fresh process + reader thread.
        resume = self._finish_run(ret)
        if resume:
            self.start(resume)

    def _handle_line(self, line):
        self.bus.publish_log(line)
        if READY_MARKER in line:
            with self.lock:
                if self.state != "starting":
                    return
                self.state = "running"
            self.bus.publish_server(self.status())


class WorktreeManager:
    """Owns the per-target worktree odoo servers — one process per target, each on
    its own port, all running concurrently with the main OdooManager and with each
    other (so several branches can run at once). Keyed by target id. Lighter than
    OdooManager: no PTY/terminal — just readiness detection, per-server log
    streaming (SSE 'worktree_log' + a bounded tail), and a clean stop. State per
    entry: starting -> running -> stopping -> stopped.
    """

    LOG_TAIL = 500  # lines kept per server so a freshly-selected worktree has scrollback

    def __init__(self, bus):
        self.bus = bus
        self.lock = threading.Lock()
        self.servers = {}  # target_id -> entry dict

    def _public(self, target, entry):
        """The SSE/JSON-safe view of one server entry — a ServerSnapshot keyed by the
        worktree's own target id (no PTY, so terminal=False). `exists` is dropped
        here: it's a client-facing on-disk fact added only by status_for on bootstrap,
        so the live SSE stream carries just state/port and the client's spread-merge
        preserves the bootstrapped `exists` rather than clobbering it with null."""
        snap = asdict(
            ServerSnapshot(
                id=target,
                state=entry["state"],
                terminal=False,
                target=target,
                db=entry["db"],
                port=entry["port"],
            )
        )
        del snap["exists"]
        return snap

    def start(self, target, config):
        """Launch a worktree odoo server for <target> on its own free port. Returns
        (ok, detail): detail is {"port": N} on success, else an error string. The
        config must already carry the worktree's repo paths + server_path."""
        if not target:
            return False, "missing target"
        try:
            cmd, db, _is_new = build_odoo_cmd(config)
        except ValueError as e:
            return False, f"invalid_config: {e}"
        # two odoo processes on one db corrupt it — refuse if the db is already held
        # by the main server or another worktree server (read main status outside our
        # lock to avoid holding it during a db query)
        main = MANAGER.status()
        with self.lock:
            existing = self.servers.get(target)
            if existing and existing["state"] in ("starting", "running"):
                return False, "already_running"
            if main.get("state") in ("starting", "running") and main.get("db") == db:
                return False, f"database '{db}' is in use by the main server"
            for t, e in self.servers.items():
                if t != target and e["state"] in ("starting", "running") and e["db"] == db:
                    return False, f"database '{db}' is in use by another worktree server"
            # run on free ports so the main server (default ports) is undisturbed
            port, gport = free_port(), free_port()
            wcmd = f"{cmd} --http-port {port} --gevent-port {gport}"
            self.bus.publish_log(f"{TAG} starting worktree odoo ({target}): {wcmd}")
            warn_if_rust_bundler_missing(config, self.bus, context=f"worktree {target}")
            effects.trace("run", wcmd)
            process = subprocess.Popen(
                wcmd,
                shell=True,
                executable="/bin/bash",
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                preexec_fn=os.setsid,
            )
            entry = {
                "state": "starting",
                "port": port,
                "gport": gport,
                "db": db,
                "process": process,
                "started_at": time.time(),
                "exited_unexpectedly": False,
                "returncode": None,
                "log": collections.deque(maxlen=self.LOG_TAIL),
            }
            self.servers[target] = entry
            threading.Thread(target=self._reader, args=(target, process), daemon=True).start()
        self.bus.publish_server(self._public(target, entry))
        return True, {"port": port}

    def _reader(self, target, process):
        """Drain the worktree server's output: stream every line to the browser and
        the per-server tail, flip to running on the ready marker, detect exit."""
        for line in process.stdout:
            line = line.rstrip("\r\n")
            with self.lock:
                entry = self.servers.get(target)
                current = bool(entry and entry["process"] is process)
                if current:
                    entry["log"].append(line)
                ready = current and READY_MARKER in line and entry["state"] == "starting"
                if ready:
                    entry["state"] = "running"
                    snap = self._public(target, entry)
            if current:
                self.bus.publish_worktree_log(target, line)
            if ready:
                self.bus.publish_server(snap)
        ret = process.wait()
        with self.lock:
            entry = self.servers.get(target)
            # stop() owns intentional exits; a stale reader (post-restart) must not
            # clobber a freshly-started entry
            if not entry or entry["process"] is not process or entry["state"] == "stopping":
                return
            entry["state"] = "stopped"
            entry["exited_unexpectedly"] = True
            entry["returncode"] = ret
            entry["process"] = None  # keep the entry so the screen shows "stopped"
            snap = self._public(target, entry)
        self.bus.publish_event(
            f"worktree server ({target}) exited unexpectedly (code {ret})", level="error"
        )
        self.bus.publish_server(snap)

    def stop(self, target):
        """Stop a worktree server. Idempotent; always frees its port."""
        with self.lock:
            entry = self.servers.get(target)
            if not entry:
                return True, "stopped"
            port = entry["port"]
            if entry["state"] in ("starting", "running"):
                entry["state"] = "stopping"
                process = entry["process"]
            else:
                process = None
        if process is not None:
            self.bus.publish_log(f"{TAG} stopping worktree odoo ({target})...")
            try:
                terminate_process(process)
            except Exception as e:
                self.bus.publish_log(f"{TAG} error stopping worktree ({target}): {e}")
        if port:
            kill_port(port)
        with self.lock:
            entry = self.servers.get(target)
            if entry:
                entry["state"] = "stopped"
                entry["process"] = None
                snap = self._public(target, entry)
            else:
                snap = asdict(
                    ServerSnapshot(id=target, state="stopped", terminal=False, target=target)
                )
        self.bus.publish_server(snap)
        return True, "stopped"

    def logs_for(self, target):
        """The buffered log tail (list of lines) for one worktree server, or []."""
        with self.lock:
            entry = self.servers.get(target)
            return list(entry["log"]) if entry else []

    def status_for(self, targets):
        """targets: [{"id", "dirPath"}]. Returns {id: ServerSnapshot-dict}, merging
        each target's on-disk worktree existence with its live server state (or a
        stopped snapshot when no server is running)."""
        with self.lock:
            servers = {t: self._public(t, e) for t, e in self.servers.items()}
        out = {}
        for t in targets:
            tid = t.get("id")
            if not tid:
                continue
            snap = servers.get(tid) or asdict(
                ServerSnapshot(id=tid, state="stopped", terminal=False, target=tid)
            )
            snap["exists"] = effects.is_dir(t.get("dirPath", ""))
            out[tid] = snap
        return out

    def shutdown(self):
        """Stop every worktree server (goo exit / restart)."""
        with self.lock:
            targets = list(self.servers.keys())
        for t in targets:
            self.stop(t)


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
    """One headless Claude conversation per worktree target. A message spawns
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
            self.bus.publish_claude({"target": target, **item})

    def send(self, target, prompt, cwd, add_dirs=None, model=None):
        """Spawn a Claude turn for <target> in <cwd> (its worktree checkout), resuming
        the target's session when one exists. `model` (a CLI alias/name, e.g. "sonnet"
        or "opus[1m]") overrides the CLI's default when set. Returns (ok, detail)."""
        if not target or not (prompt or "").strip():
            return False, "missing target or prompt"
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
        self.bus.publish_claude({"target": target, "role": "result", "ok": True})
        return True, "stopped"

    def history_for(self, target):
        """The transcript + live state for one target, to re-prime the chat on load."""
        with self.lock:
            e = self.convos.get(target)
            if not e:
                return {"items": [], "state": "idle"}
            return {"items": list(e["history"]), "state": e["state"]}

    def forget(self, target):
        """Drop a target's conversation (its worktree was removed)."""
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
MANAGER = OdooManager(BUS)
WORKTREES = WorktreeManager(BUS)
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
            self._send_json(200, MANAGER.status())
        elif path == "/api/goo/update":
            self._send_json(200, {**GOO_UPDATE, "boot": BOOT_ID})
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
            self._action_start(MANAGER.start)
        elif path == "/api/restart":
            self._action_start(MANAGER.restart)
        elif path in ("/api/tests/run", "/api/addons/run"):
            self._action_oneshot()
        elif path == "/api/config":
            self._save_config()
        elif path == "/api/cli/test":
            self._handle_cli_test()
        elif path == "/api/command":
            body, err = self._read_json()
            if err:
                return self._send_json(400, {"ok": False, "error": err})
            cfg = self._build_launch(body)
            if cfg is None:
                return self._send_json(400, {"ok": False, "error": "unknown target"})
            try:
                cmd, _, _ = build_odoo_cmd(cfg)
                self._send_json(200, {"ok": True, "cmd": cmd})
            except ValueError as e:
                self._send_json(400, {"ok": False, "error": str(e)})
        elif path == "/api/stop":
            ok, detail = MANAGER.stop()
            # stopping a one-shot run mid-flight finalizes it and, like a natural
            # finish, resumes any server it had interrupted (the reader bailed out
            # because stop() owns the exit, so drive the resume from here)
            if ok:
                resume = MANAGER._finish_run(None)
                if resume:
                    MANAGER.start(resume)
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
            states, details, unsupported = MERGEBOT.statuses(
                prs, refresh=bool((body or {}).get("refresh"))
            )
            self._send_json(
                200,
                {"ok": True, "states": states, "details": details, "unsupported": unsupported},
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
                # the shell cmd spans all configured repos (not a target) — build from
                # the server's own config, no config in the request body
                cmd = build_shell_cmd(CONFIG.get()["config"], db)
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
                ok, error = GIT.create_branch(b.get("path"), b.get("name"), b.get("start_point"))
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
        elif path == "/api/worktree/create":
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
                )
                results.append({"repo": r.get("repo"), "ok": ok, "error": error})
            self._send_json(200, {"ok": all(x["ok"] for x in results), "results": results})
        elif path == "/api/worktree/start":
            body, err = self._read_json()
            target = (body or {}).get("target")
            if err or not target:
                return self._send_json(400, {"ok": False, "error": "missing target"})
            cfg = self._build_launch(body)  # server builds the worktree launch config
            if cfg is None:
                return self._send_json(400, {"ok": False, "error": "unknown target"})
            ok, detail = WORKTREES.start(target, cfg)
            if ok:
                self._send_json(200, {"ok": True, "port": detail["port"]})
            else:
                code = 400 if str(detail).startswith("invalid_config") else 409
                self._send_json(code, {"ok": False, "error": detail})
        elif path == "/api/worktree/stop":
            body, err = self._read_json()
            target = (body or {}).get("target")
            if err or not target:
                return self._send_json(400, {"ok": False, "error": "missing target"})
            ok, detail = WORKTREES.stop(target)
            self._send_json(200 if ok else 409, {"ok": ok, "error": None if ok else detail})
        elif path == "/api/worktree/remove":
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
            target = (body or {}).get("target")
            if target:
                CLAUDE.forget(target)  # its checkout is gone; drop the chat + any run
            self._send_json(200, {"ok": all(x["ok"] for x in results), "results": results})
        elif path == "/api/worktree/list":
            body, err = self._read_json()
            targets = (body or {}).get("targets")
            if err or not isinstance(targets, list):
                return self._send_json(400, {"ok": False, "error": "missing targets list"})
            self._send_json(200, {"ok": True, "worktrees": WORKTREES.status_for(targets)})
        elif path == "/api/worktree/logs":
            body, err = self._read_json()
            target = (body or {}).get("target")
            if err or not target:
                return self._send_json(400, {"ok": False, "error": "missing target"})
            self._send_json(200, {"ok": True, "lines": WORKTREES.logs_for(target)})
        elif path == "/api/worktree/claude":
            body, err = self._read_json()
            target = (body or {}).get("target")
            prompt = (body or {}).get("prompt")
            cwd = (body or {}).get("cwd")
            add_dirs = (body or {}).get("addDirs") or []
            model = (body or {}).get("model")
            if err or not target or not prompt or not cwd:
                return self._send_json(400, {"ok": False, "error": "missing target, prompt or cwd"})
            ok, detail = CLAUDE.send(target, prompt, cwd, add_dirs, model=model)
            if ok:
                self._send_json(200, {"ok": True, "state": detail["state"]})
            else:
                code = 409 if detail == "already_running" else 400
                self._send_json(code, {"ok": False, "error": detail})
        elif path == "/api/worktree/claude/stop":
            body, err = self._read_json()
            target = (body or {}).get("target")
            if err or not target:
                return self._send_json(400, {"ok": False, "error": "missing target"})
            ok, detail = CLAUDE.stop(target)
            self._send_json(200, {"ok": ok, "error": None if ok else detail})
        elif path == "/api/worktree/claude/history":
            body, err = self._read_json()
            target = (body or {}).get("target")
            if err or not target:
                return self._send_json(400, {"ok": False, "error": "missing target"})
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
            target = (body or {}).get("target")
            if (
                err
                or not isinstance(source, str)
                or not isinstance(target, str)
                or not source
                or not target
            ):
                return self._send_json(400, {"ok": False, "error": "missing source or target"})
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
        """Resolve a thin {target, overrides} launch request against the server's own
        config into the dict build_odoo_cmd consumes (handles plain + worktree targets).
        Returns None if the target is missing/unknown."""
        target = (body or {}).get("target")
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
            return self._send_json(400, {"ok": False, "error": "unknown target"})
        ok, detail = action(cfg)
        if ok:
            self._send_json(200, {"ok": True, "state": "starting", "cmd": detail})
        else:
            code = 400 if detail.startswith("invalid_config") else 409
            self._send_json(code, {"ok": False, "error": detail})

    def _action_oneshot(self):
        """Stop whatever holds the odoo port, then start a one-shot run
        (tests / install / upgrade). Shares the manager with the server. If a real
        server is interrupted, its config is handed to the run so the backend restarts
        it when the run ends (resume-after, owned server-side)."""
        body, err = self._read_json()
        if err:
            return self._send_json(400, {"ok": False, "error": err})
        cfg = self._build_launch(body)
        if cfg is None:
            return self._send_json(400, {"ok": False, "error": "unknown target"})
        pre = MANAGER.status()
        resume_config = (
            MANAGER.server_config()
            if pre.get("state") in ("starting", "running") and pre.get("mode") == "server"
            else None
        )
        MANAGER.stop()
        ok, detail = MANAGER.start(cfg, resume_config=resume_config)
        if ok:
            self._send_json(200, {"ok": True, "state": "starting", "cmd": detail})
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
        """Upgrade to WebSocket, replay the PTY ring buffer, then proxy
        live PTY bytes to the browser and browser keystrokes to the PTY."""
        if not self._origin_ok():
            return self._send_json(403, {"ok": False, "error": "cross-origin request refused"})
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
        with MANAGER._raw_lock:
            replay = bytes(MANAGER._raw_buf)
            MANAGER._ws_clients.add(q)

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
                fd = MANAGER.master_fd
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
            MANAGER._ws_clients.discard(q)
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
            self._send_event("server", MANAGER.status())
            run = MANAGER.run_snapshot()
            if run:
                self._send_event("run", run)
            self._send_event("config", CONFIG.get())
            for line in backlog:
                self._send_event("log", {"line": line})
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
        the browser event log, using the server's own config + active target."""
        body, err = self._read_json()
        tags = ((body or {}).get("test_tags") or "").strip()
        if err or not tags:
            return self._send_json(400, {"ok": False, "error": "missing test_tags"})
        snapshot = CONFIG.get()
        config = snapshot.get("config")
        active = (snapshot.get("state") or {}).get("active_target")
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
                    "error": "no target yet — open the goo UI (with a target configured) once",
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
    atexit.register(MANAGER.shutdown)
    atexit.register(WORKTREES.shutdown)
    atexit.register(CLAUDE.shutdown)
    # check whether goo's checkout is behind origin/master — at startup, then hourly
    threading.Thread(target=goo_update_loop, daemon=True).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print(f"\n{TAG} shutting down...")
    finally:
        MANAGER.shutdown()
        WORKTREES.shutdown()
        CLAUDE.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
