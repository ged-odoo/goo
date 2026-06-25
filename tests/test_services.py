"""Unit tests for the services layer — the payoff of the IO seam: each service is
exercised against a FakeIO, so there's no real subprocess, network, or sleep.

Run from the repo root: `python3 -m unittest discover`
"""

import json
import subprocess
import threading
import time
import unittest

from backend import services
from backend.cache import TTLCache


def completed(stdout="", returncode=0, stderr=""):
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=stderr)


class FakeIO:
    """Canned stand-in for effects.py — records calls, returns scripted results."""

    TAG = "[goo]"

    def __init__(self, *, run_result=None, runs=None, http=None, dirs=None, files=None, fs_fail=None):
        self._run_result = run_result if run_result is not None else completed()
        self._runs = runs or {}  # {cmd_substring: CompletedProcess} — first match wins
        self._http = http or {}  # {url_substring: (text, error)}
        self._dirs = dirs or {}  # {dir path: [entry names]}
        self._files = files or {}  # {file path: text content}
        self.fs_fail = fs_fail  # path substring whose filesystem op should fail
        self.run_calls = []
        self.http_calls = []
        self.logs = []
        self.fs_ops = []  # recorded (op, src, dst) filesystem mutations

    def log_request(self, target):
        pass

    def log(self, message):
        self.logs.append(message)

    def run(self, cmd, **kwargs):
        self.run_calls.append(cmd)
        joined = " ".join(str(c) for c in cmd)
        for needle, res in self._runs.items():
            if needle in joined:
                return res
        return self._run_result

    def http_get(self, url, **kwargs):
        self.http_calls.append(url)
        for needle, resp in self._http.items():
            if needle in url:
                return resp
        return "", "not stubbed"

    def is_dir(self, path):
        return path in self._dirs

    def list_dir(self, path):
        return sorted(self._dirs.get(path, []))

    def read_text(self, path):
        return self._files.get(path)

    # filesystem mutations — record them and keep self._dirs consistent so a later
    # is_dir() reflects the change. fs_fail (a path substring) forces an error.
    def remove_tree(self, path):
        self.fs_ops.append(("remove", path, None))
        if self.fs_fail and self.fs_fail in path:
            return False, "boom"
        self._dirs.pop(path, None)
        return True, None

    def move_path(self, src, dst):
        self.fs_ops.append(("move", src, dst))
        if self.fs_fail and self.fs_fail in src:
            return False, "boom"
        self._dirs[dst] = self._dirs.pop(src, [])
        return True, None

    def copy_tree(self, src, dst):
        self.fs_ops.append(("copy", src, dst))
        if self.fs_fail and self.fs_fail in src:
            return False, "boom"
        self._dirs[dst] = list(self._dirs.get(src, []))
        return True, None


class RunbotServiceTest(unittest.TestCase):
    def test_bundle_pass_and_running(self):
        html = (
            '<link rel="shortcut icon" href="/web/static/icon_ok.png">'
            '<div class="batch_tile"><a class="btn btn-info">building</a></div>'
            '<div class="batch_tile">older</div>'
        )
        svc = services.RunbotService(FakeIO(http={"bundle": (html, None)}), TTLCache(ttl=0))
        self.assertEqual(
            svc.statuses(["master"]), {"master": {"result": "success", "running": True}}
        )

    def test_bundle_fail_not_running(self):
        html = '<link rel="icon" href="x/icon_ko.png"><div class="batch_tile">done</div>'
        svc = services.RunbotService(FakeIO(http={"bundle": (html, None)}), TTLCache(ttl=0))
        self.assertEqual(svc.statuses(["b"]), {"b": {"result": "failure", "running": False}})

    def test_badge_fallback_when_bundle_unreachable(self):
        io = FakeIO(
            http={
                "bundle": ("", "boom"),
                "badge": ("<svg><text>x</text><text>success</text></svg>", None),
            }
        )
        svc = services.RunbotService(io, TTLCache(ttl=0))
        self.assertEqual(svc.statuses(["b"]), {"b": {"result": "success", "running": False}})


