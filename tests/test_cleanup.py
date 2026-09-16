"""Unit tests for backend/cleanup.py's merge/safety gating — _merge_gate and
_safety_guard are pure-ish functions (their only IO is through the GIT/GITHUB/
MERGEBOT module singletons), so they're exercised directly against mocks
rather than through the full run() loop.

Run from the repo root: `python3 -m unittest discover`
"""

import subprocess
import unittest
import unittest.mock

from backend import cleanup

REPO_MAP = {"community": {"github": "odoo/odoo", "pull_remote": "origin"}}
TWO_REPO_MAP = {
    "community": {"github": "odoo/odoo", "pull_remote": "origin"},
    "enterprise": {"github": "odoo/enterprise", "pull_remote": "origin"},
}


def ws(branch="17.0-feature-jpp"):
    return {
        "id": "w1",
        "name": "feature",
        "worktree": {"dir": "/wt/feature"},
        "checkouts": [{"repo": "community", "branch": branch}],
    }


def ws_two_repos(branch="17.0-feature-jpp"):
    return {
        "id": "w1",
        "name": "feature",
        "worktree": {"dir": "/wt/feature"},
        "checkouts": [
            {"repo": "community", "branch": branch},
            {"repo": "enterprise", "branch": branch},
        ],
    }


class MergeGateTest(unittest.TestCase):
    def test_no_pr_yet_is_wip(self):
        with (
            unittest.mock.patch.object(cleanup.GITHUB, "prs_for_branches", return_value=[]),
            unittest.mock.patch.object(cleanup.MERGEBOT, "statuses", return_value=({}, {}, {}, [])),
        ):
            ok, reason = cleanup._merge_gate(ws(), REPO_MAP)
        self.assertFalse(ok)
        self.assertIn("WIP", reason)

    def test_github_state_merged_when_mergebot_has_no_opinion(self):
        # a repo mergebot doesn't track: fall back to GitHub's own PR state
        pr = {"github": "odoo/odoo", "branch": "17.0-feature-jpp", "number": 42, "state": "merged"}
        with (
            unittest.mock.patch.object(cleanup.GITHUB, "prs_for_branches", return_value=[pr]),
            unittest.mock.patch.object(cleanup.MERGEBOT, "statuses", return_value=({}, {}, {}, [])),
        ):
            ok, reason = cleanup._merge_gate(ws(), REPO_MAP)
        self.assertTrue(ok)

    def test_github_closed_but_mergebot_merged_is_still_merged(self):
        # the actual bug this test guards against: mergebot integrates a PR by
        # its own rebase/squash and then just closes it via the API, so GitHub
        # reports "closed" for a PR that mergebot has genuinely merged -- that
        # must NOT block cleanup
        pr = {"github": "odoo/odoo", "branch": "17.0-feature-jpp", "number": 42, "state": "closed"}
        with (
            unittest.mock.patch.object(cleanup.GITHUB, "prs_for_branches", return_value=[pr]),
            unittest.mock.patch.object(
                cleanup.MERGEBOT, "statuses", return_value=({"odoo/odoo#42": "merged"}, {}, {}, [])
            ),
        ):
            ok, reason = cleanup._merge_gate(ws(), REPO_MAP)
        self.assertTrue(ok)

    def test_github_closed_and_mergebot_says_closed_is_not_merged(self):
        # closed WITHOUT being merged, and NOT empty (real changes lost) —
        # must still block
        pr = {"github": "odoo/odoo", "branch": "17.0-feature-jpp", "number": 42, "state": "closed"}
        with (
            unittest.mock.patch.object(cleanup.GITHUB, "prs_for_branches", return_value=[pr]),
            unittest.mock.patch.object(
                cleanup.MERGEBOT, "statuses", return_value=({"odoo/odoo#42": "closed"}, {}, {}, [])
            ),
            unittest.mock.patch.object(cleanup, "_pr_is_empty", return_value=False),
        ):
            ok, reason = cleanup._merge_gate(ws(), REPO_MAP)
        self.assertFalse(ok)
        self.assertIn("closed", reason)

    def test_closed_but_empty_pr_does_not_block(self):
        # Odoo's multi-repo bundle workflow opens a PR per touched repo even
        # when a repo ends up needing no changes -- that PR gets closed empty
        # rather than merged, and must not block cleanup: there's no code in
        # it a "merged" state would otherwise be protecting
        pr = {"github": "odoo/odoo", "branch": "17.0-feature-jpp", "number": 7, "state": "closed"}
        with (
            unittest.mock.patch.object(cleanup.GITHUB, "prs_for_branches", return_value=[pr]),
            unittest.mock.patch.object(
                cleanup.MERGEBOT, "statuses", return_value=({"odoo/odoo#7": "closed"}, {}, {}, [])
            ),
            unittest.mock.patch.object(cleanup, "_pr_is_empty", return_value=True),
        ):
            ok, reason = cleanup._merge_gate(ws(), REPO_MAP)
        # the only checkout's PR is empty and ignored -- nothing left to
        # block on, so this workspace IS cleanup-eligible
        self.assertTrue(ok)

    def test_no_repo_github_info(self):
        ok, reason = cleanup._merge_gate(ws(), {})
        self.assertFalse(ok)
        self.assertIn("no repo/github info", reason)

    def test_real_merge_plus_empty_sibling_pr_is_eligible(self):
        # the actual reported case: community's PR genuinely merged
        # (mergebot squash, GitHub shows "closed"), enterprise's PR closed
        # empty (0 changed files, nothing needed there) -- must be eligible
        community_pr = {
            "github": "odoo/odoo", "branch": "master-x-jpp", "number": 241056, "state": "closed",
        }
        enterprise_pr = {
            "github": "odoo/enterprise", "branch": "master-x-jpp", "number": 102796, "state": "closed",
        }
        mb_states = {"odoo/odoo#241056": "merged", "odoo/enterprise#102796": "closed"}
        with (
            unittest.mock.patch.object(
                cleanup.GITHUB, "prs_for_branches", return_value=[community_pr, enterprise_pr]
            ),
            unittest.mock.patch.object(cleanup.MERGEBOT, "statuses", return_value=(mb_states, {}, {}, [])),
            unittest.mock.patch.object(cleanup, "_pr_is_empty", side_effect=lambda gh, n: gh == "odoo/enterprise"),
        ):
            ok, reason = cleanup._merge_gate(ws_two_repos("master-x-jpp"), TWO_REPO_MAP)
        self.assertTrue(ok)


