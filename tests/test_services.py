"""Unit tests for the services layer — the payoff of the IO seam: each service is
exercised against a FakeIO, so there's no real subprocess, network, or sleep.

Run from the repo root: `python3 -m unittest discover`
"""

import json
import os
import pathlib
import re
import subprocess
import threading
import time
import unittest
import unittest.mock
from dataclasses import asdict

from backend import services
from backend.cache import TTLCache
from backend.models import RunSnapshot, ServerSnapshot


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
        self.run_kwargs = []  # kwargs (env, timeout, …) passed alongside each run_calls entry
        self.http_calls = []
        self.logs = []
        self.fs_ops = []  # recorded (op, src, dst) filesystem mutations

    def log_request(self, target):
        pass

    def log(self, message):
        self.logs.append(message)

    def run(self, cmd, **kwargs):
        self.run_calls.append(cmd)
        self.run_kwargs.append(kwargs)
        joined = cmd if isinstance(cmd, str) else " ".join(str(c) for c in cmd)
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
        states, details, forward_ports, unsupported = svc.statuses(
            [{"github": "odoo/odoo", "number": 1}]
        )
        self.assertEqual(states, {"odoo/odoo#1": "merged"})
        self.assertEqual(details, {})  # no `todo` checklist → no blocking detail
        self.assertEqual(forward_ports, {"odoo/odoo#1": []})
        self.assertEqual(unsupported, [])

    def test_blocked(self):
        io = FakeIO(http={"pull": ('<p class="bg-warning">blocked: CI</p>', None)})
        svc = services.MergebotService(io, TTLCache(ttl=0))
        states, details, forward_ports, unsupported = svc.statuses([{"github": "o/o", "number": 7}])
        self.assertEqual(states, {"o/o#7": "blocked"})
        self.assertEqual(forward_ports, {"o/o#7": []})
        self.assertEqual(unsupported, [])

    def test_blocked_reasons_lists_unmet_requirements(self):
        # the real mergebot page renders a `todo` checklist; the unmet top-level <li>
        # (class != "ok") are the blocking reasons. Whitespace is collapsed; satisfied
        # items and the nested per-CI-check <li> (they start with <a>) are excluded.
        html = (
            '<p class="text-danger bg-danger">Blocked</p>'
            "<ul><li>Description bullet, not a merge requirement</li></ul>"
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
        states, details, forward_ports, unsupported = svc.statuses(
            [{"github": "odoo/enterprise", "number": 9}]
        )
        self.assertEqual(states, {"odoo/enterprise#9": "blocked"})
        self.assertEqual(details, {"odoo/enterprise#9": "Review, CI"})
        self.assertEqual(forward_ports, {"odoo/enterprise#9": []})
        self.assertEqual(unsupported, [])

    def test_forward_ports_lists_every_subsequent_branch_and_linked_repo(self):
        html = """
            <div class="alert alert-success">Merged</div>
            <table class="table table-bordered table-sm">
              <thead><tr><th></th><th>odoo/odoo</th><th>odoo/enterprise</th></tr></thead>
              <tbody>
                <tr><td>16.0</td>
                  <td class="table-success"><span title="merged at yesterday">
                    <a href="/odoo/odoo/pull/275568">#275568</a></span></td>
                  <td class="table-success"><span title="merged at yesterday">
                    <a href="/odoo/enterprise/pull/90000">#90000</a></span></td>
                </tr>
                <tr><td>17.0</td>
                  <td class="table-warning"><span title="approved, is not ready">
                    <a href="/odoo/odoo/pull/275660">#275660</a>
                    <sup class="text-danger">missing statuses</sup></span></td>
                  <td></td>
                </tr>
                <tr><td>18.0</td><td></td><td></td></tr>
                <tr><td>master</td>
                  <td class="table-success"><span title="merged at today">
                    <a href="/odoo/odoo/pull/275999">#275999</a></span></td>
                  <td></td>
                </tr>
              </tbody>
            </table>
        """
        svc = services.MergebotService(FakeIO(http={"pull": (html, None)}), TTLCache(ttl=0))
        states, _, forward_ports, _ = svc.statuses([{"github": "odoo/odoo", "number": 275568}])
        self.assertEqual(states, {"odoo/odoo#275568": "merged"})
        self.assertEqual(
            forward_ports["odoo/odoo#275568"],
            [
                {
                    "branch": "17.0",
                    "cells": [
                        {
                            "repository": "odoo/odoo",
                            "pulls": [
                                {
                                    "github": "odoo/odoo",
                                    "number": 275660,
                                    "status": "approved, is not ready",
                                    "detail": "missing statuses",
                                    "category": "warning",
                                }
                            ],
                        },
                        {"repository": "odoo/enterprise", "pulls": []},
                    ],
                },
                {
                    "branch": "18.0",
                    "cells": [
                        {"repository": "odoo/odoo", "pulls": []},
                        {"repository": "odoo/enterprise", "pulls": []},
                    ],
                },
                {
                    "branch": "master",
                    "cells": [
                        {
                            "repository": "odoo/odoo",
                            "pulls": [
                                {
                                    "github": "odoo/odoo",
                                    "number": 275999,
                                    "status": "merged at today",
                                    "detail": "",
                                    "category": "success",
                                }
                            ],
                        },
                        {"repository": "odoo/enterprise", "pulls": []},
                    ],
                },
            ],
        )

    def test_transient_failure_is_blank_not_unsupported(self):
        svc = services.MergebotService(FakeIO(http={"pull": ("", "down")}), TTLCache(ttl=0))
        states, details, forward_ports, unsupported = svc.statuses([{"github": "o/o", "number": 7}])
        self.assertEqual(states, {"o/o#7": ""})
        self.assertEqual(details, {})
        self.assertEqual(forward_ports, {})
        self.assertEqual(unsupported, [])  # a non-404 error is transient, not "no mergebot"

    def test_404_marks_repo_unsupported(self):
        io = FakeIO(http={"pull": ("", "HTTP Error 404: Not Found")})
        svc = services.MergebotService(io, TTLCache(ttl=0))
        states, details, forward_ports, unsupported = svc.statuses(
            [{"github": "odoo/owl", "number": 5}]
        )
        self.assertEqual(states, {"odoo/owl#5": ""})
        self.assertEqual(forward_ports, {})
        self.assertEqual(unsupported, ["odoo/owl"])

    def test_404_blank_is_not_cached(self):
        # a fresh PR 404s until mergebot indexes it (minutes) — pinning that blank
        # for the full TTL would hide the real state for hours. The 404 must be
        # re-fetched on the next ask; a real state stays cached.
        io = FakeIO(
            http={
                "pull/1": ("", "HTTP Error 404: Not Found"),
                "pull/2": ('<div class="alert alert-success">merged</div>', None),
            }
        )
        svc = services.MergebotService(io, TTLCache(ttl=3600))
        prs = [{"github": "odoo/odoo", "number": 1}, {"github": "odoo/odoo", "number": 2}]
        svc.statuses(prs)
        svc.statuses(prs)
        self.assertEqual(len([u for u in io.http_calls if "pull/1" in u]), 2)  # re-fetched
        self.assertEqual(len([u for u in io.http_calls if "pull/2" in u]), 1)  # cached

    def test_reachable_sibling_keeps_repo_supported(self):
        # one PR 404s but another in the same repo loads → repo is NOT unsupported
        io = FakeIO(
            http={
                "pull/1": ('<div class="alert alert-success">merged</div>', None),
                "pull/2": ("", "HTTP Error 404: Not Found"),
            }
        )
        svc = services.MergebotService(io, TTLCache(ttl=0))
        states, details, forward_ports, unsupported = svc.statuses(
            [{"github": "odoo/odoo", "number": 1}, {"github": "odoo/odoo", "number": 2}]
        )
        self.assertEqual(states, {"odoo/odoo#1": "merged", "odoo/odoo#2": ""})
        self.assertEqual(forward_ports, {"odoo/odoo#1": []})
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

    def test_prs_for_branches_resolves_by_head_ref(self):
        # two PRs share the head ref: a closed old one and an open live one — the
        # open PR wins, and it comes back as a head-relation PullRequest
        payload = (
            '[{"number": 10, "title": "old", "url": "u10", "state": "CLOSED", "isDraft": false,'
            ' "headRefName": "br-fw", "createdAt": "a", "updatedAt": "2026-01-01T00:00:00Z"},'
            '{"number": 20, "title": "fw port", "url": "u20", "state": "OPEN", "isDraft": false,'
            ' "headRefName": "br-fw", "createdAt": "b", "updatedAt": "2026-02-01T00:00:00Z"}]'
        )
        io = FakeIO(run_result=completed(stdout=payload))
        svc = services.GitHubService(io, TTLCache(ttl=0))
        prs = svc.prs_for_branches([{"github": "odoo/odoo", "branch": "br-fw"}])
        self.assertEqual(len(prs), 1)
        self.assertEqual(prs[0]["number"], 20)  # open PR preferred over closed
        self.assertEqual(prs[0]["relation"], "head")
        self.assertEqual(prs[0]["branch"], "br-fw")
        self.assertEqual(prs[0]["state"], "open")
        # queried by head ref, not by author
        joined = " ".join(str(c) for c in io.run_calls[0])
        self.assertIn("--head", joined)
        self.assertIn("br-fw", joined)
        self.assertNotIn("@me", joined)

    def test_prs_for_branches_omits_branches_without_a_pr(self):
        io = FakeIO(run_result=completed(stdout="[]"))
        svc = services.GitHubService(io, TTLCache(ttl=0))
        prs = svc.prs_for_branches([{"github": "odoo/odoo", "branch": "no-pr"}])
        self.assertEqual(prs, [])

    def test_prs_for_branches_dedups_and_caches(self):
        io = FakeIO(run_result=completed(stdout="[]"))
        svc = services.GitHubService(io, TTLCache(ttl=600))
        pairs = [
            {"github": "odoo/odoo", "branch": "br"},
            {"github": "odoo/odoo", "branch": "br"},  # duplicate — one gh call
        ]
        svc.prs_for_branches(pairs)
        svc.prs_for_branches(pairs)  # served from cache — still one gh call
        self.assertEqual(len(io.run_calls), 1)

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

    def test_post_r_plus_comments_through_gh(self):
        io = FakeIO(run_result=completed())
        svc = services.GitHubService(io, TTLCache(ttl=600))
        ok, error = svc.post_r_plus("odoo/odoo", 275826)
        self.assertTrue(ok)
        self.assertIsNone(error)
        self.assertEqual(
            io.run_calls,
            [
                [
                    "gh",
                    "pr",
                    "comment",
                    "275826",
                    "--repo",
                    "odoo/odoo",
                    "--body",
                    "robodoo r+",
                ]
            ],
        )

    def test_post_r_plus_surfaces_gh_failure(self):
        io = FakeIO(run_result=completed(returncode=1, stderr="not allowed"))
        svc = services.GitHubService(io, TTLCache(ttl=600))
        self.assertEqual(svc.post_r_plus("odoo/odoo", 275826), (False, "not allowed"))


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
            "latest_version": completed(stdout="17.0|f|t|2024-06-20T10:00:00\n"),  # odoo_info
        }
        runs.update(extra)
        return FakeIO(runs=runs, dirs=dirs, fs_fail=fs_fail)

    def test_databases_lists_with_info(self):
        svc = services.DatabaseService(self._io(), TTLCache(ttl=0))
        dbs = svc.databases()
        self.assertEqual([d["name"] for d in dbs], ["alpha", "beta"])
        self.assertEqual(dbs[0]["odoo_version"], "17.0")
        self.assertTrue(dbs[0]["demo_data"])
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


