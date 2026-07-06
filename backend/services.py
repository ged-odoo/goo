"""Domain services over the IO seam (effects.py).

Each service takes an `io` object (the effects module, or a fake in tests) and a
TTLCache, so it can be unit-tested without real subprocesses or network. This is
where external state (GitHub PRs, runbot, mergebot) is fetched, parsed, and cached
server-side; the HTTP handlers in goo.py just delegate here.
"""

import ast
import base64
import html as html_lib
import json
import os
import re
import subprocess
import threading
import urllib.parse
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from datetime import datetime, timedelta, timezone

from .models import CiCheck, CiRollup, PullRequest

RUNBOT_BASE = "https://runbot.odoo.com"
MERGEBOT_BASE = "https://mergebot.odoo.com"


# ─────────────────────────── GitHub PRs (via the `gh` CLI) ───────────────────


def _ci_state(raw):
    """Normalize a GitHub status/check state to success | failure | pending | ""."""
    s = (raw or "").lower()
    if s == "success":
        return "success"
    if s in (
        "failure",
        "error",
        "timed_out",
        "cancelled",
        "action_required",
        "stale",
        "startup_failure",
    ):
        return "failure"
    if s in ("pending", "expected", "queued", "in_progress", "waiting", "requested"):
        return "pending"
    return ""


def _ci_rollup(rollup):
    """Compress a PR's statusCheckRollup into a CiRollup {overall, runbot, checks}.

    `checks` is [CiCheck(context, state, url)] (state normalized via _ci_state);
    `runbot` is the ci/runbot context's state; `overall` is failure if any check
    failed, else pending if any is still pending, else success if all passed (else
    ""). Handles both StatusContext (.context/.state, what Odoo's CI posts) and
    CheckRun (.name/.status/.conclusion)."""
    checks = []
    for c in rollup or []:
        context = c.get("context") or c.get("name") or ""
        if not context:
            continue
        raw = c.get("state") or c.get("conclusion") or c.get("status") or ""
        checks.append(
            CiCheck(
                context=context,
                state=_ci_state(raw),
                url=c.get("targetUrl") or c.get("detailsUrl") or "",
            )
        )
    checks.sort(key=lambda c: c.context)
    states = {c.state for c in checks}
    if "failure" in states:
        overall = "failure"
    elif "pending" in states:
        overall = "pending"
    elif states == {"success"}:
        overall = "success"
    else:
        overall = ""
    runbot = next((c.state for c in checks if c.context == "ci/runbot"), "")
    return CiRollup(overall=overall, runbot=runbot, checks=checks)


class GitHubService:
    """The user's PRs and PR actions, via the `gh` CLI."""

    def __init__(self, io, cache):
        self.io = io
        self.cache = cache

    def prs(self, repos, refresh=False):
        """For each repo {id, github}: the user's PRs (all states). Cached per
        repo-set; pass refresh=True to bypass the cache."""
        key = tuple(sorted((r.get("id"), r.get("github")) for r in repos))
        if refresh:
            self.cache.invalidate(key)
        return self.cache.get(key, lambda: self._fetch(repos))

    def _fetch(self, repos):
        # one `gh pr list` per repo, in parallel (pool.map preserves order)
        valid = [r for r in repos if r.get("id") and r.get("github")]
        if not valid:
            return []
        with ThreadPoolExecutor(max_workers=min(8, len(valid))) as pool:
            return list(pool.map(self._fetch_one, valid))

    def _fetch_one(self, repo):
        rid, gh_repo = repo["id"], repo["github"]
        entry = {"id": rid, "github": gh_repo, "prs": [], "error": None}
        self.io.log_request(f"gh pr list --repo {gh_repo} --author @me")
        try:
            r = self.io.run(
                [
                    "gh",
                    "pr",
                    "list",
                    "--repo",
                    gh_repo,
                    "--author",
                    "@me",
                    "--state",
                    "all",
                    "--limit",
                    "200",
                    "--json",
                    "number,title,url,state,isDraft,headRefName,createdAt,updatedAt,statusCheckRollup",
                ],
                timeout=30,
            )
            if r.returncode != 0:
                entry["error"] = r.stderr.strip().split("\n")[0] or "gh failed"
            else:
                entry["prs"] = [
                    asdict(
                        PullRequest(
                            github=gh_repo,
                            number=pr.get("number"),
                            title=pr.get("title", ""),
                            url=pr.get("url", ""),
                            state=(pr.get("state") or "").lower(),  # OPEN → open
                            branch=pr.get("headRefName", ""),
                            relation="authored",
                            draft=pr.get("isDraft", False),
                            created_at=pr.get("createdAt", ""),
                            updated_at=pr.get("updatedAt", ""),
                            ci=_ci_rollup(pr.get("statusCheckRollup")),
                        )
                    )
                    for pr in json.loads(r.stdout)
                ]
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            entry["error"] = str(e)
        except json.JSONDecodeError:
            entry["error"] = "unexpected gh output"
        return entry

    # GraphQL search: one call gives us the PR head branch and a real MERGED state
    # (the REST search/issues endpoint exposes neither). `$after` drives pagination.
    _REVIEWED_QUERY = """
    query($q: String!, $after: String) {
      search(query: $q, type: ISSUE, first: 100, after: $after) {
        issueCount
        nodes {
          ... on PullRequest {
            number title url state isDraft updatedAt headRefName
            repository { nameWithOwner }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
    """

    def reviewed(self, days=14, refresh=False):
        """PRs the current user commented on (but didn't author) in the last `days`
        days, across all of GitHub (search: type:pr commenter:@me -author:@me
        updated:>=<cutoff>), newest first. Cached by `days`; refresh=True bypasses."""
        key = ("reviewed", days)
        if refresh:
            self.cache.invalidate(key)
        return self.cache.get(key, lambda: self._fetch_reviewed(days))

    def _fetch_reviewed(self, days):
        # one global GitHub search via GraphQL (this gh has no `gh search`
        # subcommand). Paginated by cursor, capped at 300 results to bound it.
        # -author:@me drops PRs the user opened (commenting on your own PR ≠ review).
        cutoff = (datetime.now(timezone.utc).date() - timedelta(days=days)).isoformat()
        query = f"type:pr commenter:@me -author:@me updated:>={cutoff} sort:updated-desc"
        self.io.log_request(f"gh api graphql search '{query}'")
        prs, total, after = [], 0, None
        try:
            for _ in range(3):  # cap at 3 × 100 = 300 results
                cmd = [
                    "gh",
                    "api",
                    "graphql",
                    "-f",
                    f"query={self._REVIEWED_QUERY}",
                    "-f",
                    f"q={query}",
                ]
                if after:
                    cmd += ["-f", f"after={after}"]
                r = self.io.run(cmd, timeout=30)
                if r.returncode != 0:
                    return {"prs": [], "error": r.stderr.strip().split("\n")[0] or "gh failed"}
                search = (json.loads(r.stdout).get("data") or {}).get("search") or {}
                total = search.get("issueCount", 0)
                prs.extend(self._review_row(n) for n in search.get("nodes", []) if n.get("number"))
                page = search.get("pageInfo") or {}
                after = page.get("endCursor")
                if not page.get("hasNextPage"):
                    break
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return {"prs": [], "error": str(e)}
        except json.JSONDecodeError:
            return {"prs": [], "error": "unexpected gh output"}
        # surface truncation rather than silently dropping results
        return {"prs": prs, "error": None, "capped": total > len(prs)}

    @staticmethod
    def _review_row(node):
        return asdict(
            PullRequest(
                github=(node.get("repository") or {}).get("nameWithOwner", ""),
                number=node.get("number"),
                title=node.get("title", ""),
                url=node.get("url", ""),
                state=(node.get("state") or "").lower(),  # open / closed / merged
                branch=node.get("headRefName", ""),
                relation="reviewed",
                draft=node.get("isDraft", False),
                updated_at=node.get("updatedAt", ""),
            )
        )

    def close_pr(self, github, number):
        """Close a GitHub PR. Returns (ok, error); invalidates the PR cache on
        success so the next fetch reflects the closure."""
        self.io.log_request(f"gh pr close {number} --repo {github}")
        try:
            r = self.io.run(["gh", "pr", "close", str(number), "--repo", github], timeout=30)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e)
        if r.returncode != 0:
            return False, r.stderr.strip().split("\n")[0] or "gh pr close failed"
        self.cache.invalidate()
        return True, None

    def search_branches(self, repos, query):
        """Search GitHub for branches whose name starts with `query`, across all
        repos that have a github field (one `gh api` call per repo, in parallel).
        Returns a list of {repo: id, branch: name}."""
        results = []
        lock = threading.Lock()

        def search_one(r):
            github = r.get("github", "")
            if not github:
                return
            try:
                res = self.io.run(
                    [
                        "gh",
                        "api",
                        f"repos/{github}/git/matching-refs/heads/{query}",
                        "--jq",
                        ".[].ref",
                    ],
                    timeout=15,
                )
                if res.returncode != 0:
                    return
                found = []
                for line in res.stdout.splitlines():
                    branch = line.strip()
                    if branch.startswith("refs/heads/"):
                        branch = branch[len("refs/heads/") :]
                    if branch:
                        found.append({"repo": r["id"], "branch": branch})
                with lock:
                    results.extend(found)
            except (FileNotFoundError, subprocess.TimeoutExpired):
                pass

        threads = [threading.Thread(target=search_one, args=(r,), daemon=True) for r in repos]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=20)
        return results


# ─────────────────────────── Runbot (HTML scraping) ─────────────────────────


