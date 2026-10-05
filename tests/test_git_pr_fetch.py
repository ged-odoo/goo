"""Fetching a PR head with real git: github.com's HTTPS side answers 401 (a private
repo on a machine with no HTTPS credentials) while its SSH side is a local bare repo
holding refs/pull/<n>/head. Both URLs are redirected with `url.<base>.insteadOf`."""

import http.server
import os
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest import mock

from backend import effects, services


class _Unauthorized(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="github"')
        self.end_headers()

    def log_message(self, *args):
        pass


class PrFetchOverSshTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Unauthorized)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        remote_root = os.path.join(self.tmp, "remote")
        bare = os.path.join(remote_root, "odoo", "enterprise.git")
        os.makedirs(bare)
        self.git(bare, "init", "-q", "--bare")
        work = os.path.join(self.tmp, "work")
        os.makedirs(work)
        self.git(work, "init", "-q")
        with open(os.path.join(work, "f"), "w") as f:
            f.write("x")
        self.git(work, "add", "f")
        self.git(work, "commit", "-q", "-m", "pr head")
        self.pr_head = self.git(work, "rev-parse", "HEAD")
        self.git(work, "push", "-q", bare, "HEAD:refs/pull/5/head")

        gitconfig = os.path.join(self.tmp, "gitconfig")
        with open(gitconfig, "w") as f:
            f.write(
                f'[url "http://127.0.0.1:{server.server_port}/"]\n'
                "\tinsteadOf = https://github.com/\n"
                f'[url "{remote_root}/"]\n'
                "\tinsteadOf = git@github.com:\n"
            )
        env = {
            "GIT_CONFIG_GLOBAL": gitconfig,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@t",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@t",
        }
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)

        self.local = os.path.join(self.tmp, "local")
        os.makedirs(self.local)
        self.git(self.local, "init", "-q")
        self.svc = services.GitService(effects)

    def git(self, cwd, *args):
        return subprocess.run(
            ["git", "-C", cwd, *args], check=True, capture_output=True, text=True
        ).stdout.strip()

    def test_failure_is_reported_when_the_ssh_retry_fails_too(self):
        ok, error, _ = self.svc.fetch_pr_head(self.local, "odoo/missing", 5, "pr")
        self.assertFalse(ok)
        self.assertTrue(error)
        self.assertNotIn("pr", self.git(self.local, "branch", "--list").split())

    def test_fetch_pr_head_creates_the_branch_through_ssh(self):
        ok, error, _ = self.svc.fetch_pr_head(self.local, "odoo/enterprise", 5, "pr")
        self.assertEqual((ok, error), (True, None))
        self.assertEqual(self.git(self.local, "rev-parse", "pr"), self.pr_head)

    def test_sync_pr_worktree_resets_onto_the_pr_head_through_ssh(self):
        ok, error = self.svc.sync_pr_worktree(self.local, "odoo/enterprise", 5)
        self.assertEqual((ok, error), (True, None))
        self.assertEqual(self.git(self.local, "rev-parse", "HEAD"), self.pr_head)
