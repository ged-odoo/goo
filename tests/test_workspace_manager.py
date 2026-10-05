"""Integration tests for the process subsystem in backend/server.py: WorkspaceManager
(start/stop/restart/one-shot runs/snapshots) against a real PTY-launched fake
`odoo-bin`, and the terminal/shell/CLI-test endpoints over a real HTTP server with a
raw-socket WebSocket client. No real Odoo, database, or docker: the singletons the
manager reads (DATABASE, DOCKER_INFRA, CONFIG, BUS) are swapped for small fakes."""

import base64
import contextlib
import http.client
import io
import json
import os
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest

from backend import server

# Stands in for odoo-bin. Behaviour is chosen by the arguments goo passes it:
#   `shell ...`            -> a line-echo REPL (the odoo-bin shell popup)
#   --test-tags pass|fail  -> a one-shot run exiting 0 / 1 after the ready marker
#   --test-tags hang       -> a one-shot run that never finishes
#   --fake-crash           -> dies with exit code 3 before becoming ready
#   otherwise              -> a server: listens on --http-port, spawns a child in
#                             its process group, echoes PTY input, runs until killed
FAKE_ODOO = r"""
import os, socket, subprocess, sys, threading, time

args = sys.argv[1:]


def opt(name):
    return args[args.index(name) + 1] if name in args else None


print(f"FAKE_PID={os.getpid()}", flush=True)
if args and args[0] == "shell":
    print(f"SHELL db={opt('-d')}", flush=True)
    for line in sys.stdin:
        print("SHELL-OUT:" + line.strip(), flush=True)
    sys.exit(0)

print(f"odoo.modules.loading: db={opt('-d')}", flush=True)
if "-i" in args:
    print(f"installing {opt('-i')}", flush=True)
if "--fake-crash" in args:
    sys.stdout.write("fatal: boom (no newline)")
    sys.stdout.flush()
    sys.exit(3)

tags = opt("--test-tags")
listener = None
port = opt("--http-port")
if port:
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", int(port)))
    listener.listen(5)
if not tags:
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    print(f"CHILD_PID={child.pid}", flush=True)
print("2026-01-01 INFO db odoo.registry: Registry loaded in 0.01s", flush=True)
if tags == "pass":
    print("tests: 3 passed", flush=True)
    sys.exit(0)
if tags == "fail":
    print("tests: 1 failed", flush=True)
    sys.exit(1)


def echo():
    for line in sys.stdin:
        s = line.strip()
        if s == "size":
            size = os.get_terminal_size(0)
            print(f"SIZE={size.lines}x{size.columns}", flush=True)
        else:
            print("GOT:" + s, flush=True)


threading.Thread(target=echo, daemon=True).start()
while True:
    if listener:
        conn, _ = listener.accept()
        conn.close()
    else:
        time.sleep(0.1)
"""

TIMEOUT = 5.0


def wait_for(pred, what, timeout=TIMEOUT):
    """Poll `pred` until truthy (returning its value) or fail after `timeout`."""
    deadline = time.monotonic() + timeout
    while True:
        value = pred()
        if value:
            return value
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {what}")
        time.sleep(0.02)


