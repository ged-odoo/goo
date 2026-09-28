"""goo's HTTP layer end to end: the real `Server`/`Handler` on an ephemeral
localhost port, driven over `http.client` — static files, the POST route table
envelope, /api/config, the SSE stream, the websocket endpoints' refusals, and the
`goo --test-tags` CLI relay (against a fake odoo-bin script)."""

import contextlib
import http.client
import io
import json
import os
import shutil
import socket
import stat
import tempfile
import threading
import time
import unittest
from unittest import mock

from backend import effects, server, services


class _FakeDatabase:
    """A tiny in-memory stand-in for DatabaseService: a set of database names."""

    def __init__(self, names=(), error=None):
        self.names = set(names)
        self.error = error

    def databases(self, refresh=False):
        if self.error:
            raise RuntimeError(self.error)
        return [{"name": n} for n in sorted(self.names)]

    def drop(self, name, filestore=None):
        if name not in self.names:
            return False, f"database {name} does not exist"
        self.names.discard(name)
        return True, None

    def db_initialized(self, db):
        return db in self.names


def _alive(pid):
    """True while `pid` runs (a zombie — killed, not yet reaped — counts as gone)."""
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().rsplit(")", 1)[1].split()[0] != "Z"
    except OSError:
        return False


def closed_port():
    """A localhost port nothing listens on."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_server():
    """Start the real goo HTTP server on 127.0.0.1:<ephemeral>. Returns (httpd, thread)."""
    httpd = server.Server(("127.0.0.1", 0), server.Handler)
    thread = threading.Thread(target=httpd.serve_forever, args=(0.02,), daemon=True)
    thread.start()
    return httpd, thread


def stop_server(httpd, thread):
    httpd.shutdown()
    httpd.server_close()
    thread.join(timeout=5)


class ServerTestCase(unittest.TestCase):
    """Runs a real server per test, with CONFIG pointed at a temp file and the
    goo terminal output (stdout) silenced."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="goo-http-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.config_path = os.path.join(self.tmp, "config.json")
        self.config = services.ConfigStore(
            effects, self.config_path, notify=server.BUS.publish_config
        )
        stack.enter_context(mock.patch.object(server, "CONFIG", self.config))
        stack.enter_context(
            mock.patch.object(
                server, "REVIEW_PROMPT_PATH", os.path.join(self.tmp, "review_prompt.md")
            )
        )
        self.httpd, self.thread = start_server()
        self.addCleanup(stop_server, self.httpd, self.thread)
        self.port = self.httpd.server_address[1]

    def request(self, method, path, body=None, headers=None, raw=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            data = (
                raw
                if raw is not None
                else (json.dumps(body).encode() if body is not None else None)
            )
            hdrs = dict(headers or {})
            if data is not None:
                hdrs.setdefault("Content-Type", "application/json")
            conn.request(method, path, body=data, headers=hdrs)
            resp = conn.getresponse()
            return resp.status, resp, resp.read()
        finally:
            conn.close()

    def json_request(self, method, path, body=None, **kw):
        status, _resp, data = self.request(method, path, body, **kw)
        return status, json.loads(data)


class StaticFilesTest(ServerTestCase):
    def test_root_serves_index_html(self):
        status, resp, data = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertTrue(resp.getheader("Content-Type").startswith("text/html"))
        with open(os.path.join(server.STATIC_DIR, "index.html"), "rb") as f:
            self.assertEqual(data, f.read())
        self.assertEqual(resp.getheader("Cache-Control"), "no-cache")

    def test_js_file_is_served_with_a_javascript_content_type(self):
        status, resp, data = self.request("GET", "/static/dist/app.js?v=123")
        self.assertEqual(status, 200)
        self.assertIn("javascript", resp.getheader("Content-Type"))
        self.assertEqual(int(resp.getheader("Content-Length")), len(data))
        with open(os.path.join(server.STATIC_DIR, "dist", "app.js"), "rb") as f:
            self.assertEqual(data, f.read())

    def test_css_file_content_type(self):
        status, resp, _ = self.request("GET", "/static/style.css")
        self.assertEqual(status, 200)
        self.assertTrue(resp.getheader("Content-Type").startswith("text/css"))

    def test_missing_static_file_is_a_json_404(self):
        status, body = self.json_request("GET", "/static/does-not-exist.js")
        self.assertEqual((status, body), (404, {"ok": False, "error": "not_found"}))

    def test_static_directory_itself_is_not_served(self):
        for path in ("/static/", "/static/dist"):
            status, _ = self.json_request("GET", path)
            self.assertEqual(status, 404, path)

    def test_path_traversal_never_serves_files_outside_static(self):
        with open(os.path.join(server.GOO_DIR, "pyproject.toml"), "rb") as f:
            secret = f.read()
        for path in (
            "/../pyproject.toml",
            "/static/../pyproject.toml",
            "/static/../../pyproject.toml",
            "/static/dist/../../pyproject.toml",
            "/static/..%2fpyproject.toml",
            "/static/" + os.path.join(server.GOO_DIR, "pyproject.toml"),
            "/static//etc/passwd",
            "/static/../static_evil/x",
        ):
            status, _resp, data = self.request("GET", path)
            self.assertEqual(status, 404, path)
            self.assertNotEqual(data, secret, path)
            self.assertNotIn(b"root:", data, path)


class GetRoutesTest(ServerTestCase):
    def test_unknown_get_is_404(self):
        self.assertEqual(
            self.json_request("GET", "/api/nope"), (404, {"ok": False, "error": "not_found"})
        )

    def test_status_reports_the_idle_main_server(self):
        status, body = self.json_request("GET", "/api/status")
        self.assertEqual(status, 200)
        self.assertEqual(body["id"], "main")
        self.assertIn("odoo_port_busy", body)

    def test_goo_update_state_carries_the_boot_id(self):
        status, body = self.json_request("GET", "/api/goo/update")
        self.assertEqual(status, 200)
        self.assertEqual(body["boot"], server.BOOT_ID)
        self.assertIn("behind", body)

    def test_review_prompt_bootstraps_the_default_to_disk(self):
        status, body = self.json_request("GET", "/api/review-prompt")
        self.assertEqual(
            (status, body), (200, {"ok": True, "content": server.DEFAULT_REVIEW_PROMPT})
        )
        with open(server.REVIEW_PROMPT_PATH) as f:
            self.assertEqual(f.read(), server.DEFAULT_REVIEW_PROMPT)
        with open(server.REVIEW_PROMPT_PATH, "w") as f:
            f.write("custom prompt")
        self.assertEqual(
            self.json_request("GET", "/api/review-prompt")[1]["content"], "custom prompt"
        )

    def test_databases_lists_and_reports_errors(self):
        with mock.patch.object(server, "DATABASE", _FakeDatabase({"b", "a"})):
            status, body = self.json_request("GET", "/api/databases?refresh=1")
        self.assertEqual(status, 200)
        self.assertEqual([d["name"] for d in body["databases"]], ["a", "b"])
        with mock.patch.object(server, "DATABASE", _FakeDatabase(error="psql not found")):
            status, body = self.json_request("GET", "/api/databases")
        self.assertEqual((status, body), (500, {"ok": False, "error": "psql not found"}))


class PostRoutesTest(ServerTestCase):
    def test_unknown_route_is_404(self):
        self.assertEqual(
            self.json_request("POST", "/api/nope", {}), (404, {"ok": False, "error": "not_found"})
        )

    def test_missing_required_field_is_the_400_envelope(self):
        self.assertEqual(
            self.json_request("POST", "/api/event", {}),
            (400, {"ok": False, "error": "missing text"}),
        )
        # a custom `missing` message
        self.assertEqual(
            self.json_request("POST", "/api/databases/drop", {"name": ""}),
            (400, {"ok": False, "error": "missing database name"}),
        )
        # several required fields share one generated message
        self.assertEqual(
            self.json_request("POST", "/api/databases/clone", {"source": "a"}),
            (400, {"ok": False, "error": "missing source or dest"}),
        )

    def test_invalid_or_non_object_json_fails_the_required_checks(self):
        for raw in (b"{not json", b"[1, 2]", b""):
            status, _resp, data = self.request("POST", "/api/event", raw=raw)
            self.assertEqual(
                (status, json.loads(data)), (400, {"ok": False, "error": "missing text"}), raw
            )

    def test_event_is_echoed_on_the_goo_terminal(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            status, body = self.json_request("POST", "/api/event", {"text": "hello log"})
        self.assertEqual((status, body), (200, {"ok": True}))
        self.assertIn("hello log", out.getvalue())

    def test_route_success_and_error_through_a_swapped_singleton(self):
        db = _FakeDatabase({"keep", "gone"})
        with mock.patch.object(server, "DATABASE", db):
            self.assertEqual(
                self.json_request("POST", "/api/databases/drop", {"name": "gone"}),
                (200, {"ok": True}),
            )
            _, body = self.json_request("GET", "/api/databases")
            self.assertEqual([d["name"] for d in body["databases"]], ["keep"])
            # a (status, payload) tuple route reply
            status, body = self.json_request("POST", "/api/databases/drop", {"name": "gone"})
        self.assertEqual(status, 400)
        self.assertEqual(body, {"ok": False, "error": "database gone does not exist"})

    def test_cross_origin_post_is_refused(self):
        status, body = self.json_request(
            "POST", "/api/event", {"text": "x"}, headers={"Origin": "http://evil.example"}
        )
        self.assertEqual(
            (status, body), (403, {"ok": False, "error": "cross-origin request refused"})
        )
        # goo's own UI origin is allowed
        status, _ = self.json_request(
            "POST",
            "/api/event",
            {"text": "x"},
            headers={"Origin": f"http://127.0.0.1:{server.PORT}"},
        )
        self.assertEqual(status, 200)


class ConfigRoundTripTest(ServerTestCase):
    def test_fresh_config_is_rev_zero(self):
        self.assertEqual(
            self.json_request("GET", "/api/config"),
            (200, {"ok": True, "rev": 0, "config": None, "state": None}),
        )

    def test_save_bumps_rev_persists_and_rejects_a_stale_rev(self):
        status, body = self.json_request(
            "POST", "/api/config", {"rev": 0, "config": {"a": 1}, "state": {"s": True}}
        )
        self.assertEqual(
            (status, body), (200, {"ok": True, "rev": 1, "config": {"a": 1}, "state": {"s": True}})
        )
        with open(self.config_path) as f:
            self.assertEqual(json.load(f), {"rev": 1, "config": {"a": 1}, "state": {"s": True}})
        # state-only save keeps config
        status, body = self.json_request("POST", "/api/config", {"rev": 1, "state": {"s": False}})
        self.assertEqual((status, body["rev"], body["config"]), (200, 2, {"a": 1}))
        # stale rev: 409 with the current state so the client can reconcile; file untouched
        status, body = self.json_request("POST", "/api/config", {"rev": 1, "config": {"a": 99}})
        self.assertEqual(
            (status, body),
            (
                409,
                {
                    "ok": False,
                    "conflict": True,
                    "rev": 2,
                    "config": {"a": 1},
                    "state": {"s": False},
                },
            ),
        )
        self.assertEqual(
            self.json_request("GET", "/api/config")[1],
            {"ok": True, "rev": 2, "config": {"a": 1}, "state": {"s": False}},
        )

    def test_missing_rev_or_bad_json_is_400(self):
        for raw in (json.dumps({"config": {}}).encode(), b"{oops"):
            status, _resp, data = self.request("POST", "/api/config", raw=raw)
            self.assertEqual(
                (status, json.loads(data)), (400, {"ok": False, "error": "missing rev"})
            )

    def test_write_failure_is_500(self):
        blocker = os.path.join(self.tmp, "file")
        with open(blocker, "w") as f:
            f.write("x")
        self.config.path = os.path.join(blocker, "config.json")  # parent is a file
        status, body = self.json_request("POST", "/api/config", {"rev": 0, "config": {}})
        self.assertEqual(status, 500)
        self.assertFalse(body["ok"])
        self.assertTrue(body["error"])


class EventsStreamTest(ServerTestCase):
    def _open_stream(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        self.addCleanup(conn.close)
        conn.request("GET", "/api/events")
        resp = conn.getresponse()
        return conn, resp

    def _next_event(self, resp):
        """Read one `event:`/`data:` block off the stream (skipping pings)."""
        event, data = None, None
        while True:
            line = resp.readline().decode()
            if not line:
                raise AssertionError("stream closed")
            line = line.rstrip("\n")
            if line.startswith("event: "):
                event = line[len("event: ") :]
            elif line.startswith("data: "):
                data = json.loads(line[len("data: ") :])
            elif line == "" and event:
                return event, data

    def _wait(self, cond):
        deadline = time.monotonic() + 5
        while not cond():
            if time.monotonic() > deadline:
                raise AssertionError("timed out")
            time.sleep(0.01)

    def test_stream_primes_then_relays_live_events_and_unsubscribes_on_close(self):
        with server.BUS._lock:
            before = {id(q) for q in server.BUS._subscribers}
        conn, resp = self._open_stream()
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.getheader("Content-Type"), "text/event-stream")
        # priming: the main server snapshot first, then the config
        event, data = self._next_event(resp)
        self.assertEqual((event, data["id"]), ("server", "main"))
        while event != "config":
            event, data = self._next_event(resp)
        self.assertEqual(data, {"rev": 0, "config": None, "state": None})
        # drain any backlog log lines, then a live event arrives
        with server.BUS._lock:
            (mine,) = [q for q in server.BUS._subscribers if id(q) not in before]
        server.BUS.publish_goo_update({"marker": "live-1"})
        event, data = self._next_event(resp)
        while event == "log":
            event, data = self._next_event(resp)
        self.assertEqual((event, data), ("goo_update", {"marker": "live-1"}))
        # a config save is broadcast to the open stream too
        self.json_request("POST", "/api/config", {"rev": 0, "config": {"x": 1}})
        self.assertEqual(
            self._next_event(resp), ("config", {"rev": 1, "config": {"x": 1}, "state": None})
        )
        # the client goes away: the next writes fail and the handler unsubscribes
        resp.close()
        conn.close()

        def gone():
            server.BUS.publish_goo_update({"marker": "after-close"})
            with server.BUS._lock:
                return mine not in server.BUS._subscribers

        self._wait(gone)

    def test_backlog_log_lines_are_replayed_on_connect(self):
        server.BUS.publish_log("backlog line for sse test")
        _conn, resp = self._open_stream()
        lines = []
        event, data = self._next_event(resp)
        while event != "log" or data["line"] != "backlog line for sse test":
            lines.append(event)
            event, data = self._next_event(resp)
        self.assertEqual(data, {"server": "main", "line": "backlog line for sse test"})
        self.assertIn("config", lines)  # config is primed before the backlog


class EventsStreamRunPrimingTest(ServerTestCase):
    def test_runs_are_primed_on_connect(self):
        run = {"id": "run-1", "workspace": "w1", "state": "running"}
        with mock.patch.object(server.WORKSPACES, "run_snapshots", return_value=[run]):
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
            self.addCleanup(conn.close)
            conn.request("GET", "/api/events")
            resp = conn.getresponse()
            seen = []
            while "config" not in seen:
                line = resp.readline().decode().rstrip("\n")
                if line.startswith("event: "):
                    seen.append(line[len("event: ") :])
                elif line.startswith("data: ") and seen[-1] == "run":
                    self.assertEqual(json.loads(line[len("data: ") :]), run)
        self.assertEqual(seen, ["server", "run", "config"])


class MiscRoutesTest(ServerTestCase):
    def test_rust_bundler_status(self):
        self.config.save(0, config={"rust_bundler": True})

        class _Bundler:
            def status(self, config):
                return {"installed": False, "enabled": config.get("rust_bundler")}

        with mock.patch.object(server, "RUST_BUNDLER", _Bundler()):
            self.assertEqual(
                self.json_request("GET", "/api/rust-bundler"),
                (200, {"ok": True, "installed": False, "enabled": True}),
            )

    def test_restart_replies_before_re_exec(self):
        restarted = threading.Event()
        with mock.patch.object(server, "restart_goo", restarted.set):
            self.assertEqual(self.json_request("POST", "/api/goo/restart", {}), (200, {"ok": True}))
            self.assertFalse(restarted.is_set())  # the reply went out first
            self.assertTrue(restarted.wait(5))


class MainTest(ServerTestCase):
    """main()'s startup up to the bind: --config re-pointing, the PG* env seeding,
    the --test-tags client mode, and a busy port."""

    def setUp(self):
        super().setUp()
        for obj, attr in (
            (server.CI, "cache_path"),
            (server.DOCKER_INFRA, "nginx_conf_path"),
            (server.CLAUDE, "reviews_dir"),
            (server, "REVIEWS_DIR"),
        ):
            p = mock.patch.object(obj, attr, getattr(obj, attr))
            p.start()
            self.addCleanup(p.stop)
        env = mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        for k in ("PGUSER", "PGPASSWORD", "PGHOST", "PGPORT"):
            os.environ.pop(k, None)
        self.addCleanup(effects.set_trace, False)

    def _main(self, *argv, config=None, port=None):
        """Run main() against a temp --config; `port` defaults to a closed one so a
        goo actually running on the real port is never contacted."""
        path = os.path.join(self.tmp, "alt", "config.json")
        if config is not None:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                json.dump({"rev": 1, "config": config, "state": None}, f)
        self.config._cache = None
        err = io.StringIO()
        with (
            mock.patch("sys.argv", ["goo", "--config", path, *argv]),
            mock.patch.object(server, "PORT", port or closed_port()),
            contextlib.redirect_stderr(err),
        ):
            return server.main(), err.getvalue(), path

    def test_config_flag_repoints_every_sidecar_file(self):
        rc, err, path = self._main("--test-tags", "/web", config={})
        alt = os.path.dirname(path)
        self.assertEqual(rc, 2)  # nothing listens on the (closed) port
        self.assertEqual(server.CONFIG.path, path)
        self.assertEqual(server.CI.cache_path, os.path.join(alt, "ci_merge_stats.json"))
        self.assertEqual(
            server.DOCKER_INFRA.nginx_conf_path, os.path.join(alt, "docker", "nginx.conf")
        )
        self.assertEqual(server.REVIEW_PROMPT_PATH, os.path.join(alt, "review_prompt.md"))
        self.assertEqual(server.CLAUDE.reviews_dir, os.path.join(alt, "reviews"))

    def test_test_tags_mode_talks_to_the_running_server(self):
        rc, err, _ = self._main("--test-tags", "/web", "--trace", config={}, port=self.port)
        self.assertEqual(rc, 2)
        self.assertIn("no workspace yet", err)

    def test_pg_env_is_seeded_from_the_config(self):
        cfg = {"db_user": "u", "db_password": "pw", "db_host": "db.local", "db_port": 6543}
        self._main("--test-tags", "/web", config=cfg)
        self.assertEqual(
            {k: os.environ.get(k) for k in ("PGUSER", "PGPASSWORD", "PGHOST", "PGPORT")},
            {"PGUSER": "u", "PGPASSWORD": "pw", "PGHOST": "db.local", "PGPORT": "6543"},
        )

    def test_docker_mode_points_pg_at_goos_own_postgres(self):
        self._main("--test-tags", "/web", config={"launch_mode": "docker", "db_host": "ignored"})
        self.assertEqual((os.environ["PGHOST"], os.environ["PGPORT"]), ("127.0.0.1", "5433"))

    def test_busy_port_fails_to_bind(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc, _err, _ = self._main(config={}, port=self.port)
        self.assertEqual(rc, 1)
        self.assertIn(f"cannot bind 127.0.0.1:{self.port}", out.getvalue())


class WebsocketEndpointsTest(ServerTestCase):
    def test_cross_origin_upgrades_are_refused(self):
        for path in ("/api/terminal", "/api/shell?cwd=/tmp"):
            status, body = self.json_request("GET", path, headers={"Origin": "http://evil.example"})
            self.assertEqual(
                (status, body), (403, {"ok": False, "error": "cross-origin request refused"}), path
            )

    def test_unknown_workspace_is_404(self):
        for path in ("/api/terminal?workspace=nope", "/api/shell?workspace=nope"):
            status, body = self.json_request("GET", path)
            self.assertEqual(
                (status, body), (404, {"ok": False, "error": "unknown workspace"}), path
            )

    def test_terminal_without_websocket_key_is_400(self):
        status, body = self.json_request("GET", "/api/terminal")
        self.assertEqual((status, body), (400, {"ok": False, "error": "missing WS key"}))


class CliTestRelayTest(ServerTestCase):
    """POST /api/cli/test (and `run_cli_test`, the `goo --test-tags` client) against
    a fake odoo-bin script, so the whole stream-the-log-and-exit-code path runs."""

    def _configure(self, exit_code=0, script=None):
        community = os.path.join(self.tmp, "community")
        os.makedirs(community)
        odoo_bin = os.path.join(community, "fake-odoo-bin")
        with open(odoo_bin, "w") as f:
            f.write(
                script
                or f'#!/bin/sh\necho "fake odoo ran in $(pwd)"\necho "args: $*"\nexit {exit_code}\n'
            )
        os.chmod(odoo_bin, os.stat(odoo_bin).st_mode | stat.S_IXUSR)
        config = {
            "repos": [{"id": "community", "path": community}],
            "server_path": odoo_bin,
            "workspaces": [{"id": "w1", "db": "testdb", "checkouts": [{"repo": "community"}]}],
        }
        ok, _ = self.config.save(0, config=config, state={"active_workspace": "w1"})
        self.assertTrue(ok)
        self._enter(mock.patch.object(server, "DATABASE", _FakeDatabase({"testdb"})))
        return community

    def _enter(self, cm):  # (TestCase.enterContext is 3.11+ only)
        result = cm.__enter__()
        self.addCleanup(cm.__exit__, None, None, None)
        return result

    def test_missing_tags_is_400(self):
        for body in ({}, {"test_tags": "  "}):
            self.assertEqual(
                self.json_request("POST", "/api/cli/test", body),
                (400, {"ok": False, "error": "missing test_tags"}),
            )

    def test_no_active_workspace_is_409(self):
        status, body = self.json_request("POST", "/api/cli/test", {"test_tags": "/web"})
        self.assertEqual(status, 409)
        self.assertIn("no workspace yet", body["error"])

    def test_invalid_workspace_config_is_400(self):
        self.config.save(
            0,
            config={"repos": [], "workspaces": [{"id": "w1", "db": "d"}]},
            state={"active_workspace": "w1"},
        )
        status, body = self.json_request("POST", "/api/cli/test", {"test_tags": "/web"})
        self.assertEqual(
            (status, body), (400, {"ok": False, "error": "no 'community' repo defined in repos"})
        )

    def test_streams_the_run_log_and_exit_code(self):
        community = self._configure(exit_code=0)
        q, _ = server.BUS.subscribe()
        self.addCleanup(server.BUS.unsubscribe, q)
        status, resp, data = self.request("POST", "/api/cli/test", {"test_tags": "/web:Suite[x]"})
        text = data.decode()
        self.assertEqual(status, 200)
        self.assertTrue(resp.getheader("Content-Type").startswith("text/plain"))
        self.assertIn("running tests (tags: /web:Suite[x])", text)
        self.assertIn(f"fake odoo ran in {community}", text)
        self.assertIn("--test-tags /web:Suite[x]", text)  # quoted: no glob mangling
        self.assertIn("-d testdb", text)
        self.assertIn("test run finished (exit 0)", text)
        events = []
        while not q.empty():
            events.append(q.get_nowait())
        texts = [p["text"] for e, p in events if e == "event"]
        self.assertIn("CLI test run (tags: /web:Suite[x])", texts)
        self.assertIn("CLI test passed (tags: /web:Suite[x])", texts)

    def test_run_cli_test_client_returns_the_test_outcome(self):
        for code, expected in ((0, 0), (3, 1)):
            with self.subTest(exit_code=code):
                shutil.rmtree(os.path.join(self.tmp, "community"), ignore_errors=True)
                self.config._cache = None
                if os.path.exists(self.config_path):
                    os.remove(self.config_path)
                self._configure(exit_code=code)
                out = io.StringIO()
                with mock.patch.object(server, "PORT", self.port), contextlib.redirect_stdout(out):
                    rc = server.run_cli_test("/web")
                self.assertEqual(rc, expected)
                self.assertIn(f"test run finished (exit {code})", out.getvalue())

    def test_client_disconnect_kills_the_running_test(self):
        pidfile = os.path.join(self.tmp, "pid")
        self._configure(
            script=f"#!/bin/sh\necho $$ > {pidfile}\nwhile true; do echo tick; sleep 0.02; done\n"
        )
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("POST", "/api/cli/test", body=json.dumps({"test_tags": "/web"}))
        resp = conn.getresponse()
        self.assertIn(b"tick", resp.readline() + resp.readline())
        with open(pidfile) as f:
            pid = int(f.read())
        resp.close()
        conn.close()
        deadline = time.monotonic() + 5
        while _alive(pid):
            if time.monotonic() > deadline:
                os.kill(pid, 9)
                self.fail("the test process outlived its CLI client")
            time.sleep(0.02)

    def test_run_cli_test_client_reports_a_server_refusal(self):
        err = io.StringIO()
        with mock.patch.object(server, "PORT", self.port), contextlib.redirect_stderr(err):
            rc = server.run_cli_test("/web")
        self.assertEqual(rc, 2)
        self.assertIn("no workspace yet", err.getvalue())

    def test_run_cli_test_client_reports_an_unreachable_server(self):
        err = io.StringIO()
        with mock.patch.object(server, "PORT", closed_port()), contextlib.redirect_stderr(err):
            rc = server.run_cli_test("/web")
        self.assertEqual(rc, 2)
        self.assertIn("cannot reach goo", err.getvalue())


if __name__ == "__main__":
    unittest.main()