class PrIsEmptyTest(unittest.TestCase):
    def test_empty_pr(self):
        with unittest.mock.patch.object(
            cleanup.effects,
            "run",
            return_value=unittest.mock.Mock(returncode=0, stdout='{"changedFiles": 0}'),
        ):
            self.assertTrue(cleanup._pr_is_empty("odoo/enterprise", 7))

    def test_non_empty_pr(self):
        with unittest.mock.patch.object(
            cleanup.effects,
            "run",
            return_value=unittest.mock.Mock(returncode=0, stdout='{"changedFiles": 3}'),
        ):
            self.assertFalse(cleanup._pr_is_empty("odoo/odoo", 42))

    def test_gh_failure_stays_conservative(self):
        with unittest.mock.patch.object(
            cleanup.effects, "run", return_value=unittest.mock.Mock(returncode=1, stdout="")
        ):
            self.assertFalse(cleanup._pr_is_empty("odoo/odoo", 42))


class SafetyGuardTest(unittest.TestCase):
    def test_dirty_blocks(self):
        entry = {"id": "community", "dirty": True, "head_pushed": True, "error": None}
        with unittest.mock.patch.object(cleanup.GIT, "branches", return_value=[entry]):
            reason = cleanup._safety_guard(ws(), REPO_MAP)
        self.assertIn("uncommitted", reason)

    def test_error_blocks(self):
        entry = {"id": "community", "dirty": False, "head_pushed": True, "error": "boom"}
        with unittest.mock.patch.object(cleanup.GIT, "branches", return_value=[entry]):
            reason = cleanup._safety_guard(ws(), REPO_MAP)
        self.assertIn("boom", reason)

    def test_unpushed_head_no_longer_blocks(self):
        # the actual bug: after a mergebot squash-merge, the local branch's
        # commits are never reachable from any remote ref (different commit
        # objects), so head_pushed is permanently False post-merge -- must not
        # block cleanup once _merge_gate already confirmed the PR is merged
        entry = {"id": "community", "dirty": False, "head_pushed": False, "error": None}
        with unittest.mock.patch.object(cleanup.GIT, "branches", return_value=[entry]):
            reason = cleanup._safety_guard(ws(), REPO_MAP)
        self.assertIsNone(reason)


