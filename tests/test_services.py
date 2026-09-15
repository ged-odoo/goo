"""Unit tests for the services layer — the payoff of the IO seam: each service is
exercised against a FakeIO, so there's no real subprocess, network, or sleep.

Run from the repo root: `python3 -m unittest discover`
"""

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
        http_head=None,
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
        self._http_head = http_head or {}  # {url_substring: (status, size)}
        self._dirs = dirs or {}  # {dir path: [entry names]}
        self._files = files or {}  # {file path: text content}
        self._json_files = dict(json_files or {})  # {path: parsed-json-object}
        self.fs_fail = fs_fail  # path substring whose filesystem op should fail
        self.run_calls = []
        self.run_kwargs = []  # kwargs (env, timeout, …) passed alongside each run_calls entry
        self.http_calls = []
        self.logs = []
        self.fs_ops = []  # recorded (op, src, dst) filesystem mutations
        self.downloads = []  # recorded (url, path) http_download calls
        self.temp_dir = "/tmp/goo-fake"  # what make_temp_dir hands out
        self.unpacks = {}  # {archive path substring: [member names]} for unzip

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

    def http_head(self, url, **kwargs):
        self.http_calls.append(url)
        for needle, resp in self._http_head.items():
            if needle in url:
                return (*resp, None)
        return 404, 0, "not stubbed"

    # downloads/archives: no bytes actually move — a download "creates" its target as
    # a file, and unzip "extracts" whatever the test declared under the archive path.
    def http_download(self, url, path, **kwargs):
        self.http_calls.append(url)
        self.downloads.append((url, path))
        for needle, resp in self._http_head.items():
            if needle in url:
                if resp[0] != 200:
                    return False, f"HTTP {resp[0]}"
                self._files[path] = "<zip>"
                return True, None
        return False, "not stubbed"

    def unzip(self, path, dest):
        self.fs_ops.append(("unzip", path, dest))
        if self.fs_fail and self.fs_fail in path:
            return False, "boom"
        for name, entries in list(self.unpacks.items()):
            if name in path:
                for entry in entries:
                    full = os.path.join(dest, entry)
                    if entry.endswith("/"):
                        self._dirs[full.rstrip("/")] = []
                    else:
                        self._files[full] = ""
                return True, None
        return False, "nothing to unpack"

    def make_temp_dir(self, prefix="goo-"):
        self.fs_ops.append(("mkdtemp", prefix, None))
        return self.temp_dir

    def make_dirs(self, path):
        self.fs_ops.append(("makedirs", path, None))
        if self.fs_fail and self.fs_fail in path:
            return False, "boom"
        self._dirs.setdefault(path, [])
        return True, None

    def is_dir(self, path):
        return path in self._dirs

    def is_file(self, path):
        return path in self._files

    def list_dir(self, path):
        return sorted(self._dirs.get(path, []))

    def read_text(self, path):
        return self._files.get(path)

    def write_text(self, path, text):
        self.fs_ops.append(("write_text", path, None))
        if self.fs_fail and self.fs_fail in path:
            return False, "boom"
        self._files[path] = text
        return True, None

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

    BUNDLE_HTML = (
        "<title>Bundle master-tref-pr-3-nby</title>"
        '<a href="https://github.com/odoo-dev/odoo/tree/master-tref-pr-3-nby">branch</a>'
        '<a href="https://github.com/odoo/odoo/pull/269266">old pr</a>'
        '<a href="https://github.com/odoo/odoo/pull/274706">pr</a>'
        '<a href="https://github.com/odoo-dev/enterprise/tree/master-tref-pr-3-nby">branch</a>'
        '<a href="https://github.com/odoo/enterprise/pull/123261">pr</a>'
        '<a href="https://github.com/odoo/enterprise/pull/123261">pr again</a>'
    )

    def test_bundle_info_canonical_url(self):
        # a canonical /runbot/bundle/<id> URL answers 200 directly
        io = FakeIO(
            http_nofollow={"bundle/master-tref-pr-3-nby-475950": (200, "", self.BUNDLE_HTML)}
        )
        svc = services.RunbotService(io, TTLCache(ttl=0))
        info, error = svc.bundle_info(
            "https://runbot.odoo.com/runbot/bundle/master-tref-pr-3-nby-475950"
        )
        self.assertIsNone(error)
        self.assertEqual(info["name"], "master-tref-pr-3-nby")
        self.assertEqual(
            info["branches"],
            [
                {"github": "odoo-dev/odoo", "branch": "master-tref-pr-3-nby"},
                {"github": "odoo-dev/enterprise", "branch": "master-tref-pr-3-nby"},
            ],
        )
        # PRs deduped, order preserved
        self.assertEqual(
            info["prs"],
            [
                {"github": "odoo/odoo", "number": 269266},
                {"github": "odoo/odoo", "number": 274706},
                {"github": "odoo/enterprise", "number": 123261},
            ],
        )

    def test_bundle_info_name_url_follows_302(self):
        # a name URL 302-redirects to the canonical page, which is then read
        io = FakeIO(
            http_nofollow={"bundle/master-tref-pr-3-nby": (302, "/runbot/bundle/475950", "")},
            http={"bundle/475950": (self.BUNDLE_HTML, None)},
        )
        svc = services.RunbotService(io, TTLCache(ttl=0))
        info, error = svc.bundle_info("https://runbot.odoo.com/runbot/bundle/master-tref-pr-3-nby")
        self.assertIsNone(error)
        self.assertEqual(info["name"], "master-tref-pr-3-nby")

    def test_bundle_info_rejects_foreign_and_missing(self):
        svc = services.RunbotService(FakeIO(), TTLCache(ttl=0))
        info, error = svc.bundle_info("https://example.com/runbot/bundle/x")
        self.assertIsNone(info)
        self.assertIn("not a runbot bundle URL", error)
        # 301 = id-misresolve (no bundle of that name) — must not follow
        io = FakeIO(http_nofollow={"bundle/nope-33": (301, "/runbot/bundle/foreign-33", "")})
        info, error = services.RunbotService(io, TTLCache(ttl=0)).bundle_info(
            "https://runbot.odoo.com/runbot/bundle/nope-33"
        )
        self.assertIsNone(info)
        self.assertIn("no such bundle", error)

    def test_bundle_info_non_bundle_page(self):
        io = FakeIO(http_nofollow={"bundle/x": (200, "", "<title>Odoo runbot</title>")})
        info, error = services.RunbotService(io, TTLCache(ttl=0)).bundle_info(
            "https://runbot.odoo.com/runbot/bundle/x"
        )
        self.assertIsNone(info)
        self.assertIn("not a runbot bundle", error)

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

    # ── database dumps off a bundle page ────────────────────────────────────

    # two batch tiles (newest first), each with build slots carrying the data
    # attributes the dump URL is assembled from. The Documentation slot dumps no
    # database (data-databases="[]"), and the older tile must be ignored entirely.
    @staticmethod
    def _slot(name, build, dest, host, databases):
        return (
            f'<div class="slot_container"><a class="btn btn-default slot_name">'
            f"<span>{name}</span></a>"
            f'<build-options-dropdown data-id="{build}" data-dest="{dest}" '
            f'data-host="{host}" data-databases="{databases}"></build-options-dropdown></div>'
        )

    def _bundle_with_batches(self):
        latest = (
            self._slot("Community Run", "12", "12-master", "runbot9.odoo.com", "[&#34;all&#34;]")
            + self._slot(
                "Enterprise Run",
                "13",
                "13-master",
                "runbot9.odoo.com",
                "[&#34;all&#34;, &#34;base&#34;]",
            )
            + self._slot("Documentation", "14", "14-master", "runbot9.odoo.com", "[]")
        )
        older = self._slot("Community Run", "1", "1-master", "runbot1.odoo.com", "[&#34;all&#34;]")
        return (
            "<title>Bundle master-x</title>"
            f'<div class="batch_tile">{latest}</div><div class="batch_tile">{older}</div>'
        )

    def _bundle_with_fresh_empty_batch(self):
        """A bundle whose newest batch was created seconds ago: runbot hasn't filled
        in its build slots yet, so it carries no dropdowns at all."""
        return self._bundle_with_batches().replace(
            '<div class="batch_tile">',
            '<div class="batch_tile"></div><div class="batch_tile">',
            1,
        )

    def test_bundle_dumps_stops_at_the_newest_usable_batch(self):
        # every dump the latest batch offers, each probed and sized; the older
        # batch's build (runbot1) is never even looked at
        io = FakeIO(
            http_nofollow={"bundle/master-x": (200, "", self._bundle_with_batches())},
            http_head={"runbot9.odoo.com": (200, 4096)},
        )
        info, error = services.RunbotService(io, TTLCache(ttl=0)).bundle_info(
            "https://runbot.odoo.com/runbot/bundle/master-x"
        )
        self.assertIsNone(error)
        self.assertEqual(
            info["dumps"],
            [
                {
                    "build": "12",
                    "slot": "Community Run",
                    "db": "all",
                    "url": "https://runbot9.odoo.com/runbot/static/build/12-master/logs/12-master-all.zip",
                    "size": 4096,
                },
                {
                    "build": "13",
                    "slot": "Enterprise Run",
                    "db": "all",
                    "url": "https://runbot9.odoo.com/runbot/static/build/13-master/logs/13-master-all.zip",
                    "size": 4096,
                },
                {
                    "build": "13",
                    "slot": "Enterprise Run",
                    "db": "base",
                    "url": "https://runbot9.odoo.com/runbot/static/build/13-master/logs/13-master-base.zip",
                    "size": 4096,
                },
            ],
        )
        self.assertNotIn("runbot1.odoo.com", " ".join(io.http_calls))

    def test_bundle_dumps_falls_back_past_a_batch_with_no_builds(self):
        # a batch created moments ago has no build slots yet — read the one before it
        # rather than reporting that the bundle has no database to restore
        io = FakeIO(
            http_nofollow={"bundle/master-x": (200, "", self._bundle_with_fresh_empty_batch())},
            http_head={"runbot9.odoo.com": (200, 4096)},
        )
        info, _ = services.RunbotService(io, TTLCache(ttl=0)).bundle_info(
            "https://runbot.odoo.com/runbot/bundle/master-x"
        )
        self.assertEqual(
            [(d["build"], d["db"]) for d in info["dumps"]],
            [("12", "all"), ("13", "all"), ("13", "base")],
        )

    def test_bundle_dumps_falls_back_when_every_dump_is_pruned(self):
        # the newest batch's builds are all gone from disk → the previous batch's
        # (runbot1) dumps are offered instead
        io = FakeIO(
            http_nofollow={"bundle/master-x": (200, "", self._bundle_with_batches())},
            http_head={"runbot9.odoo.com": (404, 0), "runbot1.odoo.com": (200, 77)},
        )
        info, _ = services.RunbotService(io, TTLCache(ttl=0)).bundle_info(
            "https://runbot.odoo.com/runbot/bundle/master-x"
        )
        self.assertEqual(
            [(d["build"], d["db"], d["size"]) for d in info["dumps"]], [("1", "all", 77)]
        )

    def test_bundle_dumps_drops_pruned_builds(self):
        # runbot cleans old build directories up: a candidate whose zip is gone is
        # not offered at all, rather than failing after the workspace exists
        io = FakeIO(
            http_nofollow={"bundle/master-x": (200, "", self._bundle_with_batches())},
            http_head={"13-master": (200, 10), "12-master": (404, 0)},
        )
        info, _ = services.RunbotService(io, TTLCache(ttl=0)).bundle_info(
            "https://runbot.odoo.com/runbot/bundle/master-x"
        )
        self.assertEqual(
            [(d["build"], d["db"]) for d in info["dumps"]], [("13", "all"), ("13", "base")]
        )

    def test_dumps_by_branch_name(self):
        # "the runbot database for master" — the same parse, reached by bundle NAME
        # (302 → canonical page) instead of a pasted URL
        io = FakeIO(
            http_nofollow={"bundle/master": (302, "/runbot/bundle/master-1", "")},
            http={"bundle/master-1": (self._bundle_with_batches(), None)},
            http_head={"runbot9.odoo.com": (200, 4096)},
        )
        svc = services.RunbotService(io, TTLCache(ttl=60))
        dumps = svc.dumps("master")
        self.assertEqual(
            [(d["build"], d["db"]) for d in dumps],
            [("12", "all"), ("13", "all"), ("13", "base")],
        )
        # cached per branch under its own key — a second open costs no requests
        before = len(io.http_calls)
        svc.dumps("master")
        self.assertEqual(len(io.http_calls), before)

    def test_dumps_resolves_a_sticky_series_by_bundle_id(self):
        # /runbot/bundle/saas-19.4 redirects to `saas-194`, an unrelated private dev
        # bundle — a sticky series must be addressed by the id the starred list gives
        # it, and never through that name lookup
        rd1 = (
            '<div class="row bundle_row"><i class="fa fa-star"></i>'
            '<a href="/runbot/bundle/483750" title="View Bundle saas-19.4">v</a></div>'
        )
        io = FakeIO(
            http={"rd-1": (rd1, None), "bundle/483750": (self._bundle_with_batches(), None)},
            http_head={"runbot9.odoo.com": (200, 8)},
        )
        dumps = services.RunbotService(io, TTLCache(ttl=0)).dumps("saas-19.4")
        self.assertEqual([d["build"] for d in dumps], ["12", "13", "13"])
        # the misleading name URL was never requested
        self.assertFalse(any("bundle/saas-19.4" in c for c in io.http_calls))

    def test_dumps_by_branch_absent_bundle(self):
        # 301 = runbot read the trailing number as some other bundle's id: no offer
        io = FakeIO(http_nofollow={"bundle/nope-33": (301, "/runbot/bundle/foreign-33", "")})
        self.assertEqual(services.RunbotService(io, TTLCache(ttl=0)).dumps("nope-33"), [])

    def test_bundle_dumps_absent_without_batches(self):
        io = FakeIO(http_nofollow={"bundle/x": (200, "", self.BUNDLE_HTML)})
        info, _ = services.RunbotService(io, TTLCache(ttl=0)).bundle_info(
            "https://runbot.odoo.com/runbot/bundle/x"
        )
        self.assertEqual(info["dumps"], [])


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
            '<build-options-dropdown data-id="300" data-dest="300-master" '
            'data-host="runbot1.odoo.com" '
            'data-log_list="[&#34;restore_all&#34;, &#34;start_qunit_only&#34;]"></build-options-dropdown>'
            '<build-options-dropdown data-id="301" data-dest="301-master" '
            'data-host="runbot2.odoo.com" '
            'data-log_list="[&#34;install_all&#34;]"></build-options-dropdown>'
        )
        io = FakeIO(http={"batch/1/build/1": (html, None)})
        svc = services.NightlyService(io, TTLCache(60))
        self.assertEqual(
            svc.batch_builds("/runbot/batch/1/build/1"),
            [
                {
                    "label": "300",
                    "url": "https://runbot1.odoo.com/runbot/static/build/300-master/logs/start_qunit_only.txt",
                }
            ],
        )

    def test_batch_builds_falls_back_to_test_only_no_limit_no_autotags(self):
        html = (
            '<build-options-dropdown data-id="300" data-dest="300-master" '
            'data-host="runbot1.odoo.com" '
            'data-log_list="[&#34;restore&#34;, &#34;test_only_no_limit_no_autotags&#34;]">'
            "</build-options-dropdown>"
            '<build-options-dropdown data-id="301" data-dest="301-master" '
            'data-host="runbot2.odoo.com" '
            'data-log_list="[&#34;install_all&#34;]"></build-options-dropdown>'
        )
        io = FakeIO(http={"batch/1/build/1": (html, None)})
        svc = services.NightlyService(io, TTLCache(60))
        self.assertEqual(
            svc.batch_builds("/runbot/batch/1/build/1"),
            [
                {
                    "label": "300",
                    "url": (
                        "https://runbot1.odoo.com/runbot/static/build/300-master"
                        "/logs/test_only_no_limit_no_autotags.txt"
                    ),
                }
            ],
        )

    def test_batch_builds_prefers_start_qunit_only_when_both_present(self):
        html = (
            '<build-options-dropdown data-id="300" data-dest="300-master" '
            'data-host="runbot1.odoo.com" '
            'data-log_list="[&#34;test_only_no_limit_no_autotags&#34;, &#34;start_qunit_only&#34;]">'
            "</build-options-dropdown>"
        )
        io = FakeIO(http={"batch/1/build/1": (html, None)})
        svc = services.NightlyService(io, TTLCache(60))
        self.assertEqual(
            svc.batch_builds("/runbot/batch/1/build/1"),
            [
                {
                    "label": "300",
                    "url": "https://runbot1.odoo.com/runbot/static/build/300-master/logs/start_qunit_only.txt",
                }
            ],
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


class MemoryServiceTest(unittest.TestCase):
    def test_fetch_from_url(self):
        log = "a.WebSuite.Something.js:  [MEMINFO] @suite.one (after GC) - used: 100\n"
        io = FakeIO(http={"example.com": (log, None)})
        svc = services.MemoryService(io)
        rows = svc.fetch([{"label": "master", "url": "http://example.com/log.txt"}])
        self.assertEqual(rows, [{"suite": "@suite.one", "master": 100}])

    def test_fetch_from_uploaded_content_skips_http(self):
        log = "a.WebSuite.Something.js:  [MEMINFO] @suite.one (after GC) - used: 200\n"
        io = FakeIO()
        svc = services.MemoryService(io)
        rows = svc.fetch([{"label": "local", "content": log}])
        self.assertEqual(rows, [{"suite": "@suite.one", "local": 200}])
        self.assertEqual(io.http_calls, [])

    def test_fetch_mixes_url_and_uploaded_builds(self):
        url_log = "a.WebSuite.Something.js:  [MEMINFO] @suite.one (after GC) - used: 100\n"
        file_log = "a.WebSuite.Something.js:  [MEMINFO] @suite.one (after GC) - used: 300\n"
        io = FakeIO(http={"example.com": (url_log, None)})
        svc = services.MemoryService(io)
        rows = svc.fetch(
            [
                {"label": "master", "url": "http://example.com/log.txt"},
                {"label": "uploaded", "content": file_log},
            ]
        )
        self.assertEqual(rows, [{"suite": "@suite.one", "master": 100, "uploaded": 300}])


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

    def test_pr_head_returns_head_ref(self):
        io = FakeIO(run_result=completed(stdout='{"headRefName": "master-saas-19.4-x-548384-fw"}'))
        svc = services.GitHubService(io, TTLCache(ttl=600))
        self.assertEqual(svc.pr_head("odoo/odoo", 278098), ("master-saas-19.4-x-548384-fw", None))
        self.assertEqual(
            io.run_calls,
            [["gh", "pr", "view", "278098", "--repo", "odoo/odoo", "--json", "headRefName"]],
        )

    def test_pr_head_surfaces_gh_failure(self):
        io = FakeIO(run_result=completed(returncode=1, stderr="no pull requests found"))
        svc = services.GitHubService(io, TTLCache(ttl=600))
        self.assertEqual(svc.pr_head("odoo/odoo", 1), ("", "no pull requests found"))

    def test_pr_infos_maps_ci_rollup_and_dedups(self):
        payload = (
            '{"number": 279751, "title": "t", "url": "u", "state": "MERGED", "isDraft": false,'
            ' "headRefName": "br", "createdAt": "a", "updatedAt": "b", "statusCheckRollup": ['
            '{"context": "ci/runbot", "state": "SUCCESS", "targetUrl": "ru"}]}'
        )
        io = FakeIO(run_result=completed(stdout=payload))
        svc = services.GitHubService(io, TTLCache(ttl=600))
        pairs = [
            {"github": "odoo/odoo", "number": 279751},
            {"github": "odoo/odoo", "number": 279751},  # duplicate — one gh call
        ]
        prs = svc.pr_infos(pairs)
        self.assertEqual(len(prs), 1)
        pr = prs[0]
        self.assertEqual(pr["relation"], "tracked")
        self.assertEqual(pr["state"], "merged")
        self.assertEqual(pr["branch"], "br")
        self.assertEqual(pr["ci"]["runbot"], "success")
        self.assertEqual(
            io.run_calls,
            [
                [
                    "gh",
                    "pr",
                    "view",
                    "279751",
                    "--repo",
                    "odoo/odoo",
                    "--json",
                    "number,title,url,state,isDraft,headRefName,createdAt,updatedAt,statusCheckRollup",
                ]
            ],
        )

    def test_pr_infos_omits_unresolvable_pairs(self):
        io = FakeIO(run_result=completed(returncode=1, stderr="not found"))
        svc = services.GitHubService(io, TTLCache(ttl=0))
        self.assertEqual(svc.pr_infos([{"github": "odoo/odoo", "number": 1}]), [])

    def test_review_statuses_reviewed_when_review_after_last_request(self):
        # GitHub's own "current reviewRequests" doesn't clear on a plain Comment
        # review (only Approve/Request-changes) — the real signal is whether the
        # user's last review is more recent than their last review-request event
        io = FakeIO(
            runs={
                "gh api user": completed(stdout="aab"),
                "gh pr view": completed(
                    stdout='{"reviews": [{"author": {"login": "aab"},'
                    ' "submittedAt": "2026-01-02T00:00:00Z"}]}'
                ),
                "timeline": completed(stdout='{"login": "aab", "at": "2026-01-01T00:00:00Z"}\n'),
            },
        )
        svc = services.GitHubService(io, TTLCache(ttl=600))
        statuses = svc.review_statuses([{"github": "odoo/odoo", "number": 1}])
        self.assertEqual(statuses, {"odoo/odoo#1": "reviewed"})

    def test_review_statuses_to_review_when_re_requested_after_review(self):
        io = FakeIO(
            runs={
                "gh api user": completed(stdout="aab"),
                "gh pr view": completed(
                    stdout='{"reviews": [{"author": {"login": "aab"},'
                    ' "submittedAt": "2026-01-01T00:00:00Z"}]}'
                ),
                "timeline": completed(stdout='{"login": "aab", "at": "2026-01-02T00:00:00Z"}\n'),
            }
        )
        svc = services.GitHubService(io, TTLCache(ttl=600))
        statuses = svc.review_statuses([{"github": "odoo/odoo", "number": 1}])
        self.assertEqual(statuses, {"odoo/odoo#1": "to_review"})

    def test_review_statuses_to_review_when_never_reviewed(self):
        io = FakeIO(
            runs={
                "gh api user": completed(stdout="aab"),
                "gh pr view": completed(stdout='{"reviews": []}'),
            }
        )
        svc = services.GitHubService(io, TTLCache(ttl=600))
        statuses = svc.review_statuses([{"github": "odoo/odoo", "number": 1}])
        self.assertEqual(statuses, {"odoo/odoo#1": "to_review"})
        # never reviewed → no need to even check the request timeline
        self.assertFalse(any("timeline" in " ".join(c) for c in io.run_calls))
        # "me" is resolved once and cached for the service's lifetime
        svc.review_statuses([{"github": "odoo/odoo", "number": 2}])
        self.assertEqual(sum(1 for c in io.run_calls if "user" in c), 1)

    def test_review_statuses_to_review_when_only_review_is_a_pending_draft(self):
        # a PENDING (not-yet-submitted) review comes back with "submittedAt": null
        # — a present-but-null key, so a plain .get(key, default) wouldn't catch it
        # and a bare max() over [None] used to blow up comparing it to a string
        io = FakeIO(
            runs={
                "gh api user": completed(stdout="aab"),
                "gh pr view": completed(
                    stdout='{"reviews": [{"author": {"login": "aab"}, "submittedAt": null}]}'
                ),
                "timeline": completed(stdout='{"login": "aab", "at": "2026-01-01T00:00:00Z"}\n'),
            }
        )
        svc = services.GitHubService(io, TTLCache(ttl=600))
        statuses = svc.review_statuses([{"github": "odoo/odoo", "number": 1}])
        self.assertEqual(statuses, {"odoo/odoo#1": "to_review"})

    def test_ready_pr_marks_ready_through_gh(self):
        io = FakeIO(run_result=completed())
        svc = services.GitHubService(io, TTLCache(ttl=600))
        ok, error = svc.ready_pr("odoo/odoo", 275826)
        self.assertTrue(ok)
        self.assertIsNone(error)
        self.assertEqual(io.run_calls, [["gh", "pr", "ready", "275826", "--repo", "odoo/odoo"]])

    def test_ready_pr_invalidates_cache(self):
        cache = TTLCache(ttl=600)
        io = FakeIO(run_result=completed(stdout="[]"))
        svc = services.GitHubService(io, cache)
        svc.prs([{"id": "c", "github": "o/o"}])  # populates the cache
        svc.prs([{"id": "c", "github": "o/o"}])  # served from cache → no 2nd gh call
        self.assertEqual(len(io.run_calls), 1)
        ok, _ = svc.ready_pr("o/o", 3)
        self.assertTrue(ok)
        svc.prs([{"id": "c", "github": "o/o"}])  # cache was invalidated → fetches again
        self.assertEqual(len(io.run_calls), 3)  # 1 prs + 1 ready + 1 prs

    def test_ready_pr_surfaces_gh_failure(self):
        io = FakeIO(run_result=completed(returncode=1, stderr="not a draft"))
        svc = services.GitHubService(io, TTLCache(ttl=600))
        self.assertEqual(svc.ready_pr("odoo/odoo", 275826), (False, "not a draft"))


def _mb_row(state_cls, day, prs):
    """One staging <tr> as the mergebot page renders it: colour class, a 'Staged at'
    UTC timestamp, and a PR link per (repo, number)."""
    links = "".join(
        f'<a href="https://github.com/{repo}/pull/{num}" target="_blank">{repo}#{num}</a>'
        for repo, num in prs
    )
    return (
        f'<tr class="  {state_cls}  ">'
        f"<th>Staged at {day} 10:00:00Z</th>"
        f'<td class="pr-listing"><ul>{links}</ul></td>'
        f"</tr>"
    )


def _mb_page(rows, next_until=None):
    nxt = (
        f'<a href="/runbot_merge/1?until={next_until} 10:00:00&amp;state=">Next &gt;</a>'
        if next_until
        else ""
    )
    return f"<table>{''.join(rows)}</table>{nxt}"


class CiServiceTest(unittest.TestCase):
    CACHE = "/cfg/goo/ci_merge_stats.json"

    @staticmethod
    def _today():
        from datetime import datetime, timezone

        return datetime.now(timezone.utc).date()

    @staticmethod
    def _day(offset):
        from datetime import timedelta

        return (CiServiceTest._today() + timedelta(days=offset)).isoformat()

    def test_parse_and_aggregate_single_page(self):
        t0, t1 = self._day(0), self._day(-1)
        page = _mb_page(
            [
                _mb_row("bg-success", t0, [("odoo/odoo", 1)]),
                _mb_row("bg-success", t0, [("odoo/odoo", 2)]),
                _mb_row("bg-danger", t0, [("odoo/odoo", 3)]),
                # a batch pairing two repos → 2 PRs; plus a duplicate link (dedup → still 2)
                _mb_row(
                    "bg-success", t1, [("odoo/odoo", 4), ("odoo/enterprise", 4), ("odoo/odoo", 4)]
                ),
                _mb_row("bg-gray-lighter", t1, [("odoo/odoo", 5)]),
                _mb_row("bg-info", t1, [("odoo/odoo", 6)]),
            ]
        )
        io = FakeIO(http={"runbot_merge/1": (page, None)})
        svc = services.CiService(io, self.CACHE)
        out = svc.merge_stats(days=14)

        self.assertEqual(len(out), 14)
        self.assertEqual(out[0]["date"], t0)
        self.assertEqual(
            {
                k: out[0][k]
                for k in ("batches", "merged", "failed", "killed", "pending", "prs_merged")
            },
            {"batches": 3, "merged": 2, "failed": 1, "killed": 0, "pending": 0, "prs_merged": 2},
        )
        self.assertEqual(
            {
                k: out[1][k]
                for k in ("batches", "merged", "failed", "killed", "pending", "prs_merged")
            },
            {"batches": 3, "merged": 1, "failed": 0, "killed": 1, "pending": 1, "prs_merged": 2},
        )
        # older days with no data are zero-filled
        self.assertEqual(out[5]["batches"], 0)

    def test_completed_days_cached_and_not_refetched(self):
        t0, t1, t2 = self._day(0), self._day(-1), self._day(-2)
        page1 = _mb_page(
            [
                _mb_row("bg-success", t0, [("odoo/odoo", 10)]),
                _mb_row("bg-success", t1, [("odoo/odoo", 11)]),
            ],
            next_until=t2,
        )
        page2 = _mb_page([_mb_row("bg-success", t2, [("odoo/odoo", 12)])])  # exhausted
        io = FakeIO(http={f"until={t2}": (page2, None), "runbot_merge/1": (page1, None)})
        svc = services.CiService(io, self.CACHE)

        out1 = svc.merge_stats(days=3)
        self.assertEqual([d["merged"] for d in out1], [1, 1, 1])
        self.assertEqual(len(io.http_calls), 2)  # both pages fetched

        # completed days (t1, t2) are now on disk; a fresh staging appears today
        io.http_calls.clear()
        io._http = {
            "runbot_merge/1": (
                _mb_page(
                    [
                        _mb_row("bg-success", t0, [("odoo/odoo", 10)]),
                        _mb_row("bg-success", t0, [("odoo/odoo", 99)]),
                        _mb_row("bg-success", t1, [("odoo/odoo", 11)]),
                    ],
                    next_until=t2,
                ),
                None,
            )
        }
        out2 = svc.merge_stats(days=3)
        self.assertEqual(len(io.http_calls), 1)  # only today's page — page2 skipped
        self.assertFalse(any(f"until={t2}" in u for u in io.http_calls))
        self.assertEqual(out2[0]["merged"], 2)  # today refreshed live
        self.assertEqual(out2[2]["merged"], 1)  # t2 served from the immutable cache

    def test_refresh_bypasses_cache(self):
        t0, t1, t2 = self._day(0), self._day(-1), self._day(-2)
        page1 = _mb_page(
            [
                _mb_row("bg-success", t0, [("odoo/odoo", 10)]),
                _mb_row("bg-success", t1, [("odoo/odoo", 11)]),
            ],
            next_until=t2,
        )
        page2 = _mb_page([_mb_row("bg-success", t2, [("odoo/odoo", 12)])])
        io = FakeIO(http={f"until={t2}": (page2, None), "runbot_merge/1": (page1, None)})
        svc = services.CiService(io, self.CACHE)
        svc.merge_stats(days=3)

        io.http_calls.clear()
        svc.merge_stats(days=3, refresh=True)
        self.assertTrue(any(f"until={t2}" in u for u in io.http_calls))  # page2 re-fetched

    def test_queue_counts_only_this_branch_awaiting(self):
        # the Splits list, the Blocked list, and saas-19.4's Awaiting must not count
        root = (
            '<h1>RD</h1><h2><a href="/runbot_merge/1">master</a></h2>'
            '<div class="splits pr-awaiting"><h5>Splits</h5><ul>'
            '<li><a href="https://github.com/odoo/odoo/pull/1">x</a></li></ul></div>'
            '<div class="pr-listing pr-awaiting"><h5>Awaiting</h5><ul>'
            '<li><a href="https://github.com/odoo/odoo/pull/10">a</a></li>'
            '<li><a href="https://github.com/odoo/enterprise/pull/11">b</a></li>'
            '<li><a href="https://github.com/odoo/odoo/pull/12">c</a></li></ul></div>'
            '<div class="pr-listing pr-blocked"><h5>Blocked</h5><ul>'
            '<li><a href="https://github.com/odoo/odoo/pull/99">z</a></li></ul></div>'
            '<h2><a href="/runbot_merge/131">saas-19.4</a></h2>'
            '<div class="pr-listing pr-awaiting"><h5>Awaiting</h5><ul>'
            '<li><a href="https://github.com/odoo/odoo/pull/500">other</a></li></ul></div>'
        )
        io = FakeIO(http={"runbot_merge": (root, None)})
        self.assertEqual(services.CiService(io, self.CACHE).queue(), 3)

    def test_queue_none_when_page_unavailable(self):
        io = FakeIO(http={"runbot_merge": ("", "timeout")})
        self.assertIsNone(services.CiService(io, self.CACHE).queue())


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

    def test_drop_uses_if_exists_so_an_already_absent_db_is_not_an_error(self):
        io = self._io(dropdb=completed())
        ok, err = services.DatabaseService(io, TTLCache(ttl=600)).drop("gone-already")
        self.assertTrue(ok)
        self.assertIsNone(err)
        [dropdb_call] = [c for c in io.run_calls if c[0] == "dropdb"]
        self.assertIn("--if-exists", dropdb_call)

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

    # ── runbot dump restore ─────────────────────────────────────────────────

    DUMP_URL = "https://runbot9.odoo.com/runbot/static/build/13-master/logs/13-master-all.zip"

    def _dump_io(self, **extra):
        """An IO where `gamma` doesn't exist yet and the dump downloads + unpacks
        into the odoo layout (dump.sql + filestore/)."""
        io = self._io(**extra)
        io._runs.setdefault("FROM pg_database WHERE datname", completed(stdout=""))
        io._http_head = {"13-master": (200, 4096)}
        io.unpacks = {"dump.zip": ["dump.sql", "filestore/"]}
        return io

    def test_restore_dump_creates_restores_and_installs_filestore(self):
        io = self._dump_io()
        svc = services.DatabaseService(io, TTLCache(ttl=0))
        ok, err = svc.restore_dump("gamma", self.DUMP_URL, filestore="/fs", log_progress=False)
        self.assertTrue(ok, err)
        self.assertEqual(io.downloads, [(self.DUMP_URL, "/tmp/goo-fake/dump.zip")])
        # odoo's own database shape — its dumps restore into no other
        self.assertIn(
            ["createdb", "--template=template0", "--encoding=unicode", "--lc-collate=C", "gamma"],
            io.run_calls,
        )
        self.assertIn(
            ["psql", "--quiet", "--dbname", "gamma", "--file", "/tmp/goo-fake/dump/dump.sql"],
            io.run_calls,
        )
        self.assertIn(("move", "/tmp/goo-fake/dump/filestore", "/fs/gamma"), io.fs_ops)
        self.assertIn(("remove", "/tmp/goo-fake", None), io.fs_ops)  # temp dir cleaned up

    def test_restore_dump_without_a_filestore_says_so(self):
        # the archive's attachments are dropped (there's nowhere to put them) — the
        # restore still succeeds, but it must not do that silently
        io = self._dump_io()
        io.unpacks = {"dump.zip": ["dump.sql", "filestore/"]}
        svc = services.DatabaseService(io, TTLCache(ttl=0))
        ok, err = svc.restore_dump("gamma", self.DUMP_URL, filestore="", log_progress=False)
        self.assertTrue(ok, err)
        self.assertFalse(any(op == "move" for op, _s, _d in io.fs_ops))
        self.assertTrue(any("no filestore configured" in line for line in io.logs))

    def test_restore_dump_refuses_existing_database(self):
        io = self._dump_io()
        io._runs["FROM pg_database WHERE datname"] = completed(stdout="1\n")
        svc = services.DatabaseService(io, TTLCache(ttl=0))
        ok, err = svc.restore_dump("gamma", self.DUMP_URL, log_progress=False)
        self.assertFalse(ok)
        self.assertIn("already exists", err)
        self.assertEqual(io.downloads, [])  # nothing downloaded before the check

    def test_restore_dump_refuses_foreign_url(self):
        io = self._dump_io()
        svc = services.DatabaseService(io, TTLCache(ttl=0))
        ok, err = svc.restore_dump("gamma", "https://example.com/evil.zip", log_progress=False)
        self.assertFalse(ok)
        self.assertIn("not a runbot dump URL", err)
        self.assertEqual(io.downloads, [])

    def test_restore_dump_drops_the_database_when_psql_fails(self):
        io = self._dump_io()
        io._runs["--file"] = completed(returncode=1, stderr="syntax error")
        svc = services.DatabaseService(io, TTLCache(ttl=0))
        ok, err = svc.restore_dump("gamma", self.DUMP_URL, filestore="/fs", log_progress=False)
        self.assertFalse(ok)
        self.assertIn("syntax error", err)
        # no half-restored shell left behind, and no filestore installed for it
        self.assertIn(["dropdb", "--if-exists", "gamma"], io.run_calls)
        self.assertNotIn(("move", "/tmp/goo-fake/dump/filestore", "/fs/gamma"), io.fs_ops)

    def test_restore_dump_rejects_archive_without_dump_sql(self):
        io = self._dump_io()
        io.unpacks = {"dump.zip": ["logs.txt"]}
        svc = services.DatabaseService(io, TTLCache(ttl=0))
        ok, err = svc.restore_dump("gamma", self.DUMP_URL, log_progress=False)
        self.assertFalse(ok)
        self.assertIn("no dump.sql", err)
        self.assertNotIn(
            ["createdb", "--template=template0", "--encoding=unicode", "--lc-collate=C", "gamma"],
            io.run_calls,
        )


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

    def test_ssh_over_https_port_form(self):
        # git@ssh.github.com:443 — the SSH-over-443 host GitHub offers when port 22
        # is blocked; the port must not be swallowed into the owner
        self.assertEqual(
            services.parse_github_slug("ssh://git@ssh.github.com:443/someone/documentation.git"),
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

    def test_amend_commit_stages_and_amends(self):
        io = FakeIO(run_result=completed())
        ok, err = services.GitService(io).amend_commit("/repo", "new message")
        self.assertTrue(ok)
        self.assertIsNone(err)
        [commit_call] = [c for c in io.run_calls if "commit" in c]
        self.assertIn("--amend", commit_call)
        self.assertIn("new message", commit_call)

    def test_amend_commit_reports_git_error(self):
        io = FakeIO(
            runs={
                "add -A": completed(),
                "commit": completed(returncode=1, stderr="error: could not amend commit"),
            }
        )
        ok, err = services.GitService(io).amend_commit("/repo", "new message")
        self.assertFalse(ok)
        self.assertIn("could not amend", err)

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

    def test_worktree_add_no_longer_self_triggers_claude_md_or_skills(self):
        # generation moved to server.py's _api_workspace_create, called explicitly
        # once every repo in the workspace is known — worktree_add itself is now a
        # plain git operation with no side file generation
        io = FakeIO()
        ok, _ = services.GitService(io).worktree_add(
            "/repo/community", "/wt/demo/community", "18.0-fix", repo="community"
        )
        self.assertTrue(ok)
        self.assertEqual(io._files, {})

    def test_create_worktree_claude_md_and_skills_at_parent_dir(self):
        io = FakeIO()
        svc = services.GitService(io)
        svc.create_worktree_claude_md("/wt/demo", "18.0-fix", has_enterprise=True)
        svc.create_worktree_skills("/wt/demo/community", "/wt/demo", "18.0-fix")
        self.assertIn("/wt/demo/.claude/CLAUDE.md", io._files)
        claude_md = io._files["/wt/demo/.claude/CLAUDE.md"]
        self.assertIn("psql", claude_md)
        self.assertIn("../odoo.conf", claude_md)
        self.assertIn("enterprise/", claude_md)
        for slug in ("odoo-orm", "odoo-views", "odoo-frontend-owl", "odoo-testing"):
            self.assertIn(f"/wt/demo/.claude/skills/{slug}/SKILL.md", io._files)
        # never written inside a repo itself
        self.assertFalse(any(p.startswith("/wt/demo/community/.claude") for p in io._files))
        skill = io._files["/wt/demo/.claude/skills/odoo-orm/SKILL.md"]
        self.assertIn("name: odoo-orm", skill)
        self.assertIn(
            "https://raw.githubusercontent.com/odoo/documentation/18.0/content/developer",
            skill,
        )
        self.assertIn("chrome-devtools", claude_md)
        self.assertIn("memlab", claude_md)

    def test_create_worktree_claude_md_omits_enterprise_when_absent(self):
        io = FakeIO()
        services.GitService(io).create_worktree_claude_md(
            "/wt/demo", "18.0-fix", has_enterprise=False
        )
        self.assertNotIn("enterprise/", io._files["/wt/demo/.claude/CLAUDE.md"])

    def test_create_worktree_claude_md_mentions_local_documentation_when_given(self):
        io = FakeIO()
        services.GitService(io).create_worktree_claude_md(
            "/wt/demo", "18.0-fix", has_enterprise=False, documentation_path="/wt/demo/documentation"
        )
        claude_md = io._files["/wt/demo/.claude/CLAUDE.md"]
        self.assertIn("documentation/", claude_md)
        self.assertIn("18.0", claude_md)  # forked from the base branch, not "18.0-fix"

    def test_create_worktree_claude_md_mentions_local_owl_when_given(self):
        io = FakeIO()
        services.GitService(io).create_worktree_claude_md(
            "/wt/demo", "18.0-fix", has_enterprise=False, owl_path="/wt/demo/owl"
        )
        self.assertIn("owl/", io._files["/wt/demo/.claude/CLAUDE.md"])

    def test_create_worktree_skills_uses_local_documentation_path_when_given(self):
        io = FakeIO()
        services.GitService(io).create_worktree_skills(
            "/wt/demo/community", "/wt/demo", "18.0-fix", documentation_path="/wt/demo/documentation"
        )
        skill = io._files["/wt/demo/.claude/skills/odoo-orm/SKILL.md"]
        self.assertIn("/wt/demo/documentation/content/developer", skill)
        self.assertIn("Read the file directly", skill)
        self.assertNotIn("raw.githubusercontent.com/odoo/documentation", skill)
        self.assertNotIn("gh api repos/odoo/documentation", skill)

    def test_create_worktree_skills_uses_local_owl_path_when_given(self):
        io = FakeIO(
            files={
                "/wt/demo/community/addons/web/static/lib/owl/owl.js": (
                    'var version = "2.8.4"; var __info__ = {hash: "5093c0b"};'
                )
            },
            dirs={"/wt/demo/owl/doc/reference": []},
        )
        services.GitService(io).create_worktree_skills(
            "/wt/demo/community", "/wt/demo", "18.0-fix", owl_path="/wt/demo/owl"
        )
        skill = io._files["/wt/demo/.claude/skills/odoo-frontend-owl/SKILL.md"]
        self.assertIn("/wt/demo/owl/doc/reference", skill)
        self.assertIn("Read the file directly", skill)
        self.assertIn("checked out locally in `owl/`", skill)
        self.assertNotIn("raw.githubusercontent.com/odoo/owl", skill)

    def test_create_worktree_skills_writes_memory_perf_skill_and_scripts(self):
        io = FakeIO()
        services.GitService(io).create_worktree_skills("/wt/demo/community", "/wt/demo", "18.0-fix")
        base = "/wt/demo/.claude/skills/odoo-memory-perf"
        skill_md = io._files[f"{base}/SKILL.md"]
        self.assertIn("name: odoo-memory-perf", skill_md)
        self.assertIn("memlab", skill_md)
        self.assertIn("memleak_check", skill_md)
        # only one bundled file now — the tour is driven by the memleak_check
        # addon's own HttpCase, not a separate memlab-launched browser
        self.assertEqual(
            {p for p in io._files if p.startswith(f"{base}/")},
            {f"{base}/SKILL.md", f"{base}/scripts/run_check.sh"},
        )
        run_check = io._files[f"{base}/scripts/run_check.sh"]
        self.assertIn("odoo-bin -c ../odoo.conf", run_check)
        self.assertIn("dropdb --if-exists", run_check)
        self.assertIn("-i \"memleak_check,$MODULES\"", run_check)
        self.assertIn("--test-tags \"$TEST_TAGS\"", run_check)
        self.assertIn("MEMCHECK_DUMP_DIR", run_check)
        self.assertIn("memlab@latest find-leaks", run_check)
        self.assertIn("--baseline", run_check)
        self.assertIn("--target", run_check)
        self.assertIn("--final", run_check)
        self.assertIn("--work-dir", run_check)  # else the leaks.txt dump lands in a throwaway temp dir
        self.assertIn("DUMP_DIR", run_check)

    def test_create_worktree_skills_writes_bootstrap_leak_audit_skill(self):
        io = FakeIO()
        services.GitService(io).create_worktree_skills("/wt/demo/community", "/wt/demo", "18.0-fix")
        base = "/wt/demo/.claude/skills/odoo-bootstrap-leak-audit"
        self.assertEqual({p for p in io._files if p.startswith(f"{base}/")}, {f"{base}/SKILL.md"})
        skill_md = io._files[f"{base}/SKILL.md"]
        self.assertIn("name: odoo-bootstrap-leak-audit", skill_md)
        self.assertIn("elementMap", skill_md)
        self.assertIn("dispose()", skill_md)
        self.assertIn("getOrCreateInstance", skill_md)
        self.assertIn("Carousel", skill_md)
        self.assertIn("odoo-memory-perf", skill_md)  # cross-references the empirical skill

    def test_create_worktree_skills_writes_leak_bisect_skill_and_script(self):
        io = FakeIO()
        services.GitService(io).create_worktree_skills("/wt/demo/community", "/wt/demo", "18.0-fix")
        base = "/wt/demo/.claude/skills/odoo-leak-bisect"
        self.assertEqual(
            {p for p in io._files if p.startswith(f"{base}/")},
            {f"{base}/SKILL.md", f"{base}/scripts/heapcheck_cdp.py"},
        )
        skill_md = io._files[f"{base}/SKILL.md"]
        self.assertIn("name: odoo-leak-bisect", skill_md)
        self.assertIn("MEMINFO", skill_md)
        self.assertIn("runbot", skill_md)
        self.assertIn("heapcheck_cdp.py", skill_md)
        script = io._files[f"{base}/scripts/heapcheck_cdp.py"]
        self.assertIn("HeapProfiler.collectGarbage", script)
        self.assertIn("[HOOT] Test suite succeeded", script)

    def test_create_worktree_skills_does_not_overwrite_existing_skills(self):
        io = FakeIO(files={"/wt/demo/.claude/skills/odoo-orm/SKILL.md": "user-edited content"})
        services.GitService(io).create_worktree_skills("/wt/demo/community", "/wt/demo", "18.0-fix")
        self.assertEqual(
            io._files["/wt/demo/.claude/skills/odoo-orm/SKILL.md"], "user-edited content"
        )
        self.assertNotIn("/wt/demo/.claude/skills/odoo-views/SKILL.md", io._files)

    def test_create_worktree_claude_md_does_not_overwrite_existing_file(self):
        io = FakeIO(files={"/wt/demo/.claude/CLAUDE.md": "user-edited content"})
        services.GitService(io).create_worktree_claude_md("/wt/demo", "18.0-fix", has_enterprise=True)
        self.assertEqual(io._files["/wt/demo/.claude/CLAUDE.md"], "user-edited content")

    def test_resolve_owl_docs_pins_exact_commit_when_reachable(self):
        io = FakeIO(
            files={
                "/wt/community/addons/web/static/lib/owl/owl.js": (
                    'var version = "2.8.4"; var __info__ = {hash: "5093c0b"};'
                )
            },
            http={"odoo/owl/5093c0b/doc/reference/component.md": ("# component", None)},
        )
        ref, path, major = services.GitService(io)._resolve_owl_docs("/wt/community")
        self.assertEqual((ref, path, major), ("5093c0b", "doc/reference", "2"))

    def test_resolve_owl_docs_falls_back_to_master_when_hash_unreachable(self):
        io = FakeIO(
            files={
                "/wt/community/addons/web/static/lib/owl/owl.js": (
                    'var version = "3.0.0-alpha.45"; var __info__ = {hash: "cf5b97cd"};'
                )
            }
            # no http stub matches the hash-pinned candidates -> "not stubbed" errors
        )
        ref, path, major = services.GitService(io)._resolve_owl_docs("/wt/community")
        self.assertEqual((ref, path, major), ("master", "doc/v3/owl/reference", "3"))

    def test_resolve_owl_docs_defaults_to_v2_when_owl_js_missing(self):
        io = FakeIO()  # no owl.js file at all
        ref, path, major = services.GitService(io)._resolve_owl_docs("/wt/community")
        self.assertEqual((ref, path, major), ("master", "doc/v2/reference", "2"))

    def test_resolve_owl_worktree_start_uses_exact_commit_when_locally_reachable(self):
        io = FakeIO(
            files={
                "/wt/community/addons/web/static/lib/owl/owl.js": (
                    'var version = "2.8.4"; var __info__ = {hash: "5093c0b"};'
                )
            },
            runs={"cat-file -e 5093c0b": completed()},
        )
        start = services.GitService(io).resolve_owl_worktree_start("/wt/community", "/owl/main")
        self.assertEqual(start, "5093c0b")
        [cmd] = [c for c in io.run_calls if "cat-file" in c]
        self.assertIn("/owl/main", cmd)
        self.assertFalse(any("fetch" in c for c in io.run_calls))  # local hit -> no network

    def test_resolve_owl_worktree_start_fetches_by_sha_when_not_locally_reachable(self):
        # not in the local object store yet, but the remote host can serve it by
        # sha (common on GitHub) — a plain fetch pulls it in, so it's still used
        io = FakeIO(
            files={
                "/wt/community/addons/web/static/lib/owl/owl.js": (
                    'var version = "2.8.4"; var __info__ = {hash: "5093c0b"};'
                )
            },
            runs={"cat-file -e 5093c0b": completed(returncode=1, stderr="not found")},
        )
        start = services.GitService(io).resolve_owl_worktree_start("/wt/community", "/owl/main")
        self.assertEqual(start, "5093c0b")
        [cmd] = [c for c in io.run_calls if "fetch" in c]
        self.assertIn("origin", cmd)
        self.assertIn("5093c0b", cmd)

    def test_resolve_owl_worktree_start_uses_configured_pull_remote_for_the_fetch(self):
        io = FakeIO(
            files={
                "/wt/community/addons/web/static/lib/owl/owl.js": (
                    'var version = "2.8.4"; var __info__ = {hash: "5093c0b"};'
                )
            },
            runs={"cat-file -e 5093c0b": completed(returncode=1, stderr="not found")},
        )
        services.GitService(io).resolve_owl_worktree_start(
            "/wt/community", "/owl/main", pull_remote="upstream"
        )
        [cmd] = [c for c in io.run_calls if "fetch" in c]
        self.assertIn("upstream", cmd)

    def test_resolve_owl_worktree_start_falls_back_to_master_when_commit_unreachable(self):
        # neither locally present nor fetchable — e.g. a hash built from a commit
        # that was never actually pushed publicly (seen with some alpha builds)
        io = FakeIO(
            files={
                "/wt/community/addons/web/static/lib/owl/owl.js": (
                    'var version = "3.0.0-alpha.45"; var __info__ = {hash: "cf5b97cd"};'
                )
            },
            run_result=completed(returncode=1, stderr="not found"),
        )
        start = services.GitService(io).resolve_owl_worktree_start("/wt/community", "/owl/main")
        self.assertEqual(start, "master")

    def test_resolve_owl_worktree_start_falls_back_to_master_when_owl_js_missing(self):
        io = FakeIO()  # no owl.js at all -> no hash to even try
        start = services.GitService(io).resolve_owl_worktree_start("/wt/community", "/owl/main")
        self.assertEqual(start, "master")
        self.assertEqual(io.run_calls, [])  # never bothers with a local git check

    def test_owl_local_layout_prefers_flat_when_present(self):
        io = FakeIO(dirs={"/wt/owl/doc/reference": []})
        self.assertEqual(services.GitService(io)._owl_local_layout("/wt/owl", "2"), "doc/reference")

    def test_owl_local_layout_falls_back_to_split_when_no_flat_layout(self):
        io = FakeIO()
        self.assertEqual(
            services.GitService(io)._owl_local_layout("/wt/owl", "3"), "doc/v3/owl/reference"
        )
        self.assertEqual(
            services.GitService(io)._owl_local_layout("/wt/owl", "2"), "doc/v2/reference"
        )

    def test_current_branch_returns_checked_out_name(self):
        io = FakeIO(runs={"branch --show-current": completed(stdout="master-thing\n")})
        self.assertEqual(services.GitService(io).current_branch("/repo"), "master-thing")

    def test_current_branch_empty_on_error(self):
        io = FakeIO(run_result=completed(returncode=128, stderr="not a git repository"))
        self.assertEqual(services.GitService(io).current_branch("/nope"), "")

    def test_write_dev_context_writes_claude_md_and_all_skills_unconditionally(self):
        # pre-existing content at the target paths — unlike the worktree-creation
        # helpers, write_dev_context has no "don't overwrite" guard: it's meant for a
        # fresh, throwaway directory (the headless chat's per-conversation temp dir)
        io = FakeIO(files={"/ctx/.claude/skills/odoo-orm/SKILL.md": "stale"})
        services.GitService(io).write_dev_context("/ctx", "/wt/community", "19.0-fix")
        self.assertIn("/ctx/.claude/CLAUDE.md", io._files)
        self.assertIn("19.0-fix", io._files["/ctx/.claude/CLAUDE.md"])
        for slug in (
            "odoo-orm",
            "odoo-views",
            "odoo-frontend-owl",
            "odoo-testing",
            "odoo-memory-perf",
            "odoo-bootstrap-leak-audit",
            "odoo-leak-bisect",
        ):
            content = io._files[f"/ctx/.claude/skills/{slug}/SKILL.md"]
            self.assertIn(f"name: {slug}", content)
        self.assertNotEqual(io._files["/ctx/.claude/skills/odoo-orm/SKILL.md"], "stale")
        self.assertIn(
            "npx --yes memlab",
            io._files["/ctx/.claude/skills/odoo-memory-perf/scripts/run_check.sh"],
        )

    def test_write_dev_context_detects_documentation_enterprise_and_owl_siblings(self):
        io = FakeIO(
            files={
                "/wt/community/addons/web/static/lib/owl/owl.js": (
                    'var version = "2.8.4"; var __info__ = {hash: "5093c0b"};'
                )
            },
            dirs={
                "/wt/documentation": [],
                "/wt/enterprise": [],
                "/wt/owl": [],
                "/wt/owl/doc/reference": [],
            },
        )
        services.GitService(io).write_dev_context("/ctx", "/wt/community", "18.0-fix")
        claude_md = io._files["/ctx/.claude/CLAUDE.md"]
        self.assertIn("documentation/", claude_md)
        self.assertIn("enterprise/", claude_md)
        self.assertIn("owl/", claude_md)
        skill = io._files["/ctx/.claude/skills/odoo-orm/SKILL.md"]
        self.assertIn("/wt/documentation/content/developer", skill)
        owl_skill = io._files["/ctx/.claude/skills/odoo-frontend-owl/SKILL.md"]
        self.assertIn("/wt/owl/doc/reference", owl_skill)

    def test_write_dev_context_falls_back_to_remote_docs_without_siblings(self):
        io = FakeIO()  # no documentation/enterprise/owl dirs at all (e.g. main-located)
        services.GitService(io).write_dev_context("/ctx", "/wt/community", "18.0-fix")
        claude_md = io._files["/ctx/.claude/CLAUDE.md"]
        self.assertNotIn("documentation/", claude_md)
        self.assertNotIn("enterprise/", claude_md)
        self.assertNotIn("owl/", claude_md)
        skill = io._files["/ctx/.claude/skills/odoo-orm/SKILL.md"]
        self.assertIn("raw.githubusercontent.com/odoo/documentation", skill)
        owl_skill = io._files["/ctx/.claude/skills/odoo-frontend-owl/SKILL.md"]
        self.assertIn("raw.githubusercontent.com/odoo/owl", owl_skill)

    def test_write_odoo_conf_writes_addons_path_and_db_role(self):
        io = FakeIO()
        services.GitService(io).write_odoo_conf(
            "/wt/demo", "/wt/demo/community/addons,/wt/demo/enterprise", "odoo", "odoo"
        )
        conf = io._files["/wt/demo/odoo.conf"]
        self.assertIn("[options]", conf)
        self.assertIn("addons_path = /wt/demo/community/addons,/wt/demo/enterprise", conf)
        self.assertIn("db_user = odoo", conf)
        self.assertIn("db_password = odoo", conf)

    def test_write_odoo_conf_does_not_overwrite_existing_file(self):
        io = FakeIO(files={"/wt/demo/odoo.conf": "user-edited content"})
        services.GitService(io).write_odoo_conf("/wt/demo", "addons", "odoo", "odoo")
        self.assertEqual(io._files["/wt/demo/odoo.conf"], "user-edited content")

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

    def test_commit_diff_returns_commit_patch(self):
        sha = "a" * 40
        io = FakeIO(runs={"git -C /r show": completed(stdout="diff --git a/a b/a\n")})
        diff, err = services.GitService(io).commit_diff("/r", sha)
        self.assertIsNone(err)
        self.assertEqual(diff, "diff --git a/a b/a\n")
        self.assertEqual(io.run_calls[0][-2:], [sha, "--"])

    def test_commit_diff_rejects_invalid_hash(self):
        io = FakeIO()
        diff, err = services.GitService(io).commit_diff("/r", "--stat")
        self.assertIsNone(diff)
        self.assertEqual(err, "invalid commit hash")
        self.assertFalse(io.run_calls)

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

    def test_rewrite_history_reorders_and_squashes(self):
        io = FakeIO(
            runs={
                "rev-list origin/master..HEAD": completed(stdout="a\nb\n"),
                "rev-parse origin/master": completed(stdout="basesha\n"),
                "log -1 --format=%B a": completed(stdout="keep me\n"),
            }
        )
        plan = [{"sha": "a"}, {"sha": "b", "squash": True}]
        ok, err, in_progress = services.GitService(io).rewrite_history("/repo", "master", plan)
        self.assertTrue(ok)
        self.assertIsNone(err)
        self.assertFalse(in_progress)
        [rebase_call] = [c for c in io.run_calls if "rebase" in c]
        self.assertIn("--autostash", rebase_call)
        self.assertIn("basesha", rebase_call)

    def test_rewrite_history_rewords_picks_and_squash_roots(self):
        class CapturingIO(FakeIO):
            def run(self, cmd, **kwargs):
                result = super().run(cmd, **kwargs)
                if isinstance(cmd, list) and "rebase" in cmd:
                    queue_dir = pathlib.Path(kwargs["env"]["GOO_QUEUE_DIR"])
                    self.todo = (queue_dir / "todo").read_text()
                    self.messages = [path.read_text() for path in sorted(queue_dir.glob("*.msg"))]
                return result

        io = CapturingIO(
            runs={
                "rev-list origin/master..HEAD": completed(stdout="a\nb\nc\n"),
                "rev-parse origin/master": completed(stdout="basesha\n"),
            }
        )
        plan = [
            {"sha": "a", "message": "new A\n\nbody A"},
            {"sha": "b", "message": "new B"},
            {"sha": "c", "squash": True},
        ]
        ok, err, in_progress = services.GitService(io).rewrite_history("/repo", "master", plan)
        self.assertTrue(ok)
        self.assertIsNone(err)
        self.assertFalse(in_progress)
        self.assertEqual(io.todo, "reword a\npick b\nsquash c\n")
        self.assertEqual(io.messages, ["new A\n\nbody A\n", "new B\n"])
        self.assertFalse(any("log -1 --format=%B" in " ".join(call) for call in io.run_calls))

    def test_rewrite_history_rejects_message_on_squashed_commit(self):
        ok, err, in_progress = services.GitService(FakeIO()).rewrite_history(
            "/repo",
            "master",
            [{"sha": "a"}, {"sha": "b", "squash": True, "message": "lost"}],
        )
        self.assertFalse(ok)
        self.assertIn("independent message", err)
        self.assertFalse(in_progress)

    def test_rewrite_history_rejects_empty_message(self):
        ok, err, in_progress = services.GitService(FakeIO()).rewrite_history(
            "/repo", "master", [{"sha": "a", "message": "  "}]
        )
        self.assertFalse(ok)
        self.assertIn("can't be empty", err)
        self.assertFalse(in_progress)

    def test_rewrite_history_drops_commit(self):
        class CapturingIO(FakeIO):
            def run(self, cmd, **kwargs):
                result = super().run(cmd, **kwargs)
                if isinstance(cmd, list) and "rebase" in cmd:
                    queue_dir = pathlib.Path(kwargs["env"]["GOO_QUEUE_DIR"])
                    self.todo = (queue_dir / "todo").read_text()
                return result

        io = CapturingIO(
            runs={
                "rev-list origin/master..HEAD": completed(stdout="a\nb\n"),
                "rev-parse origin/master": completed(stdout="basesha\n"),
            }
        )
        plan = [{"sha": "a", "drop": True}, {"sha": "b"}]
        ok, err, in_progress = services.GitService(io).rewrite_history("/repo", "master", plan)
        self.assertTrue(ok)
        self.assertIsNone(err)
        self.assertFalse(in_progress)
        self.assertEqual(io.todo, "drop a\npick b\n")

    def test_rewrite_history_rejects_rewording_dropped_commit(self):
        ok, err, in_progress = services.GitService(FakeIO()).rewrite_history(
            "/repo", "master", [{"sha": "a", "drop": True, "message": "lost"}]
        )
        self.assertFalse(ok)
        self.assertIn("dropped commit", err)
        self.assertFalse(in_progress)

    def test_rewrite_history_rejects_squash_as_first_entry(self):
        ok, err, in_progress = services.GitService(FakeIO()).rewrite_history(
            "/repo", "master", [{"sha": "a", "squash": True}]
        )
        self.assertFalse(ok)
        self.assertIn("oldest commit", err)
        self.assertFalse(in_progress)

    def test_rewrite_history_rejects_stale_plan(self):
        io = FakeIO(runs={"rev-list origin/master..HEAD": completed(stdout="a\nc\n")})
        ok, err, in_progress = services.GitService(io).rewrite_history(
            "/repo", "master", [{"sha": "a"}, {"sha": "b"}]
        )
        self.assertFalse(ok)
        self.assertIn("changed", err)
        self.assertFalse(in_progress)

    def test_rewrite_history_reports_conflict_left_in_progress(self):
        io = FakeIO(
            runs={
                "rev-list origin/master..HEAD": completed(stdout="a\nb\n"),
                "rev-parse origin/master": completed(stdout="basesha\n"),
                "log -1 --format=%B a": completed(stdout="keep me\n"),
                "rebase --autostash -i basesha": completed(
                    returncode=1, stderr="error: could not apply b"
                ),
                "rev-parse --git-path rebase-merge": completed(stdout=".git/rebase-merge\n"),
            },
            dirs={"/repo/.git/rebase-merge": []},
        )
        plan = [{"sha": "a"}, {"sha": "b", "squash": True}]
        ok, err, in_progress = services.GitService(io).rewrite_history("/repo", "master", plan)
        self.assertFalse(ok)
        self.assertIn("could not apply", err)
        self.assertTrue(in_progress)

    def test_abort_rebase_runs_git_abort(self):
        io = FakeIO(run_result=completed())
        ok, err = services.GitService(io).abort_rebase("/repo")
        self.assertTrue(ok)
        self.assertIsNone(err)
        [abort_call] = [c for c in io.run_calls if "rebase" in c]
        self.assertIn("--abort", abort_call)

    def test_rebase_status_detects_stuck_rebase(self):
        io = FakeIO(
            runs={"rev-parse --git-path rebase-merge": completed(stdout=".git/rebase-merge\n")},
            dirs={"/repo/.git/rebase-merge": []},
        )
        in_progress, err = services.GitService(io).rebase_status("/repo")
        self.assertTrue(in_progress)
        self.assertIsNone(err)

    def test_rebase_status_clean_when_no_rebase_dirs(self):
        io = FakeIO(
            runs={
                "rev-parse --git-path rebase-merge": completed(stdout=".git/rebase-merge\n"),
                "rev-parse --git-path rebase-apply": completed(stdout=".git/rebase-apply\n"),
            }
        )
        in_progress, err = services.GitService(io).rebase_status("/repo")
        self.assertFalse(in_progress)
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
        ok, err, non_ff = services.GitService(io).fetch_remote_branch(
            "/r", "master-x", pull_remote="upstream"
        )
        self.assertEqual((ok, err, non_ff), (True, None, False))
        self.assertIn("fetch upstream master-x:master-x", " ".join(io.run_calls[-1]))

    def test_fetch_remote_branch_from_push_remote(self):
        # forward-port sub-workspace fetches the fw head from the dev fork, so the
        # opportunistic refs/remotes/dev/<branch> ref makes it look pushed
        io = FakeIO()
        ok, err, non_ff = services.GitService(io).fetch_remote_branch(
            "/r", "master-x-548384-fw", pull_remote="dev"
        )
        self.assertEqual((ok, err, non_ff), (True, None, False))
        self.assertIn("fetch dev master-x-548384-fw:master-x-548384-fw", " ".join(io.run_calls[-1]))

    def test_fetch_remote_branch_non_fast_forward_flagged(self):
        io = FakeIO(
            runs={
                "fetch": completed(
                    returncode=1,
                    stderr="From github.com:odoo-dev/odoo\n"
                    " ! [rejected]        master-x -> master-x  (non-fast-forward)\n",
                )
            }
        )
        ok, err, non_ff = services.GitService(io).fetch_remote_branch(
            "/r", "master-x", pull_remote="dev"
        )
        self.assertFalse(ok)
        self.assertTrue(non_ff)

    def test_fetch_remote_branch_force_uses_plus_refspec(self):
        io = FakeIO()
        ok, err, non_ff = services.GitService(io).fetch_remote_branch(
            "/r", "master-x", pull_remote="dev", force=True
        )
        self.assertEqual((ok, err, non_ff), (True, None, False))
        self.assertIn("fetch dev +master-x:master-x", " ".join(io.run_calls[-1]))

    def test_fetch_pr_head_uses_the_pr_s_own_repo_not_a_local_remote(self):
        # refs/pull/<n>/head only ever resolves against the exact repo the PR was
        # opened on — fetch_pr_head must go straight to https://github.com/<github>.git
        # rather than any locally-configured remote (see the method's own docstring).
        io = FakeIO()
        ok, err, non_ff = services.GitService(io).fetch_pr_head(
            "/r", "odoo-dev/odoo", 123, "master-x"
        )
        self.assertEqual((ok, err, non_ff), (True, None, False))
        cmd = " ".join(io.run_calls[-1])
        self.assertIn("fetch https://github.com/odoo-dev/odoo.git", cmd)
        self.assertIn("refs/pull/123/head:master-x", cmd)

    def test_fetch_pr_head_force_uses_plus_refspec(self):
        io = FakeIO()
        services.GitService(io).fetch_pr_head("/r", "odoo/odoo", 1, "master-x", force=True)
        self.assertIn("+refs/pull/1/head:master-x", " ".join(io.run_calls[-1]))

    def test_fetch_pr_head_non_fast_forward_flagged(self):
        io = FakeIO(
            runs={
                "fetch": completed(
                    returncode=1,
                    stderr="From github.com:odoo/odoo\n"
                    " ! [rejected]        refs/pull/1/head -> master-x  (non-fast-forward)\n",
                )
            }
        )
        ok, err, non_ff = services.GitService(io).fetch_pr_head("/r", "odoo/odoo", 1, "master-x")
        self.assertFalse(ok)
        self.assertTrue(non_ff)

    def test_sync_pr_worktree_fetches_pr_head_and_hard_resets(self):
        # unlike fetch_pr_head, this must never rename a local branch ref (that's
        # refused by git when the branch is checked out in a worktree) — it fetches
        # into FETCH_HEAD and resets the worktree itself onto it.
        io = FakeIO()
        ok, err = services.GitService(io).sync_pr_worktree("/wt/community", "odoo/odoo", 123)
        self.assertEqual((ok, err), (True, None))
        joined = [" ".join(c) for c in io.run_calls]
        self.assertTrue(
            any(
                "fetch https://github.com/odoo/odoo.git refs/pull/123/head" in c
                and ":master-x" not in c
                for c in joined
            )
        )
        self.assertTrue(any("reset --hard FETCH_HEAD" in c for c in joined))

    def test_sync_pr_worktree_refuses_when_dirty(self):
        io = FakeIO(runs={"status --porcelain": completed(stdout=" M foo.py\n")})
        ok, err = services.GitService(io).sync_pr_worktree("/wt/community", "odoo/odoo", 123)
        self.assertFalse(ok)
        self.assertIn("uncommitted", err)
        self.assertFalse(any("fetch" in " ".join(c) for c in io.run_calls))

    def test_sync_pr_worktree_error_on_fetch_failure(self):
        notes = []
        io = FakeIO(
            runs={"fetch": completed(returncode=1, stderr="could not read from remote\n")}
        )
        svc = services.GitService(
            io, notify=lambda text, **kw: notes.append((text, kw.get("status", "")))
        )
        ok, err = svc.sync_pr_worktree("/wt/community", "odoo/odoo", 123, repo="community")
        self.assertFalse(ok)
        self.assertEqual(err, "could not read from remote")
        self.assertFalse(any("reset --hard" in " ".join(c) for c in io.run_calls))
        self.assertEqual(
            notes,
            [
                ("fetching PR #123 (community)", "start"),
                ("fetching PR #123 (community)", "error"),
            ],
        )

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
        # no pull_remote given — falls back to "origin"
        self.assertTrue(all(f["remote"] == "origin" for f in found))

    def test_search_branches_also_searches_push_remote_fork(self):
        # a branch pushed only to a personal/team fork (here "odoo-dev", resolved
        # from the push remote's actual URL) never reaches the upstream repo
        io = FakeIO(
            runs={
                "remote get-url dev": completed(stdout="git@github.com:odoo-dev/odoo.git\n"),
                "repos/odoo/odoo/git/matching-refs": completed(stdout=""),
                "repos/odoo-dev/odoo/git/matching-refs": completed(
                    stdout="refs/heads/master-mine\n"
                ),
            }
        )
        svc = services.GitHubService(io, TTLCache(ttl=0))
        found = svc.search_branches(
            [{"id": "community", "github": "odoo/odoo", "path": "/r", "push_remote": "dev"}],
            "master-",
        )
        self.assertEqual([f["branch"] for f in found], ["master-mine"])
        self.assertEqual(found[0]["repo"], "community")
        # found only on the fork — must be fetched from "dev", not upstream
        self.assertEqual(found[0]["remote"], "dev")

    def test_search_branches_prefers_upstream_remote_over_fork(self):
        io = FakeIO(
            runs={
                "remote get-url dev": completed(stdout="git@github.com:odoo-dev/odoo.git\n"),
                "repos/odoo/odoo/git/matching-refs": completed(stdout="refs/heads/master-shared\n"),
                "repos/odoo-dev/odoo/git/matching-refs": completed(
                    stdout="refs/heads/master-shared\n"
                ),
            }
        )
        svc = services.GitHubService(io, TTLCache(ttl=0))
        found = svc.search_branches(
            [{"id": "community", "github": "odoo/odoo", "path": "/r", "push_remote": "dev"}],
            "master-",
        )
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["remote"], "origin")

    def test_fork_slug_exception_does_not_lose_upstream_matches(self):
        # regression test: fork_slug's own `git remote get-url` call used to be
        # unguarded, unlike its sibling matching_refs — an exception there (e.g.
        # git missing, or a hung process) silently dropped this repo's ALREADY
        # FOUND upstream matches too, since the results.append happens after
        # fork_slug returns. It must now degrade gracefully like matching_refs.
        class RaisingOnRemoteGetUrlIO(FakeIO):
            def run(self, cmd, **kwargs):
                if cmd[:3] == ["git", "remote", "get-url"] or (
                    len(cmd) > 3 and cmd[1] == "-C" and cmd[3:5] == ["remote", "get-url"]
                ):
                    raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout"))
                return super().run(cmd, **kwargs)

        io = RaisingOnRemoteGetUrlIO(
            runs={"repos/odoo/odoo/git/matching-refs": completed(stdout="refs/heads/master-x\n")}
        )
        svc = services.GitHubService(io, TTLCache(ttl=0))
        found = svc.search_branches(
            [{"id": "community", "github": "odoo/odoo", "path": "/r", "push_remote": "dev"}],
            "master-",
        )
        self.assertEqual([f["branch"] for f in found], ["master-x"])
        self.assertEqual(found[0]["remote"], "origin")


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


class VenvServiceTest(unittest.TestCase):
    VENV = "/wt/feature-x/.venv"
    REQ = "/wt/feature-x/community/requirements.txt"

    def test_create_installs_requirements_when_present(self):
        io = FakeIO(files={self.REQ: "odoo-stubs==1.0\n"})
        events = []
        svc = services.VenvService(io, notify=lambda *args, **kwargs: events.append((args, kwargs)))
        ok, error = svc.create(self.VENV, self.REQ)
        self.assertTrue(ok)
        self.assertIsNone(error)
        self.assertEqual(io.run_calls[0], ["python3", "-m", "venv", self.VENV])
        self.assertEqual(io.run_calls[1], [f"{self.VENV}/bin/pip", "install", "-r", self.REQ])
        self.assertEqual(io.run_calls[2], [f"{self.VENV}/bin/pip", "install", "websocket-client"])
        self.assertEqual(len(io.run_calls), 3)
        self.assertEqual([kw["status"] for _, kw in events], ["start", "done"])

    def test_create_skips_pip_when_requirements_missing(self):
        io = FakeIO()  # no files registered — read_text(REQ) is None
        svc = services.VenvService(io)
        ok, error = svc.create(self.VENV, self.REQ)
        self.assertTrue(ok)
        self.assertIsNone(error)
        # venv + the always-attempted websocket-client install, no requirements pip
        self.assertEqual(len(io.run_calls), 2)
        self.assertEqual(io.run_calls[1], [f"{self.VENV}/bin/pip", "install", "websocket-client"])

    def test_create_ignores_websocket_client_install_failure(self):
        io = FakeIO(
            files={self.REQ: "odoo-stubs==1.0\n"},
            runs={"websocket-client": completed(returncode=1, stderr="no network\n")},
        )
        svc = services.VenvService(io)
        ok, error = svc.create(self.VENV, self.REQ)
        self.assertTrue(ok)
        self.assertIsNone(error)

    def test_venv_creation_failure_is_reported_and_notified(self):
        io = FakeIO(runs={"-m venv": completed(returncode=1, stderr="boom\nno space left\n")})
        events = []
        svc = services.VenvService(io, notify=lambda *args, **kwargs: events.append((args, kwargs)))
        ok, error = svc.create(self.VENV, self.REQ)
        self.assertFalse(ok)
        self.assertIn("no space left", error)
        self.assertEqual([kw["status"] for _, kw in events], ["start", "error"])

    def test_pip_install_failure_is_reported(self):
        io = FakeIO(
            files={self.REQ: "odoo-stubs==1.0\n"},
            runs={"pip": completed(returncode=1, stderr="first\nresolution failed\n")},
        )
        svc = services.VenvService(io)
        ok, error = svc.create(self.VENV, self.REQ)
        self.assertFalse(ok)
        self.assertIn("resolution failed", error)

    def test_missing_python3_is_reported(self):
        class MissingPython(FakeIO):
            def run(self, cmd, **kwargs):
                raise FileNotFoundError("python3 not found")

        svc = services.VenvService(MissingPython())
        ok, error = svc.create(self.VENV, self.REQ)
        self.assertFalse(ok)
        self.assertIn("python3 not found", error)


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
        "venv_activate": "source /global/env/bin/activate",
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
                "id": "ww3",
                "name": "feature-z",
                "db": "wzdb",
                "location": "worktree",
                "worktree": {"base": "w1", "dir": "/wt/feature-z", "venv": True},
                "checkouts": [{"repo": "community", "branch": "feat-z"}],
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

    def test_worktree_without_dedicated_venv_keeps_global_venv_activate(self):
        cfg = services.build_start_config(self.CFG, "ww1")
        self.assertEqual(cfg["venv_activate"], "source /global/env/bin/activate")

    def test_worktree_with_dedicated_venv_overrides_venv_activate(self):
        cfg = services.build_start_config(self.CFG, "ww3")
        self.assertEqual(cfg["venv_activate"], "source /wt/feature-z/.venv/bin/activate")
        # pins the exact interpreter too — odoo-bin then runs under it regardless
        # of its own shebang line (see server._odoo_cmd_base)
        self.assertEqual(cfg["venv_python"], "/wt/feature-z/.venv/bin/python")

    def test_worktree_without_dedicated_venv_has_no_venv_python(self):
        cfg = services.build_start_config(self.CFG, "ww1")
        self.assertNotIn("venv_python", cfg)

    def test_shell_cmd_uses_worktree_checkout(self):
        # /api/assets/generate with a workspace: the shell command must run the
        # worktree's own odoo-bin from its own checkout
        from backend import server

        cfg = services.build_start_config(self.CFG, "ww1")
        cmd = server.build_shell_cmd(cfg, "wwdb")
        self.assertIn("cd /wt/feature-x/community", cmd)
        self.assertIn("/wt/feature-x/community/odoo-bin", cmd)

    def test_worktree_with_venv_end_to_end_runs_its_own_odoo_bin_via_its_own_venv(self):
        # the full chain a real server start goes through: build_start_config
        # (worktree + venv resolution) feeding build_odoo_cmd (the shell cmd) — the
        # odoo-bin invoked must be feature-z's own, run by feature-z's own venv,
        # never the main/global community checkout or python
        from backend import server

        cfg = services.build_start_config(self.CFG, "ww3")
        orig = server.DATABASE.db_initialized
        server.DATABASE.db_initialized = lambda db: True
        try:
            cmd, db, _is_new = server.build_odoo_cmd(cfg)
        finally:
            server.DATABASE.db_initialized = orig
        self.assertEqual(db, "wzdb")
        self.assertIn("cd /wt/feature-z/community &&", cmd)
        self.assertIn(
            "/wt/feature-z/.venv/bin/python /wt/feature-z/community/odoo-bin", cmd
        )
        self.assertNotIn("/c/odoo-bin", cmd)  # never the global community repo's own

    def test_worktree_workspace_gets_docker_fields(self):
        # launch_mode="docker" needs the worktree root dir and the main repo's
        # checked-out branch (image resolution). docker_container is NOT set
        # here -- it's a "dev"/"dev1"/"dev2" pooled slot picked live at start
        # time (DockerInfraService.next_container_slot), not derived from the
        # workspace at all
        cfg = services.build_start_config(self.CFG, "ww1")
        self.assertEqual(cfg["docker_worktree_dir"], "/wt/feature-x")
        self.assertNotIn("docker_container", cfg)
        self.assertEqual(cfg["docker_branch"], "feat")

    def test_plain_workspace_has_no_docker_fields(self):
        cfg = services.build_start_config(self.CFG, "w1")
        self.assertNotIn("docker_worktree_dir", cfg)
        self.assertNotIn("docker_container", cfg)
        self.assertNotIn("docker_branch", cfg)

    def test_missing_db_falls_back_to_workspace_name_slug(self):
        # a workspace created with a blank Database field must still start,
        # rather than hard-failing with "no database configured" — falls back
        # to the workspace's own name, sanitized the same way as a worktree
        # folder name
        cfg_no_db = {
            **self.CFG,
            "workspaces": [
                {**w, "db": ""} if w["id"] == "ww1" else w for w in self.CFG["workspaces"]
            ],
        }
        cfg = services.build_start_config(cfg_no_db, "ww1")
        self.assertEqual(cfg["start"]["db"], "feature-x")

    def test_explicit_db_is_never_overridden(self):
        cfg = services.build_start_config(self.CFG, "ww1")
        self.assertEqual(cfg["start"]["db"], "wwdb")


class BuildOdooCmdTest(unittest.TestCase):
    """--without-demo mirrors the target's demo_data flag (config_models.js
    Target.demo_data): dfc6299c hardcoded it off for every start, this makes it
    per-target, defaulting on."""

    def _cmd(
        self,
        demo_data=None,
        rust_bundler=False,
        test_tags=None,
        memcheck=False,
        memleak_check_installed=False,
        log_level=None,
    ):
        from backend import server

        start = {"repos": ["community"], "db": "db1"}
        if demo_data is not None:
            start["demo_data"] = demo_data
        if test_tags is not None:
            start["test_tags"] = test_tags
        if memcheck:
            start["memcheck"] = True
        config = {
            "repos": [{"id": "community", "path": "/repo/community"}],
            "start": start,
            "rust_bundler": rust_bundler,
        }
        if log_level is not None:
            config["log_level"] = log_level
        orig_init = server.DATABASE.db_initialized
        orig_installed = server.DATABASE.installed_modules
        server.DATABASE.db_initialized = lambda db: True  # skip the real psql probe
        server.DATABASE.installed_modules = lambda db: (
            {"memleak_check": "installed"} if memleak_check_installed else {}
        )
        try:
            cmd, _db, _is_new = server.build_odoo_cmd(config)
        finally:
            server.DATABASE.db_initialized = orig_init
            server.DATABASE.installed_modules = orig_installed
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

    def test_memcheck_is_a_plain_option_on_the_classic_test_tags_run(self):
        # no special syntax: whatever --test-tags value the classic run
        # already uses is passed through completely unchanged
        cmd = self._cmd(
            test_tags="web:WebSuite.test_unit_desktop", memcheck=True,
            memleak_check_installed=True,
        )
        self.assertIn("--test-tags web:WebSuite.test_unit_desktop", cmd)
        self.assertIn("MEMCHECK_DUMP_DIR=", cmd)

    def test_memcheck_skips_install_when_memleak_check_already_installed(self):
        # crucial: once installed, memleak_check must NOT get a bare -i/-u
        # bundled into the actual --test-tags run — that would flip Odoo's
        # post_install test-discovery scope to just-updated modules only
        # (registry.updated_modules), silently excluding the real target
        # module's own tests (the regression this replaced: a memcheck run on
        # an already-installed target module executed 0 tests)
        cmd = self._cmd(test_tags="sale", memcheck=True, memleak_check_installed=True)
        self.assertNotIn("-i memleak_check", cmd)
        self.assertNotIn("-u memleak_check", cmd)
        self.assertEqual(cmd.count("--test-tags"), 1)

    def test_memcheck_bootstraps_memleak_check_in_a_prior_separate_invocation(self):
        # not installed yet: install it via ITS OWN odoo-bin invocation first
        # (no --test-tags there, so it can't narrow this bootstrap's own
        # module-discovery scope), then the real --test-tags run follows,
        # untouched by any -i/-u
        cmd = self._cmd(test_tags="sale", memcheck=True, memleak_check_installed=False)
        self.assertIn("-i memleak_check --stop-after-init", cmd)
        bootstrap_end = cmd.index("--stop-after-init") + len("--stop-after-init")
        self.assertNotIn("--test-tags", cmd[:bootstrap_end])
        rest = cmd[bootstrap_end:]
        self.assertIn("--test-tags sale", rest)
        self.assertNotIn("-i memleak_check", rest)

    def test_memcheck_off_does_not_touch_the_command_at_all(self):
        cmd = self._cmd(test_tags="sale", memcheck=False)
        self.assertNotIn("memleak_check", cmd)
        self.assertNotIn("MEMCHECK_DUMP_DIR", cmd)
        self.assertNotIn("memlab", cmd)

    def test_memcheck_without_test_tags_is_a_no_op(self):
        # memcheck only makes sense alongside a real test run
        cmd = self._cmd(memcheck=True)
        self.assertNotIn("memleak_check", cmd)
        self.assertNotIn("MEMCHECK_DUMP_DIR", cmd)

    def test_memcheck_chains_memlab_find_leaks_on_the_dumped_snapshots(self):
        cmd = self._cmd(test_tags="sale", memcheck=True, memleak_check_installed=True)
        self.assertIn("&& npx --yes memlab@latest find-leaks", cmd)
        self.assertIn("--baseline", cmd)
        self.assertIn("baseline.heapsnapshot", cmd)
        self.assertIn("--target", cmd)
        self.assertIn("target.heapsnapshot", cmd)
        self.assertIn("--final", cmd)
        self.assertIn("final.heapsnapshot", cmd)
        self.assertIn("--work-dir", cmd)

    def test_venv_python_invokes_odoo_bin_via_the_dedicated_interpreter(self):
        from backend import server

        config = {
            "repos": [{"id": "community", "path": "/wt/feature-z/community"}],
            "start": {"repos": ["community"], "db": "db1"},
            "venv_activate": "source /wt/feature-z/.venv/bin/activate",
            "venv_python": "/wt/feature-z/.venv/bin/python",
        }
        orig = server.DATABASE.db_initialized
        server.DATABASE.db_initialized = lambda db: True
        try:
            cmd, _db, _is_new = server.build_odoo_cmd(config)
        finally:
            server.DATABASE.db_initialized = orig
        self.assertIn("source /wt/feature-z/.venv/bin/activate &&", cmd)
        # the venv's own python invokes odoo-bin explicitly — correct regardless
        # of odoo-bin's shebang line
        self.assertIn(
            "/wt/feature-z/.venv/bin/python /wt/feature-z/community/odoo-bin", cmd
        )

    def test_without_venv_python_odoo_bin_runs_directly(self):
        self.assertIn("&& /repo/community/odoo-bin", self._cmd())
        self.assertNotIn("bin/python /repo/community/odoo-bin", self._cmd())

    def test_log_level_unset_by_default(self):
        self.assertNotIn("--log-level", self._cmd())

    def test_log_level_applied_when_set(self):
        self.assertIn("--log-level warn", self._cmd(log_level="warn"))

    def test_full_command_shape_is_pinned(self):
        # a golden/exact-string regression pin (the other tests here only check
        # substrings) — guards _odoo_bin_invocation's split from build_odoo_cmd
        # (the prefix/argument-tail refactor for Docker launch mode) against any
        # accidental reordering or stray whitespace in the assembled command
        from backend import server

        self.assertEqual(
            self._cmd(),
            "cd /repo/community && /repo/community/odoo-bin -r odoo -w odoo -d db1 "
            "--database db1 --no-database-list --without-demo false "
            "--addons-path addons," + server.ADDONS_DIR,
        )


class BuildDockerCmdTest(unittest.TestCase):
    """build_docker_cmd shares _odoo_bin_invocation's argument tail with
    build_odoo_cmd (see BuildOdooCmdTest) — these tests cover what's genuinely
    different: the `docker run` invocation prefix itself."""

    def _cmd(self, **extra_config):
        from backend import server

        config = {
            "start": {"repos": ["community", "enterprise"], "db": "db1"},
            "main_repo_id": "community",
            "docker_worktree_dir": "/wt/feature-x",
            "docker_container": "feature-x",
            "docker_network": "goo_odoo",
            "docker_postgres_container": "goo-postgres",
            "docker_mount_path": "/src",
            **extra_config,
        }
        orig = server.DATABASE.db_initialized
        server.DATABASE.db_initialized = lambda db: True
        try:
            return server.build_docker_cmd(config, "goo-odoo-noble:latest")
        finally:
            server.DATABASE.db_initialized = orig

    def test_basic_shape(self):
        from backend import server

        cmd, db, _is_new = self._cmd()
        self.assertEqual(db, "db1")
        self.assertIn("docker run --rm -it --network goo_odoo --name feature-x", cmd)
        # --workdir is docker's equivalent of build_odoo_cmd's `cd {community_path}
        # &&` — without it, relative addons-path entries resolve against the
        # image's own WORKDIR instead of the checkout (caught by actually running
        # this command against a real container, not just string assertions)
        self.assertIn("--workdir /src/community", cmd)
        # docker run does not propagate the host's env into the container (unlike
        # a local subprocess, which inherits goo's own PGHOST/PGPORT) — odoo-bin
        # needs the connection info as explicit CLI flags instead
        self.assertIn("--db_host goo-postgres --db_port 5432", cmd)
        # odoo-bin's default HTTP bind is loopback-only, invisible to nginx
        # reaching in from its own container (confirmed live: DNS resolves,
        # TCP connect refused, without this flag)
        self.assertIn("--http-interface 0.0.0.0", cmd)
        self.assertIn("-v /wt/feature-x:/src", cmd)
        self.assertIn(f"-v {server.ADDONS_DIR}:/goo-addons:ro", cmd)
        self.assertIn("goo-odoo-noble:latest python3 /src/community/odoo-bin", cmd)
        # addons path: main repo → "addons" (a subdir of the workdir), every other
        # repo → "../<repo_id>" (a SIBLING of the workdir, matching the sibling
        # layout build_start_config's worktree branch actually gives every repo
        # host-side — a bare "enterprise" would resolve one level too deep)
        self.assertIn("--addons-path addons,../enterprise,/goo-addons", cmd)
        # no filestore configured → no filestore mount
        self.assertNotIn("filestore", cmd)
        # goo-postgres hosts every docker-mode workspace's db together — scope
        # this instance to its own, and never let a paused breakpoint get
        # killed by odoo's own worker time limits
        self.assertIn("--db-filter '^db1$'", cmd)  # shlex-quoted: $/^ need shell-escaping
        self.assertIn("--limit-time-cpu 9999999999 --limit-time-real 9999999999", cmd)
        # headed-browser off by default — none of its flags/mounts appear
        self.assertNotIn("--privileged", cmd)
        self.assertNotIn("--shm-size", cmd)
        self.assertNotIn("DISPLAY", cmd)

    def test_headed_browser_off_by_default_even_with_a_display(self):
        with unittest.mock.patch.dict("os.environ", {"DISPLAY": ":1"}):
            cmd, _db, _is_new = self._cmd()
        self.assertNotIn("--privileged", cmd)
        self.assertNotIn("DISPLAY", cmd)

    def test_headed_browser_with_display_forwards_x11(self):
        with unittest.mock.patch.dict("os.environ", {"DISPLAY": ":1"}):
            cmd, _db, _is_new = self._cmd(docker_headed_browser=True)
        self.assertIn("--privileged", cmd)
        self.assertIn("--shm-size=1g", cmd)
        self.assertIn("-e DISPLAY=:1", cmd)
        self.assertIn("-v /tmp/.X11-unix:/tmp/.X11-unix:rw", cmd)

    def test_headed_browser_without_a_display_skips_x11_but_keeps_the_rest(self):
        # --privileged/--shm-size still help a headless-over-SSH browser test;
        # there's just no X server to mount a socket for
        with unittest.mock.patch.dict("os.environ", {}, clear=True):
            cmd, _db, _is_new = self._cmd(docker_headed_browser=True)
        self.assertIn("--privileged", cmd)
        self.assertIn("--shm-size=1g", cmd)
        self.assertNotIn("DISPLAY", cmd)
        self.assertNotIn("X11-unix", cmd)

    def test_filestore_mount_included_when_configured(self):
        cmd, _db, _is_new = self._cmd(
            filestore="/home/me/filestore", docker_filestore_mount="/odoo/filestore"
        )
        self.assertIn("-v /home/me/filestore:/odoo/filestore", cmd)

    def test_container_user_and_extra_args_passthrough(self):
        cmd, _db, _is_new = self._cmd(
            docker_container_user="1000:1000", docker_extra_run_args="--memory=4g"
        )
        self.assertIn("--user 1000:1000", cmd)
        self.assertIn("--memory=4g", cmd)
        # both land before the image, after the mounts
        self.assertLess(cmd.index("--user"), cmd.index("goo-odoo-noble:latest"))

    def test_raises_without_db(self):
        with self.assertRaises(ValueError):
            self._cmd(start={"repos": ["community"], "db": ""})

    def test_raises_without_main_repo_in_start_repos(self):
        with self.assertRaises(ValueError):
            self._cmd(start={"repos": ["enterprise"], "db": "db1"})

    def test_raises_without_docker_worktree_dir(self):
        with self.assertRaises(ValueError):
            self._cmd(docker_worktree_dir="")

    def test_raises_without_docker_container(self):
        with self.assertRaises(ValueError):
            self._cmd(docker_container="")

    def test_raises_on_memcheck(self):
        # not yet supported in Docker mode (see build_docker_cmd) — must fail
        # clearly rather than crash on a None dump_dir
        with self.assertRaises(ValueError):
            self._cmd(start={"repos": ["community"], "db": "db1", "test_tags": "sale", "memcheck": True})


class BuildDockerShellCmdTest(unittest.TestCase):
    """build_docker_shell_cmd shares _docker_run_prefix's mounts/network setup
    with build_docker_cmd (see BuildDockerCmdTest) — these tests cover what's
    genuinely different: no --name (runs alongside an already-started server),
    and the odoo-bin `shell` tail instead of the server flags."""

    def _cmd(self, db="db1", **extra_config):
        from backend import server

        config = {
            "start": {"repos": ["community", "enterprise"], "db": db},
            "main_repo_id": "community",
            "docker_worktree_dir": "/wt/feature-x",
            "docker_network": "goo_odoo",
            "docker_postgres_container": "goo-postgres",
            "docker_mount_path": "/src",
            **extra_config,
        }
        return server.build_docker_shell_cmd(config, db, "goo-odoo-noble:latest")

    def test_basic_shape(self):
        cmd = self._cmd()
        self.assertIn("docker run --rm -it --network goo_odoo", cmd)
        # no --name: a standalone container, independent of (and never
        # colliding with) the workspace's own running server container
        self.assertNotIn("--name", cmd)
        self.assertIn("--workdir /src/community", cmd)
        self.assertIn("-v /wt/feature-x:/src", cmd)
        self.assertIn("--addons-path addons,../enterprise,/goo-addons", cmd)
        self.assertIn(
            "goo-odoo-noble:latest python3 /src/community/odoo-bin shell "
            "-d db1 -r odoo -w odoo --no-http --no-database-list",
            cmd,
        )
        self.assertIn("--db_host goo-postgres --db_port 5432", cmd)
        self.assertIn("--log-level=warn", cmd)
        # server-only flags don't belong on a one-off REPL
        self.assertNotIn("--http-interface", cmd)
        self.assertNotIn("--db-filter", cmd)
        self.assertNotIn("--limit-time", cmd)

    def test_container_user_and_extra_args_passthrough(self):
        cmd = self._cmd(docker_container_user="1000:1000", docker_extra_run_args="--memory=4g")
        self.assertIn("--user 1000:1000", cmd)
        self.assertIn("--memory=4g", cmd)

    def test_raises_on_invalid_db_name(self):
        with self.assertRaises(ValueError):
            self._cmd(db="; rm -rf /")

    def test_raises_without_docker_worktree_dir(self):
        with self.assertRaises(ValueError):
            self._cmd(docker_worktree_dir="")

    def test_raises_without_main_repo_in_start_repos(self):
        with self.assertRaises(ValueError):
            self._cmd(start={"repos": ["enterprise"], "db": "db1"})


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
        "docker_container",
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


class ResolveDockerImageTest(unittest.TestCase):
    JAMMY = {"id": "jammy", "versions": ["16.0", "17.0"], "image": "jammy:latest"}
    NOBLE = {
        "id": "noble",
        "versions": ["18.0", "saas-18", "19.0", "saas-19", "master"],
        "image": "noble:latest",
        "is_default": True,
    }

    def test_prefix_match_wins(self):
        row = services.resolve_docker_image("16.0-fix-jpp", [self.JAMMY, self.NOBLE])
        self.assertEqual(row["id"], "jammy")

    def test_falls_back_to_default_when_nothing_matches(self):
        row = services.resolve_docker_image("master-feature-jpp", [self.JAMMY, self.NOBLE])
        self.assertEqual(row["id"], "noble")

    def test_none_when_no_match_and_no_default(self):
        row = services.resolve_docker_image("16.0-fix-jpp", [{"id": "x", "versions": ["17.0"]}])
        self.assertIsNone(row)

    def test_empty_list_is_none(self):
        self.assertIsNone(services.resolve_docker_image("master-x-jpp", []))


class DockerInfraServiceTest(unittest.TestCase):
    CONFIG = {
        "docker_network": "goo_odoo",
        "docker_postgres_container": "goo-postgres",
        "docker_postgres_image": "postgres:16",
        "docker_postgres_port": "5433",
        "docker_postgres_volume": "goo-postgres-data",
        "docker_nginx_container": "goo-nginx",
        "docker_nginx_image": "nginx:alpine",
        "docker_nginx_port": "80",
        "db_user": "odoo",
        "db_password": "odoo",
        "docker_images": [
            {"id": "jammy", "versions": ["16.0"], "dockerfile_path": "~/docker/jammy.Dockerfile"},
        ],
    }

    def _svc(self, **kwargs):
        io = FakeIO(**kwargs)
        return services.DockerInfraService(io, "/cfg/docker/nginx.conf"), io

    def test_ensure_network_skips_create_when_already_present(self):
        svc, io = self._svc(runs={"network inspect goo_odoo": completed(returncode=0)})
        ok, err = svc.ensure_network("goo_odoo")
        self.assertTrue(ok)
        self.assertIsNone(err)
        self.assertFalse(any("network create" in " ".join(c) for c in io.run_calls))

    def test_ensure_network_creates_when_missing(self):
        svc, io = self._svc(
            runs={
                "network inspect goo_odoo": completed(returncode=1),
                "network create goo_odoo": completed(returncode=0),
            }
        )
        ok, err = svc.ensure_network("goo_odoo")
        self.assertTrue(ok)
        self.assertIsNone(err)

    def test_ensure_postgres_noop_when_running(self):
        svc, io = self._svc(runs={"docker inspect -f": completed(stdout="true\n")})
        ok, err = svc.ensure_postgres(self.CONFIG)
        self.assertTrue(ok)
        self.assertFalse(any("docker run" in " ".join(c) for c in io.run_calls))

    def test_ensure_postgres_starts_stopped_container(self):
        svc, io = self._svc(
            runs={
                "docker inspect -f": completed(stdout="false\n"),
                "docker start goo-postgres": completed(returncode=0),
            }
        )
        ok, err = svc.ensure_postgres(self.CONFIG)
        self.assertTrue(ok)
        self.assertTrue(any(c[:2] == ["docker", "start"] for c in io.run_calls))

    def test_ensure_postgres_creates_when_missing(self):
        svc, io = self._svc(runs={"docker inspect -f": completed(returncode=1)})
        ok, err = svc.ensure_postgres(self.CONFIG)
        self.assertTrue(ok)
        run_cmd = next(c for c in io.run_calls if c[:2] == ["docker", "run"])
        joined = " ".join(run_cmd)
        self.assertIn("--name goo-postgres", joined)
        self.assertIn("--network goo_odoo", joined)
        self.assertIn("POSTGRES_USER=odoo", joined)
        self.assertIn("POSTGRES_PASSWORD=odoo", joined)
        self.assertIn("127.0.0.1:5433:5432", joined)
        self.assertIn("goo-postgres-data:/var/lib/postgresql/data", joined)
        self.assertIn("postgres:16", run_cmd)

    def test_ensure_nginx_writes_config_and_creates_when_missing(self):
        svc, io = self._svc(runs={"docker inspect -f": completed(returncode=1)})
        ok, err = svc.ensure_nginx(self.CONFIG)
        self.assertTrue(ok)
        self.assertIn("/cfg/docker/nginx.conf", io._files)
        self.assertIn("resolver 127.0.0.11", io._files["/cfg/docker/nginx.conf"])
        run_cmd = next(c for c in io.run_calls if c[:2] == ["docker", "run"])
        joined = " ".join(run_cmd)
        self.assertIn("--name goo-nginx", joined)
        self.assertIn("80:80", joined)
        self.assertIn("/cfg/docker/nginx.conf:/etc/nginx/nginx.conf:ro", joined)

    def test_ensure_nginx_noop_when_running(self):
        svc, io = self._svc(runs={"docker inspect -f": completed(stdout="true\n")})
        ok, err = svc.ensure_nginx(self.CONFIG)
        self.assertTrue(ok)
        self.assertFalse(any("docker run" in " ".join(c) for c in io.run_calls))

    def test_ensure_image_returns_existing_tag_without_building(self):
        svc, io = self._svc(runs={"image inspect": completed(returncode=0)})
        tag, err = svc.ensure_image(self.CONFIG, "16.0-fix-jpp")
        # CONFIG's jammy row has no literal `image` — the tag is derived from its id
        self.assertEqual(tag, "goo-jammy")
        self.assertIsNone(err)
        self.assertFalse(any("docker build" in " ".join(c) for c in io.run_calls))

    def test_ensure_image_builds_when_tag_missing_locally(self):
        svc, io = self._svc(
            runs={
                "image inspect": completed(returncode=1),
                "docker build": completed(returncode=0),
            }
        )
        tag, err = svc.ensure_image(self.CONFIG, "16.0-fix-jpp")
        self.assertIsNone(err)
        self.assertTrue(any(c[:2] == ["docker", "build"] for c in io.run_calls))

    def test_ensure_image_errors_without_a_matching_row(self):
        svc, io = self._svc()
        tag, err = svc.ensure_image({"docker_images": []}, "16.0-fix-jpp")
        self.assertIsNone(tag)
        self.assertIn("no Docker image configured", err)

    def test_ensure_image_errors_when_missing_and_no_dockerfile(self):
        svc, io = self._svc(runs={"image inspect": completed(returncode=1)})
        config = {"docker_images": [{"id": "x", "versions": ["16.0"], "image": "prebuilt:tag"}]}
        tag, err = svc.ensure_image(config, "16.0-fix-jpp")
        self.assertIsNone(tag)
        self.assertIn("isn't built locally", err)

    def test_next_container_slot_picks_plain_dev_when_free(self):
        svc, io = self._svc(runs={"container inspect dev": completed(returncode=1)})
        self.assertEqual(svc.next_container_slot(), "dev")

    def test_next_container_slot_skips_taken_slots(self):
        # substring matching (FakeIO) can't tell "dev" from "dev1"/"dev2" apart
        # here, so match on the exact inspected name instead
        class IO(FakeIO):
            def run(self, cmd, **kwargs):
                self.run_calls.append(cmd)
                return completed(returncode=0 if cmd[-1] in ("dev", "dev1") else 1)

        svc = services.DockerInfraService(IO(), "/cfg/docker/nginx.conf")
        self.assertEqual(svc.next_container_slot(), "dev2")


class FieldOkTest(unittest.TestCase):
    """_field_ok's per-kind truthiness rules — every post_route's validation gate."""

    def test_default_kind_is_plain_truthy(self):
        from backend import server

        self.assertTrue(server._field_ok({"x": "a"}, "x"))
        self.assertFalse(server._field_ok({"x": ""}, "x"))
        self.assertFalse(server._field_ok({}, "x"))

    def test_str_kind_requires_non_empty_string(self):
        from backend import server

        self.assertTrue(server._field_ok({"x": "a"}, "x:str"))
        self.assertFalse(server._field_ok({"x": ""}, "x:str"))
        self.assertFalse(server._field_ok({"x": 1}, "x:str"))

    def test_strip_kind_requires_non_blank_content(self):
        from backend import server

        self.assertTrue(server._field_ok({"x": "  a "}, "x:strip"))
        self.assertFalse(server._field_ok({"x": "   "}, "x:strip"))
        self.assertFalse(server._field_ok({"x": 1}, "x:strip"))

    def test_list_kind_allows_empty_list(self):
        from backend import server

        self.assertTrue(server._field_ok({"x": []}, "x:list"))
        self.assertTrue(server._field_ok({"x": [1]}, "x:list"))
        self.assertFalse(server._field_ok({"x": "a"}, "x:list"))
        self.assertFalse(server._field_ok({}, "x:list"))

    def test_list_plus_kind_requires_non_empty_list(self):
        from backend import server

        self.assertTrue(server._field_ok({"x": [1]}, "x:list+"))
        self.assertFalse(server._field_ok({"x": []}, "x:list+"))
        self.assertFalse(server._field_ok({"x": "a"}, "x:list+"))


class PostRouteMissingMessageTest(unittest.TestCase):
    """post_route's auto-generated `missing` message, per required-field spec."""

    def _register(self, *required, missing=""):
        from backend import server

        path = "/__test__/probe"

        @server.post_route(path, *required, missing=missing)
        def _probe(body):
            return {"ok": True}

        try:
            return server.POST_ROUTES[path]
        finally:
            del server.POST_ROUTES[path]

    def test_single_plain_field(self):
        _fn, _required, missing = self._register("workspace")
        self.assertEqual(missing, "missing workspace")

    def test_single_list_field_gets_list_suffix(self):
        _fn, _required, missing = self._register("repos:list")
        self.assertEqual(missing, "missing repos list")

    def test_single_list_plus_field_gets_list_suffix(self):
        _fn, _required, missing = self._register("repos:list+")
        self.assertEqual(missing, "missing repos list")

    def test_multiple_fields_joined_with_or_no_list_suffix(self):
        _fn, _required, missing = self._register("workspace", "prompt:str")
        self.assertEqual(missing, "missing workspace or prompt")

    def test_explicit_missing_overrides_generated_one(self):
        _fn, _required, missing = self._register("repos", missing="custom message")
        self.assertEqual(missing, "custom message")


class _FakeGitForHandlers:
    """Stand-in for GIT used by _api_workspace_create/_remove tests — records every
    call so the test asserts on the handler's own orchestration, not GitService's
    (separately tested) internals. worktree_add's result is scripted per repo id."""

    def __init__(self, worktree_add_results=None, owl_start="master", doc_attach_fails=False):
        self.worktree_add_results = worktree_add_results or {}
        self.owl_start = owl_start
        self.doc_attach_fails = doc_attach_fails
        self.worktree_add_calls = []
        self.worktree_remove_calls = []
        self.write_odoo_conf_calls = []
        self.create_worktree_claude_md_calls = []
        self.create_worktree_skills_calls = []

    def worktree_add(self, main_path, worktree_path, branch, repo="", **kwargs):
        self.worktree_add_calls.append(
            {
                "main_path": main_path,
                "worktree_path": worktree_path,
                "branch": branch,
                "repo": repo,
                **kwargs,
            }
        )
        # the documentation "attach an existing branch" call (unlike its
        # fresh-fork fallback) never passes new_branch — the one way to tell
        # the two documentation worktree_add calls apart here
        if repo == "documentation" and self.doc_attach_fails and "new_branch" not in kwargs:
            return False, "no such branch on origin"
        return self.worktree_add_results.get(repo, (True, None))

    def worktree_remove(self, main_path, worktree_path, repo=""):
        self.worktree_remove_calls.append((main_path, worktree_path, repo))
        return True, None

    def resolve_owl_worktree_start(self, community_path, owl_main_path, pull_remote=None):
        return self.owl_start

    def write_odoo_conf(self, worktree_parent, addons_path, db_user, db_password):
        self.write_odoo_conf_calls.append((worktree_parent, addons_path, db_user, db_password))

    def create_worktree_claude_md(
        self, worktree_parent, dev_branch, has_enterprise, documentation_path, owl_path
    ):
        self.create_worktree_claude_md_calls.append(
            (worktree_parent, dev_branch, has_enterprise, documentation_path, owl_path)
        )

    def create_worktree_skills(
        self, community_path, worktree_parent, dev_branch, documentation_path, owl_path
    ):
        self.create_worktree_skills_calls.append(
            (community_path, worktree_parent, dev_branch, documentation_path, owl_path)
        )


class _FakeConfigStore:
    def __init__(self, config):
        self._config = config

    def get(self):
        return {"rev": 1, "config": self._config, "state": {}}


class ApiWorkspaceCreateTest(unittest.TestCase):
    """_api_workspace_create's own orchestration: repo/dev_branch selection, the
    documentation attach-vs-fork branch, the owl auto-fork, the addons_path
    exclusion set, and gating conf/CLAUDE.md/skills generation on every repo's
    worktree_add having succeeded."""

    def setUp(self):
        from backend import server

        self.server = server
        self.orig_git = server.GIT
        self.orig_config = server.CONFIG

    def tearDown(self):
        self.server.GIT = self.orig_git
        self.server.CONFIG = self.orig_config

    def _config(self, main_repo_id=None, extra_repos=None):
        repos = [
            {"id": "documentation", "path": "/repos/documentation", "pull_remote": "origin"},
            {"id": "owl", "path": "/repos/owl", "pull_remote": "origin"},
        ] + (extra_repos or [])
        cfg = {"repos": repos, "db_user": "odoo", "db_password": "secret"}
        if main_repo_id is not None:
            cfg["main_repo_id"] = main_repo_id
        return cfg

    def test_configured_main_repo_id_is_honored_not_hardcoded_community(self):
        # regression test for the main_repo_id fix: the configured main repo id
        # ("odoo", not "community") must drive dev_branch selection and be
        # excluded from the addons_path, just like "community" used to be.
        fake_git = _FakeGitForHandlers()
        self.server.GIT = fake_git
        self.server.CONFIG = _FakeConfigStore(self._config(main_repo_id="odoo"))
        body = {
            "repos": [
                {
                    "repo": "odoo",
                    "mainPath": "/main/odoo",
                    "worktreePath": "/w/odoo",
                    "newBranch": "master-feat-x",
                    "startPoint": "master",
                },
                {
                    "repo": "enterprise",
                    "mainPath": "/main/enterprise",
                    "worktreePath": "/w/enterprise",
                    "newBranch": "master-feat-x",
                    "startPoint": "master",
                },
            ]
        }
        result = self.server._api_workspace_create(body)
        self.assertTrue(result["ok"])
        self.assertEqual(len(fake_git.write_odoo_conf_calls), 1)
        _parent, addons_path, db_user, db_password = fake_git.write_odoo_conf_calls[0]
        paths = addons_path.split(",")
        self.assertIn("/w/odoo/addons", paths)
        self.assertIn("/w/enterprise", paths)
        self.assertNotIn("/w/odoo", paths)  # main repo itself excluded, not just "community"
        self.assertEqual(db_user, "odoo")
        self.assertEqual(db_password, "secret")
        _parent, dev_branch, has_enterprise, _doc, _owl = fake_git.create_worktree_claude_md_calls[
            0
        ]
        self.assertEqual(dev_branch, "master-feat-x")
        self.assertTrue(has_enterprise)

    def test_defaults_to_community_when_main_repo_id_unset(self):
        fake_git = _FakeGitForHandlers()
        self.server.GIT = fake_git
        self.server.CONFIG = _FakeConfigStore(self._config(main_repo_id=None))
        body = {
            "repos": [
                {
                    "repo": "community",
                    "mainPath": "/main/community",
                    "worktreePath": "/w/community",
                    "newBranch": "master-feat-x",
                    "startPoint": "master",
                }
            ]
        }
        result = self.server._api_workspace_create(body)
        self.assertTrue(result["ok"])
        self.assertEqual(len(fake_git.write_odoo_conf_calls), 1)

    def test_a_failed_repo_skips_conf_and_claude_md_generation(self):
        fake_git = _FakeGitForHandlers(worktree_add_results={"enterprise": (False, "boom")})
        self.server.GIT = fake_git
        self.server.CONFIG = _FakeConfigStore(self._config(main_repo_id="odoo"))
        body = {
            "repos": [
                {
                    "repo": "odoo",
                    "mainPath": "/main/odoo",
                    "worktreePath": "/w/odoo",
                    "newBranch": "master-feat-x",
                    "startPoint": "master",
                },
                {
                    "repo": "enterprise",
                    "mainPath": "/main/enterprise",
                    "worktreePath": "/w/enterprise",
                    "newBranch": "master-feat-x",
                    "startPoint": "master",
                },
            ]
        }
        result = self.server._api_workspace_create(body)
        self.assertFalse(result["ok"])
        self.assertEqual(fake_git.write_odoo_conf_calls, [])
        self.assertEqual(fake_git.create_worktree_claude_md_calls, [])
        self.assertEqual(fake_git.create_worktree_skills_calls, [])
        errored = [r for r in result["results"] if r["repo"] == "enterprise"][0]
        self.assertEqual(errored["error"], "boom")

    def test_documentation_attach_used_when_an_existing_branch_was_sent(self):
        fake_git = _FakeGitForHandlers()
        self.server.GIT = fake_git
        self.server.CONFIG = _FakeConfigStore(self._config(main_repo_id="odoo"))
        body = {
            "repos": [
                {
                    "repo": "odoo",
                    "mainPath": "/main/odoo",
                    "worktreePath": "/w/odoo",
                    "newBranch": "master-feat-x",
                    "startPoint": "master",
                },
                {"repo": "documentation", "branch": "master-feat-x-docs"},
            ]
        }
        result = self.server._api_workspace_create(body)
        self.assertTrue(result["ok"])
        doc_calls = [c for c in fake_git.worktree_add_calls if c["repo"] == "documentation"]
        self.assertEqual(len(doc_calls), 1)
        self.assertEqual(doc_calls[0]["branch"], "master-feat-x-docs")
        self.assertFalse(doc_calls[0].get("new_branch"))
        _parent, _dev, _ent, doc_path, _owl = fake_git.create_worktree_claude_md_calls[0]
        self.assertEqual(doc_path, "/w/documentation")

    def test_documentation_forks_from_base_branch_when_nothing_manual(self):
        # ticked with a bundle-matched branch (like the passing attach test) that
        # turns out not to actually exist there — attach fails, falls back to
        # forking fresh from the matching Odoo series (base_branch(dev_branch))
        fake_git = _FakeGitForHandlers(doc_attach_fails=True)
        self.server.GIT = fake_git
        self.server.CONFIG = _FakeConfigStore(self._config(main_repo_id="odoo"))
        body = {
            "repos": [
                {
                    "repo": "odoo",
                    "mainPath": "/main/odoo",
                    "worktreePath": "/w/odoo",
                    "newBranch": "master-feat-x",
                    "startPoint": "master",
                },
                {"repo": "documentation", "branch": "master-feat-x-docs"},
            ]
        }
        result = self.server._api_workspace_create(body)
        self.assertTrue(result["ok"])
        doc_calls = [c for c in fake_git.worktree_add_calls if c["repo"] == "documentation"]
        self.assertEqual(len(doc_calls), 2)
        self.assertEqual(doc_calls[0]["branch"], "master-feat-x-docs")  # failed attach attempt
        self.assertEqual(doc_calls[1]["branch"], "master-feat-x")  # fresh fork fallback
        self.assertTrue(doc_calls[1]["new_branch"])
        self.assertEqual(doc_calls[1]["start_point"], "master")  # base_branch("master-feat-x")

    def test_owl_auto_forked_from_resolved_start(self):
        fake_git = _FakeGitForHandlers(owl_start="abcdef1")
        self.server.GIT = fake_git
        self.server.CONFIG = _FakeConfigStore(self._config(main_repo_id="odoo"))
        body = {
            "repos": [
                {
                    "repo": "odoo",
                    "mainPath": "/main/odoo",
                    "worktreePath": "/w/odoo",
                    "newBranch": "master-feat-x",
                    "startPoint": "master",
                },
                # owl ticked in the create dialog — never carries branch data of its
                # own (see _api_workspace_create), just its presence in body["repos"]
                # signals the checkbox was ticked
                {"repo": "owl"},
            ]
        }
        result = self.server._api_workspace_create(body)
        self.assertTrue(result["ok"])
        owl_calls = [c for c in fake_git.worktree_add_calls if c["repo"] == "owl"]
        self.assertEqual(len(owl_calls), 1)
        self.assertEqual(owl_calls[0]["start_point"], "abcdef1")
        self.assertEqual(owl_calls[0]["worktree_path"], "/w/owl")
        _parent, _dev, _ent, _doc, owl_path = fake_git.create_worktree_claude_md_calls[0]
        self.assertEqual(owl_path, "/w/owl")

    def test_manually_selected_documentation_skips_auto_fork(self):
        fake_git = _FakeGitForHandlers()
        self.server.GIT = fake_git
        self.server.CONFIG = _FakeConfigStore(self._config(main_repo_id="odoo"))
        body = {
            "repos": [
                {
                    "repo": "odoo",
                    "mainPath": "/main/odoo",
                    "worktreePath": "/w/odoo",
                    "newBranch": "master-feat-x",
                    "startPoint": "master",
                },
                {
                    "repo": "documentation",
                    "mainPath": "/main/documentation",
                    "worktreePath": "/w/documentation-manual",
                    "newBranch": "master-feat-x",
                    "startPoint": "master",
                },
            ]
        }
        result = self.server._api_workspace_create(body)
        self.assertTrue(result["ok"])
        # only the one, generic-loop call for documentation — no extra auto-fork call
        doc_calls = [c for c in fake_git.worktree_add_calls if c["repo"] == "documentation"]
        self.assertEqual(len(doc_calls), 1)
        self.assertEqual(doc_calls[0]["worktree_path"], "/w/documentation-manual")
        _parent, _dev, _ent, doc_path, _owl = fake_git.create_worktree_claude_md_calls[0]
        self.assertEqual(doc_path, "/w/documentation-manual")

    def test_no_extra_forks_when_documentation_and_owl_not_configured(self):
        fake_git = _FakeGitForHandlers()
        self.server.GIT = fake_git
        self.server.CONFIG = _FakeConfigStore(
            {"repos": [], "main_repo_id": "odoo", "db_user": "odoo", "db_password": "odoo"}
        )
        body = {
            "repos": [
                {
                    "repo": "odoo",
                    "mainPath": "/main/odoo",
                    "worktreePath": "/w/odoo",
                    "newBranch": "master-feat-x",
                    "startPoint": "master",
                }
            ]
        }
        result = self.server._api_workspace_create(body)
        self.assertTrue(result["ok"])
        self.assertEqual(len(fake_git.worktree_add_calls), 1)  # only the requested repo
        self.assertEqual(len(fake_git.write_odoo_conf_calls), 1)


class ApiWorkspaceRemoveTest(unittest.TestCase):
    """_api_workspace_remove: aggregate ok, the documentation/owl re-derivation
    (never present in body["repos"], since they're auto-forked without the
    frontend's knowledge), and the conditional remove_tree/CLAUDE.forget calls."""

    def setUp(self):
        from backend import server

        self.server = server
        self.orig_git = server.GIT
        self.orig_config = server.CONFIG
        self.orig_effects_is_dir = server.effects.is_dir
        self.orig_effects_remove_tree = server.effects.remove_tree
        self.orig_claude_forget = server.CLAUDE.forget

    def tearDown(self):
        self.server.GIT = self.orig_git
        self.server.CONFIG = self.orig_config
        self.server.effects.is_dir = self.orig_effects_is_dir
        self.server.effects.remove_tree = self.orig_effects_remove_tree
        self.server.CLAUDE.forget = self.orig_claude_forget

    def test_deregisters_auto_forked_documentation_and_owl_and_sweeps_dir(self):
        fake_git = _FakeGitForHandlers()
        self.server.GIT = fake_git
        self.server.CONFIG = _FakeConfigStore(
            {
                "repos": [
                    {"id": "documentation", "path": "/repos/documentation"},
                    {"id": "owl", "path": "/repos/owl"},
                ]
            }
        )
        self.server.effects.is_dir = lambda path: True
        removed = []
        self.server.effects.remove_tree = lambda path: removed.append(path)
        forgotten = []
        self.server.CLAUDE.forget = lambda ws: forgotten.append(ws)

        body = {
            "repos": [
                {"repo": "odoo", "mainPath": "/main/odoo", "worktreePath": "/w/odoo"},
            ],
            "dirPath": "/w",
            "workspace": "feat-x",
        }
        result = self.server._api_workspace_remove(body)
        self.assertTrue(result["ok"])
        doc_owl_removed = {c[2] for c in fake_git.worktree_remove_calls if c[2] != "odoo"}
        self.assertEqual(doc_owl_removed, {"documentation", "owl"})
        self.assertEqual(removed, ["/w"])
        self.assertEqual(forgotten, ["feat-x"])

    def test_no_sweep_or_forget_when_dirpath_and_workspace_absent(self):
        fake_git = _FakeGitForHandlers()
        self.server.GIT = fake_git
        self.server.CONFIG = _FakeConfigStore({"repos": []})
        removed = []
        self.server.effects.remove_tree = lambda path: removed.append(path)
        forgotten = []
        self.server.CLAUDE.forget = lambda ws: forgotten.append(ws)

        body = {"repos": [{"repo": "odoo", "mainPath": "/main/odoo", "worktreePath": "/w/odoo"}]}
        result = self.server._api_workspace_remove(body)
        self.assertTrue(result["ok"])
        self.assertEqual(removed, [])
        self.assertEqual(forgotten, [])

    def test_aggregate_ok_is_false_when_any_repo_fails(self):
        class FailingGit(_FakeGitForHandlers):
            def worktree_remove(self, main_path, worktree_path, repo=""):
                if repo == "odoo":
                    return False, "still dirty"
                return True, None

        self.server.GIT = FailingGit()
        self.server.CONFIG = _FakeConfigStore({"repos": []})
        body = {"repos": [{"repo": "odoo", "mainPath": "/main/odoo", "worktreePath": "/w/odoo"}]}
        result = self.server._api_workspace_remove(body)
        self.assertFalse(result["ok"])


class ApiWorkspaceExternalStatusTest(unittest.TestCase):
    """The docker ps/inspect scan lives directly in the handler, not a service."""

    def setUp(self):
        from backend import server

        self.server = server
        self.orig_run = server.effects.run

    def tearDown(self):
        self.server.effects.run = self.orig_run

    def test_running_when_a_container_serves_the_named_db(self):
        def fake_run(cmd, **kwargs):
            if cmd[:2] == ["docker", "ps"]:
                return completed(stdout="dev1\ndev2\n")
            if cmd[:2] == ["docker", "inspect"] and cmd[-1] == "dev1":
                return completed(stdout="[/bin/sh -c odoo-bin -d other ]")
            if cmd[:2] == ["docker", "inspect"] and cmd[-1] == "dev2":
                return completed(stdout="[/bin/sh -c odoo-bin -d mydb ]")
            return completed(returncode=1)

        self.server.effects.run = fake_run
        result = self.server._api_workspace_external_status({"name": "mydb"})
        self.assertTrue(result["running"])
        self.assertEqual(result["url"], "http://dev2.localhost/")

    def test_not_running_when_docker_ps_fails(self):
        self.server.effects.run = lambda cmd, **kwargs: completed(returncode=1)
        result = self.server._api_workspace_external_status({"name": "mydb"})
        self.assertFalse(result["running"])
        self.assertIsNone(result["url"])

    def test_not_running_when_docker_missing(self):
        def raise_missing(cmd, **kwargs):
            raise FileNotFoundError("docker not found")

        self.server.effects.run = raise_missing
        result = self.server._api_workspace_external_status({"name": "mydb"})
        self.assertTrue(result["ok"])
        self.assertFalse(result["running"])

    def test_not_running_on_timeout(self):
        def raise_timeout(cmd, **kwargs):
            raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout"))

        self.server.effects.run = raise_timeout
        result = self.server._api_workspace_external_status({"name": "mydb"})
        self.assertFalse(result["running"])

    def test_no_matching_container_reports_not_running(self):
        def fake_run(cmd, **kwargs):
            if cmd[:2] == ["docker", "ps"]:
                return completed(stdout="dev1\n")
            return completed(stdout="[/bin/sh -c odoo-bin -d other ]")

        self.server.effects.run = fake_run
        result = self.server._api_workspace_external_status({"name": "mydb"})
        self.assertFalse(result["running"])


class ApiCodeParallelFanoutTest(unittest.TestCase):
    """_api_code_checkout/_api_code_rebase/_api_code_branches_create all fan a
    per-repo git op out over a ThreadPoolExecutor and pool.map the results back —
    verify the empty-list short-circuit and that every repo's own result survives
    the round trip, for all three handlers."""

    def setUp(self):
        from backend import server

        self.server = server
        self.orig_git = server.GIT

    def tearDown(self):
        self.server.GIT = self.orig_git

    def test_checkout_empty_repos_short_circuits(self):
        result = self.server._api_code_checkout({"repos": []})
        self.assertEqual(result, {"ok": True, "results": []})

    def test_checkout_fans_out_and_preserves_each_result(self):
        class FakeGit:
            def checkout(self, path, branch, repo=""):
                return (branch != "bad"), (None if branch != "bad" else "conflict")

        self.server.GIT = FakeGit()
        body = {
            "repos": [
                {"path": "/a", "branch": "feat-x", "repo": "a"},
                {"path": "/b", "branch": "bad", "repo": "b"},
            ]
        }
        result = self.server._api_code_checkout(body)
        self.assertTrue(result["ok"])  # the handler itself always reports ok=True
        by_branch = {r["branch"]: r for r in result["results"]}
        self.assertTrue(by_branch["feat-x"]["ok"])
        self.assertFalse(by_branch["bad"]["ok"])
        self.assertEqual(by_branch["bad"]["error"], "conflict")

    def test_rebase_empty_repos_short_circuits(self):
        result = self.server._api_code_rebase({"repos": []})
        self.assertEqual(result, {"ok": True, "results": []})

    def test_rebase_fans_out_over_repos(self):
        class FakeGit:
            def fetch_rebase(self, path, base, pull_remote, repo):
                return True, None

        self.server.GIT = FakeGit()
        body = {"repos": [{"path": "/a", "base": "master", "repo": "a"}]}
        result = self.server._api_code_rebase(body)
        self.assertEqual(result["results"], [{"repo": "a", "ok": True, "error": None}])

    def test_branches_create_empty_short_circuits(self):
        result = self.server._api_code_branches_create({"branches": []})
        self.assertEqual(result, {"ok": True, "results": []})

    def test_branches_create_fans_out_over_branches(self):
        class FakeGit:
            def create_branch(
                self, path, name, start_point, fresh_start=False, pull_remote=None, repo=""
            ):
                return True, None

        self.server.GIT = FakeGit()
        body = {"branches": [{"path": "/a", "name": "feat-x"}, {"path": "/b", "name": "feat-y"}]}
        result = self.server._api_code_branches_create(body)
        self.assertEqual(
            {r["name"] for r in result["results"]},
            {"feat-x", "feat-y"},
        )


class ApiCodeRemoteBranchesSearchTest(unittest.TestCase):
    def setUp(self):
        from backend import server

        self.server = server
        self.orig_github = server.GITHUB

    def tearDown(self):
        self.server.GITHUB = self.orig_github

    def test_repos_defaults_to_empty_list_when_absent(self):
        class FakeGithub:
            def search_branches(self, repos, query):
                self.seen = (repos, query)
                return []

        fake = FakeGithub()
        self.server.GITHUB = fake
        result = self.server._api_code_remote_branches_search({"query": "master-x"})
        self.assertEqual(result, {"ok": True, "results": []})
        self.assertEqual(fake.seen, ([], "master-x"))

    def test_non_list_repos_is_rejected(self):
        status, payload = self.server._api_code_remote_branches_search(
            {"query": "x", "repos": "not-a-list"}
        )
        self.assertEqual(status, 400)
        self.assertFalse(payload["ok"])


class ApiPrsValidationTest(unittest.TestCase):
    """_api_prs_ready/_api_prs_head/_api_prs_r_plus each carry their own
    copy-pasted repo/number validation — test each independently since a
    regression in one copy wouldn't be caught by testing another."""

    def setUp(self):
        from backend import server

        self.server = server
        self.orig_github = server.GITHUB

    def tearDown(self):
        self.server.GITHUB = self.orig_github

    def _bad_bodies(self):
        return [
            {"repo": "not-a-slug", "number": 1},
            {"repo": "owner/repo/extra", "number": 1},
            {"repo": 123, "number": 1},
            {"repo": "owner/repo", "number": "1"},
            {"repo": "owner/repo", "number": 1.5},
            {"repo": "owner/repo", "number": 0},
            {"repo": "owner/repo", "number": -1},
            {"repo": "owner/repo"},
        ]

    def test_ready_rejects_invalid_repo_or_number(self):
        for body in self._bad_bodies():
            with self.subTest(body=body):
                status, payload = self.server._api_prs_ready(body)
                self.assertEqual(status, 400)
                self.assertFalse(payload["ok"])

    def test_ready_calls_through_on_valid_input(self):
        class FakeGithub:
            def ready_pr(self, repo, number):
                self.seen = (repo, number)
                return True, None

        fake = FakeGithub()
        self.server.GITHUB = fake
        status, payload = self.server._api_prs_ready({"repo": "odoo/odoo", "number": 42})
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(fake.seen, ("odoo/odoo", 42))

    def test_head_rejects_invalid_repo_or_number(self):
        for body in self._bad_bodies():
            with self.subTest(body=body):
                status, payload = self.server._api_prs_head(body)
                self.assertEqual(status, 400)
                self.assertFalse(payload["ok"])

    def test_head_calls_through_on_valid_input(self):
        class FakeGithub:
            def pr_head(self, repo, number):
                return "master-feat-x", None

        self.server.GITHUB = FakeGithub()
        result = self.server._api_prs_head({"repo": "odoo/odoo", "number": 42})
        self.assertEqual(result, {"ok": True, "branch": "master-feat-x"})

    def test_r_plus_rejects_invalid_repo_or_number(self):
        for body in self._bad_bodies():
            with self.subTest(body=body):
                status, payload = self.server._api_prs_r_plus(body)
                self.assertEqual(status, 400)
                self.assertFalse(payload["ok"])

    def test_r_plus_calls_through_on_valid_input(self):
        class FakeGithub:
            def post_r_plus(self, repo, number):
                return True, None

        self.server.GITHUB = FakeGithub()
        status, payload = self.server._api_prs_r_plus({"repo": "odoo/odoo", "number": 42})
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])


