"""Tests for backend/effects.py — the IO seam, exercised for real: a temp dir for the
filesystem helpers, real subprocesses for run(), and a local http.server on
127.0.0.1 for the HTTP helpers.

Run from the repo root: `python3 -m unittest discover`
"""

import contextlib
import gzip
import http.server
import io
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock
import zipfile

from backend import effects

BIG = b"x" * (2 * (1 << 20) + 123)  # > 2 read chunks, so progress fires several times


class _Handler(http.server.BaseHTTPRequestHandler):
    def _send(self, status, body=b"", headers=()):
        self.send_response(status)
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        if self.path == "/ok":
            self._send(200, "héllo".encode(), [("Content-Length", "6")])
        elif self.path == "/redirect":
            self._send(302, b"moved", [("Location", "/ok"), ("Content-Length", "5")])
        elif self.path == "/big":
            self._send(200, BIG, [("Content-Length", str(len(BIG)))])
        elif self.path == "/nolength":
            self._send(200, b"abc")  # HTTP/1.0: body ends at connection close
        elif self.path == "/truncated":
            # promises more than it sends, then closes the connection
            self._send(200, b"y" * 1000, [("Content-Length", "5000")])
        elif self.path == "/stall":
            self.send_response(200)
            self.send_header("Content-Length", "5000")
            self.end_headers()
            self.wfile.write(b"z" * 100)
            self.wfile.flush()
            time.sleep(1.0)
        else:
            self._send(404, b"nope", [("Content-Length", "4")])

    do_HEAD = do_GET

    def log_message(self, *args):
        pass


