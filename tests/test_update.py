"""goo's self-update against real git repos: a bare "remote", an "upstream"
clone that publishes new commits, and a "goo" clone standing in for GOO_DIR.
Covers the probes in backend/update.py and server.py's check_goo_update /
goo_update_loop / the /api/goo/* routes."""

import contextlib
import io
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

from backend import server, services, update
from tests.test_http import ServerTestCase

_ENV = {
    **os.environ,
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@t",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@t",
}


def git(cwd, *args):
    return subprocess.run(
        ["git", "-C", cwd, *args], env=_ENV, check=True, capture_output=True, text=True
    ).stdout.strip()


def commit(repo, name, content="x"):
    with open(os.path.join(repo, name), "w") as f:
        f.write(content)
    git(repo, "add", name)
    git(repo, "commit", "-q", "-m", f"add {name}")


class GitReposMixin:
    """Temp remote/upstream/goo repos; GOO_DIR (as update.py reads it) -> goo."""

    def make_repos(self):
        self.root = tempfile.mkdtemp(prefix="goo-update-")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.remote = os.path.join(self.root, "remote.git")
        self.upstream = os.path.join(self.root, "upstream")
        self.goo = os.path.join(self.root, "goo")
        subprocess.run(
            ["git", "init", "-q", "--bare", "-b", "master", self.remote], env=_ENV, check=True
        )
        subprocess.run(["git", "init", "-q", "-b", "master", self.upstream], env=_ENV, check=True)
        git(self.upstream, "remote", "add", "origin", self.remote)
        commit(self.upstream, "README")
        git(self.upstream, "push", "-q", "origin", "master")
        subprocess.run(["git", "clone", "-q", self.remote, self.goo], env=_ENV, check=True)
        self.point_goo_at(self.goo)

    def point_goo_at(self, path):
        patcher = mock.patch.object(update, "GOO_DIR", path)
        patcher.start()
        self.addCleanup(patcher.stop)

    def publish_upstream(self, *names):
        for n in names:
            commit(self.upstream, n)
        git(self.upstream, "push", "-q", "origin", "master")

    def head(self, repo=None):
        return git(repo or self.goo, "rev-parse", "HEAD")