class ApiNightlyAndCiMergeStatsTest(unittest.TestCase):
    def setUp(self):
        from backend import server

        self.server = server
        self.orig_nightly = server.NIGHTLY
        self.orig_ci = server.CI

    def tearDown(self):
        self.server.NIGHTLY = self.orig_nightly
        self.server.CI = self.orig_ci

    def test_max_nights_is_clamped_between_7_and_84(self):
        class FakeNightly:
            def builds(self, refresh=False, max_nights=None):
                self.seen = max_nights
                return {"builds": []}

        for requested, expected in [(1, 7), (7, 7), (30, 30), (84, 84), (200, 84)]:
            with self.subTest(requested=requested):
                fake = FakeNightly()
                self.server.NIGHTLY = fake
                self.server._api_nightly({"max_nights": requested})
                self.assertEqual(fake.seen, expected)

    def test_max_nights_defaults_to_14_when_absent(self):
        class FakeNightly:
            def builds(self, refresh=False, max_nights=None):
                self.seen = max_nights
                return {}

        fake = FakeNightly()
        self.server.NIGHTLY = fake
        self.server._api_nightly({})
        self.assertEqual(fake.seen, 14)

    def test_ci_merge_stats_days_is_clamped_between_1_and_60(self):
        class FakeCi:
            def merge_stats(self, days=None, refresh=False):
                self.seen_days = days
                return []

            def queue(self):
                return 3

        for requested, expected in [(0, 1), (1, 1), (14, 14), (60, 60), (400, 60)]:
            with self.subTest(requested=requested):
                fake = FakeCi()
                self.server.CI = fake
                result = self.server._api_ci_merge_stats({"days": requested})
                self.assertEqual(fake.seen_days, expected)
                self.assertEqual(result["awaiting"], 3)

    def test_nightly_errors_rejects_malformed_url(self):
        for bad in ["", "/not/a/build/url", "/runbot/batch/x/build/1"]:
            with self.subTest(url=bad):
                status, payload = self.server._api_nightly_errors({"url": bad})
                self.assertEqual(status, 400)
                self.assertFalse(payload["ok"])

    def test_nightly_errors_accepts_well_formed_url(self):
        class FakeNightly:
            def build_errors(self, url):
                self.seen = url
                return {"errors": [], "metrics": {}}

        fake = FakeNightly()
        self.server.NIGHTLY = fake
        result = self.server._api_nightly_errors({"url": "/runbot/batch/123/build/456"})
        self.assertTrue(result["ok"])
        self.assertEqual(fake.seen, "/runbot/batch/123/build/456")


