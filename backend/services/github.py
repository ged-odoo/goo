"""GitHub PRs + CI rollups, fetched via the `gh` CLI."""

import json
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from typing import Any

from ..cache import TTLCache
from ..models import CiCheck, CiRollup, PullRequest
from .git import parse_github_slug

# ─────────────────────────── GitHub PRs (via the `gh` CLI) ───────────────────


def _ci_state(raw: str | None) -> str:
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


def _ci_rollup(rollup: list[dict[str, Any]] | None) -> CiRollup:
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


class _FetchFailed(Exception):
    """A gh call a review status depends on failed."""


class GitHubService:
    """The user's PRs and PR actions, via the `gh` CLI."""

    def __init__(self, io: Any, cache: TTLCache) -> None:
        self.io = io
        self.cache = cache
        self._login = None

    def prs(self, repos: list[dict[str, Any]], refresh: bool = False) -> list[dict[str, Any]]:
        """For each repo {id, github}: the user's PRs (all states). Cached per
        repo-set; pass refresh=True to bypass the cache."""
        key = tuple(sorted((r.get("id"), r.get("github")) for r in repos))
        if refresh:
            self.cache.invalidate(key)
        return self.cache.get(key, lambda: self._fetch(repos))

    def _fetch(self, repos: list[dict[str, Any]]) -> list[dict[str, Any]]:
        # one `gh pr list` per repo, in parallel (pool.map preserves order)
        valid = [r for r in repos if r.get("id") and r.get("github")]
        if not valid:
            return []
        with ThreadPoolExecutor(max_workers=min(8, len(valid))) as pool:
            return list(pool.map(self._fetch_one, valid))

    def _fetch_one(self, repo: dict[str, Any]) -> dict[str, Any]:
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
                    "number,title,body,url,state,isDraft,headRefName,createdAt,updatedAt,statusCheckRollup",
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
                            body=pr.get("body") or "",
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

    def prs_for_branches(
        self, pairs: list[dict[str, Any]], refresh: bool = False
    ) -> list[dict[str, Any]]:
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

    def _fetch_head(self, gh_repo: str, branch: str) -> dict[str, Any] | None:
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
                    "number,title,body,url,state,isDraft,headRefName,createdAt,updatedAt,statusCheckRollup",
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
                body=pr.get("body") or "",
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

    def pr_infos(self, pairs: list[dict[str, Any]], refresh: bool = False) -> list[dict[str, Any]]:
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

    def _fetch_info(self, gh_repo: str, number: int) -> dict[str, Any] | None:
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
                    "number,title,body,url,state,isDraft,headRefName,createdAt,updatedAt,statusCheckRollup",
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
                body=pr.get("body") or "",
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

    def review_statuses(self, pairs: list[dict[str, Any]], refresh: bool = False) -> dict[str, str]:
        """For each {github, number}: "reviewed" if the authenticated user has
        submitted a review on it since they were last (re-)requested, "commented"
        if they only commented (conversation or inline) since, else "to_review".
        Who r+'d it doesn't matter here — that's mergebot's own
        state, not this. Cached per (github, number); refresh=True bypasses it.
        Returns {"github#number": status}."""
        uniq = self._uniq_pairs(pairs)
        if not uniq:
            return {}
        if refresh:
            for gh_repo, number in uniq:
                self.cache.invalidate(("review", gh_repo, number))
        with ThreadPoolExecutor(max_workers=min(8, len(uniq))) as pool:
            statuses = pool.map(self._review_status, uniq)
        return {
            f"{gh_repo}#{number}": s for (gh_repo, number), s in zip(uniq, statuses, strict=True)
        }

    def _review_status(self, pair: tuple[str, int]) -> str:
        """Cached `_fetch_review_status`; a failed fetch reads as "to_review" but isn't cached."""
        gh_repo, number = pair
        try:
            return self.cache.get(
                ("review", gh_repo, number), lambda: self._fetch_review_status(gh_repo, number)
            )
        except _FetchFailed:
            return "to_review"

    def _fetch_review_status(self, gh_repo: str, number: int) -> str:
        """ "reviewed" if the authenticated user has submitted a review (any state
        — Odoo reviewers mostly leave plain "Comment" reviews, never GitHub's
        formal Approve/Request-changes) more recently than the last time they
        were (re-)requested, "commented" if they only left a conversation or
        inline comment since, else "to_review". Comparing timestamps — not
        GitHub's "current reviewRequests" list — matters here: GitHub only
        drops a user from that list on an Approve/Request-changes review, so
        for a Comment-only review it stays there forever and would otherwise
        always look "still requested"."""
        login = self._me()
        if not login:
            return "to_review"
        my_reviews = self._my_activity_times(
            gh_repo, number, login, "pulls", "reviews", "submitted_at"
        )
        my_comments = self._my_comment_times(gh_repo, number, login)
        if not my_reviews and not my_comments:
            return "to_review"
        last_request_at = self._last_review_request(gh_repo, number, login)
        if my_reviews and max(my_reviews) > last_request_at:
            return "reviewed"
        if my_comments and max(my_comments) > last_request_at:
            return "commented"
        return "to_review"

    def _my_comment_times(self, gh_repo: str, number: int, login: str) -> list[str]:
        """The creation times of `login`'s conversation and inline comments on a PR
        (a plain comment isn't a review, so `reviews` never lists it)."""
        return self._my_activity_times(
            gh_repo, number, login, "issues", "comments", "created_at"
        ) + self._my_activity_times(gh_repo, number, login, "pulls", "comments", "created_at")

    def _my_activity_times(
        self, gh_repo: str, number: int, login: str, kind: str, what: str, field: str
    ) -> list[str]:
        """The `field` timestamps of `login`'s entries in repos/<gh_repo>/<kind>/<number>/<what>
        (a REST call: `gh pr view` goes through GraphQL, which can hang for 30s). A pending
        review has no `submitted_at`, so it never counts. Raises _FetchFailed when gh fails,
        so the caller doesn't cache a guess."""
        path = f"repos/{gh_repo}/{kind}/{number}/{what}"
        self.io.log_request(f"gh api {path} --paginate")
        try:
            r = self.io.run(
                [
                    "gh",
                    "api",
                    path,
                    "--paginate",
                    "--jq",
                    f'.[] | "\\(.user.login) \\(.{field})"',
                ],
                timeout=30,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            raise _FetchFailed from e
        if r.returncode != 0:
            raise _FetchFailed
        times: list[str] = []
        for line in r.stdout.splitlines():
            who, _, at = line.strip().partition(" ")
            if who == login and at and at != "null":
                times.append(at)
        return times

    def _last_review_request(self, gh_repo: str, number: int, login: str) -> str:
        """The most recent time `login` was requested to review this PR (ISO
        timestamp, "" if never) — from the issue timeline, since a PR's current
        `reviewRequests` doesn't carry timing and (per above) often doesn't clear
        at all. Raises _FetchFailed when gh fails."""
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
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            raise _FetchFailed from e
        if r.returncode != 0:
            raise _FetchFailed
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

    def review_requests(self, query: str) -> tuple[list[dict[str, Any]], str | None]:
        """The PRs a GitHub issue search returns (e.g. `review-requested:@me`), newest
        update first, as ({github, number, title, url, author, draft, labels,
        updated_at}, error). Uncached: a review request is waited on, not polled."""
        return self._fetch_review_requests(query)

    def _fetch_review_requests(self, query: str) -> tuple[list[dict[str, Any]], str | None]:
        self.io.log_request(f"gh api search/issues q={query}")
        jq = (
            '.items[] | {github: (.repository_url | sub(".*/repos/"; "")), number, title,'
            " url: .html_url, author: .user.login, draft, labels: [.labels[].name],"
            " updated_at}"
        )
        cmd = ["gh", "api", "-X", "GET", "search/issues", "-f", f"q=is:pr {query}"]
        cmd += ["-f", "sort=updated", "-f", "per_page=100", "--jq", jq]
        try:
            r = self.io.run(cmd, timeout=30)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return [], str(e) or "gh unavailable"
        if r.returncode != 0:
            return [], (r.stderr or "").strip() or "gh failed"
        try:
            return [json.loads(line) for line in r.stdout.splitlines() if line.strip()], None
        except json.JSONDecodeError:
            return [], "unreadable gh output"

    def _me(self) -> str:
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
    def _uniq_pairs(pairs: list[dict[str, Any]]) -> list[tuple[str, int]]:
        seen, uniq = set(), []
        for p in pairs:
            gh_repo, number = p.get("github"), p.get("number")
            if not (gh_repo and number) or (gh_repo, number) in seen:
                continue
            seen.add((gh_repo, number))
            uniq.append((gh_repo, number))
        return uniq

    def close_pr(self, github: str, number: int) -> tuple[bool, str | None]:
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

    def ready_pr(self, github: str, number: int) -> tuple[bool, str | None]:
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

    def post_r_plus(self, github: str, number: int) -> tuple[bool, str | None]:
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

    def pr_head(self, github: str, number: int) -> tuple[str, str | None]:
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

    def search_branches(self, repos: list[dict[str, Any]], query: str) -> list[dict[str, str]]:
        """Search GitHub for branches whose name starts with `query`, across each
        repo's upstream (`github`) slug and its push remote's fork slug — a branch
        pushed only to a personal/team fork never reaches upstream, so both are
        searched (one `gh api` call per slug, in parallel across repos). Each
        result also carries the git remote name to fetch it from (`pull_remote`
        for an upstream match, else the fork's `push_remote`) — a caller that
        blindly fetches from `pull_remote` gets "couldn't find remote ref" for a
        fork-only branch. Returns a list of {repo: id, branch: name, remote: name}."""
        results = []
        lock = threading.Lock()

        def matching_refs(slug: str) -> list[str]:
            try:
                res = self.io.run(
                    [
                        "gh",
                        "api",
                        f"repos/{slug}/git/matching-refs/heads/{query}",
                        "--jq",
                        ".[].ref",
                    ],
                    timeout=15,
                )
                if res.returncode != 0:
                    return []
            except (FileNotFoundError, subprocess.TimeoutExpired):
                return []
            found = []
            for line in res.stdout.splitlines():
                branch = line.strip()
                if branch.startswith("refs/heads/"):
                    branch = branch[len("refs/heads/") :]
                if branch:
                    found.append(branch)
            return found

        def fork_slug(r: dict[str, Any]) -> str | None:
            path, push_remote = r.get("path"), r.get("push_remote")
            if not path or not push_remote:
                return None
            try:
                pu = self.io.run(
                    ["git", "-C", path, "remote", "get-url", push_remote], timeout=10, quiet=True
                )
            except (FileNotFoundError, subprocess.TimeoutExpired):
                return None
            return parse_github_slug(pu.stdout.strip()) if pu.returncode == 0 else None

        def search_one(r: dict[str, Any]) -> None:
            found = {}  # branch -> remote name; an upstream match wins over a fork one
            github = r.get("github", "")
            if github:
                for branch in matching_refs(github):
                    found[branch] = r.get("pull_remote") or "origin"
            fork = fork_slug(r)
            if fork and fork != github:
                push_remote = r.get("push_remote") or "dev"
                for branch in matching_refs(fork):
                    found.setdefault(branch, push_remote)
            with lock:
                for branch, remote in found.items():
                    results.append({"repo": r["id"], "branch": branch, "remote": remote})

        threads = [threading.Thread(target=search_one, args=(r,), daemon=True) for r in repos]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=20)
        return results