class GooUpdateStatusTest(GitReposMixin, unittest.TestCase):
    def setUp(self):
        self.make_repos()

    def test_not_a_git_repo(self):
        plain = os.path.join(self.root, "plain")
        os.makedirs(plain)
        self.point_goo_at(plain)
        status = update.goo_update_status()
        self.assertEqual(
            status,
            {
                "checked": True,
                "is_repo": False,
                "branch": "",
                "behind": 0,
                "ahead": 0,
                "dirty": False,
                "can_fast_forward": False,
            },
        )
        self.assertEqual(update.goo_fast_forward(), (False, "nothing to fast-forward"))

    def test_git_missing_or_timing_out_reads_as_not_a_repo(self):
        for exc in (FileNotFoundError("git"), subprocess.TimeoutExpired("git", 10)):
            with (
                self.subTest(exc=type(exc).__name__),
                mock.patch.object(update, "run", side_effect=exc),
            ):
                self.assertIsNone(update._git_goo("status"))
                self.assertFalse(update.goo_update_status()["is_repo"])

    def test_repo_without_origin_master(self):
        lone = os.path.join(self.root, "lone")
        subprocess.run(["git", "init", "-q", "-b", "dev", lone], env=_ENV, check=True)
        commit(lone, "a")
        self.point_goo_at(lone)
        status = update.goo_update_status()
        self.assertTrue(status["is_repo"])
        self.assertEqual(status["branch"], "dev")
        self.assertEqual((status["behind"], status["can_fast_forward"]), (0, False))

    def test_up_to_date(self):
        status = update.goo_update_status()
        self.assertEqual(
            (
                status["is_repo"],
                status["branch"],
                status["behind"],
                status["ahead"],
                status["dirty"],
            ),
            (True, "master", 0, 0, False),
        )
        self.assertFalse(status["can_fast_forward"])
        before = self.head()
        self.assertEqual(update.goo_fast_forward(), (False, "nothing to fast-forward"))
        self.assertEqual(self.head(), before)

    def test_behind_by_n_fast_forwards_onto_origin_master(self):
        self.publish_upstream("b", "c")
        git(self.goo, "fetch", "-q", "origin", "master")
        status = update.goo_update_status()
        self.assertEqual((status["behind"], status["ahead"]), (2, 0))
        self.assertTrue(status["can_fast_forward"])
        self.assertEqual(update.goo_fast_forward(), (True, None))
        self.assertEqual(self.head(), self.head(self.upstream))
        self.assertTrue(os.path.exists(os.path.join(self.goo, "c")))
        self.assertEqual(update.goo_update_status()["behind"], 0)

    def test_local_commits_on_top_block_the_fast_forward(self):
        self.publish_upstream("b")
        git(self.goo, "fetch", "-q", "origin", "master")
        commit(self.goo, "mine")
        before = self.head()
        status = update.goo_update_status()
        self.assertEqual(
            (status["behind"], status["ahead"], status["can_fast_forward"]), (1, 1, False)
        )
        self.assertEqual(
            update.goo_fast_forward(),
            (False, "local commits on top of master — update manually (git pull --rebase)"),
        )
        self.assertEqual(self.head(), before)

    def test_dirty_tree_blocks_the_fast_forward(self):
        self.publish_upstream("b")
        git(self.goo, "fetch", "-q", "origin", "master")
        with open(os.path.join(self.goo, "README"), "w") as f:
            f.write("local edit")
        before = self.head()
        status = update.goo_update_status()
        self.assertEqual(
            (status["behind"], status["dirty"], status["can_fast_forward"]), (1, True, False)
        )
        self.assertEqual(
            update.goo_fast_forward(), (False, "the working tree is dirty — commit or stash first")
        )
        self.assertEqual(self.head(), before)
        with open(os.path.join(self.goo, "README")) as f:
            self.assertEqual(f.read(), "local edit")

    def test_a_failing_merge_reports_gits_error(self):
        self.publish_upstream("b")
        git(self.goo, "fetch", "-q", "origin", "master")
        before = self.head()
        # a stale index.lock makes the merge itself fail after the status check passed
        with open(os.path.join(self.goo, ".git", "index.lock"), "w"):
            pass
        ok, error = update.goo_fast_forward()
        self.assertFalse(ok)
        self.assertIn("lock", error)  # git's last stderr line
        self.assertEqual(self.head(), before)

    def test_merge_timing_out_is_reported(self):
        self.publish_upstream("b")
        git(self.goo, "fetch", "-q", "origin", "master")
        real_run = update.run

        def run(cmd, **kw):
            if "merge" in cmd:
                raise subprocess.TimeoutExpired(cmd, 30)
            return real_run(cmd, **kw)

        with mock.patch.object(update, "run", side_effect=run):
            self.assertEqual(update.goo_fast_forward(), (False, "git not available or timed out"))