class ApiAddonsTest(unittest.TestCase):
    def setUp(self):
        from backend import server

        self.server = server
        self.orig_addons = server.ADDONS
        self.orig_database = server.DATABASE
        self.orig_config = server.CONFIG

    def tearDown(self):
        self.server.ADDONS = self.orig_addons
        self.server.DATABASE = self.orig_database
        self.server.CONFIG = self.orig_config

    def test_merges_installed_state_onto_modules_when_db_given(self):
        class FakeAddons:
            def modules(self, repos, main_repo_id):
                self.seen_main_repo_id = main_repo_id
                return [{"name": "sale"}, {"name": "purchase"}]

        class FakeDatabase:
            def installed_modules(self, db):
                return {"sale": "installed"}

        fake_addons = FakeAddons()
        self.server.ADDONS = fake_addons
        self.server.DATABASE = FakeDatabase()
        self.server.CONFIG = _FakeConfigStore({"main_repo_id": "odoo"})
        result = self.server._api_addons({"repos": [], "db": "mydb"})
        by_name = {m["name"]: m["state"] for m in result["modules"]}
        self.assertEqual(by_name, {"sale": "installed", "purchase": None})
        self.assertEqual(fake_addons.seen_main_repo_id, "odoo")

    def test_no_db_skips_installed_state_lookup(self):
        class FakeAddons:
            def modules(self, repos, main_repo_id):
                return [{"name": "sale"}]

        class FakeDatabase:
            def installed_modules(self, db):
                raise AssertionError("should not be called without a db")

        self.server.ADDONS = FakeAddons()
        self.server.DATABASE = FakeDatabase()
        self.server.CONFIG = _FakeConfigStore({})
        result = self.server._api_addons({"repos": []})
        self.assertEqual(result["modules"], [{"name": "sale", "state": None}])
        self.assertIsNone(result["db"])


