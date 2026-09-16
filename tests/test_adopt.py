"""Unit tests for backend/adopt.py -- the worktree-adoption scan. adopt.py talks
directly to the filesystem (os.listdir/os.path.getmtime) and to the real CONFIG
singleton imported from server.py (not the effects seam), so these tests use real
tempdirs for the directory-scanning parts and mock CONFIG.get/CONFIG.save the same
way test_cleanup.py mocks cleanup's GIT/GITHUB/MERGEBOT module singletons.

Run from the repo root: `python3 -m unittest discover`
"""

import os
import subprocess
import tempfile
import unittest
import unittest.mock

from backend import adopt


def config_snapshot(rev=1, worktree_dir=None, repos=None, workspaces=None):
    return {
        "rev": rev,
        "config": {
            "worktree_dir": worktree_dir,
            "repos": repos or [{"id": "community", "path": "/main/community"}],
            "workspaces": workspaces or [],
        },
    }


def make_checkout(base_dir, repo_id="community", branch="17.0-feature-jpp"):
    """A fake worktree dir with one repo subdir that looks like a real git
    checkout on the branch `branch` (via a mocked subprocess.run, not a real repo)."""
    repo_dir = os.path.join(base_dir, repo_id)
    os.makedirs(os.path.join(repo_dir, ".git"))
    return repo_dir


def age(path, seconds_old):
    """Backdate a directory's mtime so the ADOPT_GRACE_SECONDS freshness guard
    doesn't skip it (or does, if seconds_old < ADOPT_GRACE_SECONDS)."""
    t = os.path.getatime(path) - seconds_old
    os.utime(path, (t, t))


class CurrentBranchTest(unittest.TestCase):
    def test_no_git_dir_returns_none(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(adopt._current_branch(d))

    def test_returns_branch_name(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, ".git"))
            with unittest.mock.patch.object(
                adopt.subprocess,
                "run",
                return_value=subprocess.CompletedProcess(
                    args=[], returncode=0, stdout="17.0-feature-jpp\n", stderr=""
                ),
            ):
                self.assertEqual(adopt._current_branch(d), "17.0-feature-jpp")

    def test_git_failure_returns_none(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, ".git"))
            with unittest.mock.patch.object(
                adopt.subprocess,
                "run",
                return_value=subprocess.CompletedProcess(
                    args=[], returncode=128, stdout="", stderr="fatal"
                ),
            ):
                self.assertIsNone(adopt._current_branch(d))

    def test_timeout_returns_none(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, ".git"))
            with unittest.mock.patch.object(
                adopt.subprocess,
                "run",
                side_effect=subprocess.TimeoutExpired(cmd="git", timeout=10),
            ):
                self.assertIsNone(adopt._current_branch(d))

    def test_detached_head_empty_output_returns_none(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, ".git"))
            with unittest.mock.patch.object(
                adopt.subprocess,
                "run",
                return_value=subprocess.CompletedProcess(
                    args=[], returncode=0, stdout="\n", stderr=""
                ),
            ):
                self.assertIsNone(adopt._current_branch(d))


