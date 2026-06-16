#!/usr/bin/env python3
"""goo - GED Odoo Overseer, a local web app for Odoo development.

Run `python3 goo.py`, open the printed URL (or pass --open to open it in the
browser right away). The frontend (static/) holds the configuration and posts
it with each start request; the backend is stateless.
"""

import argparse
import ast
import atexit
import collections
import json
import mimetypes
import os
import pty
import queue
import re
import signal
import socket
import subprocess
import sys
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


def git_branches(repos):
    """For each repo {id, path}: the checked-out branch and all local
    branches with their last-commit date."""
    out = []
    for repo in repos:
        rid = repo.get("id")
        path = os.path.expanduser(repo.get("path", ""))
        if not rid or not path:
            continue
        entry = {"id": rid, "current": None, "dirty": False, "branches": [], "error": None}
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
            # branch names that have a remote-tracking ref, i.e. were pushed to
            # some remote from this clone (refname minus refs/remotes/<remote>/)
            rr = subprocess.run(
                ["git", "-C", path, "for-each-ref", "refs/remotes", "--format=%(refname:lstrip=3)"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            remote_branches = set(rr.stdout.split())
            r = subprocess.run(
                [
                    "git",
                    "-C",
                    path,
                    "for-each-ref",
                    "refs/heads",
                    "--format=%(refname:short)%09%(committerdate:iso8601-strict)",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            for line in r.stdout.splitlines():
                name, _, date = line.partition("\t")
                if name:
                    entry["branches"].append(
                        {"name": name, "date": date, "remote": name in remote_branches}
                    )
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            entry["error"] = str(e)
        out.append(entry)

    # enrich work branches with their runbot status (one badge per unique
    # name, fetched in parallel); base branches are skipped — see frontend.
    names = {b["name"] for e in out for b in e["branches"] if not BASE_BRANCH_RE.match(b["name"])}
    if names:
        with ThreadPoolExecutor(max_workers=min(8, len(names))) as pool:
            status = dict(zip(names, pool.map(runbot_badge_status, names), strict=False))
        for e in out:
            for b in e["branches"]:
                b["runbot"] = status.get(b["name"], "")
    return out


def git_delete_branch(path, branch):
    """Force-delete a local branch. Returns (ok, error)."""
    try:
        result = subprocess.run(
            ["git", "-C", os.path.expanduser(path), "branch", "-D", branch],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return False, str(e)
    if result.returncode != 0:
        return False, result.stderr.strip().split("\n")[0] or "git branch -D failed"
    return True, None


BASE_BRANCH_RE = re.compile(r"^(saas-\d+\.\d+|\d+\.\d+|master)$")


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
                    "number,url,state,isDraft,headRefName,updatedAt",
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


def push_branch(path, branch):
    """Push <branch> to the odoo-dev remote, setting upstream. (ok, error)."""
    remote, err = dev_remote(path)
    if err:
        return False, err
    log_request(f"git push {remote} {branch}")
    try:
        r = subprocess.run(
            ["git", "-C", os.path.expanduser(path), "push", "--set-upstream", remote, branch],
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
    addons_path = ",".join(addons_parts)

    db_user = config.get("db_user", "odoo")
    db_password = config.get("db_password", "odoo")
    venv_activate = config.get("venv_activate", "")

    parts = []
    if venv_activate:
        parts.append(venv_activate)
    parts.append(f"cd {community_path}")
    parts.append(
        f"./odoo-bin "
        f"-r {db_user} -w {db_password} -d {db} "
        f"--database {db} --no-database-list --with-demo "
        f"--addons-path {addons_path}"
    )
    cmd = " && ".join(parts)

    # test mode: run the given --test-tags and exit, skipping the server-only
    # extras (other_args / on_create_args), mirroring the old odev behaviour
    test_tags = start.get("test_tags")
    if test_tags:
        cmd += f" --test-tags {test_tags} --stop-after-init"
        return cmd, db, False

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
            try:
                pgid = os.getpgid(process.pid)
                os.killpg(pgid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(pgid, signal.SIGKILL)
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        pass
            except (ProcessLookupError, OSError):
                pass
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
            ok, error = git_delete_branch(repo_path, branch)
            if ok:
                self._send_json(200, {"ok": True})
            else:
                self._send_json(400, {"ok": False, "error": error})
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
            ok, error = push_branch(repo_path, branch)
            if ok:
                self._send_json(200, {"ok": True})
            else:
                self._send_json(400, {"ok": False, "error": error})
        else:
            self._send_json(404, {"ok": False, "error": "not_found"})

    # --- API helpers ---

    def _action_start(self, action):
        config, err = self._read_json()
        if err:
            return self._send_json(400, {"ok": False, "error": err})
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


def main():
    parser = argparse.ArgumentParser(description="odoo development helper (web UI)")
    parser.add_argument("--open", action="store_true", help="open the UI in the default browser")
    args = parser.parse_args()

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