class ParseGithubSlugTest(unittest.TestCase):
    def test_ssh_form(self):
        self.assertEqual(
            services.parse_github_slug("git@github.com:someone/documentation.git"),
            "someone/documentation",
        )

    def test_https_form(self):
        self.assertEqual(
            services.parse_github_slug("https://github.com/someone/documentation.git"),
            "someone/documentation",
        )

    def test_https_form_without_dot_git_suffix(self):
        self.assertEqual(
            services.parse_github_slug("https://github.com/someone/documentation"),
            "someone/documentation",
        )

    def test_ssh_protocol_form(self):
        self.assertEqual(
            services.parse_github_slug("ssh://git@github.com/someone/documentation.git"),
            "someone/documentation",
        )

    def test_non_github_url_returns_none(self):
        self.assertIsNone(services.parse_github_slug("https://gitlab.com/someone/documentation"))

    def test_blank_returns_none(self):
        self.assertIsNone(services.parse_github_slug(""))
        self.assertIsNone(services.parse_github_slug(None))


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

    def test_branches_resolves_push_github_from_ssh_remote(self):
        io = FakeIO(
            runs={
                "branch --show-current": completed(stdout="master-x\n"),
                "remote get-url dev": completed(
                    stdout="git@github.com:someone/documentation.git\n"
                ),
            }
        )
        [entry] = services.GitService(io).branches(
            [{"id": "documentation", "path": "/repo", "push_remote": "dev"}]
        )
        self.assertEqual(entry["push_github"], "someone/documentation")

    def test_branches_resolves_push_github_from_https_remote(self):
        io = FakeIO(
            runs={
                "branch --show-current": completed(stdout="master-x\n"),
                "remote get-url dev": completed(
                    stdout="https://github.com/someone/documentation\n"
                ),
            }
        )
        [entry] = services.GitService(io).branches(
            [{"id": "documentation", "path": "/repo", "push_remote": "dev"}]
        )
        self.assertEqual(entry["push_github"], "someone/documentation")

    def test_branches_uses_the_configured_push_remote_name(self):
        io = FakeIO(
            runs={
                "branch --show-current": completed(stdout="master-x\n"),
                "remote get-url upstream-dev": completed(
                    stdout="git@github.com:someone/enterprise.git\n"
                ),
            }
        )
        [entry] = services.GitService(io).branches(
            [{"id": "enterprise", "path": "/repo", "push_remote": "upstream-dev"}]
        )
        # only matches because the call used "upstream-dev", not the "dev" default
        self.assertEqual(entry["push_github"], "someone/enterprise")

    def test_branches_push_github_none_when_remote_missing(self):
        io = FakeIO(
            runs={
                "branch --show-current": completed(stdout="master-x\n"),
                "remote get-url dev": completed(returncode=128, stderr="No such remote"),
            }
        )
        [entry] = services.GitService(io).branches([{"id": "community", "path": "/repo"}])
        self.assertIsNone(entry["push_github"])

    def test_branches_reports_not_a_repo(self):
        io = FakeIO(
            runs={"branch --show-current": completed(returncode=128, stderr="not a git repo")}
        )
        [entry] = services.GitService(io).branches([{"id": "x", "path": "/nope"}])
        self.assertEqual(entry["error"], "not a git repo")

    def test_branches_compares_against_configured_pull_remote(self):
        io = FakeIO(runs={"branch --show-current": completed(stdout="master-x\n")})
        services.GitService(io).branches(
            [{"id": "community", "path": "/repo", "pull_remote": "upstream"}]
        )
        [ahead_behind] = [c for c in io.run_calls if "--left-right" in " ".join(c)]
        self.assertIn("upstream/master...HEAD", " ".join(ahead_behind))

    def test_branches_defaults_pull_remote_to_origin(self):
        io = FakeIO(runs={"branch --show-current": completed(stdout="master-x\n")})
        services.GitService(io).branches([{"id": "community", "path": "/repo"}])
        [ahead_behind] = [c for c in io.run_calls if "--left-right" in " ".join(c)]
        self.assertIn("origin/master...HEAD", " ".join(ahead_behind))

    def test_checkout_error(self):
        io = FakeIO(
            run_result=completed(returncode=1, stderr="error: pathspec 'nope' did not match")
        )
        ok, err = services.GitService(io).checkout("/repo", "nope")
        self.assertFalse(ok)
        self.assertIn("pathspec", err)

    def test_wip_commit_uses_bracketed_message(self):
        io = FakeIO(run_result=completed())
        ok, err = services.GitService(io).wip_commit("/repo")
        self.assertTrue(ok)
        self.assertIsNone(err)
        [commit_call] = [c for c in io.run_calls if "commit" in c]
        self.assertIn("[WIP]", commit_call)

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

    def test_delete_branch_pushes_delete_to_push_remote(self):
        io = FakeIO()
        ok, err, remote_err = services.GitService(io).delete_branch(
            "/r", "b", delete_remote=True, push_remote="fork"
        )
        self.assertEqual((ok, err, remote_err), (True, None, None))
        self.assertTrue(any("push fork --delete b" in " ".join(c) for c in io.run_calls))

    def test_delete_branch_remote_defaults_to_dev(self):
        io = FakeIO()
        ok, _, _ = services.GitService(io).delete_branch("/r", "b", delete_remote=True)
        self.assertTrue(ok)
        self.assertTrue(any("push dev --delete b" in " ".join(c) for c in io.run_calls))

    def test_delete_branch_refuses_remote_delete_of_base_branch(self):
        # the local branch still goes; the remote base branch is never touched
        io = FakeIO()
        ok, err, remote_err = services.GitService(io).delete_branch(
            "/r", "saas-19.4", delete_remote=True
        )
        self.assertTrue(ok)
        self.assertIsNone(err)
        self.assertIn("refusing to delete base branch", remote_err)
        self.assertFalse(any("push" in " ".join(c) for c in io.run_calls))

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
                "ahead": False,
            },
        )

    def test_log_marks_commits_ahead_of_base(self):
        rec = (
            "sha1\x1fAlice\x1f2024-06-20\x1f[FIX] a\x1f\x1e"
            "sha2\x1fAlice\x1f2024-06-19\x1f[FIX] b\x1f\x1e"
        )
        io = FakeIO(
            runs={
                "git -C /r log": completed(stdout=rec),
                "rev-list origin/master..HEAD": completed(stdout="sha1\n"),
            }
        )
        commits, err = services.GitService(io).log("/r", base="master")
        self.assertIsNone(err)
        self.assertTrue(commits[0]["ahead"])  # sha1 — unique to this branch
        self.assertFalse(commits[1]["ahead"])  # sha2 — inherited from base

    def test_log_falls_back_to_local_base_branch(self):
        rec = "sha1\x1fAlice\x1f2024-06-20\x1f[FIX] a\x1f\x1e"
        io = FakeIO(
            runs={
                "git -C /r log": completed(stdout=rec),
                # no fetched origin/master ref locally; only the bare local branch
                "rev-list origin/master..HEAD": completed(
                    returncode=128, stderr="unknown revision"
                ),
                "rev-list master..HEAD": completed(stdout="sha1\n"),
            }
        )
        commits, err = services.GitService(io).log("/r", base="master")
        self.assertIsNone(err)
        self.assertTrue(commits[0]["ahead"])

    def test_log_conservatively_marks_nothing_ahead_when_base_unresolvable(self):
        rec = "sha1\x1fAlice\x1f2024-06-20\x1f[FIX] a\x1f\x1e"
        io = FakeIO(
            runs={
                "git -C /r log": completed(stdout=rec),
                "rev-list": completed(returncode=128, stderr="unknown revision"),
            }
        )
        commits, err = services.GitService(io).log("/r", base="master")
        self.assertIsNone(err)
        self.assertFalse(commits[0]["ahead"])

    def test_log_without_base_marks_nothing_ahead(self):
        rec = "sha1\x1fAlice\x1f2024-06-20\x1f[FIX] a\x1f\x1e"
        io = FakeIO(runs={"git -C /r log": completed(stdout=rec)})
        commits, err = services.GitService(io).log("/r")
        self.assertIsNone(err)
        self.assertFalse(commits[0]["ahead"])
        self.assertFalse(any("rev-list" in " ".join(c) for c in io.run_calls))

    def test_reword_commit_writes_amend_trailer_and_autosquashes(self):
        io = FakeIO()
        ok, err = services.GitService(io).reword_commit("/r", "abc123", "new message")
        self.assertTrue(ok)
        self.assertIsNone(err)
        fixup_call = next(c for c in io.run_calls if "--fixup" in " ".join(c))
        self.assertIn("--allow-empty", fixup_call)
        self.assertIn("--fixup=reword:abc123", fixup_call)
        rebase_call = next(c for c in io.run_calls if "rebase" in c)
        self.assertIn("--autosquash", rebase_call)
        self.assertIn("--autostash", rebase_call)
        self.assertIn("abc123^", rebase_call)
        # the fixup step's editor is pointed at a prepared file (never at the raw
        # message directly, avoiding any shell-embedding of arbitrary content)
        fixup_kwargs = io.run_kwargs[io.run_calls.index(fixup_call)]
        editor = fixup_kwargs["env"]["GIT_EDITOR"]
        self.assertTrue(editor.startswith("cp "))
        tmp_path = editor[len("cp ") :].strip()
        # the temp file is cleaned up by the time reword_commit returns
        self.assertFalse(os.path.exists(tmp_path))
        # the no-op editors for the rebase step, so autosquash's own todo/message
        # is accepted without ever opening a real editor
        rebase_kwargs = io.run_kwargs[io.run_calls.index(rebase_call)]
        self.assertEqual(rebase_kwargs["env"]["GIT_SEQUENCE_EDITOR"], "true")
        self.assertEqual(rebase_kwargs["env"]["GIT_EDITOR"], "true")

    def test_reword_commit_trailer_uses_full_sha_not_subject(self):
        # autosquash matches "amend! <text>" against ancestor SUBJECTS by default —
        # ambiguous the moment two commits share one (e.g. several "[WIP]" commits).
        # Using the full sha there instead must be exact, so read the file the
        # fixup step's GIT_EDITOR="cp <file>" would copy, while it still exists
        # (reword_commit deletes it once both git calls are done).
        written = {}

        class CapturingIO(FakeIO):
            def run(self, cmd, **kwargs):
                editor = (kwargs.get("env") or {}).get("GIT_EDITOR", "")
                if editor.startswith("cp ") and "--fixup" in " ".join(cmd):
                    with open(editor[len("cp ") :].strip()) as f:
                        written["content"] = f.read()
                return super().run(cmd, **kwargs)

        io = CapturingIO()
        ok, err = services.GitService(io).reword_commit("/r", "abc123def", "hello")
        self.assertTrue(ok)
        self.assertIsNone(err)
        self.assertEqual(written["content"], "amend! abc123def\n\nhello\n")

    def test_reword_commit_refuses_when_not_ahead_of_base(self):
        io = FakeIO(runs={"rev-list origin/master..HEAD": completed(stdout="other-sha\n")})
        ok, err = services.GitService(io).reword_commit(
            "/r", "abc123", "new message", base="master"
        )
        self.assertFalse(ok)
        self.assertIn("refusing", err)
        self.assertFalse(any("--fixup" in " ".join(c) for c in io.run_calls))

    def test_reword_commit_allowed_when_ahead_of_base(self):
        io = FakeIO(runs={"rev-list origin/master..HEAD": completed(stdout="abc123\n")})
        ok, err = services.GitService(io).reword_commit(
            "/r", "abc123", "new message", base="master"
        )
        self.assertTrue(ok)
        self.assertIsNone(err)

    def test_push_branch_pushes_to_push_remote(self):
        io = FakeIO()
        ok, err = services.GitService(io).push_branch("/r", "master-x", push_remote="fork")
        self.assertEqual((ok, err), (True, None))
        self.assertIn("push --set-upstream fork master-x", " ".join(io.run_calls[-1]))

    def test_push_branch_defaults_to_dev_and_supports_force(self):
        io = FakeIO()
        ok, _ = services.GitService(io).push_branch("/r", "master-x", force=True)
        self.assertTrue(ok)
        self.assertIn(
            "push --set-upstream --force-with-lease dev master-x", " ".join(io.run_calls[-1])
        )

    def test_push_branch_refuses_base_branches(self):
        for base in ("master", "saas-19.4", "17.0"):
            io = FakeIO()
            ok, err = services.GitService(io).push_branch("/r", base)
            self.assertFalse(ok)
            self.assertEqual(err, f"refusing to push base branch {base}")
            self.assertEqual(io.run_calls, [])  # never reaches git

    def test_push_branch_allows_base_prefixed_work_branches(self):
        for branch in ("master-foo", "17.0-fix-x", "saas-19.4-imp-y"):
            io = FakeIO()
            ok, err = services.GitService(io).push_branch("/r", branch)
            self.assertEqual((ok, err), (True, None))

    def test_remote_branch_exists_queries_push_remote(self):
        io = FakeIO(runs={"ls-remote": completed(stdout="abc\trefs/heads/master-x\n")})
        exists, err = services.GitService(io).remote_branch_exists(
            "/r", "master-x", push_remote="fork"
        )
        self.assertEqual((exists, err), (True, None))
        self.assertIn("ls-remote --heads fork master-x", " ".join(io.run_calls[-1]))

    def test_fetch_remote_branch_uses_pull_remote(self):
        io = FakeIO()
        ok, err = services.GitService(io).fetch_remote_branch(
            "/r", "master-x", pull_remote="upstream"
        )
        self.assertEqual((ok, err), (True, None))
        self.assertIn("fetch upstream master-x:master-x", " ".join(io.run_calls[-1]))

    def test_fetch_master_uses_pull_remote(self):
        io = FakeIO()
        services.GitService(io).fetch_master(
            {"id": "community", "path": "/r", "pull_remote": "upstream"}
        )
        self.assertIn("fetch upstream master", " ".join(io.run_calls[-1]))

    def test_create_branch_fetches_remote_start_point_first(self):
        notes = []
        io = FakeIO(
            runs={
                "ls-remote --exit-code --heads origin master": completed(
                    stdout="abc123\trefs/heads/master\n"
                ),
                "fetch origin master": completed(),
            }
        )
        svc = services.GitService(
            io, notify=lambda text, **kw: notes.append((text, kw.get("status", "")))
        )
        ok, err = svc.create_branch(
            "/r", "master-feature", "master", fresh_start=True, repo="community"
        )
        self.assertTrue(ok)
        self.assertIsNone(err)
        self.assertIn("branch master-feature FETCH_HEAD", " ".join(io.run_calls[-1]))
        self.assertEqual(
            notes,
            [
                ("fetching master (community)", "start"),
                ("fetching master (community)", "done"),
            ],
        )

    def test_create_branch_fetches_start_point_from_custom_pull_remote(self):
        io = FakeIO(
            runs={
                "ls-remote --exit-code --heads upstream master": completed(
                    stdout="abc123\trefs/heads/master\n"
                ),
                "fetch upstream master": completed(),
            }
        )
        ok, err = services.GitService(io).create_branch(
            "/r", "master-feature", "master", fresh_start=True, pull_remote="upstream"
        )
        self.assertEqual((ok, err), (True, None))
        joined = [" ".join(c) for c in io.run_calls]
        self.assertTrue(any("ls-remote --exit-code --heads upstream master" in c for c in joined))
        self.assertTrue(any("fetch upstream master" in c for c in joined))

    def test_worktree_uses_local_start_point_when_remote_branch_is_absent(self):
        io = FakeIO(
            runs={
                "ls-remote --exit-code --heads origin local-base": completed(returncode=2),
            }
        )
        ok, err = services.GitService(io).worktree_add(
            "/r",
            "/wt/feature",
            "feature",
            new_branch=True,
            start_point="local-base",
            fresh_start=True,
        )
        self.assertTrue(ok)
        self.assertIsNone(err)
        self.assertIn("worktree add -b feature /wt/feature local-base", " ".join(io.run_calls[-1]))
        self.assertFalse(any(" fetch " in f" {' '.join(c)} " for c in io.run_calls))

    def test_remote_start_lookup_failure_does_not_fall_back_to_local(self):
        io = FakeIO(
            runs={
                "ls-remote --exit-code --heads origin master": completed(
                    returncode=128, stderr="could not read from remote"
                ),
            }
        )
        ok, err = services.GitService(io).create_branch("/r", "feature", "master", fresh_start=True)
        self.assertFalse(ok)
        self.assertIn("could not read", err)
        self.assertFalse(any(" branch feature " in f" {' '.join(c)} " for c in io.run_calls))

    def test_remote_start_fetch_failure_does_not_use_stale_local_branch(self):
        notes = []
        io = FakeIO(
            runs={
                "ls-remote --exit-code --heads origin master": completed(
                    stdout="abc123\trefs/heads/master\n"
                ),
                "fetch origin master": completed(returncode=1, stderr="fetch failed"),
            }
        )
        svc = services.GitService(
            io, notify=lambda text, **kw: notes.append((text, kw.get("status", "")))
        )
        ok, err = svc.create_branch("/r", "feature", "master", fresh_start=True)
        self.assertFalse(ok)
        self.assertEqual(err, "fetch failed")
        self.assertEqual(notes[-1], ("fetching master (r)", "error"))
        self.assertFalse(any(" branch feature " in f" {' '.join(c)} " for c in io.run_calls))

    def test_fetch_rebase_notifies_phases(self):
        notes = []
        io = FakeIO()
        svc = services.GitService(
            io, notify=lambda text, **kw: notes.append((text, kw.get("status", "")))
        )
        ok, _ = svc.fetch_rebase("/r", "master", repo="community")
        self.assertTrue(ok)
        self.assertTrue(any("fetch origin master" in " ".join(c) for c in io.run_calls))
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

    def test_fetch_rebase_fetches_from_custom_pull_remote(self):
        io = FakeIO()
        ok, _ = services.GitService(io).fetch_rebase(
            "/r", "master", pull_remote="upstream", repo="community"
        )
        self.assertTrue(ok)
        self.assertTrue(any("fetch upstream master" in " ".join(c) for c in io.run_calls))

    def test_fetch_rebase_notifies_error_on_conflict(self):
        notes = []
        io = FakeIO(
            runs={
                "rebase": completed(returncode=1, stderr="CONFLICT (content)\n"),
            }
        )
        svc = services.GitService(
            io, notify=lambda text, **kw: notes.append((text, kw.get("status", "")))
        )
        ok, _ = svc.fetch_rebase("/r", "master", repo="community")
        self.assertFalse(ok)
        # the timed event still resolves — to "error" — so the spinner never hangs
        self.assertEqual(notes[-1], ("rebasing community onto master", "error"))

    def test_fetch_rebase_notifies_error_on_fetch_failure(self):
        notes = []
        io = FakeIO(
            runs={
                "fetch": completed(returncode=1, stderr="could not read from remote\n"),
            }
        )
        svc = services.GitService(
            io, notify=lambda text, **kw: notes.append((text, kw.get("status", "")))
        )
        ok, _ = svc.fetch_rebase("/r", "master", repo="community")
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