def pid_gone(pid):
    """True when `pid` no longer runs (absent, or a zombie awaiting its reaper)."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().rsplit(")", 1)[1].split()[0] == "Z"
    except OSError:
        return True


def can_connect(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.3):
            return True
    except OSError:
        return False


class _FakeBus:
    """Records what the manager / handlers publish, without any SSE plumbing."""

    def __init__(self):
        self.runs = []
        self.servers = []
        self.logs = []  # (server, line)
        self.events = []  # (text, level)

    def publish_run(self, snap):
        self.runs.append(snap)

    def publish_server(self, snap):
        self.servers.append(snap)

    def publish_log(self, line, server="main"):
        self.logs.append((server, line))

    def publish_event(self, text, level="", **kw):
        self.events.append((text, level))


class _FakeDatabase:
    def __init__(self):
        self.initialized = True

    def db_initialized(self, db):
        return self.initialized

    def installed_modules(self, db):
        return {}

    def odoo_info(self, db):
        return "17.0", True, True, None


class _FakeDocker:
    """DockerInfraService stand-in: each ensure_* returns the configured outcome."""

    def __init__(self, network=(True, None), postgres=(True, None), nginx=(True, None)):
        self.network, self.postgres, self.nginx = network, postgres, nginx
        self.image = ("odoo:dev", None)
        self.slot = "dev"

    def ensure_network(self, name):
        return self.network

    def ensure_postgres(self, config):
        return self.postgres

    def ensure_nginx(self, config):
        return self.nginx

    def ensure_image(self, config, branch):
        return self.image

    def next_container_slot(self):
        return self.slot


class _FakeConfig:
    def __init__(self, config, state=None):
        self.snapshot = {"rev": 1, "config": config, "state": state or {}}

    def get(self):
        return self.snapshot


class _ProcessTestCase(unittest.TestCase):
    """A temp "community" checkout holding the fake odoo-bin, a fresh manager with
    a recording bus, and fakes for the singletons it reads."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.community = os.path.join(tmp.name, "community")
        os.makedirs(self.community)
        with open(os.path.join(self.community, "odoo-bin"), "w") as f:
            f.write(FAKE_ODOO)
        self.tmp = tmp.name
        self.bus = _FakeBus()
        self.mgr = server.WorkspaceManager(self.bus)
        self.pids = []  # every fake pid seen, killed in cleanup if still alive
        self._swap("DATABASE", _FakeDatabase())
        self._swap("DOCKER_INFRA", _FakeDocker())
        # main's stop/status probe odoo's default port — point it at a free one so
        # the tests never see (or kill) a developer's real odoo on 8069
        self._swap("ODOO_PORT", server.free_port())
        self.addCleanup(self._kill_leftovers)

    def _swap(self, name, value):
        old = getattr(server, name)
        setattr(server, name, value)
        self.addCleanup(setattr, server, name, old)

    def _kill_leftovers(self):
        self.mgr.shutdown()
        for pid in self.pids:
            with contextlib.suppress(OSError):
                os.kill(pid, 9)

    def config(self, db="db1", **start):
        return {
            "repos": [{"id": "community", "path": self.community}],
            "venv_python": sys.executable,
            "start": {"db": db, "repos": ["community"], **start},
        }

    def logs(self, wsid):
        return [line for srv, line in self.bus.logs if srv == wsid]

    def wait_state(self, wsid, state):
        return wait_for(
            lambda: self.mgr.entries.get(wsid) and self.mgr.entries[wsid].state == state,
            f"{wsid} to be {state}",
        )

    def fake_pid(self, wsid, key="FAKE_PID", after=0):
        """The pid the fake printed as `key=<pid>` on `wsid`'s stream."""

        def find():
            for line in self.logs(wsid)[after:]:
                if line.startswith(f"{key}="):
                    return int(line.split("=", 1)[1])
            return None

        pid = wait_for(find, f"{key} on {wsid}")
        self.pids.append(pid)
        return pid

    def start_running(self, wsid, config):
        ok, detail = self.mgr.start(wsid, config)
        self.assertTrue(ok, detail)
        self.wait_state(wsid, "running")
        return detail