class MergebotServiceTest(unittest.TestCase):
    def test_merged(self):
        io = FakeIO(http={"pull": ('<div class="alert alert-success">merged</div>', None)})
        svc = services.MergebotService(io, TTLCache(ttl=0))
        states, details, unsupported = svc.statuses([{"github": "odoo/odoo", "number": 1}])
        self.assertEqual(states, {"odoo/odoo#1": "merged"})
        self.assertEqual(details, {})  # no `todo` checklist → no blocking detail
        self.assertEqual(unsupported, [])

    def test_blocked(self):
        io = FakeIO(http={"pull": ('<p class="bg-warning">blocked: CI</p>', None)})
        svc = services.MergebotService(io, TTLCache(ttl=0))
        states, details, unsupported = svc.statuses([{"github": "o/o", "number": 7}])
        self.assertEqual(states, {"o/o#7": "blocked"})
        self.assertEqual(unsupported, [])

    def test_blocked_reasons_lists_unmet_requirements(self):
        # the real mergebot page renders a `todo` checklist; the unmet top-level <li>
        # (class != "ok") are the blocking reasons. Whitespace is collapsed; satisfied
        # items and the nested per-CI-check <li> (they start with <a>) are excluded.
        html = (
            '<p class="text-danger bg-danger">Blocked</p>'
            '<ul class="todo">'
            '  <li class="ok">\n  Merge method\n  </li>'
            '  <li class="fail">\n  Review\n  </li>'
            '  <li class="">\n  CI\n  '
            '    <ul class="todo">'
            '      <li class="ok"><a href="x">ci/runbot</a></li>'
            '      <li class="fail"><a href="">ci/style</a></li>'
            "    </ul>"
            "  </li>"
            "</ul>"
        )
        io = FakeIO(http={"pull": (html, None)})
        svc = services.MergebotService(io, TTLCache(ttl=0))
        states, details, unsupported = svc.statuses([{"github": "odoo/enterprise", "number": 9}])
        self.assertEqual(states, {"odoo/enterprise#9": "blocked"})
        self.assertEqual(details, {"odoo/enterprise#9": "Review, CI"})
        self.assertEqual(unsupported, [])

    def test_transient_failure_is_blank_not_unsupported(self):
        svc = services.MergebotService(FakeIO(http={"pull": ("", "down")}), TTLCache(ttl=0))
        states, details, unsupported = svc.statuses([{"github": "o/o", "number": 7}])
        self.assertEqual(states, {"o/o#7": ""})
        self.assertEqual(details, {})
        self.assertEqual(unsupported, [])  # a non-404 error is transient, not "no mergebot"

    def test_404_marks_repo_unsupported(self):
        io = FakeIO(http={"pull": ("", "HTTP Error 404: Not Found")})
        svc = services.MergebotService(io, TTLCache(ttl=0))
        states, details, unsupported = svc.statuses([{"github": "odoo/owl", "number": 5}])
        self.assertEqual(states, {"odoo/owl#5": ""})
        self.assertEqual(unsupported, ["odoo/owl"])

    def test_reachable_sibling_keeps_repo_supported(self):
        # one PR 404s but another in the same repo loads → repo is NOT unsupported
        io = FakeIO(
            http={
                "pull/1": ('<div class="alert alert-success">merged</div>', None),
                "pull/2": ("", "HTTP Error 404: Not Found"),
            }
        )
        svc = services.MergebotService(io, TTLCache(ttl=0))
        states, details, unsupported = svc.statuses(
            [{"github": "odoo/odoo", "number": 1}, {"github": "odoo/odoo", "number": 2}]
        )
        self.assertEqual(states, {"odoo/odoo#1": "merged", "odoo/odoo#2": ""})
        self.assertEqual(unsupported, [])


