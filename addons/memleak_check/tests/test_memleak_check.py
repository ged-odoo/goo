import os
import urllib.parse

from odoo.tests.common import ChromeBrowser


def _take_heap_snapshot(browser, path):
    """Capture one full CDP heap snapshot of <browser>'s current page to
    <path>. HeapProfiler.takeHeapSnapshot streams the snapshot as a series of
    addHeapSnapshotChunk events; CDP guarantees per-connection message
    ordering, so every chunk has already arrived by the time the command's own
    response comes back."""
    chunks = []
    browser._handlers["HeapProfiler.addHeapSnapshotChunk"] = lambda chunk: chunks.append(chunk)
    try:
        browser._websocket_request("HeapProfiler.enable")
        browser._websocket_request(
            "HeapProfiler.takeHeapSnapshot", params={"captureNumericValue": False}
        )
    finally:
        del browser._handlers["HeapProfiler.addHeapSnapshotChunk"]
    with open(path, "w", encoding="utf-8") as f:
        f.write("".join(chunks))


def _memcheck_active():
    return bool(os.environ.get("MEMCHECK_DUMP_DIR"))


def _memcheck_finalize(browser):
    """Registered on `browser.cleanup` (an ExitStack) the first time this
    browser navigates — callbacks run LIFO, and this is appended right after
    the real teardown callbacks ChromeBrowser.__init__ already registered
    (chrome process kill, websocket close, …), so it always runs BEFORE them:
    the browser is still alive here."""
    if not _memcheck_active() or getattr(browser, "_memcheck_finalized", False):
        return
    browser._memcheck_finalized = True
    dump_dir = os.environ["MEMCHECK_DUMP_DIR"]
    try:
        neutral = urllib.parse.urljoin(browser.test_case.base_url(), "/odoo")
        browser.navigate_to(neutral, wait_stop=True)
        _take_heap_snapshot(browser, os.path.join(dump_dir, "final.heapsnapshot"))
    except Exception:
        browser._logger.exception("memleak_check: failed to capture the final heap snapshot")


def _install_generic_chrome_patch():
    """This is the whole of memleak_check: goo's Tests tab "Memory check"
    checkbox is a plain option on a classic --test-tags run, not a separate
    mode — whatever test(s) that tag already selects get driven exactly as
    normal; this module just needs to be IMPORTED for its patch below to take
    effect, which Odoo's test loader does automatically for every installed
    module whenever --test-tags/--test-enable runs at all (loader.make_suite
    imports every candidate module's tests package to discover its
    TestCase classes, before filtering by tag — see odoo/tests/loader.py).
    memleak_check itself is (re)installed on every memcheck run (see
    build_odoo_cmd) specifically so it's always part of that module scan.

    Once imported, this patches ChromeBrowser (from odoo.tests.common) so that,
    only while MEMCHECK_DUMP_DIR is set, ANY test's own ChromeBrowser session —
    constructed and driven entirely by that test's own code, e.g. its own
    browser_js()/start_tour() call — gets three heap snapshots taken around it:
    right before its first navigation (after first forcing a trip to a neutral
    screen), right after its console success signal fires, and right before
    teardown (after forcing another trip back to that neutral screen) — mirrors
    the classic before/after-a-real-user-action diff memlab's `find-leaks`
    expects, just applied from the outside instead of driven explicitly.

    Relies on ChromeBrowser's private (`_`-prefixed) websocket/CDP plumbing
    (_websocket_request, _handlers) plus reassigning its navigate_to/
    _wait_code_ok methods outright — unofficial, internal API that could shift
    between Odoo versions; verified against this checkout's odoo/tests/common.py.
    """
    if getattr(ChromeBrowser, "_memcheck_patched", False):
        return
    ChromeBrowser._memcheck_patched = True

    orig_navigate_to = ChromeBrowser.navigate_to
    orig_wait_code_ok = ChromeBrowser._wait_code_ok

    def navigate_to(self, url, wait_stop=False):
        if _memcheck_active() and not getattr(self, "_memcheck_baselined", False):
            self._memcheck_baselined = True
            dump_dir = os.environ["MEMCHECK_DUMP_DIR"]
            os.makedirs(dump_dir, exist_ok=True)
            neutral = urllib.parse.urljoin(self.test_case.base_url(), "/odoo")
            orig_navigate_to(self, neutral, wait_stop=True)
            _take_heap_snapshot(self, os.path.join(dump_dir, "baseline.heapsnapshot"))
            self.cleanup.callback(_memcheck_finalize, self)
        return orig_navigate_to(self, url, wait_stop)

    def wait_code_ok(self, code, timeout, error_checker=None):
        result = orig_wait_code_ok(self, code, timeout, error_checker=error_checker)
        if _memcheck_active():
            dump_dir = os.environ["MEMCHECK_DUMP_DIR"]
            _take_heap_snapshot(self, os.path.join(dump_dir, "target.heapsnapshot"))
        return result

    ChromeBrowser.navigate_to = navigate_to
    ChromeBrowser._wait_code_ok = wait_code_ok


_install_generic_chrome_patch()