class RustBundlerServiceTest(unittest.TestCase):
    SOURCE = "/goo path/addons/rust_bundler/native"
    CARGO = '[package]\nname = "goo_odoo_bundler"\nversion = "0.1.0"\n'

    def service(self, io=None, notify=None):
        io = io or FakeIO()
        io._files[f"{self.SOURCE}/Cargo.toml"] = self.CARGO
        return services.RustBundlerService(io, self.SOURCE, notify=notify), io

    def test_addon_and_native_versions_stay_in_sync(self):
        root = pathlib.Path(__file__).parents[1] / "addons" / "rust_bundler"
        cargo = (root / "native" / "Cargo.toml").read_text()
        addon = (root / "models" / "assetsbundle.py").read_text()
        cargo_version = re.search(r'(?ms)^\[package\].*?^version\s*=\s*"([^"]+)"', cargo)
        addon_version = re.search(r'^NATIVE_VERSION\s*=\s*"([^"]+)"', addon, re.MULTILINE)
        self.assertEqual(cargo_version.group(1), addon_version.group(1))

    def test_install_command_targets_configured_environment_and_quotes_source(self):
        svc, _io = self.service()
        command = svc.install_command({"venv_activate": "source /env/bin/activate"})
        self.assertTrue(command.startswith("source /env/bin/activate && python3 -m pip"))
        self.assertIn("--force-reinstall --no-deps", command)
        self.assertIn("'/goo path/addons/rust_bundler/native'", command)
        self.assertEqual(
            svc.install_command({}),
            "python3 -m pip install --force-reinstall --no-deps "
            "'/goo path/addons/rust_bundler/native'",
        )

    def test_status_distinguishes_missing_current_and_stale(self):
        missing, _io = self.service(FakeIO(run_result=completed(returncode=1)))
        self.assertEqual(
            missing.status({}),
            {
                "installed": False,
                "current": False,
                "version": "",
                "expected_version": "0.1.0",
                "building": False,
            },
        )

        current, _io = self.service(FakeIO(run_result=completed('{"version":"0.1.0"}\n')))
        self.assertTrue(current.status({})["current"])

        stale, _io = self.service(FakeIO(run_result=completed('{"version":"0.0.9"}\n')))
        status = stale.status({})
        self.assertTrue(status["installed"])
        self.assertFalse(status["current"])
        self.assertEqual(status["version"], "0.0.9")

    def test_successful_install_is_verified_and_notified(self):
        io = FakeIO(
            runs={
                "pip install": completed(),
                "python3 -c": completed('{"version":"0.1.0"}\n'),
            }
        )
        events = []
        svc, _io = self.service(io, notify=lambda *args: events.append(args))
        ok, result = svc.install({"venv_activate": "source /env/bin/activate"})
        self.assertTrue(ok)
        self.assertTrue(result["current"])
        self.assertTrue(result["restart_required"])
        self.assertEqual([event[3] for event in events], ["start", "done"])
        self.assertEqual(len(io.run_calls), 2)  # pip, then exact-version probe

    def test_install_failure_returns_output_tail(self):
        svc, _io = self.service(
            FakeIO(runs={"pip install": completed(returncode=1, stderr="first\nlast failure\n")})
        )
        ok, result = svc.install({})
        self.assertFalse(ok)
        self.assertIn("last failure", result["error"])

    def test_install_verification_rejects_stale_module(self):
        io = FakeIO(
            runs={
                "pip install": completed(),
                "python3 -c": completed('{"version":"0.0.9"}\n'),
            }
        )
        svc, _io = self.service(io)
        ok, result = svc.install({})
        self.assertFalse(ok)
        self.assertFalse(result["current"])
        self.assertIn("verified", result["error"])

    def test_timeout_and_concurrent_install_are_reported(self):
        class TimeoutIO(FakeIO):
            def run(self, cmd, **kwargs):
                raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout"))

        timeout_svc, _io = self.service(TimeoutIO())
        ok, result = timeout_svc.install({})
        self.assertFalse(ok)
        self.assertIn("timed out", result["error"])

        locked_svc, _io = self.service()
        locked_svc._build_lock.acquire()
        try:
            ok, result = locked_svc.install({})
        finally:
            locked_svc._build_lock.release()
        self.assertFalse(ok)
        self.assertIn("already in progress", result["error"])


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