class ApiAssetsGenerateTest(unittest.TestCase):
    def setUp(self):
        from backend import server

        self.server = server
        self.orig_assets = server.ASSETS
        self.orig_config = server.CONFIG
        self.orig_build_shell_cmd = server.build_shell_cmd

    def tearDown(self):
        self.server.ASSETS = self.orig_assets
        self.server.CONFIG = self.orig_config
        self.server.build_shell_cmd = self.orig_build_shell_cmd

    def test_uses_server_config_when_no_workspace_override(self):
        seen = {}

        def fake_build_shell_cmd(cfg, db):
            seen["cfg"] = cfg
            return "odoo-bin shell"

        class FakeAssets:
            def generate(self, cmd, db):
                seen["cmd"] = cmd
                return True, None

        self.server.build_shell_cmd = fake_build_shell_cmd
        self.server.ASSETS = FakeAssets()
        self.server.CONFIG = _FakeConfigStore({"marker": "server-config"})
        status, payload = self.server._api_assets_generate({"db": "mydb"})
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(seen["cfg"], {"marker": "server-config"})

    def test_workspace_override_resolves_through_build_start_config(self):
        def fake_build_shell_cmd(cfg, db):
            return "odoo-bin shell"

        class FakeAssets:
            def generate(self, cmd, db):
                return True, None

        self.server.build_shell_cmd = fake_build_shell_cmd
        self.server.ASSETS = FakeAssets()
        self.server.CONFIG = _FakeConfigStore({"marker": "server-config"})
        overridden = {"marker": "workspace-config"}
        with unittest.mock.patch.object(
            services, "build_start_config", return_value=overridden
        ) as m:
            status, payload = self.server._api_assets_generate({"db": "mydb", "workspace": "w1"})
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        m.assert_called_once_with({"marker": "server-config"}, "w1")

    def test_value_error_from_build_shell_cmd_maps_to_400(self):
        def raising(cfg, db):
            raise ValueError("invalid database name")

        self.server.build_shell_cmd = raising
        self.server.CONFIG = _FakeConfigStore({})
        status, payload = self.server._api_assets_generate({"db": "; drop"})
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "invalid database name")