class WorkspaceServerLifecycleTest(_ProcessTestCase):
    def test_start_goes_starting_then_running_and_serves_on_its_port(self):
        detail = self.start_running("w1", self.config(db="shop"))
        port = detail["port"]
        states = [s["state"] for s in self.bus.servers if s and s["id"] == "w1"]
        self.assertEqual(states, ["starting", "running"])
        # odoo's own output reaches the workspace's log stream and scrollback
        lines = self.logs("w1")
        self.assertIn("odoo.modules.loading: db=shop", lines)
        self.assertTrue(any(server.READY_MARKER in line for line in lines))
        self.assertIn("odoo.modules.loading: db=shop", self.mgr.logs_for("w1"))
        self.assertTrue(any("starting odoo" in line for line in lines))
        # the PTY bytes are kept for terminal replay
        self.assertIn(b"Registry loaded", bytes(self.mgr.entries["w1"].raw_buf))
        self.assertTrue(wait_for(lambda: can_connect(port), "fake odoo to listen"))
        snap = self.mgr.status_for(
            [{"id": "w1", "dirPath": self.tmp}, {"id": "never", "dirPath": "/nope"}, {}]
        )
        self.assertEqual(snap["w1"]["state"], "running")
        self.assertEqual(snap["w1"]["port"], port)
        self.assertEqual(snap["w1"]["db"], "shop")
        self.assertTrue(snap["w1"]["exists"])
        self.assertEqual(snap["never"]["state"], "stopped")
        self.assertFalse(snap["never"]["exists"])
        self.assertFalse(snap["never"]["terminal"])
        self.assertEqual(set(snap), {"w1", "never"})
        self.assertEqual([s["id"] for s in self.mgr.public_snapshots()], ["main", "w1"])
        self.assertEqual(self.mgr.server_config("w1")["start"]["db"], "shop")
        self.assertIsNone(self.mgr.server_config("unknown"))

    def test_stop_kills_the_whole_process_group_and_frees_the_port(self):
        port = self.start_running("w1", self.config())["port"]
        pid = self.fake_pid("w1")
        child = self.fake_pid("w1", "CHILD_PID")
        wait_for(lambda: can_connect(port), "fake odoo to listen")

        self.assertEqual(self.mgr.stop("w1"), (True, "stopped"))

        entry = self.mgr.entries["w1"]
        self.assertEqual(entry.state, "stopped")
        self.assertIsNone(entry.process)
        self.assertFalse(entry.exited_unexpectedly)
        self.assertTrue(wait_for(lambda: pid_gone(pid), "fake odoo to die"))
        self.assertTrue(wait_for(lambda: pid_gone(child), "its child to die"))
        self.assertFalse(can_connect(port))
        self.assertIn(f"{server.TAG} stopping odoo...", self.mgr.logs_for("w1"))
        self.assertEqual(self.bus.servers[-1]["state"], "stopped")
        # idempotent: stopping again (or an unknown workspace) is still ok
        self.assertEqual(self.mgr.stop("w1"), (True, "stopped"))
        self.assertEqual(self.mgr.stop("nope"), (True, "stopped"))

    def test_start_twice_is_refused(self):
        self.start_running("w1", self.config())
        self.assertEqual(self.mgr.start("w1", self.config()), (False, "already_running"))

    def test_invalid_config_is_reported_without_launching(self):
        ok, detail = self.mgr.start("w1", {"start": {"db": ""}})
        self.assertFalse(ok)
        self.assertTrue(detail.startswith("invalid_config:"), detail)
        self.assertEqual(self.mgr.start("", self.config()), (False, "missing workspace"))
        self.assertNotIn("w1", self.mgr.entries)

    def test_crash_is_reported_with_its_return_code(self):
        ok, _ = self.mgr.start("w1", self.config(other_args="--fake-crash"))
        self.assertTrue(ok)
        wait_for(lambda: self.mgr.entries["w1"].exited_unexpectedly, "the crash")
        entry = self.mgr.entries["w1"]
        self.assertEqual(entry.state, "stopped")
        self.assertEqual(entry.returncode, 3)
        self.assertIn(
            ("workspace server (w1) exited unexpectedly (code 3)", "error"), self.bus.events
        )
        # a last line without a trailing newline still reaches the log
        self.assertIn("fatal: boom (no newline)", self.mgr.logs_for("w1"))
        self.assertEqual(self.bus.servers[-1]["state"], "stopped")
        # and it can be started again afterwards
        self.start_running("w1", self.config())
        self.assertFalse(self.mgr.entries["w1"].exited_unexpectedly)

    def test_restart_gives_a_new_process(self):
        self.start_running("w1", self.config())
        old = self.fake_pid("w1")
        n = len(self.logs("w1"))
        ok, _ = self.mgr.restart("w1", self.config())
        self.assertTrue(ok)
        self.wait_state("w1", "running")
        new = self.fake_pid("w1", after=n)
        self.assertNotEqual(old, new)
        self.assertTrue(pid_gone(old))
        self.assertFalse(pid_gone(new))

    def test_busy_stable_port_falls_back_to_a_free_one(self):
        with socket.socket() as busy:
            busy.bind(("127.0.0.1", 0))
            busy.listen(1)
            wanted = busy.getsockname()[1]
            port = self.start_running("w1", {**self.config(), "worktree_port": wanted})["port"]
        self.assertNotEqual(port, wanted)
        self.assertIn(
            f"{server.TAG} port {wanted} is busy — falling back to a free port", self.logs("w1")
        )
        self.assertTrue(wait_for(lambda: can_connect(port), "fake odoo on the fallback port"))

    def test_port_fallback_notice_stays_in_the_scrollback(self):
        with socket.socket() as busy:
            busy.bind(("127.0.0.1", 0))
            busy.listen(1)
            wanted = busy.getsockname()[1]
            self.start_running("w1", {**self.config(), "worktree_port": wanted})
        self.assertIn(
            f"{server.TAG} port {wanted} is busy — falling back to a free port",
            self.mgr.logs_for("w1"),
        )

    def test_free_stable_port_is_honored(self):
        wanted = server.free_port()
        port = self.start_running("w1", {**self.config(), "worktree_port": wanted})["port"]
        self.assertEqual(port, wanted)
        self.assertTrue(wait_for(lambda: can_connect(wanted), "fake odoo on its stable port"))

    def test_two_workspaces_run_side_by_side_without_mixing(self):
        p1 = self.start_running("w1", self.config(db="db1"))["port"]
        p2 = self.start_running("w2", self.config(db="db2"))["port"]
        self.assertNotEqual(p1, p2)
        self.assertNotEqual(self.fake_pid("w1"), self.fake_pid("w2"))
        self.assertIn("odoo.modules.loading: db=db1", self.mgr.logs_for("w1"))
        self.assertNotIn("odoo.modules.loading: db=db2", self.mgr.logs_for("w1"))
        self.assertIn("odoo.modules.loading: db=db2", self.mgr.logs_for("w2"))
        wait_for(lambda: can_connect(p1) and can_connect(p2), "both fakes to listen")
        # a third workspace (or main) on an already-held database is refused
        self.assertEqual(
            self.mgr.start("w3", self.config(db="db1")),
            (False, "database 'db1' is in use by another workspace's server"),
        )
        self.assertEqual(
            self.mgr.start("main", self.config(db="db2")),
            (False, "database 'db2' is in use by the 'w2' workspace server"),
        )
        # stopping one leaves the other running
        self.mgr.stop("w1")
        self.assertEqual(self.mgr.entries["w2"].state, "running")
        self.assertTrue(can_connect(p2))

    def test_shutdown_stops_every_server(self):
        self.start_running("w1", self.config(db="db1"))
        self.start_running("w2", self.config(db="db2"))
        pids = [self.fake_pid("w1"), self.fake_pid("w2")]
        self.mgr.shutdown()
        self.assertEqual({e.state for e in self.mgr.entries.values()}, {"stopped"})
        for pid in pids:
            self.assertTrue(wait_for(lambda pid=pid: pid_gone(pid), f"pid {pid} to die"))


