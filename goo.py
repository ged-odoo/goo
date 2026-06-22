#!/usr/bin/env python3
"""goo - GED Odoo Overseer, a local web app for Odoo development.

Run `python3 goo.py`, open the printed URL (or pass --open to open it in the
browser right away). The frontend (static/) holds the configuration and posts
it with each start request; the backend is stateless.
"""

import argparse
import ast
import atexit
import base64
import collections
import fcntl
import hashlib
import json
import mimetypes
import os
import pty
import queue
import re
import shlex
import signal
import socket
import struct
import subprocess
import sys
import termios
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TAG = "[goo]"
HOST = "127.0.0.1"
PORT = 8068
ODOO_PORT = 8069
READY_MARKER = "odoo.registry: Registry loaded"
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
ADDONS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "addons")
LOG_BUFFER_SIZE = 2000


def log_request(target):
    """Announce an outgoing network request on the terminal, so the user can
    see what goo is reaching out to (runbot, GitHub, git remotes)."""
    print(f"{TAG} {time.strftime('%H:%M:%S')} → {target}", flush=True)


# =============================================================================
# Event bus: log ring buffer + SSE fan-out
# =============================================================================


class EventBus:
    def __init__(self, maxlen=LOG_BUFFER_SIZE):
        self._lock = threading.Lock()
        self._buffer = collections.deque(maxlen=maxlen)
        self._subscribers = []

    def publish_log(self, line):
        with self._lock:
            self._buffer.append(line)
            subscribers = list(self._subscribers)
        for q in subscribers:
            q.put(("log", {"line": line}))

    def publish_status(self, status):
        with self._lock:
            subscribers = list(self._subscribers)
        for q in subscribers:
            q.put(("status", status))

    def publish_event(self, text, level=""):
        """A business event: logged to the goo server stdout and pushed to the
        browser event log via an SSE 'event' message (level "error" tints it)."""
        print(f"{TAG} {time.strftime('%H:%M:%S')} • {text}", flush=True)
        with self._lock:
            subscribers = list(self._subscribers)
        for q in subscribers:
            q.put(("event", {"text": text, "level": level}))

    def subscribe(self):
        """Register a client queue. Returns (queue, log backlog) atomically so
        no line is lost between the backlog replay and the live stream."""
        q = queue.Queue()
        with self._lock:
            backlog = list(self._buffer)
            self._subscribers.append(q)
        return q, backlog

    def unsubscribe(self, q):
        with self._lock:
            try:
                self._subscribers.remove(q)
            except ValueError:
                pass


# =============================================================================
# Helpers
# =============================================================================


def free_port():
    """An OS-assigned free TCP port, so a CLI test run can use its own http /
    gevent ports and not clash with the running server's."""
    with socket.socket() as s:
        s.bind((HOST, 0))
        return s.getsockname()[1]


def port_busy(port):
    try:
        with socket.create_connection((HOST, port), timeout=0.3):
            return True
    except OSError:
        return False


