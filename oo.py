#!/usr/bin/env python3
"""oo - Odoo development helper, served as a local web app.

Run `python3 oo.py`, open the printed URL. The frontend (static/) holds the
configuration and posts it with each start request; the backend is stateless.
"""

import atexit
import collections
import json
import mimetypes
import os
import pty
import queue
import signal
import socket
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TAG = "[oo]"
HOST = "127.0.0.1"
PORT = 8068
ODOO_PORT = 8069
READY_MARKER = "odoo.registry: Registry loaded"
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
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

def port_busy(port):
    try:
        with socket.create_connection((HOST, port), timeout=0.3):
            return True
    except OSError:
        return False


def kill_port(port):
    """Kill any process listening on the given port."""
    try:
        result = subprocess.run(
            ["lsof", "-ti", f":{port}"],
            capture_output=True, text=True, timeout=3,
        )
        for pid_str in result.stdout.strip().split("\n"):
            if pid_str.strip():
                try:
                    os.kill(int(pid_str.strip()), signal.SIGKILL)
                except (ProcessLookupError, ValueError, OSError):
                    pass
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass


def db_initialized(db_name):
    """Check if the database exists AND holds an initialized odoo schema.

    A database can exist as an empty shell (e.g. leftover from an aborted
    run); odoo then refuses to load it without -i, so treat it as new.
    """
    try:
        result = subprocess.run(
            ["psql", "-d", db_name, "-tAc",
             "SELECT 1 FROM information_schema.tables"
             " WHERE table_name = 'ir_module_module'"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode != 0:
            return False  # database doesn't exist
        return result.stdout.strip() == "1"
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return True  # can't check: assume initialized, avoid surprise installs


def build_odoo_cmd(config):
    """Build the odoo-bin shell command from a client config.

    Returns (cmd, db, is_new_db). Raises ValueError on invalid config.
    """
    start = config.get("start") or {}
    db = start.get("db")
    if not db:
        raise ValueError("no database configured (start.db)")

    repo_map = {
        r["id"]: r for r in config.get("repos", [])
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
    addons_path = ",".join(addons_parts)

    db_user = config.get("db_user", "odoo")
    db_password = config.get("db_password", "odoo")
    venv_activate = config.get("venv_activate", "")

    parts = []
    if venv_activate:
        parts.append(venv_activate)
    parts.append(f"cd {community_path}")
    parts.append(
        f"./odoo-bin "
        f"-r {db_user} -w {db_password} -d {db} "
        f"--database {db} --no-database-list --with-demo "
        f"--addons-path {addons_path}"
    )
    cmd = " && ".join(parts)

    other_args = start.get("other_args", "")
    if other_args:
        cmd += f" {other_args}"

    is_new = not db_initialized(db)
    on_create_args = start.get("on_create_args", "")
    if is_new and on_create_args:
        cmd += f" {on_create_args}"
    return cmd, db, is_new


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
        self.exited_unexpectedly = False
        self.returncode = None

    def status(self):
        with self.lock:
            active = self.state in ("starting", "running")
            status = {
                "state": self.state,
                "pid": self.process.pid if (active and self.process) else None,
                "db": self.db if active else None,
            }
            if self.exited_unexpectedly:
                status["exited_unexpectedly"] = True
                status["returncode"] = self.returncode
        status["odoo_port_busy"] = port_busy(ODOO_PORT)
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
            self.bus.publish_log(f"{TAG} starting odoo: {cmd}")
            if is_new:
                self.bus.publish_log(f"{TAG} database '{db}' not initialized, applying on_create_args")

            master_fd, slave_fd = pty.openpty()
            self.process = subprocess.Popen(
                cmd, shell=True, executable="/bin/bash",
                stdout=slave_fd, stderr=slave_fd, stdin=slave_fd,
                preexec_fn=os.setsid,
            )
            os.close(slave_fd)
            self.master_fd = master_fd
            self.state = "starting"
            self.reader_thread = threading.Thread(
                target=self._reader, args=(master_fd, self.process), daemon=True,
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
            try:
                pgid = os.getpgid(process.pid)
                os.killpg(pgid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(pgid, signal.SIGKILL)
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        pass
            except (ProcessLookupError, OSError):
                pass
            kill_port(ODOO_PORT)
            if reader:
                reader.join(timeout=2)
            with self.lock:
                self.state = "stopped"
                self.process = None
                self.master_fd = None
                self.db = None
            self.bus.publish_log(f"{TAG} odoo stopped")
        elif port_busy(ODOO_PORT):
            kill_port(ODOO_PORT)
            self.bus.publish_log(f"{TAG} killed process on port {ODOO_PORT}")

        self.bus.publish_status(self.status())
        return True, "stopped"

    def restart(self, config):
        ok, detail = self.stop()
        if not ok:
            return ok, detail
        return self.start(config)

    def shutdown(self):
        """Cleanup on oo exit: stop our own child, but never touch an
        external odoo we didn't start."""
        with self.lock:
            active = self.state in ("starting", "running")
        if active:
            self.stop()

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
            self._serve_static(path[len("/static/"):])
        elif path == "/api/status":
            self._send_json(200, MANAGER.status())
        elif path == "/api/events":
            self._handle_events()
        else:
            self._send_json(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/start":
            self._action_start(MANAGER.start)
        elif path == "/api/restart":
            self._action_start(MANAGER.restart)
        elif path == "/api/stop":
            ok, detail = MANAGER.stop()
            if ok:
                self._send_json(200, {"ok": True, "state": "stopped"})
            else:
                self._send_json(409, {"ok": False, "error": detail})
        else:
            self._send_json(404, {"ok": False, "error": "not_found"})

    # --- API helpers ---

    def _action_start(self, action):
        config, err = self._read_json()
        if err:
            return self._send_json(400, {"ok": False, "error": err})
        ok, detail = action(config)
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

    # --- SSE ---

    def _handle_events(self):
        q, backlog = BUS.subscribe()
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

    def _send_event(self, event, payload):
        # json.dumps guarantees a single-line data field
        msg = f"event: {event}\ndata: {json.dumps(payload)}\n\n"
        self.wfile.write(msg.encode("utf-8"))
        self.wfile.flush()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    try:
        httpd = Server((HOST, PORT), Handler)
    except OSError as e:
        print(f"{TAG} cannot bind {HOST}:{PORT}: {e}")
        return 1

    print(f"{TAG} running at http://{HOST}:{PORT}", flush=True)

    signal.signal(signal.SIGTERM, lambda signum, frame: sys.exit(0))
    atexit.register(MANAGER.shutdown)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print(f"\n{TAG} shutting down...")
    finally:
        MANAGER.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