class MainServerTest(_ProcessTestCase):
    def test_main_lifecycle_and_enriched_status(self):
        server.DATABASE.initialized = False
        ok, detail = self.mgr.start("main", self.config(db="maindb", on_create_args="-i base"))
        self.assertTrue(ok, detail)
        self.assertIsNone(detail["port"])  # main runs on odoo's default port
        self.wait_state("main", "running")
        status = self.mgr.status()
        self.assertEqual(status["state"], "running")
        self.assertEqual(status["db"], "maindb")
        self.assertEqual(status["odoo_version"], "17.0")
        self.assertTrue(status["enterprise"])
        self.assertEqual(status["pid"], self.mgr.entries["main"].process.pid)
        self.assertIn("installing base", self.logs("main"))  # uninitialized db → on_create_args
        self.assertTrue(any("not initialized" in line for line in self.logs("main")))
        # the other workspaces can't take main's database
        self.assertEqual(
            self.mgr.start("w1", self.config(db="maindb")),
            (False, "database 'maindb' is in use by the main server"),
        )
        pid = self.fake_pid("main")

        self.assertEqual(self.mgr.stop("main"), (True, "stopped"))
        self.assertTrue(wait_for(lambda: pid_gone(pid), "main odoo to die"))
        status = self.mgr.status()
        self.assertEqual(status["state"], "stopped")
        self.assertIsNone(status["db"])
        self.assertIsNone(status["pid"])
        self.assertIn(f"{server.TAG} odoo stopped", self.logs("main"))
        # stopping an already-stopped main is a no-op success
        self.assertEqual(self.mgr.stop("main"), (True, "stopped"))

    def test_main_crash_shows_in_status(self):
        self.mgr.start("main", self.config(other_args="--fake-crash"))
        wait_for(lambda: self.mgr.status()["exited_unexpectedly"], "main to crash")
        status = self.mgr.status()
        self.assertEqual(status["state"], "stopped")
        self.assertEqual(status["returncode"], 3)
        self.assertIn(f"{server.TAG} odoo exited unexpectedly (code 3)", self.logs("main"))