class CheckGooUpdateTest(GitReposMixin, unittest.TestCase):
    """check_goo_update fetches, records server.GOO_UPDATE and announces new
    commits on the bus."""

    def setUp(self):
        self.make_repos()
        patcher = mock.patch.object(server, "GOO_UPDATE", dict(server.GOO_UPDATE, behind=0))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.q, _ = server.BUS.subscribe()
        self.addCleanup(server.BUS.unsubscribe, self.q)
        out = contextlib.redirect_stdout(io.StringIO())
        out.__enter__()
        self.addCleanup(out.__exit__, None, None, None)

    def drain(self):
        items = []
        while not self.q.empty():
            items.append(self.q.get_nowait())
        return items

    def test_not_a_repo_or_no_origin_is_silent(self):
        plain = os.path.join(self.root, "plain")
        os.makedirs(plain)
        self.point_goo_at(plain)
        self.assertFalse(server.check_goo_update())
        git(self.goo, "remote", "remove", "origin")
        self.point_goo_at(self.goo)
        self.assertFalse(server.check_goo_update())
        self.assertEqual(self.drain(), [])

    def test_unreachable_origin_is_silent(self):
        git(self.goo, "remote", "set-url", "origin", os.path.join(self.root, "missing.git"))
        self.assertFalse(server.check_goo_update())
        self.assertEqual(self.drain(), [])
        self.assertEqual(server.GOO_UPDATE["behind"], 0)

    def test_fetches_and_announces_new_commits_once(self):
        self.publish_upstream("b", "c")
        self.assertTrue(server.check_goo_update())
        self.assertEqual(
            (server.GOO_UPDATE["behind"], server.GOO_UPDATE["can_fast_forward"]), (2, True)
        )
        events = self.drain()
        updates = [p for e, p in events if e == "goo_update"]
        self.assertEqual(len(updates), 1)
        self.assertEqual((updates[0]["behind"], updates[0]["boot"]), (2, server.BOOT_ID))
        self.assertIn(
            "goo update available — 2 commits behind origin/master",
            [p["text"] for e, p in events if e == "event"],
        )
        # unchanged on the next hourly check: no re-announcement
        self.assertTrue(server.check_goo_update())
        self.assertEqual(self.drain(), [])

    def test_announcement_mentions_local_commits_ahead(self):
        commit(self.goo, "mine")
        self.publish_upstream("b")
        self.assertTrue(server.check_goo_update())
        texts = [p["text"] for e, p in self.drain() if e == "event"]
        self.assertEqual(
            texts, ["goo update available — 1 commit behind origin/master, 1 local commit ahead"]
        )

    def test_update_loop_honors_the_update_check_setting(self):
        self.publish_upstream("b")

        class _Stop(Exception):
            pass

        fake_time = mock.Mock()
        fake_time.sleep.side_effect = _Stop
        for enabled, behind in ((False, 0), (True, 1)):
            with self.subTest(update_check=enabled):
                store = services.ConfigStore(_Io(), "")
                store._cache = {"rev": 1, "config": {"update_check": enabled}, "state": None}
                with (
                    mock.patch.object(server, "CONFIG", store),
                    mock.patch.object(server, "time", fake_time),
                    self.assertRaises(_Stop),
                ):
                    server.goo_update_loop()
                self.assertEqual(server.GOO_UPDATE["behind"], behind)
                fake_time.sleep.assert_called_with(3600)


class _Io:
    """ConfigStore IO that is never touched (the cache is pre-seeded)."""

    def read_json_file(self, path):
        raise AssertionError("unexpected read")


class GooUpdateRoutesTest(GitReposMixin, ServerTestCase):
    def setUp(self):
        super().setUp()
        self.make_repos()
        patcher = mock.patch.object(server, "GOO_UPDATE", dict(server.GOO_UPDATE, behind=0))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_check_then_update_moves_head_and_clears_the_badge(self):
        self.publish_upstream("b")
        status, body = self.json_request("POST", "/api/goo/check", {})
        self.assertEqual(status, 200)
        self.assertEqual((body["ok"], body["behind"], body["boot"]), (True, 1, server.BOOT_ID))
        self.assertEqual(self.json_request("GET", "/api/goo/update")[1]["behind"], 1)
        self.assertEqual(
            self.json_request("POST", "/api/goo/update", {}), (200, {"ok": True, "error": None})
        )
        self.assertEqual(self.head(), self.head(self.upstream))
        self.assertEqual(self.json_request("GET", "/api/goo/update")[1]["behind"], 0)

    def test_update_refused_with_local_commits(self):
        commit(self.goo, "mine")
        self.publish_upstream("b")
        self.json_request("POST", "/api/goo/check", {})
        before = self.head()
        status, body = self.json_request("POST", "/api/goo/update", {})
        self.assertEqual(status, 400)
        self.assertIn("local commits on top of master", body["error"])
        self.assertEqual(self.head(), before)


if __name__ == "__main__":
    unittest.main()