class GitHubServiceTest(unittest.TestCase):
    def test_prs_maps_ci_rollup(self):
        payload = (
            '[{"number": 5, "title": "t", "url": "u", "state": "OPEN", "isDraft": false,'
            ' "headRefName": "br", "updatedAt": "x", "statusCheckRollup": ['
            '{"context": "ci/runbot", "state": "SUCCESS", "targetUrl": "ru"},'
            '{"context": "ci/style", "state": "FAILURE", "targetUrl": "su"}]}]'
        )
        io = FakeIO(run_result=completed(stdout=payload))
        svc = services.GitHubService(io, TTLCache(ttl=0))
        repos = svc.prs([{"id": "community", "github": "odoo/odoo"}])
        pr = repos[0]["prs"][0]
        self.assertEqual(pr["ci"]["runbot"], "success")
        self.assertEqual(pr["ci"]["overall"], "failure")  # ci/style failed
        self.assertEqual([c["context"] for c in pr["ci"]["checks"]], ["ci/runbot", "ci/style"])

    def test_prs_reports_gh_error(self):
        io = FakeIO(run_result=completed(returncode=1, stderr="gh: not logged in"))
        svc = services.GitHubService(io, TTLCache(ttl=0))
        repos = svc.prs([{"id": "community", "github": "odoo/odoo"}])
        self.assertEqual(repos[0]["error"], "gh: not logged in")

    def test_reviewed_maps_search_items(self):
        payload = json.dumps(
            {
                "data": {
                    "search": {
                        "issueCount": 2,
                        "nodes": [
                            {
                                "number": 5,
                                "title": "merged one",
                                "url": "https://github.com/odoo/odoo/pull/5",
                                "state": "MERGED",
                                "isDraft": False,
                                "updatedAt": "2026-06-24T00:00:00Z",
                                "headRefName": "master-fix-abc",
                                "repository": {"nameWithOwner": "odoo/odoo"},
                            },
                            {
                                "number": 7,
                                "title": "open draft",
                                "url": "https://github.com/odoo/enterprise/pull/7",
                                "state": "OPEN",
                                "isDraft": True,
                                "updatedAt": "2026-06-23T00:00:00Z",
                                "headRefName": "saas-1.0-feat",
                                "repository": {"nameWithOwner": "odoo/enterprise"},
                            },
                        ],
                        "pageInfo": {"hasNextPage": False, "endCursor": "c1"},
                    }
                }
            }
        )
        io = FakeIO(run_result=completed(stdout=payload))
        svc = services.GitHubService(io, TTLCache(ttl=0))
        result = svc.reviewed(days=14)
        prs = result["prs"]
        self.assertEqual(len(prs), 2)
        self.assertEqual(prs[0]["repo"], "odoo/odoo")
        self.assertEqual(prs[0]["state"], "merged")  # MERGED → "merged"
        self.assertEqual(prs[0]["url"], "https://github.com/odoo/odoo/pull/5")
        self.assertEqual(prs[0]["branch"], "master-fix-abc")
        self.assertEqual(prs[1]["repo"], "odoo/enterprise")
        self.assertEqual(prs[1]["state"], "open")
        self.assertTrue(prs[1]["draft"])
        self.assertEqual(prs[1]["branch"], "saas-1.0-feat")
        self.assertFalse(result["capped"])  # issueCount == fetched
        # one global GraphQL search: commented on but not authored by me
        joined = " ".join(str(c) for c in io.run_calls[0])
        self.assertIn("graphql", joined)
        self.assertIn("commenter:@me", joined)
        self.assertIn("-author:@me", joined)

    def test_reviewed_reports_gh_error(self):
        io = FakeIO(run_result=completed(returncode=1, stderr="gh: not logged in"))
        svc = services.GitHubService(io, TTLCache(ttl=0))
        result = svc.reviewed()
        self.assertEqual(result["error"], "gh: not logged in")
        self.assertEqual(result["prs"], [])

    def test_close_pr_invalidates_cache(self):
        cache = TTLCache(ttl=600)
        io = FakeIO(run_result=completed(stdout="[]"))
        svc = services.GitHubService(io, cache)
        svc.prs([{"id": "c", "github": "o/o"}])  # populates the cache
        svc.prs([{"id": "c", "github": "o/o"}])  # served from cache → no 2nd gh call
        self.assertEqual(len(io.run_calls), 1)
        ok, _ = svc.close_pr("o/o", 3)
        self.assertTrue(ok)
        svc.prs([{"id": "c", "github": "o/o"}])  # cache was invalidated → fetches again
        self.assertEqual(len(io.run_calls), 3)  # 1 prs + 1 close + 1 prs