class OneShotRunTest(_ProcessTestCase):
    def wait_run(self, state):
        return wait_for(
            lambda: next((r for r in reversed(self.bus.runs) if r["state"] == state), None),
            f"a {state} run",
        )

    def test_passing_run_resumes_the_interrupted_server(self):
        server_cfg = self.config(db="db1")
        self.start_running("w1", server_cfg)
        server_pid = self.fake_pid("w1")

        ok, _ = self.mgr.oneshot("w1", self.config(db="db1", test_tags="pass"))
        self.assertTrue(ok)
        running = self.wait_run("running")
        self.assertEqual(running["kind"], "test")
        self.assertEqual(running["spec"], {"tags": "pass"})
        self.assertTrue(running["resume"])
        self.assertTrue(pid_gone(server_pid))  # the server was stopped for the run

        done = self.wait_run("done")
        self.assertTrue(done["ok"])
        self.assertEqual(done["returncode"], 0)
        self.assertEqual(done["id"], running["id"])
        # the backend brings the interrupted server back on its own
        wait_for(
            lambda: (
                self.mgr.entries["w1"].mode == "server"
                and self.mgr.entries["w1"].state == "running"
            ),
            "the server to resume",
        )
        self.assertIs(self.mgr.server_config("w1"), server_cfg)
        self.assertEqual([r["state"] for r in self.mgr.run_snapshots()], [])  # server clears run

    def test_failing_run_without_a_server_stays_stopped(self):
        ok, _ = self.mgr.oneshot("w1", self.config(test_tags="fail"))
        self.assertTrue(ok)
        failed = self.wait_run("failed")
        self.assertFalse(failed["ok"])
        self.assertEqual(failed["returncode"], 1)
        self.assertFalse(failed["resume"])
        self.assertIn("tests: 1 failed", self.mgr.logs_for("w1"))
        self.wait_state("w1", "stopped")
        self.assertEqual([r["state"] for r in self.mgr.run_snapshots()], ["failed"])

    def test_install_run_is_minted_as_an_install(self):
        ok, _ = self.mgr.oneshot("w1", self.config(install="sale"))
        self.assertTrue(ok)
        run = self.wait_run("running")
        self.assertEqual((run["kind"], run["spec"]), ("install", {"module": "sale"}))
        self.assertIn("installing sale", wait_for(lambda: self.mgr.logs_for("w1"), "output"))

    def test_stopping_a_run_mid_way_fails_it_and_resumes_the_server(self):
        self.start_running("w1", self.config())
        n = len(self.logs("w1"))
        self.mgr.oneshot("w1", self.config(test_tags="hang"))
        self.wait_state("w1", "running")
        run_pid = self.fake_pid("w1", after=n)

        self.assertEqual(self.mgr.stop_and_finalize("w1"), (True, "stopped"))

        failed = self.wait_run("failed")
        self.assertFalse(failed["ok"])
        self.assertIsNone(failed["returncode"])
        self.assertTrue(pid_gone(run_pid))
        self.wait_state("w1", "running")
        self.assertEqual(self.mgr.entries["w1"].mode, "server")

    def test_a_finished_run_is_not_reported_as_a_crash(self):
        self.mgr.oneshot("w1", self.config(test_tags="pass"))
        self.wait_run("done")
        self.wait_state("w1", "stopped")
        self.assertFalse(any("exited unexpectedly" in text for text, _ in self.bus.events))
        self.assertFalse(self.mgr.entries["w1"].exited_unexpectedly)


