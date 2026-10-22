"""A commit's diff and a file as of a commit (the commit diff view and its context
expansion), against a real git repo in a temp dir."""

import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

from backend import effects, services


class CommitFileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        env = {
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@t",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@t",
        }
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.git("init", "-q")
        os.makedirs(os.path.join(self.tmp, "sub"))
        self.write("sub/f.py", "one\ntwo\n")
        self.git("add", ".")
        self.git("commit", "-q", "-m", "first")
        self.first = self.git("rev-parse", "HEAD")
        self.write("sub/f.py", "one\ntwo\nthree\n")
        self.git("commit", "-q", "-am", "second")
        self.svc = services.GitService(effects)

    def git(self, *args):
        return subprocess.run(
            ["git", "-C", self.tmp, *args], check=True, capture_output=True, text=True
        ).stdout.strip()

    def write(self, name, text):
        with open(os.path.join(self.tmp, name), "w") as f:
            f.write(text)

    def test_returns_the_file_as_of_the_commit(self):
        self.assertEqual(
            self.svc.commit_file(self.tmp, self.first, "sub/f.py"), ("one\ntwo\n", None)
        )

    def test_a_missing_file_is_an_error(self):
        content, error = self.svc.commit_file(self.tmp, self.first, "nope.py")
        self.assertIsNone(content)
        self.assertIn("nope.py", error)

    def test_rejects_an_invalid_hash(self):
        self.assertEqual(
            self.svc.commit_file(self.tmp, "HEAD", "sub/f.py"), (None, "invalid commit hash")
        )

    def test_a_merge_diffs_against_its_first_parent(self):
        self.git("checkout", "-q", "-b", "side", self.first)
        self.write("side.py", "s\n")
        self.git("add", "side.py")
        self.git("commit", "-q", "-m", "side")
        self.git("checkout", "-q", "-")
        self.git("merge", "-q", "--no-ff", "-m", "merge side", "side")
        diff, error = self.svc.commit_diff(self.tmp, self.git("rev-parse", "HEAD"))
        self.assertIsNone(error)
        # a plain per-file diff of what the merge brought in, not git's combined one
        self.assertIn("diff --git a/side.py b/side.py", diff)
        self.assertIn("+s", diff)
        self.assertNotIn("diff --cc", diff)

    def test_a_non_ascii_path_is_not_escaped(self):
        self.write("café.py", "x\n")
        self.git("add", "café.py")
        self.git("commit", "-q", "-m", "accent")
        sha = self.git("rev-parse", "HEAD")
        diff, _ = self.svc.commit_diff(self.tmp, sha)
        self.assertIn("+++ b/café.py", diff)
        self.assertEqual(self.svc.commit_file(self.tmp, sha, "café.py"), ("x\n", None))


if __name__ == "__main__":
    unittest.main()