class TTLCacheTest(unittest.TestCase):
    def test_single_flight(self):
        cache = TTLCache(ttl=60)
        calls = []

        def compute():
            calls.append(1)
            time.sleep(0.05)  # hold the key lock so concurrent gets queue
            return "v"

        threads = [threading.Thread(target=lambda: cache.get("k", compute)) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(calls), 1)  # computed exactly once despite 8 concurrent gets

    def test_ttl_expiry_and_invalidate(self):
        now = [1000.0]
        cache = TTLCache(ttl=10, clock=lambda: now[0])
        n = []
        compute = lambda: (n.append(1), len(n))[1]  # noqa: E731
        self.assertEqual(cache.get("k", compute), 1)
        self.assertEqual(cache.get("k", compute), 1)  # fresh → cached
        now[0] += 11  # past the TTL
        self.assertEqual(cache.get("k", compute), 2)  # recomputed
        cache.invalidate("k")
        self.assertEqual(cache.get("k", compute), 3)  # invalidated → recomputed


class DatabaseServiceTest(unittest.TestCase):
    def _io(self, *, dirs=None, fs_fail=None, **extra):
        runs = {
            "ORDER BY datname": completed(stdout="alpha\nbeta\n"),  # the db list
            "pg_stat_file": completed(stdout="alpha|2024-01-01 00:00:00\n"),  # creation times
            "pg_database_size": completed(stdout="alpha|1048576\n"),  # sizes (bytes)
            "latest_version": completed(stdout="17.0|f|2024-06-20T10:00:00\n"),  # odoo_info
        }
        runs.update(extra)
        return FakeIO(runs=runs, dirs=dirs, fs_fail=fs_fail)

    def test_databases_lists_with_info(self):
        svc = services.DatabaseService(self._io(), TTLCache(ttl=0))
        dbs = svc.databases()
        self.assertEqual([d["name"] for d in dbs], ["alpha", "beta"])
        self.assertEqual(dbs[0]["odoo_version"], "17.0")
        self.assertEqual(dbs[0]["created"], "2024-01-01 00:00:00")
        self.assertIsNone(dbs[1]["created"])  # only alpha had a creation time
        self.assertEqual(dbs[0]["size"], 1048576)
        self.assertIsNone(dbs[1]["size"])  # only alpha had a size

    def test_databases_raises_when_psql_fails(self):
        io = self._io()
        io._runs["ORDER BY datname"] = completed(returncode=2, stderr="psql: connection refused")
        svc = services.DatabaseService(io, TTLCache(ttl=0))
        with self.assertRaises(RuntimeError):
            svc.databases()

    def test_db_initialized(self):
        ok = services.DatabaseService(
            FakeIO(runs={"information_schema.tables": completed(stdout="1")}), TTLCache(ttl=0)
        )
        self.assertTrue(ok.db_initialized("d"))
        empty = services.DatabaseService(
            FakeIO(runs={"information_schema.tables": completed(stdout="")}), TTLCache(ttl=0)
        )
        self.assertFalse(empty.db_initialized("d"))  # shell db, no schema
        missing = services.DatabaseService(
            FakeIO(runs={"information_schema.tables": completed(returncode=2)}), TTLCache(ttl=0)
        )
        self.assertFalse(missing.db_initialized("d"))  # db doesn't exist

    def test_installed_modules(self):
        io = FakeIO(runs={"name, state": completed(stdout="sale|installed\naccount|uninstalled\n")})
        svc = services.DatabaseService(io, TTLCache(ttl=0))
        self.assertEqual(
            svc.installed_modules("d"), {"sale": "installed", "account": "uninstalled"}
        )

    def test_drop_invalidates_cache(self):
        cache = TTLCache(ttl=600)
        svc = services.DatabaseService(self._io(dropdb=completed()), cache)
        svc.databases()  # cache the list
        svc.databases()  # served from cache → one list query only
        list_calls = sum("ORDER BY datname" in " ".join(c) for c in svc.io.run_calls)
        self.assertEqual(list_calls, 1)
        ok, _ = svc.drop("alpha")
        self.assertTrue(ok)
        svc.databases()  # cache invalidated → list query runs again
        list_calls = sum("ORDER BY datname" in " ".join(c) for c in svc.io.run_calls)
        self.assertEqual(list_calls, 2)

    def test_clone_runs_createdb_and_invalidates_cache(self):
        cache = TTLCache(ttl=600)
        svc = services.DatabaseService(self._io(), cache)
        svc.databases()  # cache the list
        ok, err = svc.clone("alpha", "alpha-copy")
        self.assertTrue(ok, err)
        self.assertTrue(
            any(c[:3] == ["createdb", "-T", "alpha"] and c[-1] == "alpha-copy" for c in svc.io.run_calls)
        )
        svc.databases()  # cache invalidated → list query runs again
        self.assertEqual(sum("ORDER BY datname" in " ".join(c) for c in svc.io.run_calls), 2)

    def test_clone_rejects_invalid_target(self):
        svc = services.DatabaseService(self._io(), TTLCache(ttl=0))
        ok, err = svc.clone("alpha", "bad name!")
        self.assertFalse(ok)
        self.assertIn("invalid", err)
        self.assertFalse(any("createdb" in " ".join(c) for c in svc.io.run_calls))

    def test_rename_runs_alter_and_invalidates_cache(self):
        cache = TTLCache(ttl=600)
        svc = services.DatabaseService(self._io(), cache)
        svc.databases()  # cache the list
        ok, err = svc.rename("alpha", "gamma")
        self.assertTrue(ok, err)
        self.assertTrue(
            any('ALTER DATABASE "alpha" RENAME TO "gamma"' in " ".join(c) for c in svc.io.run_calls)
        )
        svc.databases()  # cache invalidated → list query runs again
        self.assertEqual(sum("ORDER BY datname" in " ".join(c) for c in svc.io.run_calls), 2)

    def test_rename_rejects_invalid_name(self):
        svc = services.DatabaseService(self._io(), TTLCache(ttl=0))
        ok, err = svc.rename("alpha", 'evil"; DROP')
        self.assertFalse(ok)
        self.assertFalse(any("ALTER DATABASE" in " ".join(c) for c in svc.io.run_calls))

    # ── filestore kept in lockstep with the database ──
    def test_drop_removes_filestore(self):
        io = self._io(dropdb=completed(), dirs={"/fs/alpha": ["a.png"]})
        svc = services.DatabaseService(io, TTLCache(ttl=0))
        ok, _ = svc.drop("alpha", filestore="/fs")
        self.assertTrue(ok)
        self.assertIn(("remove", "/fs/alpha", None), io.fs_ops)

    def test_drop_without_filestore_leaves_disk(self):
        io = self._io(dropdb=completed(), dirs={"/fs/alpha": ["a.png"]})
        svc = services.DatabaseService(io, TTLCache(ttl=0))
        svc.drop("alpha")  # no filestore arg → never touches disk
        self.assertEqual(io.fs_ops, [])

    def test_drop_filestore_failure_is_logged_not_fatal(self):
        io = self._io(dropdb=completed(), dirs={"/fs/alpha": ["a.png"]}, fs_fail="/fs/alpha")
        svc = services.DatabaseService(io, TTLCache(ttl=0))
        ok, err = svc.drop("alpha", filestore="/fs")
        self.assertTrue(ok)  # the db is gone; a filestore failure doesn't fail the drop
        self.assertIsNone(err)
        self.assertTrue(any("filestore" in m for m in io.logs))

    def test_clone_copies_filestore(self):
        io = self._io(dirs={"/fs/alpha": ["a.png"]})
        svc = services.DatabaseService(io, TTLCache(ttl=0))
        ok, err = svc.clone("alpha", "beta", filestore="/fs")
        self.assertTrue(ok, err)
        self.assertIn(("copy", "/fs/alpha", "/fs/beta"), io.fs_ops)

    def test_clone_skips_filestore_when_source_absent(self):
        io = self._io(dirs={})  # the source db has no filestore on disk
        svc = services.DatabaseService(io, TTLCache(ttl=0))
        ok, _ = svc.clone("alpha", "beta", filestore="/fs")
        self.assertTrue(ok)
        self.assertEqual(io.fs_ops, [])

    def test_rename_moves_filestore(self):
        io = self._io(dirs={"/fs/alpha": ["a.png"]})
        svc = services.DatabaseService(io, TTLCache(ttl=0))
        ok, err = svc.rename("alpha", "gamma", filestore="/fs")
        self.assertTrue(ok, err)
        self.assertIn(("move", "/fs/alpha", "/fs/gamma"), io.fs_ops)


