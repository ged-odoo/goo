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

    def __init__(
        self,
        *,
        run_result=None,
        runs=None,
        http=None,
        http_nofollow=None,
        dirs=None,
        files=None,
        json_files=None,
        fs_fail=None,
    ):
        self._run_result = run_result if run_result is not None else completed()
        self._runs = runs or {}  # {cmd_substring: CompletedProcess} — first match wins
        self._http = http or {}  # {url_substring: (text, error)}
        # {url_substring: (status, location, text)} for http_get_nofollow
        self._http_nofollow = http_nofollow or {}
        self._dirs = dirs or {}  # {dir path: [entry names]}
        self._files = files or {}  # {file path: text content}
        self._json_files = dict(json_files or {})  # {path: parsed-json-object}
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

    def http_get_nofollow(self, url, **kwargs):
        self.http_calls.append(url)
        for needle, resp in self._http_nofollow.items():
            if needle in url:
                return (*resp, None)
        return 0, "", "", "not stubbed"

    def is_dir(self, path):
        return path in self._dirs

    def list_dir(self, path):
        return sorted(self._dirs.get(path, []))

    def read_text(self, path):
        return self._files.get(path)

    # JSON file IO — an in-memory {path: object} store mirroring effects.*_json_file.
    # A missing file is (None, None); fs_fail (a path substring) forces a write error.
    def read_json_file(self, path):
        return self._json_files.get(path), None

    def write_json_file(self, path, data):
        self.fs_ops.append(("write_json", path, None))
        if self.fs_fail and self.fs_fail in path:
            return False, "boom"
        self._json_files[path] = data
        return True, None

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
        # a real branch: name match → 302 to the canonical page, which we then read
        html = (
            '<link rel="shortcut icon" href="/web/static/icon_ok.png">'
            '<div class="batch_tile"><div class="card bg-info-subtle">'
            '<i class="fa fa-spin"></i>building</div></div>'
            '<div class="batch_tile">older</div>'
        )
        io = FakeIO(
            http_nofollow={"bundle/master": (302, "/runbot/bundle/master-1", "")},
            http={"bundle/master-1": (html, None)},
        )
        svc = services.RunbotService(io, TTLCache(ttl=0))
        self.assertEqual(
            svc.statuses(["master"]),
            {
                "master": {
                    "result": "success",
                    "running": True,
                    "url": "https://runbot.odoo.com/runbot/bundle/master-1",
                }
            },
        )

    def test_bundle_pass_not_running_with_connect_links(self):
        # every finished slot has an `fa-sign-in btn-info` connect link — a bare
        # btn-info must NOT be read as "still running"
        html = (
            '<link rel="shortcut icon" href="/web/static/icon_ok.png">'
            '<div class="batch_tile"><div class="card bg-success-subtle">'
            '<a class="fa fa-sign-in btn btn-info" href="/runbot/run/1"></a></div></div>'
        )
        io = FakeIO(
            http_nofollow={"bundle/master": (302, "/runbot/bundle/master-1", "")},
            http={"bundle/master-1": (html, None)},
        )
        svc = services.RunbotService(io, TTLCache(ttl=0))
        self.assertEqual(
            svc.statuses(["master"]),
            {
                "master": {
                    "result": "success",
                    "running": False,
                    "url": "https://runbot.odoo.com/runbot/bundle/master-1",
                }
            },
        )

    def test_bundle_fail_not_running(self):
        # a canonical URL hit directly (200) is parsed straight from the body
        html = '<link rel="icon" href="x/icon_ko.png"><div class="batch_tile">done</div>'
        io = FakeIO(http_nofollow={"bundle/b": (200, "", html)})
        svc = services.RunbotService(io, TTLCache(ttl=0))
        self.assertEqual(
            svc.statuses(["b"]),
            {
                "b": {
                    "result": "failure",
                    "running": False,
                    "url": services.RUNBOT_BASE + "/runbot/bundle/b",
                }
            },
        )

    def test_slug_misresolve_301_is_not_reported(self):
        # a never-pushed `master-test-33` has no bundle of that name, so runbot reads
        # the trailing 33 as a bundle id and 301-redirects to an unrelated bundle —
        # which we must NOT report (the bug: it showed that foreign bundle's "ko").
        io = FakeIO(
            http_nofollow={
                "bundle/master-test-33": (
                    301,
                    "/runbot/bundle/master-decimal-rounding-fix-jar-33",
                    "",
                )
            }
        )
        svc = services.RunbotService(io, TTLCache(ttl=0))
        self.assertEqual(
            svc.statuses(["master-test-33"]),
            {"master-test-33": {"result": "", "running": False, "url": ""}},
        )

    def test_bundle_absent_404(self):
        io = FakeIO(http_nofollow={"bundle/gone": (404, "", "")})
        svc = services.RunbotService(io, TTLCache(ttl=0))
        self.assertEqual(
            svc.statuses(["gone"]), {"gone": {"result": "", "running": False, "url": ""}}
        )

    def test_badge_fallback_when_bundle_unreachable(self):
        # name match (302), but the canonical page can't be read → name-keyed badge
        io = FakeIO(
            http_nofollow={"bundle/b": (302, "/runbot/bundle/b-9", "")},
            http={
                "bundle/b-9": ("", "boom"),
                "badge": ("<svg><text>x</text><text>success</text></svg>", None),
            },
        )
        svc = services.RunbotService(io, TTLCache(ttl=0))
        self.assertEqual(
            svc.statuses(["b"]),
            {
                "b": {
                    "result": "success",
                    "running": False,
                    "url": services.RUNBOT_BASE + "/runbot/bundle/b-9",
                }
            },
        )


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


