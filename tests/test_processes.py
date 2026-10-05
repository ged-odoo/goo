"""Tests for backend/processes.py (port probes on real sockets, process-group
termination on real children, the WebSocket frame helpers over a socketpair, the
odoo-bin / docker command builders, _Entry defaults) and backend/events.py (the
EventBus as an SSE client sees it).

Run from the repo root: `python3 -m unittest discover`
"""

import contextlib
import io
import os
import shlex
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from backend import events, processes


class PortTests(unittest.TestCase):
    def test_free_port_is_bindable(self):
        port = processes.free_port()
        self.assertTrue(processes.port_is_free(port))
        with socket.socket() as s:
            s.bind(("127.0.0.1", port))

    def test_listening_port_is_busy_and_not_free(self):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            s.listen()
            port = s.getsockname()[1]
            self.assertTrue(processes.port_busy(port))
            self.assertFalse(processes.port_is_free(port))
        self.assertFalse(processes.port_busy(port))

    @unittest.skipUnless(shutil.which("lsof"), "needs lsof")
    def test_kill_port_kills_the_listener(self):
        port = processes.free_port()
        child = subprocess.Popen(
            [
                sys.executable,
                "-c",
                "import socket,time\n"
                f"s=socket.socket(); s.bind(('127.0.0.1',{port})); s.listen()\n"
                "print('ready', flush=True); time.sleep(30)",
            ],
            stdout=subprocess.PIPE,
            text=True,
        )
        self.addCleanup(child.kill)
        self.addCleanup(child.stdout.close)
        self.assertEqual(child.stdout.readline().strip(), "ready")
        processes.kill_port(port)
        self.assertEqual(child.wait(timeout=3), -9)
        self.assertFalse(processes.port_busy(port))

    def test_kill_port_on_idle_port_is_a_noop(self):
        with contextlib.redirect_stdout(io.StringIO()):
            processes.kill_port(processes.free_port())


