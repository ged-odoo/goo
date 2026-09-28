---
name: odoo-leak-bisect
description: 'Use when a memory leak was reported on CI/runbot (a batch is flagged, an earlier one wasn''t) and needs to be bisected down to the introducing commit and root-caused — especially when the goo `memleak_check` addon and the `chrome-devtools` MCP aren''t available locally (a bare/sandboxed checkout), so the usual `/leak-check` + `odoo-memory-perf` empirical path can''t be used directly.'
---

# Bisecting a JS memory leak from a runbot report

Methodology for going from *"batch N leaks, batch M (earlier) didn't"* to a
proven, empirically-verified fix — without the goo `memleak_check` addon or a
`chrome-devtools` MCP connection, both of which `odoo-memory-perf` normally
relies on. Everything here was built from scratch in one investigation and
works with nothing but a Postgres instance, a checked-out repo, Python, and
`google-chrome` on PATH.

The core idea throughout: hoot's own JS test runner can log a `[MEMINFO]`
line per test suite (heap size, right after a forced GC) — that's exactly
what runbot's own logs already contain, and exactly what this skill's script
reproduces locally without needing the addon or the extra Chrome flag that
real `[MEMINFO]` needs (`--js-flags=--expose-gc`, which was observed to stall
the renderer mid-suite under memory pressure — see Pitfalls). A per-suite
memory curve, diffed between two commits, tells you *where* memory starts
diverging — which models/components the accumulating objects belong to —
long before you need a heap snapshot retainer trace.

## 1. Read the CI logs first — no local repro needed yet

If the user can point to a leaking runbot build and a prior clean one, their
`start_qunit_only.txt` logs (`http://<runbotXXX>.odoo.com/runbot/static/build/<id>-<branch>/logs/start_qunit_only.txt`)
already contain the full `[MEMINFO] <suite> (after GC) - used: <bytes> - total: <bytes> - tests: <n>`
sequence for that exact CI run. Download both, and diff them suite-by-suite
(same order, deterministic):

```python
import re
def parse(path):
    out, order = {}, []
    for line in open(path):
        m = re.search(r'\[MEMINFO\] (\S+) \(after GC\) - used: (\d+) - total: (\d+)', line)
        if m:
            name, used = m.group(1), int(m.group(2))
            if name not in out: order.append(name)
            out[name] = used
    return out, order
leak, _ = parse("leak_log.txt")
clean, order = parse("clean_log.txt")
prev_gap = 0
for name in order:
    if name not in leak: continue
    gap = leak[name] - clean[name]
    print(f"{name:50s} leak={leak[name]/1e6:7.1f}MB clean={clean[name]/1e6:7.1f}MB gap={gap/1e6:+7.1f}MB d={gap-prev_gap:+7.1f}MB")
    prev_gap = gap
```

The **first suite where the gap opens** (and stays open — a real leak never
comes back down) tells you which addon/component to suspect, well before
touching git history. In the case this skill was built from, the gap opened
exactly at the suites exercising `Message`/`discuss.channel` fields that a
single commit had converted to a different reactivity primitive — a strong
enough signal to go straight to `git log --oneline <good>..<bad> -- addons/<suspect>`
and read diffs, rather than bisecting blindly across the whole range.

## 2. Narrow the git range with static reading

`git log --oneline <good_sha>..<bad_sha> -- addons/<suspect_module>` — filter
to the module the log analysis pointed at. Read every candidate commit's
diff. A JS reactivity refactor (converting stored/computed fields to a
different primitive, changing when/how effects are disposed) is a much more
plausible leak source than a pure-Python fix, a test-only change, or a
one-line UI tweak — most candidate commits can usually be ruled out by
reading alone. Pick the most plausible one as the primary suspect and note
its **direct parent commit** — comparing adjacent commits (one commit of
diff) is what makes the empirical confirmation in step 5 unambiguous; a
wide-range comparison (e.g. against the last known-good release) risks
attributing the leak to the wrong one of several changes.

## 3. Set up a local empirical harness

Needed once per investigation; ~15 minutes:

**Get real seed data.** A synthetic/empty db under-exercises the JS (few
messages, few threads). If CI publishes a full-DB dump for the batch (a
runbot `..._all.zip`, `dump.sql` + `filestore/`), use it:

```bash
curl -fsSL -o build.zip "<the batch's ..._all.zip logs URL>"
unzip -oq build.zip filestore/ dump.sql -d dump/
createdb leakbuild_base
psql -d leakbuild_base -f dump/dump.sql   # a handful of GIST-index errors on
                                            # unrelated fuzzy-search indexes are
                                            # harmless noise, not a red flag
```
Then for each test db (one per commit under test), `createdb -T
leakbuild_base <name>` and symlink its filestore dir at
`~/.local/share/Odoo/filestore/<name>` to the extracted `dump/filestore`
(cheap — no per-db copy needed, the content is identical).

**Purge the JS test bundle cache.** The dump's `ir_attachment` rows for
`web.assets_unit_tests(_setup)?.min.(js|css)` point at filestore hashes that
the exported zip does *not* always actually contain (CI regenerates/GCs
these; the SQL dump and the filestore export weren't taken byte-consistent
for this specific bundle). If left in place, Odoo serves a **stale,
zero-content bundle in a plain 200 response** — no error anywhere, just a
JS page that loads, logs nothing, and hangs forever waiting for a signal
that will never come. Symptom to watch for: baseline heap usage far smaller
than a healthy run's (a broken/empty bundle idles at ~10MB; a real one is
~60-70MB even before any test starts) and zero HTTP requests for 5+ minutes.
Fix: delete the stale rows so Odoo regenerates them fresh on first request —
do this on the base db (or per test db, cheap either way):

```sql
delete from ir_attachment where name ilike '%assets_unit_tests%';
```

**Worktrees, one per commit under test:**
```bash
git worktree add <scratch>/wt/<label> <commit_sha>
cat > <scratch>/wt/<label>/odoo.conf <<EOF
[options]
addons_path = <scratch>/wt/<label>/addons,<path-to-enterprise>
db_user = odoo
db_password = odoo
EOF
python3 odoo-bin -c odoo.conf -d <db_for_this_label> --http-port <port> --dev all --max-cron-threads 0 --logfile <scratch>/logs_<label>.log
```
A missing venv only needs `psycopg2-binary` (not `psycopg2` — avoids a
`libpq-dev` build dependency), `requests`, `websockets`; skip `python-ldap`
(needs system SASL/LDAP headers, irrelevant to a JS-only investigation — just
mark `auth_ldap` `uninstalled` in the db if a CRITICAL import error names it).
If other CRITICAL import errors name specific missing packages (a manifest's
`external_dependencies.python` entry not actually installed — `pyjwt`,
`phonenumbers`, `dbfread`, `paramiko`, `google-auth` are common ones in a full
"all modules" db), `pip install` them; they're all pure-Python or have
prebuilt wheels, no system headers needed.

## 4. Drive the browser and capture per-suite MEMINFO — `scripts/heapcheck_cdp.py`

This is the piece that replaces both `memleak_check` (not on the addons path
here) and `chrome-devtools` MCP (no running/attachable Chrome to connect to):
it launches its own headless Chrome via subprocess, drives it over raw CDP,
and logs a synthetic `[MEMINFO-CDP] <suite> - used: ... - total: ...` line at
every suite boundary using `HeapProfiler.collectGarbage` +
`Runtime.getHeapUsage` — the same shape as real `[MEMINFO]`, diffable the
same way as step 1, but generated locally without the addon or the
`--expose-gc` flag (see Pitfalls for why that flag was dropped).

```bash
# compute the hoot suite-id filter for one module (stable across nearby commits,
# recompute per-worktree if the module list itself might have changed):
cd <worktree>/community && python3 odoo-bin shell -c odoo.conf -d <db> --no-http <<'PY'
import sys; sys.path.insert(0, "addons/web/tests")
from test_js import HootCommon
class Fake(HootCommon):
    def __init__(self, env):
        self.env = env; self._test_params = []
h = Fake(env)
bundle = h._get_addons_from_asset_bundle('web.assets_unit_tests')
print("FILTER:", h._get_hoot_filters(bundle, ['mail', 'im_livechat']))  # module names to scope to
PY

# then, per commit under test:
python3 scripts/heapcheck_cdp.py <http_port> <db_name> <label> <out_dir> "<filter from above>"
```