class DockerStartFailureTest(_ProcessTestCase):
    """Docker-mode start refuses cleanly when its infrastructure can't be set up
    (no docker is touched: DOCKER_INFRA is faked)."""

    def docker_config(self):
        return {**self.config(), "launch_mode": "docker"}

    def test_each_infra_failure_is_reported(self):
        cases = [
            ({"network": (False, "no net")}, "docker network: no net"),
            ({"postgres": (False, "no pg")}, "docker postgres: no pg"),
            ({"nginx": (False, "no nginx")}, "docker nginx: no nginx"),
        ]
        for kw, expected in cases:
            server.DOCKER_INFRA = _FakeDocker(**kw)
            self.assertEqual(self.mgr.start("w1", self.docker_config()), (False, expected))
        server.DOCKER_INFRA = _FakeDocker()
        server.DOCKER_INFRA.image = (None, "pull failed")
        self.assertEqual(
            self.mgr.start("w1", self.docker_config()), (False, "docker image: pull failed")
        )
        server.DOCKER_INFRA = _FakeDocker()
        server.DOCKER_INFRA.slot = None
        self.assertEqual(
            self.mgr.start("w1", self.docker_config()), (False, "docker: no free dev slot found")
        )
        server.DOCKER_INFRA = _FakeDocker()  # no docker_worktree_dir → invalid config
        ok, detail = self.mgr.start("w1", self.docker_config())
        self.assertFalse(ok)
        self.assertTrue(detail.startswith("invalid_config:"), detail)
        self.assertEqual(self.mgr.entries.get("w1", server._Entry("w1")).state, "stopped")


class DockerMainServerTest(_ProcessTestCase):
    """The main server follows launch_mode like any workspace: in docker mode it is
    a container (published on odoo's default ports, which the UI's links use), never a
    local odoo-bin. A fake `docker` on PATH records its calls — the real one is never run."""

    def setUp(self):
        super().setUp()
        bindir = os.path.join(self.tmp, "bin")
        os.makedirs(bindir)
        self.calls = os.path.join(self.tmp, "docker-calls")
        script = os.path.join(bindir, "docker")
        with open(script, "w") as f:
            f.write(
                f'#!/bin/sh\necho "$@" >> {self.calls}\n[ "$1" = run ] && exec sleep 30\nexit 0\n'
            )
        os.chmod(script, 0o755)
        old_path = os.environ["PATH"]
        os.environ["PATH"] = f"{bindir}:{old_path}"
        self.addCleanup(os.environ.__setitem__, "PATH", old_path)

    def docker_calls(self):
        with contextlib.suppress(FileNotFoundError), open(self.calls) as f:
            return f.read().splitlines()
        return []

    def docker_config(self):
        return {
            **self.config(),
            "launch_mode": "docker",
            "main_repo_id": "community",
            "docker_worktree_dir": self.tmp,
        }

    def test_main_server_runs_in_a_container_publishing_odoo_ports(self):
        ok, detail = self.mgr.start("main", self.docker_config())
        self.assertTrue(ok, detail)
        self.assertEqual(self.mgr.entries["main"].docker_container, "dev")
        run = wait_for(lambda: self.docker_calls(), "docker run")[0]
        self.assertTrue(run.startswith("run "), run)
        self.assertIn("--name dev", run)
        self.assertIn("-p 8069:8069 -p 8072:8072", run)

    def test_stopping_the_main_container_stops_it_through_docker(self):
        self.mgr.start("main", self.docker_config())
        wait_for(lambda: self.docker_calls(), "docker run")
        self.assertEqual(self.mgr.stop("main"), (True, "stopped"))
        self.assertIn("stop -t 10 dev", self.docker_calls())

    def test_a_worktree_container_does_not_publish_ports(self):
        self.mgr.start("w1", self.docker_config())
        run = wait_for(lambda: self.docker_calls(), "docker run")[0]
        self.assertNotIn("-p 8069", run)


# ── HTTP / WebSocket endpoints ───────────────────────────────────────────────────