class RunbotService:
    """Runbot CI status for a branch's bundle, scraped from runbot.odoo.com."""

    def __init__(self, io, cache):
        self.io = io
        self.cache = cache

    def statuses(self, branches, refresh=False):
        """{branch: {result, running}} for the given branches, cached per branch
        and fetched in parallel. Pass refresh=True to bypass the cache."""
        branches = [b for b in dict.fromkeys(branches) if b]  # unique, non-empty
        if not branches:
            return {}
        if refresh:
            for b in branches:
                self.cache.invalidate(b)
        with ThreadPoolExecutor(max_workers=min(8, len(branches))) as pool:
            states = pool.map(lambda b: self.cache.get(b, lambda b=b: self._status(b)), branches)
            return dict(zip(branches, states, strict=False))

    def _status(self, branch):
        """{result, running, url} for a branch's runbot bundle.

        `/runbot/bundle/<name>` resolves the *name* and 302-redirects to the bundle's
        canonical URL. But when no bundle has that name, runbot/Odoo instead treats a
        trailing "-<n>" as a record id and 301-redirects to whatever bundle has id n —
        a *different* branch (e.g. a fresh, never-pushed `master-test-33` resolves to
        bundle 33, `master-decimal-rounding-fix-jar`). We must not report that foreign
        bundle's status, so we don't follow redirects ourselves: a 302 is a real name
        match (follow it), a 301 means "no such bundle" (the trailing number was read
        as an id), and 404 is plainly absent.

        `result` ("success"/"failure"/"") comes from the bundle page favicon
        (icon_ok/icon_ko/icon_killed …). `running` is true when the latest batch still
        has a build in progress: runbot tints the batch card `bg-info-subtle` (vs
        `bg-success-subtle`/`bg-danger-subtle` once done) and spins the building slot's
        icon (`fa-spin`). NB: a bare `btn-info` is *not* a running signal — every
        finished slot carries an `fa-sign-in btn-info` "connect to live build" link.
        `url` is the canonical bundle page (""=no bundle); the UI links to it."""
        url = f"{RUNBOT_BASE}/runbot/bundle/{urllib.parse.quote(branch)}"
        status, location, html, _ = self.io.http_get_nofollow(url)
        if status == 302:  # name match → the canonical bundle page
            url = urllib.parse.urljoin(RUNBOT_BASE, location)
            html, _ = self.io.http_get(url)
        elif status != 200:  # 301 (id-misresolve to a foreign bundle), 404, or error
            return {"result": "", "running": False, "url": ""}
        if not html:  # canonical page unreadable → fall back to the name-keyed badge
            s = self._badge(branch)
            r = s if s in ("success", "failure") else ""
            return {"result": r, "running": s == "pending", "url": url}
        m = re.search(r'rel="[^"]*icon"[^>]*href="[^"]*?icon_([a-z]+)\.', html)
        state = m.group(1) if m else ""
        result = "failure" if state in ("ko", "killed") else "success" if state == "ok" else ""
        parts = html.split('class="batch_tile', 1)
        latest = parts[1].split('class="batch_tile', 1)[0] if len(parts) > 1 else ""
        running = "bg-info-subtle" in latest or "fa-spin" in latest
        return {"result": result, "running": running, "url": url}

    def _badge(self, branch):
        """Parse the runbot badge SVG: "success" / "failure" / "pending" / ""."""
        svg, _ = self.io.http_get(f"{RUNBOT_BASE}/runbot/badge/1/{urllib.parse.quote(branch)}.svg")
        if not svg:
            return ""
        texts = re.findall(r"<text[^>]*>([^<]*)</text>", svg)
        label = texts[-1].strip().lower() if texts else ""
        if "success" in label:
            return "success"
        if any(k in label for k in ("fail", "ko", "error", "killed")):
            return "failure"
        if any(k in label for k in ("pending", "running", "testing", "progress")):
            return "pending"
        return ""


# ─────────────────────────── Mergebot (HTML scraping) ───────────────────────

MERGEBOT_STATES = frozenset(
    (
        "merged",
        "staged",
        "staging",
        "blocked",
        "ready",
        "approved",
        "validated",
        "mergeable",
        "reviewed",
        "squashed",
        "pending",
        "error",
        "closed",
    )
)


class MergebotService:
    """Mergebot merge-queue state for a PR, scraped from mergebot.odoo.com."""

    def __init__(self, io, cache):
        self.io = io
        self.cache = cache

    def statuses(self, prs, refresh=False):
        """Return ({"github#number": state}, {"github#number": detail}, [unsupported
        repos]) for the given PRs, cached per PR and fetched in parallel. Pass
        refresh=True to bypass the cache. `detail` (omitted when empty) lists the
        unmet merge requirements behind a blocked state, e.g. "Review, CI".

        A repo is reported "unsupported" when, in this batch, at least one of its PRs
        404s (no mergebot page) and none of its PRs is reachable — so the caller can
        remember it and stop asking. A repo with one un-indexed 404 but another
        reachable PR is NOT unsupported (its reachable PR clears it)."""
        prs = [p for p in prs if p.get("github") and p.get("number")]
        if not prs:
            return {}, {}, []
        if refresh:
            for p in prs:
                self.cache.invalidate(f"{p['github']}#{p['number']}")
        with ThreadPoolExecutor(max_workers=min(8, len(prs))) as pool:
            results = list(
                pool.map(
                    lambda p: self.cache.get(
                        f"{p['github']}#{p['number']}",
                        lambda p=p: self._status(p["github"], p["number"]),
                    ),
                    prs,
                )
            )
        states, details, reachable, missing = {}, {}, set(), set()
        for p, (state, detail, supported) in zip(prs, results, strict=False):
            key = f"{p['github']}#{p['number']}"
            states[key] = state
            if detail:
                details[key] = detail
            if supported is None:
                # transient failure — don't pin a blank for the whole TTL
                self.cache.invalidate(key)
            elif supported:
                reachable.add(p["github"])
            else:
                missing.add(p["github"])
        unsupported = sorted(missing - reachable)
        return states, details, unsupported

    def _status(self, github, number):
        """(merge state, detail, supported) — e.g. ('blocked', 'Review, CI', True),
        ('merged', '', True), or ('', '', True) when the page loads but shows no
        known state. `detail` lists the unmet merge requirements when blocked, ''
        otherwise. `supported` is False on a 404 (repo/PR not on mergebot) and None
        on a transient failure. State is rendered inconsistently (a colored <p> for
        blocked/staged/ready/…, an alert <div> for merged/closed), so scan for the
        first element with a bg-* or alert class whose leading word is a known state."""
        html, err = self.io.http_get(f"{MERGEBOT_BASE}/{github}/pull/{number}")
        if err:
            return "", "", (False if "404" in err else None)
        state = ""
        for m in re.finditer(
            r'<\w+[^>]*class="[^"]*(?:\bbg-\w+|\balert\b)[^"]*"[^>]*>(.*?)</', html, re.S
        ):
            txt = re.sub(r"<[^>]+>", " ", m.group(1)).strip()
            if not txt:
                continue
            word = re.sub(r"[^a-z]", "", txt.split()[0].lower())
            if word in MERGEBOT_STATES:
                state = word
                break
        return state, self._blocked_reasons(html), True

    def _blocked_reasons(self, html):
        """The unmet merge requirements from the page's `todo` checklist: the labels
        of the top-level <li> items not marked satisfied (class 'ok'), joined like
        "Review, CI". Nested per-CI-check items begin with an <a>, so their empty
        leading text excludes them. Returns '' when nothing is unmet / no checklist."""
        reasons = []
        for m in re.finditer(r'<li(?:[^>]*\bclass="([^"]*)")?[^>]*>([^<]*)', html):
            label = re.sub(r"\s+", " ", m.group(2)).strip()
            if not label or "ok" in (m.group(1) or "").split():
                continue
            reasons.append(label)
        return ", ".join(reasons)[:200]


# ─────────────────────────── Nightly builds (HTML scraping) ─────────────────


