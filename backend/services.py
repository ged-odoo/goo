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
import shlex
import shutil
import subprocess
import tempfile
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
        self._login = None

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

    def prs_for_branches(self, pairs, refresh=False):
        """For each {github, branch}: the PR whose head is that branch, regardless
        of author, so forward-port / colleagues' PRs resolve too (the authored
        `prs()` fetch misses them). Returns a flat list of PullRequest dicts
        (`relation="head"`), one per branch that has a matching PR. Cached per
        (github, branch); refresh=True bypasses it."""
        seen, uniq = set(), []
        for p in pairs:
            gh_repo, branch = p.get("github"), p.get("branch")
            if not (gh_repo and branch) or (gh_repo, branch) in seen:
                continue
            seen.add((gh_repo, branch))
            uniq.append((gh_repo, branch))
        if not uniq:
            return []
        if refresh:
            for gh_repo, branch in uniq:
                self.cache.invalidate(("head", gh_repo, branch))
        with ThreadPoolExecutor(max_workers=min(8, len(uniq))) as pool:
            results = pool.map(
                lambda gb: self.cache.get(
                    ("head", gb[0], gb[1]), lambda gb=gb: self._fetch_head(*gb)
                ),
                uniq,
            )
        return [pr for pr in results if pr]

    def _fetch_head(self, gh_repo, branch):
        """The best PR whose head ref is `branch` (open preferred, else most recently
        updated), or None. Returns a PullRequest dict, cached by the caller."""
        self.io.log_request(f"gh pr list --repo {gh_repo} --head {branch}")
        try:
            r = self.io.run(
                [
                    "gh",
                    "pr",
                    "list",
                    "--repo",
                    gh_repo,
                    "--head",
                    branch,
                    "--state",
                    "all",
                    "--limit",
                    "10",
                    "--json",
                    "number,title,url,state,isDraft,headRefName,createdAt,updatedAt,statusCheckRollup",
                ],
                timeout=30,
            )
            if r.returncode != 0:
                return None
            rows = json.loads(r.stdout)
        except (FileNotFoundError, subprocess.TimeoutExpired, json.JSONDecodeError):
            return None
        if not rows:
            return None
        # an open PR is the live one; otherwise the most recently touched
        rows.sort(key=lambda pr: (pr.get("state") == "OPEN", pr.get("updatedAt", "")), reverse=True)
        pr = rows[0]
        return asdict(
            PullRequest(
                github=gh_repo,
                number=pr.get("number"),
                title=pr.get("title", ""),
                url=pr.get("url", ""),
                state=(pr.get("state") or "").lower(),
                branch=pr.get("headRefName", ""),
                relation="head",
                draft=pr.get("isDraft", False),
                created_at=pr.get("createdAt", ""),
                updated_at=pr.get("updatedAt", ""),
                ci=_ci_rollup(pr.get("statusCheckRollup")),
            )
        )

    def pr_infos(self, pairs, refresh=False):
        """Full PR info (title, url, state, ci, ...) for explicit {github, number}
        pairs — e.g. a user-curated watchlist, regardless of author. Cached per
        (github, number); refresh=True bypasses it. Returns a list of PullRequest
        dicts (relation="tracked"), skipping pairs `gh` couldn't resolve."""
        uniq = self._uniq_pairs(pairs)
        if not uniq:
            return []
        if refresh:
            for gh_repo, number in uniq:
                self.cache.invalidate(("info", gh_repo, number))
        with ThreadPoolExecutor(max_workers=min(8, len(uniq))) as pool:
            results = pool.map(
                lambda gn: self.cache.get(
                    ("info", gn[0], gn[1]), lambda gn=gn: self._fetch_info(*gn)
                ),
                uniq,
            )
        return [pr for pr in results if pr]

    def _fetch_info(self, gh_repo, number):
        """A single PR's full info by number, regardless of author. Returns a
        PullRequest dict, or None if `gh` couldn't resolve it."""
        self.io.log_request(f"gh pr view {number} --repo {gh_repo}")
        try:
            r = self.io.run(
                [
                    "gh",
                    "pr",
                    "view",
                    str(number),
                    "--repo",
                    gh_repo,
                    "--json",
                    "number,title,url,state,isDraft,headRefName,createdAt,updatedAt,statusCheckRollup",
                ],
                timeout=30,
            )
            if r.returncode != 0:
                return None
            pr = json.loads(r.stdout)
        except (FileNotFoundError, subprocess.TimeoutExpired, json.JSONDecodeError):
            return None
        return asdict(
            PullRequest(
                github=gh_repo,
                number=pr.get("number"),
                title=pr.get("title", ""),
                url=pr.get("url", ""),
                state=(pr.get("state") or "").lower(),
                branch=pr.get("headRefName", ""),
                relation="tracked",
                draft=pr.get("isDraft", False),
                created_at=pr.get("createdAt", ""),
                updated_at=pr.get("updatedAt", ""),
                ci=_ci_rollup(pr.get("statusCheckRollup")),
            )
        )

    def review_statuses(self, pairs, refresh=False):
        """For each {github, number}: "reviewed" if the authenticated user has
        submitted a review on it and isn't currently in the pending
        review-request list (i.e. hasn't been re-asked since), else
        "to_review". Who r+'d it doesn't matter here — that's mergebot's own
        state, not this. Cached per (github, number); refresh=True bypasses it.
        Returns {"github#number": status}."""
        uniq = self._uniq_pairs(pairs)
        if not uniq:
            return {}
        if refresh:
            for gh_repo, number in uniq:
                self.cache.invalidate(("review", gh_repo, number))
        with ThreadPoolExecutor(max_workers=min(8, len(uniq))) as pool:
            statuses = pool.map(
                lambda gn: self.cache.get(
                    ("review", gn[0], gn[1]), lambda gn=gn: self._fetch_review_status(*gn)
                ),
                uniq,
            )
        return {
            f"{gh_repo}#{number}": s for (gh_repo, number), s in zip(uniq, statuses, strict=True)
        }

    def _fetch_review_status(self, gh_repo, number):
        """ "reviewed" if the authenticated user has submitted a review (any state
        — Odoo reviewers mostly leave plain "Comment" reviews, never GitHub's
        formal Approve/Request-changes) more recently than the last time they
        were (re-)requested, else "to_review". Comparing timestamps — not
        GitHub's "current reviewRequests" list — matters here: GitHub only
        drops a user from that list on an Approve/Request-changes review, so
        for a Comment-only review it stays there forever and would otherwise
        always look "still requested"."""
        login = self._me()
        if not login:
            return "to_review"
        self.io.log_request(f"gh pr view {number} --repo {gh_repo} --json reviews")
        try:
            r = self.io.run(
                ["gh", "pr", "view", str(number), "--repo", gh_repo, "--json", "reviews"],
                timeout=30,
            )
            if r.returncode != 0:
                return "to_review"
            data = json.loads(r.stdout)
        except (FileNotFoundError, subprocess.TimeoutExpired, json.JSONDecodeError):
            return "to_review"
        my_reviews = [
            rev.get("submittedAt") or ""
            for rev in data.get("reviews") or []
            if (rev.get("author") or {}).get("login") == login
        ]
        if not my_reviews:
            return "to_review"
        last_review_at = max(my_reviews)
        last_request_at = self._last_review_request(gh_repo, number, login)
        return "to_review" if last_request_at > last_review_at else "reviewed"

    def _last_review_request(self, gh_repo, number, login):
        """The most recent time `login` was requested to review this PR (ISO
        timestamp, "" if never/unknown) — from the issue timeline, since a
        PR's current `reviewRequests` doesn't carry timing and (per above)
        often doesn't clear at all. Never raises; "" on any failure just means
        "no re-request found", the safe default (favors "reviewed")."""
        self.io.log_request(f"gh api repos/{gh_repo}/issues/{number}/timeline --paginate")
        try:
            r = self.io.run(
                [
                    "gh",
                    "api",
                    f"repos/{gh_repo}/issues/{number}/timeline",
                    "--paginate",
                    "--jq",
                    '.[] | select(.event=="review_requested") '
                    '| {login: (.requested_reviewer.login // ""), at: .created_at}',
                ],
                timeout=30,
            )
            if r.returncode != 0:
                return ""
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return ""
        at_times = []
        for line in r.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if obj.get("login") == login and obj.get("at"):
                at_times.append(obj["at"])
        return max(at_times) if at_times else ""

    def _me(self):
        """The authenticated `gh` user's login, cached for the service's lifetime."""
        if self._login is None:
            self.io.log_request("gh api user --jq .login")
            try:
                r = self.io.run(["gh", "api", "user", "--jq", ".login"], timeout=15)
                self._login = r.stdout.strip() if r.returncode == 0 else ""
            except (FileNotFoundError, subprocess.TimeoutExpired):
                self._login = ""
        return self._login

    @staticmethod
    def _uniq_pairs(pairs):
        seen, uniq = set(), []
        for p in pairs:
            gh_repo, number = p.get("github"), p.get("number")
            if not (gh_repo and number) or (gh_repo, number) in seen:
                continue
            seen.add((gh_repo, number))
            uniq.append((gh_repo, number))
        return uniq

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

    def ready_pr(self, github, number):
        """Mark a draft GitHub PR ready for review. Returns (ok, error);
        invalidates the PR cache on success so the next fetch reflects it."""
        self.io.log_request(f"gh pr ready {number} --repo {github}")
        try:
            r = self.io.run(["gh", "pr", "ready", str(number), "--repo", github], timeout=30)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e)
        if r.returncode != 0:
            return False, r.stderr.strip().split("\n")[0] or "gh pr ready failed"
        self.cache.invalidate()
        return True, None

    def post_r_plus(self, github, number):
        """Post the mergebot approval command on a GitHub PR via ``gh``."""
        self.io.log_request(f"gh pr comment {number} --repo {github} --body 'robodoo r+'")
        try:
            r = self.io.run(
                [
                    "gh",
                    "pr",
                    "comment",
                    str(number),
                    "--repo",
                    github,
                    "--body",
                    "robodoo r+",
                ],
                timeout=30,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e)
        if r.returncode != 0:
            return False, r.stderr.strip().split("\n")[0] or "gh pr comment failed"
        self.cache.invalidate()
        return True, None

    def pr_head(self, github, number):
        """The head branch ref of a PR by number. Used for forward-port sub-workspaces:
        the mergebot matrix only exposes the target branch (e.g. "master"), while the
        forward-port PR's actual head is fw-bot's `master-<src>-<n>-fw` on odoo-dev.
        Returns (branch, error)."""
        self.io.log_request(f"gh pr view {number} --repo {github} --json headRefName")
        try:
            r = self.io.run(
                ["gh", "pr", "view", str(number), "--repo", github, "--json", "headRefName"],
                timeout=30,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return "", str(e)
        if r.returncode != 0:
            return "", r.stderr.strip().split("\n")[0] or "gh pr view failed"
        try:
            data = json.loads(r.stdout or "{}")
        except ValueError as e:
            return "", str(e)
        return data.get("headRefName", ""), None

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

    def bundle_info(self, url):
        """The bundle a pasted runbot URL names: (info, error) with info =
        {name, branches, prs}. `name` is the bundle (= branch) name from the
        page title; `branches` lists the github repos carrying the branch (the
        page's `tree` links — dev forks for colleagues' work); `prs` the pull
        requests the bundle shows. Accepts canonical (/runbot/bundle/<id>) and
        name URLs — same 302-follow / 301-misresolve rules as _status."""
        m = re.match(r"https?://runbot\.odoo\.com(/runbot/bundle/[^\s?#]+)", (url or "").strip())
        if not m:
            return None, "not a runbot bundle URL (https://runbot.odoo.com/runbot/bundle/…)"
        status, location, html, _ = self.io.http_get_nofollow(RUNBOT_BASE + m.group(1))
        if status == 302:  # name URL → the canonical bundle page
            html, _ = self.io.http_get(urllib.parse.urljoin(RUNBOT_BASE, location))
        elif status != 200:  # 301 (id-misresolve), 404, or error
            return None, f"no such bundle (HTTP {status or 'unreachable'})"
        if not html:
            return None, "could not read the bundle page"
        tm = re.search(r"<title>\s*Bundle\s+([^<]+?)\s*</title>", html)
        if not tm:
            return None, "that page is not a runbot bundle"
        branches, prs, seen = [], [], set()
        for github, branch in re.findall(r'github\.com/([\w.-]+/[\w.-]+)/tree/([^"\s<>]+)', html):
            if ("t", github, branch) not in seen:
                seen.add(("t", github, branch))
                branches.append({"github": github, "branch": branch})
        for github, number in re.findall(r"github\.com/([\w.-]+/[\w.-]+)/pull/(\d+)", html):
            if ("p", github, number) not in seen:
                seen.add(("p", github, number))
                prs.append({"github": github, "number": int(number)})
        return {"name": tm.group(1), "branches": branches, "prs": prs}, None

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
        """Return ({"github#number": state}, {"github#number": detail},
        {"github#number": forward-port matrix}, [unsupported repos]) for the given
        PRs, cached per PR and fetched in parallel. Pass refresh=True to bypass the
        cache. `detail` (omitted when empty) lists the unmet merge requirements behind
        a blocked state, e.g. "Review, CI". Forward-port rows only contain branches
        after the requested PR's target branch; empty cells are retained so the UI can
        show branches which are still waiting for fw-bot.

        A repo is reported "unsupported" when, in this batch, at least one of its PRs
        404s (no mergebot page) and none of its PRs is reachable — so the caller can
        remember it and stop asking. A repo with one un-indexed 404 but another
        reachable PR is NOT unsupported (its reachable PR clears it)."""
        prs = [p for p in prs if p.get("github") and p.get("number")]
        if not prs:
            return {}, {}, {}, []
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
        states, details, forward_ports, reachable, missing = {}, {}, {}, set(), set()
        for p, (state, detail, ports, supported) in zip(prs, results, strict=False):
            key = f"{p['github']}#{p['number']}"
            states[key] = state
            if detail:
                details[key] = detail
            if supported:
                # An empty list is meaningful: the page was parsed, but this PR has
                # no subsequent branches. It also distinguishes a fetched merged PR
                # from a client-side persisted "merged" seed.
                forward_ports[key] = ports
            if supported is None:
                # transient failure — don't pin a blank for the whole TTL
                self.cache.invalidate(key)
            elif supported:
                reachable.add(p["github"])
            else:
                # 404 — the repo may genuinely not be on mergebot, OR the PR is just
                # too fresh to be indexed (a new PR appears within minutes). Report it
                # for this batch's unsupported bookkeeping, but drop the cache entry:
                # pinning the blank for the full TTL (8h) would hide the real state
                # long after mergebot picks the PR up. Callers dedup per session, so
                # the re-asks stay cheap.
                self.cache.invalidate(key)
                missing.add(p["github"])
        unsupported = sorted(missing - reachable)
        return states, details, forward_ports, unsupported

    def _status(self, github, number):
        """(merge state, detail, forward ports, supported).

        `supported` is False on a 404 and None on a transient failure. State is
        rendered inconsistently (a colored <p> for blocked/staged/ready/…, an alert
        <div> for merged/closed), so scan for the first colored element whose leading
        word is known. The same page's table is the authoritative forward-port chain.
        """
        html, err = self.io.http_get(f"{MERGEBOT_BASE}/{github}/pull/{number}")
        if err:
            return "", "", [], (False if "404" in err else None)
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
        return state, self._blocked_reasons(html), self._forward_ports(html, github, number), True

    @staticmethod
    def _html_text(fragment):
        text = re.sub(r"<[^>]+>", " ", fragment)
        return re.sub(r"\s+", " ", html_lib.unescape(text)).strip()

    @staticmethod
    def _html_attr(attrs, name):
        match = re.search(rf"\b{re.escape(name)}\s*=\s*(?:\"([^\"]*)\"|'([^']*)')", attrs, re.I)
        return (
            (match.group(1) if match and match.group(1) is not None else match.group(2))
            if match
            else ""
        )

    def _forward_ports(self, html, github, number):
        """Parse the forward-port matrix below a PR and return subsequent rows.

        Each row keeps one cell per repository because linked community/enterprise
        chains can progress independently. A cell can contain multiple PRs (conflict
        resolutions sometimes create siblings), hence the nested ``pulls`` list.
        """
        table = re.search(
            r'<table\b[^>]*class="[^"]*\btable-bordered\b[^"]*"[^>]*>(.*?)</table>',
            html,
            re.S | re.I,
        )
        if not table:
            return []
        table_html = table.group(1)
        head = re.search(r"<thead\b[^>]*>(.*?)</thead>", table_html, re.S | re.I)
        if not head:
            return []
        repositories = [
            self._html_text(body)
            for _, body in re.findall(r"<th\b([^>]*)>(.*?)</th>", head.group(1), re.S | re.I)
        ][1:]
        repositories = [repo for repo in repositories if re.fullmatch(r"[^/\s]+/[^/\s]+", repo)]
        if not repositories:
            return []

        body = re.search(r"<tbody\b[^>]*>(.*?)</tbody>", table_html, re.S | re.I)
        if not body:
            return []
        rows = []
        target_index = None
        wanted_number = int(number)
        for _row_attrs, row_html in re.findall(
            r"<tr\b([^>]*)>(.*?)</tr>", body.group(1), re.S | re.I
        ):
            raw_cells = re.findall(r"<td\b([^>]*)>(.*?)</td>", row_html, re.S | re.I)
            if not raw_cells:
                continue
            branch = self._html_text(raw_cells[0][1])
            if not branch:
                continue
            cells = []
            contains_requested = False
            for repository, (cell_attrs, cell_html) in zip(
                repositories, raw_cells[1:], strict=False
            ):
                cell_classes = self._html_attr(cell_attrs, "class").split()
                pulls = []
                for span_attrs, span_html in re.findall(
                    r"<span\b([^>]*)>(.*?)</span>", cell_html, re.S | re.I
                ):
                    title = self._html_attr(span_attrs, "title")
                    details = [
                        self._html_text(sup)
                        for sup in re.findall(r"<sup\b[^>]*>(.*?)</sup>", span_html, re.S | re.I)
                    ]
                    detail = ", ".join(part for part in details if part)
                    for slug, pull_number in re.findall(
                        r'href=["\']/([^"\']+?/[^"\']+?)/pull/(\d+)["\']', span_html, re.I
                    ):
                        pull_number = int(pull_number)
                        category = "pending"
                        if "table-success" in cell_classes:
                            category = "success"
                        elif "table-warning" in cell_classes:
                            category = "warning"
                        elif "table-danger" in cell_classes:
                            category = "danger"
                        pulls.append(
                            {
                                "github": slug,
                                "number": pull_number,
                                "status": title or "pending",
                                "detail": detail,
                                "category": category,
                            }
                        )
                        if slug == github and pull_number == wanted_number:
                            contains_requested = True
                cells.append({"repository": repository, "pulls": pulls})
            rows.append({"branch": branch, "cells": cells})
            if contains_requested:
                target_index = len(rows) - 1

        if target_index is None:
            return []
        # The target row itself is already represented by the workspace checkout.
        return rows[target_index + 1 :]

    def _blocked_reasons(self, html):
        """The unmet merge requirements from the page's `todo` checklist: the labels
        of the top-level <li> items not marked satisfied (class 'ok'), joined like
        "Review, CI". Nested per-CI-check items begin with an <a>, so their empty
        leading text excludes them. Returns '' when nothing is unmet / no checklist."""
        start = re.search(r'<ul\b[^>]*class="[^"]*\btodo\b[^"]*"[^>]*>', html, re.I)
        if not start:
            return ""
        depth = 1
        end = len(html)
        for tag in re.finditer(r"</?ul\b[^>]*>", html[start.end() :], re.I):
            depth += -1 if tag.group(0).lower().startswith("</") else 1
            if depth == 0:
                end = start.end() + tag.start()
                break
        checklist = html[start.end() : end]
        reasons = []
        for m in re.finditer(r'<li(?:[^>]*\bclass="([^"]*)")?[^>]*>([^<]*)', checklist):
            label = re.sub(r"\s+", " ", m.group(2)).strip()
            if not label or "ok" in (m.group(1) or "").split():
                continue
            reasons.append(label)
        return ", ".join(reasons)[:200]


# ─────────────────────────── CI dashboard (mergebot stagings) ───────────────

# staging row colour → outcome. bg-info is in-progress (not a terminal state).
_STAGING_STATE = {
    "bg-success": "merged",
    "bg-danger": "failed",
    "bg-gray-lighter": "killed",
    "bg-info": "pending",
}
_STAGING_ROW_RE = re.compile(r'<tr\b[^>]*class="\s*(bg-[a-z-]+)\s*"[^>]*>(.*?)</tr>', re.S)
_STAGED_AT_RE = re.compile(r"Staged at (\d{4}-\d{2}-\d{2}) [\d:]+Z")
_PR_RE = re.compile(r"github\.com/([^/\s\"']+/[^/\s\"']+)/pull/(\d+)")
# the "Next >" link back in time: /runbot_merge/1?until=<datetime>&state=
_NEXT_UNTIL_RE = re.compile(r'href="/runbot_merge/\d+\?until=([^&"]*)&(?:amp;)?state=')


class CiService:
    """Per-day merge-queue stats scraped from the mergebot stagings page
    (mergebot.odoo.com/runbot_merge/<branch>, master = 1).

    Each colour-coded staging row is one "batch": bg-success = merged,
    bg-danger = failed, bg-gray-lighter = killed, bg-info = in-progress. Days are
    the UTC staged date. A completed day (before today UTC) is immutable, so once
    fully scanned its stats are persisted to disk and never re-fetched; only today
    (and any gap not yet cached) is fetched live."""

    MAX_PAGES = 40  # ~1 day/page — a hard stop so a parse miss can't loop forever

    def __init__(self, io, cache_path, branch=1):
        self.io = io
        self.cache_path = cache_path
        self.branch = branch

    # ── on-disk cache of immutable completed days ─────────────────────────────
    # {"oldest_complete": "YYYY-MM-DD" | None, "days": {"YYYY-MM-DD": {...}}}
    def _load_cache(self):
        data, _ = self.io.read_json_file(self.cache_path)
        if not isinstance(data, dict):
            return {"oldest_complete": None, "days": {}}
        data.setdefault("days", {})
        data.setdefault("oldest_complete", None)
        return data

    def _save_cache(self, cache):
        self.io.write_json_file(self.cache_path, cache)

    def _fetch_page(self, until):
        url = f"{MERGEBOT_BASE}/runbot_merge/{self.branch}"
        if until:
            url += f"?until={urllib.parse.quote(until)}&state="
        return self.io.http_get(url, timeout=30)

    @staticmethod
    def _blank_day(d):
        return {
            "date": d,
            "batches": 0,
            "merged": 0,
            "failed": 0,
            "killed": 0,
            "pending": 0,
            "prs_merged": 0,
        }

    @classmethod
    def _parse_page(cls, html):
        """Return (rows, next_until). rows = [{date, state, prs}] newest-first."""
        rows = []
        for cls_name, body in _STAGING_ROW_RE.findall(html):
            m = _STAGED_AT_RE.search(body)
            if not m:
                continue
            state = _STAGING_STATE.get(cls_name)
            if not state:
                continue
            prs = {f"{repo}#{num}" for repo, num in _PR_RE.findall(body)}
            rows.append({"date": m.group(1), "state": state, "prs": len(prs)})
        nxt = _NEXT_UNTIL_RE.search(html)
        return rows, (html_lib.unescape(nxt.group(1)) if nxt else None)

    def merge_stats(self, days=14, refresh=False):
        """Per-day stats for the last `days` days (today back), newest-first.

        Walks the stagings pages back in time, folding each row into its UTC day.
        Completed days already on disk are reused; only today (or an uncached gap)
        is fetched. Returns a list of day dicts."""
        today = datetime.now(timezone.utc).date()
        cutoff = today - timedelta(days=days - 1)
        cache = self._load_cache()
        if refresh:
            cache = {"oldest_complete": None, "days": {}}
        cached_days = cache["days"]
        oldest_complete = cache.get("oldest_complete")

        # if every completed day in the window is already cached, we only need to
        # rescan today; otherwise scan the whole window down to the cutoff.
        have_window = (
            not refresh and oldest_complete is not None and oldest_complete <= cutoff.isoformat()
        )
        target = today if have_window else cutoff  # stop once a row predates this

        fresh = {}  # date -> aggregated counters, from this run's live scan
        oldest_seen = None
        exhausted = False  # reached the end of mergebot's history (no "Next >")
        until = None
        for _ in range(self.MAX_PAGES):
            html, err = self._fetch_page(until)
            if err or not html:
                break
            rows, until = self._parse_page(html)
            if not rows:
                break
            for row in rows:
                d = row["date"]
                agg = fresh.setdefault(d, self._blank_day(d))
                agg["batches"] += 1
                agg[row["state"]] += 1
                if row["state"] == "merged":
                    agg["prs_merged"] += row["prs"]
            oldest_seen = rows[-1]["date"]
            if until is None:
                exhausted = True
                break
            if oldest_seen < target.isoformat():
                break

        # A freshly scanned day is complete once we've read past it — i.e. seen a
        # row strictly older (so no more of that day can be on a later page), or hit
        # the end of history. Persist the complete days that are before today (today
        # is always volatile), and advance the "everything from here to today is
        # covered" marker so the next call can skip them.
        today_iso = today.isoformat()

        def complete(d):
            return d < today_iso and (exhausted or (oldest_seen is not None and d > oldest_seen))

        for d, agg in fresh.items():
            if complete(d):
                cached_days[d] = agg
        complete_days = [d for d in fresh if complete(d)]
        if complete_days:
            oldest_complete = (
                min(complete_days)
                if oldest_complete is None
                else min(oldest_complete, min(complete_days))
            )
        cache["oldest_complete"] = oldest_complete
        self._save_cache(cache)

        # assemble the window, newest first: today (and partial days) from the live
        # scan, completed days from cache, missing days as zeros.
        out = []
        d = today
        while d >= cutoff:
            iso = d.isoformat()
            if iso == today_iso:
                out.append(fresh.get(iso) or self._blank_day(iso))
            else:
                out.append(cached_days.get(iso) or fresh.get(iso) or self._blank_day(iso))
            d -= timedelta(days=1)
        return out

    def queue(self):
        """The current 'Awaiting' queue size for this branch — batches approved but
        not yet staged — scraped from the root runbot_merge dashboard. Volatile (the
        queue drains constantly), so uncached. Returns the PR count, or None if the
        page can't be read."""
        html, err = self.io.http_get(f"{MERGEBOT_BASE}/runbot_merge", timeout=30)
        if err or not html:
            return None
        # isolate this branch's block: its <h2><a href="/runbot_merge/<id>"> heading
        # up to the next branch/project heading
        start = html.find(f'href="/runbot_merge/{self.branch}"')
        if start == -1:
            return None
        rest = html[start:]
        nxt = re.search(r'href="/runbot_merge/\d+"', rest[1:])
        block = rest[: nxt.start() + 1] if nxt else rest
        # the Awaiting section is class="pr-listing pr-awaiting" (the Splits section is
        # "splits pr-awaiting"); count the PR links up to the next sibling <div>
        aw = re.search(r'class="[^"]*\bpr-listing pr-awaiting\b[^"]*"', block)
        if not aw:
            return 0
        seg = block[aw.end() :]
        end = seg.find("<div")
        if end != -1:
            seg = seg[:end]
        return len(re.findall(r"/pull/\d+", seg))


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
    # step names whose log offers [MEMINFO] lines — checked in this order, first
    # match wins, so a build offering both takes the dedicated qunit-only run
    _MEMINFO_STEP_NAMES = ("start_qunit_only", "test_only_no_limit_no_autotags")

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
        """[{"label", "url"}] of raw step-log URLs (one of `_MEMINFO_STEP_NAMES`)
        for builds offering one of those steps on a runbot batch/build page —
        used by the Memory panel to bulk-import builds from a batch
        (MemoryService.fetch parses [MEMINFO] lines out of the raw log text,
        not a build's HTML page). The action dropdown itself is built
        client-side by runbot's JS from a <build-options-dropdown data-id
        data-log_list data-dest data-log_url> element, so we read those data
        attributes and construct the log URL directly rather than the
        (JS-rendered, never-present-in-the-fetched-HTML) <a> links. Runbot
        dropped the once-present `data-log_url` attribute, so the log host
        is now built from `data-host` instead. Not cached: a one-off user
        action, not a periodic poll."""
        if url.startswith("/"):
            url = f"{RUNBOT_BASE}{url}"
        html = self._fetch_html(url)
        if not html:
            return []
        builds, seen = [], set()
        for m in re.finditer(r"<build-options-dropdown\b([^>]*)>", html):
            attrs = m.group(1)
            log_list_m = re.search(r'data-log_list="([^"]*)"', attrs)
            if not log_list_m:
                continue
            log_list = html_lib.unescape(log_list_m.group(1))
            step = next((s for s in self._MEMINFO_STEP_NAMES if s in log_list), None)
            if not step:
                continue
            id_m = re.search(r'data-id="(\d+)"', attrs)
            dest_m = re.search(r'data-dest="([^"]*)"', attrs)
            host_m = re.search(r'data-host="([^"]*)"', attrs)
            if not id_m or not dest_m or not host_m:
                continue
            build_id = id_m.group(1)
            if build_id in seen:
                continue
            seen.add(build_id)
            log_url = f"https://{html_lib.unescape(host_m.group(1))}"
            dest = html_lib.unescape(dest_m.group(1))
            builds.append(
                {
                    "label": build_id,
                    "url": f"{log_url}/runbot/static/build/{dest}/logs/{step}.txt",
                }
            )
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
        build — for a list of {"label", "url"} builds fetched in parallel, or
        {"label", "content"} builds (a log uploaded from disk) parsed directly."""
        to_fetch = [b for b in builds if b.get("url") and not b.get("content")]

        def fetch_one(build):
            html, err = self.io.http_get(build["url"], timeout=60)
            return build.get("label", ""), ([] if err else self.parse_log(html))

        per_build = {}
        if to_fetch:
            with ThreadPoolExecutor(max_workers=min(16, len(to_fetch))) as pool:
                per_build = dict(pool.map(fetch_one, to_fetch))
        for b in builds:
            if b.get("content"):
                per_build[b.get("label", "")] = self.parse_log(b["content"])

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
        list cache. --if-exists: a target's db may never have been created (or was
        already dropped) — that's not a failure, so dropdb shouldn't error on it."""
        try:
            r = self.io.run(["dropdb", "--if-exists", name], timeout=15)
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


# the vendored owl.js bundle exports a literal `version = "X.Y.Z"` plus an
# `__info__ = {..., hash: "<short sha>"}` — used to pin the odoo-frontend-owl skill's
# doc links to the Owl build actually checked out (see GitService._resolve_owl_docs).
_OWL_VERSION_RE = re.compile(r'version = "(\d+)\.[^"]*"')
_OWL_HASH_RE = re.compile(r'hash:\s*"([0-9a-f]+)"')


def is_base_branch(name):
    """Whether <name> IS a base branch (exact match — master-foo is a work branch)."""
    return bool(_BASE_BRANCH_RE.fullmatch(name or ""))


_GITHUB_REMOTE_RE = re.compile(r"github\.com[:/]+([^/]+)/(.+?)(?:\.git)?/?$")


def parse_github_slug(url):
    """The "owner/repo" GitHub slug a remote URL points to (SSH, HTTPS, or
    ssh:// forms), or None if it's not a github.com URL. A repo's push remote
    can be a fork under a different owner — and even a differently-renamed
    repo — than its `github` (upstream) slug, so this is resolved from the
    remote's actual URL rather than assumed."""
    m = _GITHUB_REMOTE_RE.search(url or "")
    return f"{m.group(1)}/{m.group(2)}" if m else None


class GitService:
    """Local git operations on the user's repos, over the IO seam. Branch reads are
    volatile (dirty / current-branch state) and fast, so they're not cached — callers
    fetch fresh each time. `notify` (optional) reports progress events (the fetch /
    rebase phases) — wired to the event bus in production, a no-op in tests."""

    def __init__(self, io, notify=None):
        self.io = io
        self.notify = notify or (lambda *a, **k: None)

    def _git(self, path, *args, timeout=30, err="git failed", quiet=False, tail=False):
        """Run one git command in <path> (expanduser'd). Returns (result, error):
        error is None on success, else the first stderr line (or <err> when git
        was silent), or the FileNotFoundError/TimeoutExpired message — the shared
        failure envelope every simple mutation used to hand-roll. `tail` reports
        the LAST stderr line instead (push errors put the useful hint there).
        On a nonzero exit the result is still returned so callers can inspect
        the raw stderr (e.g. delete_branch's "remote ref does not exist")."""
        try:
            r = self.io.run(
                ["git", "-C", os.path.expanduser(path), *args], timeout=timeout, quiet=quiet
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return None, str(e)
        if r.returncode != 0:
            lines = r.stderr.strip().split("\n")
            return r, (lines[-1] if tail else lines[0]) or err
        return r, None

    def current_branch(self, path):
        """The branch currently checked out at <path> ("" if detached/unreadable).
        A lightweight single-subprocess alternative to branches() for callers that
        only need the current branch name (e.g. the headless Claude chat, which
        needs it on every fresh conversation and shouldn't pay for the full
        dirty/ahead-behind/remote-refs read)."""
        r, error = self._git(path, "branch", "--show-current", timeout=10)
        return "" if error else (r.stdout or "").strip()

    def branches(self, repos):
        """For each repo {id, path}: the checked-out branch and all local branches
        with their last-commit date, plus dirty / pushed / ahead-behind state and
        the push remote's resolved "owner/repo" (push_github, None if the remote
        is missing/unparseable). Each repo's git reads (~8 subprocesses) are
        independent, so repos are read in parallel — keeping a multi-repo target's
        refresh snappy."""
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
                "push_github": None,  # "owner/repo" the push remote's URL actually points to
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
                # the push remote's actual fork owner/repo — a repo's fork can live
                # under a different GitHub owner (or even a renamed repo) than its
                # upstream `github` slug, and that can vary independently per repo
                # (e.g. one repo forked under a personal username, another under a
                # team org), so it's resolved from the remote itself, not assumed
                push_remote = repo.get("push_remote") or "dev"
                pu = self.io.run(
                    ["git", "-C", path, "remote", "get-url", push_remote], timeout=10, quiet=True
                )
                if pu.returncode == 0:
                    entry["push_github"] = parse_github_slug(pu.stdout.strip())
                # HEAD's sha + last commit subject + date (for the branch summaries)
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
                ref = f"{repo.get('pull_remote') or 'origin'}/{base}"
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
        label = repo or os.path.basename(os.path.expanduser(path))
        eid = uuid.uuid4().hex
        checking = f"checking out {branch} ({label})"
        self.notify(checking, event_id=eid, status="start")
        _, error = self._git(path, "checkout", branch, timeout=60, err="git checkout failed")
        self.notify(checking, event_id=eid, status="error" if error else "done")
        return error is None, error

    def fresh_start_point(self, path, branch, pull_remote="origin", repo=""):
        """Resolve a workspace branch's start point. If the configured pull remote
        has <branch>, fetch it and return FETCH_HEAD so branch/worktree creation
        starts from the freshly fetched commit. If the branch is local-only, return
        its local name unchanged. A remote lookup/fetch error is not silently treated
        as local-only: doing so could create a workspace from stale local state."""
        if not path or not branch:
            return None, "missing path or start point"
        p = os.path.expanduser(path)
        remote = pull_remote or "origin"
        label = repo or os.path.basename(p)
        self.io.log_request(f"git ls-remote {remote} {branch}  (workspace base {label})")
        try:
            exists = self.io.run(
                ["git", "-C", p, "ls-remote", "--exit-code", "--heads", remote, branch],
                timeout=30,
                quiet=True,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return None, str(e)
        # --exit-code uses 2 for a successful query with no matching refs: this is
        # the expected local-only branch case.
        if exists.returncode == 2 or (exists.returncode == 0 and not exists.stdout.strip()):
            return branch, None
        if exists.returncode != 0:
            return None, (exists.stderr.strip() or "remote branch lookup failed").split("\n")[0]

        eid = uuid.uuid4().hex
        fetching = f"fetching {branch} ({label})"
        self.notify(fetching, event_id=eid, status="start")
        _, error = self._git(p, "fetch", remote, branch, timeout=180, err="git fetch failed")
        self.notify(fetching, event_id=eid, status="error" if error else "done")
        return (None, error) if error else ("FETCH_HEAD", None)

    def worktree_add(
        self,
        main_path,
        worktree_path,
        branch,
        repo="",
        new_branch=False,
        start_point=None,
        fresh_start=False,
        pull_remote="origin",
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
        if new_branch and fresh_start:
            start_point, error = self.fresh_start_point(p, start_point, pull_remote, repo)
            if error:
                return False, error
        wp = os.path.expanduser(worktree_path)
        label = repo or os.path.basename(p)
        eid = uuid.uuid4().hex
        creating = f"creating worktree {branch} ({label})"
        self.notify(creating, event_id=eid, status="start")
        if new_branch:
            args = ["worktree", "add", "-b", branch, wp, start_point]
        else:
            args = ["worktree", "add", wp, branch]
        _, error = self._git(p, *args, timeout=120, err="git worktree add failed")
        self.notify(creating, event_id=eid, status="error" if error else "done")
        return error is None, error

    def create_worktree_claude_md(
        self, worktree_parent, branch, has_enterprise, documentation_path=None, owl_path=None
    ):
        """Create a .claude/CLAUDE.md file at the worktree's parent dir for Claude Code
        context — outside any git-tracked repo (<worktree_dir>/<slug>/.claude/CLAUDE.md,
        <worktree_dir>/<slug>/{community,enterprise,documentation,owl}/ are its
        siblings). Called once, explicitly, after every repo in the workspace has been
        created (server.py's _api_workspace_create) — so has_enterprise/
        documentation_path/owl_path are known for certain rather than guessed."""
        claude_md_path = os.path.join(worktree_parent, ".claude", "CLAUDE.md")
        if self.io.read_text(claude_md_path) is not None:
            return
        self.io.write_text(
            claude_md_path,
            self._claude_md_content(branch, has_enterprise, documentation_path, owl_path),
        )

    def _claude_md_content(self, branch, has_enterprise, documentation_path=None, owl_path=None):
        repo_lines = [
            "- `community/` — an independent `git worktree` checkout of odoo/odoo, on "
            f"branch **{branch}**. It shares git history/objects with the main checkout "
            "but is its own working tree — commits, checkouts, and file edits here "
            "don't touch the main one.",
        ]
        if has_enterprise:
            repo_lines.append(f"- `enterprise/` — same, for odoo/enterprise, on branch **{branch}**.")
        if documentation_path:
            repo_lines.append(
                f"- `documentation/` — same, for odoo/documentation, forked from "
                f"**{base_branch(branch)}** (not `{branch}` — the doc repo doesn't have "
                "per-feature branches). The skills below read it directly from disk, no "
                "network fetch needed; `git pull --rebase` it here if the docs feel stale."
            )
        if owl_path:
            repo_lines.append(
                f"- `owl/` — same, for odoo/owl, forked from the exact commit vendored at "
                "`community/addons/web/static/lib/owl/owl.js` (odoo/owl's `master` branch "
                "when that exact commit wasn't locally reachable). The frontend skill "
                "reads it directly from disk too."
            )
        repos_section = "\n".join(repo_lines)
        return f"""# Odoo Development Worktree

This worktree is checked out on branch **{branch}**.

## About this worktree

This worktree was created from the main development repository. Use Claude Code here
for development tasks, debugging, refactoring, and code review.

## Repos in this worktree

{repos_section}

## Database

Local Postgres, direct access with `psql <dbname>` (peer auth — no user/password
needed for the standard local dev setup). By convention in this app the database is
named after the branch/workspace (**{branch}**), but it's a free-text field the user
could have changed — check goo's Workspaces screen if unsure, or `psql -l`.

## Running the server / tests

An `odoo.conf` already sits one level up (`../odoo.conf`), generated at creation
with this workspace's real `addons_path` and db role — no need to reconstruct
`--addons-path` by hand. From `community/`:

```bash
./odoo-bin -c ../odoo.conf -d <dbname> --without-demo all
```

Default port is 8069 — add `--http-port <N>` if something else (goo's main server,
another workspace) is already using it.

Run a specific test:

```bash
./odoo-bin -c ../odoo.conf -d <dbname> --test-tags /module_name --dev all --stop-after-init
```

(`--dev all` enables dev features — asset reload/qweb/xml — matching what goo itself
passes for test runs; JS/hoot tests need Chrome on PATH.) If goo is running, its
Workspaces screen's Start button remains the simplest path.

## Key Claude Code skills for Odoo development

Project skills (generated for this worktree, in `.claude/skills/` — version-matched
to branch {branch}):

- **`/odoo-orm`** — models, fields, ORM methods, security, module manifests, mixins,
  HTTP controllers.
- **`/odoo-views`** — view XML (form/list/kanban/search), actions, qweb reports.
- **`/odoo-frontend-owl`** — the JS framework layer (services, registries, hooks,
  assets) and the Owl component framework itself.
- **`/odoo-testing`** — Python tests (TransactionCase/HttpCase/tours) and JS unit
  tests (hoot).

Other useful (user-level) skills:

- **`/run`** — Start the Odoo application to test changes in real-time. Use this before
  submitting PRs to verify the UI works as expected.
- **`/simplify`** — Review and optimize your code changes for reuse and efficiency.
- **`/security-review`** — Complete a security review of pending changes on this branch.
- **`/check-commit`** — Validate commit messages against Odoo Git guidelines before pushing.

## Development workflow

1. **Branch work** — Make your changes in this worktree
2. **Test locally** — Use `/run` to start the app and verify behavior
3. **Code review** — Use `/simplify` and `/security-review` to audit changes
4. **Commit & push** — Use `/check-commit` to ensure your commit message is compliant

## Browser & memory debugging (MCP)

If the `chrome-devtools` and `memlab` MCP servers are configured (`claude mcp list`),
prefer them over guessing at UI/memory behavior from the code alone:

- **`chrome-devtools`** — drive a real Chrome against the running Odoo instance to
  click through the UI, take snapshots/screenshots, and read console/network output.
- **`memlab`** — analyze heap snapshots for memory leaks (pairs with `/leak-check`
  and the `memleak_check` addon).

If `chrome-devtools` fails to connect ("Could not connect to Chrome" / "Target
closed"), it's likely pinned to a fixed `--browserUrl` expecting an
already-running debuggable Chrome, or the sandbox here can't launch Chrome with
its default sandbox. Reconfigure it to launch its own headless browser instead:
`claude mcp remove chrome-devtools -s user`, then `claude mcp add chrome-devtools
-s user -- <command from the old config> --headless --isolated
--chromeArg=--no-sandbox --chromeArg=--disable-setuid-sandbox` (drop any
`--browserUrl`/`--wsEndpoint` arg). Editing the MCP config only takes effect after
Claude Code restarts.

---

*This file was auto-generated. Feel free to edit it.*
"""

    def _resolve_owl_docs(self, community_path):
        """(ref, doc_base_path, major) to fetch odoo/owl docs matching the Owl build
        actually vendored at <community_path>/addons/web/static/lib/owl/owl.js — the
        bundle exports a literal `version = "X.Y.Z..."` plus `__info__.hash` (a short
        commit sha). Tries the exact vendored commit first (perfect API match, no
        drift from an alpha framework's fast-moving master), then odoo/owl's own
        master branch (current doc/v{2,3}/... layout) for the matching major version.
        A canary file fetch decides each candidate: raw.githubusercontent.com 404s
        for a ref/layout that doesn't exist (e.g. old commits predate the v2/v3 doc
        split, and some alpha-build hashes aren't reachable on the public mirror at
        all)."""
        owl_js = (
            self.io.read_text(os.path.join(community_path, "addons/web/static/lib/owl/owl.js"))
            or ""
        )
        v_match = _OWL_VERSION_RE.search(owl_js)
        major = v_match.group(1) if v_match else "2"  # undetectable -> assume the long-stable v2
        h_match = _OWL_HASH_RE.search(owl_js)
        versioned_path = "doc/v3/owl/reference" if major == "3" else "doc/v2/reference"
        candidates = []
        if h_match:
            h = h_match.group(1)
            if major != "3":
                candidates.append((h, "doc/reference"))  # pre-v2/v3-split layout
            candidates.append((h, versioned_path))
        candidates.append(("master", versioned_path))  # always-good fallback
        for ref, path in candidates:
            text, error = self.io.http_get(
                f"https://raw.githubusercontent.com/odoo/owl/{ref}/{path}/component.md"
            )
            if not error and text:
                return ref, path, major
        return "master", versioned_path, major

    def resolve_owl_worktree_start(self, community_path, owl_main_path, pull_remote="origin"):
        """The odoo/owl ref to fork an owl worktree from, matching the Owl build
        actually vendored at <community_path> (an already-created worktree — this is
        called after community's own worktree_add, once its owl.js is real). Returns
        the exact vendored commit if it's reachable, else "master" — same fallback
        rationale as _resolve_owl_docs's remote lookup (some alpha-build hashes
        aren't reachable at all, e.g. built from a commit never pushed publicly).
        Checked in two steps: the LOCAL owl clone's object store first (free), then
        an explicit `git fetch <remote> <commit>` (most hosts, GitHub included,
        allow fetching by sha when it's reachable there — this catches a commit
        that's genuinely available upstream but predates however much history the
        local clone happens to have fetched so far)."""
        owl_js = (
            self.io.read_text(os.path.join(community_path, "addons/web/static/lib/owl/owl.js"))
            or ""
        )
        h_match = _OWL_HASH_RE.search(owl_js)
        if not h_match:
            return "master"
        commit = h_match.group(1)
        _, error = self._git(owl_main_path, "cat-file", "-e", commit, timeout=10, quiet=True)
        if error:
            _, error = self._git(
                owl_main_path, "fetch", pull_remote or "origin", commit, timeout=30, quiet=True
            )
        return commit if not error else "master"

    def create_worktree_skills(
        self, community_path, worktree_parent, branch, documentation_path=None, owl_path=None
    ):
        """Create the .claude/skills/ Odoo-dev skills at the worktree's parent dir
        (alongside .claude/CLAUDE.md — see create_worktree_claude_md), one per domain,
        each pointing at documentation matched to this worktree's Odoo version (and,
        for the frontend skill, its exact vendored Owl build) — read locally from
        <documentation_path>/<owl_path> when the workspace has those checkouts (see
        create_worktree_claude_md's sibling note), else fetched from
        raw.githubusercontent.com. Called once, explicitly, from server.py after every
        repo in the workspace has been created."""
        skills_dir = os.path.join(worktree_parent, ".claude", "skills")
        marker = os.path.join(skills_dir, "odoo-orm", "SKILL.md")
        if self.io.read_text(marker) is not None:
            return
        contents = self._skill_contents(community_path, branch, documentation_path, owl_path)
        for slug, files in contents.items():
            for rel_path, content in files.items():
                self.io.write_text(os.path.join(skills_dir, slug, rel_path), content)

    def _owl_local_layout(self, owl_path, major):
        """Which on-disk doc/ layout an owl worktree checkout actually has — probed
        directly (the checkout is real, so there's no need to guess/retry like
        _resolve_owl_docs's remote canary-fetch does): the pre-v2/v3-split flat
        layout (older commits), or the newer doc/v{2,3}/... split."""
        split = f"doc/v{major}/owl/reference" if major == "3" else f"doc/v{major}/reference"
        if self.io.is_dir(os.path.join(owl_path, "doc", "reference")):
            return "doc/reference"
        return split

    def _skill_contents(self, community_path, branch, documentation_path=None, owl_path=None):
        """{slug: full SKILL.md content (frontmatter + body)} for the four Odoo-dev
        skills, version-matched to <branch> (and, for odoo-frontend-owl, the Owl
        build actually vendored at <community_path>). Odoo/Owl doc references read
        <documentation_path>/<owl_path> directly (local worktree checkouts — see
        create_worktree_claude_md) when given, else fall back to
        raw.githubusercontent.com/gh api at <branch>'s/the vendored build's matching
        doc-repo ref."""
        doc_branch = base_branch(branch)
        if documentation_path:
            doc_base = f"{documentation_path}/content/developer"
            doc_fetch = "Read the file directly"

            def doc_browse(subdir):
                return f"`find {documentation_path}/content/developer/{subdir} -type f`"
        else:
            doc_base = f"https://raw.githubusercontent.com/odoo/documentation/{doc_branch}/content/developer"
            doc_fetch = "WebFetch the raw URL"

            def doc_browse(subdir):
                return (
                    f"`gh api repos/odoo/documentation/contents/content/developer/"
                    f"{subdir}?ref={doc_branch}`"
                )

        if owl_path:
            v_match = _OWL_VERSION_RE.search(
                self.io.read_text(os.path.join(community_path, "addons/web/static/lib/owl/owl.js"))
                or ""
            )
            major = v_match.group(1) if v_match else "2"
            owl_layout = self._owl_local_layout(owl_path, major)
            owl_base = f"{owl_path}/{owl_layout}"
            owl_pin_note = "checked out locally in `owl/` — always exactly matches what's vendored"
            owl_key_files = f"Read the file directly, e.g. `{owl_base}/component.md`"
            owl_browse = f"`find {owl_path}/{owl_layout} -type f`"
        else:
            owl_ref, owl_doc_path, major = self._resolve_owl_docs(community_path)
            owl_pinned = owl_ref != "master"
            owl_base = f"https://raw.githubusercontent.com/odoo/owl/{owl_ref}/{owl_doc_path}"
            owl_pin_note = (
                f"pinned to the exact vendored commit `{owl_ref}`"
                if owl_pinned
                else "exact commit docs weren't reachable — using odoo/owl's master branch "
                f"instead, latest v{major} docs"
            )
            owl_key_files = f"WebFetch the raw URL, e.g. `{owl_base}/component.md`"
            owl_browse = f"`gh api repos/odoo/owl/contents/{owl_doc_path}?ref={owl_ref}`"

        skills = {
            "odoo-orm": (
                "Use when writing or editing Odoo backend Python code: models, fields, "
                "compute/onchange/constrain methods, recordsets, the environment, "
                "security (ir.model.access.csv, record rules), module manifests, "
                "mixins, data files, or HTTP controllers/routing.",
                f"""# Odoo ORM & backend reference (branch: {doc_branch})

This worktree targets Odoo **{doc_branch}**. The ORM API, security model, and
manifest format change across versions — prefer these version-matched docs over
general/training knowledge.

Base URL: `{doc_base}/`

Key files ({doc_fetch}):
- `reference/backend/orm.rst` — fields, recordsets, environment, ORM methods
- `reference/backend/security.rst` — ACL, record rules, groups
- `reference/backend/module.rst` — manifest format, module structure
- `reference/backend/mixins.rst` — mail.thread and other mixins
- `reference/backend/data.rst` — data/demo XML/CSV files
- `reference/backend/http.rst` — controllers, routing, JSON-RPC
- `reference/backend/actions.rst` — server actions, window actions
- `reference/backend/performance.rst` — batching, prefetching, N+1 pitfalls
- `tutorials/server_framework_101.rst` (+ numbered chapters 01_ to 15_ under
  `tutorials/server_framework_101/`) — the guided from-scratch walkthrough

Not listed above? Browse the directory: {doc_browse("reference/backend")}
""",
            ),
            "odoo-views": (
                "Use when writing or editing Odoo view XML (form/list/kanban/search), "
                "window actions, menus, or qweb PDF reports.",
                f"""# Odoo views, actions & reports reference (branch: {doc_branch})

This worktree targets Odoo **{doc_branch}**. View architecture and attributes change
across versions — prefer these version-matched docs over general/training knowledge.

Base URL: `{doc_base}/`

Key files ({doc_fetch}):
- `reference/backend/actions.rst` — window/server actions, menus
- `reference/backend/reports.rst` — qweb PDF reports
- `reference/user_interface/view_architectures.rst` — view XML attributes reference
- `reference/user_interface/view_records.rst` — <record> declarations for views
- `reference/user_interface/icons.rst` — icon widgets/classes

Not listed above? Browse the directories:
{doc_browse("reference/user_interface")}
{doc_browse("reference/user_interface/view_architectures")}
(the latter has one short file per view attribute)
""",
            ),
            "odoo-frontend-owl": (
                "Use when writing or editing Odoo frontend JS: Owl components, "
                "services, registries, hooks, assets bundling, qweb templates, or "
                "patching existing code.",
                f"""# Odoo frontend & Owl framework reference (branch: {doc_branch})

This worktree targets Odoo **{doc_branch}**, which vendors Owl **major v{major}**
({owl_pin_note}).
Owl's API differs significantly between v2 and v3 (v3 is still alpha and fast-moving)
— prefer these version-matched docs over general/training knowledge.

## Odoo's frontend layer
Base URL: `{doc_base}/reference/frontend/`

Key files ({doc_fetch}):
- `framework_overview.rst` — how the pieces fit together
- `owl_components.rst` — Odoo-specific Owl conventions
- `services.rst` — the service layer (registry, useService)
- `registries.rst` — fields/views/actions registries
- `hooks.rst` — Odoo's own hooks on top of Owl's
- `assets.rst` — bundles, asset targets
- `qweb.rst` — template directives
- `patching_code.rst` — patch()/the monkey-patch helper
- `javascript_modules.rst` — module system (`/** @odoo-module **/`)
- `unit_testing/{{hoot,mock_server,web_helpers}}.rst` — JS unit tests (hoot)

Not listed above? Browse: {doc_browse("reference/frontend")}

## The Owl framework itself
Base URL: `{owl_base}/`

Key files ({owl_key_files}): `component.md`,
`hooks.md`, `props.md`, `reactivity.md`, `slots.md`, `event_handling.md`,
`error_handling.md`, `app.md`, `refs.md`, `concurrency_model.md`.

Not listed above (v3 adds several concepts v2 doesn't have — signals, effects,
resources, plugins, scope, proxies, error boundaries)? Browse: {owl_browse}
""",
            ),
            "odoo-testing": (
                "Use when writing or debugging Odoo tests: Python TransactionCase/"
                "HttpCase/tours, or JS unit tests (hoot).",
                f"""# Odoo testing reference (branch: {doc_branch})

This worktree targets Odoo **{doc_branch}**. Prefer these version-matched docs over
general/training knowledge.

Base URL: `{doc_base}/`

Key files ({doc_fetch}):
- `reference/backend/testing.rst` — TransactionCase, HttpCase, tours, tags
- `reference/frontend/unit_testing/hoot.rst` — the hoot JS test runner
- `reference/frontend/unit_testing/mock_server.rst` — mocking RPCs in JS tests
- `reference/frontend/unit_testing/web_helpers.rst` — DOM/query test helpers
- `tutorials/unit_tests.rst` — guided walkthrough

Not listed above? Browse: {doc_browse("reference/backend/testing")}
""",
            ),
        }

        result = {
            slug: {"SKILL.md": f"---\nname: {slug}\ndescription: '{description}'\n---\n\n{body}"}
            for slug, (description, body) in skills.items()
        }
        result["odoo-memory-perf"] = self._memory_perf_skill_files()
        result["odoo-bootstrap-leak-audit"] = self._bootstrap_leak_audit_skill_files()
        return result

    def _memory_perf_skill_files(self):
        """{relative_path: content} for the odoo-memory-perf skill — unlike the
        four doc-reference skills above, this one is a runnable tool (empirical
        heap-diff memory check via memlab + an existing Odoo tour), bundled with
        its own scripts rather than pointing at documentation."""
        skill_md = """---
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
"""
        run_check_sh = """#!/usr/bin/env bash
# Empirical memory-leak check: runs any existing --test-tags-selectable test
# through the memleak_check addon (dumping 3 heap snapshots around whatever
# browser session that test creates), then hands those snapshots to memlab
# for offline analysis. Not a special mode — <test_tags> is the exact same
# value you'd give odoo-bin's own --test-tags.
# Usage: run_check.sh <test_tags> <modules_to_install> [db_name]
set -euo pipefail

TEST_TAGS="${1:?usage: run_check.sh <test_tags> <modules_to_install> [db_name]}"
MODULES="${2:?usage: run_check.sh <test_tags> <modules_to_install> [db_name]}"
DB="${3:-memcheck_$$}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# .claude/skills/odoo-memory-perf/scripts -> worktree root -> community/
WORKTREE_ROOT="$(cd "$HERE/../../../.." && pwd)"
COMMUNITY="$WORKTREE_ROOT/community"

# --work-dir persists memlab's report (by default it writes to a temp dir that's
# gone once the run ends): <DUMP_DIR>/data/cur/leaks.txt, plus the raw
# baseline/target/final .heapsnapshot files the ChromeBrowser patch writes here
# directly (see test_memleak_check.py)
DUMP_DIR="$HERE/../dumps/memcheck_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$DUMP_DIR"

cleanup() {
  dropdb --if-exists "$DB" 2>/dev/null || true
}
trap cleanup EXIT

echo "installing memleak_check,$MODULES and running '$TEST_TAGS' (db: $DB)..."
# --test-tags --stop-after-init runs synchronously and exits on its own — no
# background process or port to manage, unlike a long-running server
(
  cd "$COMMUNITY"
  export MEMCHECK_DUMP_DIR="$DUMP_DIR"
  ./odoo-bin -c ../odoo.conf -d "$DB" \\
    -i "memleak_check,$MODULES" \\
    --test-tags "$TEST_TAGS" --test-enable --stop-after-init --without-demo all
)

echo "analyzing the 3 snapshots with memlab..."
npx --yes memlab@latest find-leaks \\
  --baseline "$DUMP_DIR/baseline.heapsnapshot" \\
  --target "$DUMP_DIR/target.heapsnapshot" \\
  --final "$DUMP_DIR/final.heapsnapshot" \\
  --work-dir "$DUMP_DIR"

echo
echo "dump saved: $DUMP_DIR/ (*.heapsnapshot, data/cur/leaks.txt)"
"""
        return {
            "SKILL.md": skill_md,
            "scripts/run_check.sh": run_check_sh,
        }

    def _bootstrap_leak_audit_skill_files(self):
        """{relative_path: content} for the odoo-bootstrap-leak-audit skill — a
        *static* grep-and-read methodology for one specific, recurring,
        already-proven memory-leak anti-pattern in Odoo's JS: a vendored
        Bootstrap 5 component instance created without a matching .dispose()
        call. Complements odoo-memory-perf's *empirical* heap-diff approach:
        this finds candidate sites by pattern-matching code; that one confirms
        and quantifies a specific site by actually running it and diffing heap
        snapshots. The mechanism below was verified against a real checkout's
        vendored addons/web/static/lib/bootstrap/js/dist/{dom/data.js,
        base-component.js} before being written up here."""
        skill_md = """---
name: odoo-bootstrap-leak-audit
description: 'Use when auditing Odoo JS/Owl code (community, enterprise, or any addon) for memory leaks caused by Bootstrap 5 component instances (Carousel, Modal, Tooltip, Dropdown, etc.) never being disposed.'
---

# Bootstrap 5 component leak audit (static, grep-and-read)

A specific, recurring memory-leak anti-pattern in Odoo's JS/Owl frontend,
found and fixed multiple times already in community — worth checking any
time new frontend code (an addon, a PR, an enterprise module) is being
reviewed for memory leaks.

## The mechanism (verified against the vendored source)

Odoo vendors Bootstrap 5 at `addons/web/static/lib/bootstrap/js/dist/`.
Every component instance — `Carousel`, `Tooltip`, `Popover`, `Modal`,
`Dropdown`, `Collapse`, `ScrollSpy`, `Tab`, `Offcanvas`, `Toast`, `Alert`,
`Button` — is tracked in one page-global, **non-weak** `Map` (`dom/data.js`):

```js
const elementMap = new Map();  // keyed by the DOM element the instance is attached to
```

The **only** way an entry is ever removed is calling `.dispose()` on the
instance — internally (`base-component.js`):

```js
dispose() {
  Data.remove(this._element, this.constructor.DATA_KEY);
  ...
}
```

So `new Carousel(el)`, `Modal.getOrCreateInstance(el)`, etc. — any of these —
permanently retains `el` (and everything `el` references) in memory unless
something later calls `.dispose()` on that instance. If the creation site is
inside an Owl component's mount lifecycle, or a JS "Interaction" (Odoo's
public-page interaction framework) that runs repeatedly (every mount, every
modal/popup open, every list item added), each repetition leaks one more
element — a compounding leak, not a one-off.

Already found and fixed this way in community (context/precedent — always
re-verify against the actual checkout being audited, since fixes land on
separate branches/PRs and a given local worktree may or may not have them
all yet): `addons/pos_self_order/static/src/app/utils/carousel_hook.js`
(biggest impact — ~85% memory reduction in its own test suite),
`addons/website/static/src/snippets/s_searchbar/search_bar.js`,
`addons/website/static/src/interactions/image_popup.js` +
`addons/website/static/src/snippets/s_image_gallery/gallery.js`.

## How to audit

1. Search for direct instantiation and the factory method, across whatever
   scope you're auditing (one addon, all of enterprise, everything):

   ```bash
   grep -rnE "new (Carousel|Tooltip|Popover|Modal|Dropdown|Collapse|ScrollSpy|Tab|Offcanvas|Toast|Alert|Button)\\(" <path>/static/src
   grep -rnE "\\.getOrCreateInstance\\(" <path>/static/src
   ```

2. For **each** hit, read the *whole file* (not just the instantiation line)
   and the enclosing Owl component / Interaction / hook:
   - Which class, and what element — a persistent one-time element (created
     once, e.g. at module scope or a top-level ref) vs. one created/destroyed
     repeatedly (every mount, every modal open, every row added/removed)?
     Repeatable creation is what turns this into a real, compounding leak; a
     genuinely one-time element still leaks, but only once.
   - Search the same file for `.dispose()`, `onWillUnmount`, `onWillDestroy`,
     `destroy()`, `registerCleanup` — is the instance actually disposed when
     its owning component/interaction tears down, or when its element is
     removed? Note: an Interaction's `this.insert(el, ...)` /
     `registerCleanup(() => el.remove())` only removes `el` from the DOM — it
     does **not** call `.dispose()` on any Bootstrap instance attached to it,
     so relying on that alone is NOT a fix.
   - Verdict: genuine leak (repeatable creation, no matching dispose) vs.
     safe (disposed correctly, or a verified one-time element).

3. Report format, ranked by confidence: file:line, class + element
   description, dispose found (y/n, where), verdict. Only report sites
   you've actually read the surrounding code for — don't guess from the
   instantiation line alone.

## Fix shape (from the community precedent)

```js
let carousel;
onMounted(() => {
  carousel = new Carousel(el);
});
onWillUnmount(() => {
  carousel?.dispose();
});
```

Same idea for a repeatedly-opened Modal/Popover/etc.: dispose it on whatever
event signals it's done (`hidden.bs.modal`, the interaction's own teardown,
`onWillDestroy`), not just remove its element from the DOM.

## Going from static to empirical

A static hit here is a *candidate*, not proof — confirm and quantify it with
the `odoo-memory-perf` skill: find or write a tour/test that exercises the
exact mount/open/close cycle around the suspected site, then run it through
goo's Tests tab "Memory check" checkbox (or that skill's own `run_check.sh`)
to diff real heap snapshots. The retained element (and the Bootstrap
instance holding it) should show up directly in memlab's retainer trace if
the leak is real.
"""
        return {"SKILL.md": skill_md}

    def write_dev_context(self, out_dir, community_path, branch):
        """Materialize the Odoo-dev CLAUDE.md + skills straight into <out_dir>/.claude/
        (no existence guard — meant for a fresh, throwaway directory, e.g. the headless
        Claude chat's per-conversation temp dir). Unlike the persisted worktree copy
        (create_worktree_claude_md/create_worktree_skills, generated once at worktree
        creation), this always reflects goo's current skill templates and <branch>'s
        current state — and works for a main-located checkout too, which has no
        worktree parent dir of its own to persist into. Detects (but never creates)
        enterprise/documentation/owl siblings next to <community_path> — present for
        a worktree-based target created via the auto-fork flow, absent otherwise."""
        parent = os.path.dirname(community_path)
        has_enterprise = self.io.is_dir(os.path.join(parent, "enterprise"))

        def sibling_or_none(name):
            path = os.path.join(parent, name)
            return path if self.io.is_dir(path) else None

        documentation_path = sibling_or_none("documentation")
        owl_path = sibling_or_none("owl")
        self.io.write_text(
            os.path.join(out_dir, ".claude", "CLAUDE.md"),
            self._claude_md_content(branch, has_enterprise, documentation_path, owl_path),
        )
        contents = self._skill_contents(community_path, branch, documentation_path, owl_path)
        for slug, files in contents.items():
            for rel_path, content in files.items():
                self.io.write_text(
                    os.path.join(out_dir, ".claude", "skills", slug, rel_path), content
                )

    def write_odoo_conf(self, worktree_parent, addons_path, db_user, db_password):
        """Write a ready-to-use odoo.conf at the worktree root (sibling to
        community/enterprise, alongside .claude/ — see create_worktree_claude_md), so
        `./odoo-bin -c ../odoo.conf -d <db>` just works from within community/ without
        hand-reconstructing --addons-path. Only if absent — like its .claude/ siblings,
        never overwritten (the caller may have edited it)."""
        path = os.path.join(worktree_parent, "odoo.conf")
        if self.io.read_text(path) is not None:
            return
        self.io.write_text(
            path,
            "[options]\n"
            "; auto-generated by goo — feel free to edit\n"
            f"addons_path = {addons_path}\n"
            f"db_user = {db_user}\n"
            f"db_password = {db_password}\n",
        )

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
        _, error = self._git(
            p, "worktree", "remove", "--force", wp, timeout=60, err="git worktree remove failed"
        )
        self.notify(removing, event_id=eid, status="error" if error else "done")
        return error is None, error

    def create_branch(
        self, path, name, start_point, fresh_start=False, pull_remote="origin", repo=""
    ):
        """Create a new local branch <name> at <start_point> WITHOUT checking it
        out (working tree / current branch untouched). Returns (ok, error)."""
        if not path or not name or not start_point:
            return False, "missing path, name or start point"
        if fresh_start:
            start_point, error = self.fresh_start_point(path, start_point, pull_remote, repo)
            if error:
                return False, error
        _, error = self._git(path, "branch", name, start_point, timeout=10, err="git branch failed")
        return error is None, error

    def delete_branch(self, path, branch, delete_remote=False, push_remote="dev"):
        """Force-delete a local branch, and optionally its branch on the configured
        push remote too. Returns (ok, error, remote_error): the first two are for the
        local delete; remote_error is set when the local delete succeeded but the
        remote branch could not be removed (None otherwise)."""
        _, error = self._git(path, "branch", "-D", branch, timeout=10, err="git branch -D failed")
        if error:
            return False, error, None
        remote_error = None
        if delete_remote:
            if is_base_branch(branch):
                return True, None, f"refusing to delete base branch {branch} on the remote"
            # delete straight away — no `ls-remote` pre-check (a round-trip per branch).
            # If the branch was never pushed, git fails with "remote ref does not
            # exist", which we treat as success: there was nothing to remove.
            remote = push_remote or "dev"
            self.io.log_request(f"git push {remote} --delete {branch}")
            r, remote_error = self._git(
                path,
                "push",
                remote,
                "--delete",
                branch,
                timeout=120,
                err="git push --delete failed",
                tail=True,
            )
            if remote_error and r is not None and "remote ref does not exist" in r.stderr:
                remote_error = None
        return True, None, remote_error

    def commit(self, path, message):
        """Stage all changes and create a commit with the given message. Returns
        (ok, error)."""
        _, error = self._git(path, "add", "-A", err="git add failed")
        if error:
            return False, error
        _, error = self._git(path, "commit", "--no-verify", "-m", message, err="git commit failed")
        return error is None, error

    def wip_commit(self, path):
        """Stage all changes and create a WIP commit. Returns (ok, error)."""
        return self.commit(path, "[WIP]")

    def amend_commit(self, path, message):
        """Stage all changes and fold them into the HEAD commit with the given
        message (git commit --amend). Returns (ok, error)."""
        _, error = self._git(path, "add", "-A", err="git add failed")
        if error:
            return False, error
        _, error = self._git(
            path, "commit", "--no-verify", "--amend", "-m", message, err="git commit --amend failed"
        )
        return error is None, error

    def _ahead_shas(self, path, ref, base, pull_remote):
        """The set of commit shas reachable from <ref> (default HEAD) but not from
        the base branch — its fetched <pull_remote>/<base> tip, falling back to a
        local <base> branch — i.e. unique to this branch, not inherited from base.
        None if neither resolves (caller should then treat nothing as safe)."""
        for candidate in (f"{pull_remote or 'origin'}/{base}", base):
            r = self.io.run(
                ["git", "-C", path, "rev-list", f"{candidate}..{ref or 'HEAD'}"],
                timeout=15,
                quiet=True,
            )
            if r.returncode == 0:
                return set(r.stdout.split())
        return None

    def _rebase_in_progress(self, path):
        """Whether <path> currently has a rebase left mid-flight (conflict, or
        any other stop) — the standard `.git/rebase-merge` (interactive; what
        rewrite_history always uses) or `.git/rebase-apply` (plain am-style)
        state directories, resolved via --git-path so this also works from a
        linked worktree."""
        for kind in ("rebase-merge", "rebase-apply"):
            r = self.io.run(
                ["git", "-C", path, "rev-parse", "--git-path", kind], timeout=10, quiet=True
            )
            if r.returncode != 0:
                continue
            git_path = r.stdout.strip()
            if not os.path.isabs(git_path):
                git_path = os.path.join(path, git_path)
            if self.io.is_dir(git_path):
                return True
        return False

    def abort_rebase(self, path):
        """Abort an in-progress rebase (git rebase --abort), restoring the
        branch to its pre-rebase state. Returns (ok, error)."""
        _, error = self._git(path, "rebase", "--abort", err="git rebase --abort failed")
        return error is None, error

    def rebase_status(self, path):
        """Whether <path> already has a rebase left mid-flight — from a
        conflicted rewrite_history (or anything else, e.g. a manual rebase run
        outside goo) — checked fresh on every history view load, not just
        right after applying a plan, so a stuck rebase from a previous session
        is never silently invisible. (in_progress, error)."""
        path = os.path.expanduser(path)
        try:
            return self._rebase_in_progress(path), None
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e)

    def rewrite_history(self, path, base, plan, pull_remote="origin"):
        """Reorder and/or squash this branch's own commits via a scripted,
        non-interactive `git rebase -i`.

        `plan` is the desired FINAL order, oldest-first:
        [{sha, squash, drop, message?}, ...].
        squash=True folds that commit into whichever entry precedes it in the
        list — its own message is discarded. `message`, when present on a pick,
        replaces that commit's full message; for a squash group it becomes the
        resulting group's message. drop=True removes that commit and its changes.
        Re-validates
        server-side that `plan` covers exactly this branch's commits ahead of
        <base> (see reword_commit) — never touches base/shared history, and
        refuses a plan whose oldest entry is itself a squash (nothing precedes
        it). Returns (ok, error, in_progress) — in_progress is True only when
        the rebase itself conflicted and was left mid-flight (see
        _rebase_in_progress/abort_rebase for the recovery path); every earlier
        validation failure returns it False, since git was never touched.

        Mechanics: GIT_SEQUENCE_EDITOR overwrites git's default todo with our
        exact pick/reword/squash order (the same non-interactive "cp a prepared file
        over whatever git drafted" trick reword_commit uses for its fixup
        message) — no reliance on git's own reordering/autosquash. Reworded
        picks and squash groups open a message editor; GIT_EDITOR points at a
        tiny counter script that pops each prepared message off an ordered queue
        (one shared substitution isn't enough when a plan contains several edits
        and/or independent squash groups).
        """
        path = os.path.expanduser(path)
        if not plan:
            return False, "nothing to reorder", False
        for entry in plan:
            if not isinstance(entry, dict) or not isinstance(entry.get("sha"), str):
                return False, "invalid history plan", False
            if "message" in entry and (
                not isinstance(entry["message"], str) or not entry["message"].strip()
            ):
                return False, "commit messages can't be empty", False
            if entry.get("squash") and "message" in entry:
                return False, "a squashed commit can't keep an independent message", False
            if entry.get("drop") and (entry.get("squash") or "message" in entry):
                return False, "a dropped commit can't be squashed or reworded", False
        shas = [entry["sha"] for entry in plan]
        has_kept_commit = False
        previous_dropped = False
        for entry in plan:
            if entry.get("drop"):
                previous_dropped = True
                continue
            if entry.get("squash") and not has_kept_commit:
                return False, "the oldest commit can't be squashed — nothing precedes it", False
            if entry.get("squash") and previous_dropped:
                return False, "a commit can't be squashed into a dropped commit", False
            has_kept_commit = True
            previous_dropped = False
        ahead = self._ahead_shas(path, "HEAD", base, pull_remote)
        if not ahead or len(shas) != len(ahead) or set(shas) != ahead:
            return False, "the commit list changed — reload and try again", False
        base_ref = None
        for candidate in (f"{pull_remote or 'origin'}/{base}", base):
            r = self.io.run(["git", "-C", path, "rev-parse", candidate], timeout=15, quiet=True)
            if r.returncode == 0:
                base_ref = r.stdout.strip()
                break
        if not base_ref:
            return False, "couldn't resolve the base branch", False

        # Group consecutive squash entries under the pick that precedes them.
        # A lone edited pick uses `reword`; a squash group keeps (or replaces)
        # its root's message through the squash editor.
        groups = []
        for e in plan:
            if e.get("drop"):
                groups.append([e])
            elif e.get("squash") and groups and not groups[-1][0].get("drop"):
                groups[-1].append(e)
            else:
                groups.append([e])

        tmp_dir = tempfile.mkdtemp()
        try:
            todo_file = os.path.join(tmp_dir, "todo")
            todo_lines = []
            queued_messages = []
            counter = 0
            for g in groups:
                root = g[0]
                if root.get("drop"):
                    todo_lines.append(f"drop {root['sha']}")
                    continue
                if len(g) == 1:
                    todo_lines.append(f"{'reword' if 'message' in root else 'pick'} {root['sha']}")
                    if "message" in root:
                        queued_messages.append(root["message"])
                    continue
                todo_lines.append(f"pick {root['sha']}")
                todo_lines.extend(f"squash {entry['sha']}" for entry in g[1:])
                if "message" in root:
                    queued_messages.append(root["message"])
                    continue
                msg_r = self.io.run(
                    ["git", "-C", path, "log", "-1", "--format=%B", root["sha"]],
                    timeout=15,
                    quiet=True,
                )
                if msg_r.returncode != 0:
                    return False, msg_r.stderr.strip() or "couldn't read commit message", False
                queued_messages.append(msg_r.stdout)
            with open(todo_file, "w") as f:
                f.write("\n".join(todo_lines) + "\n")
            for message in queued_messages:
                with open(os.path.join(tmp_dir, f"{counter}.msg"), "w") as f:
                    f.write(message if message.endswith("\n") else message + "\n")
                counter += 1
            with open(os.path.join(tmp_dir, "counter"), "w") as f:
                f.write("0")
            editor_script = os.path.join(tmp_dir, "editor.sh")
            with open(editor_script, "w") as f:
                f.write(
                    "#!/bin/sh\n"
                    'n=$(cat "$GOO_QUEUE_DIR/counter")\n'
                    'cp "$GOO_QUEUE_DIR/$n.msg" "$1"\n'
                    'echo $((n+1)) > "$GOO_QUEUE_DIR/counter"\n'
                )
            env = {
                **os.environ,
                "GIT_SEQUENCE_EDITOR": f"cp {shlex.quote(todo_file)}",
                "GIT_EDITOR": f"sh {shlex.quote(editor_script)}",
                "GOO_QUEUE_DIR": tmp_dir,
            }
            r = self.io.run(
                ["git", "-C", path, "rebase", "--autostash", "-i", base_ref], timeout=120, env=env
            )
            if r.returncode != 0:
                in_progress = self._rebase_in_progress(path)
                return False, r.stderr.strip() or "git rebase failed", in_progress
            return True, None, False
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e), False
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    def reword_commit(self, path, sha, message, base="", pull_remote="origin"):
        """Rewrite an existing commit's message, leaving its content untouched.

        Uses git's own non-interactive reword mechanism: an empty `--fixup=reword:`
        commit supplies the new message, then `rebase --autosquash` splices it into
        <sha> — GIT_SEQUENCE_EDITOR/GIT_EDITOR are set to the no-op `true` for that
        step since autosquash has already prepared the correct todo/message by the
        time either would run. The fixup commit's message must be provided through
        an editor (git refuses `-m`/`-F` together with `--fixup=reword:`), so
        GIT_EDITOR is pointed at `cp <tmpfile>` for that one step, copying a
        prepared file over whatever git drafted — no shell-embedding of the
        (arbitrary, possibly multi-line/quoted) message at all. That file's first
        line must be "amend! <sha>" using <sha> in full: autosquash normally matches
        by searching ancestor SUBJECTS for that trailer, which is ambiguous the
        moment two commits share a subject (e.g. several "[WIP]" commits) — using
        the full sha there instead makes the match exact.

        `base`/`pull_remote`, when given, gate this to commits actually ahead of
        the base branch (see `_ahead_shas`/`log`'s `ahead` flag) — the UI only ever
        offers rewording for those, and this re-checks it server-side too, since
        rewriting inherited/shared history is a mistake no confirmation dialog
        should be able to wave through. Returns (ok, error); on conflict the
        rebase is left in progress (mirrors fetch_rebase)."""
        path = os.path.expanduser(path)
        if base:
            ahead = self._ahead_shas(path, "HEAD", base, pull_remote)
            if not ahead or sha not in ahead:
                return False, "refusing to rewrite a commit that isn't unique to this branch"
        tmp = None
        try:
            with tempfile.NamedTemporaryFile("w", delete=False, suffix=".txt") as f:
                f.write(f"amend! {sha}\n\n{message}\n")
                tmp = f.name
            env = {**os.environ, "GIT_EDITOR": f"cp {shlex.quote(tmp)}"}
            r = self.io.run(
                ["git", "-C", path, "commit", "--allow-empty", f"--fixup=reword:{sha}"],
                timeout=30,
                env=env,
            )
            if r.returncode != 0:
                return False, r.stderr.strip() or "git commit --fixup failed"
            env = {**os.environ, "GIT_SEQUENCE_EDITOR": "true", "GIT_EDITOR": "true"}
            r = self.io.run(
                ["git", "-C", path, "rebase", "--autosquash", "--autostash", "-i", f"{sha}^"],
                timeout=60,
                env=env,
            )
            if r.returncode != 0:
                return False, r.stderr.strip() or "git rebase --autosquash failed"
            return True, None
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e)
        finally:
            if tmp and os.path.exists(tmp):
                os.unlink(tmp)

    def discard(self, path):
        """Make the working tree pristine: reset tracked files to HEAD, then remove
        untracked files/dirs (git clean -fd, leaving ignored files). (ok, error)."""
        _, error = self._git(path, "reset", "--hard", "HEAD", err="git reset failed")
        if error:
            return False, error
        _, error = self._git(path, "clean", "-fd", err="git clean failed")
        return error is None, error

    def log(self, path, n=20, ref="", base="", pull_remote="origin"):
        """The last n commits on <ref> (default HEAD). Returns (commits, error);
        commits is a list of {sha, author, date, subject, body, ahead}. Fields are
        \\x1f-separated, commits \\x1e-terminated so multi-line bodies survive.

        When `base` is given, "ahead" marks commits reachable from <ref> but not
        from the base branch (see `_ahead_shas`) — i.e. unique to this branch, not
        inherited from it. Only those are safe to reword (see `reword_commit`); if
        the base can't be resolved, every commit conservatively comes back
        not-ahead rather than guessing."""
        path = os.path.expanduser(path)
        args = ["log", "-n", str(n), "--format=%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1e"]
        if ref:
            args += [ref, "--"]  # log a specific branch; -- disambiguates ref from a path
        r, error = self._git(path, *args, err="git log failed")
        if error:
            return None, error
        ahead = self._ahead_shas(path, ref, base, pull_remote) if base else None
        commits = []
        for rec in r.stdout.split("\x1e"):
            rec = rec.strip("\n")
            if not rec:
                continue
            parts = rec.split("\x1f")
            if len(parts) < 4:
                continue
            sha = parts[0]
            commits.append(
                {
                    "sha": sha,
                    "author": parts[1],
                    "date": parts[2],
                    "subject": parts[3],
                    "body": parts[4].strip() if len(parts) > 4 else "",
                    "ahead": bool(ahead and sha in ahead),
                }
            )
        return commits, None

    def commit_diff(self, path, sha):
        """Return the patch introduced by one commit as (diff, error)."""
        if not re.fullmatch(r"[0-9a-fA-F]{7,40}", sha or ""):
            return None, "invalid commit hash"
        r, error = self._git(
            path,
            "show",
            "--format=",
            "--no-ext-diff",
            "--no-color",
            "--find-renames",
            sha,
            "--",
            err="git show failed",
        )
        return (None, error) if error else (r.stdout, None)

    def fetch_remote_branch(self, path, branch, pull_remote="origin", force=False):
        """Fetch a remote branch and create/reset the local branch to track it
        (git fetch <pull_remote> {branch}:{branch}). Also updates the remote's
        opportunistic tracking ref (refs/remotes/<remote>/<branch>), so callers can
        pass a fork remote to make a forward-port head look pushed. Without `force`,
        a local branch that already exists and has diverged (e.g. the remote branch
        was rebased/force-pushed since the last fetch) is rejected rather than
        silently rewritten — flagged back as `non_ff` so a caller can ask the user
        before retrying with force=True. Returns (ok, error, non_ff)."""
        remote = pull_remote or "origin"
        refspec = f"{'+' if force else ''}{branch}:{branch}"
        r, error = self._git(path, "fetch", remote, refspec, timeout=60, err="git fetch failed")
        non_ff = bool(error) and r is not None and "non-fast-forward" in (r.stderr or "")
        return error is None, error, non_ff

    def fetch_rebase(self, path, base, pull_remote="origin", repo=""):
        """Fetch the base branch from the configured pull remote and rebase the
        current branch onto it. Announces the fetch and rebase phases via notify.
        Returns (ok, error); on conflict the rebase is left in progress."""
        if not path or not base:
            return False, "missing path or base branch"
        remote = pull_remote or "origin"
        p = os.path.expanduser(path)
        label = repo or os.path.basename(p)
        # both phases are slow — track each as a timed event so the browser shows a
        # live "..." that resolves to "ok" (or "failed")
        fid = uuid.uuid4().hex
        fetching = f"fetching {base} ({label})"
        self.notify(fetching, event_id=fid, status="start")
        _, error = self._git(p, "fetch", remote, base, timeout=180, err="git fetch failed")
        self.notify(fetching, event_id=fid, status="error" if error else "done")
        if error:
            return False, error
        eid = uuid.uuid4().hex
        rebasing = f"rebasing {label} onto {base}"
        self.notify(rebasing, event_id=eid, status="start")
        r, error = self._git(p, "rebase", "FETCH_HEAD", timeout=120, err="git rebase failed")
        self.notify(rebasing, event_id=eid, status="error" if error else "done")
        if error and r is not None and not r.stderr.strip():
            # a conflicted rebase reports on stdout — surface its first line instead
            error = r.stdout.strip().split("\n")[0] or "git rebase failed"
        return error is None, error

    def remote_branch_exists(self, path, branch, push_remote="dev"):
        """Whether <branch> exists on the configured push remote. (exists, error)."""
        remote = push_remote or "dev"
        self.io.log_request(f"git ls-remote {remote} {branch}")
        r, error = self._git(
            path, "ls-remote", "--heads", remote, branch, timeout=20, err="git ls-remote failed"
        )
        return (None, error) if error else (bool(r.stdout.strip()), None)

    def push_branch(self, path, branch, force=False, push_remote="dev"):
        """Push <branch> to the configured push remote, setting upstream. With force,
        use --force-with-lease (aborts if the remote moved unexpectedly). (ok, error).
        Base branches (master, saas-19.4, …) are never pushed."""
        if is_base_branch(branch):
            return False, f"refusing to push base branch {branch}"
        remote = push_remote or "dev"
        args = ["push", "--set-upstream"]
        if force:
            args.append("--force-with-lease")
        args += [remote, branch]
        self.io.log_request("git " + " ".join(args))
        _, error = self._git(path, *args, timeout=120, err="git push failed", tail=True)
        return error is None, error

    def fetch_master(self, repo):
        """Fetch master objects for one repo (no merge, no working-tree change).
        Slow on stale odoo clones, so callers run this off the main thread."""
        rid = repo.get("id") or "?"
        path = repo.get("path")
        if not path:
            return
        remote = repo.get("pull_remote") or "origin"
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


# ─────────────────────────── Venv (worktree Python environments) ────────────


class VenvService:
    """Build a dedicated Python venv for a worktree workspace, from its own
    requirements.txt (python3 -m venv, then pip install -r if the file is
    present), plus websocket-client (best-effort — needed by Odoo's
    ChromeBrowser for the Tests tab's memory-check option, since memleak_check
    is available in every worktree but isn't itself an Odoo dependency). Same
    notify-timed-event shape as GitService's mutations."""

    def __init__(self, io, notify=None):
        self.io = io
        self.notify = notify or (lambda *a, **k: None)

    def _pip(self, pip, *args, timeout, err):
        """Run one pip command in the venv. Returns (ok, error): error is the last
        stderr line (or <err> when pip was silent), or a raised
        FileNotFoundError/TimeoutExpired's message."""
        try:
            result = self.io.run([pip, *args], timeout=timeout)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e)
        if result.returncode != 0:
            lines = (result.stderr or "").strip().splitlines()
            return False, (lines[-1] if lines else err)
        return True, None

    def create(self, venv_path, requirements_path, timeout=600):
        """Create the venv at <venv_path> and install <requirements_path> into it
        if that file exists. Returns (ok, error). Announced as a timed event."""
        vp = os.path.expanduser(venv_path)
        label = os.path.basename(os.path.dirname(vp.rstrip("/")))
        eid = uuid.uuid4().hex
        creating = f"creating venv ({label})"
        self.notify(creating, event_id=eid, status="start")
        try:
            result = self.io.run(["python3", "-m", "venv", vp], timeout=60)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            self.notify(creating, event_id=eid, status="error")
            return False, str(e)
        if result.returncode != 0:
            error = (result.stderr or "python3 -m venv failed").strip().splitlines()[-1]
            self.notify(creating, event_id=eid, status="error")
            return False, error

        pip = os.path.join(vp, "bin", "pip")

        # a missing requirements.txt is not an error — just nothing to install
        if self.io.read_text(requirements_path) is not None:
            req = os.path.expanduser(requirements_path)
            ok, error = self._pip(pip, "install", "-r", req, timeout=timeout, err="pip failed")
            if not ok:
                self.notify(creating, event_id=eid, status="error")
                return False, error

        # best-effort: not an Odoo dependency, so it's never in requirements.txt,
        # but memleak_check (available in every worktree) needs it for
        # ChromeBrowser — a failure here shouldn't fail the whole venv
        self._pip(pip, "install", "websocket-client", timeout=60, err="pip failed")

        self.notify(creating, event_id=eid, status="done")
        return True, None