class ApiAssetsBreakdownTest(unittest.TestCase):
    def setUp(self):
        from backend import server

        self.server = server
        self.orig_assets = server.ASSETS

    def tearDown(self):
        self.server.ASSETS = self.orig_assets

    def test_unknown_kind_is_normalized_to_none(self):
        class FakeAssets:
            def breakdown(self, db, bundle, filestore, kind):
                self.seen_kind = kind
                return {"js": [], "css": [], "xml": []}, None

        fake = FakeAssets()
        self.server.ASSETS = fake
        self.server._api_assets_breakdown({"db": "mydb", "bundle": "web.assets", "kind": "wat"})
        self.assertIsNone(fake.seen_kind)

    def test_valid_kind_is_passed_through(self):
        class FakeAssets:
            def breakdown(self, db, bundle, filestore, kind):
                self.seen_kind = kind
                return {"js": [], "css": [], "xml": []}, None

        fake = FakeAssets()
        self.server.ASSETS = fake
        self.server._api_assets_breakdown({"db": "mydb", "bundle": "web.assets", "kind": "js"})
        self.assertEqual(fake.seen_kind, "js")

    def test_none_data_maps_to_400(self):
        class FakeAssets:
            def breakdown(self, db, bundle, filestore, kind):
                return None, "bundle not generated yet"

        self.server.ASSETS = FakeAssets()
        status, payload = self.server._api_assets_breakdown({"db": "mydb", "bundle": "web.assets"})
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "bundle not generated yet")