class WorkspaceResolutionTest(unittest.TestCase):
    """build_start_config resolves the canonical `workspaces` list and forwards a
    worktree workspace's stable port."""

    CFG = {
        "worktree_dir": "/wt",
        "repos": [
            {"id": "community", "path": "/c", "github": "odoo/odoo"},
            {"id": "enterprise", "path": "/e", "github": "odoo/enterprise"},
        ],
        "workspaces": [
            {
                "id": "w1",
                "name": "w1",
                "db": "wdb1",
                "location": "main",
                "checkouts": [{"repo": "community", "branch": "master"}],
            },
            {
                "id": "ww1",
                "name": "feature-x",
                "db": "wwdb",
                "location": "worktree",
                "worktree": {"base": "w1", "dir": "/wt/feature-x"},
                "port": 8071,
                "checkouts": [{"repo": "community", "branch": "feat"}],
            },
            {
                "id": "ww2",
                "name": "feature-y",
                "db": "wydb",
                "location": "worktree",
                "worktree": {"base": "w1", "dir": "/wt/feature-y"},
                "checkouts": [{"repo": "community", "branch": "feat-y"}],
            },
            {
                "id": "w2",
                "name": "w2",
                "db": "wdb2",
                "location": "main",
                "demo_data": False,
                "on_create_args": "-i sale",
                "checkouts": [
                    {"repo": "community", "branch": "master"},
                    {"repo": "enterprise", "branch": "master"},
                ],
            },
        ],
        "start": {"other_args": "--dev all"},
    }

    def test_plain_workspace_resolves(self):
        cfg = services.build_start_config(self.CFG, "w1")
        self.assertEqual(cfg["workspace"], "w1")
        self.assertEqual(cfg["start"]["db"], "wdb1")
        self.assertEqual(cfg["repos"], self.CFG["repos"])  # main-located: paths untouched
        self.assertNotIn("worktree_port", cfg)

    def test_maps_workspace_to_start_block(self):
        cfg = services.build_start_config(self.CFG, "w2")
        self.assertEqual(cfg["start"]["repos"], ["community", "enterprise"])
        self.assertEqual(cfg["start"]["on_create_args"], "-i sale")
        self.assertEqual(cfg["start"]["other_args"], "--dev all")  # from config.start
        self.assertFalse(cfg["start"]["demo_data"])

    def test_overrides(self):
        cfg = services.build_start_config(
            self.CFG, "w1", {"other_args": "-u web", "test_tags": "web"}
        )
        self.assertEqual(cfg["start"]["other_args"], "-u web")
        self.assertEqual(cfg["start"]["test_tags"], "web")

    def test_unknown_workspace_is_none(self):
        self.assertIsNone(services.build_start_config(self.CFG, "nope"))

    def test_worktree_workspace_rewrites_paths_and_forwards_port(self):
        cfg = services.build_start_config(self.CFG, "ww1")
        self.assertEqual(
            cfg["repos"],
            [{"id": "community", "path": "/wt/feature-x/community", "github": "odoo/odoo"}],
        )
        self.assertEqual(cfg["server_path"], "/wt/feature-x/community/odoo-bin")
        self.assertEqual(cfg["worktree_port"], 8071)

    def test_worktree_workspace_without_port(self):
        cfg = services.build_start_config(self.CFG, "ww2")
        self.assertEqual(cfg["server_path"], "/wt/feature-y/community/odoo-bin")
        self.assertNotIn("worktree_port", cfg)

    def test_shell_cmd_uses_worktree_checkout(self):
        # /api/assets/generate with a workspace: the shell command must run the
        # worktree's own odoo-bin from its own checkout
        from backend import server

        cfg = services.build_start_config(self.CFG, "ww1")
        cmd = server.build_shell_cmd(cfg, "wwdb")
        self.assertIn("cd /wt/feature-x/community", cmd)
        self.assertIn("/wt/feature-x/community/odoo-bin", cmd)