def _closed_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        cls.server.daemon_threads = True
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        quiet = contextlib.redirect_stdout(io.StringIO())
        self.out = quiet.__enter__()
        self.addCleanup(quiet.__exit__, None, None, None)
        tmp = tempfile.TemporaryDirectory()
        self.dir = tmp.name
        self.addCleanup(tmp.cleanup)

    def test_get_returns_decoded_body(self):
        self.assertEqual(effects.http_get(f"{self.base}/ok"), ("héllo", None))
        self.assertIn(f"GET {self.base}/ok", self.out.getvalue())  # the request is logged

    def test_get_404_is_an_error_not_a_raise(self):
        text, err = effects.http_get(f"{self.base}/missing")
        self.assertEqual(text, "")
        self.assertIn("404", err)

    def test_get_unreachable(self):
        text, err = effects.http_get(f"http://127.0.0.1:{_closed_port()}/", timeout=2)
        self.assertEqual(text, "")
        self.assertTrue(err)

    def test_get_follows_redirects(self):
        self.assertEqual(effects.http_get(f"{self.base}/redirect"), ("héllo", None))

    def test_nofollow_returns_the_redirect_itself(self):
        status, location, text, err = effects.http_get_nofollow(f"{self.base}/redirect")
        self.assertEqual((status, location, text, err), (302, "/ok", "moved", None))

    def test_nofollow_plain_200(self):
        self.assertEqual(effects.http_get_nofollow(f"{self.base}/ok"), (200, "", "héllo", None))

    def test_nofollow_404_is_returned_as_status(self):
        status, location, text, err = effects.http_get_nofollow(f"{self.base}/missing")
        self.assertEqual((status, text, err), (404, "nope", None))

    def test_nofollow_unreachable(self):
        status, location, text, err = effects.http_get_nofollow(
            f"http://127.0.0.1:{_closed_port()}/", timeout=2
        )
        self.assertEqual((status, location, text), (0, "", ""))
        self.assertTrue(err)

    def test_head_reports_size(self):
        self.assertEqual(effects.http_head(f"{self.base}/big"), (200, len(BIG), None))

    def test_head_without_content_length_is_size_zero(self):
        self.assertEqual(effects.http_head(f"{self.base}/nolength"), (200, 0, None))

    def test_head_404_is_an_answer(self):
        status, size, err = effects.http_head(f"{self.base}/missing")
        self.assertEqual((status, size), (404, 0))
        self.assertTrue(err)

    def test_head_unreachable(self):
        status, size, err = effects.http_head(f"http://127.0.0.1:{_closed_port()}/", timeout=2)
        self.assertEqual((status, size), (0, 0))
        self.assertTrue(err)

    def test_download_writes_file_and_reports_progress(self):
        path = os.path.join(self.dir, "dump.zip")
        calls = []
        ok, err = effects.http_download(
            f"{self.base}/big", path, on_progress=lambda d, t: calls.append((d, t))
        )
        self.assertEqual((ok, err), (True, None))
        with open(path, "rb") as f:
            self.assertEqual(f.read(), BIG)
        self.assertGreaterEqual(len(calls), 3)
        self.assertEqual(calls[-1], (len(BIG), len(BIG)))
        self.assertEqual([t for _, t in calls], [len(BIG)] * len(calls))
        done = [d for d, _ in calls]
        self.assertEqual(done, sorted(done))

    def test_download_unknown_total_is_zero(self):
        path = os.path.join(self.dir, "f")
        calls = []
        ok, _ = effects.http_download(
            f"{self.base}/nolength", path, on_progress=lambda d, t: calls.append((d, t))
        )
        self.assertTrue(ok)
        self.assertEqual(calls[-1], (3, 0))

    def test_download_404_leaves_no_file(self):
        path = os.path.join(self.dir, "f")
        ok, err = effects.http_download(f"{self.base}/missing", path)
        self.assertFalse(ok)
        self.assertIn("404", err)
        self.assertFalse(os.path.exists(path))

    def test_download_stall_times_out_and_removes_partial_file(self):
        path = os.path.join(self.dir, "f")
        ok, err = effects.http_download(f"{self.base}/stall", path, timeout=0.3)
        self.assertFalse(ok)
        self.assertTrue(err)
        self.assertFalse(os.path.exists(path))

    def test_download_truncated_body_is_a_failure(self):
        path = os.path.join(self.dir, "f")
        ok, _ = effects.http_download(f"{self.base}/truncated", path)
        self.assertFalse(ok)
        self.assertFalse(os.path.exists(path))

    def test_download_into_missing_dir_fails(self):
        ok, err = effects.http_download(f"{self.base}/ok", os.path.join(self.dir, "no", "f"))
        self.assertFalse(ok)
        self.assertTrue(err)


class RunTests(unittest.TestCase):
    def setUp(self):
        quiet = contextlib.redirect_stdout(io.StringIO())
        self.out = quiet.__enter__()
        self.addCleanup(quiet.__exit__, None, None, None)

    def test_success_captures_stdout(self):
        r = effects.run([sys.executable, "-c", "print('hi')"])
        self.assertEqual((r.returncode, r.stdout), (0, "hi\n"))
        self.assertEqual(self.out.getvalue(), "")

    def test_failure_is_logged_with_stderr(self):
        r = effects.run([sys.executable, "-c", "import sys; sys.exit('boom')"])
        self.assertEqual(r.returncode, 1)
        self.assertEqual(r.stderr.strip(), "boom")
        log = self.out.getvalue()
        self.assertIn(f"$ {sys.executable} -c", log)
        self.assertIn("boom", log)

    def test_failure_falls_back_to_stdout_in_log(self):
        effects.run([sys.executable, "-c", "print('out-msg'); raise SystemExit(3)"])
        self.assertIn("out-msg", self.out.getvalue())

    def test_quiet_failure_is_not_logged(self):
        r = effects.run([sys.executable, "-c", "raise SystemExit(2)"], quiet=True)
        self.assertEqual(r.returncode, 2)
        self.assertEqual(self.out.getvalue(), "")

    def test_shell_string(self):
        r = effects.run("echo a && echo b", shell=True)
        self.assertEqual(r.stdout, "a\nb\n")

    def test_explicit_stdout_is_respected(self):
        with tempfile.TemporaryFile("w+") as f:
            r = effects.run([sys.executable, "-c", "print('to-file')"], stdout=f)
            self.assertIsNone(r.stdout)
            f.seek(0)
            self.assertEqual(f.read(), "to-file\n")

    def test_missing_binary_raises(self):
        with self.assertRaises(FileNotFoundError):
            effects.run(["goo-no-such-binary-xyz"])

    def test_trace_logs_when_enabled(self):
        effects.set_trace(True)
        self.addCleanup(effects.set_trace, False)
        effects.run([sys.executable, "-c", "pass"])
        self.assertIn("trace run:", self.out.getvalue())

    def test_trace_silent_by_default(self):
        effects.trace("run", "x")
        self.assertEqual(self.out.getvalue(), "")

    def test_log_writes_line(self):
        effects.log("hello")
        self.assertEqual(self.out.getvalue(), "hello\n")


class FilesystemTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.dir = tmp.name
        self.addCleanup(tmp.cleanup)

    def p(self, *parts):
        return os.path.join(self.dir, *parts)

    def test_gunzip_inflates_into_the_target_file(self):
        with gzip.open(self.p("dump.sql.gz"), "wb") as f:
            f.write(BIG)
        ok, err = effects.gunzip(self.p("dump.sql.gz"), self.p("out", "dump.sql"))
        self.assertTrue(ok, err)
        with open(self.p("out", "dump.sql"), "rb") as f:
            self.assertEqual(f.read(), BIG)

    def test_gunzip_of_a_non_gzip_file_fails_and_leaves_nothing(self):
        effects.write_text(self.p("dump.sql.gz"), "plain text")
        ok, err = effects.gunzip(self.p("dump.sql.gz"), self.p("dump.sql"))
        self.assertFalse(ok)
        self.assertTrue(err)
        self.assertFalse(os.path.exists(self.p("dump.sql")))

    def test_save_stream_copies_exactly_length_bytes(self):
        ok, err = effects.save_stream(io.BytesIO(BIG + b"trailing"), len(BIG), self.p("up"))
        self.assertTrue(ok, err)
        with open(self.p("up"), "rb") as f:
            self.assertEqual(f.read(), BIG)

    def test_save_stream_short_body_is_an_error(self):
        ok, err = effects.save_stream(io.BytesIO(b"abc"), 10, self.p("up"))
        self.assertFalse(ok)
        self.assertIn("truncated", err)

    def test_is_dir_is_file(self):
        effects.write_text(self.p("f"), "x")
        self.assertTrue(effects.is_dir(self.dir))
        self.assertFalse(effects.is_dir(self.p("f")))
        self.assertTrue(effects.is_file(self.p("f")))
        self.assertFalse(effects.is_file(self.dir))
        self.assertFalse(effects.is_file(self.p("missing")))

    def test_list_dir_sorted_and_missing_is_empty(self):
        for name in ("b", "a", "c"):
            effects.write_text(self.p(name), "")
        self.assertEqual(effects.list_dir(self.dir), ["a", "b", "c"])
        self.assertEqual(effects.list_dir(self.p("missing")), [])

    def test_read_text_roundtrip_and_missing(self):
        self.assertEqual(
            effects.write_text(self.p("sub", "deep", "f.txt"), "héllo\n"), (True, None)
        )
        self.assertEqual(effects.read_text(self.p("sub", "deep", "f.txt")), "héllo\n")
        self.assertIsNone(effects.read_text(self.p("missing")))

    def test_expands_user(self):
        with unittest.mock.patch.dict(os.environ, {"HOME": self.dir}):
            effects.write_text("~/home.txt", "h")
        self.assertEqual(effects.read_text(self.p("home.txt")), "h")

    def test_mtime(self):
        effects.write_text(self.p("f"), "x")
        os.utime(self.p("f"), (1000, 1000))
        self.assertEqual(effects.mtime(self.p("f")), 1000)
        self.assertIsNone(effects.mtime(self.p("missing")))

    def test_write_text_replaces_atomically_leaving_no_temp(self):
        effects.write_text(self.p("f"), "old")
        self.assertEqual(effects.write_text(self.p("f"), "new"), (True, None))
        self.assertEqual(effects.read_text(self.p("f")), "new")
        self.assertEqual(os.listdir(self.dir), ["f"])

    def test_write_text_failure_leaves_no_temp(self):
        os.mkdir(self.p("target"))  # os.replace onto a directory fails
        ok, err = effects.write_text(self.p("target"), "x")
        self.assertFalse(ok)
        self.assertTrue(err)
        self.assertEqual(os.listdir(self.dir), ["target"])
        self.assertEqual(os.listdir(self.p("target")), [])

    def test_write_text_parent_is_a_file(self):
        effects.write_text(self.p("f"), "x")
        ok, err = effects.write_text(self.p("f", "child"), "y")
        self.assertFalse(ok)
        self.assertTrue(err)

    def test_json_roundtrip(self):
        data = {"rev": 3, "config": {"repos": [{"id": "community"}]}, "s": "é"}
        self.assertEqual(effects.write_json_file(self.p("c", "config.json"), data), (True, None))
        self.assertEqual(effects.read_json_file(self.p("c", "config.json")), (data, None))
        self.assertEqual(os.listdir(self.p("c")), ["config.json"])

    def test_read_json_missing_is_not_an_error(self):
        self.assertEqual(effects.read_json_file(self.p("missing.json")), (None, None))

    def test_read_json_corrupt_is_an_error(self):
        effects.write_text(self.p("bad.json"), "{not json")
        data, err = effects.read_json_file(self.p("bad.json"))
        self.assertIsNone(data)
        self.assertTrue(err)

    def test_read_json_unreadable_is_an_error(self):
        os.mkdir(self.p("dir.json"))
        data, err = effects.read_json_file(self.p("dir.json"))
        self.assertIsNone(data)
        self.assertTrue(err)

    def test_write_json_unserializable_never_tears_the_file(self):
        effects.write_json_file(self.p("config.json"), {"keep": True})
        with contextlib.suppress(TypeError):
            effects.write_json_file(self.p("config.json"), {"bad": object()})
        self.assertEqual(effects.read_json_file(self.p("config.json")), ({"keep": True}, None))
        self.assertEqual(os.listdir(self.dir), ["config.json"])

    def test_write_json_failure_leaves_no_temp(self):
        os.mkdir(self.p("target.json"))
        ok, err = effects.write_json_file(self.p("target.json"), {})
        self.assertFalse(ok)
        self.assertTrue(err)
        self.assertEqual(os.listdir(self.dir), ["target.json"])

    def test_write_json_parent_is_a_file(self):
        effects.write_text(self.p("f"), "x")
        ok, _ = effects.write_json_file(self.p("f", "c.json"), {})
        self.assertFalse(ok)

    def test_make_dirs_and_remove_tree(self):
        self.assertEqual(effects.make_dirs(self.p("a", "b")), (True, None))
        self.assertEqual(effects.make_dirs(self.p("a", "b")), (True, None))  # idempotent
        effects.write_text(self.p("a", "b", "f"), "x")
        self.assertEqual(effects.remove_tree(self.p("a")), (True, None))
        self.assertFalse(os.path.exists(self.p("a")))
        self.assertEqual(effects.remove_tree(self.p("a")), (True, None))  # missing is ok

    def test_make_dirs_under_a_file_fails(self):
        effects.write_text(self.p("f"), "x")
        ok, err = effects.make_dirs(self.p("f", "sub"))
        self.assertFalse(ok)
        self.assertTrue(err)

    def test_remove_tree_on_a_file_fails(self):
        effects.write_text(self.p("f"), "x")
        ok, err = effects.remove_tree(self.p("f"))
        self.assertFalse(ok)
        self.assertTrue(err)
        self.assertTrue(os.path.exists(self.p("f")))

    def test_move_path(self):
        effects.write_text(self.p("src", "f"), "x")
        self.assertEqual(effects.move_path(self.p("src"), self.p("dst")), (True, None))
        self.assertFalse(os.path.exists(self.p("src")))
        self.assertEqual(effects.read_text(self.p("dst", "f")), "x")

    def test_move_missing_fails(self):
        ok, err = effects.move_path(self.p("missing"), self.p("dst"))
        self.assertFalse(ok)
        self.assertTrue(err)

    def test_copy_tree(self):
        effects.write_text(self.p("src", "sub", "f"), "x")
        self.assertEqual(effects.copy_tree(self.p("src"), self.p("dst")), (True, None))
        self.assertEqual(effects.read_text(self.p("src", "sub", "f")), "x")
        self.assertEqual(effects.read_text(self.p("dst", "sub", "f")), "x")

    def test_copy_tree_onto_existing_fails(self):
        effects.make_dirs(self.p("src"))
        effects.make_dirs(self.p("dst"))
        ok, err = effects.copy_tree(self.p("src"), self.p("dst"))
        self.assertFalse(ok)
        self.assertTrue(err)

    def test_make_temp_dir(self):
        path = effects.make_temp_dir(prefix="goo-test-")
        self.addCleanup(effects.remove_tree, path)
        self.assertTrue(os.path.isdir(path))
        self.assertTrue(os.path.basename(path).startswith("goo-test-"))

    def test_make_temp_dir_failure_is_none(self):
        old = tempfile.tempdir
        tempfile.tempdir = self.p("missing")
        self.addCleanup(setattr, tempfile, "tempdir", old)
        self.assertIsNone(effects.make_temp_dir())

    def _zip(self, members):
        path = self.p("a.zip")
        with zipfile.ZipFile(path, "w") as zf:
            for name, data in members.items():
                zf.writestr(zipfile.ZipInfo(name), data)
        return path

    def test_unzip_extracts(self):
        z = self._zip({"dump.sql": "SELECT 1;", "filestore/ab/cd": "bin"})
        self.assertEqual(effects.unzip(z, self.p("out")), (True, None))
        self.assertEqual(effects.read_text(self.p("out", "dump.sql")), "SELECT 1;")
        self.assertEqual(effects.read_text(self.p("out", "filestore", "ab", "cd")), "bin")

    def test_unzip_skips_members_escaping_dest(self):
        z = self._zip(
            {
                "ok.txt": "fine",
                "../evil": "pwned",
                "sub/../../evil2": "pwned",
                os.path.join(self.dir, "abs-evil"): "pwned",
            }
        )
        dest = self.p("x", "out")
        self.assertEqual(effects.unzip(z, dest), (True, None))
        self.assertEqual(effects.read_text(os.path.join(dest, "ok.txt")), "fine")
        self.assertFalse(os.path.exists(self.p("x", "evil")))
        self.assertFalse(os.path.exists(self.p("evil2")))
        self.assertFalse(os.path.exists(self.p("x", "evil2")))
        self.assertFalse(os.path.exists(self.p("abs-evil")))
        # nothing landed anywhere but the destination
        found = {
            os.path.relpath(os.path.join(r, f), self.dir)
            for r, _, fs in os.walk(self.dir)
            for f in fs
        }
        self.assertEqual(found, {"a.zip", os.path.join("x", "out", "ok.txt")})

    def test_unzip_bad_archive(self):
        effects.write_text(self.p("bad.zip"), "not a zip")
        ok, err = effects.unzip(self.p("bad.zip"), self.p("out"))
        self.assertFalse(ok)
        self.assertTrue(err)

    def test_unzip_missing_archive(self):
        ok, err = effects.unzip(self.p("missing.zip"), self.p("out"))
        self.assertFalse(ok)
        self.assertTrue(err)


if __name__ == "__main__":
    unittest.main()