class _WSClient:
    """The few lines of client-side WebSocket framing the tests need."""

    def __init__(self, port, path):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=TIMEOUT)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(
            (
                f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n"
                "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
            ).encode()
        )
        self.buf = b""
        while b"\r\n\r\n" not in self.buf:
            self.buf += self._recv()
        head, self.buf = self.buf.split(b"\r\n\r\n", 1)
        lines = head.decode().split("\r\n")
        self.status = int(lines[0].split()[1])
        headers = dict(line.split(": ", 1) for line in lines[1:])
        self.accept_ok = headers.get("Sec-WebSocket-Accept") == server._ws_accept_key(key)
        self.data = b""  # every payload byte received so far
        self.closed = False

    def _recv(self):
        chunk = self.sock.recv(65536)
        if not chunk:
            raise OSError("connection closed")
        return chunk

    def _take(self, n):
        while len(self.buf) < n:
            self.buf += self._recv()
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv_frame(self):
        b0, b1 = self._take(2)
        length = b1 & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._take(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._take(8))[0]
        return b0 & 0x0F, self._take(length)

    def send(self, payload, opcode=2):
        mask = os.urandom(4)
        n = len(payload)
        header = bytes([0x80 | opcode])
        if n < 126:
            header += bytes([0x80 | n])
        else:
            header += bytes([0x80 | 126]) + struct.pack(">H", n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def read_until(self, needle):
        """Read frames until `needle` appears in the received bytes (or fail)."""
        deadline = time.monotonic() + TIMEOUT
        while needle not in self.data:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or self.closed:
                raise AssertionError(f"{needle!r} never arrived; got {self.data[-500:]!r}")
            self.sock.settimeout(remaining)
            try:
                opcode, payload = self.recv_frame()
            except TimeoutError:
                continue
            if opcode == 8:
                self.closed = True
            self.data += payload
        return self.data

    def close(self):
        with contextlib.suppress(OSError):
            self.send(b"", opcode=8)
        self.sock.close()


class _HttpTestCase(_ProcessTestCase):
    """A real goo HTTP server on an ephemeral port, serving this test's manager."""

    def setUp(self):
        super().setUp()
        self._swap("WORKSPACES", self.mgr)
        self._swap("BUS", self.bus)
        self.httpd = server.Server(("127.0.0.1", 0), server.Handler)
        self.port = self.httpd.server_address[1]
        threading.Thread(
            target=self.httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        ).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)

    def ws(self, path):
        client = _WSClient(self.port, path)
        self.addCleanup(client.close)
        return client

    def get(self, path, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=TIMEOUT)
        self.addCleanup(conn.close)
        conn.request("GET", path, headers=headers or {})
        resp = conn.getresponse()
        return resp.status, json.loads(resp.read() or b"null")

    def post(self, path, body):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=TIMEOUT)
        self.addCleanup(conn.close)
        conn.request("POST", path, json.dumps(body), {"Content-Type": "application/json"})
        resp = conn.getresponse()
        return resp.status, resp.read().decode()

    def workspace_config(self):
        return {
            "repos": [{"id": "community", "path": self.community}],
            "venv_python": sys.executable,
            "workspaces": [{"id": "w1", "db": "shdb", "checkouts": [{"repo": "community"}]}],
        }


class TerminalEndpointTest(_HttpTestCase):
    def test_terminal_replays_then_proxies_the_server_pty(self):
        self.start_running("w1", self.config())
        term = self.ws("/api/terminal?workspace=w1")
        self.assertEqual(term.status, 101)
        self.assertTrue(term.accept_ok)
        term.read_until(b"Registry loaded")  # the replayed scrollback
        wait_for(lambda: self.mgr.entries["w1"].ws_clients, "the client to register")

        term.send(b"hello-term\n")
        term.read_until(b"GOT:hello-term")  # keystrokes reach odoo, its output comes back

        term.send(json.dumps({"type": "resize", "rows": 40, "cols": 100}).encode(), opcode=1)
        term.send(b"not json", opcode=1)  # ignored
        term.send(b"size\n")
        term.read_until(b"SIZE=40x100")

        term.close()
        wait_for(lambda: not self.mgr.entries["w1"].ws_clients, "the client to unregister")

    def test_terminal_refusals(self):
        self.assertEqual(self.get("/api/terminal?workspace=nope")[0], 404)
        self.assertEqual(self.get("/api/terminal")[0], 400)  # main exists; no WS key
        self.assertEqual(self.get("/api/terminal", {"Origin": "http://evil.example"})[0], 403)