Outputs `<label>_baseline.heapsnapshot`, `<label>_target.heapsnapshot`,
`<label>_result.json`, and `<label>_meminfo.txt` (the per-suite lines) in
`<out_dir>`. Run it for the suspect commit and its direct parent (in
parallel, different ports/db — they're fully independent), then diff
`*_meminfo.txt` exactly as in step 1. This reproduces the CI-level signal
precisely enough that, on the case this skill was built from, the gap opened
at the exact same suite locally as it had on runbot, and grew to the same
order of magnitude by the end of the block (single-commit diff: ~130MB → a
few GB by the last suite, entirely attributable to that one commit).

### Reading the result

- **Gap opens and stays open, growing suite after suite, never returning to
  baseline**: a real leak, and the suite where it *first* opens is the one
  whose fixtures/components to inspect.
- **Gap opens then closes again** (or is proportional to test count only):
  probably just more objects legitimately alive during that suite, not
  retained after — churn, not a leak.
- **Total heap stays within roughly 2x of the parent's throughout**: clean.

## 5. Verify a fix the same way

Third worktree, same commit as the suspect, patch applied on top (`git diff`
from the main worktree → `git apply` in the throwaway one is enough — no
need to commit anything there). Re-run `heapcheck_cdp.py` against it and
diff against both the unfixed suspect and the parent: a correct fix lands
within noise of the parent's numbers, not just "better than before." This is
what actually proves the fix, as opposed to a plausible-sounding source-code
argument for why it *should* work.

## Pitfalls hit along the way (all solved, keep the fixes)

- **Login via a transplanted cookie is flaky.** Doing `POST
  /web/session/authenticate` via a separate HTTP client and then CDP
  `Network.setCookie`-ing the returned `session_id` onto the browser races
  Odoo's own session-rotation-on-login: the next navigation can still carry
  the *pre-login* cookie and bounce back to `/web/login`, hanging forever
  (indistinguishable from the stale-bundle symptom above — check both).
  Fix (already in the script): navigate to `/web/login` first, authenticate
  via a same-origin `fetch()` run through `Runtime.evaluate` from *inside*
  that page (so the browser's own cookie jar commits it), `await
  asyncio.sleep(1)` after, *then* navigate to the actual test URL.
- **`--js-flags=--expose-gc`** (needed for hoot's own real `[MEMINFO]`
  logging, see `module_set.hoot.js`'s `__gcAndLogMemory`) was observed to
  stall the renderer indefinitely under sustained test-suite memory
  pressure — CPU flatlines, no crash, no timeout, just silence. The
  script's own `HeapProfiler.collectGarbage` CDP call is a stable
  substitute and needs no special launch flag.
- **A second CDP client attached to a busy tab to grab an ad-hoc heap
  snapshot** (rather than waiting for the script's own scheduled
  baseline/target) can stall for a very long time — `HeapProfiler.
  takeHeapSnapshot` competes with the page's own running JS for the single
  main thread. `Debugger.pause` first (then `Debugger.resume` after)
  makes this reliable; still expect real wall-clock time proportional to
  heap size (a ~300MB heap's `.heapsnapshot` took a few minutes; multi-GB
  took much longer and is usually not worth waiting for — the per-suite
  MEMINFO curve alone is normally enough to act on).
- **Multi-statement backgrounded shell commands can silently no-op.** A
  background launch chaining `pkill ...; rm -f ...; python3 script.py ...`
  was repeatedly observed to produce *no* new process and *no* error,
  leaving the previous run's stale log file in place (same birth
  timestamp, easy to miss). Always verify a relaunch actually started a
  new PID (`pgrep -af <script>`) and that the log file's birth time is
  fresh, don't trust the launch command's own reported exit status alone;
  when in doubt, run the single launch command with nothing chained in
  front of it.
- **Ephemeral session directories don't survive a session
  interruption.** Everything under the session's own scratch path
  (worktrees, downloaded dumps, `.heapsnapshot` files) is gone if the
  harness restarts; only what was written inside the actual git worktree
  (a committed or uncommitted file change, or a script saved under
  `.claude/skills/`) survives. Save the reusable script into a skill (as
  this one does) rather than only the scratch dir, and be ready to redo
  the DB/worktree setup (step 3) from scratch — it's ~15 minutes of
  mostly-scripted work, not a re-investigation.