class GitServiceTest(unittest.TestCase):
    def test_branches_parses_state(self):
        io = FakeIO(
            runs={
                "branch --show-current": completed(stdout="master-owl-update\n"),
                "status --porcelain": completed(stdout=" M file.py\n"),  # dirty
                "log -1": completed(stdout="abc123\n[FIX] thing\n2024-06-20T10:00:00\n"),
                "--not --remotes --count": completed(stdout="0\n"),  # pushed
                "--left-right --count": completed(stdout="2\t3\n"),  # behind 2, ahead 3
                "for-each-ref refs/remotes": completed(stdout="master-owl-update\nmaster\n"),
                "for-each-ref refs/heads": completed(
                    stdout="master-owl-update\t2024-06-20T10:00:00\t[FIX] thing\tabc123\n"
                ),
                "master@{upstream}": completed(stdout="origin/master\n"),
            }
        )
        svc = services.GitService(io)
        [entry] = svc.branches([{"id": "community", "path": "/repo", "github": "odoo/odoo"}])
        self.assertEqual(entry["current"], "master-owl-update")
        self.assertTrue(entry["dirty"])
        self.assertTrue(entry["head_pushed"])
        self.assertEqual((entry["behind"], entry["ahead"]), (2, 3))
        self.assertTrue(entry["head_remote"])  # current branch has a remote ref
        self.assertEqual(entry["branches"][0]["name"], "master-owl-update")
        self.assertTrue(entry["branches"][0]["remote"])

    def test_branches_reports_not_a_repo(self):
        io = FakeIO(
            runs={"branch --show-current": completed(returncode=128, stderr="not a git repo")}
        )
        [entry] = services.GitService(io).branches([{"id": "x", "path": "/nope"}])
        self.assertEqual(entry["error"], "not a git repo")

    def test_checkout_error(self):
        io = FakeIO(
            run_result=completed(returncode=1, stderr="error: pathspec 'nope' did not match")
        )
        ok, err = services.GitService(io).checkout("/repo", "nope")
        self.assertFalse(ok)
        self.assertIn("pathspec", err)

    def test_delete_branch_no_dev_remote_skips_remote(self):
        # local delete ok; no odoo-dev remote → remote delete skipped (no error)
        io = FakeIO(
            runs={
                "branch -D": completed(),
                "remote -v": completed(stdout="origin\tgit@github:odoo/odoo\n"),
            }
        )
        ok, err, remote_err = services.GitService(io).delete_branch("/r", "b", delete_remote=True)
        self.assertEqual((ok, err, remote_err), (True, None, None))
        self.assertFalse(any("--delete" in " ".join(c) for c in io.run_calls))  # never pushed

    def test_log_parses_commits(self):
        rec = "sha1\x1fAlice\x1f2024-06-20\x1f[FIX] a\x1fbody line\x1e"
        io = FakeIO(runs={"git -C /r log": completed(stdout=rec)})
        commits, err = services.GitService(io).log("/r")
        self.assertIsNone(err)
        self.assertEqual(
            commits[0],
            {
                "sha": "sha1",
                "author": "Alice",
                "date": "2024-06-20",
                "subject": "[FIX] a",
                "body": "body line",
            },
        )

    def test_main_remote_falls_back_to_origin(self):
        # no upstream and no github match → "origin"
        io = FakeIO(runs={"master@{upstream}": completed(returncode=128, stderr="no upstream")})
        self.assertEqual(services.GitService(io).main_remote("/r"), "origin")

    def test_main_remote_from_github_url(self):
        io = FakeIO(
            runs={
                "master@{upstream}": completed(returncode=128),
                "remote -v": completed(stdout="upstream\tgit@github.com:odoo/odoo.git (fetch)\n"),
            }
        )
        self.assertEqual(services.GitService(io).main_remote("/r", "odoo/odoo"), "upstream")

    def test_fetch_rebase_notifies_phases(self):
        notes = []
        io = FakeIO(runs={"master@{upstream}": completed(stdout="origin/master\n")})
        svc = services.GitService(io, notify=notes.append)
        ok, _ = svc.fetch_rebase("/r", "master", "odoo/odoo", repo="community")
        self.assertTrue(ok)
        self.assertEqual(notes, ["fetching master (community)", "rebasing community onto master"])