class BuildOdooCmdTest(unittest.TestCase):
    """--without-demo mirrors the target's demo_data flag (config_models.js
    Target.demo_data): dfc6299c hardcoded it off for every start, this makes it
    per-target, defaulting on."""

    def _cmd(self, demo_data=None, rust_bundler=False):
        from backend import server

        start = {"repos": ["community"], "db": "db1"}
        if demo_data is not None:
            start["demo_data"] = demo_data
        config = {
            "repos": [{"id": "community", "path": "/repo/community"}],
            "start": start,
            "rust_bundler": rust_bundler,
        }
        orig = server.DATABASE.db_initialized
        server.DATABASE.db_initialized = lambda db: True  # skip the real psql probe
        try:
            cmd, _db, _is_new = server.build_odoo_cmd(config)
        finally:
            server.DATABASE.db_initialized = orig
        return cmd

    def test_demo_data_defaults_on(self):
        self.assertIn("--without-demo false", self._cmd())

    def test_demo_data_explicit_on(self):
        self.assertIn("--without-demo false", self._cmd(demo_data=True))

    def test_demo_data_off(self):
        self.assertIn("--without-demo all", self._cmd(demo_data=False))

    def test_rust_bundler_environment_is_opt_in(self):
        self.assertNotIn("RUST_BUNDLER=1", self._cmd())
        self.assertIn("RUST_BUNDLER=1", self._cmd(rust_bundler=True))