class ApiRustBundlerInstallTest(unittest.TestCase):
    def setUp(self):
        from backend import server

        self.server = server
        self.orig_rust_bundler = server.RUST_BUNDLER
        self.orig_config = server.CONFIG

    def tearDown(self):
        self.server.RUST_BUNDLER = self.orig_rust_bundler
        self.server.CONFIG = self.orig_config

    def test_success_maps_to_200(self):
        class FakeBundler:
            def install(self, config):
                return True, {"installed": True}

        self.server.RUST_BUNDLER = FakeBundler()
        self.server.CONFIG = _FakeConfigStore({})
        status, payload = self.server._api_rust_bundler_install({})
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])

    def test_already_in_progress_maps_to_409(self):
        class FakeBundler:
            def install(self, config):
                return False, {"error": "a build is already in progress"}

        self.server.RUST_BUNDLER = FakeBundler()
        self.server.CONFIG = _FakeConfigStore({})
        status, payload = self.server._api_rust_bundler_install({})
        self.assertEqual(status, 409)

    def test_other_failure_maps_to_500(self):
        class FakeBundler:
            def install(self, config):
                return False, {"error": "cargo not found"}

        self.server.RUST_BUNDLER = FakeBundler()
        self.server.CONFIG = _FakeConfigStore({})
        status, payload = self.server._api_rust_bundler_install({})
        self.assertEqual(status, 500)