class NightlyService:
    """Nightly Multi Qunit build status per Odoo version, scraped from runbot.

    One `TTLCache` backs three key families: "versions" (the starred-bundle
    list, rarely changes), ("bundle", id, page) (one bundle page's night
    listing — grows as new nightly runs land), and ("build"|"child", url) (a
    single build page's parsed detail). Detail entries are written only once a
    build's own status is terminal and are never explicitly invalidated — a
    given runbot URL is fetched and parsed at most once for the life of the
    process. `refresh=True` (the UI's Refresh button) only invalidates the
    versions/bundle-index keys; re-scraping a finished build is pointless
    since its page can't change."""

    _VERSIONS_URL = f"{RUNBOT_BASE}/runbot/rd-1"
    _VERSIONS_FALLBACK = (
        ("master", "1"),
        ("saas-19.4", "483750"),
        ("saas-19.3", "461010"),
        ("saas-19.2", "441214"),
        ("saas-19.1", "424486"),
        ("19.0", "398573"),
        ("saas-18.4", "379655"),
        ("saas-18.3", "365472"),
        ("saas-18.2", "348552"),
        ("18.0", "320432"),
        ("17.0", "192736"),
    )
    _BUNDLE_ROW_RE = re.compile(r'class="row bundle_row"')
    _BUNDLE_LINK_RE = re.compile(r'href="/runbot/bundle/(\d+)"[^>]*title="View Bundle ([^"]+)"')

    def __init__(self, io, cache):
        self.io = io
        self.cache = cache

    def _fetch_html(self, url, timeout=20):
        html, err = self.io.http_get(url, timeout=timeout)
        return "" if err else html

    # ── versions: starred bundles on the rd-1 page ───────────────────────────

    def _versions(self, refresh=False):
        if refresh:
            self.cache.invalidate("versions")
        return self.cache.get("versions", self._fetch_versions)

    def _fetch_versions(self):
        html = self._fetch_html(self._VERSIONS_URL)
        if not html:
            return list(self._VERSIONS_FALLBACK)
        starts = [m.start() for m in self._BUNDLE_ROW_RE.finditer(html)]
        versions = []
        for i, start in enumerate(starts):
            end = starts[i + 1] if i + 1 < len(starts) else start + 4000
            chunk = html[start:end]
            if "fa fa-star" not in chunk:
                continue
            m = self._BUNDLE_LINK_RE.search(chunk)
            if not m:
                continue
            bundle_id, version = m.group(1), m.group(2)
            if version == "16.0":
                continue
            versions.append((version, bundle_id))
        return versions or list(self._VERSIONS_FALLBACK)

    # ── bundle pages: the night index for one version ────────────────────────

    @staticmethod
    def _bundle_url(bundle_id, page):
        url = f"{RUNBOT_BASE}/runbot/bundle/{bundle_id}"
        return f"{url}?page={page}" if page > 1 else url

    def _bundle_page_html(self, bundle_id, page, refresh=False):
        key = ("bundle", bundle_id, page)
        if refresh:
            self.cache.invalidate(key)
        return self.cache.get(key, lambda: self._fetch_html(self._bundle_url(bundle_id, page)))

    def _bundle_nights(self, bundle_id, max_nights, refresh=False):
        """Fetch bundle pages until max_nights nightly builds are collected,
        stopping early if a page returns no new dates (history exhausted)."""
        all_nights, seen_dates = [], set()
        for page in range(1, 8):  # up to 7 pages × ~10 nights = ~70 nights max
            html = self._bundle_page_html(bundle_id, page, refresh=refresh)
            if not html:
                break
            nights = self._parse_bundle(html, max_nights=max_nights)
            new_nights = [n for n in nights if n["date"] not in seen_dates]
            if not new_nights:
                break
            all_nights.extend(new_nights)
            seen_dates.update(n["date"] for n in new_nights)
            if len(all_nights) >= max_nights:
                break
        return all_nights[:max_nights]

    def _parse_bundle(self, html, max_nights=7):
        """Extract nightly batches from a bundle page.

        Returns a list of {date, community, enterprise} where each build is
        {status, url} or None. Only batches containing "Multi Qunit" sub-builds
        are treated as nightly. Name matching is case-insensitive so minor
        spelling variations ("QUnit", "Qunit Community v2", …) still match."""
        batch_starts = [m.start() for m in re.finditer(r'class="batch_tile', html)]
        nights = []
        html_lower = html.lower()
        for i, start in enumerate(batch_starts):
            end = batch_starts[i + 1] if i + 1 < len(batch_starts) else start + 30000
            chunk = html[start:end]
            chunk_lower = html_lower[start:end]
            if "qunit" not in chunk_lower:
                continue
            date_m = re.search(r'title="(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})"', chunk)
            if not date_m:
                continue
            date_str = date_m.group(1)[:10]  # YYYY-MM-DD
            community = None
            enterprise = None
            slot_starts = [m.start() for m in re.finditer(r'<div class="slot_container">', chunk)]
            for j, ss in enumerate(slot_starts):
                se = slot_starts[j + 1] if j + 1 < len(slot_starts) else ss + 2000
                slot = chunk[ss:se]
                name_m = re.search(
                    r'class="btn btn-default slot_name"[^>]*>\s*<span>([^<]+)</span>', slot
                )
                if not name_m:
                    continue
                name = name_m.group(1).strip()
                name_l = name.lower()
                if "qunit" not in name_l:
                    continue
                is_community = "community" in name_l
                is_enterprise = "enterprise" in name_l
                if not is_community and not is_enterprise:
                    continue
                status_m = re.search(r'<span class="btn btn-([a-z]+) disabled"', slot)
                href_m = re.search(r'href="(/runbot/batch/\d+/build/\d+)"', slot)
                if not status_m or not href_m:
                    continue
                build = {"status": status_m.group(1), "url": href_m.group(1)}
                if is_community:
                    community = build
                else:
                    enterprise = build
            if community or enterprise:
                nights.append({"date": date_str, "community": community, "enterprise": enterprise})
            if len(nights) >= max_nights:
                break
        return nights

    # ── per-build detail: cached forever once the build is terminal ─────────

    def _build_detail(self, url, running=False):
        """{"counts", "child_rows"} for a Multi Qunit build page. Cached
        permanently unless `running` (the build's own status isn't terminal
        yet), in which case it's always re-fetched fresh."""
        if running:
            return self._fetch_build_detail(url)
        return self.cache.get(("build", url), lambda: self._fetch_build_detail(url))

    def _fetch_build_detail(self, url):
        html = self._fetch_html(f"{RUNBOT_BASE}{url}")
        if not html:
            return None
        ok = len(re.findall(r'<tr class="bg-success-subtle">', html))
        warning = len(re.findall(r'<tr class="bg-warning-subtle">', html))
        failed = len(re.findall(r'<tr class="bg-danger-subtle">', html))
        counts = {"total": ok + warning + failed, "ok": ok, "warning": warning, "failed": failed}
        seen, child_rows = set(), []
        for row_m in re.finditer(
            r'<tr class="bg-(success|warning|danger)-subtle">(.*?)</tr>', html, re.DOTALL
        ):
            row_status, row_body = row_m.group(1), row_m.group(2)
            href_m = re.search(r'href="(/runbot/batch/\d+/build/\d+)"', row_body)
            if href_m and href_m.group(1) not in seen:
                seen.add(href_m.group(1))
                child_rows.append((href_m.group(1), row_status))
        return {"counts": counts, "child_rows": child_rows}

    # ── per-child detail: individual test failures + perf metrics ───────────

    def _child_detail(self, child_url, row_status):
        # a child only appears in `child_rows` once its row is success/warning/
        # danger (i.e. finished) — always safe to cache permanently.
        return self.cache.get(
            ("child", child_url), lambda: self._fetch_child_detail(child_url, row_status)
        )

    def _fetch_child_detail(self, child_url, row_status):
        html = self._fetch_html(f"{RUNBOT_BASE}{child_url}")
        if not html:
            return {"errors": [], "metrics": {}}
        errors = []
        if row_status in ("warning", "danger"):
            errors = self._parse_child_errors(html)
            for e in errors:
                e["url"] = child_url
        metrics = {}
        if row_status in ("success", "warning"):
            metrics = self._parse_child_metrics(html)
        return {"errors": errors, "metrics": metrics}

    @staticmethod
    def _fmt_warning(text):
        tl = text.lower()
        if "time" in tl:

            def _t(m):
                v = float(m.group())
                mins = int(v // 60)
                return f"{mins}m {int(v % 60)}s" if mins else f"{int(v)}s"

            return re.sub(r"\d+(?:\.\d+)?", _t, text)
        if "memory" in tl:
            return re.sub(
                r"\d+(?:\.\d+)?", lambda m: f"{float(m.group()) / 1024 / 1024:.2f} MB", text
            )
        return text

    def _parse_child_errors(self, html_text):
        """[{test_name, status, timeout, known, assignee}] from a Multi Qunit
        Child build page. log-server rows: ERROR + [HOOT] Test → test failure;
        ERROR + Script timeout exceeded → timeout. log-runbot rows: WARNING +
        Test time for ... → time-limit warning."""
        errors = []
        for row_m in re.finditer(
            r'<tr class="log-(?:server|runbot)"[^>]*>(.*?)</tr>', html_text, re.DOTALL
        ):
            tds = re.findall(r"<td[^>]*>(.*?)</td>", row_m.group(1), re.DOTALL)
            if len(tds) < 3:
                continue
            td1 = re.sub(r"<[^>]+>", "", tds[1]).strip()
            raw = html_lib.unescape(re.sub(r"<[^>]+>", "", tds[2])).strip()
            if td1 == "ERROR":
                hoot_m = re.search(r'\[HOOT\] Test "([^"]+)"', raw)
                if hoot_m:
                    errors.append(
                        {
                            "test_name": hoot_m.group(1),
                            "status": "danger",
                            "timeout": False,
                            "known": False,
                            "assignee": "",
                        }
                    )
                elif "Script timeout exceeded" in raw:
                    fail_m = re.search(r"FAIL:\s+([\w.]+)", raw)
                    if fail_m:
                        errors.append(
                            {
                                "test_name": f"{fail_m.group(1)}: timeout",
                                "status": "danger",
                                "timeout": True,
                                "known": False,
                                "assignee": "",
                            }
                        )
            elif td1 == "WARNING":
                first_line = raw.splitlines()[0].strip() if raw else ""
                if first_line:
                    errors.append(
                        {
                            "test_name": self._fmt_warning(first_line),
                            "status": "warning",
                            "timeout": False,
                            "known": False,
                            "assignee": "",
                        }
                    )
        return errors

    def _parse_child_metrics(self, html):
        """{suite_name: {avg_mem, max_mem, time, tests, assertions}} for suites
        where the three required memory/time values are present."""
        data = {}
        hoot_matches = re.findall(r"\[HOOT\] Passed (\d+) tests \((\d+) assertions", html)
        suite_order = []
        for m in re.finditer(r"Average memory used for ([\w.]+):\s*([\d.]+)", html):
            suite = m.group(1)
            data.setdefault(suite, {})["avg_mem"] = float(m.group(2))
            if suite not in suite_order:
                suite_order.append(suite)
        for m in re.finditer(r"Max memory used for ([\w.]+):\s*([\d.]+)", html):
            data.setdefault(m.group(1), {})["max_mem"] = float(m.group(2))
        for m in re.finditer(r"Test time for ([\w.]+):\s*([\d.]+)", html):
            data.setdefault(m.group(1), {})["time"] = float(m.group(2))
        for i, suite in enumerate(suite_order):
            if i < len(hoot_matches):
                data.setdefault(suite, {})["tests"] = int(hoot_matches[i][0])
                data.setdefault(suite, {})["assertions"] = int(hoot_matches[i][1])
        return {s: v for s, v in data.items() if "avg_mem" in v and "max_mem" in v and "time" in v}

    # ── public API ────────────────────────────────────────────────────────

    def builds(self, refresh=False, max_nights=14):
        """{"versions": [...], "nights": [{date, versions: {v: {community,
        enterprise}}}]} for all starred Odoo versions, newest night first."""
        max_nights = max(7, min(max_nights, 84))
        versions = self._versions(refresh=refresh)
        if not versions:
            return {"versions": [], "nights": []}

        def fetch_bundle(vb):
            version, bundle_id = vb
            return version, self._bundle_nights(bundle_id, max_nights, refresh=refresh)

        with ThreadPoolExecutor(max_workers=min(10, len(versions))) as pool:
            version_nights = dict(pool.map(fetch_bundle, versions))

        jobs = []
        for version, nights in version_nights.items():
            for night in nights:
                for kind in ("community", "enterprise"):
                    b = night.get(kind)
                    if b:
                        jobs.append((version, night["date"], kind, b))

        def fetch_detail(job):
            version, date, kind, b = job
            return version, date, kind, self._build_detail(b["url"], running=b["status"] == "info")

        detail_map = {}
        if jobs:
            with ThreadPoolExecutor(max_workers=min(16, len(jobs))) as pool:
                for version, date, kind, detail in pool.map(fetch_detail, jobs):
                    if detail:
                        detail_map[(version, date, kind)] = detail

        date_order = {}
        for version, nights in version_nights.items():
            for night in nights:
                d = night["date"]
                vdata = date_order.setdefault(d, {})
                entry = {}
                for kind in ("community", "enterprise"):
                    b = night.get(kind)
                    if not b:
                        continue
                    b = dict(b)
                    detail = detail_map.get((version, d, kind))
                    if detail:
                        b["counts"] = detail["counts"]
                    entry[kind] = b
                vdata[version] = entry

        sorted_nights = [
            {"date": d, "versions": date_order[d]} for d in sorted(date_order, reverse=True)
        ]
        return {"versions": [v for v, _ in versions], "nights": sorted_nights}

    def build_errors(self, parent_url):
        """{"errors": [...], "metrics": {suite: {avg_mem, max_mem, time,
        count, tests, assertions}}} for a Multi Qunit build URL — test-level
        errors and aggregated per-suite performance metrics across its
        children (fetched in parallel, each cached forever once fetched)."""
        detail = self._build_detail(parent_url)
        if not detail:
            return {"errors": [], "metrics": {}}

        def fetch_child(info):
            child_url, row_status = info
            return self._child_detail(child_url, row_status)

        all_errors, suite_buckets = [], {}
        if detail["child_rows"]:
            with ThreadPoolExecutor(max_workers=min(16, len(detail["child_rows"]))) as pool:
                for result in pool.map(fetch_child, detail["child_rows"]):
                    all_errors.extend(result["errors"])
                    for suite, m in result["metrics"].items():
                        b = suite_buckets.setdefault(
                            suite,
                            {
                                "avg_mem": [],
                                "max_mem": [],
                                "time": [],
                                "tests": None,
                                "assertions": None,
                            },
                        )
                        b["avg_mem"].append(m["avg_mem"])
                        b["max_mem"].append(m["max_mem"])
                        b["time"].append(m["time"])
                        if b["tests"] is None and "tests" in m:
                            b["tests"] = m["tests"]
                            b["assertions"] = m["assertions"]

        agg_metrics = {}
        for suite, b in suite_buckets.items():
            n = len(b["avg_mem"])
            if n:
                agg_metrics[suite] = {
                    "avg_mem": sum(b["avg_mem"]) / n,
                    "max_mem": sum(b["max_mem"]) / n,
                    "time": sum(b["time"]) / n,
                    "count": n,
                    "tests": b["tests"],
                    "assertions": b["assertions"],
                }
        return {"errors": all_errors, "metrics": agg_metrics}

    def batch_builds(self, url):
        """[{"label", "url"}] of "start_qunit_only" build links from a runbot
        batch/build page — used by the Memory panel to bulk-import builds from
        a batch. Not cached: a one-off user action, not a periodic poll."""
        if url.startswith("/"):
            url = f"{RUNBOT_BASE}{url}"
        html = self._fetch_html(url)
        if not html:
            return []
        builds, seen = [], set()
        for m in re.finditer(r"<a([^>]*)>(.*?)</a>", html, re.DOTALL):
            attrs, inner = m.group(1), m.group(2)
            if "dropdown-item" not in attrs:
                continue
            text = re.sub(r"<[^>]+>", "", inner).strip()
            if "start_qunit_only" not in text:
                continue
            href_m = re.search(r'href="([^"]+)"', attrs)
            if not href_m:
                continue
            href = href_m.group(1)
            if href in seen:
                continue
            seen.add(href)
            if href.startswith("/"):
                href = f"{RUNBOT_BASE}{href}"
            build_m = re.search(r"/build/(\d+)", href)
            label = build_m.group(1) if build_m else href.split("/")[-1]
            builds.append({"label": label, "url": href})
        return builds


# ─────────────────────────── Memory (hoot [MEMINFO] logs) ───────────────────


class MemoryService:
    """Hoot [MEMINFO] memory-usage comparison across build log URLs the user
    picks explicitly. Not cached — the user is comparing a hand-picked set of
    builds, not polling for updates, so every "Draw graph" fetches fresh."""

    _MEMINFO_RE = re.compile(
        r".*(\.MobileWebSuite|\.WebSuite).*:\s+\[MEMINFO\]\s+([^ ]+)\s+\(after GC\)\s+-\s+used:\s+(\d+)"
    )

    def __init__(self, io):
        self.io = io

    def parse_log(self, text):
        """[(suite_name, used_bytes, is_mobile)] from a hoot build log."""
        results = []
        for line in text.splitlines():
            if "[MEMINFO] @" not in line:
                continue
            m = self._MEMINFO_RE.match(line)
            if m:
                suite_type, suite_name, used = m.group(1), m.group(2), int(m.group(3))
                results.append((suite_name, used, suite_type == ".MobileWebSuite"))
        return results

    def fetch(self, builds, with_mobile=False):
        """[{suite, <label>: bytes, ...}] — one row per suite, one column per
        build — for a list of {"label", "url"} builds, fetched in parallel."""
        valid = [b for b in builds if b.get("url")]

        def fetch_one(build):
            html, err = self.io.http_get(build["url"], timeout=60)
            return build.get("label", ""), ([] if err else self.parse_log(html))

        per_build = {}
        if valid:
            with ThreadPoolExecutor(max_workers=min(16, len(valid))) as pool:
                per_build = dict(pool.map(fetch_one, valid))

        rows, seen = [], {}
        for build in builds:
            label = build.get("label", "")
            for suite_name, used, is_mobile in per_build.get(label, []):
                if not with_mobile and is_mobile:
                    continue
                if suite_name not in seen:
                    seen[suite_name] = len(rows)
                    rows.append({"suite": suite_name})
                rows[seen[suite_name]][label] = used
        return rows


# ─────────────────────────── PostgreSQL databases ───────────────────────────


# a safe database name: letters/digits then letters/digits/._- (no leading dash so
# it can't be read as a CLI flag, no quotes/spaces so it's safe to quote in SQL).
# Covers typical odoo db names (master, 19.0, master-feat-xyz, test_db).
_DB_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def _valid_db_name(name):
    return bool(name) and isinstance(name, str) and bool(_DB_NAME_RE.match(name))


class DatabaseService:
    """PostgreSQL databases: the list (with odoo version + last activity), the
    existence/info probes, and drop. The list is cached server-side and fetched
    with parallel per-db probes; drop invalidates the cache. The probes are quiet
    (a non-zero exit just means "no such db" / "not an odoo db")."""

    def __init__(self, io, cache):
        self.io = io
        self.cache = cache

    def databases(self, refresh=False):
        """All non-template databases with their odoo info. Cached; pass
        refresh=True to bypass. Raises RuntimeError if psql can't be reached."""
        if refresh:
            self.cache.invalidate("list")
        return self.cache.get("list", self._list)

    def _list(self):
        try:
            r = self.io.run(
                [
                    "psql",
                    "-d",
                    "postgres",
                    "-tAc",
                    "SELECT datname FROM pg_database"
                    " WHERE NOT datistemplate AND datname <> 'postgres'"
                    " ORDER BY datname",
                ],
                timeout=5,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            raise RuntimeError(f"cannot list databases: {e}") from e
        if r.returncode != 0:
            raise RuntimeError(r.stderr.strip() or "psql failed")
        names = [ln.strip() for ln in r.stdout.split("\n") if ln.strip()]
        if not names:
            return []
        created = self._creation_times()
        sizes = self._sizes()
        with ThreadPoolExecutor(max_workers=min(8, len(names))) as pool:
            infos = list(pool.map(self.odoo_info, names))  # one psql per db, in parallel
        return [
            {
                "name": n,
                "odoo_version": v,
                "enterprise": e,
                "demo_data": d,
                "last_update": u,
                "created": created.get(n),
                "size": sizes.get(n),
            }
            for n, (v, e, d, u) in zip(names, infos, strict=False)
        ]

    # ── filestore: an Odoo database's attachments live in <filestore>/<dbname>.
    # goo keeps it in lockstep with the database — dropped/renamed/cloned to match —
    # so a target's attachments survive a clone and don't leak after a drop. These
    # are best-effort: a filestore failure is logged, never failing the DB op (the
    # database change already happened). Names are charset-validated, so the joined
    # path can't traverse out of the filestore root.
    def _filestore_dir(self, filestore, name):
        if not filestore or not _valid_db_name(name):
            return None
        return os.path.join(os.path.expanduser(filestore), name)

    def _log_filestore(self, action, src, dst, err):
        tag = getattr(self.io, "TAG", "[goo]")
        where = f"{src} → {dst}" if dst else src
        self.io.log(f"{tag} could not {action} filestore {where}: {err}")

    def drop(self, name, filestore=None):
        """Drop a database (and its filestore). Returns (ok, error); invalidates the
        list cache."""
        try:
            r = self.io.run(["dropdb", name], timeout=15)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e)
        if r.returncode != 0:
            return False, r.stderr.strip() or "dropdb failed"
        self.cache.invalidate("list")
        store = self._filestore_dir(filestore, name)
        if store and self.io.is_dir(store):
            ok, err = self.io.remove_tree(store)
            if not ok:
                self._log_filestore("delete", store, None, err)
        return True, None

    def clone(self, source, target, filestore=None):
        """Clone `source` into a new database `target` (createdb -T) and copy its
        filestore. Returns (ok, error); invalidates the list cache on success. The
        source must have no active connections (a postgres requirement) — stop the
        server if it's on it."""
        if not _valid_db_name(source):
            return False, f"invalid source name: {source}"
        if not _valid_db_name(target):
            return False, f"invalid target name: {target}"
        try:
            r = self.io.run(["createdb", "-T", source, target], timeout=120)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e)
        if r.returncode != 0:
            return False, r.stderr.strip() or "createdb failed"
        self.cache.invalidate("list")
        src = self._filestore_dir(filestore, source)
        dst = self._filestore_dir(filestore, target)
        if src and dst and self.io.is_dir(src):
            ok, err = self.io.copy_tree(src, dst)
            if not ok:
                self._log_filestore("copy", src, dst, err)
        return True, None

    def rename(self, old, new, filestore=None):
        """Rename database `old` to `new` (ALTER DATABASE … RENAME) and move its
        filestore. Returns (ok, error); invalidates the list cache on success. `old`
        must have no active connections (a postgres requirement)."""
        if not _valid_db_name(old):
            return False, f"invalid name: {old}"
        if not _valid_db_name(new):
            return False, f"invalid name: {new}"
        # names are validated to the safe charset above, so quoting is injection-free
        sql = f'ALTER DATABASE "{old}" RENAME TO "{new}"'
        try:
            r = self.io.run(["psql", "-d", "postgres", "-tAc", sql], timeout=15)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e)
        if r.returncode != 0:
            return False, r.stderr.strip() or "rename failed"
        self.cache.invalidate("list")
        src = self._filestore_dir(filestore, old)
        dst = self._filestore_dir(filestore, new)
        if src and dst and self.io.is_dir(src):
            ok, err = self.io.move_path(src, dst)
            if not ok:
                self._log_filestore("move", src, dst, err)
        return True, None

    def db_initialized(self, db):
        """Whether the database exists AND holds an initialized odoo schema. A db
        can exist as an empty shell; odoo refuses to load it without -i, so treat
        that as new. On a probe error (no psql), assume initialized to avoid a
        surprise reinstall."""
        try:
            r = self.io.run(
                [
                    "psql",
                    "-d",
                    db,
                    "-tAc",
                    "SELECT 1 FROM information_schema.tables WHERE table_name = 'ir_module_module'",
                ],
                timeout=5,
                quiet=True,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return True
        if r.returncode != 0:
            return False  # database doesn't exist
        return r.stdout.strip() == "1"

    def odoo_info(self, db):
        """(version, is_enterprise, has_demo_data, last_update) of the odoo in a
        database, or (None, False, False, None) if it holds no odoo. has_demo_data
        reflects ir_module_module.demo — set per-module by odoo itself when that
        module's demo data was actually loaded (i.e. not `--without-demo all`).
        last_update is the UTC timestamp of the last detectable activity (cron
        writes, login rows)."""
        try:
            r = self.io.run(
                [
                    "psql",
                    "-d",
                    db,
                    "-tAc",
                    "SELECT (SELECT latest_version FROM ir_module_module WHERE name = 'base'),"
                    " EXISTS (SELECT 1 FROM ir_module_module"
                    " WHERE name = 'web_enterprise' AND state = 'installed'),"
                    " EXISTS (SELECT 1 FROM ir_module_module WHERE demo),"
                    " GREATEST((SELECT max(write_date) FROM ir_cron),"
                    " (SELECT max(create_date) FROM res_users_log))",
                ],
                timeout=5,
                quiet=True,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return None, False, False, None
        line = r.stdout.strip()
        if r.returncode != 0 or not line:
            return None, False, False, None  # no odoo tables: not an odoo database
        version, enterprise, demo_data, last_update = line.split("|", 3)
        return version or None, enterprise == "t", demo_data == "t", last_update or None

    def installed_modules(self, db):
        """Map of module name -> state for a database (empty if unreadable)."""
        try:
            r = self.io.run(
                ["psql", "-d", db, "-tAc", "SELECT name, state FROM ir_module_module"],
                timeout=5,
                quiet=True,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return {}
        if r.returncode != 0:
            return {}
        out = {}
        for line in r.stdout.splitlines():
            if "|" in line:
                name, state = line.split("|", 1)
                out[name] = state
        return out

    def _creation_times(self):
        """Map db name -> creation timestamp (naive UTC ISO) from each database's
        PG_VERSION mtime. Needs superuser / pg_read_server_files; {} if not."""
        try:
            r = self.io.run(
                [
                    "psql",
                    "-d",
                    "postgres",
                    "-tAc",
                    "SELECT datname,"
                    " (pg_stat_file('base/' || oid || '/PG_VERSION')).modification AT TIME ZONE 'UTC'"
                    " FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres'",
                ],
                timeout=5,
                quiet=True,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return {}
        if r.returncode != 0:
            return {}
        out = {}
        for line in r.stdout.splitlines():
            if "|" in line:
                name, ts = line.split("|", 1)
                out[name] = ts or None
        return out

    def _sizes(self):
        """Map db name -> on-disk size in bytes (pg_database_size). Best-effort: {}
        on any error — the size is just informational, never blocks the listing."""
        try:
            r = self.io.run(
                [
                    "psql",
                    "-d",
                    "postgres",
                    "-tAc",
                    "SELECT datname, pg_database_size(datname)"
                    " FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres'",
                ],
                timeout=5,
                quiet=True,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return {}
        if r.returncode != 0:
            return {}
        out = {}
        for line in r.stdout.splitlines():
            if "|" in line:
                name, size = line.split("|", 1)
                try:
                    out[name] = int(size)
                except ValueError:
                    pass
        return out


# ─────────────────────────── git (user repos) ───────────────────────────

_BASE_BRANCH_RE = re.compile(r"^(saas-\d+\.\d+|\d+\.\d+|master)")


def base_branch(name):
    """The canonical base a branch derives from (master-owl-update -> master,
    19.0-fix -> 19.0). Defaults to master."""
    m = _BASE_BRANCH_RE.match(name or "")
    return m.group(1) if m else "master"


class GitService:
    """Local git operations on the user's repos, over the IO seam. Branch reads are
    volatile (dirty / current-branch state) and fast, so they're not cached — callers
    fetch fresh each time. `notify` (optional) reports progress events (the fetch /
    rebase phases) — wired to the event bus in production, a no-op in tests."""

    def __init__(self, io, notify=None):
        self.io = io
        self.notify = notify or (lambda *a, **k: None)

    def branches(self, repos):
        """For each repo {id, path}: the checked-out branch and all local branches
        with their last-commit date, plus dirty / pushed / ahead-behind state. Each
        repo's git reads (~7 subprocesses) are independent, so repos are read in
        parallel — keeping a multi-repo target's refresh snappy."""
        valid = [r for r in repos if r.get("id") and r.get("path")]
        if not valid:
            return []

        def one(repo):
            rid = repo.get("id")
            path = os.path.expanduser(repo.get("path", ""))
            entry = {
                "id": rid,
                "current": None,
                "dirty": False,
                "head_subject": "",
                "head_date": "",
                "head_sha": "",  # HEAD commit sha
                "head_pushed": False,  # HEAD is reachable from some remote (so linkable)
                "head_remote": False,  # the current branch has a remote-tracking ref
                "ahead": 0,  # current branch commits not on its base (target) branch
                "behind": 0,  # base branch commits not on the current branch
                "branches": [],
                "error": None,
            }
            try:
                r = self.io.run(["git", "-C", path, "branch", "--show-current"], timeout=10)
                if r.returncode != 0:
                    entry["error"] = r.stderr.strip().split("\n")[0] or "not a git repository"
                    return entry
                entry["current"] = r.stdout.strip() or "(detached)"
                # uncommitted changes in the working tree (only the current branch)
                st = self.io.run(["git", "-C", path, "status", "--porcelain"], timeout=10)
                entry["dirty"] = bool(st.stdout.strip())
                # HEAD's sha + last commit subject + date (for the dashboard summary)
                hl = self.io.run(
                    ["git", "-C", path, "log", "-1", "--format=%H%n%s%n%cI"], timeout=10
                )
                if hl.returncode == 0:
                    lines = hl.stdout.splitlines()
                    entry["head_sha"] = lines[0] if lines else ""
                    entry["head_subject"] = lines[1] if len(lines) > 1 else ""
                    entry["head_date"] = lines[2] if len(lines) > 2 else ""
                # is HEAD reachable from any remote ref? (i.e. pushed -> linkable)
                rp = self.io.run(
                    ["git", "-C", path, "rev-list", "HEAD", "--not", "--remotes", "--count"],
                    timeout=10,
                )
                if rp.returncode == 0:
                    entry["head_pushed"] = rp.stdout.strip() == "0"
                # how far the current branch diverges from its canonical base (the
                # "target" it would rebase onto), e.g. master-owl-update vs origin/master
                base = base_branch(entry["current"])
                ref = f"{self.main_remote(path, repo.get('github'))}/{base}"
                # quiet: the base ref may not be fetched locally (→ "bad revision"); that's
                # expected, we just leave ahead/behind at 0 rather than log every refresh
                ad = self.io.run(
                    ["git", "-C", path, "rev-list", "--left-right", "--count", f"{ref}...HEAD"],
                    timeout=10,
                    quiet=True,
                )
                if ad.returncode == 0 and len(ad.stdout.split()) == 2:
                    behind, ahead = ad.stdout.split()
                    entry["behind"], entry["ahead"] = int(behind), int(ahead)
                # remote-tracking refs: the branch names (pushed from this clone at
                # some point) and the sha each ref points at. The sha lets a branch
                # tell whether its local tip is actually what's on the remote — a
                # stale same-named ref (e.g. an ancient dev/<branch> whose name got
                # reused for fresh, unpushed local work) is present but NOT in sync.
                rr = self.io.run(
                    [
                        "git",
                        "-C",
                        path,
                        "for-each-ref",
                        "refs/remotes",
                        "--format=%(refname:lstrip=3)%09%(objectname)",
                    ],
                    timeout=10,
                )
                remote_branches = set()
                remote_shas = {}  # branch name -> {sha, …} across remotes
                for line in rr.stdout.splitlines():
                    parts = line.split("\t")
                    nm = parts[0]
                    if not nm:
                        continue
                    remote_branches.add(nm)
                    if len(parts) > 1:
                        remote_shas.setdefault(nm, set()).add(parts[1])
                entry["head_remote"] = entry["current"] in remote_branches
                r = self.io.run(
                    [
                        "git",
                        "-C",
                        path,
                        "for-each-ref",
                        "refs/heads",
                        "--format=%(refname:short)%09%(committerdate:iso8601-strict)%09%(contents:subject)%09%(objectname)",
                    ],
                    timeout=10,
                )
                for line in r.stdout.splitlines():
                    parts = line.split("\t")
                    name = parts[0]
                    if name:
                        sha = parts[3] if len(parts) > 3 else ""
                        entry["branches"].append(
                            {
                                "name": name,
                                "date": parts[1] if len(parts) > 1 else "",
                                "subject": parts[2] if len(parts) > 2 else "",
                                "sha": sha,
                                "remote": name in remote_branches,
                                # local tip == a same-named remote ref (truly pushed
                                # and current, not just a stale ref of the same name)
                                "synced": bool(sha) and sha in remote_shas.get(name, ()),
                            }
                        )
            except (FileNotFoundError, subprocess.TimeoutExpired) as e:
                entry["error"] = str(e)
            return entry

        with ThreadPoolExecutor(max_workers=min(8, len(valid))) as pool:
            return list(pool.map(one, valid))

    def checkout(self, path, branch, repo=""):
        """Checkout a local branch in a repo. Returns (ok, error). Announced as a
        timed event via notify so the browser shows a live "..." that resolves to
        "ok"/"failed"."""
        if not path or not branch:
            return False, "missing path or branch"
        p = os.path.expanduser(path)
        label = repo or os.path.basename(p)
        eid = uuid.uuid4().hex
        checking = f"checking out {branch} ({label})"
        self.notify(checking, event_id=eid, status="start")
        try:
            r = self.io.run(["git", "-C", p, "checkout", branch], timeout=60)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            self.notify(checking, event_id=eid, status="error")
            return False, str(e)
        if r.returncode != 0:
            self.notify(checking, event_id=eid, status="error")
            return False, r.stderr.strip().split("\n")[0] or "git checkout failed"
        self.notify(checking, event_id=eid, status="done")
        return True, None

    def worktree_add(
        self, main_path, worktree_path, branch, repo="", new_branch=False, start_point=None
    ):
        """Add a git worktree at <worktree_path>, linked to the repo at <main_path>
        (sharing its .git); git creates intermediate dirs. With new_branch, create
        <branch> at <start_point> in the new worktree (git worktree add -b) — the
        usual case, since a branch already checked out in the main tree can't be
        checked out again elsewhere. Otherwise attach the existing <branch>. Returns
        (ok, error). Announced as a timed event via notify."""
        if not main_path or not worktree_path or not branch:
            return False, "missing path, worktree path or branch"
        if new_branch and not start_point:
            return False, "missing start point for the new branch"
        p = os.path.expanduser(main_path)
        wp = os.path.expanduser(worktree_path)
        label = repo or os.path.basename(p)
        eid = uuid.uuid4().hex
        creating = f"creating worktree {branch} ({label})"
        self.notify(creating, event_id=eid, status="start")
        if new_branch:
            cmd = ["git", "-C", p, "worktree", "add", "-b", branch, wp, start_point]
        else:
            cmd = ["git", "-C", p, "worktree", "add", wp, branch]
        try:
            r = self.io.run(cmd, timeout=120)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            self.notify(creating, event_id=eid, status="error")
            return False, str(e)
        if r.returncode != 0:
            self.notify(creating, event_id=eid, status="error")
            return False, (r.stderr.strip() or "git worktree add failed").split("\n")[0]
        self.notify(creating, event_id=eid, status="done")
        return True, None

    def worktree_remove(self, main_path, worktree_path, repo=""):
        """Remove the git worktree at <worktree_path> (--force, so it goes even with
        local changes or a running server). Returns (ok, error). Timed event."""
        if not main_path or not worktree_path:
            return False, "missing path or worktree path"
        p = os.path.expanduser(main_path)
        wp = os.path.expanduser(worktree_path)
        label = repo or os.path.basename(p)
        eid = uuid.uuid4().hex
        removing = f"removing worktree ({label})"
        self.notify(removing, event_id=eid, status="start")
        try:
            r = self.io.run(["git", "-C", p, "worktree", "remove", "--force", wp], timeout=60)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            self.notify(removing, event_id=eid, status="error")
            return False, str(e)
        if r.returncode != 0:
            self.notify(removing, event_id=eid, status="error")
            return False, (r.stderr.strip() or "git worktree remove failed").split("\n")[0]
        self.notify(removing, event_id=eid, status="done")
        return True, None

    def create_branch(self, path, name, start_point):
        """Create a new local branch <name> at <start_point> WITHOUT checking it
        out (working tree / current branch untouched). Returns (ok, error)."""
        if not path or not name or not start_point:
            return False, "missing path, name or start point"
        try:
            r = self.io.run(
                ["git", "-C", os.path.expanduser(path), "branch", name, start_point], timeout=10
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e)
        if r.returncode != 0:
            return False, r.stderr.strip().split("\n")[0] or "git branch failed"
        return True, None

    def delete_branch(self, path, branch, delete_remote=False):
        """Force-delete a local branch, and optionally its branch on the odoo-dev
        remote too. Returns (ok, error, remote_error): the first two are for the
        local delete; remote_error is set when the local delete succeeded but the
        remote branch could not be removed (None otherwise)."""
        path = os.path.expanduser(path)
        try:
            r = self.io.run(["git", "-C", path, "branch", "-D", branch], timeout=10)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e), None
        if r.returncode != 0:
            return False, r.stderr.strip().split("\n")[0] or "git branch -D failed", None
        remote_error = None
        if delete_remote:
            # delete straight away — no `ls-remote` pre-check (a round-trip per branch).
            # If the branch was never pushed, git fails with "remote ref does not
            # exist", which we treat as success: there was nothing to remove.
            remote, _ = self.dev_remote(path)
            if not remote:
                return True, None, None  # no odoo-dev fork → nothing could be there
            self.io.log_request(f"git push {remote} --delete {branch}")
            try:
                r = self.io.run(
                    ["git", "-C", path, "push", remote, "--delete", branch], timeout=120
                )
                if r.returncode != 0 and "remote ref does not exist" not in r.stderr:
                    remote_error = r.stderr.strip().split("\n")[-1] or "git push --delete failed"
            except (FileNotFoundError, subprocess.TimeoutExpired) as e:
                remote_error = str(e)
        return True, None, remote_error

    def wip_commit(self, path):
        """Stage all changes and create a WIP commit. Returns (ok, error)."""
        path = os.path.expanduser(path)
        try:
            r = self.io.run(["git", "-C", path, "add", "-A"], timeout=30)
            if r.returncode != 0:
                return False, r.stderr.strip() or "git add failed"
            r = self.io.run(["git", "-C", path, "commit", "--no-verify", "-m", "WIP"], timeout=30)
            if r.returncode != 0:
                return False, r.stderr.strip() or "git commit failed"
            return True, None
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e)

    def discard(self, path):
        """Make the working tree pristine: reset tracked files to HEAD, then remove
        untracked files/dirs (git clean -fd, leaving ignored files). (ok, error)."""
        path = os.path.expanduser(path)
        try:
            r = self.io.run(["git", "-C", path, "reset", "--hard", "HEAD"], timeout=30)
            if r.returncode != 0:
                return False, r.stderr.strip() or "git reset failed"
            r = self.io.run(["git", "-C", path, "clean", "-fd"], timeout=30)
            if r.returncode != 0:
                return False, r.stderr.strip() or "git clean failed"
            return True, None
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e)

    def log(self, path, n=20, ref=""):
        """The last n commits on <ref> (default HEAD). Returns (commits, error);
        commits is a list of {sha, author, date, subject, body}. Fields are
        \\x1f-separated, commits \\x1e-terminated so multi-line bodies survive."""
        path = os.path.expanduser(path)
        cmd = ["git", "-C", path, "log", "-n", str(n), "--format=%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1e"]
        if ref:
            cmd += [ref, "--"]  # log a specific branch; -- disambiguates ref from a path
        try:
            r = self.io.run(cmd, timeout=30)
            if r.returncode != 0:
                return None, r.stderr.strip() or "git log failed"
            commits = []
            for rec in r.stdout.split("\x1e"):
                rec = rec.strip("\n")
                if not rec:
                    continue
                parts = rec.split("\x1f")
                if len(parts) < 4:
                    continue
                commits.append(
                    {
                        "sha": parts[0],
                        "author": parts[1],
                        "date": parts[2],
                        "subject": parts[3],
                        "body": parts[4].strip() if len(parts) > 4 else "",
                    }
                )
            return commits, None
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return None, str(e)

    def fetch_remote_branch(self, path, branch):
        """Fetch a remote branch and create/reset the local branch to track it
        (git fetch origin {branch}:{branch}). Returns (ok, error)."""
        path = os.path.expanduser(path)
        try:
            r = self.io.run(
                ["git", "-C", path, "fetch", "origin", f"{branch}:{branch}"], timeout=60
            )
            if r.returncode != 0:
                return False, r.stderr.strip().split("\n")[0] or "git fetch failed"
            return True, None
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e)

    def fetch_rebase(self, path, base, github, repo=""):
        """Fetch the base branch from the canonical (main) repo and rebase the
        current branch onto it. Announces the fetch and rebase phases via notify.
        Returns (ok, error); on conflict the rebase is left in progress."""
        if not path or not base:
            return False, "missing path or base branch"
        remote = self.main_remote(path, github)
        if not remote:
            return False, f"no remote points at {github}"
        p = os.path.expanduser(path)
        label = repo or os.path.basename(p)
        # both phases are slow — track each as a timed event so the browser shows a
        # live "..." that resolves to "ok" (or "failed")
        fid = uuid.uuid4().hex
        fetching = f"fetching {base} ({label})"
        self.notify(fetching, event_id=fid, status="start")
        try:
            f = self.io.run(["git", "-C", p, "fetch", remote, base], timeout=180)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            self.notify(fetching, event_id=fid, status="error")
            return False, str(e)
        if f.returncode != 0:
            self.notify(fetching, event_id=fid, status="error")
            return False, (f.stderr.strip() or "git fetch failed").split("\n")[0]
        self.notify(fetching, event_id=fid, status="done")
        eid = uuid.uuid4().hex
        rebasing = f"rebasing {label} onto {base}"
        self.notify(rebasing, event_id=eid, status="start")
        try:
            r = self.io.run(["git", "-C", p, "rebase", "FETCH_HEAD"], timeout=120)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            self.notify(rebasing, event_id=eid, status="error")
            return False, str(e)
        if r.returncode != 0:
            self.notify(rebasing, event_id=eid, status="error")
            msg = (r.stderr.strip() or r.stdout.strip()).split("\n")[0]
            return False, msg or "git rebase failed"
        self.notify(rebasing, event_id=eid, status="done")
        return True, None

    def dev_remote(self, path):
        """Name of the remote pointing at the odoo-dev fork. (remote, error)."""
        try:
            r = self.io.run(["git", "-C", os.path.expanduser(path), "remote", "-v"], timeout=10)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return None, str(e)
        for line in r.stdout.splitlines():
            parts = line.split()
            if len(parts) >= 2 and "odoo-dev" in parts[1]:
                return parts[0], None
        return None, "no odoo-dev remote configured"

    def remote_branch_exists(self, path, branch):
        """Whether <branch> exists on the odoo-dev remote. (exists, error)."""
        remote, err = self.dev_remote(path)
        if err:
            return None, err
        self.io.log_request(f"git ls-remote {remote} {branch}")
        try:
            r = self.io.run(
                ["git", "-C", os.path.expanduser(path), "ls-remote", "--heads", remote, branch],
                timeout=20,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return None, str(e)
        if r.returncode != 0:
            return None, r.stderr.strip().split("\n")[0] or "git ls-remote failed"
        return bool(r.stdout.strip()), None

    def push_branch(self, path, branch, force=False):
        """Push <branch> to the odoo-dev remote, setting upstream. With force, use
        --force-with-lease (aborts if the remote moved unexpectedly). (ok, error)."""
        remote, err = self.dev_remote(path)
        if err:
            return False, err
        args = ["push", "--set-upstream"]
        if force:
            args.append("--force-with-lease")
        args += [remote, branch]
        self.io.log_request("git " + " ".join(args))
        try:
            r = self.io.run(["git", "-C", os.path.expanduser(path), *args], timeout=120)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e)
        if r.returncode != 0:
            return False, r.stderr.strip().split("\n")[-1] or "git push failed"
        return True, None

    def main_remote(self, path, github=None):
        """Best guess at the remote hosting the canonical master: (1) the upstream
        of the local `master` branch; (2) the remote whose URL matches the github
        slug (not the odoo-dev fork); (3) "origin"."""
        p = os.path.expanduser(path)
        try:
            # quiet: a non-zero exit just means master has no upstream here — expected,
            # we fall back to the remote-URL match / "origin" below
            r = self.io.run(
                ["git", "-C", p, "rev-parse", "--abbrev-ref", "master@{upstream}"],
                timeout=10,
                quiet=True,
            )
            if r.returncode == 0 and "/" in r.stdout.strip():
                return r.stdout.strip().split("/", 1)[0]
            if github:
                rv = self.io.run(["git", "-C", p, "remote", "-v"], timeout=10)
                for line in rv.stdout.splitlines():
                    parts = line.split()
                    if len(parts) >= 2 and github in parts[1]:
                        return parts[0]
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass
        return "origin"

    def fetch_master(self, repo):
        """Fetch master objects for one repo (no merge, no working-tree change).
        Slow on stale odoo clones, so callers run this off the main thread."""
        rid = repo.get("id") or "?"
        path = repo.get("path")
        if not path:
            return
        remote = self.main_remote(path, repo.get("github"))
        self.io.log_request(f"git fetch {remote} master  (auto-reload {rid})")
        tag = getattr(self.io, "TAG", "[goo]")
        try:
            r = self.io.run(
                ["git", "-C", os.path.expanduser(path), "fetch", remote, "master"],
                timeout=900,
                quiet=True,  # we print our own auto-reload summary below
            )
            if r.returncode != 0:
                tail = r.stderr.strip().splitlines()
                self.io.log(
                    f"{tag} auto-reload {rid} failed: {tail[-1] if tail else 'git fetch failed'}"
                )
            else:
                self.io.log(f"{tag} auto-reload {rid}: fetched {remote}/master")
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            self.io.log(f"{tag} auto-reload {rid} failed: {e}")


# ─────────────────────────── Addons (filesystem scan) ───────────────────────


class AddonsService:
    """Odoo modules discovered by scanning each repo's addons roots for a
    __manifest__.py. Over the IO seam (filesystem reads), so it's testable without
    a real checkout. The install state per db comes from DatabaseService."""

    def __init__(self, io):
        self.io = io

    def modules(self, repos):
        """Scan each repo {id, path} for modules with a manifest. A module name
        found in an earlier repo wins (community before enterprise, etc.)."""
        mods = []
        seen = set()
        for repo in repos:
            rid, path = repo.get("id"), repo.get("path")
            if not rid or not path:
                continue
            for root in self._roots(rid, path):
                if not self.io.is_dir(root):
                    continue
                for name in self.io.list_dir(root):
                    if name.startswith((".", "_")) or name in seen:
                        continue
                    man = self._manifest(os.path.join(root, name))
                    if not man:
                        continue
                    seen.add(name)
                    mods.append(
                        {
                            "name": name,
                            "repo": rid,
                            "category": man.get("category") or "",
                            "summary": man.get("summary") or "",
                            "application": bool(man.get("application")),
                            "installable": man.get("installable", True),
                        }
                    )
        return mods

    @staticmethod
    def _roots(rid, path):
        """Directories that hold modules for a repo, matching the addons-path."""
        p = os.path.expanduser(path)
        if rid == "community":
            return [os.path.join(p, "addons"), os.path.join(p, "odoo", "addons")]
        return [p]

    def _manifest(self, module_path):
        """Parse a module's __manifest__.py into a dict, or None."""
        content = self.io.read_text(os.path.join(module_path, "__manifest__.py"))
        if content is None:
            return None
        try:
            tree = ast.parse(content)
        except SyntaxError:
            return None
        for node in ast.walk(tree):
            if isinstance(node, ast.Dict):
                try:
                    return ast.literal_eval(node)
                except (ValueError, TypeError):
                    return None
        return None


# ─────────────────────────── Assets (asset bundles) ─────────────────────────


class AssetsService:
    """Asset-bundle attachments in a target db — the ir_attachment rows whose url
    is under /web/assets/... (one per bundle/extension/version). Read via psql,
    cached per-db with a short TTL. `generate` forces a pregeneration by piping a
    call into `odoo-bin shell` (the command is assembled in the server layer, which
    owns the odoo-bin invocation)."""

    # the shell rolls its cursor back unless we commit, so the script commits itself
    PREGEN_SCRIPT = "env['ir.qweb']._pregenerate_assets_bundles()\nenv.cr.commit()\n"

    def __init__(self, io, cache):
        self.io = io
        self.cache = cache

    def bundles(self, db, refresh=False):
        """[{id, name, url, size, created}] for a db's asset bundles, ordered by
        name. Empty if the db is unreadable or holds no odoo. refresh bypasses the
        cache."""
        if not _valid_db_name(db):
            return []
        if refresh:
            self.cache.invalidate(db)
        return self.cache.get(db, lambda: self._bundles(db))

    def _bundles(self, db):
        try:
            r = self.io.run(
                [
                    "psql",
                    "-d",
                    db,
                    "-tAc",
                    "SELECT id, name, url, COALESCE(file_size, 0), create_date"
                    " FROM ir_attachment WHERE url LIKE '/web/assets/%' ORDER BY name",
                ],
                timeout=10,
                quiet=True,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return []
        if r.returncode != 0:
            return []
        rows = []
        for line in r.stdout.splitlines():
            parts = line.split("|", 4)
            if len(parts) < 5:
                continue
            aid, name, url, size, created = parts
            rows.append(
                {
                    "id": int(aid) if aid.isdigit() else aid,
                    "name": name,
                    "url": url,
                    "size": int(size) if size.isdigit() else 0,
                    "created": created or "",
                }
            )
        return rows

    def generate(self, cmd, db, timeout=900):
        """Run a prepared `odoo-bin shell` command, piping the pregeneration call to
        its stdin. Returns (ok, error); on success the cached bundle list for db is
        dropped so the next read reflects the new attachments."""
        try:
            r = self.io.run(
                cmd,
                shell=True,
                executable="/bin/bash",
                input=self.PREGEN_SCRIPT,
                timeout=timeout,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e)
        if r.returncode != 0:
            tail = (r.stderr or r.stdout or "").strip().splitlines()
            return False, (tail[-1] if tail else "asset generation failed")
        self.cache.invalidate(db)
        return True, None

    # the per-file separators odoo writes into a bundle: "/* /web/.../foo.js */"
    # before each file, and a stars banner before the XML templates section.
    _MARKER = re.compile(r"/\* (/\S+?) \*/")
    _TPL = re.compile(r'register(?:Template|TemplateExtension)\("([^"]+)"')
    _TPL_SPLIT = re.compile(r"/\*{6,}")
    # fallback when the client sends no filestore root (the config always has one)
    DEFAULT_FILESTORE = os.path.expanduser("~/.local/share/Odoo/filestore")

    def breakdown(self, db, bundle, filestore=None, kind=None):
        """Per-file minified-size breakdown of a bundle, read straight from its
        stored attachments — the actual shipped bytes, so it's version-correct and
        needs no odoo process. `filestore` is the configured filestore root (a db's
        files live in <filestore>/<db>/<store_fname>). `kind` scopes the read to one
        asset: "js" → the .min.js (its code + XML templates), "css" → the .min.css;
        None reads both. Scoping matches the size shown for the attachment the caller
        clicked (a .min.js row is JS-only, not JS+CSS). Slices the bundle on the
        per-file "/* /path */" markers and the XML-templates banner. Returns
        (data, error); data is {js: [[path, bytes], …], css: […], xml: […]}, None on
        failure (e.g. the bundle was never generated to disk)."""
        if not _valid_db_name(db):
            return None, "invalid database name"
        if not re.match(r"^[A-Za-z0-9_.-]+$", bundle or ""):
            return None, "invalid bundle name"
        rows = self._bundle_files(db, bundle)
        if rows is None:
            return None, "could not read the database"
        filestore = filestore or self.DEFAULT_FILESTORE
        want_js = kind in (None, "js")
        want_css = kind in (None, "css")
        js_text = self._asset_text(db, filestore, rows.get("min.js")) if want_js else None
        css_text = self._asset_text(db, filestore, rows.get("min.css")) if want_css else None
        if js_text is None and css_text is None:
            return None, 'bundle not generated yet — run "Generate asset bundles" first'
        parts = self._TPL_SPLIT.split(js_text or "", maxsplit=1)
        js = self._split_markers(parts[0])
        xml = self._templates(parts[1] if len(parts) > 1 else "")
        css = self._split_markers(css_text or "")
        return {"js": js, "css": css, "xml": xml}, None

    def _bundle_files(self, db, bundle):
        """{"min.js"|"min.css": (store_fname, db_datas_b64)} for a bundle's stored
        attachments, or None if the db can't be read. bundle is pre-validated."""
        names = f"'{bundle}.min.js', '{bundle}.min.css'"
        try:
            r = self.io.run(
                [
                    "psql",
                    "-d",
                    db,
                    "-tAc",
                    "SELECT name, COALESCE(store_fname, ''),"
                    " COALESCE(encode(db_datas, 'base64'), '') FROM ir_attachment"
                    f" WHERE url LIKE '/web/assets/%' AND name IN ({names})",
                ],
                timeout=15,
                quiet=True,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return None
        if r.returncode != 0:
            return None
        out = {}
        for line in r.stdout.splitlines():
            cols = line.split("|", 2)
            if len(cols) < 3:
                continue
            name, store_fname, datas = cols
            for ext in ("min.js", "min.css"):
                if name.endswith("." + ext):
                    out[ext] = (store_fname, datas)
        return out

    def _asset_text(self, db, filestore, row):
        """One stored attachment's text — from its filestore file
        (<filestore>/<db>/<store_fname>), else its inline db_datas. None when
        absent/unreadable."""
        if not row:
            return None
        store_fname, datas = row
        if store_fname:
            path = os.path.join(os.path.expanduser(filestore), db, store_fname)
            try:
                return self.io.read_text(path)
            except ValueError:  # incl. UnicodeDecodeError on a non-utf8 file
                return None
        if datas:
            try:
                return base64.b64decode(datas).decode("utf-8", "replace")
            except ValueError:  # incl. binascii.Error
                return None
        return None

    def _split_markers(self, text):
        """[[path, bytes], …] by slicing text on the "/* /path */" file markers; each
        file's size is the byte length of its chunk up to the next marker."""
        marks = list(self._MARKER.finditer(text))
        out = []
        for i, m in enumerate(marks):
            end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
            out.append([m.group(1), len(text[m.end() : end].encode("utf-8"))])
        return out

    def _templates(self, text):
        """[[template, bytes], …] from a bundle's XML section (registerTemplate
        calls). Dotted names become slash paths so they nest by addon in the tree."""
        marks = list(self._TPL.finditer(text))
        out = []
        for i, m in enumerate(marks):
            end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
            out.append([m.group(1).replace(".", "/"), len(text[m.end() : end].encode("utf-8"))])
        return out


# ─────────────────────────── Config store ───────────────────────────

_KEEP = object()  # sentinel: "leave this blob unchanged" in ConfigStore.save


class ConfigStore:
    """The server-owned config file: {rev, config, state}, persisted atomically.

    `config` (the user's settings/repos/targets) and `state` (app-recorded: active
    target, test history, reviews, claude model) are opaque JSON blobs — the schema
    lives in the frontend (static/src/config.js); the server only versions them under
    one shared `rev`, guards concurrent writes, and reads a few well-known fields for
    the CLI / auto-reloader. A missing file reads as rev 0 with null blobs (the client
    seeds it on first boot). Writes go through the effects seam, so it's unit-testable.
    """

    def __init__(self, io, path, notify=None):
        self.io = io
        self.path = path
        self._notify = notify  # called with the new {rev, config, state} after a save
        self._lock = threading.Lock()
        self._cache = None  # {rev, config, state}, lazily loaded

    def _load(self):
        data, error = self.io.read_json_file(self.path)
        if error:
            # a corrupt file: don't clobber it — surface rev 0 so the client can decide
            return {"rev": 0, "config": None, "state": None, "error": error}
        if not data:
            return {"rev": 0, "config": None, "state": None}
        return {
            "rev": data.get("rev", 0),
            "config": data.get("config"),
            "state": data.get("state"),
        }

    def get(self):
        """The current {rev, config, state} (cached after first read)."""
        with self._lock:
            if self._cache is None:
                self._cache = self._load()
            return dict(self._cache)

    def save(self, rev, config=_KEEP, state=_KEEP):
        """Replace `config` and/or `state` (whichever isn't _KEEP) iff `rev` matches the
        current rev. Returns (ok, result): on success (True, {rev, config, state}) with
        rev bumped; on a stale rev (False, {conflict:True, rev, config, state}) leaving
        the file untouched; on a write failure (False, {error})."""
        with self._lock:
            cur = self._cache if self._cache is not None else self._load()
            self._cache = cur
            if rev != cur.get("rev", 0):
                return False, {
                    "conflict": True,
                    "rev": cur.get("rev", 0),
                    "config": cur.get("config"),
                    "state": cur.get("state"),
                }
            new = {
                "rev": cur.get("rev", 0) + 1,
                "config": cur.get("config") if config is _KEEP else config,
                "state": cur.get("state") if state is _KEEP else state,
            }
            ok, error = self.io.write_json_file(self.path, new)
            if not ok:
                return False, {"error": error}
            self._cache = new
            if self._notify:
                self._notify(dict(new))
            return True, dict(new)


def _worktree_slug(target):
    """Filesystem-safe folder name for a worktree target — the Python twin of
    utils.js worktreeSlug (case-preserving, falls back to the stable id)."""
    s = re.sub(r"(^-+|-+$)", "", re.sub(r"[^a-zA-Z0-9._-]+", "-", target.get("name") or ""))
    return s or target.get("id")


def _worktree_dir(config, target):
    """A worktree target's on-disk directory: its persisted `worktree.dir` (frozen at
    creation, Step 3), else the derived <worktree_dir>/<slug> fallback."""
    wt = target.get("worktree") or {}
    if wt.get("dir"):
        return wt["dir"]
    base = (config.get("worktree_dir") or "/tmp").rstrip("/")
    return f"{base}/{_worktree_slug(target)}"


def build_start_config(config, target_id, overrides=None):
    """Assemble the launch config `build_odoo_cmd` consumes from the stored config, a
    target id, and optional `overrides` ({other_args?, test_tags?, install?, upgrade?}).
    This is the one server-side builder the thin launch endpoints resolve
    `{target, overrides}` to — the Python home of the retired frontend
    buildStartConfig/buildWorktreeStartConfig. A worktree target points its repos +
    server_path at its on-disk copies (so build_odoo_cmd cd's into the worktree's
    community and runs its odoo-bin). Returns None if the target id isn't in the config.
    The checkout branches aren't applied here — they're checked out separately."""
    target = next((t for t in (config.get("targets") or []) if t.get("id") == target_id), None)
    if not target:
        return None
    overrides = overrides or {}
    start_cfg = config.get("start") or {}
    repo_ids = [c["repo"] for c in (target.get("checkouts") or []) if c.get("repo")]
    start = {
        "repos": repo_ids,
        "db": target.get("db"),
        "on_create_args": target.get("on_create_args") or "",
        "other_args": overrides.get("other_args", start_cfg.get("other_args", "")),
        "demo_data": target.get("demo_data", True),
    }
    for key in ("test_tags", "install", "upgrade"):
        if overrides.get(key):
            start[key] = overrides[key]
    cfg = {**config, "target": target["id"], "start": start}
    is_worktree = (
        target.get("kind") or ("worktree" if target.get("worktree") else "plain")
    ) == "worktree"
    if is_worktree:
        d = _worktree_dir(config, target)
        github = {
            r["id"]: r.get("github", "")
            for r in config.get("repos", [])
            if isinstance(r, dict) and r.get("id")
        }
        # point repos at the worktree's on-disk copies; build_odoo_cmd derives the
        # community path (and thus the addons-path + odoo-bin) from these
        cfg["repos"] = [
            {"id": rid, "path": f"{d}/{rid}", "github": github.get(rid, "")} for rid in repo_ids
        ]
        cfg["server_path"] = f"{d}/community/odoo-bin"
    return cfg