class RustBundlerWarningTest(unittest.TestCase):
    def test_missing_or_stale_fork_warns_only_when_enabled(self):
        from backend import server

        class Bundler:
            @staticmethod
            def status(config):
                return {
                    "installed": True,
                    "current": False,
                    "version": "0.0.9",
                    "expected_version": "0.1.0",
                }

        class Bus:
            lines = []

            def publish_log(self, line):
                self.lines.append(line)

        original = server.RUST_BUNDLER
        server.RUST_BUNDLER = Bundler()
        bus = Bus()
        try:
            self.assertIsNone(server.warn_if_rust_bundler_missing({}, bus))
            thread = server.warn_if_rust_bundler_missing(
                {"rust_bundler": True}, bus, context="workspace w1"
            )
            thread.join(timeout=1)
        finally:
            server.RUST_BUNDLER = original
        self.assertEqual(len(bus.lines), 1)
        self.assertIn("version 0.0.9 is stale", bus.lines[0])
        self.assertIn("Configuration", bus.lines[0])


class ServerSnapshotTest(unittest.TestCase):
    """The unified runtime wire shape (Step 5): one ServerSnapshot for the main odoo
    and each worktree server, keyed by id. asdict() must always emit every field so
    the client's spread-merge behaves as a full replace for the complete main
    snapshot."""

    EXPECTED_KEYS = {
        "id",
        "state",
        "terminal",
        "workspace",
        "db",
        "port",
        "mode",
        "pid",
        "cmd",
        "started_at",
        "exited_unexpectedly",
        "returncode",
        "odoo_port_busy",
        "odoo_version",
        "enterprise",
        "exists",
    }

    def test_asdict_always_has_every_key(self):
        # a minimal snapshot still carries the full field set (defaults filled in)
        snap = asdict(ServerSnapshot(id="main", state="stopped"))
        self.assertEqual(set(snap), self.EXPECTED_KEYS)

    def test_main_defaults(self):
        snap = asdict(ServerSnapshot(id="main", state="running", terminal=True))
        self.assertEqual(snap["id"], "main")
        self.assertTrue(snap["terminal"])
        self.assertFalse(snap["exited_unexpectedly"])  # bool default, not omitted
        self.assertIsNone(snap["odoo_version"])  # enrichment absent until set

    def test_worktree_shape(self):
        # every live entry has its own PTY since the manager unification → terminal True
        snap = asdict(
            ServerSnapshot(id="wt-x", state="running", terminal=True, workspace="wt-x", port=8072)
        )
        self.assertEqual((snap["id"], snap["workspace"], snap["port"]), ("wt-x", "wt-x", 8072))
        self.assertTrue(snap["terminal"])

    def test_run_snapshot_server_key(self):
        # runs default to the main slot; a workspace one-shot carries its own id
        self.assertEqual(
            asdict(RunSnapshot(id="run-1", kind="test", state="running"))["server"], "main"
        )
        snap = asdict(RunSnapshot(id="run-2", kind="test", state="running", server="wt-x"))
        self.assertEqual(snap["server"], "wt-x")