class ScanAndRegisterTest(unittest.TestCase):
    def _run_scan(self, snapshot, current_branch="17.0-feature-jpp"):
        """Patch CONFIG.get/save and _current_branch, run scan_and_register, and
        return the list of adopted workspaces from the CONFIG.save call (or None
        if save was never called)."""
        with (
            unittest.mock.patch.object(adopt.CONFIG, "get", return_value=snapshot),
            unittest.mock.patch.object(adopt.CONFIG, "save") as save,
            unittest.mock.patch.object(adopt, "_current_branch", return_value=current_branch),
        ):
            save.return_value = (True, {"rev": snapshot["rev"] + 1})
            adopt.scan_and_register()
            if not save.called:
                return None
            _, kwargs = save.call_args
            return kwargs["config"]["workspaces"]

    def test_no_worktree_dir_configured_does_nothing(self):
        snapshot = config_snapshot(worktree_dir=None)
        with (
            unittest.mock.patch.object(adopt.CONFIG, "get", return_value=snapshot),
            unittest.mock.patch.object(adopt.CONFIG, "save") as save,
        ):
            adopt.scan_and_register()
        save.assert_not_called()

    def test_worktree_dir_not_a_directory_does_nothing(self):
        snapshot = config_snapshot(worktree_dir="/does/not/exist/at/all")
        with (
            unittest.mock.patch.object(adopt.CONFIG, "get", return_value=snapshot),
            unittest.mock.patch.object(adopt.CONFIG, "save") as save,
        ):
            adopt.scan_and_register()
        save.assert_not_called()

    def test_no_repos_configured_does_nothing(self):
        with tempfile.TemporaryDirectory() as wtdir:
            os.makedirs(os.path.join(wtdir, "somefeature"))
            snapshot = config_snapshot(worktree_dir=wtdir, repos=[])
            with (
                unittest.mock.patch.object(adopt.CONFIG, "get", return_value=snapshot),
                unittest.mock.patch.object(adopt.CONFIG, "save") as save,
            ):
                adopt.scan_and_register()
            save.assert_not_called()

    def test_adopts_a_genuine_orphan(self):
        with tempfile.TemporaryDirectory() as wtdir:
            ws_dir = os.path.join(wtdir, "myfeature")
            make_checkout(ws_dir)
            age(ws_dir, adopt.ADOPT_GRACE_SECONDS + 60)
            snapshot = config_snapshot(worktree_dir=wtdir)
            adopted = self._run_scan(snapshot)
        self.assertIsNotNone(adopted)
        self.assertEqual(len(adopted), 1)
        w = adopted[0]
        self.assertEqual(w["id"], "myfeature")
        self.assertEqual(w["worktree"]["dir"], ws_dir)
        self.assertEqual(w["db"], "17.0-feature-jpp")
        self.assertEqual(w["checkouts"], [{"repo": "community", "branch": "17.0-feature-jpp"}])

    def test_directory_matching_an_existing_id_is_not_re_adopted(self):
        with tempfile.TemporaryDirectory() as wtdir:
            ws_dir = os.path.join(wtdir, "myfeature")
            make_checkout(ws_dir)
            age(ws_dir, adopt.ADOPT_GRACE_SECONDS + 60)
            snapshot = config_snapshot(
                worktree_dir=wtdir,
                workspaces=[{"id": "myfeature", "worktree": {"dir": ws_dir}}],
            )
            adopted = self._run_scan(snapshot)
        self.assertIsNone(adopted)

    def test_directory_matching_an_existing_dir_by_path_not_name_is_not_re_adopted(self):
        """Regression test for the bug documented in adopt.py's scan_and_register:
        a workspace's id (e.g. "wt-abc123") deliberately does not match its
        directory name (worktreeSlug prefers the human-readable name). Comparing
        `name in existing_ids` alone treated every fresh worktree as unknown and
        adopted a live duplicate of it moments after goo's own creation flow made
        it. The fix compares the actual worktree.dir path instead -- this must
        catch the duplicate even though the workspace's id ("wt-abc123") doesn't
        match the directory name ("myfeature") at all."""
        with tempfile.TemporaryDirectory() as wtdir:
            ws_dir = os.path.join(wtdir, "myfeature")
            make_checkout(ws_dir)
            age(ws_dir, adopt.ADOPT_GRACE_SECONDS + 60)
            snapshot = config_snapshot(
                worktree_dir=wtdir,
                # id does NOT match the directory name "myfeature" -- only the
                # worktree.dir path does
                workspaces=[{"id": "wt-abc123", "worktree": {"dir": ws_dir}}],
            )
            adopted = self._run_scan(snapshot)
        self.assertIsNone(adopted, "path-based dedup must catch this even though the id differs")

    def test_a_repos_own_main_checkout_dir_is_never_adopted(self):
        with tempfile.TemporaryDirectory() as wtdir:
            main_parent = os.path.join(wtdir, "master")
            main_path = os.path.join(main_parent, "community")
            os.makedirs(os.path.join(main_path, ".git"))
            age(main_parent, adopt.ADOPT_GRACE_SECONDS + 60)
            snapshot = config_snapshot(
                worktree_dir=wtdir,
                repos=[{"id": "community", "path": main_path}],
            )
            adopted = self._run_scan(snapshot)
        self.assertIsNone(adopted)

    def test_directory_younger_than_grace_period_is_skipped(self):
        with tempfile.TemporaryDirectory() as wtdir:
            ws_dir = os.path.join(wtdir, "myfeature")
            make_checkout(ws_dir)
            # freshly created -- default mtime is "now", well under the grace period
            snapshot = config_snapshot(worktree_dir=wtdir)
            adopted = self._run_scan(snapshot)
        self.assertIsNone(adopted)

    def test_directory_with_no_recognizable_checkout_is_skipped(self):
        with tempfile.TemporaryDirectory() as wtdir:
            ws_dir = os.path.join(wtdir, "randomjunk")
            os.makedirs(ws_dir)  # no repo subdirs with a .git inside
            age(ws_dir, adopt.ADOPT_GRACE_SECONDS + 60)
            snapshot = config_snapshot(worktree_dir=wtdir)
            adopted = self._run_scan(snapshot, current_branch=None)
        self.assertIsNone(adopted)

    def test_save_retries_on_conflict_then_succeeds(self):
        with tempfile.TemporaryDirectory() as wtdir:
            ws_dir = os.path.join(wtdir, "myfeature")
            make_checkout(ws_dir)
            age(ws_dir, adopt.ADOPT_GRACE_SECONDS + 60)
            snapshot = config_snapshot(rev=1, worktree_dir=wtdir)
            conflict_config = snapshot["config"]
            with (
                unittest.mock.patch.object(adopt.CONFIG, "get", return_value=snapshot),
                unittest.mock.patch.object(adopt.CONFIG, "save") as save,
                unittest.mock.patch.object(
                    adopt, "_current_branch", return_value="17.0-feature-jpp"
                ),
            ):
                save.side_effect = [
                    (False, {"conflict": True, "rev": 2, "config": conflict_config}),
                    (True, {"rev": 3}),
                ]
                adopt.scan_and_register()
            self.assertEqual(save.call_count, 2)
            first_rev = save.call_args_list[0].args[0]
            second_rev = save.call_args_list[1].args[0]
            self.assertEqual(first_rev, 1)
            self.assertEqual(second_rev, 2)  # retried with the fresher rev from the conflict

    def test_save_gives_up_after_three_conflicts(self):
        with tempfile.TemporaryDirectory() as wtdir:
            ws_dir = os.path.join(wtdir, "myfeature")
            make_checkout(ws_dir)
            age(ws_dir, adopt.ADOPT_GRACE_SECONDS + 60)
            snapshot = config_snapshot(rev=1, worktree_dir=wtdir)
            with (
                unittest.mock.patch.object(adopt.CONFIG, "get", return_value=snapshot),
                unittest.mock.patch.object(adopt.CONFIG, "save") as save,
                unittest.mock.patch.object(
                    adopt, "_current_branch", return_value="17.0-feature-jpp"
                ),
            ):
                save.return_value = (
                    False,
                    {"conflict": True, "rev": 1, "config": snapshot["config"]},
                )
                adopt.scan_and_register()  # must not raise
            self.assertEqual(save.call_count, 3)

    def test_save_write_failure_does_not_raise(self):
        with tempfile.TemporaryDirectory() as wtdir:
            ws_dir = os.path.join(wtdir, "myfeature")
            make_checkout(ws_dir)
            age(ws_dir, adopt.ADOPT_GRACE_SECONDS + 60)
            snapshot = config_snapshot(worktree_dir=wtdir)
            with (
                unittest.mock.patch.object(adopt.CONFIG, "get", return_value=snapshot),
                unittest.mock.patch.object(
                    adopt.CONFIG, "save", return_value=(False, {"error": "disk full"})
                ),
                unittest.mock.patch.object(
                    adopt, "_current_branch", return_value="17.0-feature-jpp"
                ),
            ):
                adopt.scan_and_register()  # must not raise


class LoopTest(unittest.TestCase):
    def test_loop_runs_scan_and_sleeps(self):
        class StopLoop(Exception):
            pass

        with (
            unittest.mock.patch.object(adopt, "scan_and_register") as scan,
            unittest.mock.patch.object(adopt.time, "sleep", side_effect=StopLoop) as sleep,
        ):
            with self.assertRaises(StopLoop):
                adopt.loop()
        scan.assert_called_once()
        sleep.assert_called_once_with(adopt.SCAN_INTERVAL)

    def test_loop_survives_a_failed_scan(self):
        class StopLoop(Exception):
            pass

        with (
            unittest.mock.patch.object(
                adopt, "scan_and_register", side_effect=RuntimeError("boom")
            ),
            unittest.mock.patch.object(adopt.time, "sleep", side_effect=StopLoop),
        ):
            with self.assertRaises(StopLoop):
                adopt.loop()  # the scan's exception must be swallowed, not propagated


if __name__ == "__main__":
    unittest.main()