def kill_port(port):
    """Kill any process listening on the given port."""
    try:
        result = subprocess.run(
            ["lsof", "-ti", f":{port}"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        for pid_str in result.stdout.strip().split("\n"):
            if pid_str.strip():
                try:
                    os.kill(int(pid_str.strip()), signal.SIGKILL)
                except (ProcessLookupError, ValueError, OSError):
                    pass
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass


def db_initialized(db_name):
    """Check if the database exists AND holds an initialized odoo schema.

    A database can exist as an empty shell (e.g. leftover from an aborted
    run); odoo then refuses to load it without -i, so treat it as new.
    """
    try:
        result = subprocess.run(
            [
                "psql",
                "-d",
                db_name,
                "-tAc",
                "SELECT 1 FROM information_schema.tables WHERE table_name = 'ir_module_module'",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            return False  # database doesn't exist
        return result.stdout.strip() == "1"
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return True  # can't check: assume initialized, avoid surprise installs


def odoo_info(db_name):
    """(version, is_enterprise, last_update) of the odoo installed in a
    database. (None, False, None) if it holds no odoo.

    last_update is a UTC timestamp of the last detectable activity: crons
    are written whenever a server runs against the db, logins create
    res_users_log rows."""
    try:
        result = subprocess.run(
            [
                "psql",
                "-d",
                db_name,
                "-tAc",
                "SELECT (SELECT latest_version FROM ir_module_module WHERE name = 'base'),"
                " EXISTS (SELECT 1 FROM ir_module_module"
                " WHERE name = 'web_enterprise' AND state = 'installed'),"
                " GREATEST((SELECT max(write_date) FROM ir_cron),"
                " (SELECT max(create_date) FROM res_users_log))",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        line = result.stdout.strip()
        if result.returncode != 0 or not line:
            return None, False, None  # no odoo tables: not an odoo database
        version, enterprise, last_update = line.split("|", 2)
        return version or None, enterprise == "t", last_update or None
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None, False, None


def db_creation_times():
    """Map db name -> creation timestamp (naive UTC ISO), from the mtime of
    each database's PG_VERSION file. Needs superuser / pg_read_server_files;
    returns {} if unavailable."""
    try:
        r = subprocess.run(
            [
                "psql",
                "-d",
                "postgres",
                "-tAc",
                "SELECT datname,"
                " (pg_stat_file('base/' || oid || '/PG_VERSION')).modification AT TIME ZONE 'UTC'"
                " FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres'",
            ],
            capture_output=True,
            text=True,
            timeout=5,
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


def list_databases():
    """All non-template databases with their odoo version. Raises RuntimeError."""
    try:
        result = subprocess.run(
            [
                "psql",
                "-d",
                "postgres",
                "-tAc",
                "SELECT datname FROM pg_database"
                " WHERE NOT datistemplate AND datname <> 'postgres'"
                " ORDER BY datname",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        raise RuntimeError(f"cannot list databases: {e}") from e
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "psql failed")
    created = db_creation_times()
    dbs = []
    for line in result.stdout.split("\n"):
        name = line.strip()
        if not name:
            continue
        version, enterprise, last_update = odoo_info(name)
        dbs.append(
            {
                "name": name,
                "odoo_version": version,
                "enterprise": enterprise,
                "last_update": last_update,
                "created": created.get(name),
            }
        )
    return dbs


def drop_database(db_name):
    """Drop a database. Returns (ok, error)."""
    try:
        result = subprocess.run(
            ["dropdb", db_name],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return False, str(e)
    if result.returncode != 0:
        return False, result.stderr.strip() or "dropdb failed"
    return True, None


def read_data_file(path):
    """Read a JSON data file. Returns (data, error). A missing file is not an
    error: it returns (None, None) so the caller can create it on first use."""
    p = os.path.expanduser(path)
    if not os.path.exists(p):
        return None, None
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f), None
    except (OSError, ValueError) as e:
        return None, str(e)


def write_data_file(path, data):
    """Write data as pretty JSON to a file, creating parent dirs. (ok, error)."""
    p = os.path.expanduser(path)
    try:
        parent = os.path.dirname(p)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        return True, None
    except OSError as e:
        return False, str(e)


_BASE_BRANCH_RE = re.compile(r"^(saas-\d+\.\d+|\d+\.\d+|master)")


def base_branch(name):
    """The canonical base a branch derives from (master-owl-update -> master,
    19.0-fix -> 19.0). Defaults to master."""
    m = _BASE_BRANCH_RE.match(name or "")
    return m.group(1) if m else "master"


def git_branches(repos):
    """For each repo {id, path}: the checked-out branch and all local
    branches with their last-commit date."""
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
            r = subprocess.run(
                ["git", "-C", path, "branch", "--show-current"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if r.returncode != 0:
                entry["error"] = r.stderr.strip().split("\n")[0] or "not a git repository"
                out.append(entry)
                continue
            entry["current"] = r.stdout.strip() or "(detached)"
            # uncommitted changes in the working tree (only the current branch)
            st = subprocess.run(
                ["git", "-C", path, "status", "--porcelain"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            entry["dirty"] = bool(st.stdout.strip())
            # HEAD's sha + last commit subject + date (for the dashboard summary)
            hl = subprocess.run(
                ["git", "-C", path, "log", "-1", "--format=%H%n%s%n%cI"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if hl.returncode == 0:
                lines = hl.stdout.splitlines()
                entry["head_sha"] = lines[0] if lines else ""
                entry["head_subject"] = lines[1] if len(lines) > 1 else ""
                entry["head_date"] = lines[2] if len(lines) > 2 else ""
            # is HEAD reachable from any remote ref? (i.e. pushed -> linkable)
            rp = subprocess.run(
                ["git", "-C", path, "rev-list", "HEAD", "--not", "--remotes", "--count"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if rp.returncode == 0:
                entry["head_pushed"] = rp.stdout.strip() == "0"
            # how far the current branch diverges from its canonical base (the
            # "target" it would rebase onto), e.g. master-owl-update vs origin/master
            base = base_branch(entry["current"])
            ref = f"{main_remote(path, repo.get('github'))}/{base}"
            ad = subprocess.run(
                ["git", "-C", path, "rev-list", "--left-right", "--count", f"{ref}...HEAD"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if ad.returncode == 0 and len(ad.stdout.split()) == 2:
                behind, ahead = ad.stdout.split()
                entry["behind"], entry["ahead"] = int(behind), int(ahead)
            # branch names that have a remote-tracking ref, i.e. were pushed to
            # some remote from this clone (refname minus refs/remotes/<remote>/)
            rr = subprocess.run(
                ["git", "-C", path, "for-each-ref", "refs/remotes", "--format=%(refname:lstrip=3)"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            remote_branches = set(rr.stdout.split())
            entry["head_remote"] = entry["current"] in remote_branches
            r = subprocess.run(
                [
                    "git",
                    "-C",
                    path,
                    "for-each-ref",
                    "refs/heads",
                    "--format=%(refname:short)%09%(committerdate:iso8601-strict)%09%(contents:subject)%09%(objectname)",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            for line in r.stdout.splitlines():
                parts = line.split("\t")
                name = parts[0]
                date = parts[1] if len(parts) > 1 else ""
                subject = parts[2] if len(parts) > 2 else ""
                sha = parts[3] if len(parts) > 3 else ""
                if name:
                    entry["branches"].append(
                        {
                            "name": name,
                            "date": date,
                            "subject": subject,
                            "sha": sha,
                            "remote": name in remote_branches,
                        }
                    )
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            entry["error"] = str(e)
        out.append(entry)
    # runbot status is fetched lazily for the few branches the dashboard shows
    # (see /api/runbot) rather than for every branch on every load.
    return out


def git_delete_branch(path, branch, delete_remote=False):
    """Force-delete a local branch, and optionally its branch on the odoo-dev
    remote too. Returns (ok, error, remote_error): `ok`/`error` are for the local
    delete; `remote_error` is set when the local delete succeeded but the remote
    branch could not be removed (None on success or when not requested)."""
    path = os.path.expanduser(path)
    try:
        result = subprocess.run(
            ["git", "-C", path, "branch", "-D", branch],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return False, str(e), None
    if result.returncode != 0:
        return False, result.stderr.strip().split("\n")[0] or "git branch -D failed", None
    remote_error = None
    if delete_remote:
        # only delete on the dev fork when the branch is actually there. A branch
        # that was never pushed (or only exists on the canonical remote) has
        # nothing to remove, so don't try — and don't report a spurious failure.
        exists, _ = remote_branch_exists(path, branch)
        if exists:
            remote, _ = dev_remote(path)
            log_request(f"git push {remote} --delete {branch}")
            try:
                r = subprocess.run(
                    ["git", "-C", path, "push", remote, "--delete", branch],
                    capture_output=True,
                    text=True,
                    timeout=120,
                )
                if r.returncode != 0:
                    remote_error = r.stderr.strip().split("\n")[-1] or "git push --delete failed"
            except (FileNotFoundError, subprocess.TimeoutExpired) as e:
                remote_error = str(e)
    return True, None, remote_error


def git_wip_commit(path):
    """Stage all changes and create a WIP commit. Returns (ok, error)."""
    path = os.path.expanduser(path)
    try:
        r = subprocess.run(
            ["git", "-C", path, "add", "-A"],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode != 0:
            return False, r.stderr.strip() or "git add failed"
        r = subprocess.run(
            ["git", "-C", path, "commit", "--no-verify", "-m", "WIP"],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode != 0:
            return False, r.stderr.strip() or "git commit failed"
        return True, None
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return False, str(e)


def git_log(path, n=20, ref=""):
    """Return the last n commits on <ref> (default: the current branch / HEAD).
    Returns (commits, error); commits is a list of {sha, author, date, subject,
    body}. Fields are \\x1f-separated, commits \\x1e-terminated so multi-line
    bodies survive."""
    path = os.path.expanduser(path)
    cmd = ["git", "-C", path, "log", "-n", str(n),
           "--format=%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1e"]
    if ref:
        cmd += [ref, "--"]  # log a specific branch; -- disambiguates ref from a path
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
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
            commits.append({
                "sha": parts[0],
                "author": parts[1],
                "date": parts[2],
                "subject": parts[3],
                "body": parts[4].strip() if len(parts) > 4 else "",
            })
        return commits, None
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return None, str(e)


def git_discard(path):
    """Make the working tree pristine: reset tracked files (staged + unstaged)
    to HEAD, then remove untracked files/dirs. Mirrors the dirty check, which
    flags any non-empty `git status --porcelain` (untracked files included).
    `git clean -fd` (no -x) leaves ignored files alone. Returns (ok, error)."""
    path = os.path.expanduser(path)
    try:
        r = subprocess.run(
            ["git", "-C", path, "reset", "--hard", "HEAD"],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode != 0:
            return False, r.stderr.strip() or "git reset failed"
        r = subprocess.run(
            ["git", "-C", path, "clean", "-fd"],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode != 0:
            return False, r.stderr.strip() or "git clean failed"
        return True, None
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return False, str(e)


def search_remote_branches(repos, query):
    """Search GitHub for branches whose name starts with `query`, across all
    repos that have a github field. Runs one gh api call per repo in parallel.
    Returns a list of {repo: id, branch: name} dicts."""
    results = []
    lock = threading.Lock()

    def search_one(r):
        github = r.get("github", "")
        if not github:
            return
        try:
            res = subprocess.run(
                ["gh", "api", f"repos/{github}/git/matching-refs/heads/{query}",
                 "--jq", ".[].ref"],
                capture_output=True, text=True, timeout=15,
            )
            if res.returncode != 0:
                return
            found = []
            for line in res.stdout.splitlines():
                branch = line.strip()
                if branch.startswith("refs/heads/"):
                    branch = branch[len("refs/heads/"):]
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


def git_fetch_remote_branch(path, branch):
    """Fetch a remote branch and create/reset the local branch to track it.
    Equivalent to: git fetch origin {branch}:{branch}. Returns (ok, error)."""
    path = os.path.expanduser(path)
    try:
        r = subprocess.run(
            ["git", "-C", path, "fetch", "origin", f"{branch}:{branch}"],
            capture_output=True, text=True, timeout=60,
        )
        if r.returncode != 0:
            return False, r.stderr.strip().split("\n")[0] or "git fetch failed"
        return True, None
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return False, str(e)


def git_checkout(path, branch):
    """Checkout a local branch in a repo. Returns (ok, error)."""
    if not path or not branch:
        return False, "missing path or branch"
    try:
        result = subprocess.run(
            ["git", "-C", os.path.expanduser(path), "checkout", branch],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return False, str(e)
    if result.returncode != 0:
        return False, result.stderr.strip().split("\n")[0] or "git checkout failed"
    return True, None


def git_branch_create(path, name, start_point):
    """Create a new local branch <name> at <start_point> WITHOUT checking it out
    (the working tree / current branch is left untouched). Returns (ok, error)."""
    if not path or not name or not start_point:
        return False, "missing path, name or start point"
    try:
        result = subprocess.run(
            ["git", "-C", os.path.expanduser(path), "branch", name, start_point],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return False, str(e)
    if result.returncode != 0:
        return False, result.stderr.strip().split("\n")[0] or "git branch failed"
    return True, None


def git_fetch_rebase(path, base, github):
    """Fetch the base branch from the canonical (main) repo and rebase the
    current branch onto it — e.g. master-owl-update is rebased onto odoo/odoo's
    master. Returns (ok, error); on conflict the rebase is left in progress for
    manual resolution."""
    if not path or not base:
        return False, "missing path or base branch"
    remote = main_remote(path, github)
    if not remote:
        return False, f"no remote points at {github}"
    p = os.path.expanduser(path)
    try:
        f = subprocess.run(
            ["git", "-C", p, "fetch", remote, base],
            capture_output=True,
            text=True,
            timeout=180,
        )
        if f.returncode != 0:
            return False, (f.stderr.strip() or "git fetch failed").split("\n")[0]
        r = subprocess.run(
            ["git", "-C", p, "rebase", "FETCH_HEAD"],
            capture_output=True,
            text=True,
            timeout=120,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return False, str(e)
    if r.returncode != 0:
        msg = (r.stderr.strip() or r.stdout.strip()).split("\n")[0]
        return False, msg or "git rebase failed"
    return True, None


def runbot_badge_status(branch):
    """Fetch the runbot status badge for a branch and parse its result.

    Returns "success", "failure", "pending", or "" (no build / unreachable).
    The badge SVG carries the status as its right-hand <text> label, e.g.
    <text ...>success</text>.
    """
    url = f"https://runbot.odoo.com/runbot/badge/1/{urllib.parse.quote(branch)}.svg"
    log_request(f"GET {url}")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "goo/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            svg = resp.read().decode("utf-8", errors="replace")
    except Exception:
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


def runbot_bundle_page(branch):
    """Fetch a bundle's runbot page HTML ("" if unreachable)."""
    url = f"https://runbot.odoo.com/runbot/bundle/{urllib.parse.quote(branch)}"
    log_request(f"GET {url}")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "goo/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except Exception:
        return ""


def runbot_status(branch):
    """Runbot status for a branch's bundle as {"result": ..., "running": bool}.

    `result` ("success" / "failure" / "") comes from the bundle page favicon
    (icon_ok / icon_ko / icon_killed …) — runbot's own overall verdict, which
    already reflects a failure even mid-run. `running` is true when the latest
    batch still has a build in progress — runbot colours an in-progress build
    `btn-info` (blue), which reliably distinguishes a running batch from a
    finished one. So the UI can show the result *and* a "still running" indicator
    at once. Falls back to the badge's last-finished result if the page can't be
    read."""
    html = runbot_bundle_page(branch)
    if not html:
        s = runbot_badge_status(branch)
        return {"result": s if s in ("success", "failure") else "", "running": s == "pending"}
    m = re.search(r'rel="[^"]*icon"[^>]*href="[^"]*?icon_([a-z]+)\.', html)
    state = m.group(1) if m else ""
    result = "failure" if state in ("ko", "killed") else "success" if state == "ok" else ""
    parts = html.split('class="batch_tile', 1)
    latest = parts[1].split('class="batch_tile', 1)[0] if len(parts) > 1 else ""
    running = "btn-info" in latest or "fa-spin" in latest
    return {"result": result, "running": running}


def runbot_statuses(branches):
    """For a list of branch names: their runbot status keyed by name, fetched
    in parallel."""
    branches = [b for b in dict.fromkeys(branches) if b]  # unique, non-empty
    if not branches:
        return {}
    with ThreadPoolExecutor(max_workers=min(8, len(branches))) as pool:
        states = pool.map(runbot_status, branches)
        return dict(zip(branches, states, strict=False))


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


def mergebot_status(github, number):
    """Scrape the mergebot PR page and return its merge state, e.g. 'blocked',
    'staged', 'merged' ("" on failure / unknown). The state is rendered
    inconsistently per state (a colored <p> for blocked/staged/ready/…, an alert
    <div> for merged/closed), so scan for the first element with a bg-* or alert
    class whose leading word is a known state."""
    url = f"https://mergebot.odoo.com/{github}/pull/{number}"
    log_request(f"GET {url}")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "goo/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            html = resp.read().decode("utf-8", errors="replace")
    except Exception:
        return ""
    for m in re.finditer(r'<\w+[^>]*class="[^"]*(?:\bbg-\w+|\balert\b)[^"]*"[^>]*>(.*?)</', html, re.S):
        txt = re.sub(r"<[^>]+>", " ", m.group(1)).strip()
        if not txt:
            continue
        word = re.sub(r"[^a-z]", "", txt.split()[0].lower())
        if word in MERGEBOT_STATES:
            return word
    return ""


def mergebot_statuses(prs):
    """For a list of {github, number}: their mergebot states keyed
    'github#number', fetched in parallel."""
    prs = [p for p in prs if p.get("github") and p.get("number")]
    if not prs:
        return {}
    with ThreadPoolExecutor(max_workers=min(8, len(prs))) as pool:
        states = pool.map(lambda p: mergebot_status(p["github"], p["number"]), prs)
        return {f"{p['github']}#{p['number']}": s for p, s in zip(prs, states, strict=False)}


def github_prs(repos):
    """For each repo {id, github}: the user's PRs (all states) via the gh CLI."""
    out = []
    for repo in repos:
        rid, gh_repo = repo.get("id"), repo.get("github")
        if not rid or not gh_repo:
            continue
        entry = {"id": rid, "github": gh_repo, "prs": [], "error": None}
        log_request(f"gh pr list --repo {gh_repo} --author @me")
        try:
            r = subprocess.run(
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
                    "number,title,url,state,isDraft,headRefName,updatedAt",
                ],
                capture_output=True,
                text=True,
                timeout=30,
            )
            if r.returncode != 0:
                entry["error"] = r.stderr.strip().split("\n")[0] or "gh failed"
            else:
                entry["prs"] = json.loads(r.stdout)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            entry["error"] = str(e)
        except json.JSONDecodeError:
            entry["error"] = "unexpected gh output"
        out.append(entry)
    return out


def _addon_roots(repo_id, path):
    """Directories that hold modules for a repo, matching the addons-path."""
    p = os.path.expanduser(path)
    if repo_id == "community":
        return [os.path.join(p, "addons"), os.path.join(p, "odoo", "addons")]
    return [p]


def module_manifest(module_path):
    """Parse a module's __manifest__.py into a dict, or None."""
    manifest = os.path.join(module_path, "__manifest__.py")
    try:
        with open(manifest, encoding="utf-8") as f:
            tree = ast.parse(f.read())
    except (OSError, SyntaxError):
        return None
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            try:
                return ast.literal_eval(node)
            except (ValueError, TypeError):
                return None
    return None


def installed_modules(db):
    """Map of module name -> state from a database (empty if unreadable)."""
    try:
        r = subprocess.run(
            ["psql", "-d", db, "-tAc", "SELECT name, state FROM ir_module_module"],
            capture_output=True,
            text=True,
            timeout=5,
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


def list_addons(repos):
    """Scan each repo {id, path} for modules with a manifest. A module name
    found in an earlier repo wins (community before enterprise, etc.)."""
    mods = []
    seen = set()
    for repo in repos:
        rid, path = repo.get("id"), repo.get("path")
        if not rid or not path:
            continue
        for root in _addon_roots(rid, path):
            if not os.path.isdir(root):
                continue
            for name in sorted(os.listdir(root)):
                if name.startswith((".", "_")) or name in seen:
                    continue
                man = module_manifest(os.path.join(root, name))
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


def dev_remote(path):
    """Name of the remote pointing at the odoo-dev fork. (remote, error)."""
    try:
        r = subprocess.run(
            ["git", "-C", os.path.expanduser(path), "remote", "-v"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return None, str(e)
    for line in r.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 2 and "odoo-dev" in parts[1]:
            return parts[0], None
    return None, "no odoo-dev remote configured"


def remote_branch_exists(path, branch):
    """Whether <branch> exists on the odoo-dev remote. (exists, error)."""
    remote, err = dev_remote(path)
    if err:
        return None, err
    log_request(f"git ls-remote {remote} {branch}")
    try:
        r = subprocess.run(
            ["git", "-C", os.path.expanduser(path), "ls-remote", "--heads", remote, branch],
            capture_output=True,
            text=True,
            timeout=20,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return None, str(e)
    if r.returncode != 0:
        return None, r.stderr.strip().split("\n")[0] or "git ls-remote failed"
    return bool(r.stdout.strip()), None


def push_branch(path, branch, force=False):
    """Push <branch> to the odoo-dev remote, setting upstream. With force, use
    --force-with-lease (a safe force that aborts if the remote moved
    unexpectedly). Returns (ok, error)."""
    remote, err = dev_remote(path)
    if err:
        return False, err
    args = ["push", "--set-upstream"]
    if force:
        args.append("--force-with-lease")
    args += [remote, branch]
    log_request("git " + " ".join(args))
    try:
        r = subprocess.run(
            ["git", "-C", os.path.expanduser(path), *args],
            capture_output=True,
            text=True,
            timeout=120,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return False, str(e)
    if r.returncode != 0:
        return False, r.stderr.strip().split("\n")[-1] or "git push failed"
    return True, None


def close_pr(github, number):
    """Close a GitHub PR via the gh CLI. Returns (ok, error)."""
    log_request(f"gh pr close {number} --repo {github}")
    try:
        r = subprocess.run(
            ["gh", "pr", "close", str(number), "--repo", github],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return False, str(e)
    if r.returncode != 0:
        return False, r.stderr.strip().split("\n")[0] or "gh pr close failed"
    return True, None


def main_remote(path, github=None):
    """Best guess at the remote that hosts the canonical master, in order:
    1. the upstream configured for the local `master` branch (git's own answer);
    2. the remote whose URL matches the canonical github slug (e.g. odoo/odoo),
       i.e. not the odoo-dev fork — the mirror of dev_remote();
    3. "origin".
    """
    p = os.path.expanduser(path)
    try:
        r = subprocess.run(
            ["git", "-C", p, "rev-parse", "--abbrev-ref", "master@{upstream}"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if r.returncode == 0 and "/" in r.stdout.strip():
            return r.stdout.strip().split("/", 1)[0]
        if github:
            rv = subprocess.run(
                ["git", "-C", p, "remote", "-v"], capture_output=True, text=True, timeout=10
            )
            for line in rv.stdout.splitlines():
                parts = line.split()
                if len(parts) >= 2 and github in parts[1]:
                    return parts[0]
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return "origin"


def fetch_master(repo):
    """Fetch master objects for one repo (no merge, no working-tree change).
    Slow on stale odoo clones, so callers run this off the main thread."""
    rid = repo.get("id") or "?"
    path = repo.get("path")
    if not path:
        return
    remote = main_remote(path, repo.get("github"))
    log_request(f"git fetch {remote} master  (auto-reload {rid})")
    try:
        r = subprocess.run(
            ["git", "-C", os.path.expanduser(path), "fetch", remote, "master"],
            capture_output=True,
            text=True,
            timeout=900,
        )
        if r.returncode != 0:
            tail = r.stderr.strip().splitlines()
            print(f"{TAG} auto-reload {rid} failed: {tail[-1] if tail else 'git fetch failed'}", flush=True)
        else:
            print(f"{TAG} auto-reload {rid}: fetched {remote}/master", flush=True)
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        print(f"{TAG} auto-reload {rid} failed: {e}", flush=True)


class AutoReloader:
    """Fetches master for opted-in repos every INTERVAL seconds, in the
    background. The repo set is pushed by the frontend (config lives there).
    Each repo's first fetch is one interval after it is first registered, so
    starting goo never triggers a fetch storm."""

    INTERVAL = 4 * 3600

    def __init__(self):
        self._repos = []
        self._next = {}  # path -> earliest next fetch time
        self._lock = threading.Lock()
        threading.Thread(target=self._loop, daemon=True).start()

    def set_repos(self, repos):
        with self._lock:
            self._repos = [r for r in repos if r.get("path")]
            now = time.time()
            for r in self._repos:
                self._next.setdefault(r["path"], now + self.INTERVAL)

    def _loop(self):
        while True:
            time.sleep(60)
            now = time.time()
            with self._lock:
                due = [r for r in self._repos if now >= self._next.get(r["path"], 0)]
                for r in due:
                    self._next[r["path"]] = now + self.INTERVAL
            for r in due:
                fetch_master(r)


def build_odoo_cmd(config):
    """Build the odoo-bin shell command from a client config.

    Returns (cmd, db, is_new_db). Raises ValueError on invalid config.
    """
    start = config.get("start") or {}
    db = start.get("db")
    if not db:
        raise ValueError("no database configured (start.db)")

    repo_map = {
        r["id"]: {**r, "path": os.path.expanduser(r["path"])}
        for r in config.get("repos", [])
        if isinstance(r, dict) and "id" in r and "path" in r
    }
    community = repo_map.get("community")
    if not community:
        raise ValueError("no 'community' repo defined in repos")
    community_path = community["path"]

    addons_parts = []
    for repo_id in start.get("repos", []):
        repo = repo_map.get(repo_id)
        if not repo:
            raise ValueError(f"unknown repo '{repo_id}' in start.repos")
        if repo_id == "community":
            addons_parts.append("addons")
        else:
            addons_parts.append(os.path.relpath(repo["path"], community_path))
    if not addons_parts:
        raise ValueError("no repos selected in start.repos")
    addons_parts.append(ADDONS_DIR)  # goo's own addons (autologin, auto-installed)
    addons_path = ",".join(addons_parts)

    db_user = config.get("db_user", "odoo")
    db_password = config.get("db_password", "odoo")
    venv_activate = config.get("venv_activate", "")
    # the configurable launch prefix (cwd + odoo-bin); goo appends the dynamic args
    start_cmd = config.get("start_cmd") or f"cd {community_path} && ./odoo-bin"

    parts = []
    if venv_activate:
        parts.append(venv_activate)
    parts.append(start_cmd)
    cmd = " && ".join(parts)
    cmd += (
        f" -r {db_user} -w {db_password} -d {db} "
        f"--database {db} --no-database-list --with-demo "
        f"--addons-path {addons_path}"
    )

    # test mode: run the given --test-tags and exit, skipping the server-only
    # extras (other_args / on_create_args), mirroring the old odev behaviour
    test_tags = start.get("test_tags")
    if test_tags:
        # quote so shell globbing can't mangle hoot params, e.g.
        # /web:WebSuite[@web/core/commands] (the [..] is a bash glob).
        # --dev all turns on the dev features (access/qweb/reload/xml). NOTE: it
        # does NOT de-minify the headless HOOT JS bundle — minification is decided
        # by `session.debug` (set only from the `debug=assets` URL param), and
        # test_js.py hardcodes the test URL without it (browser_js adds it only in
        # non-headless "watch" mode). To read non-minified JS stacks, open the
        # failing test via the "[open in hoot]" link in the log (debug=assets).
        cmd += f" --test-tags {shlex.quote(test_tags)} --dev all --stop-after-init"
        # if the db was never set up (target created but server never started),
        # initialize it in the same run by applying the target's on_create_args
        # (e.g. `-i <modules>`) — odoo then installs the modules AND runs the
        # tests, instead of failing against an empty/missing database
        is_new = not db_initialized(db)
        on_create_args = start.get("on_create_args", "")
        if is_new and on_create_args:
            cmd += f" {on_create_args}"
        return cmd, db, is_new

    # install / upgrade modules and exit
    install, upgrade = start.get("install"), start.get("upgrade")
    if install or upgrade:
        if install:
            cmd += f" -i {install}"
        if upgrade:
            cmd += f" -u {upgrade}"
        cmd += " --stop-after-init"
        return cmd, db, False

    other_args = start.get("other_args", "")
    if other_args:
        cmd += f" {other_args}"

    is_new = not db_initialized(db)
    on_create_args = start.get("on_create_args", "")
    if is_new and on_create_args:
        cmd += f" {on_create_args}"
    return cmd, db, is_new


# =============================================================================
# WebSocket helpers (no external deps — only stdlib hashlib/base64/struct)
# =============================================================================

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
RAW_BUF_MAX = 256 * 1024  # raw PTY byte ring buffer for terminal replay


def _ws_accept_key(key):
    digest = hashlib.sha1((key + _WS_GUID).encode()).digest()
    return base64.b64encode(digest).decode()


def _ws_send_frame(sock, payload, opcode=2):
    """Send one unmasked WebSocket frame (server→client). opcode 2 = binary."""
    n = len(payload)
    if n < 126:
        header = bytes([0x80 | opcode, n])
    elif n < 65536:
        header = bytes([0x80 | opcode, 126]) + struct.pack(">H", n)
    else:
        header = bytes([0x80 | opcode, 127]) + struct.pack(">Q", n)
    sock.sendall(header + (payload if isinstance(payload, bytes) else bytes(payload)))


def _ws_recv_frame(sock):
    """Receive one WebSocket frame (client→server, always masked).
    Returns (opcode, payload_bytes). Raises OSError on disconnect."""

    def _recv(n):
        buf = b""
        while len(buf) < n:
            chunk = sock.recv(n - len(buf))
            if not chunk:
                raise OSError("WebSocket disconnected")
            buf += chunk
        return buf

    b0, b1 = _recv(2)
    opcode = b0 & 0x0F
    masked = bool(b1 & 0x80)
    length = b1 & 0x7F
    if length == 126:
        length = struct.unpack(">H", _recv(2))[0]
    elif length == 127:
        length = struct.unpack(">Q", _recv(8))[0]
    mask = _recv(4) if masked else b""
    payload = bytearray(_recv(length))
    if masked:
        for i in range(len(payload)):
            payload[i] ^= mask[i % 4]
    return opcode, bytes(payload)


# =============================================================================
# Odoo process manager
# =============================================================================


class OdooManager:
    """Owns the single odoo process. States:
    stopped -> starting -> running -> stopping -> stopped
    """

    def __init__(self, bus):
        self.bus = bus
        self.lock = threading.Lock()
        self.state = "stopped"
        self.process = None
        self.master_fd = None
        self.reader_thread = None
        self.db = None
        self.target = None
        self.cmd = None
        self.mode = "server"  # "server" or "test"
        self.started_at = None
        self.exited_unexpectedly = False
        self.returncode = None
        # raw PTY byte ring buffer: replayed to each new terminal WebSocket client
        # so xterm.js can reconstruct the current terminal state on connect
        self._raw_buf = bytearray()
        self._raw_lock = threading.Lock()
        self._ws_clients = set()  # set of queue.Queue, one per terminal WS connection

    def status(self):
        with self.lock:
            active = self.state in ("starting", "running")
            status = {
                "state": self.state,
                "pid": self.process.pid if (active and self.process) else None,
                "db": self.db if active else None,
                "target": self.target if active else None,
                "cmd": self.cmd if active else None,
                "mode": self.mode if active else None,
                "started_at": self.started_at if active else None,
            }
            if self.exited_unexpectedly:
                status["exited_unexpectedly"] = True
                status["returncode"] = self.returncode
        status["odoo_port_busy"] = port_busy(ODOO_PORT)
        if status["db"]:
            version, enterprise, _ = odoo_info(status["db"])
            status["odoo_version"] = version
            status["enterprise"] = enterprise
        return status

    def start(self, config):
        """Returns (ok, detail). detail is the command on success, an error
        code otherwise."""
        with self.lock:
            if self.state != "stopped":
                return False, "already_running"
            try:
                cmd, db, is_new = build_odoo_cmd(config)
            except ValueError as e:
                return False, f"invalid_config: {e}"

            self.exited_unexpectedly = False
            self.returncode = None
            self.db = db
            self.target = config.get("target")
            self.cmd = cmd
            s = config.get("start") or {}
            self.mode = (
                "test"
                if s.get("test_tags")
                else "install"
                if s.get("install")
                else "upgrade"
                if s.get("upgrade")
                else "server"
            )
            self.started_at = time.time()
            self.bus.publish_log(f"{TAG} starting odoo: {cmd}")
            if is_new:
                self.bus.publish_log(
                    f"{TAG} database '{db}' not initialized, applying on_create_args"
                )

            with self._raw_lock:
                self._raw_buf.clear()

            master_fd, slave_fd = pty.openpty()
            self.process = subprocess.Popen(
                cmd,
                shell=True,
                executable="/bin/bash",
                stdout=slave_fd,
                stderr=slave_fd,
                stdin=slave_fd,
                preexec_fn=os.setsid,
            )
            os.close(slave_fd)
            self.master_fd = master_fd
            self.state = "starting"
            self.reader_thread = threading.Thread(
                target=self._reader,
                args=(master_fd, self.process),
                daemon=True,
            )
            self.reader_thread.start()
        self.bus.publish_status(self.status())
        return True, cmd

    def stop(self):
        """Stop the odoo process. Idempotent; when already stopped, still
        kills whatever holds the odoo port (orphans, external servers)."""
        with self.lock:
            if self.state == "stopping":
                return False, "already_stopping"
            was_active = self.state in ("starting", "running")
            process = self.process
            reader = self.reader_thread
            if was_active:
                self.state = "stopping"

        if was_active:
            self.bus.publish_status(self.status())
            self.bus.publish_log(f"{TAG} stopping odoo...")
            # never let an exception leave us stuck in "stopping" (the guard
            # above would then refuse every future stop until goo restarts)
            try:
                self._terminate(process)
            except Exception as e:
                self.bus.publish_log(f"{TAG} error while stopping: {e}")
            kill_port(ODOO_PORT)
            if reader:
                reader.join(timeout=2)
            with self.lock:
                self.state = "stopped"
                self.process = None
                self.master_fd = None
                self.db = None
                self.target = None
                self.cmd = None
                self.started_at = None
            self.bus.publish_log(f"{TAG} odoo stopped")
        elif port_busy(ODOO_PORT):
            kill_port(ODOO_PORT)
            self.bus.publish_log(f"{TAG} killed process on port {ODOO_PORT}")

        self.bus.publish_status(self.status())
        return True, "stopped"

    def _terminate(self, process):
        """Signal-escalate the odoo process group until it exits: graceful
        SIGTERM, then a second SIGTERM (odoo needs a second signal to force the
        shutdown when graceful hangs), then SIGKILL as a last resort."""
        if process is None:
            return
        try:
            pgid = os.getpgid(process.pid)
        except (ProcessLookupError, OSError):
            return
        for sig, wait in ((signal.SIGTERM, 4), (signal.SIGTERM, 3), (signal.SIGKILL, 3)):
            try:
                os.killpg(pgid, sig)
            except (ProcessLookupError, OSError):
                return  # already gone
            try:
                process.wait(timeout=wait)
                return
            except subprocess.TimeoutExpired:
                continue

    def restart(self, config):
        ok, detail = self.stop()
        if not ok:
            return ok, detail
        return self.start(config)

    def shutdown(self):
        """Cleanup on goo exit: stop our own child, but never touch an
        external odoo we didn't start."""
        with self.lock:
            active = self.state in ("starting", "running")
        if active:
            self.stop()

    def _emit_raw(self, data):
        """Append raw PTY bytes to the ring buffer and fan out to terminal WS clients."""
        with self._raw_lock:
            self._raw_buf += data
            if len(self._raw_buf) > RAW_BUF_MAX:
                self._raw_buf = self._raw_buf[-RAW_BUF_MAX:]
            clients = list(self._ws_clients)
        for q in clients:
            q.put(data)

    def _reader(self, fd, process):
        """Read the PTY, publish lines, detect readiness and unexpected exit."""
        buf = b""
        while True:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            self._emit_raw(data)
            buf += data
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                self._handle_line(raw.decode("utf-8", errors="replace").rstrip("\r"))
        if buf:
            self._handle_line(buf.decode("utf-8", errors="replace").rstrip("\r"))
        try:
            os.close(fd)
        except OSError:
            pass

        ret = process.wait()
        with self.lock:
            # stop() owns intentional exits; a stale reader (post-restart)
            # must not touch the new process state
            if self.state == "stopping" or process is not self.process:
                return
            self.state = "stopped"
            self.process = None
            self.master_fd = None
            self.db = None
            self.target = None
            self.cmd = None
            self.started_at = None
            self.exited_unexpectedly = True
            self.returncode = ret
        self.bus.publish_log(f"{TAG} odoo exited unexpectedly (code {ret})")
        self.bus.publish_status(self.status())

    def _handle_line(self, line):
        self.bus.publish_log(line)
        if READY_MARKER in line:
            with self.lock:
                if self.state != "starting":
                    return
                self.state = "running"
            self.bus.publish_status(self.status())


BUS = EventBus()
MANAGER = OdooManager(BUS)
# the last start/test config received from the UI — reused by the `goo --test-tags`
# CLI so agents can run tests without re-supplying the target/db/repos/venv
LAST_CONFIG = None
AUTORELOAD = AutoReloader()


# =============================================================================
# HTTP server
# =============================================================================


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # keep the terminal quiet

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/":
            self._serve_static("index.html")
        elif path.startswith("/static/"):
            self._serve_static(path[len("/static/") :])
        elif path == "/api/status":
            self._send_json(200, MANAGER.status())
        elif path == "/api/databases":
            try:
                self._send_json(200, {"ok": True, "databases": list_databases()})
            except RuntimeError as e:
                self._send_json(500, {"ok": False, "error": str(e)})
        elif path == "/api/events":
            self._handle_events()
        elif path == "/api/terminal":
            self._handle_terminal()
        elif path == "/api/shell":
            self._handle_shell()
        elif path == "/api/data":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            fpath = (qs.get("path") or [""])[0]
            if not fpath:
                return self._send_json(400, {"ok": False, "error": "missing path"})
            data, error = read_data_file(fpath)
            if error:
                return self._send_json(400, {"ok": False, "error": error})
            self._send_json(200, {"ok": True, "data": data})
        else:
            self._send_json(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/start":
            self._action_start(MANAGER.start)
        elif path == "/api/restart":
            self._action_start(MANAGER.restart)
        elif path in ("/api/tests/run", "/api/addons/run"):
            self._action_oneshot()
        elif path == "/api/cli/config":
            self._cli_config()
        elif path == "/api/cli/test":
            self._handle_cli_test()
        elif path == "/api/command":
            config, err = self._read_json()
            if err:
                return self._send_json(400, {"ok": False, "error": err})
            try:
                cmd, _, _ = build_odoo_cmd(config)
                self._send_json(200, {"ok": True, "cmd": cmd})
            except ValueError as e:
                self._send_json(400, {"ok": False, "error": str(e)})
        elif path == "/api/stop":
            ok, detail = MANAGER.stop()
            if ok:
                self._send_json(200, {"ok": True, "state": "stopped"})
            else:
                self._send_json(409, {"ok": False, "error": detail})
        elif path == "/api/code/branches":
            body, err = self._read_json()
            repos = (body or {}).get("repos")
            if err or not isinstance(repos, list):
                return self._send_json(400, {"ok": False, "error": "missing repos list"})
            self._send_json(200, {"ok": True, "repos": git_branches(repos)})
        elif path == "/api/prs":
            body, err = self._read_json()
            repos = (body or {}).get("repos")
            if err or not isinstance(repos, list):
                return self._send_json(400, {"ok": False, "error": "missing repos list"})
            self._send_json(200, {"ok": True, "repos": github_prs(repos)})
        elif path == "/api/mergebot":
            body, err = self._read_json()
            prs = (body or {}).get("prs")
            if err or not isinstance(prs, list):
                return self._send_json(400, {"ok": False, "error": "missing prs list"})
            self._send_json(200, {"ok": True, "states": mergebot_statuses(prs)})
        elif path == "/api/runbot":
            body, err = self._read_json()
            branches = (body or {}).get("branches")
            if err or not isinstance(branches, list):
                return self._send_json(400, {"ok": False, "error": "missing branches list"})
            self._send_json(200, {"ok": True, "states": runbot_statuses(branches)})
        elif path == "/api/autoreload":
            body, err = self._read_json()
            repos = (body or {}).get("repos")
            if err or not isinstance(repos, list):
                return self._send_json(400, {"ok": False, "error": "missing repos list"})
            AUTORELOAD.set_repos(repos)
            self._send_json(200, {"ok": True})
        elif path == "/api/addons":
            body, err = self._read_json()
            repos = (body or {}).get("repos")
            db = (body or {}).get("db")
            if err or not isinstance(repos, list):
                return self._send_json(400, {"ok": False, "error": "missing repos list"})
            mods = list_addons(repos)
            state = installed_modules(db) if db else {}
            for m in mods:
                m["state"] = state.get(m["name"])
            self._send_json(200, {"ok": True, "modules": mods, "db": db})
        elif path == "/api/code/branches/delete":
            body, err = self._read_json()
            repo_path = (body or {}).get("path")
            branch = (body or {}).get("branch")
            if err or not repo_path or not branch:
                return self._send_json(400, {"ok": False, "error": "missing path or branch"})
            ok, error, remote_error = git_delete_branch(
                repo_path, branch, bool((body or {}).get("delete_remote"))
            )
            if ok:
                self._send_json(200, {"ok": True, "remote_error": remote_error})
            else:
                self._send_json(400, {"ok": False, "error": error})
        elif path == "/api/code/branch/create":
            body, err = self._read_json()
            repo_path = (body or {}).get("path")
            name = (body or {}).get("name")
            start_point = (body or {}).get("start_point")
            if err or not repo_path or not name or not start_point:
                return self._send_json(400, {"ok": False, "error": "missing path, name or start point"})
            ok, error = git_branch_create(repo_path, name, start_point)
            self._send_json(200 if ok else 400, {"ok": ok, "error": error})
        elif path == "/api/code/checkout":
            body, err = self._read_json()
            repos = (body or {}).get("repos")
            if err or not isinstance(repos, list):
                return self._send_json(400, {"ok": False, "error": "missing repos list"})
            results = []
            for r in repos:
                ok, error = git_checkout(r.get("path"), r.get("branch"))
                results.append({"branch": r.get("branch"), "ok": ok, "error": error})
            self._send_json(200, {"ok": True, "results": results})
        elif path == "/api/code/rebase":
            body, err = self._read_json()
            repos = (body or {}).get("repos")
            if err or not isinstance(repos, list):
                return self._send_json(400, {"ok": False, "error": "missing repos list"})
            results = []
            for r in repos:
                ok, error = git_fetch_rebase(r.get("path"), r.get("base"), r.get("github"))
                results.append({"repo": r.get("repo"), "ok": ok, "error": error})
            self._send_json(200, {"ok": True, "results": results})
        elif path == "/api/databases/drop":
            body, err = self._read_json()
            name = (body or {}).get("name")
            if err or not name or not isinstance(name, str):
                return self._send_json(400, {"ok": False, "error": "missing database name"})
            ok, error = drop_database(name)
            if ok:
                self._send_json(200, {"ok": True})
            else:
                self._send_json(400, {"ok": False, "error": error})
        elif path == "/api/data":
            body, err = self._read_json()
            fpath = (body or {}).get("path")
            if err or not fpath:
                return self._send_json(400, {"ok": False, "error": "missing path"})
            ok, error = write_data_file(fpath, (body or {}).get("data"))
            if ok:
                self._send_json(200, {"ok": True})
            else:
                self._send_json(400, {"ok": False, "error": error})
        elif path == "/api/prs/close":
            body, err = self._read_json()
            repo = (body or {}).get("repo")
            number = (body or {}).get("number")
            if err or not repo or not number:
                return self._send_json(400, {"ok": False, "error": "missing repo or number"})
            ok, error = close_pr(repo, number)
            if ok:
                self._send_json(200, {"ok": True})
            else:
                self._send_json(400, {"ok": False, "error": error})
        elif path == "/api/code/branch/remote":
            body, err = self._read_json()
            repo_path = (body or {}).get("path")
            branch = (body or {}).get("branch")
            if err or not repo_path or not branch:
                return self._send_json(400, {"ok": False, "error": "missing path or branch"})
            exists, error = remote_branch_exists(repo_path, branch)
            if error:
                self._send_json(400, {"ok": False, "error": error})
            else:
                self._send_json(200, {"ok": True, "exists": exists})
        elif path == "/api/code/branch/push":
            body, err = self._read_json()
            repo_path = (body or {}).get("path")
            branch = (body or {}).get("branch")
            if err or not repo_path or not branch:
                return self._send_json(400, {"ok": False, "error": "missing path or branch"})
            ok, error = push_branch(repo_path, branch, bool((body or {}).get("force")))
            if ok:
                self._send_json(200, {"ok": True})
            else:
                self._send_json(400, {"ok": False, "error": error})
        elif path == "/api/code/remote-branches/search":
            body, err = self._read_json()
            repos = (body or {}).get("repos", [])
            query = (body or {}).get("query", "")
            if err or not query or not isinstance(repos, list):
                return self._send_json(400, {"ok": False, "error": "missing query or repos"})
            results = search_remote_branches(repos, query)
            self._send_json(200, {"ok": True, "results": results})
        elif path == "/api/code/remote-branch/fetch":
            body, err = self._read_json()
            repo_path = (body or {}).get("path")
            branch = (body or {}).get("branch")
            if err or not repo_path or not branch:
                return self._send_json(400, {"ok": False, "error": "missing path or branch"})
            ok, error = git_fetch_remote_branch(repo_path, branch)
            self._send_json(200 if ok else 400, {"ok": ok, "error": error})
        elif path == "/api/code/wip-commit":
            body, err = self._read_json()
            repo_path = (body or {}).get("path")
            if err or not repo_path:
                return self._send_json(400, {"ok": False, "error": "missing path"})
            ok, error = git_wip_commit(repo_path)
            self._send_json(200 if ok else 400, {"ok": ok, "error": error})
        elif path == "/api/code/discard":
            body, err = self._read_json()
            repo_path = (body or {}).get("path")
            if err or not repo_path:
                return self._send_json(400, {"ok": False, "error": "missing path"})
            ok, error = git_discard(repo_path)
            self._send_json(200 if ok else 400, {"ok": ok, "error": error})
        elif path == "/api/code/log":
            body, err = self._read_json()
            repo_path = (body or {}).get("path")
            if err or not repo_path:
                return self._send_json(400, {"ok": False, "error": "missing path"})
            count = int((body or {}).get("count") or 20)
            ref = (body or {}).get("ref") or ""
            commits, error = git_log(repo_path, count, ref)
            self._send_json(
                200 if error is None else 400,
                {"ok": error is None, "commits": commits or [], "error": error},
            )
        elif path == "/api/event":
            body, err = self._read_json()
            text = (body or {}).get("text")
            if err or not text:
                return self._send_json(400, {"ok": False, "error": "missing text"})
            # mirror the frontend event log on the goo terminal
            print(f"{TAG} {time.strftime('%H:%M:%S')} • {text}", flush=True)
            self._send_json(200, {"ok": True})
        else:
            self._send_json(404, {"ok": False, "error": "not_found"})

    # --- API helpers ---

    def _action_start(self, action):
        config, err = self._read_json()
        if err:
            return self._send_json(400, {"ok": False, "error": err})
        global LAST_CONFIG
        LAST_CONFIG = config
        ok, detail = action(config)
        if ok:
            self._send_json(200, {"ok": True, "state": "starting", "cmd": detail})
        else:
            code = 400 if detail.startswith("invalid_config") else 409
            self._send_json(code, {"ok": False, "error": detail})

    def _action_oneshot(self):
        """Stop whatever holds the odoo port, then start a one-shot run
        (tests / install / upgrade). Shares the manager with the server."""
        config, err = self._read_json()
        if err:
            return self._send_json(400, {"ok": False, "error": err})
        global LAST_CONFIG
        LAST_CONFIG = config
        MANAGER.stop()
        ok, detail = MANAGER.start(config)
        if ok:
            self._send_json(200, {"ok": True, "state": "starting", "cmd": detail})
        else:
            code = 400 if detail.startswith("invalid_config") else 409
            self._send_json(code, {"ok": False, "error": detail})

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError
            return data, None
        except (ValueError, OSError):
            return None, "invalid_config: bad JSON body"

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # --- static files ---

    def _serve_static(self, name):
        path = os.path.normpath(os.path.join(STATIC_DIR, name))
        if not path.startswith(STATIC_DIR + os.sep):
            return self._send_json(404, {"ok": False, "error": "not_found"})
        try:
            with open(path, "rb") as f:
                body = f.read()
        except OSError:
            return self._send_json(404, {"ok": False, "error": "not_found"})
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    # --- WebSocket terminal ---

    def _handle_terminal(self):
        """Upgrade to WebSocket, replay the PTY ring buffer, then proxy
        live PTY bytes to the browser and browser keystrokes to the PTY."""
        key = self.headers.get("Sec-WebSocket-Key", "")
        if not key:
            return self._send_json(400, {"ok": False, "error": "missing WS key"})

        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", _ws_accept_key(key))
        self.end_headers()
        self.wfile.flush()

        sock = self.connection
        q = queue.Queue()

        # snapshot buffer + register atomically so no bytes are lost
        with MANAGER._raw_lock:
            replay = bytes(MANAGER._raw_buf)
            MANAGER._ws_clients.add(q)

        try:
            if replay:
                _ws_send_frame(sock, replay)

            def _sender():
                while True:
                    chunk = q.get()
                    if chunk is None:
                        break
                    try:
                        _ws_send_frame(sock, chunk)
                    except OSError:
                        break

            sender = threading.Thread(target=_sender, daemon=True)
            sender.start()

            while True:
                opcode, payload = _ws_recv_frame(sock)
                if opcode == 8:  # close
                    break
                fd = MANAGER.master_fd
                if fd is None:
                    continue
                if opcode == 1:  # text: JSON control message (resize)
                    try:
                        msg = json.loads(payload)
                        if msg.get("type") == "resize":
                            rows = max(1, int(msg.get("rows", 24)))
                            cols = max(1, int(msg.get("cols", 80)))
                            fcntl.ioctl(fd, termios.TIOCSWINSZ,
                                        struct.pack("HHHH", rows, cols, 0, 0))
                    except (json.JSONDecodeError, OSError, ValueError):
                        pass
                elif opcode == 2:  # binary: raw terminal input bytes
                    try:
                        os.write(fd, payload)
                    except OSError:
                        pass
        except OSError:
            pass
        finally:
            MANAGER._ws_clients.discard(q)
            q.put(None)  # stop the sender thread

    def _handle_shell(self):
        """Upgrade to WebSocket and proxy an interactive bash shell running in
        the requested directory. One shell process per connection, killed on
        disconnect. Independent of the Odoo server PTY."""
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        cwd = os.path.expanduser((qs.get("cwd") or [""])[0])
        if not cwd or not os.path.isdir(cwd):
            return self._send_json(400, {"ok": False, "error": "invalid cwd"})
        key = self.headers.get("Sec-WebSocket-Key", "")
        if not key:
            return self._send_json(400, {"ok": False, "error": "missing WS key"})

        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", _ws_accept_key(key))
        self.end_headers()
        self.wfile.flush()

        sock = self.connection
        master_fd, slave_fd = pty.openpty()

        def _preexec():
            os.setsid()
            fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)  # pty becomes controlling tty

        proc = subprocess.Popen(
            ["/bin/bash", "-i"],
            cwd=cwd,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            preexec_fn=_preexec,
        )
        os.close(slave_fd)

        # one thread pumps PTY output to the socket; the main loop pumps client
        # input (and resize messages) into the PTY. Only this thread writes to
        # the socket, so there is no concurrent-write hazard.
        def _pty_to_ws():
            try:
                while True:
                    data = os.read(master_fd, 4096)
                    if not data:
                        break
                    _ws_send_frame(sock, data)
            except OSError:
                pass
            finally:
                try:
                    _ws_send_frame(sock, b"", opcode=8)  # close frame
                except OSError:
                    pass

        threading.Thread(target=_pty_to_ws, daemon=True).start()

        try:
            while True:
                opcode, payload = _ws_recv_frame(sock)
                if opcode == 8:  # close
                    break
                if opcode == 1:  # text: JSON control message (resize)
                    try:
                        msg = json.loads(payload)
                        if msg.get("type") == "resize":
                            rows = max(1, int(msg.get("rows", 24)))
                            cols = max(1, int(msg.get("cols", 80)))
                            fcntl.ioctl(master_fd, termios.TIOCSWINSZ,
                                        struct.pack("HHHH", rows, cols, 0, 0))
                    except (json.JSONDecodeError, OSError, ValueError):
                        pass
                elif opcode == 2:  # binary: raw terminal input bytes
                    try:
                        os.write(master_fd, payload)
                    except OSError:
                        pass
        except OSError:
            pass
        finally:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except OSError:
                pass
            try:
                os.close(master_fd)
            except OSError:
                pass

    # --- SSE ---

    def _handle_events(self):
        q, backlog = BUS.subscribe()
        print(
            f"{TAG} {time.strftime('%H:%M:%S')} client connected ({self.client_address[0]})",
            flush=True,
        )
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()  # no Content-Length: HTTP/1.0 read-until-close
            self._send_event("status", MANAGER.status())
            for line in backlog:
                self._send_event("log", {"line": line})
            while True:
                try:
                    event, payload = q.get(timeout=15)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                self._send_event(event, payload)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass  # client gone
        finally:
            BUS.unsubscribe(q)

    def _cli_config(self):
        """Store the current UI config (pushed by the browser) so the
        `goo --test-tags` CLI can run a one-shot test without the server having
        been started."""
        config, err = self._read_json()
        if err:
            return self._send_json(400, {"ok": False, "error": err})
        global LAST_CONFIG
        LAST_CONFIG = config
        self._send_json(200, {"ok": True})

    def _handle_cli_test(self):
        """Run a one-shot test (triggered by the `goo --test-tags` CLI) as its own
        odoo process — on free ports, so a running server is left untouched — and
        stream the log back as plain text. Announces the run on the server log +
        the browser event log, reusing the last config (target, db, repos, venv)."""
        body, err = self._read_json()
        tags = ((body or {}).get("test_tags") or "").strip()
        if err or not tags:
            return self._send_json(400, {"ok": False, "error": "missing test_tags"})
        if LAST_CONFIG is None:
            return self._send_json(
                409, {"ok": False, "error": "no target yet — open the goo UI (with a target configured) once"}
            )
        cfg = dict(LAST_CONFIG)
        cfg["start"] = {**(LAST_CONFIG.get("start") or {}), "test_tags": tags}
        try:
            cmd, _db, _is_new = build_odoo_cmd(cfg)
        except ValueError as e:
            return self._send_json(400, {"ok": False, "error": str(e)})
        # run on free ports so a running server (on the default ports) is undisturbed
        cmd += f" --http-port {free_port()} --gevent-port {free_port()}"

        BUS.publish_event(f"CLI test run (tags: {tags})")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(f"{TAG} running tests (tags: {tags})\n".encode())
        self.wfile.flush()
        proc = subprocess.Popen(
            cmd,
            shell=True,
            executable="/bin/bash",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            preexec_fn=os.setsid,
        )
        try:
            for line in proc.stdout:
                self.wfile.write(line.encode("utf-8", "replace"))
                self.wfile.flush()
            rc = proc.wait()
            BUS.publish_event(
                f"CLI test {'passed' if rc == 0 else f'failed (exit {rc})'} (tags: {tags})",
                "" if rc == 0 else "error",
            )
            self.wfile.write(f"{TAG} test run finished (exit {rc})\n".encode())
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            try:  # CLI client gone — don't leave the test running orphaned
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except OSError:
                pass

    def _send_event(self, event, payload):
        # json.dumps guarantees a single-line data field
        msg = f"event: {event}\ndata: {json.dumps(payload)}\n\n"
        self.wfile.write(msg.encode("utf-8"))
        self.wfile.flush()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        # the client closed the connection before we finished writing (page
        # reload, aborted fetch, SSE reconnect, a superseded refresh). Harmless
        # — don't dump a traceback. Real errors still propagate.
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


def run_cli_test(tags):
    """Client mode (`goo --test-tags …`): ask the already-running goo server to
    run a test against its current target and stream the log to stdout. Exits with
    the test's return code so agents can gate on pass/fail."""
    url = f"http://{HOST}:{PORT}/api/cli/test"
    req = urllib.request.Request(
        url,
        data=json.dumps({"test_tags": tags}).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=None) as resp:  # streams until the run ends
            exit_code = 0
            for raw in resp:
                line = raw.decode("utf-8", "replace").rstrip("\n")
                print(line, flush=True)
                m = re.search(r"test run finished \(exit (-?\d+)\)", line)
                if m:
                    exit_code = int(m.group(1))
            return 0 if exit_code == 0 else 1
    except urllib.error.HTTPError as e:
        print(f"{TAG} {e.read().decode('utf-8', 'replace')}", file=sys.stderr)
        return 2
    except urllib.error.URLError as e:
        print(f"{TAG} cannot reach goo at {url} — is goo running? ({e.reason})", file=sys.stderr)
        return 2


def main():
    parser = argparse.ArgumentParser(description="odoo development helper (web UI)")
    parser.add_argument("--open", action="store_true", help="open the UI in the default browser")
    parser.add_argument(
        "--test-tags",
        dest="test_tags",
        metavar="TAGS",
        help="run a test with these --test-tags on the running goo server and stream the log",
    )
    args = parser.parse_args()

    if args.test_tags:
        return run_cli_test(args.test_tags)

    try:
        httpd = Server((HOST, PORT), Handler)
    except OSError as e:
        print(f"{TAG} cannot bind {HOST}:{PORT}: {e}")
        return 1

    url = f"http://{HOST}:{PORT}"
    print(f"{TAG} running at {url}", flush=True)
    if args.open:
        webbrowser.open(url)

    signal.signal(signal.SIGTERM, lambda signum, frame: sys.exit(0))
    atexit.register(MANAGER.shutdown)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print(f"\n{TAG} shutting down...")
    finally:
        MANAGER.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