class _FakeBus:
    """Records what a WorkspaceManager would publish, without any SSE plumbing."""

    def __init__(self):
        self.runs = []
        self.servers = []
        self.logs = []  # (server, line)
        self.events = []

    def publish_run(self, snap):
        self.runs.append(snap)

    def publish_server(self, snap):
        self.servers.append(snap)

    def publish_log(self, line, server="main"):
        self.logs.append((server, line))

    def publish_event(self, text, level="", **kw):
        self.events.append((text, level))


class WorkspaceManagerRunTest(unittest.TestCase):
    """The Run lifecycle + backend-owned resume decision, tested at the finish_run
    seam — no real process. This is the part that restarts the user's server, so
    it's unit-covered even though a live run can't run in CI."""

    def _manager(self):
        # import here so the module's global singletons aren't disturbed
        from backend import server

        return server.WorkspaceManager(_FakeBus()), server

    def _seed(self, mgr, wsid, run, resume=None):
        from backend import server

        entry = mgr.entries.get(wsid)
        if entry is None:
            entry = mgr.entries[wsid] = server._Entry(wsid)
        entry.run = run
        entry.resume_config = resume
        return entry

    def test_finish_run_done_and_resume(self):
        mgr, _ = self._manager()
        entry = self._seed(
            mgr,
            "main",
            {"id": "run-1", "kind": "test", "state": "running", "returncode": None},
            resume={"workspace": "t1"},
        )
        resume = mgr.finish_run("main", 0)
        self.assertEqual(resume, {"workspace": "t1"})  # a server was interrupted → resume it
        self.assertEqual(entry.run["state"], "done")
        self.assertTrue(entry.run["ok"])
        self.assertEqual(entry.run["returncode"], 0)
        self.assertIsNone(entry.resume_config)  # consumed
        self.assertEqual(mgr.bus.runs[-1]["state"], "done")  # published

    def test_finish_run_failed_by_returncode(self):
        mgr, _ = self._manager()
        entry = self._seed(
            mgr, "main", {"id": "run-2", "kind": "install", "state": "running", "returncode": None}
        )
        self.assertIsNone(mgr.finish_run("main", 1))  # nothing to resume
        self.assertEqual(entry.run["state"], "failed")
        self.assertFalse(entry.run["ok"])
        self.assertEqual(entry.run["returncode"], 1)

    def test_finish_run_manual_stop(self):
        mgr, _ = self._manager()
        entry = self._seed(
            mgr, "main", {"id": "run-3", "kind": "test", "state": "running", "returncode": None}
        )
        mgr.finish_run("main", None)  # None returncode = stopped manually
        self.assertEqual(entry.run["state"], "failed")
        self.assertFalse(entry.run["ok"])
        self.assertIsNone(entry.run["returncode"])

    def test_finish_run_noop_when_not_running(self):
        mgr, _ = self._manager()
        self.assertIsNone(mgr.finish_run("main", 0))
        self.assertEqual(mgr.bus.runs, [])
        # an already-finished run isn't finalized twice
        self._seed(mgr, "main", {"id": "run-4", "kind": "test", "state": "done", "returncode": 0})
        self.assertIsNone(mgr.finish_run("main", 0))
        self.assertEqual(mgr.bus.runs, [])
        # an unknown workspace is a no-op too
        self.assertIsNone(mgr.finish_run("nope", 0))

    def test_finish_run_per_workspace_isolation(self):
        mgr, _ = self._manager()
        main = self._seed(
            mgr,
            "main",
            {"id": "run-1", "kind": "test", "state": "running", "server": "main"},
            resume={"workspace": "t1"},
        )
        wt = self._seed(
            mgr,
            "wt-x",
            {"id": "run-2", "kind": "test", "state": "running", "server": "wt-x"},
            resume={"workspace": "wt-x"},
        )
        # finishing the worktree run leaves main's untouched, and vice versa
        resume = mgr.finish_run("wt-x", 0)
        self.assertEqual(resume, {"workspace": "wt-x"})
        self.assertEqual(wt.run["state"], "done")
        self.assertEqual(main.run["state"], "running")
        self.assertEqual(mgr.bus.runs[-1]["server"], "wt-x")
        resume = mgr.finish_run("main", 1)
        self.assertEqual(resume, {"workspace": "t1"})
        self.assertEqual(main.run["state"], "failed")
        self.assertEqual(mgr.bus.runs[-1]["server"], "main")

    def test_run_seq_is_manager_level(self):
        # run ids must be unique across workspaces — the frontend keys Run records
        # by id, so per-entry counters would collide
        mgr, _ = self._manager()
        mgr._run_seq += 1
        first = f"run-{mgr._run_seq}"
        mgr._run_seq += 1
        second = f"run-{mgr._run_seq}"
        self.assertNotEqual(first, second)

    def test_run_snapshots_covers_all_entries(self):
        mgr, _ = self._manager()
        self._seed(mgr, "main", {"id": "run-1", "state": "done", "server": "main"})
        self._seed(mgr, "wt-x", {"id": "run-2", "state": "running", "server": "wt-x"})
        snaps = mgr.run_snapshots()
        self.assertEqual({s["id"] for s in snaps}, {"run-1", "run-2"})

    def test_public_terminal_flag(self):
        # a live entry's snapshot advertises its PTY; a synthesized never-started
        # snapshot (status_for for an id with no entry) does not
        import unittest.mock as mock

        from backend import effects, server

        mgr, _ = self._manager()
        entry = server._Entry("wt-x")
        mgr.entries["wt-x"] = entry
        self.assertTrue(mgr._public(entry)["terminal"])
        with mock.patch.object(effects, "is_dir", return_value=False):
            snap = mgr.status_for([{"id": "wt-never", "dirPath": "/nope"}])["wt-never"]
        self.assertFalse(snap["terminal"])

    def test_stop_and_finalize_resumes(self):
        # a manual stop mid-run finalizes the run (returncode None → failed) and
        # restarts the server the run had interrupted
        mgr, _ = self._manager()
        self._seed(
            mgr,
            "wt-x",
            {"id": "run-9", "kind": "test", "state": "running", "server": "wt-x"},
            resume={"workspace": "wt-x"},
        )
        with (
            unittest.mock.patch.object(mgr, "stop", return_value=(True, "stopped")) as stop,
            unittest.mock.patch.object(mgr, "start") as start,
        ):
            ok, detail = mgr.stop_and_finalize("wt-x")
        self.assertTrue(ok)
        stop.assert_called_once_with("wt-x")
        start.assert_called_once_with("wt-x", {"workspace": "wt-x"})
        run = mgr.entries["wt-x"].run
        self.assertEqual(run["state"], "failed")
        self.assertIsNone(run["returncode"])
        self.assertEqual(mgr.bus.runs[-1]["state"], "failed")

    def test_stop_and_finalize_refused(self):
        # a refused stop leaves the run untouched and resumes nothing
        mgr, _ = self._manager()
        entry = self._seed(
            mgr, "main", {"id": "run-10", "kind": "test", "state": "running"}, resume={"t": 1}
        )
        with (
            unittest.mock.patch.object(mgr, "stop", return_value=(False, "already_stopping")),
            unittest.mock.patch.object(mgr, "start") as start,
        ):
            ok, detail = mgr.stop_and_finalize("main")
        self.assertFalse(ok)
        self.assertEqual(detail, "already_stopping")
        start.assert_not_called()
        self.assertEqual(entry.run["state"], "running")

    def test_public_snapshots_orders_main_first(self):
        mgr, _ = self._manager()
        self._seed(mgr, "wt-x", None)
        with unittest.mock.patch.object(mgr, "status", return_value={"id": "main"}):
            snaps = mgr.public_snapshots()
        self.assertEqual([s["id"] for s in snaps], ["main", "wt-x"])
        self.assertNotIn("exists", snaps[1])  # live stream never carries exists