class ApiOpenEditorTest(unittest.TestCase):
    def setUp(self):
        from backend import server

        self.server = server
        self.orig_open_in_editor = server.open_in_editor

    def tearDown(self):
        self.server.open_in_editor = self.orig_open_in_editor

    def test_paths_field_preferred_over_path(self):
        seen = {}

        def fake_open(editor, paths):
            seen["paths"] = paths
            return True, None

        self.server.open_in_editor = fake_open
        self.server._api_open_editor({"paths": ["/a", "/b"], "path": "/c"})
        self.assertEqual(seen["paths"], ["/a", "/b"])

    def test_falls_back_to_path_when_paths_absent(self):
        seen = {}

        def fake_open(editor, paths):
            seen["paths"] = paths
            return True, None

        self.server.open_in_editor = fake_open
        self.server._api_open_editor({"path": "/c"})
        self.assertEqual(seen["paths"], "/c")

    def test_neither_field_is_400(self):
        status, payload = self.server._api_open_editor({})
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "missing path")


class ApiReviewPromptSaveTest(unittest.TestCase):
    def setUp(self):
        from backend import server

        self.server = server
        self.orig_write_text = server.effects.write_text

    def tearDown(self):
        self.server.effects.write_text = self.orig_write_text

    def test_write_failure_falls_back_to_generic_message(self):
        self.server.effects.write_text = lambda path, text: (False, "")
        status, payload = self.server._api_review_prompt_save({"content": "x"})
        self.assertEqual(status, 500)
        self.assertEqual(payload["error"], "write failed")

    def test_write_failure_surfaces_real_error_when_present(self):
        self.server.effects.write_text = lambda path, text: (False, "disk full")
        status, payload = self.server._api_review_prompt_save({"content": "x"})
        self.assertEqual(payload["error"], "disk full")

    def test_success(self):
        self.server.effects.write_text = lambda path, text: (True, None)
        result = self.server._api_review_prompt_save({"content": "x"})
        self.assertEqual(result, {"ok": True})


