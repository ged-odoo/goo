---
name: odoo-memory-perf
description: 'Use when investigating a suspected memory leak or performance regression in the Odoo web client: Owl components not cleaning up, detached DOM nodes, growing listeners/subscriptions across navigation.'
---

# Odoo memory-leak check (empirical, via a real Odoo test + memlab)

This complements a *static* code review (e.g. the `/leak-check` command, if
configured — the known Owl3/JS leak anti-patterns: dangling listeners, `useEffect`
without cleanup, unbound `useState`/`reactive()` DOM refs, unclosed observers,
orphaned third-party widgets) with an *empirical* one: actually load the app in a
real browser, exercise a real interaction, and diff heap snapshots to see what's
still retained afterwards. Static review tells you what looks suspicious; this
tells you what's actually leaking.

It's a plain **option on a normal `--test-tags` run**, not a separate tool with
its own syntax: give it any test tag you'd already give `--test-tags` — a tour
test, a HOOT suite, anything with a browser in it — and it diffs heap snapshots
around whatever that test does, unmodified.

## How the two pieces split

- **`memleak_check`** (a goo-provided Odoo addon, on the addons path already —
  see `../odoo.conf`) doesn't drive anything itself: its own test file, once
  Odoo's test loader imports it (which happens automatically for every
  installed module whenever any `--test-tags` run happens at all), patches
  `ChromeBrowser` so that **whatever other test your `--test-tags` selects**
  gets a heap snapshot taken at three checkpoints around its own browser
  session: right before its first navigation (after first forcing a trip to a
  neutral screen), right after its console success signal fires, and right
  before teardown (after forcing another trip back to that neutral screen).
  The target test runs exactly as it always would — same
  `self.start_tour(...)`/`self.browser_js(...)` call, same assertions — this
  just watches from the outside.
- **[memlab](https://github.com/facebook/memlab)** (Meta's open-source
  heap-diffing tool) only *analyzes* those three files afterwards
  (`memlab find-leaks --baseline --target --final`) — no browser involved on its
  side at all. Whatever's still retained in `final` that wasn't already in
  `baseline` is a real leak, printed as a retainer trace (the chain of references
  keeping it alive, which usually points straight at the missing cleanup).

Find a test near the code you suspect — a tour-based one is the easiest target,
since a tour is a real, repeatable user interaction:

```bash
grep -rn "start_tour(" community/addons/<module>/tests/ enterprise/addons/<module>/tests/
```

Any test with a browser session works, not just tours — pick one that actually
exercises the component/view you're investigating, and use its own
`--test-tags` selector (e.g. `web:WebSuite.test_unit_desktop`, or `:MyTestClass`,
or just the module name if there's only one relevant test in it).

No test exists yet for the interaction you want to check? Write a small one
first (`self.start_tour(...)` with a tour registered via
`registry.category("web_tour.tours").add(...)`) — it's reusable test coverage
either way, not just a one-off memory-check fixture.

### Fragility note

The module-level `ChromeBrowser` patch (`addons/memleak_check/tests/test_memleak_check.py`,
goo's repo) reuses `ChromeBrowser`'s private (`_`-prefixed) websocket/CDP methods
(`_websocket_request`, `_handlers`) and reassigns `ChromeBrowser.navigate_to`/
`_wait_code_ok` themselves — unofficial, internal API that could shift between
Odoo versions. Verified against a recent (18.0/19.0/master-era) checkout; if it
breaks on a much older series, the fix is almost always re-reading
`HttpCase.browser_js`'s current body in `odoo/tests/common.py` and adjusting the
call sequence to match.

## Usage

```bash
.claude/skills/odoo-memory-perf/scripts/run_check.sh <test_tags> <modules_to_install> [db_name]
```

e.g. `run_check.sh web:WebSuite.test_unit_desktop web`. Installs `memleak_check`
+ the given module(s) into a dedicated, throwaway scratch db (never touches
whatever's already running via goo), runs `<test_tags>` with
`--test-tags --stop-after-init` (so it exits on its own — no server to babysit
or port to poll), then runs memlab against the three snapshots it produced.
Takes a minute or two; `npx` fetches memlab on first use (no install needed).

Dumps land in `.claude/skills/odoo-memory-perf/dumps/memcheck_<timestamp>/`:
`baseline.heapsnapshot`/`target.heapsnapshot`/`final.heapsnapshot` (the raw
captures) plus, via memlab's `--work-dir`, `data/cur/leaks.txt` (the same report
printed to the terminal) — so a run can be reviewed or attached to a PR/task
after the fact instead of only living in terminal scrollback.

## Reading the output

- **"MemLab found 0 leak(s)"** (or no leak section at all) — clean; the
  interaction doesn't leave anything behind. This is the expected/passing result.
- **"MemLab found N leak(s)"** with retainer traces — real leaks. Each trace is a
  reference chain, outermost first, e.g. an `[EventTarget]` or `[Window]` holding
  a `[Closure]` holding a `[Detached HTMLDivElement]`: read it as "the closure
  (some listener/subscription that was never cleaned up) is still holding this
  DOM subtree alive." Map the retaining object/closure name back to a component
  file, then look for the matching anti-pattern (missing `removeEventListener`,
  missing `useEffect` cleanup, an `env.bus`/service subscription never unbound in
  `onWillUnmount`, etc.). Same trace, either read from the terminal or from the
  saved `leaks.txt` dump.

## Notes

- goo's own Tests tab has a "Memory check" checkbox that does the exact same
  thing against a workspace's own persistent db, for any `--test-tags` value
  typed there — this script is the standalone/scratch-db equivalent for a
  Claude session or the CLI.
