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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import effects, services
from .cache import TTLCache

# the IO seam (effects) and the services layer over it; the server's remaining
# subprocess calls (kill_port, the goo self-update probes) go through run().
from .effects import TAG, run

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

    def publish_status(self, status):
        with self._lock:
            subscribers = list(self._subscribers)
        for q in subscribers:
            q.put(("status", status))

    def publish_event(self, text, level=""):
        """A business event: logged to the goo server stdout and pushed to the
        browser event log via an SSE 'event' message (level "error" tints it)."""
        print(f"{TAG} {time.strftime('%H:%M:%S')} • {text}", flush=True)
        with self._lock:
            subscribers = list(self._subscribers)
        for q in subscribers:
            q.put(("event", {"text": text, "level": level}))

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
        result = run(
            ["lsof", "-ti", f":{port}"],
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


def open_in_editor(editor, path):
    """Launch the configured editor (e.g. `code`) on a repo directory, detached so
    it outlives goo and isn't part of its process group. The editor string may
    carry flags (`code --reuse-window`), so it's run through bash with the path
    quoted. Returns (ok, error).

    A missing/failing editor command exits quickly with a non-zero code — we wait
    briefly to catch that and return its stderr (so the UI shows why it failed,
    e.g. `code: command not found`). A GUI editor that keeps running past the
    grace period is taken as a successful launch."""
    editor = (editor or "").strip()
    path = os.path.expanduser(path or "")
    if not editor:
        return False, "no editor configured"
    if not os.path.isdir(path):
        return False, f"not a directory: {path}"
    cmd = f"{editor} {shlex.quote(path)}"
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
    if n > prev_behind:  # new commits since we last looked
        msg = f"goo update available — {n} commit{'s' if n != 1 else ''} behind origin/master"
        if GOO_UPDATE["ahead"]:
            m = GOO_UPDATE["ahead"]
            msg += f", {m} local commit{'s' if m != 1 else ''} ahead"
        BUS.publish_event(msg)
    return True


def goo_update_loop():
    """Check for a goo update at startup and then hourly, so a permanently running
    goo keeps surfacing new commits on origin/master."""
    while True:
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
    args = [a for a in sys.argv[1:] if a != "--open"]
    os.execv(sys.executable, [sys.executable, os.path.join(GOO_DIR, "goo.py"), *args])


class AutoReloader:
    """Fetches master for opted-in repos every INTERVAL seconds, in the
    background. The repo set is pushed by the frontend (config lives there).
    Each repo's first fetch is one interval after it is first registered, so
    starting goo never triggers a fetch storm."""

    INTERVAL = 4 * 3600

    def __init__(self):
        self._repos = []
        self._next = {}  # path -> earliest next fetch time
        self._lock = threading.Lock()
        threading.Thread(target=self._loop, daemon=True).start()

    def set_repos(self, repos):
        with self._lock:
            self._repos = [r for r in repos if r.get("path")]
            now = time.time()
            for r in self._repos:
                self._next.setdefault(r["path"], now + self.INTERVAL)

    def _loop(self):
        while True:
            time.sleep(60)
            now = time.time()
            with self._lock:
                due = [r for r in self._repos if now >= self._next.get(r["path"], 0)]
                for r in due:
                    self._next[r["path"]] = now + self.INTERVAL
            for r in due:
                GIT.fetch_master(r)


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
    # the configurable launch prefix (cwd + odoo-bin); goo appends the dynamic args
    start_cmd = config.get("start_cmd") or f"cd {community_path} && ./odoo-bin"

    parts = []
    if venv_activate:
        parts.append(venv_activate)
    parts.append(start_cmd)
    cmd = " && ".join(parts)
    cmd += (
        f" -r {db_user} -w {db_password} -d {db} "
        f"--database {db} --no-database-list --with-demo "
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
        # raw PTY byte ring buffer: replayed to each new terminal WebSocket client
        # so xterm.js can reconstruct the current terminal state on connect
        self._raw_buf = bytearray()
        self._raw_lock = threading.Lock()
        self._ws_clients = set()  # set of queue.Queue, one per terminal WS connection

    def status(self):
        with self.lock:
            active = self.state in ("starting", "running")
            status = {
                "state": self.state,
                "pid": self.process.pid if (active and self.process) else None,
                "db": self.db if active else None,
                "target": self.target if active else None,
                "cmd": self.cmd if active else None,
                "mode": self.mode if active else None,
                "started_at": self.started_at if active else None,
            }
            if self.exited_unexpectedly:
                status["exited_unexpectedly"] = True
                status["returncode"] = self.returncode
        status["odoo_port_busy"] = port_busy(ODOO_PORT)
        if status["db"]:
            version, enterprise, _ = DATABASE.odoo_info(status["db"])
            status["odoo_version"] = version
            status["enterprise"] = enterprise
        return status

    def start(self, config):
        """Returns (ok, detail). detail is the command on success, an error
        code otherwise."""
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
            self.bus.publish_log(f"{TAG} starting odoo: {cmd}")
            if is_new:
                self.bus.publish_log(
                    f"{TAG} database '{db}' not initialized, applying on_create_args"
                )

            with self._raw_lock:
                self._raw_buf.clear()

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
        self.bus.publish_status(self.status())
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
            self.bus.publish_status(self.status())
            self.bus.publish_log(f"{TAG} stopping odoo...")
            # never let an exception leave us stuck in "stopping" (the guard
            # above would then refuse every future stop until goo restarts)
            try:
                self._terminate(process)
            except Exception as e:
                self.bus.publish_log(f"{TAG} error while stopping: {e}")
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

        self.bus.publish_status(self.status())
        return True, "stopped"

    def _terminate(self, process):
        """Signal-escalate the odoo process group until it exits: graceful
        SIGTERM, then a second SIGTERM (odoo needs a second signal to force the
        shutdown when graceful hangs), then SIGKILL as a last resort."""
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
        self.bus.publish_status(self.status())

    def _handle_line(self, line):
        self.bus.publish_log(line)
        if READY_MARKER in line:
            with self.lock:
                if self.state != "starting":
                    return
                self.state = "running"
            self.bus.publish_status(self.status())


BUS = EventBus()
MANAGER = OdooManager(BUS)
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
# the last start/test config received from the UI — reused by the `goo --test-tags`
# CLI so agents can run tests without re-supplying the target/db/repos/venv
LAST_CONFIG = None
AUTORELOAD = AutoReloader()
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
    def log_message(self, format, *args):
        pass  # keep the terminal quiet

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
        elif path == "/api/data":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            fpath = (qs.get("path") or [""])[0]
            if not fpath:
                return self._send_json(400, {"ok": False, "error": "missing path"})
            data, error = effects.read_json_file(fpath)
            if error:
                return self._send_json(400, {"ok": False, "error": error})
            self._send_json(200, {"ok": True, "data": data})
        else:
            self._send_json(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/start":
            self._action_start(MANAGER.start)
        elif path == "/api/restart":
            self._action_start(MANAGER.restart)
        elif path in ("/api/tests/run", "/api/addons/run"):
            self._action_oneshot()
        elif path == "/api/cli/config":
            self._cli_config()
        elif path == "/api/cli/test":
            self._handle_cli_test()
        elif path == "/api/command":
            config, err = self._read_json()
            if err:
                return self._send_json(400, {"ok": False, "error": err})
            try:
                cmd, _, _ = build_odoo_cmd(config)
                self._send_json(200, {"ok": True, "cmd": cmd})
            except ValueError as e:
                self._send_json(400, {"ok": False, "error": str(e)})
        elif path == "/api/stop":
            ok, detail = MANAGER.stop()
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
            states, unsupported = MERGEBOT.statuses(prs, refresh=bool((body or {}).get("refresh")))
            self._send_json(200, {"ok": True, "states": states, "unsupported": unsupported})
        elif path == "/api/runbot":
            body, err = self._read_json()
            branches = (body or {}).get("branches")
            if err or not isinstance(branches, list):
                return self._send_json(400, {"ok": False, "error": "missing branches list"})
            states = RUNBOT.statuses(branches, refresh=bool((body or {}).get("refresh")))
            self._send_json(200, {"ok": True, "states": states})
        elif path == "/api/autoreload":
            body, err = self._read_json()
            repos = (body or {}).get("repos")
            if err or not isinstance(repos, list):
                return self._send_json(400, {"ok": False, "error": "missing repos list"})
            AUTORELOAD.set_repos(repos)
            self._send_json(200, {"ok": True})
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
        elif path == "/api/code/branch/create":
            body, err = self._read_json()
            repo_path = (body or {}).get("path")
            name = (body or {}).get("name")
            start_point = (body or {}).get("start_point")
            if err or not repo_path or not name or not start_point:
                return self._send_json(400, {"ok": False, "error": "missing path, name or start point"})
            ok, error = GIT.create_branch(repo_path, name, start_point)
            self._send_json(200 if ok else 400, {"ok": ok, "error": error})
        elif path == "/api/open-editor":
            body, err = self._read_json()
            repo_path = (body or {}).get("path")
            if err or not repo_path:
                return self._send_json(400, {"ok": False, "error": "missing path"})
            ok, error = open_in_editor((body or {}).get("editor"), repo_path)
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
            results = []
            for r in repos:
                ok, error = GIT.checkout(r.get("path"), r.get("branch"))
                results.append({"branch": r.get("branch"), "ok": ok, "error": error})
            self._send_json(200, {"ok": True, "results": results})
        elif path == "/api/code/rebase":
            body, err = self._read_json()
            repos = (body or {}).get("repos")
            if err or not isinstance(repos, list):
                return self._send_json(400, {"ok": False, "error": "missing repos list"})
            results = []
            for r in repos:
                ok, error = GIT.fetch_rebase(
                    r.get("path"), r.get("base"), r.get("github"), r.get("repo")
                )
                results.append({"repo": r.get("repo"), "ok": ok, "error": error})
            self._send_json(200, {"ok": True, "results": results})
        elif path == "/api/databases/drop":
            body, err = self._read_json()
            name = (body or {}).get("name")
            if err or not name or not isinstance(name, str):
                return self._send_json(400, {"ok": False, "error": "missing database name"})
            ok, error = DATABASE.drop(name)
            if ok:
                self._send_json(200, {"ok": True})
            else:
                self._send_json(400, {"ok": False, "error": error})
        elif path == "/api/data":
            body, err = self._read_json()
            fpath = (body or {}).get("path")
            if err or not fpath:
                return self._send_json(400, {"ok": False, "error": "missing path"})
            ok, error = effects.write_json_file(fpath, (body or {}).get("data"))
            if ok:
                self._send_json(200, {"ok": True})
            else:
                self._send_json(400, {"ok": False, "error": error})
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

    def _action_start(self, action):
        config, err = self._read_json()
        if err:
            return self._send_json(400, {"ok": False, "error": err})
        global LAST_CONFIG
        LAST_CONFIG = config
        ok, detail = action(config)
        if ok:
            self._send_json(200, {"ok": True, "state": "starting", "cmd": detail})
        else:
            code = 400 if detail.startswith("invalid_config") else 409
            self._send_json(code, {"ok": False, "error": detail})

    def _action_oneshot(self):
        """Stop whatever holds the odoo port, then start a one-shot run
        (tests / install / upgrade). Shares the manager with the server."""
        config, err = self._read_json()
        if err:
            return self._send_json(400, {"ok": False, "error": err})
        global LAST_CONFIG
        LAST_CONFIG = config
        MANAGER.stop()
        ok, detail = MANAGER.start(config)
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
                            fcntl.ioctl(fd, termios.TIOCSWINSZ,
                                        struct.pack("HHHH", rows, cols, 0, 0))
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
                            fcntl.ioctl(master_fd, termios.TIOCSWINSZ,
                                        struct.pack("HHHH", rows, cols, 0, 0))
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
            self._send_event("status", MANAGER.status())
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

    def _cli_config(self):
        """Store the current UI config (pushed by the browser) so the
        `goo --test-tags` CLI can run a one-shot test without the server having
        been started."""
        config, err = self._read_json()
        if err:
            return self._send_json(400, {"ok": False, "error": err})
        global LAST_CONFIG
        LAST_CONFIG = config
        self._send_json(200, {"ok": True})

    def _handle_cli_test(self):
        """Run a one-shot test (triggered by the `goo --test-tags` CLI) as its own
        odoo process — on free ports, so a running server is left untouched — and
        stream the log back as plain text. Announces the run on the server log +
        the browser event log, reusing the last config (target, db, repos, venv)."""
        body, err = self._read_json()
        tags = ((body or {}).get("test_tags") or "").strip()
        if err or not tags:
            return self._send_json(400, {"ok": False, "error": "missing test_tags"})
        if LAST_CONFIG is None:
            return self._send_json(
                409, {"ok": False, "error": "no target yet — open the goo UI (with a target configured) once"}
            )
        cfg = dict(LAST_CONFIG)
        cfg["start"] = {**(LAST_CONFIG.get("start") or {}), "test_tags": tags}
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
    args = parser.parse_args()

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
    # check whether goo's checkout is behind origin/master — at startup, then hourly
    threading.Thread(target=goo_update_loop, daemon=True).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print(f"\n{TAG} shutting down...")
    finally:
        MANAGER.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