class DbConflictTest(unittest.TestCase):
    """The uniform two-processes-one-db guard (now covering main too)."""

    def _manager(self):
        from backend import server

        mgr = server.WorkspaceManager(_FakeBus())

        def seed(wsid, state, db):
            entry = mgr.entries.get(wsid) or server._Entry(wsid)
            entry.state, entry.db = state, db
            mgr.entries[wsid] = entry
            return entry

        return mgr, seed

    def test_refuses_db_held_by_main(self):
        mgr, seed = self._manager()
        seed("main", "running", "shared")
        self.assertIn("the main server", mgr._db_conflict("wt-x", "shared"))

    def test_refuses_db_held_by_peer_worktree(self):
        mgr, seed = self._manager()
        seed("wt-a", "running", "shared")
        self.assertIn("another workspace's server", mgr._db_conflict("wt-b", "shared"))

    def test_main_refused_when_worktree_holds_db(self):
        mgr, seed = self._manager()
        seed("wt-a", "starting", "shared")
        self.assertIn("'wt-a' workspace server", mgr._db_conflict("main", "shared"))

    def test_allows_same_entry_and_stopped_holders(self):
        mgr, seed = self._manager()
        seed("wt-a", "running", "shared")
        self.assertIsNone(mgr._db_conflict("wt-a", "shared"))  # restarting itself
        seed("wt-a", "stopped", "shared")
        self.assertIsNone(mgr._db_conflict("wt-b", "shared"))  # holder not active
        self.assertIsNone(mgr._db_conflict("wt-b", "other"))  # different db


class PortIsFreeTest(unittest.TestCase):
    """port_is_free is the guard that lets a workspace's stable port fall back safely."""

    def test_free_and_held_ports(self):
        import socket

        from backend import server

        with socket.socket() as held:
            held.bind((server.HOST, 0))
            port = held.getsockname()[1]
            self.assertFalse(server.port_is_free(port))  # held right now
        self.assertTrue(server.port_is_free(port))  # released → bindable again


if __name__ == "__main__":
    unittest.main()