class GitHubSearchBranchesTest(unittest.TestCase):
    def test_search_branches(self):
        io = FakeIO(
            runs={"matching-refs": completed(stdout="refs/heads/master-x\nrefs/heads/master-y\n")}
        )
        svc = services.GitHubService(io, TTLCache(ttl=0))
        found = svc.search_branches([{"id": "community", "github": "odoo/odoo"}], "master-")
        self.assertEqual(sorted(f["branch"] for f in found), ["master-x", "master-y"])
        self.assertTrue(all(f["repo"] == "community" for f in found))


class AddonsServiceTest(unittest.TestCase):
    def test_modules_scanned_and_deduped(self):
        man = "{'name': 'Sale', 'category': 'Sales', 'summary': 's', 'application': True}"
        io = FakeIO(
            dirs={
                "/community/addons": ["sale", "_skip", ".hidden", "no_manifest"],
                "/community/odoo/addons": ["base"],
                "/enterprise": ["sale", "account"],  # sale dup → community wins
            },
            files={
                "/community/addons/sale/__manifest__.py": man,
                "/community/odoo/addons/base/__manifest__.py": "{'name': 'Base'}",
                "/enterprise/sale/__manifest__.py": man,
                "/enterprise/account/__manifest__.py": "{'name': 'Acc', 'installable': False}",
            },
        )
        svc = services.AddonsService(io)
        mods = svc.modules(
            [{"id": "community", "path": "/community"}, {"id": "enterprise", "path": "/enterprise"}]
        )
        by = {m["name"]: m for m in mods}
        self.assertEqual(set(by), {"sale", "base", "account"})  # _skip/.hidden/no_manifest excluded
        self.assertEqual(by["sale"]["repo"], "community")  # earlier repo wins the dup
        self.assertTrue(by["sale"]["application"])
        self.assertEqual(by["sale"]["category"], "Sales")
        self.assertFalse(by["account"]["installable"])
        self.assertTrue(by["base"]["installable"])  # defaults to True

    def test_bad_manifest_is_skipped(self):
        io = FakeIO(
            dirs={"/r": ["broken"]},
            files={"/r/broken/__manifest__.py": "{not valid python"},
        )
        self.assertEqual(services.AddonsService(io).modules([{"id": "x", "path": "/r"}]), [])


if __name__ == "__main__":
    unittest.main()