def _spawn(code):
    """A child in its own process group (like goo's odoo servers), started once it
    prints 'ready' — so any signal handler it installs is in place."""
    child = subprocess.Popen(
        [sys.executable, "-c", code + "\nprint('ready', flush=True)\nimport time; time.sleep(30)"],
        stdout=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    assert child.stdout.readline().strip() == "ready"
    child.stdout.close()
    return child


class _FastWait(subprocess.Popen):
    """Caps each wait() so the SIGTERM → SIGTERM → SIGKILL ladder runs in a fraction
    of a second; the process and signals are all real."""

    def wait(self, timeout=None):
        return super().wait(timeout=min(timeout, 0.2) if timeout else timeout)


class TerminateTests(unittest.TestCase):
    def _gone(self, child):
        self.assertIsNotNone(child.poll())
        with self.assertRaises(ProcessLookupError):
            os.killpg(child.pid, 0)

    def test_none_is_safe(self):
        processes.terminate_process(None)

    def test_graceful_sigterm(self):
        child = _spawn("")
        processes.terminate_process(child)
        self.assertEqual(child.returncode, -15)
        self._gone(child)

    def test_escalates_to_sigkill_when_sigterm_is_ignored(self):
        child = _spawn("import signal; signal.signal(signal.SIGTERM, signal.SIG_IGN)")
        child.__class__ = _FastWait
        processes.terminate_process(child)
        self.assertEqual(child.returncode, -9)
        self._gone(child)

    def test_second_sigterm_stops_a_process_that_ignores_the_first(self):
        child = _spawn(
            "import signal, sys\n"
            "n = []\n"
            "def h(*a):\n"
            "    n.append(1)\n"
            "    if len(n) == 2: sys.exit(7)\n"
            "signal.signal(signal.SIGTERM, h)"
        )
        child.__class__ = _FastWait
        processes.terminate_process(child)
        self.assertEqual(child.returncode, 7)

    def test_kills_the_whole_group(self):
        # the child spawns a grandchild in the same group; both must go
        child = _spawn(
            "import subprocess, sys\n"
            "g = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])"
        )
        processes.terminate_process(child)
        self.assertIsNotNone(child.poll())
        # the orphaned grandchild may linger briefly as a zombie until init reaps it
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                os.killpg(child.pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.02)
        with self.assertRaises(ProcessLookupError):
            os.killpg(child.pid, 0)

    def test_already_exited_is_safe(self):
        child = _spawn("")
        child.kill()
        child.wait()
        processes.terminate_process(child)
        self.assertEqual(child.returncode, -9)


class EditorTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.dir = tmp.name
        self.addCleanup(tmp.cleanup)

    def test_validation(self):
        self.assertEqual(processes.open_in_editor("", self.dir), (False, "no editor configured"))
        self.assertEqual(processes.open_in_editor("code", []), (False, "no path"))
        missing = os.path.join(self.dir, "missing")
        self.assertEqual(
            processes.open_in_editor("code", missing), (False, f"not a directory: {missing}")
        )

    def test_quick_success(self):
        self.assertEqual(processes.open_in_editor("true", [self.dir, self.dir]), (True, None))

    def test_editor_receives_quoted_paths(self):
        spaced = os.path.join(self.dir, "a dir")
        os.mkdir(spaced)
        out = os.path.join(self.dir, "args")
        editor = f'{shlex.quote(sys.executable)} -c \'import sys; open(sys.argv[1], "w").write("|".join(sys.argv[2:]))\' {shlex.quote(out)}'
        self.assertEqual(processes.open_in_editor(editor, spaced), (True, None))
        with open(out) as f:
            self.assertEqual(f.read(), spaced)

    def test_missing_editor_reports_stderr(self):
        with contextlib.redirect_stdout(io.StringIO()):
            ok, err = processes.open_in_editor("goo-no-such-editor-xyz", self.dir)
        self.assertFalse(ok)
        self.assertIn("not found", err)

    def test_silent_failure_reports_exit_code(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(
                processes.open_in_editor("false", self.dir),
                (False, "editor exited with code 1"),
            )


class WebSocketTests(unittest.TestCase):
    def setUp(self):
        self.a, self.b = socket.socketpair()
        self.addCleanup(self.a.close)
        self.addCleanup(self.b.close)

    def _roundtrip(self, payload, opcode=2):
        # sendall of a large frame blocks until the peer reads, so send from a thread
        t = threading.Thread(target=processes._ws_send_frame, args=(self.a, payload, opcode))
        t.start()
        got = processes._ws_recv_frame(self.b)
        t.join()
        return got

    def test_accept_key_rfc6455_example(self):
        self.assertEqual(
            processes._ws_accept_key("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        )

    def test_roundtrip_small_medium_large(self):
        for n in (0, 125, 126, 65535, 65536, 70000):
            payload = bytes(i % 251 for i in range(n))
            self.assertEqual(self._roundtrip(payload), (2, payload), n)

    def test_header_uses_extended_lengths(self):
        for n, header in (
            (5, bytes([0x82, 5])),
            (300, bytes([0x82, 126]) + struct.pack(">H", 300)),
            (70000, bytes([0x82, 127]) + struct.pack(">Q", 70000)),
        ):
            t = threading.Thread(target=processes._ws_send_frame, args=(self.a, b"q" * n))
            t.start()
            raw = b""
            while len(raw) < len(header) + n:
                raw += self.b.recv(1 << 16)
            t.join()
            self.assertEqual(raw[: len(header)], header)

    def test_text_opcode_and_bytearray(self):
        self.assertEqual(self._roundtrip(bytearray(b"hi"), opcode=1), (1, b"hi"))

    def _client_frame(self, opcode, payload, mask=b"\x11\x22\x33\x44"):
        n = len(payload)
        if n < 126:
            header = bytes([0x80 | opcode, 0x80 | n])
        elif n < 65536:
            header = bytes([0x80 | opcode, 0x80 | 126]) + struct.pack(">H", n)
        else:
            header = bytes([0x80 | opcode, 0x80 | 127]) + struct.pack(">Q", n)
        masked = bytes(c ^ mask[i % 4] for i, c in enumerate(payload))
        return header + mask + masked

    def test_masked_client_frames(self):
        for n in (3, 200, 70000):
            payload = bytes(i % 256 for i in range(n))
            frame = self._client_frame(1, payload)
            t = threading.Thread(target=self.a.sendall, args=(frame,))
            t.start()
            self.assertEqual(processes._ws_recv_frame(self.b), (1, payload), n)
            t.join()

    def test_close_frame(self):
        self.a.sendall(self._client_frame(8, b""))
        self.assertEqual(processes._ws_recv_frame(self.b), (8, b""))

    def test_frame_split_across_sends(self):
        frame = self._client_frame(2, b"hello world")

        def dribble():
            for i in range(len(frame)):
                self.a.sendall(frame[i : i + 1])

        t = threading.Thread(target=dribble)
        t.start()
        self.assertEqual(processes._ws_recv_frame(self.b), (2, b"hello world"))
        t.join()

    def test_disconnect_raises(self):
        self.a.sendall(bytes([0x82, 10]) + b"short")
        self.a.close()
        with self.assertRaises(OSError):
            processes._ws_recv_frame(self.b)

    def test_disconnect_before_header_raises(self):
        self.a.close()
        with self.assertRaises(OSError):
            processes._ws_recv_frame(self.b)


def _config(**kw):
    cfg = {
        "repos": [
            {"id": "community", "path": "/src/odoo"},
            {"id": "enterprise", "path": "/src/enterprise"},
        ]
    }
    cfg.update(kw)
    return cfg


class OdooCmdTests(unittest.TestCase):
    def test_base_defaults(self):
        cmd, addons = processes._odoo_cmd_base(_config())
        self.assertEqual(cmd, "cd /src/odoo && /src/odoo/odoo-bin")
        self.assertEqual(addons, f"addons,../enterprise,{processes.ADDONS_DIR}")

    def test_base_subset_and_order(self):
        _, addons = processes._odoo_cmd_base(_config(), ["enterprise", "community"])
        self.assertEqual(addons, f"../enterprise,addons,{processes.ADDONS_DIR}")

    def test_base_custom_main_repo_and_tilde(self):
        cfg = {
            "main_repo_id": "odoo",
            "repos": [{"id": "odoo", "path": "~/odoo"}, "junk", {"id": "no-path"}],
        }
        cmd, addons = processes._odoo_cmd_base(cfg)
        home = os.path.expanduser("~")
        self.assertEqual(cmd, f"cd {home}/odoo && {home}/odoo/odoo-bin")
        self.assertEqual(addons, f"addons,{processes.ADDONS_DIR}")

    def test_base_venv_rust_env_and_server_path(self):
        cmd, _ = processes._odoo_cmd_base(
            _config(
                venv_activate="source /v/bin/activate",
                venv_python="/v/bin/python",
                rust_bundler=True,
                server_path="/other/odoo-bin",
            ),
            extra_env={"A": "x y", "B": "1"},
        )
        self.assertEqual(
            cmd,
            "source /v/bin/activate && cd /src/odoo && "
            "RUST_BUNDLER=1 A='x y' B=1 /v/bin/python /other/odoo-bin",
        )

    def test_base_errors(self):
        with self.assertRaisesRegex(ValueError, "no 'community' repo"):
            processes._odoo_cmd_base({"repos": []})
        with self.assertRaisesRegex(ValueError, "unknown repo 'design'"):
            processes._odoo_cmd_base(_config(), ["design"])
        with self.assertRaisesRegex(ValueError, "no repos selected"):
            processes._odoo_cmd_base(_config(), [])

    def test_shell_cmd(self):
        cmd = processes.build_shell_cmd(_config(db_user="u", db_password="p"), "mydb")
        self.assertEqual(
            cmd,
            "cd /src/odoo && /src/odoo/odoo-bin shell -d mydb --no-http --no-database-list"
            f" -r u -w p --addons-path addons,../enterprise,{processes.ADDONS_DIR}"
            " --log-level=warn",
        )

    def test_shell_cmd_default_credentials(self):
        cmd = processes.build_shell_cmd(_config(), "db")
        self.assertIn(" -r odoo -w odoo ", cmd)

    def test_shell_cmd_rejects_bad_db(self):
        for db in ("", "a;rm -rf /", "x y"):
            with self.assertRaisesRegex(ValueError, "invalid database name"):
                processes.build_shell_cmd(_config(), db)


def _docker_config(**kw):
    cfg = {
        "start": {"repos": ["community", "enterprise"]},
        "docker_worktree_dir": "/wt/feat",
    }
    cfg.update(kw)
    return cfg


class DockerCmdTests(unittest.TestCase):
    def test_run_prefix_defaults(self):
        run, mount, main, addons = processes._docker_run_prefix(_docker_config())
        self.assertEqual((mount, main), ("/src", "community"))
        self.assertEqual(addons, "addons,../enterprise,/goo-addons")
        self.assertEqual(
            run,
            "docker run --rm -it --network goo_odoo --workdir /src/community "
            f"-v /wt/feat:/src -v {processes.ADDONS_DIR}:/goo-addons:ro ",
        )

    def test_run_prefix_name_mount_network_filestore(self):
        run, mount, _, _ = processes._docker_run_prefix(
            _docker_config(
                docker_mount_path="/work/",
                docker_network="net",
                filestore="/fs store",
                docker_filestore_mount="/data",
            ),
            container="goo-feat",
        )
        self.assertEqual(mount, "/work")
        argv = shlex.split(run)
        self.assertEqual(argv[argv.index("--name") + 1], "goo-feat")
        self.assertEqual(argv[argv.index("--network") + 1], "net")
        self.assertEqual(argv[argv.index("--workdir") + 1], "/work/community")
        mounts = [argv[i + 1] for i, a in enumerate(argv) if a == "-v"]
        self.assertEqual(
            mounts, ["/wt/feat:/work", f"{processes.ADDONS_DIR}:/goo-addons:ro", "/fs store:/data"]
        )

    def test_run_prefix_default_filestore_mount(self):
        run, *_ = processes._docker_run_prefix(_docker_config(filestore="/fs"))
        self.assertIn("-v /fs:/home/odoo_user/.local/share/Odoo/filestore ", run)

    def test_run_prefix_errors(self):
        with self.assertRaisesRegex(ValueError, "no repos selected"):
            processes._docker_run_prefix(_docker_config(start={}))
        with self.assertRaisesRegex(ValueError, "must be one of start.repos"):
            processes._docker_run_prefix(_docker_config(start={"repos": ["enterprise"]}))
        with self.assertRaisesRegex(ValueError, "no worktree directory"):
            processes._docker_run_prefix(_docker_config(docker_worktree_dir=""))

    def test_run_prefix_refuses_repos_that_are_not_siblings_under_the_mount_dir(self):
        repos = [{"id": "community", "path": "/wt/feat/community"}]
        processes._docker_run_prefix(_docker_config(repos=repos))  # laid out as mounted
        with self.assertRaisesRegex(ValueError, "'enterprise' at /wt/feat/enterprise"):
            processes._docker_run_prefix(
                _docker_config(repos=[*repos, {"id": "enterprise", "path": "/elsewhere/ent"}])
            )

    def test_shell_cmd(self):
        cmd = processes.build_docker_shell_cmd(_docker_config(), "mydb", "odoo:17")
        argv = shlex.split(cmd)
        self.assertNotIn("--name", argv)  # never collides with the workspace's server
        self.assertIn("--rm", argv)
        i = argv.index("odoo:17")
        self.assertEqual(
            argv[i:],
            [
                "odoo:17",
                "python3",
                "/src/community/odoo-bin",
                "shell",
                "-d",
                "mydb",
                "-r",
                "odoo",
                "-w",
                "odoo",
                "--no-http",
                "--no-database-list",
                "--addons-path",
                "addons,../enterprise,/goo-addons",
                "--db_host",
                "goo-postgres",
                "--db_port",
                "5432",
                "--log-level=warn",
            ],
        )

    def test_shell_cmd_user_extra_args_and_pg(self):
        cmd = processes.build_docker_shell_cmd(
            _docker_config(
                docker_container_user="1000:1000",
                docker_extra_run_args="--add-host h:1.2.3.4",
                docker_postgres_container="pg",
                db_user="u",
                db_password="p",
            ),
            "db",
            "img",
        )
        argv = shlex.split(cmd)
        i = argv.index("img")
        self.assertEqual(argv[i - 4 : i], ["--user", "1000:1000", "--add-host", "h:1.2.3.4"])
        self.assertEqual(argv[argv.index("--db_host") + 1], "pg")
        self.assertEqual(argv[argv.index("-r") + 1], "u")
        self.assertEqual(argv[argv.index("-w") + 1], "p")

    def test_shell_cmd_rejects_bad_db(self):
        with self.assertRaisesRegex(ValueError, "invalid database name"):
            processes.build_docker_shell_cmd(_docker_config(), "x;y", "img")


class EntryTests(unittest.TestCase):
    def test_defaults(self):
        e = processes._Entry("w1")
        self.assertEqual((e.id, e.state, e.mode), ("w1", "stopped", "server"))
        for attr in ("process", "master_fd", "db", "port", "gport", "run", "returncode"):
            self.assertIsNone(getattr(e, attr), attr)
        self.assertFalse(e.exited_unexpectedly)
        self.assertEqual((list(e.log), e.raw_buf, e.ws_clients), ([], bytearray(), set()))

    def test_log_tail_is_bounded_and_per_entry(self):
        a, b = processes._Entry("a"), processes._Entry("b")
        for i in range(processes._Entry.LOG_TAIL + 10):
            a.log.append(str(i))
        self.assertEqual(len(a.log), processes._Entry.LOG_TAIL)
        self.assertEqual(a.log[0], "10")
        self.assertEqual(list(b.log), [])


class EventBusTests(unittest.TestCase):
    def setUp(self):
        self.bus = events.EventBus(maxlen=3)

    def drain(self, q):
        items = []
        while not q.empty():
            items.append(q.get_nowait())
        return items

    def test_new_subscriber_gets_main_log_backlog_only(self):
        self.bus.publish_log("one")
        self.bus.publish_log("side", server="w1")
        self.bus.publish_log("two")
        q, backlog = self.bus.subscribe()
        self.assertEqual(backlog, ["one", "two"])
        self.assertEqual(self.drain(q), [])  # backlog is not replayed into the queue

    def test_backlog_is_bounded(self):
        for i in range(5):
            self.bus.publish_log(str(i))
        _, backlog = self.bus.subscribe()
        self.assertEqual(backlog, ["2", "3", "4"])

    def test_live_log_lines_reach_every_subscriber(self):
        q1, _ = self.bus.subscribe()
        q2, _ = self.bus.subscribe()
        self.bus.publish_log("hi", server="w1")
        expected = [("log", {"server": "w1", "line": "hi"})]
        self.assertEqual(self.drain(q1), expected)
        self.assertEqual(self.drain(q2), expected)

    def test_typed_events(self):
        q, _ = self.bus.subscribe()
        self.bus.publish_server({"id": "main", "state": "running"})
        self.bus.publish_goo_update({"behind": 2})
        self.bus.publish_config({"rev": 1})
        self.bus.publish_run({"state": "done"})
        self.bus.publish_claude({"workspace": "w1", "role": "assistant"})
        self.assertEqual(
            self.drain(q),
            [
                ("server", {"id": "main", "state": "running"}),
                ("goo_update", {"behind": 2}),
                ("config", {"rev": 1}),
                ("run", {"state": "done"}),
                ("claude", {"workspace": "w1", "role": "assistant"}),
            ],
        )

    def test_publish_event_logs_and_broadcasts(self):
        q, _ = self.bus.subscribe()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.bus.publish_event("created db", level="error")
            self.bus.publish_event("pulling", event_id="e1", status="start")
        self.assertIn("• created db", out.getvalue())
        self.assertEqual(
            self.drain(q),
            [
                ("event", {"text": "created db", "level": "error"}),
                ("event", {"text": "pulling", "level": "", "id": "e1", "status": "start"}),
            ],
        )

    def test_unsubscribe_stops_delivery_and_is_idempotent(self):
        q, _ = self.bus.subscribe()
        other, _ = self.bus.subscribe()
        self.bus.unsubscribe(q)
        self.bus.unsubscribe(q)
        self.bus.publish_config({"rev": 2})
        self.assertEqual(self.drain(q), [])
        self.assertEqual(self.drain(other), [("config", {"rev": 2})])

    def test_no_line_lost_or_duplicated_across_subscribe(self):
        bus = events.EventBus(maxlen=100000)
        n = 20000

        def produce():
            for i in range(n):
                bus.publish_log(str(i))

        t = threading.Thread(target=produce)
        t.start()
        q, backlog = bus.subscribe()
        t.join()
        live = [p["line"] for _, p in self.drain(q)]
        self.assertEqual(backlog + live, [str(i) for i in range(n)])


if __name__ == "__main__":
    unittest.main()