class NightlyServiceTest(unittest.TestCase):
    # ── extraction ────────────────────────────────────────────────────────

    def test_fetch_versions_parses_starred_bundles_only(self):
        html = (
            '<div class="row bundle_row"><i class="fa fa-star"></i>'
            '<a href="/runbot/bundle/1" title="View Bundle master">master</a></div>'
            '<div class="row bundle_row">'  # not starred -> excluded
            '<a href="/runbot/bundle/2" title="View Bundle saas-19.4">saas-19.4</a></div>'
            '<div class="row bundle_row"><i class="fa fa-star"></i>'  # starred but 16.0 -> excluded
            '<a href="/runbot/bundle/3" title="View Bundle 16.0">16.0</a></div>'
        )
        io = FakeIO(http={"rd-1": (html, None)})
        svc = services.NightlyService(io, TTLCache(60))
        self.assertEqual(svc._versions(), [("master", "1")])

    def test_fetch_versions_falls_back_on_error(self):
        io = FakeIO(http={"rd-1": ("", "boom")})
        svc = services.NightlyService(io, TTLCache(60))
        self.assertEqual(svc._versions(), list(services.NightlyService._VERSIONS_FALLBACK))

    def test_parse_bundle_extracts_community_and_enterprise(self):
        html = (
            '<div class="batch_tile" title="2026-07-01 03:00:00">'
            '<div class="slot_container">'
            '<button class="btn btn-default slot_name"><span>Qunit Community</span></button>'
            '<span class="btn btn-success disabled">ok</span>'
            '<a href="/runbot/batch/1/build/10">x</a></div>'
            '<div class="slot_container">'
            '<button class="btn btn-default slot_name"><span>Qunit Enterprise</span></button>'
            '<span class="btn btn-danger disabled">ko</span>'
            '<a href="/runbot/batch/1/build/11">x</a></div>'
            "</div>"
        )
        svc = services.NightlyService(FakeIO(), TTLCache(60))
        nights = svc._parse_bundle(html)
        self.assertEqual(
            nights,
            [
                {
                    "date": "2026-07-01",
                    "community": {"status": "success", "url": "/runbot/batch/1/build/10"},
                    "enterprise": {"status": "danger", "url": "/runbot/batch/1/build/11"},
                }
            ],
        )

    def test_fetch_build_detail_counts_and_child_rows(self):
        html = (
            '<tr class="bg-success-subtle"><td><a href="/runbot/batch/1/build/200">x</a></td></tr>'
            '<tr class="bg-danger-subtle"><td><a href="/runbot/batch/1/build/201">x</a></td></tr>'
        )
        io = FakeIO(http={"build/100": (html, None)})
        svc = services.NightlyService(io, TTLCache(60))
        detail = svc._build_detail("/runbot/batch/1/build/100")
        self.assertEqual(detail["counts"], {"total": 2, "ok": 1, "warning": 0, "failed": 1})
        self.assertEqual(
            detail["child_rows"],
            [("/runbot/batch/1/build/200", "success"), ("/runbot/batch/1/build/201", "danger")],
        )

    def test_parse_child_errors(self):
        html = (
            '<tr class="log-server"><td>a</td><td>ERROR</td>'
            '<td>[HOOT] Test "my.test.name" failed</td></tr>'
            '<tr class="log-server"><td>a</td><td>ERROR</td>'
            "<td>FAIL: my.module.test_x Script timeout exceeded</td></tr>"
            '<tr class="log-runbot"><td>a</td><td>WARNING</td>'
            "<td>Test time for my.suite: 125.5</td></tr>"
        )
        svc = services.NightlyService(FakeIO(), TTLCache(60))
        errors = svc._parse_child_errors(html)
        self.assertEqual(
            errors,
            [
                {
                    "test_name": "my.test.name",
                    "status": "danger",
                    "timeout": False,
                    "known": False,
                    "assignee": "",
                },
                {
                    "test_name": "my.module.test_x: timeout",
                    "status": "danger",
                    "timeout": True,
                    "known": False,
                    "assignee": "",
                },
                {
                    "test_name": "Test time for my.suite: 2m 5s",
                    "status": "warning",
                    "timeout": False,
                    "known": False,
                    "assignee": "",
                },
            ],
        )

    def test_parse_child_metrics(self):
        html = (
            "Average memory used for web.suite: 1048576\n"
            "Max memory used for web.suite: 2097152\n"
            "Test time for web.suite: 12.5\n"
            "[HOOT] Passed 42 tests (100 assertions)\n"
        )
        svc = services.NightlyService(FakeIO(), TTLCache(60))
        self.assertEqual(
            svc._parse_child_metrics(html),
            {
                "web.suite": {
                    "avg_mem": 1048576.0,
                    "max_mem": 2097152.0,
                    "time": 12.5,
                    "tests": 42,
                    "assertions": 100,
                }
            },
        )

    def test_batch_builds_filters_start_qunit_only_links(self):
        html = (
            '<a class="dropdown-item" href="/runbot/batch/1/build/300">start_qunit_only</a>'
            '<a class="dropdown-item" href="/runbot/batch/1/build/301">start_tests</a>'
        )
        io = FakeIO(http={"batch/1/build/1": (html, None)})
        svc = services.NightlyService(io, TTLCache(60))
        self.assertEqual(
            svc.batch_builds("/runbot/batch/1/build/1"),
            [{"label": "300", "url": services.RUNBOT_BASE + "/runbot/batch/1/build/300"}],
        )

    # ── caching ──────────────────────────────────────────────────────────

    def test_versions_cached_then_bypassed_on_refresh(self):
        html = (
            '<div class="row bundle_row"><i class="fa fa-star"></i>'
            '<a href="/runbot/bundle/1" title="View Bundle master">master</a></div>'
        )
        io = FakeIO(http={"rd-1": (html, None)})
        svc = services.NightlyService(io, TTLCache(60))
        svc._versions()
        svc._versions()  # cache hit — no new fetch
        self.assertEqual(len(io.http_calls), 1)
        svc._versions(refresh=True)  # explicit refresh — bypasses the cache
        self.assertEqual(len(io.http_calls), 2)

    def test_build_detail_cached_forever_unless_running(self):
        done_html = '<tr class="bg-success-subtle"><td>x</td></tr>'
        running_html = '<tr class="bg-info-subtle">still building</td></tr>'
        io = FakeIO(http={"build/10": (done_html, None), "build/11": (running_html, None)})
        svc = services.NightlyService(io, TTLCache(60))
        for _ in range(3):
            svc._build_detail("/runbot/batch/1/build/10", running=False)
            svc._build_detail("/runbot/batch/1/build/11", running=True)
        # a terminal build's page is fetched once no matter how many times it's asked for...
        self.assertEqual(sum(1 for u in io.http_calls if "build/10" in u), 1)
        # ...but a still-running build is re-fetched every time (its page keeps changing)
        self.assertEqual(sum(1 for u in io.http_calls if "build/11" in u), 3)

    def test_child_detail_fetched_at_most_once(self):
        io = FakeIO(
            http={
                "build/200": (
                    '<tr class="log-server"><td>a</td><td>ERROR</td>'
                    '<td>[HOOT] Test "x" failed</td></tr>',
                    None,
                )
            }
        )
        svc = services.NightlyService(io, TTLCache(60))
        svc._child_detail("/runbot/batch/1/build/200", "danger")
        svc._child_detail("/runbot/batch/1/build/200", "danger")
        self.assertEqual(len(io.http_calls), 1)

    def test_build_errors_reuses_the_parent_detail_cache(self):
        # simulates builds() having already populated the parent's ("build", url)
        # cache entry — build_errors() must not fetch that same parent URL again.
        parent_url = "/runbot/batch/1/build/100"
        parent_html = (
            '<tr class="bg-success-subtle"><td><a href="/runbot/batch/1/build/200">x</a></td></tr>'
        )
        child_html = "no errors here"
        io = FakeIO(http={"build/100": (parent_html, None), "build/200": (child_html, None)})
        svc = services.NightlyService(io, TTLCache(60))
        svc._build_detail(parent_url)
        self.assertEqual(len(io.http_calls), 1)
        result = svc.build_errors(parent_url)
        self.assertEqual(result, {"errors": [], "metrics": {}})
        self.assertEqual(sum(1 for u in io.http_calls if "build/100" in u), 1)  # not refetched
        self.assertEqual(
            sum(1 for u in io.http_calls if "build/200" in u), 1
        )  # the new child fetch

    def test_builds_end_to_end_with_refresh_semantics(self):
        versions_html = (
            '<div class="row bundle_row"><i class="fa fa-star"></i>'
            '<a href="/runbot/bundle/1" title="View Bundle master">master</a></div>'
        )
        bundle_html = (
            '<div class="batch_tile" title="2026-07-01 03:00:00">'
            '<div class="slot_container">'
            '<button class="btn btn-default slot_name"><span>Qunit Community</span></button>'
            '<span class="btn btn-success disabled">ok</span>'
            '<a href="/runbot/batch/1/build/10">x</a></div>'
            "</div>"
        )
        build_html = '<tr class="bg-success-subtle"><td>x</td></tr>'
        io = FakeIO(
            http={
                "rd-1": (versions_html, None),
                "bundle/1": (bundle_html, None),
                "build/10": (build_html, None),
            }
        )
        svc = services.NightlyService(io, TTLCache(60))
        result = svc.builds(max_nights=7)
        self.assertEqual(result["versions"], ["master"])
        self.assertEqual(result["nights"][0]["versions"]["master"]["community"]["counts"]["ok"], 1)
        n_calls_after_first = len(io.http_calls)

        svc.builds(max_nights=7)  # nothing changed — everything should be cache hits
        self.assertEqual(len(io.http_calls), n_calls_after_first)

        svc.builds(max_nights=7, refresh=True)  # re-fetches versions/bundle index...
        self.assertGreater(len(io.http_calls), n_calls_after_first)
        # ...but not the already-finished build's own page
        self.assertEqual(sum(1 for u in io.http_calls if "build/10" in u), 1)


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
        # unified PullRequest shape (raw gh casing normalized at the source)
        self.assertEqual(pr["relation"], "authored")
        self.assertEqual(pr["github"], "odoo/odoo")
        self.assertEqual(pr["branch"], "br")  # headRefName → branch
        self.assertEqual(pr["state"], "open")  # OPEN → open
        self.assertFalse(pr["draft"])  # isDraft → draft
        self.assertEqual(pr["updated_at"], "x")  # snake_case on the wire

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
        self.assertEqual(prs[0]["github"], "odoo/odoo")  # nameWithOwner → github (identity)
        self.assertEqual(prs[0]["relation"], "reviewed")
        self.assertEqual(prs[0]["state"], "merged")  # MERGED → "merged"
        self.assertEqual(prs[0]["url"], "https://github.com/odoo/odoo/pull/5")
        self.assertEqual(prs[0]["branch"], "master-fix-abc")
        self.assertEqual(prs[1]["github"], "odoo/enterprise")
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
            any(
                c[:3] == ["createdb", "-T", "alpha"] and c[-1] == "alpha-copy"
                for c in svc.io.run_calls
            )
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
                # dev/master-owl-update is at the local sha (synced); a stale
                # dev/master-test points elsewhere (present remotely but NOT synced)
                "for-each-ref refs/remotes": completed(
                    stdout="master-owl-update\tabc123\nmaster\tdef456\nmaster-test\told999\n"
                ),
                "for-each-ref refs/heads": completed(
                    stdout=(
                        "master-owl-update\t2024-06-20T10:00:00\t[FIX] thing\tabc123\n"
                        "master-test\t2024-06-19T10:00:00\t[NEW] x\tnew111\n"
                    )
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
        branches = {b["name"]: b for b in entry["branches"]}
        self.assertTrue(branches["master-owl-update"]["remote"])
        self.assertTrue(branches["master-owl-update"]["synced"])  # local tip == dev ref
        # a stale same-named remote ref: present, but not what's checked out locally
        self.assertTrue(branches["master-test"]["remote"])
        self.assertFalse(branches["master-test"]["synced"])

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

    def test_checkout_notifies_timed_event(self):
        notes = []
        svc = services.GitService(
            FakeIO(), notify=lambda text, **kw: notes.append((text, kw.get("status", "")))
        )
        ok, _ = svc.checkout("/repo", "master-x", repo="community")
        self.assertTrue(ok)
        self.assertEqual(
            notes,
            [
                ("checking out master-x (community)", "start"),
                ("checking out master-x (community)", "done"),
            ],
        )

    def test_checkout_notifies_error(self):
        notes = []
        io = FakeIO(run_result=completed(returncode=1, stderr="pathspec did not match"))
        svc = services.GitService(
            io, notify=lambda text, **kw: notes.append((text, kw.get("status", "")))
        )
        ok, _ = svc.checkout("/repo", "nope", repo="community")
        self.assertFalse(ok)
        self.assertEqual(notes[-1], ("checking out nope (community)", "error"))

    def test_worktree_add_new_branch(self):
        notes = []
        io = FakeIO()
        svc = services.GitService(
            io, notify=lambda text, **kw: notes.append((text, kw.get("status", "")))
        )
        ok, err = svc.worktree_add(
            "/repo/community",
            "/wt/demo/community",
            "wt-demo",
            repo="community",
            new_branch=True,
            start_point="master",
        )
        self.assertTrue(ok)
        self.assertIsNone(err)
        # ran `git worktree add -b <branch> <wp> <start_point>`
        cmd = " ".join(io.run_calls[-1])
        self.assertIn("worktree add -b wt-demo /wt/demo/community master", cmd)
        self.assertEqual(
            notes,
            [
                ("creating worktree wt-demo (community)", "start"),
                ("creating worktree wt-demo (community)", "done"),
            ],
        )

    def test_worktree_add_existing_branch(self):
        io = FakeIO()
        ok, _ = services.GitService(io).worktree_add(
            "/repo/community", "/wt/demo/community", "19.0", repo="community"
        )
        self.assertTrue(ok)
        cmd = " ".join(io.run_calls[-1])
        self.assertIn("worktree add /wt/demo/community 19.0", cmd)
        self.assertNotIn(" -b ", cmd)

    def test_worktree_add_requires_start_point_for_new_branch(self):
        ok, err = services.GitService(FakeIO()).worktree_add(
            "/repo/community", "/wt/demo/community", "wt-demo", new_branch=True
        )
        self.assertFalse(ok)
        self.assertIn("start point", err)

    def test_worktree_add_error_notifies(self):
        notes = []
        io = FakeIO(run_result=completed(returncode=128, stderr="fatal: already checked out"))
        svc = services.GitService(
            io, notify=lambda text, **kw: notes.append((text, kw.get("status", "")))
        )
        ok, err = svc.worktree_add(
            "/repo/community",
            "/wt/demo/community",
            "wt-demo",
            repo="community",
            new_branch=True,
            start_point="master",
        )
        self.assertFalse(ok)
        self.assertIn("already checked out", err)
        self.assertEqual(notes[-1], ("creating worktree wt-demo (community)", "error"))

    def test_worktree_remove(self):
        notes = []
        io = FakeIO()
        svc = services.GitService(
            io, notify=lambda text, **kw: notes.append((text, kw.get("status", "")))
        )
        ok, _ = svc.worktree_remove("/repo/community", "/wt/demo/community", repo="community")
        self.assertTrue(ok)
        cmd = " ".join(io.run_calls[-1])
        self.assertIn("worktree remove --force /wt/demo/community", cmd)
        self.assertEqual(notes[-1], ("removing worktree (community)", "done"))

    def test_worktree_remove_error(self):
        io = FakeIO(run_result=completed(returncode=1, stderr="fatal: not a working tree"))
        ok, err = services.GitService(io).worktree_remove("/repo/community", "/wt/demo/community")
        self.assertFalse(ok)
        self.assertIn("not a working tree", err)

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
        svc = services.GitService(
            io, notify=lambda text, **kw: notes.append((text, kw.get("status", "")))
        )
        ok, _ = svc.fetch_rebase("/r", "master", "odoo/odoo", repo="community")
        self.assertTrue(ok)
        # both phases are timed events: each emits a "start" then a "done" (same text)
        self.assertEqual(
            notes,
            [
                ("fetching master (community)", "start"),
                ("fetching master (community)", "done"),
                ("rebasing community onto master", "start"),
                ("rebasing community onto master", "done"),
            ],
        )

    def test_fetch_rebase_notifies_error_on_conflict(self):
        notes = []
        io = FakeIO(
            runs={
                "master@{upstream}": completed(stdout="origin/master\n"),
                "rebase": completed(returncode=1, stderr="CONFLICT (content)\n"),
            }
        )
        svc = services.GitService(
            io, notify=lambda text, **kw: notes.append((text, kw.get("status", "")))
        )
        ok, _ = svc.fetch_rebase("/r", "master", "odoo/odoo", repo="community")
        self.assertFalse(ok)
        # the timed event still resolves — to "error" — so the spinner never hangs
        self.assertEqual(notes[-1], ("rebasing community onto master", "error"))

    def test_fetch_rebase_notifies_error_on_fetch_failure(self):
        notes = []
        io = FakeIO(
            runs={
                "master@{upstream}": completed(stdout="origin/master\n"),
                "fetch": completed(returncode=1, stderr="could not read from remote\n"),
            }
        )
        svc = services.GitService(
            io, notify=lambda text, **kw: notes.append((text, kw.get("status", "")))
        )
        ok, _ = svc.fetch_rebase("/r", "master", "odoo/odoo", repo="community")
        self.assertFalse(ok)
        # a failed fetch resolves its own timed event and never starts the rebase
        self.assertEqual(
            notes,
            [
                ("fetching master (community)", "start"),
                ("fetching master (community)", "error"),
            ],
        )


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


class AssetsServiceTest(unittest.TestCase):
    def test_bundles_parsed(self):
        out = (
            "560|web.assets_backend.min.js|/web/assets/13058d4/web.assets_backend.min.js|123456|2024-01-15 10:00:00\n"
            "561|web.assets_frontend.min.css|/web/assets/8c4eafb/web.assets_frontend.min.css|7890|2024-01-16 11:00:00\n"
        )
        svc = services.AssetsService(
            FakeIO(runs={"ir_attachment": completed(stdout=out)}), TTLCache(ttl=0)
        )
        self.assertEqual(
            svc.bundles("master"),
            [
                {
                    "id": 560,
                    "name": "web.assets_backend.min.js",
                    "url": "/web/assets/13058d4/web.assets_backend.min.js",
                    "size": 123456,
                    "created": "2024-01-15 10:00:00",
                },
                {
                    "id": 561,
                    "name": "web.assets_frontend.min.css",
                    "url": "/web/assets/8c4eafb/web.assets_frontend.min.css",
                    "size": 7890,
                    "created": "2024-01-16 11:00:00",
                },
            ],
        )

    def test_bundles_rejects_bad_db_name_without_psql(self):
        io = FakeIO(runs={"ir_attachment": completed(stdout="x")})
        svc = services.AssetsService(io, TTLCache(ttl=0))
        self.assertEqual(svc.bundles("bad name!"), [])
        self.assertEqual(io.run_calls, [])  # never reaches psql

    def test_bundles_empty_on_unreadable_db(self):
        svc = services.AssetsService(
            FakeIO(runs={"ir_attachment": completed(returncode=2)}), TTLCache(ttl=0)
        )
        self.assertEqual(svc.bundles("master"), [])

    def test_generate_commits_and_invalidates(self):
        io = FakeIO(run_result=completed(returncode=0))
        cache = TTLCache(ttl=600)
        svc = services.AssetsService(io, cache)
        ok, error = svc.generate("odoo-bin shell -d master", "master")
        self.assertTrue(ok)
        self.assertIsNone(error)
        # the pregeneration call + an explicit commit are piped to the shell's stdin
        self.assertIn("_pregenerate_assets_bundles", svc.PREGEN_SCRIPT)
        self.assertIn("env.cr.commit()", svc.PREGEN_SCRIPT)

    def test_generate_reports_failure(self):
        svc = services.AssetsService(
            FakeIO(run_result=completed(returncode=1, stderr="boom: no module\n")), TTLCache(ttl=0)
        )
        ok, error = svc.generate("odoo-bin shell -d master", "master")
        self.assertFalse(ok)
        self.assertEqual(error, "boom: no module")

    def test_breakdown_from_filestore(self):
        # psql maps the bundle's attachments to filestore files; the files carry the
        # "/* /path */" markers + a stars banner before the templates section
        psql = "web.assets_x.min.js|ab/abc|\nweb.assets_x.min.css|cd/cde|\n"
        js = '/* /a/b.js */AAAA/* /c/d.js */BB/******Templates******/registerTemplate("web.Foo")XYZ'
        css = "/* /e/f.scss */CCCCC"
        io = FakeIO(
            runs={"ir_attachment": completed(stdout=psql)},
            files={
                "/fs/db1/ab/abc": js,  # <filestore>/<db>/<store_fname>
                "/fs/db1/cd/cde": css,
            },
        )
        data, err = services.AssetsService(io, TTLCache(ttl=0)).breakdown(
            "db1", "web.assets_x", filestore="/fs"
        )
        self.assertIsNone(err)
        self.assertEqual(data["js"], [["/a/b.js", 4], ["/c/d.js", 2]])
        self.assertEqual(data["css"], [["/e/f.scss", 5]])
        self.assertEqual(data["xml"], [["web/Foo", 4]])  # ")XYZ", dotted name -> path

    def test_breakdown_scoped_to_kind(self):
        # kind scopes the read to one asset so the total matches the clicked row:
        # "js" reads only the .min.js (code + templates), "css" only the .min.css
        psql = "web.assets_x.min.js|ab/abc|\nweb.assets_x.min.css|cd/cde|\n"
        js = '/* /a/b.js */AAAA/******Templates******/registerTemplate("web.Foo")XYZ'
        css = "/* /e/f.scss */CCCCC"
        files = {"/fs/db1/ab/abc": js, "/fs/db1/cd/cde": css}
        svc = lambda: services.AssetsService(  # noqa: E731
            FakeIO(runs={"ir_attachment": completed(stdout=psql)}, files=dict(files)),
            TTLCache(ttl=0),
        )
        js_data, err = svc().breakdown("db1", "web.assets_x", filestore="/fs", kind="js")
        self.assertIsNone(err)
        self.assertEqual(js_data["js"], [["/a/b.js", 4]])
        self.assertEqual(js_data["xml"], [["web/Foo", 4]])
        self.assertEqual(js_data["css"], [])  # css not read
        css_data, err = svc().breakdown("db1", "web.assets_x", filestore="/fs", kind="css")
        self.assertIsNone(err)
        self.assertEqual(css_data["css"], [["/e/f.scss", 5]])
        self.assertEqual(css_data["js"], [])  # js not read
        self.assertEqual(css_data["xml"], [])

    def test_breakdown_rejects_bad_bundle_name(self):
        io = FakeIO(run_result=completed(stdout=""))
        data, err = services.AssetsService(io, TTLCache(ttl=0)).breakdown("db1", "bad name!")
        self.assertIsNone(data)
        self.assertEqual(io.run_calls, [])  # never reaches psql

    def test_breakdown_when_not_generated(self):
        # the attachment exists but has neither a filestore file nor inline datas
        psql = "web.assets_x.min.js||\n"
        io = FakeIO(runs={"ir_attachment": completed(stdout=psql)})
        data, err = services.AssetsService(io, TTLCache(ttl=0)).breakdown("db1", "web.assets_x")
        self.assertIsNone(data)
        self.assertIn("Generate asset bundles", err)


class ConfigStoreTest(unittest.TestCase):
    P = "/cfg/config.json"

    def test_missing_file_reads_as_rev_zero(self):
        store = services.ConfigStore(FakeIO(), self.P)
        self.assertEqual(store.get(), {"rev": 0, "config": None, "state": None})

    def test_loads_existing_file(self):
        io = FakeIO(json_files={self.P: {"rev": 5, "config": {"a": 1}, "state": {"b": 2}}})
        self.assertEqual(
            services.ConfigStore(io, self.P).get(),
            {"rev": 5, "config": {"a": 1}, "state": {"b": 2}},
        )

    def test_save_bumps_rev_and_persists(self):
        io = FakeIO()
        seen = []
        store = services.ConfigStore(io, self.P, notify=seen.append)
        ok, res = store.save(0, config={"repos": []}, state={"active_target": "t1"})
        self.assertTrue(ok)
        self.assertEqual(res["rev"], 1)
        self.assertEqual(res["config"], {"repos": []})
        self.assertEqual(io._json_files[self.P]["rev"], 1)  # actually written
        self.assertEqual([n["rev"] for n in seen], [1])  # notify fired once
        # a fresh store reads the persisted rev back
        self.assertEqual(services.ConfigStore(io, self.P).get()["rev"], 1)

    def test_stale_rev_conflicts_without_mutating(self):
        io = FakeIO(json_files={self.P: {"rev": 3, "config": {"a": 1}, "state": None}})
        seen = []
        store = services.ConfigStore(io, self.P, notify=seen.append)
        ok, res = store.save(2, config={"a": 999})  # stale rev
        self.assertFalse(ok)
        self.assertTrue(res["conflict"])
        self.assertEqual(res["rev"], 3)
        self.assertEqual(res["config"], {"a": 1})  # returns current, not the attempt
        self.assertEqual(io._json_files[self.P]["config"], {"a": 1})  # file untouched
        self.assertEqual(seen, [])  # no broadcast on conflict

    def test_state_only_save_keeps_config(self):
        io = FakeIO(json_files={self.P: {"rev": 1, "config": {"a": 1}, "state": {"x": 1}}})
        store = services.ConfigStore(io, self.P)
        ok, res = store.save(1, state={"x": 2})
        self.assertTrue(ok)
        self.assertEqual(res["config"], {"a": 1})  # config preserved
        self.assertEqual(res["state"], {"x": 2})
        self.assertEqual(res["rev"], 2)

    def test_write_failure_returns_error(self):
        io = FakeIO(fs_fail="config.json")
        ok, res = services.ConfigStore(io, self.P).save(0, config={"a": 1})
        self.assertFalse(ok)
        self.assertIn("error", res)
        self.assertNotIn("conflict", res)


class BuildStartConfigTest(unittest.TestCase):
    CFG = {
        "venv_activate": "src activate",
        "repos": [{"id": "community", "path": "/c"}, {"id": "enterprise", "path": "/e"}],
        "targets": [
            {
                "id": "t1",
                "db": "db1",
                "on_create_args": "-i sale",
                "checkouts": [
                    {"repo": "community", "branch": "master"},
                    {"repo": "enterprise", "branch": "master"},
                ],
            }
        ],
        "start": {"other_args": "--dev all"},
    }

    def test_maps_target_to_start_block(self):
        cfg = services.build_start_config(self.CFG, "t1")
        self.assertEqual(cfg["target"], "t1")
        self.assertEqual(cfg["start"]["repos"], ["community", "enterprise"])
        self.assertEqual(cfg["start"]["db"], "db1")
        self.assertEqual(cfg["start"]["on_create_args"], "-i sale")
        self.assertEqual(cfg["start"]["other_args"], "--dev all")  # from config.start
        self.assertEqual(cfg["venv_activate"], "src activate")  # scalars spread through

    def test_other_args_override(self):
        cfg = services.build_start_config(self.CFG, "t1", other_args="-u web")
        self.assertEqual(cfg["start"]["other_args"], "-u web")

    def test_unknown_target_is_none(self):
        self.assertIsNone(services.build_start_config(self.CFG, "nope"))


if __name__ == "__main__":
    unittest.main()