# ─────────────────────────── Addons (filesystem scan) ───────────────────────


class AddonsService:
    """Odoo modules discovered by scanning each repo's addons roots for a
    __manifest__.py. Over the IO seam (filesystem reads), so it's testable without
    a real checkout. The install state per db comes from DatabaseService."""

    def __init__(self, io):
        self.io = io

    def modules(self, repos, main_repo_id="community"):
        """Scan each repo {id, path} for modules with a manifest. A module name
        found in an earlier repo wins (community before enterprise, etc.)."""
        mods = []
        seen = set()
        for repo in repos:
            rid, path = repo.get("id"), repo.get("path")
            if not rid or not path:
                continue
            for root in self._roots(rid, path, main_repo_id):
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
    def _roots(rid, path, main_repo_id="community"):
        """Directories that hold modules for a repo, matching the addons-path."""
        p = os.path.expanduser(path)
        if rid == main_repo_id:
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


# ─────────────────────────── Rust asset bundler ───────────────────────────


class RustBundlerService:
    """Install and probe Goo's native asset bundler in the configured Odoo Python.

    The source directory is fixed by the server, while ``venv_activate`` comes from
    Goo's trusted local configuration just like every Odoo launch command. A
    process-wide lock prevents two browser tabs from building into the same venv.
    """

    PROBE_CODE = (
        "import json, goo_odoo_bundler as module; "
        'print(json.dumps({"version": module.__version__}))'
    )

    def __init__(self, io, source_dir, notify=None):
        self.io = io
        self.source_dir = os.path.abspath(source_dir)
        self.notify = notify
        self._build_lock = threading.Lock()

    def expected_version(self):
        cargo = self.io.read_text(os.path.join(self.source_dir, "Cargo.toml")) or ""
        package = re.search(r'(?ms)^\[package\].*?^version\s*=\s*"([^"]+)"', cargo)
        return package.group(1) if package else "unknown"

    @staticmethod
    def _environment_command(config, command):
        activate = ((config or {}).get("venv_activate") or "").strip()
        return f"{activate} && {command}" if activate else command

    def install_command(self, config):
        pip = f"python3 -m pip install --force-reinstall --no-deps {shlex.quote(self.source_dir)}"
        return self._environment_command(config, pip)

    def probe_command(self, config):
        probe = f"python3 -c {shlex.quote(self.PROBE_CODE)}"
        return self._environment_command(config, probe)

    @staticmethod
    def _tail(result, fallback):
        lines = ((result.stderr or result.stdout or "").strip()).splitlines()
        return "\n".join(lines[-12:])[-3000:] if lines else fallback

    def _probe(self, config, allow_while_building=False):
        expected = self.expected_version()
        base = {
            "installed": False,
            "current": False,
            "version": "",
            "expected_version": expected,
            "building": self._build_lock.locked(),
        }
        if base["building"] and not allow_while_building:
            return base
        try:
            result = self.io.run(
                self.probe_command(config),
                shell=True,
                executable="/bin/bash",
                quiet=True,
                timeout=30,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            return {**base, "error": str(error)}
        if result.returncode:
            return base
        try:
            payload = json.loads((result.stdout or "").strip().splitlines()[-1])
            version = payload["version"]
        except (IndexError, KeyError, TypeError, ValueError):
            return {**base, "error": "the native module returned an invalid version"}
        return {
            **base,
            "installed": True,
            "current": version == expected,
            "version": version,
        }

    def status(self, config):
        return self._probe(config)

    def install(self, config, timeout=900):
        if not self._build_lock.acquire(blocking=False):
            return False, {"error": "Rust bundler installation is already in progress"}

        event_id = f"rust-bundler-{uuid.uuid4().hex}"
        event_text = "building Goo's Rust asset bundler"
        if self.notify:
            self.notify(event_text, "", event_id, "start")
        try:
            try:
                result = self.io.run(
                    self.install_command(config),
                    shell=True,
                    executable="/bin/bash",
                    timeout=timeout,
                )
            except (OSError, subprocess.TimeoutExpired) as error:
                message = str(error) or "Rust bundler installation timed out"
                if self.notify:
                    self.notify(event_text, "error", event_id, "error")
                return False, {"error": message}
            if result.returncode:
                message = self._tail(result, "Rust bundler installation failed")
                if self.notify:
                    self.notify(event_text, "error", event_id, "error")
                return False, {"error": message}

            status = {**self._probe(config, allow_while_building=True), "building": False}
            if not status.get("current"):
                message = status.get("error") or "installed module version could not be verified"
                if self.notify:
                    self.notify(event_text, "error", event_id, "error")
                return False, {"error": message, **status}
            if self.notify:
                self.notify(event_text, "", event_id, "done")
            return True, {**status, "restart_required": True}
        finally:
            self._build_lock.release()


# ─────────────────────────── Config store ───────────────────────────

_KEEP = object()  # sentinel: "leave this blob unchanged" in ConfigStore.save


class ConfigStore:
    """The server-owned config file: {rev, config, state}, persisted atomically.

    `config` (the user's settings/repos/targets) and `state` (app-recorded: active
    target, test history, claude model) are opaque JSON blobs — the schema
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


def build_start_config(config, workspace_id, overrides=None):
    """Assemble the launch config `build_odoo_cmd` consumes from the stored config, a
    workspace id, and optional `overrides` ({other_args?, test_tags?, install?,
    upgrade?, memcheck?}). This is the one server-side
    builder the thin launch endpoints resolve
    `{workspace, overrides}` to. A worktree-located workspace points its repos +
    server_path at its on-disk copies (so build_odoo_cmd cd's into the worktree's
    community and runs its odoo-bin) and forwards its stable `port` as
    cfg["worktree_port"]. Returns None if the id isn't in the config. The checkout
    branches aren't applied here — they're checked out separately."""
    target = next(
        (w for w in (config.get("workspaces") or []) if w.get("id") == workspace_id), None
    )
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
    for key in ("test_tags", "install", "upgrade", "memcheck"):
        if overrides.get(key):
            start[key] = overrides[key]
    cfg = {**config, "workspace": target["id"], "start": start}
    is_worktree = (
        target.get("location")
        or target.get("kind")
        or ("worktree" if target.get("worktree") else "plain")
    ) == "worktree"
    if is_worktree:
        d = _worktree_dir(config, target)
        github = {
            r["id"]: r.get("github", "")
            for r in config.get("repos", [])
            if isinstance(r, dict) and r.get("id")
        }
        # point repos at the worktree's on-disk copies; build_odoo_cmd derives the
        # main repo's path (and thus the addons-path + odoo-bin) from these
        cfg["repos"] = [
            {"id": rid, "path": f"{d}/{rid}", "github": github.get(rid, "")} for rid in repo_ids
        ]
        main_repo_id = config.get("main_repo_id") or "community"
        cfg["server_path"] = f"{d}/{main_repo_id}/odoo-bin"
        if target.get("port"):
            cfg["worktree_port"] = target["port"]
        # a workspace with its own venv (built from ITS OWN requirements.txt at
        # creation, VenvService) always launches through it, in place of whatever
        # venv_activate the global config carries. venv_python additionally pins
        # the exact interpreter (server.py's _odoo_cmd_base), so odoo-bin runs
        # under it regardless of its own shebang line.
        if (target.get("worktree") or {}).get("venv"):
            cfg["venv_activate"] = f"source {d}/.venv/bin/activate"
            cfg["venv_python"] = f"{d}/.venv/bin/python"
    return cfg