class ShellEndpointTest(_HttpTestCase):
    def setUp(self):
        super().setUp()
        # a predictable interactive bash: no user rc files, a plain prompt
        for name, value in (("HOME", self.tmp), ("PS1", "$ ")):
            old = os.environ.get(name)
            os.environ[name] = value
            self.addCleanup(
                lambda n=name, o=old: (
                    os.environ.pop(n, None) if o is None else os.environ.__setitem__(n, o)
                )
            )

    def test_bash_in_cwd_runs_commands_and_dies_on_close(self):
        sh = self.ws(f"/api/shell?cwd={self.community}")
        self.assertEqual(sh.status, 101)
        sh.send(json.dumps({"type": "resize", "rows": 30, "cols": 90}).encode(), opcode=1)
        sh.send(b"echo hi-from-test-$((40+2)) pid=$$ cwd=$PWD; stty size\n")
        out = sh.read_until(b"30 90")
        self.assertIn(b"hi-from-test-42", out)
        self.assertIn(f"cwd={self.community}".encode(), out)
        pid = int(out.split(b"pid=")[-1].split()[0])
        self.pids.append(pid)
        sh.close()
        self.assertTrue(wait_for(lambda: pid_gone(pid), "the shell to be killed"))

    def test_workspace_shell_runs_odoo_bin_shell_on_its_db(self):
        self._swap("CONFIG", _FakeConfig(self.workspace_config()))
        sh = self.ws("/api/shell?workspace=w1")
        self.assertEqual(sh.status, 101)
        out = sh.read_until(b"SHELL db=shdb")
        pid = int(out.split(b"FAKE_PID=")[1].split()[0])
        self.pids.append(pid)
        sh.send(b"print(env.user)\n")
        sh.read_until(b"SHELL-OUT:print(env.user)")
        sh.close()
        self.assertTrue(wait_for(lambda: pid_gone(pid), "the odoo shell to be killed"))

    def test_shell_refusals(self):
        self._swap("CONFIG", _FakeConfig(self.workspace_config()))
        self.assertEqual(self.get("/api/shell?workspace=nope")[0], 404)
        self.assertEqual(self.get("/api/shell?cwd=/does/not/exist")[0], 400)
        self.assertEqual(self.get(f"/api/shell?cwd={self.tmp}")[0], 400)  # no WS key
        self.assertEqual(self.get("/api/shell", {"Origin": "http://evil.example"})[0], 403)


class CliTestEndpointTest(_HttpTestCase):
    def setUp(self):
        super().setUp()
        self._swap("CONFIG", _FakeConfig(self.workspace_config(), {"active_workspace": "w1"}))

    def test_passing_run_streams_its_log_and_exit_code(self):
        status, body = self.post("/api/cli/test", {"test_tags": "pass"})
        self.assertEqual(status, 200)
        self.assertIn("running tests (tags: pass)", body)
        self.assertIn("tests: 3 passed", body)
        self.assertIn("test run finished (exit 0)", body)
        self.assertIn(("CLI test passed (tags: pass)", ""), self.bus.events)

    def test_failing_run_reports_its_exit_code(self):
        status, body = self.post("/api/cli/test", {"test_tags": "fail"})
        self.assertEqual(status, 200)
        self.assertIn("test run finished (exit 1)", body)
        self.assertIn(("CLI test failed (exit 1) (tags: fail)", "error"), self.bus.events)

    def test_goo_test_tags_client_exits_with_the_run_result(self):
        self._swap("PORT", self.port)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(server.run_cli_test("pass"), 0)
            self.assertEqual(server.run_cli_test("fail"), 1)
        self.assertIn("tests: 3 passed", out.getvalue())

    def test_refusals(self):
        self.assertEqual(self.post("/api/cli/test", {})[0], 400)
        server.CONFIG = _FakeConfig(self.workspace_config(), {})  # no active workspace
        self.assertEqual(self.post("/api/cli/test", {"test_tags": "x"})[0], 409)


if __name__ == "__main__":
    unittest.main()