class GitServiceGapTest(unittest.TestCase):
    """Direct coverage for GitService methods only exercised indirectly (commit,
    via wip_commit) or not at all (discard) elsewhere, plus a few failure
    branches on already-tested methods."""

    def test_commit_stages_and_commits_with_the_given_message(self):
        io = FakeIO(runs={"add -A": completed(), "commit --no-verify": completed()})
        svc = services.GitService(io)
        ok, error = svc.commit("/repo", "a real message")
        self.assertTrue(ok)
        self.assertIsNone(error)
        self.assertTrue(any("-m" in c and "a real message" in c for c in io.run_calls))

    def test_commit_short_circuits_when_add_fails(self):
        io = FakeIO(runs={"add -A": completed(returncode=1, stderr="add failed")})
        svc = services.GitService(io)
        ok, error = svc.commit("/repo", "msg")
        self.assertFalse(ok)
        self.assertIn("add failed", error)
        self.assertEqual(len(io.run_calls), 1)  # commit was never attempted

    def test_discard_resets_then_cleans(self):
        io = FakeIO(runs={"reset --hard HEAD": completed(), "clean -fd": completed()})
        svc = services.GitService(io)
        ok, error = svc.discard("/repo")
        self.assertTrue(ok)
        self.assertIsNone(error)
        self.assertTrue(any("reset" in c and "--hard" in c for c in io.run_calls))
        self.assertTrue(any("clean" in c and "-fd" in c for c in io.run_calls))

    def test_discard_short_circuits_when_reset_fails(self):
        io = FakeIO(runs={"reset --hard HEAD": completed(returncode=1, stderr="reset failed")})
        svc = services.GitService(io)
        ok, error = svc.discard("/repo")
        self.assertFalse(ok)
        self.assertIn("reset failed", error)
        self.assertFalse(any("clean" in c for c in io.run_calls))

    def test_abort_rebase_failure_surfaces_error(self):
        io = FakeIO(
            runs={"rebase --abort": completed(returncode=1, stderr="no rebase in progress")}
        )
        svc = services.GitService(io)
        ok, error = svc.abort_rebase("/repo")
        self.assertFalse(ok)
        self.assertIn("no rebase in progress", error)

    def test_remote_branch_exists_error_branch(self):
        io = FakeIO(runs={"ls-remote": completed(returncode=1, stderr="could not resolve host")})
        svc = services.GitService(io)
        exists, error = svc.remote_branch_exists("/repo", "master-feat-x")
        self.assertIsNone(exists)
        self.assertIn("could not resolve host", error)

    def test_remote_branch_exists_true_when_ref_found(self):
        io = FakeIO(runs={"ls-remote": completed(stdout="abc123\trefs/heads/master-feat-x\n")})
        svc = services.GitService(io)
        exists, error = svc.remote_branch_exists("/repo", "master-feat-x")
        self.assertTrue(exists)
        self.assertIsNone(error)

    def test_fetch_master_logs_success(self):
        io = FakeIO(runs={"fetch origin master": completed()})
        svc = services.GitService(io)
        svc.fetch_master({"id": "community", "path": "/repo"})
        self.assertTrue(any("fetched origin/master" in line for line in io.logs))

    def test_fetch_master_logs_failure(self):
        io = FakeIO(runs={"fetch origin master": completed(returncode=1, stderr="network error\n")})
        svc = services.GitService(io)
        svc.fetch_master({"id": "community", "path": "/repo"})
        self.assertTrue(any("failed" in line for line in io.logs))

    def test_fetch_master_logs_exception(self):
        class RaisingIO(FakeIO):
            def run(self, cmd, **kwargs):
                raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout"))

        svc = services.GitService(RaisingIO())
        svc.fetch_master({"id": "community", "path": "/repo"})
        self.assertTrue(any("failed" in line for line in svc.io.logs))

    def test_fetch_master_no_op_without_a_path(self):
        io = FakeIO()
        svc = services.GitService(io)
        svc.fetch_master({"id": "community"})  # no "path" key — should just return
        self.assertEqual(io.run_calls, [])


class DatabaseServiceGapTest(unittest.TestCase):
    def test_odoo_info_parses_a_full_row(self):
        io = FakeIO(
            runs={"SELECT (SELECT latest_version": completed(stdout="17.0|t|f|2024-01-01 00:00:00")}
        )
        svc = services.DatabaseService(io, TTLCache(ttl=0))
        version, enterprise, demo, last_update = svc.odoo_info("mydb")
        self.assertEqual(version, "17.0")
        self.assertTrue(enterprise)
        self.assertFalse(demo)
        self.assertEqual(last_update, "2024-01-01 00:00:00")

    def test_odoo_info_no_odoo_tables(self):
        io = FakeIO(runs={"SELECT (SELECT latest_version": completed(stdout="")})
        svc = services.DatabaseService(io, TTLCache(ttl=0))
        self.assertEqual(svc.odoo_info("mydb"), (None, False, False, None))

    def test_odoo_info_exception_returns_none_tuple(self):
        class RaisingIO(FakeIO):
            def run(self, cmd, **kwargs):
                raise FileNotFoundError("no psql")

        svc = services.DatabaseService(RaisingIO(), TTLCache(ttl=0))
        self.assertEqual(svc.odoo_info("mydb"), (None, False, False, None))

    def test_creation_times_parses_rows(self):
        io = FakeIO(runs={"pg_stat_file": completed(stdout="mydb|2024-01-01 00:00:00\n")})
        svc = services.DatabaseService(io, TTLCache(ttl=0))
        self.assertEqual(svc._creation_times(), {"mydb": "2024-01-01 00:00:00"})

    def test_creation_times_empty_on_permission_failure(self):
        io = FakeIO(runs={"pg_stat_file": completed(returncode=1, stderr="permission denied")})
        svc = services.DatabaseService(io, TTLCache(ttl=0))
        self.assertEqual(svc._creation_times(), {})

    def test_creation_times_empty_on_exception(self):
        class RaisingIO(FakeIO):
            def run(self, cmd, **kwargs):
                raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout"))

        svc = services.DatabaseService(RaisingIO(), TTLCache(ttl=0))
        self.assertEqual(svc._creation_times(), {})

    def test_sizes_parses_rows_as_ints(self):
        io = FakeIO(runs={"pg_database_size": completed(stdout="mydb|1234\n")})
        svc = services.DatabaseService(io, TTLCache(ttl=0))
        self.assertEqual(svc._sizes(), {"mydb": 1234})

    def test_sizes_skips_unparseable_size(self):
        io = FakeIO(runs={"pg_database_size": completed(stdout="mydb|not-a-number\n")})
        svc = services.DatabaseService(io, TTLCache(ttl=0))
        self.assertEqual(svc._sizes(), {})

    def test_sizes_empty_on_exception(self):
        class RaisingIO(FakeIO):
            def run(self, cmd, **kwargs):
                raise FileNotFoundError("no psql")

        svc = services.DatabaseService(RaisingIO(), TTLCache(ttl=0))
        self.assertEqual(svc._sizes(), {})


class CiServiceGapTest(unittest.TestCase):
    CACHE = "/cfg/goo/ci_merge_stats.json"

    def test_load_cache_falls_back_when_file_is_not_a_dict(self):
        io = FakeIO(json_files={self.CACHE: ["not", "a", "dict"]})
        svc = services.CiService(io, self.CACHE)
        self.assertEqual(svc._load_cache(), {"oldest_complete": None, "days": {}})

    def test_load_cache_fills_in_missing_keys(self):
        io = FakeIO(json_files={self.CACHE: {"days": {"2024-01-01": {}}}})
        svc = services.CiService(io, self.CACHE)
        cache = svc._load_cache()
        self.assertIsNone(cache["oldest_complete"])
        self.assertEqual(cache["days"], {"2024-01-01": {}})

    def test_merge_stats_paginates_across_multiple_pages(self):
        today = CiServiceTest._today()
        from datetime import timedelta

        t0 = today.isoformat()
        t_old = (today - timedelta(days=10)).isoformat()
        page1 = _mb_page([_mb_row("bg-success", t0, [("odoo/odoo", 1)])], next_until=t_old)
        page2 = _mb_page(
            [_mb_row("bg-success", t_old, [("odoo/odoo", 2)])]
        )  # no next_until -> exhausted
        io = FakeIO(http={f"until={t_old}": (page2, None), "runbot_merge/1": (page1, None)})
        svc = services.CiService(io, self.CACHE)
        out = svc.merge_stats(days=14)
        self.assertEqual(len(io.http_calls), 2)  # both pages fetched, not just the first
        self.assertEqual(out[0]["merged"], 1)
        self.assertEqual(out[10]["merged"], 1)  # t_old (today-10) folded in from page 2


class MemoryServiceGapTest(unittest.TestCase):
    def test_with_mobile_false_excludes_mobile_suites(self):
        log = (
            "a.WebSuite.Something.js:  [MEMINFO] @some.suite (after GC) - used: 100\n"
            "a.MobileWebSuite.Something.js:  [MEMINFO] @mobile.suite (after GC) - used: 200\n"
        )
        io = FakeIO(http={"logurl": (log, None)})
        svc = services.MemoryService(io)
        rows = svc.fetch([{"label": "b1", "url": "http://logurl"}], with_mobile=False)
        suites = {r["suite"] for r in rows}
        self.assertIn("@some.suite", suites)
        self.assertNotIn("@mobile.suite", suites)

    def test_with_mobile_true_includes_mobile_suites(self):
        log = "a.MobileWebSuite.Something.js:  [MEMINFO] @mobile.suite (after GC) - used: 200\n"
        io = FakeIO(http={"logurl": (log, None)})
        svc = services.MemoryService(io)
        rows = svc.fetch([{"label": "b1", "url": "http://logurl"}], with_mobile=True)
        self.assertEqual([r["suite"] for r in rows], ["@mobile.suite"])

    def test_malformed_meminfo_line_is_dropped(self):
        # has the "[MEMINFO] @" marker the pre-filter checks for, but doesn't match
        # the full regex (missing "(after GC) - used: N")
        log = "a.WebSuite.Something.js:  [MEMINFO] @some.suite nogood\n"
        self.assertEqual(services.MemoryService(FakeIO()).parse_log(log), [])

    def test_line_without_meminfo_marker_is_ignored_before_regex(self):
        log = "just a normal log line with no marker at all\n"
        self.assertEqual(services.MemoryService(FakeIO()).parse_log(log), [])


class GitHubServiceExceptionTest(unittest.TestCase):
    def test_fetch_one_exception_sets_error(self):
        class RaisingIO(FakeIO):
            def run(self, cmd, **kwargs):
                raise FileNotFoundError("no gh")

        svc = services.GitHubService(RaisingIO(), TTLCache(ttl=0))
        entry = svc._fetch_one({"id": "community", "github": "odoo/odoo"})
        self.assertIn("no gh", entry["error"])
        self.assertEqual(entry["prs"], [])

    def test_fetch_one_bad_json_sets_error(self):
        io = FakeIO(run_result=completed(stdout="not json"))
        svc = services.GitHubService(io, TTLCache(ttl=0))
        entry = svc._fetch_one({"id": "community", "github": "odoo/odoo"})
        self.assertEqual(entry["error"], "unexpected gh output")

    def test_fetch_head_returns_none_on_exception(self):
        class RaisingIO(FakeIO):
            def run(self, cmd, **kwargs):
                raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout"))

        svc = services.GitHubService(RaisingIO(), TTLCache(ttl=0))
        self.assertIsNone(svc._fetch_head("odoo/odoo", "master-feat-x"))

    def test_fetch_head_returns_none_on_bad_json(self):
        io = FakeIO(run_result=completed(stdout="not json"))
        svc = services.GitHubService(io, TTLCache(ttl=0))
        self.assertIsNone(svc._fetch_head("odoo/odoo", "master-feat-x"))

    def test_fetch_info_returns_none_on_exception(self):
        class RaisingIO(FakeIO):
            def run(self, cmd, **kwargs):
                raise FileNotFoundError("no gh")

        svc = services.GitHubService(RaisingIO(), TTLCache(ttl=0))
        self.assertIsNone(svc._fetch_info("odoo/odoo", 1))

    def test_pr_head_returns_error_on_malformed_json(self):
        io = FakeIO(run_result=completed(stdout="{not json"))
        svc = services.GitHubService(io, TTLCache(ttl=0))
        branch, error = svc.pr_head("odoo/odoo", 1)
        self.assertEqual(branch, "")
        self.assertTrue(error)

class AddonsServiceGapTest(unittest.TestCase):
    def test_repo_missing_id_or_path_is_skipped(self):
        io = FakeIO(dirs={}, files={})
        svc = services.AddonsService(io)
        self.assertEqual(svc.modules([{"id": "community"}, {"path": "/only/path"}]), [])

    def test_manifest_without_a_top_level_dict_returns_none(self):
        io = FakeIO(
            dirs={"/repo/addons": ["sale"], "/repo/addons/sale": []},
            files={"/repo/addons/sale/__manifest__.py": "print('no dict literal here')"},
        )
        svc = services.AddonsService(io)
        self.assertEqual(svc.modules([{"id": "community", "path": "/repo"}]), [])

    def test_manifest_ast_literal_eval_error_returns_none(self):
        # a dict literal whose value calls a function isn't a literal — ast.literal_eval
        # raises ValueError on it, which _manifest must swallow, not propagate
        io = FakeIO(
            dirs={"/repo/addons": ["sale"], "/repo/addons/sale": []},
            files={
                "/repo/addons/sale/__manifest__.py": "{'name': some_function_call()}",
            },
        )
        svc = services.AddonsService(io)
        self.assertEqual(svc.modules([{"id": "community", "path": "/repo"}]), [])


class AssetsServiceGapTest(unittest.TestCase):
    def test_asset_text_none_when_row_absent(self):
        svc = services.AssetsService(FakeIO(), TTLCache(ttl=0))
        self.assertIsNone(svc._asset_text("db", "/filestore", None))

    def test_asset_text_falls_back_to_none_on_corrupt_filestore_file(self):
        class RaisingIO(FakeIO):
            def read_text(self, path):
                raise ValueError("not valid utf-8")

        svc = services.AssetsService(RaisingIO(), TTLCache(ttl=0))
        self.assertIsNone(svc._asset_text("db", "/filestore", ("stored.js", "")))

    def test_asset_text_falls_back_to_none_on_corrupt_inline_base64(self):
        svc = services.AssetsService(FakeIO(), TTLCache(ttl=0))
        # "abc" is valid base64 alphabet but the wrong length (not a multiple of
        # 4) -- guaranteed invalid padding, unlike relying on non-alphabet chars
        # being silently stripped
        self.assertIsNone(svc._asset_text("db", "/filestore", ("", "abc")))

    def test_asset_text_reads_inline_base64_when_no_store_fname(self):
        import base64

        encoded = base64.b64encode(b"body { color: red }").decode()
        svc = services.AssetsService(FakeIO(), TTLCache(ttl=0))
        self.assertEqual(svc._asset_text("db", "/filestore", ("", encoded)), "body { color: red }")


class ConfigStoreGapTest(unittest.TestCase):
    def test_load_returns_error_shape_on_corrupt_file(self):
        io = FakeIO()
        io.read_json_file = lambda path: (None, "invalid JSON at line 3")
        store = services.ConfigStore(io, "/cfg/goo/config.json")
        result = store.get()
        self.assertEqual(result["rev"], 0)
        self.assertIsNone(result["config"])
        self.assertEqual(result["error"], "invalid JSON at line 3")


class ValidDbNameTest(unittest.TestCase):
    def test_valid_names(self):
        for name in ("master", "19.0", "master-feat-x", "test_db", "a1"):
            with self.subTest(name=name):
                self.assertTrue(services._valid_db_name(name))

    def test_invalid_names(self):
        for name in ("", None, "-leading-dash", "has space", "quote'd", "semi;colon", 123, []):
            with self.subTest(name=name):
                self.assertFalse(services._valid_db_name(name))


class TTLCacheInvalidateTest(unittest.TestCase):
    def test_invalidate_none_clears_every_key(self):
        cache = TTLCache(ttl=3600)
        calls = {"a": 0, "b": 0}

        def compute(key):
            calls[key] += 1
            return f"{key}-{calls[key]}"

        self.assertEqual(cache.get("a", lambda: compute("a")), "a-1")
        self.assertEqual(cache.get("b", lambda: compute("b")), "b-1")
        self.assertEqual(cache.get("a", lambda: compute("a")), "a-1")  # still cached

        cache.invalidate(None)

        self.assertEqual(cache.get("a", lambda: compute("a")), "a-2")
        self.assertEqual(cache.get("b", lambda: compute("b")), "b-2")

    def test_invalidate_one_key_leaves_others_cached(self):
        cache = TTLCache(ttl=3600)
        calls = {"a": 0, "b": 0}

        def compute(key):
            calls[key] += 1
            return calls[key]

        cache.get("a", lambda: compute("a"))
        cache.get("b", lambda: compute("b"))
        cache.invalidate("a")
        self.assertEqual(cache.get("a", lambda: compute("a")), 2)
        self.assertEqual(cache.get("b", lambda: compute("b")), 1)  # untouched


class ModelsDataclassTest(unittest.TestCase):
    def test_server_snapshot_defaults(self):
        snap = ServerSnapshot(id="main", state="running")
        d = asdict(snap)
        self.assertEqual(d["id"], "main")
        self.assertEqual(d["state"], "running")
        self.assertFalse(d["terminal"])
        self.assertIsNone(d["workspace"])
        self.assertIsNone(d["db"])
        self.assertIsNone(d["port"])
        self.assertFalse(d["exited_unexpectedly"])
        self.assertFalse(d["odoo_port_busy"])
        self.assertIsNone(d["exists"])
        self.assertIsNone(d["docker_container"])

    def test_server_snapshot_full_worktree_shape(self):
        snap = ServerSnapshot(
            id="w1",
            state="running",
            terminal=False,
            workspace="w1",
            db="mydb",
            port=9001,
            mode="server",
            pid=1234,
            cmd="odoo-bin",
            started_at=1000.0,
            exists=True,
            docker_container="dev1",
        )
        d = asdict(snap)
        self.assertEqual(d["workspace"], "w1")
        self.assertEqual(d["port"], 9001)
        self.assertTrue(d["exists"])
        self.assertEqual(d["docker_container"], "dev1")

    def test_run_snapshot_defaults(self):
        run = RunSnapshot(id="run-1", kind="test", state="running")
        d = asdict(run)
        self.assertEqual(d["server"], "main")
        self.assertIsNone(d["workspace"])
        self.assertEqual(d["spec"], {})
        self.assertIsNone(d["ok"])
        self.assertFalse(d["resume"])

    def test_run_snapshot_full_shape(self):
        run = RunSnapshot(
            id="run-2",
            kind="install",
            state="done",
            server="w1",
            workspace="w1",
            db="mydb",
            spec={"module": "sale"},
            returncode=0,
            ok=True,
            resume=True,
            started_at=500.0,
        )
        d = asdict(run)
        self.assertEqual(d["spec"], {"module": "sale"})
        self.assertTrue(d["ok"])
        self.assertTrue(d["resume"])

    def test_pull_request_and_ci_rollup_direct_construction(self):
        check = services.CiCheck(context="ci/runbot", state="failure", url="http://x")
        rollup = services.CiRollup(overall="failure", runbot="failure", checks=[check])
        pr = services.PullRequest(
            github="odoo/odoo",
            number=123,
            title="Fix thing",
            url="http://pr",
            state="open",
            branch="master-feat-x",
            relation="authored",
            ci=rollup,
        )
        d = asdict(pr)
        self.assertEqual(d["number"], 123)
        self.assertEqual(d["ci"]["overall"], "failure")
        self.assertEqual(d["ci"]["checks"][0]["context"], "ci/runbot")
        self.assertFalse(d["draft"])

    def test_pull_request_defaults(self):
        pr = services.PullRequest(
            github="odoo/odoo",
            number=1,
            title="t",
            url="u",
            state="open",
            branch="b",
            relation="head",
        )
        self.assertFalse(pr.draft)
        self.assertEqual(pr.created_at, "")
        self.assertIsNone(pr.ci)


if __name__ == "__main__":
    unittest.main()