class NotifyTest(unittest.TestCase):
    def test_calls_notify_send(self):
        with unittest.mock.patch.object(cleanup.subprocess, "run") as run:
            cleanup._notify("deleted 1: feature")
        run.assert_called_once_with(["notify-send", "goo cleanup", "deleted 1: feature"], timeout=5)

    def test_missing_notify_send_is_swallowed(self):
        with unittest.mock.patch.object(cleanup.subprocess, "run", side_effect=FileNotFoundError):
            cleanup._notify("deleted 1: feature")  # must not raise

    def test_timeout_is_swallowed(self):
        with unittest.mock.patch.object(
            cleanup.subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired(cmd="notify-send", timeout=5),
        ):
            cleanup._notify("deleted 1: feature")  # must not raise


DELETE_REPO_MAP = {"community": {"path": "/main/community"}}


def delete_ws(db="feature_db"):
    return {
        "id": "w1",
        "name": "feature",
        "worktree": {"dir": "/wt/feature"},
        "checkouts": [{"repo": "community", "branch": "17.0-feature-jpp"}],
        "db": db,
    }


class DeleteTest(unittest.TestCase):
    def test_dry_run_touches_nothing(self):
        with (
            unittest.mock.patch.object(cleanup.GIT, "worktree_remove") as worktree_remove,
            unittest.mock.patch.object(cleanup.GIT, "delete_branch") as delete_branch,
            unittest.mock.patch.object(cleanup.subprocess, "run") as run,
            unittest.mock.patch.object(cleanup.effects, "remove_tree") as remove_tree,
            unittest.mock.patch.object(cleanup.CLAUDE, "forget") as forget,
        ):
            cleanup._delete(delete_ws(), DELETE_REPO_MAP, {"filestore": "/fs"}, dry_run=True)
        worktree_remove.assert_not_called()
        delete_branch.assert_not_called()
        run.assert_not_called()
        remove_tree.assert_not_called()
        forget.assert_not_called()

    def test_live_run_with_db_and_filestore_removes_everything(self):
        with (
            unittest.mock.patch.object(
                cleanup.GIT, "worktree_remove", return_value=(True, None)
            ) as worktree_remove,
            unittest.mock.patch.object(
                cleanup.GIT, "delete_branch", return_value=(True, None, None)
            ) as delete_branch,
            unittest.mock.patch.object(
                cleanup.subprocess, "run", return_value=unittest.mock.Mock(returncode=0, stderr="")
            ) as run,
            unittest.mock.patch.object(cleanup.effects, "remove_tree") as remove_tree,
            unittest.mock.patch.object(cleanup.CLAUDE, "forget") as forget,
        ):
            cleanup._delete(
                delete_ws(), DELETE_REPO_MAP, {"filestore": "/fs", "db_user": "odoo"}, dry_run=False
            )
        worktree_remove.assert_called_once_with(
            "/main/community", "/wt/feature/community", repo="community"
        )
        delete_branch.assert_called_once_with(
            "/main/community", "17.0-feature-jpp", delete_remote=False
        )
        run.assert_called_once_with(
            ["dropdb", "-U", "odoo", "--if-exists", "feature_db"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        # both the per-db filestore folder and the worktree dir get removed
        remove_tree.assert_has_calls(
            [unittest.mock.call("/fs/feature_db"), unittest.mock.call("/wt/feature")]
        )
        forget.assert_called_once_with("w1")

    def test_no_db_skips_dropdb_and_filestore_but_still_removes_worktree(self):
        with (
            unittest.mock.patch.object(cleanup.GIT, "worktree_remove", return_value=(True, None)),
            unittest.mock.patch.object(
                cleanup.GIT, "delete_branch", return_value=(True, None, None)
            ),
            unittest.mock.patch.object(cleanup.subprocess, "run") as run,
            unittest.mock.patch.object(cleanup.effects, "remove_tree") as remove_tree,
            unittest.mock.patch.object(cleanup.CLAUDE, "forget"),
        ):
            cleanup._delete(
                delete_ws(db=None), DELETE_REPO_MAP, {"filestore": "/fs"}, dry_run=False
            )
        run.assert_not_called()
        remove_tree.assert_called_once_with("/wt/feature")

    def test_no_filestore_configured_skips_filestore_removal(self):
        with (
            unittest.mock.patch.object(cleanup.GIT, "worktree_remove", return_value=(True, None)),
            unittest.mock.patch.object(
                cleanup.GIT, "delete_branch", return_value=(True, None, None)
            ),
            unittest.mock.patch.object(
                cleanup.subprocess, "run", return_value=unittest.mock.Mock(returncode=0, stderr="")
            ),
            unittest.mock.patch.object(cleanup.effects, "remove_tree") as remove_tree,
            unittest.mock.patch.object(cleanup.CLAUDE, "forget"),
        ):
            cleanup._delete(delete_ws(), DELETE_REPO_MAP, {}, dry_run=False)
        # only the worktree dir -- no filestore configured, so no per-db folder removal
        remove_tree.assert_called_once_with("/wt/feature")

    def test_worktree_remove_failure_does_not_abort_the_rest(self):
        # a failed worktree_remove is only logged -- delete_branch, the db drop
        # and the final worktree-dir removal must still run
        with (
            unittest.mock.patch.object(
                cleanup.GIT, "worktree_remove", return_value=(False, "busy")
            ),
            unittest.mock.patch.object(
                cleanup.GIT, "delete_branch", return_value=(True, None, None)
            ) as delete_branch,
            unittest.mock.patch.object(
                cleanup.subprocess, "run", return_value=unittest.mock.Mock(returncode=0, stderr="")
            ),
            unittest.mock.patch.object(cleanup.effects, "remove_tree") as remove_tree,
            unittest.mock.patch.object(cleanup.CLAUDE, "forget") as forget,
        ):
            cleanup._delete(delete_ws(), DELETE_REPO_MAP, {}, dry_run=False)
        delete_branch.assert_called_once()
        remove_tree.assert_called_once_with("/wt/feature")
        forget.assert_called_once()

    def test_dropdb_nonzero_exit_is_logged_not_fatal(self):
        with (
            unittest.mock.patch.object(cleanup.GIT, "worktree_remove", return_value=(True, None)),
            unittest.mock.patch.object(
                cleanup.GIT, "delete_branch", return_value=(True, None, None)
            ),
            unittest.mock.patch.object(
                cleanup.subprocess,
                "run",
                return_value=unittest.mock.Mock(returncode=1, stderr="database does not exist"),
            ),
            unittest.mock.patch.object(cleanup.effects, "remove_tree") as remove_tree,
            unittest.mock.patch.object(cleanup.CLAUDE, "forget") as forget,
        ):
            cleanup._delete(delete_ws(), DELETE_REPO_MAP, {}, dry_run=False)
        # dropdb failing must not stop the worktree-dir removal or forget()
        remove_tree.assert_called_once_with("/wt/feature")
        forget.assert_called_once()

    def test_dropdb_exception_is_swallowed(self):
        with (
            unittest.mock.patch.object(cleanup.GIT, "worktree_remove", return_value=(True, None)),
            unittest.mock.patch.object(
                cleanup.GIT, "delete_branch", return_value=(True, None, None)
            ),
            unittest.mock.patch.object(
                cleanup.subprocess,
                "run",
                side_effect=subprocess.TimeoutExpired(cmd="dropdb", timeout=30),
            ),
            unittest.mock.patch.object(cleanup.effects, "remove_tree") as remove_tree,
            unittest.mock.patch.object(cleanup.CLAUDE, "forget") as forget,
        ):
            cleanup._delete(delete_ws(), DELETE_REPO_MAP, {}, dry_run=False)  # must not raise
        remove_tree.assert_called_once_with("/wt/feature")
        forget.assert_called_once()


def run_config(workspaces, rev=5):
    return {
        "rev": rev,
        "config": {
            "repos": [{"id": "community", "github": "odoo/odoo", "path": "/main/community"}],
            "workspaces": workspaces,
        },
    }


class RunTest(unittest.TestCase):
    def test_eligible_workspace_is_deleted_and_config_saved(self):
        w = ws()
        w["location"] = "worktree"
        snapshot = run_config([w])
        with (
            unittest.mock.patch.object(cleanup.CONFIG, "get", return_value=snapshot),
            unittest.mock.patch.object(cleanup, "_merge_gate", return_value=(True, "merged")),
            unittest.mock.patch.object(cleanup, "_safety_guard", return_value=None),
            unittest.mock.patch.object(cleanup, "_delete") as delete,
            unittest.mock.patch.object(cleanup.CONFIG, "save", return_value=(True, {})) as save,
            unittest.mock.patch.object(cleanup, "_notify") as notify,
        ):
            cleanup.run()
        delete.assert_called_once_with(w, unittest.mock.ANY, snapshot["config"], False)
        # the deleted workspace's id must be dropped from the saved config
        saved_workspaces = save.call_args.kwargs["config"]["workspaces"]
        self.assertEqual(saved_workspaces, [])
        notify.assert_called_once()
        self.assertIn("deleted 1", notify.call_args.args[0])

    def test_merge_gate_skip_is_silent_not_warned(self):
        # a workspace with no PR yet (WIP) is skipped without being reported as
        # "needs attention" -- only a safety-guard failure counts as a warning
        w = ws()
        w["location"] = "worktree"
        snapshot = run_config([w])
        with (
            unittest.mock.patch.object(cleanup.CONFIG, "get", return_value=snapshot),
            unittest.mock.patch.object(
                cleanup, "_merge_gate", return_value=(False, "no PR yet (WIP)")
            ),
            unittest.mock.patch.object(cleanup, "_delete") as delete,
            unittest.mock.patch.object(cleanup.CONFIG, "save") as save,
            unittest.mock.patch.object(cleanup, "_notify") as notify,
        ):
            cleanup.run()
        delete.assert_not_called()
        save.assert_not_called()
        notify.assert_not_called()

    def test_safety_guard_skip_is_warned_and_notified(self):
        w = ws()
        w["location"] = "worktree"
        snapshot = run_config([w])
        with (
            unittest.mock.patch.object(cleanup.CONFIG, "get", return_value=snapshot),
            unittest.mock.patch.object(cleanup, "_merge_gate", return_value=(True, "merged")),
            unittest.mock.patch.object(
                cleanup, "_safety_guard", return_value="community: uncommitted changes"
            ),
            unittest.mock.patch.object(cleanup, "_delete") as delete,
            unittest.mock.patch.object(cleanup.CONFIG, "save") as save,
            unittest.mock.patch.object(cleanup, "_notify") as notify,
        ):
            cleanup.run()
        delete.assert_not_called()
        save.assert_not_called()
        notify.assert_called_once()
        self.assertIn("skipped 1 (needs attention)", notify.call_args.args[0])

    def test_dry_run_deletes_but_never_saves_config(self):
        w = ws()
        w["location"] = "worktree"
        snapshot = run_config([w])
        with (
            unittest.mock.patch.object(cleanup.CONFIG, "get", return_value=snapshot),
            unittest.mock.patch.object(cleanup, "_merge_gate", return_value=(True, "merged")),
            unittest.mock.patch.object(cleanup, "_safety_guard", return_value=None),
            unittest.mock.patch.object(cleanup, "_delete") as delete,
            unittest.mock.patch.object(cleanup.CONFIG, "save") as save,
            unittest.mock.patch.object(cleanup, "_notify"),
        ):
            cleanup.run(dry_run=True)
        delete.assert_called_once_with(w, unittest.mock.ANY, snapshot["config"], True)
        save.assert_not_called()

    def test_config_save_conflict_retries_against_the_fresh_config(self):
        w = ws()
        w["location"] = "worktree"
        other = {**ws(branch="other"), "id": "w2"}
        snapshot = run_config([w], rev=5)
        conflict_config = {**snapshot["config"], "workspaces": [w, other]}
        with (
            unittest.mock.patch.object(cleanup.CONFIG, "get", return_value=snapshot),
            unittest.mock.patch.object(cleanup, "_merge_gate", return_value=(True, "merged")),
            unittest.mock.patch.object(cleanup, "_safety_guard", return_value=None),
            unittest.mock.patch.object(cleanup, "_delete"),
            unittest.mock.patch.object(
                cleanup.CONFIG,
                "save",
                side_effect=[
                    (False, {"conflict": True, "rev": 6, "config": conflict_config}),
                    (True, {}),
                ],
            ) as save,
            unittest.mock.patch.object(cleanup, "_notify"),
        ):
            cleanup.run()
        self.assertEqual(save.call_count, 2)
        # retried at the fresh rev, against the fresh config's own workspace list
        second_call = save.call_args_list[1]
        self.assertEqual(second_call.args[0], 6)
        self.assertEqual(second_call.kwargs["config"]["workspaces"], [other])

    def test_config_save_conflict_exhausted_logs_and_does_not_raise(self):
        w = ws()
        w["location"] = "worktree"
        snapshot = run_config([w], rev=5)
        with (
            unittest.mock.patch.object(cleanup.CONFIG, "get", return_value=snapshot),
            unittest.mock.patch.object(cleanup, "_merge_gate", return_value=(True, "merged")),
            unittest.mock.patch.object(cleanup, "_safety_guard", return_value=None),
            unittest.mock.patch.object(cleanup, "_delete"),
            unittest.mock.patch.object(
                cleanup.CONFIG,
                "save",
                return_value=(False, {"conflict": True, "rev": 6, "config": snapshot["config"]}),
            ) as save,
            unittest.mock.patch.object(cleanup, "_notify"),
        ):
            cleanup.run()  # must not raise even after exhausting all 3 attempts
        self.assertEqual(save.call_count, 3)

    def test_non_worktree_workspaces_are_ignored(self):
        w = ws()
        w["location"] = "external"
        snapshot = run_config([w])
        with (
            unittest.mock.patch.object(cleanup.CONFIG, "get", return_value=snapshot),
            unittest.mock.patch.object(cleanup, "_merge_gate") as merge_gate,
            unittest.mock.patch.object(cleanup, "_notify") as notify,
        ):
            cleanup.run()
        merge_gate.assert_not_called()
        notify.assert_not_called()


class LoopTest(unittest.TestCase):
    def test_disabled_skips_run(self):
        with (
            unittest.mock.patch.object(cleanup.CONFIG, "get", return_value={"config": {}}),
            unittest.mock.patch.object(cleanup, "run") as run,
            unittest.mock.patch.object(cleanup.time, "sleep", side_effect=StopIteration),
        ):
            with self.assertRaises(StopIteration):
                cleanup.loop()
        run.assert_not_called()

    def test_enabled_calls_run(self):
        with (
            unittest.mock.patch.object(
                cleanup.CONFIG, "get", return_value={"config": {"cleanup_enabled": True}}
            ),
            unittest.mock.patch.object(cleanup, "run") as run,
            unittest.mock.patch.object(cleanup.time, "sleep", side_effect=StopIteration),
        ):
            with self.assertRaises(StopIteration):
                cleanup.loop()
        run.assert_called_once_with()

    def test_run_exception_is_logged_not_raised(self):
        # a failed run must never take the background thread (and so the whole
        # server) down
        with (
            unittest.mock.patch.object(
                cleanup.CONFIG, "get", return_value={"config": {"cleanup_enabled": True}}
            ),
            unittest.mock.patch.object(cleanup, "run", side_effect=RuntimeError("boom")),
            unittest.mock.patch.object(cleanup.time, "sleep", side_effect=StopIteration),
        ):
            with self.assertRaises(StopIteration):
                cleanup.loop()  # the RuntimeError itself must not propagate


if __name__ == "__main__":
    unittest.main()
