"""Unit tests for backend/cleanup.py's merge/safety gating — _merge_gate and
_safety_guard are pure-ish functions (their only IO is through the GIT/GITHUB/
MERGEBOT module singletons), so they're exercised directly against mocks
rather than through the full run() loop.

Run from the repo root: `python3 -m unittest discover`
"""

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


if __name__ == "__main__":
    unittest.main()
