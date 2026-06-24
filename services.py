"""Domain services over the IO seam (effects.py).

Each service takes an `io` object (the effects module, or a fake in tests) and a
TTLCache, so it can be unit-tested without real subprocesses or network. This is
where external state (GitHub PRs, runbot, mergebot) is fetched, parsed, and cached
server-side; the HTTP handlers in goo.py just delegate here.
"""

import json
import re
import subprocess
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

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
    """Compress a PR's statusCheckRollup into {overall, runbot, checks}.

    `checks` is [{context, state, url}] (state normalized via _ci_state); `runbot`
    is the ci/runbot context's state; `overall` is failure if any check failed,
    else pending if any is still pending, else success if all passed (else "").
    Handles both StatusContext (.context/.state, what Odoo's CI posts) and
    CheckRun (.name/.status/.conclusion)."""
    checks = []
    for c in rollup or []:
        context = c.get("context") or c.get("name") or ""
        if not context:
            continue
        raw = c.get("state") or c.get("conclusion") or c.get("status") or ""
        checks.append(
            {
                "context": context,
                "state": _ci_state(raw),
                "url": c.get("targetUrl") or c.get("detailsUrl") or "",
            }
        )
    checks.sort(key=lambda c: c["context"])
    states = {c["state"] for c in checks}
    if "failure" in states:
        overall = "failure"
    elif "pending" in states:
        overall = "pending"
    elif states == {"success"}:
        overall = "success"
    else:
        overall = ""
    runbot = next((c["state"] for c in checks if c["context"] == "ci/runbot"), "")
    return {"overall": overall, "runbot": runbot, "checks": checks}


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
        out = []
        for repo in repos:
            rid, gh_repo = repo.get("id"), repo.get("github")
            if not rid or not gh_repo:
                continue
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
                        "number,title,url,state,isDraft,headRefName,updatedAt,statusCheckRollup",
                    ],
                    timeout=30,
                )
                if r.returncode != 0:
                    entry["error"] = r.stderr.strip().split("\n")[0] or "gh failed"
                else:
                    prs = json.loads(r.stdout)
                    for pr in prs:
                        pr["ci"] = _ci_rollup(pr.pop("statusCheckRollup", None))
                    entry["prs"] = prs
            except (FileNotFoundError, subprocess.TimeoutExpired) as e:
                entry["error"] = str(e)
            except json.JSONDecodeError:
                entry["error"] = "unexpected gh output"
            out.append(entry)
        return out

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
        """`result` ("success"/"failure"/"") comes from the bundle page favicon
        (icon_ok/icon_ko/icon_killed …) — runbot's own overall verdict, which
        already reflects a failure even mid-run. `running` is true when the latest
        batch still has a build in progress (runbot colours it btn-info / fa-spin).
        Falls back to the badge's last-finished result if the page can't be read."""
        html, _ = self.io.http_get(f"{RUNBOT_BASE}/runbot/bundle/{urllib.parse.quote(branch)}")
        if not html:
            s = self._badge(branch)
            return {"result": s if s in ("success", "failure") else "", "running": s == "pending"}
        m = re.search(r'rel="[^"]*icon"[^>]*href="[^"]*?icon_([a-z]+)\.', html)
        state = m.group(1) if m else ""
        result = "failure" if state in ("ko", "killed") else "success" if state == "ok" else ""
        parts = html.split('class="batch_tile', 1)
        latest = parts[1].split('class="batch_tile', 1)[0] if len(parts) > 1 else ""
        running = "btn-info" in latest or "fa-spin" in latest
        return {"result": result, "running": running}

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
        """{"github#number": state} for the given PRs, cached per PR and fetched in
        parallel. Pass refresh=True to bypass the cache."""
        prs = [p for p in prs if p.get("github") and p.get("number")]
        if not prs:
            return {}
        if refresh:
            for p in prs:
                self.cache.invalidate(f"{p['github']}#{p['number']}")
        with ThreadPoolExecutor(max_workers=min(8, len(prs))) as pool:
            states = pool.map(
                lambda p: self.cache.get(
                    f"{p['github']}#{p['number']}",
                    lambda p=p: self._status(p["github"], p["number"]),
                ),
                prs,
            )
            return {f"{p['github']}#{p['number']}": s for p, s in zip(prs, states, strict=False)}

    def _status(self, github, number):
        """The merge state, e.g. 'blocked', 'staged', 'merged' ("" on failure /
        unknown). State is rendered inconsistently (a colored <p> for blocked/
        staged/ready/…, an alert <div> for merged/closed), so scan for the first
        element with a bg-* or alert class whose leading word is a known state."""
        html, _ = self.io.http_get(f"{MERGEBOT_BASE}/{github}/pull/{number}")
        if not html:
            return ""
        for m in re.finditer(
            r'<\w+[^>]*class="[^"]*(?:\bbg-\w+|\balert\b)[^"]*"[^>]*>(.*?)</', html, re.S
        ):
            txt = re.sub(r"<[^>]+>", " ", m.group(1)).strip()
            if not txt:
                continue
            word = re.sub(r"[^a-z]", "", txt.split()[0].lower())
            if word in MERGEBOT_STATES:
                return word
        return ""
