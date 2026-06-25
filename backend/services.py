"""Domain services over the IO seam (effects.py).

Each service takes an `io` object (the effects module, or a fake in tests) and a
TTLCache, so it can be unit-tested without real subprocesses or network. This is
where external state (GitHub PRs, runbot, mergebot) is fetched, parsed, and cached
server-side; the HTTP handlers in goo.py just delegate here.
"""

import ast
import json
import os
import re
import subprocess
import threading
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

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
        return {
            "repo": (node.get("repository") or {}).get("nameWithOwner", ""),
            "number": node.get("number"),
            "title": node.get("title", ""),
            "url": node.get("url", ""),
            "state": (node.get("state") or "").lower(),  # open / closed / merged
            "draft": node.get("isDraft", False),
            "branch": node.get("headRefName", ""),
            "updatedAt": node.get("updatedAt", ""),
        }

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


# ─────────────────────────── PostgreSQL databases ───────────────────────────


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
        with ThreadPoolExecutor(max_workers=min(8, len(names))) as pool:
            infos = list(pool.map(self.odoo_info, names))  # one psql per db, in parallel
        return [
            {
                "name": n,
                "odoo_version": v,
                "enterprise": e,
                "last_update": u,
                "created": created.get(n),
            }
            for n, (v, e, u) in zip(names, infos, strict=False)
        ]

    def drop(self, name):
        """Drop a database. Returns (ok, error); invalidates the list cache."""
        try:
            r = self.io.run(["dropdb", name], timeout=15)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e)
        if r.returncode != 0:
            return False, r.stderr.strip() or "dropdb failed"
        self.cache.invalidate("list")
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
        """(version, is_enterprise, last_update) of the odoo in a database, or
        (None, False, None) if it holds no odoo. last_update is the UTC timestamp
        of the last detectable activity (cron writes, login rows)."""
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
                    " GREATEST((SELECT max(write_date) FROM ir_cron),"
                    " (SELECT max(create_date) FROM res_users_log))",
                ],
                timeout=5,
                quiet=True,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return None, False, None
        line = r.stdout.strip()
        if r.returncode != 0 or not line:
            return None, False, None  # no odoo tables: not an odoo database
        version, enterprise, last_update = line.split("|", 2)
        return version or None, enterprise == "t", last_update or None

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
        with their last-commit date, plus dirty / pushed / ahead-behind state."""
        out = []
        for repo in repos:
            rid = repo.get("id")
            path = os.path.expanduser(repo.get("path", ""))
            if not rid or not path:
                continue
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
                    out.append(entry)
                    continue
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
                # branch names with a remote-tracking ref (pushed from this clone)
                rr = self.io.run(
                    [
                        "git",
                        "-C",
                        path,
                        "for-each-ref",
                        "refs/remotes",
                        "--format=%(refname:lstrip=3)",
                    ],
                    timeout=10,
                )
                remote_branches = set(rr.stdout.split())
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
                        entry["branches"].append(
                            {
                                "name": name,
                                "date": parts[1] if len(parts) > 1 else "",
                                "subject": parts[2] if len(parts) > 2 else "",
                                "sha": parts[3] if len(parts) > 3 else "",
                                "remote": name in remote_branches,
                            }
                        )
            except (FileNotFoundError, subprocess.TimeoutExpired) as e:
                entry["error"] = str(e)
            out.append(entry)
        return out

    def checkout(self, path, branch):
        """Checkout a local branch in a repo. Returns (ok, error)."""
        if not path or not branch:
            return False, "missing path or branch"
        try:
            r = self.io.run(["git", "-C", os.path.expanduser(path), "checkout", branch], timeout=60)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e)
        if r.returncode != 0:
            return False, r.stderr.strip().split("\n")[0] or "git checkout failed"
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
        try:
            self.notify(f"fetching {base} ({label})")
            f = self.io.run(["git", "-C", p, "fetch", remote, base], timeout=180)
            if f.returncode != 0:
                return False, (f.stderr.strip() or "git fetch failed").split("\n")[0]
            self.notify(f"rebasing {label} onto {base}")
            r = self.io.run(["git", "-C", p, "rebase", "FETCH_HEAD"], timeout=120)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e)
        if r.returncode != 0:
            msg = (r.stderr.strip() or r.stdout.strip()).split("\n")[0]
            return False, msg or "git rebase failed"
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
