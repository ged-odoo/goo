#!/usr/bin/env python3

import atexit
import json
import pty
import re
import subprocess
import threading
import time
import os
import signal
import sys
import shutil
import tty
import termios
import select
import urllib.request

FETCH_INTERVAL = 86400  # seconds (24 hours)

# =============================================================================
# Configuration
# =============================================================================

WORK_DIR = "/home/odoo/work"
DATA_FILE = os.path.join(WORK_DIR, "odev-data.json")

DB_USER = "odoo"
DB_PASSWORD = "odoo"
VENV_ACTIVATE = "source /home/odoo/work/env20/bin/activate"

REPOS = [
    {"id": "community", "path": os.path.join(WORK_DIR, "community"), "remotes": ["origin", "dev"]},
    {"id": "enterprise", "path": os.path.join(WORK_DIR, "enterprise"), "remotes": ["origin", "dev"]},
    {"id": "tutorials", "path": os.path.join(WORK_DIR, "tutorials"), "remotes": ["origin"]},
]

REPO_MAP = {r["id"]: r for r in REPOS}

DEFAULT_TARGET_ARGS = {
    "on_create_args": "-i sale_management",
    "other_args": "--dev all",
    "auto_start": True,
}

BASE_TARGETS = [
    {
        "id": "19.0",
        "repos": ["community"],
        "branch": "19.0",
        "db": "test_db_19",
    },
    {
        "id": "19.0e",
        "repos": ["community", "enterprise"],
        "branch": "19.0",
        "db": "test_db_19e",
    },
    {
        "id": "community",
        "repos": ["community"],
        "branch": "master",
        "db": "test_db",
    },
    {
        "id": "enterprise",
        "repos": ["community", "enterprise"],
        "branch": "master",
        "db": "test_db_e",
    },
]

# =============================================================================
# Data file (single JSON for state + user targets + PRs)
# =============================================================================
#
# Structure:
# {
#   "active_target": "community",
#   "fetch_times": {"community:master": 1234567890},
#   "targets": [
#     {"id": "some_task", "parent": "community", "branch": "myfeature-ged"},
#     ...
#   ],
#   "prs": [
#     {"url": "...", "title": "...", "state": "pending", ...},
#     ...
#   ]
# }


def load_data():
    try:
        with open(DATA_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_data(data):
    with open(DATA_FILE, "w") as f:
        json.dump(data, f, indent=2)


# =============================================================================
# Target resolution
# =============================================================================


def get_all_targets():
    """Return base targets + user-defined targets from data file."""
    data = load_data()
    return BASE_TARGETS + data.get("targets", [])


def find_target(target_id, all_targets=None):
    if all_targets is None:
        all_targets = get_all_targets()
    return next((t for t in all_targets if t["id"] == target_id), None)


def resolve_target(target_id, all_targets=None):
    """Walk the parent chain and resolve repos, branches, db, args.

    Resolution rules:
    - repos: combined from all ancestors (root first, then down)
    - branch per repo: determined by the target that listed that repo.
      If a target has a branch but no repos, it overrides the branch
      for ALL inherited repos (the "task/feature branch" case).
    - db, on_create_args, other_args, auto_start: first non-None
      value walking from child up to root.
    """
    if all_targets is None:
        all_targets = get_all_targets()

    target = find_target(target_id, all_targets)
    if not target:
        return None

    # Build chain from child to root
    chain = []
    current = target
    seen = set()
    while current:
        if current["id"] in seen:
            break  # prevent cycles
        seen.add(current["id"])
        chain.append(current)
        parent_id = current.get("parent")
        current = find_target(parent_id, all_targets) if parent_id else None

    # Reverse: root first
    chain.reverse()

    # Resolve repos and their branches
    repo_branches = {}  # repo_id -> branch
    for level in chain:
        level_repos = level.get("repos", [])
        level_branch = level.get("branch")

        if level_repos and level_branch:
            # Branch applies to listed repos
            for repo_id in level_repos:
                repo_branches[repo_id] = level_branch
        elif level_repos and not level_branch:
            # Repos inherit branch from whatever was set before (parent)
            for repo_id in level_repos:
                if repo_id not in repo_branches:
                    # Find nearest ancestor branch
                    repo_branches[repo_id] = _find_ancestor_branch(chain, level)
        elif level_branch and not level_repos:
            # Override branch for ALL inherited repos (task branch)
            for repo_id in repo_branches:
                repo_branches[repo_id] = level_branch

    # Resolve scalar fields (child overrides parent, DEFAULT_TARGET_ARGS as fallback)
    resolved = {"id": target_id, "repos": []}
    for field in ("db", "on_create_args", "other_args", "auto_start"):
        for level in reversed(chain):  # child first
            if field in level and level[field] is not None:
                resolved[field] = level[field]
                break
        else:
            if field in DEFAULT_TARGET_ARGS:
                resolved[field] = DEFAULT_TARGET_ARGS[field]

    # Build ordered repo list (root repos first)
    seen_repos = []
    for level in chain:
        for repo_id in level.get("repos", []):
            if repo_id not in seen_repos:
                seen_repos.append(repo_id)
    # If no repos at all in chain (task with only branch override), use parent repos
    if not seen_repos:
        seen_repos = list(repo_branches.keys())

    for repo_id in seen_repos:
        branch = repo_branches.get(repo_id, "master")
        resolved["repos"].append({"id": repo_id, "branch": branch})

    return resolved


def _find_ancestor_branch(chain, current_level):
    """Find the branch from the nearest ancestor in the chain."""
    idx = chain.index(current_level)
    for i in range(idx - 1, -1, -1):
        if chain[i].get("branch"):
            return chain[i]["branch"]
    return "master"


# =============================================================================
# Terminal helpers
# =============================================================================

TAG = "\033[38;5;208m[odev]\033[0m"  # orange


def hoot_hash(s):
    """Generate a hoot test hash (same algorithm as _generate_hash in test_js.py)."""
    h = 0
    for ch in s:
        h = (h << 5) - h + ord(ch)
        h = h & 0xFFFFFFFF
    return f'{h:08x}'


def get_terminal_size():
    return shutil.get_terminal_size()


def write_raw(s):
    sys.stdout.write(s)
    sys.stdout.flush()


def move_cursor(row, col):
    write_raw(f"\033[{row};{col}H")


def clear_line():
    write_raw("\033[2K")


def set_scroll_region(top, bottom):
    write_raw(f"\033[{top};{bottom}r")


def reset_scroll_region():
    write_raw("\033[r")


def save_cursor():
    write_raw("\033[s")


def restore_cursor():
    write_raw("\033[u")


def hide_cursor():
    write_raw("\033[?25l")


def show_cursor():
    write_raw("\033[?25h")


# =============================================================================
# App
# =============================================================================

class Odev:
    def __init__(self):
        self.process = None
        self.master_fd = None
        self.server_status = "stopped"  # stopped, starting, running, testing
        self._pending_chrome_url = None
        self.input_buffer = ""
        self.cursor_pos = 0
        self.show_placeholder = True
        self.running = True
        self.lock = threading.Lock()
        self.old_settings = None

        # Load state
        data = load_data()
        self.active_target_id = data.get("active_target")
        self.active_repo_index = 0  # in-memory only, not persisted
        self.active_branch = ""  # current git branch of active repo
        self.repo_sync = {}  # repo_id -> (ahead, behind)
        self.repo_dirty = {}  # repo_id -> bool
        self.command_history = []  # last N commands
        self.history_index = -1  # -1 = not browsing history
        self.history_saved_input = ""  # buffer saved when entering history
        self.max_history = 100

        # Resolve target if we have one
        self.resolved = None
        if self.active_target_id:
            self.resolved = resolve_target(self.active_target_id)
            if self.resolved:
                # Clamp repo index
                n = len(REPOS)
                if self.active_repo_index >= n:
                    self.active_repo_index = 0
                self._refresh_active_branch()
        self._refresh_repo_sync()

    # -------------------------------------------------------------------------
    # State persistence
    # -------------------------------------------------------------------------

    def _save_state(self):
        data = load_data()
        data["active_target"] = self.active_target_id
        save_data(data)

    def _get_fetch_time(self, repo_id, branch):
        data = load_data()
        return data.get("fetch_times", {}).get(f"{repo_id}:{branch}", 0)

    def _set_fetch_time(self, repo_id, branch):
        data = load_data()
        ft = data.setdefault("fetch_times", {})
        ft[f"{repo_id}:{branch}"] = time.time()
        save_data(data)

    def _should_fetch(self, repo_id, branch):
        return (time.time() - self._get_fetch_time(repo_id, branch)) > FETCH_INTERVAL

    def _background_fetch_all(self):
        """Fetch all base target branches that haven't been fetched recently."""
        # Collect unique (repo_id, branch) pairs across all base targets
        to_fetch = set()
        for target in BASE_TARGETS:
            resolved = resolve_target(target["id"])
            if not resolved:
                continue
            for repo_entry in resolved["repos"]:
                rid = repo_entry["id"]
                branch = repo_entry["branch"]
                if self._should_fetch(rid, branch):
                    to_fetch.add((rid, branch))
        if not to_fetch:
            return

        def do_fetch():
            for rid, branch in sorted(to_fetch):
                repo = REPO_MAP.get(rid)
                if not repo:
                    continue
                with self.lock:
                    self.append_output(f"{TAG} fetching {rid}:{branch}...")
                try:
                    result = subprocess.run(
                        ["git", "fetch", "origin", branch],
                        cwd=repo["path"], capture_output=True, text=True, timeout=120,
                    )
                    if result.returncode == 0:
                        self._set_fetch_time(rid, branch)
                except Exception:
                    pass
            # Refresh sync indicators after fetch
            self._refresh_repo_sync()
            with self.lock:
                self.draw_chrome()

        threading.Thread(target=do_fetch, daemon=True).start()

    # -------------------------------------------------------------------------
    # Active repo helpers
    # -------------------------------------------------------------------------

    def _active_repo(self):
        """Return the REPO dict for the currently active repo."""
        return REPOS[self.active_repo_index]

    def _active_repo_path(self):
        return self._active_repo()["path"]

    def _refresh_active_branch(self):
        """Get the actual git branch of the active repo."""
        path = self._active_repo_path()
        try:
            result = subprocess.run(
                ["git", "branch", "--show-current"],
                cwd=path, capture_output=True, text=True, timeout=3,
            )
            self.active_branch = result.stdout.strip() or "(detached)"
        except Exception:
            self.active_branch = "?"

    def _get_base_branches(self):
        """Get the base branch for each repo (from parent target or self if root)."""
        if not self.active_target_id:
            return {}
        all_targets = get_all_targets()
        target = find_target(self.active_target_id, all_targets)
        if not target:
            return {}
        parent_id = target.get("parent")
        if parent_id:
            # Has parent: base branches come from parent resolution
            parent_resolved = resolve_target(parent_id, all_targets)
            if parent_resolved:
                return {r["id"]: r["branch"] for r in parent_resolved["repos"]}
        # No parent: this IS the root, current branches are the base
        if self.resolved:
            return {r["id"]: r["branch"] for r in self.resolved["repos"]}
        return {}

    def _refresh_repo_sync(self):
        """Get ahead/behind counts and dirty state for all repos."""
        base_branches = self._get_base_branches()
        for repo in REPOS:
            rid = repo["id"]
            path = repo["path"]
            # Dirty check
            try:
                dirty = subprocess.run(
                    ["git", "status", "--porcelain"],
                    cwd=path, capture_output=True, text=True, timeout=3,
                )
                self.repo_dirty[rid] = bool(dirty.stdout.strip())
            except Exception:
                self.repo_dirty[rid] = False
            # Ahead/behind vs origin/<base_branch>
            base = base_branches.get(rid)
            if not base:
                # No target info, try origin/<current branch>
                try:
                    base = subprocess.run(
                        ["git", "branch", "--show-current"],
                        cwd=path, capture_output=True, text=True, timeout=3,
                    ).stdout.strip()
                except Exception:
                    base = None
            if base:
                try:
                    result = subprocess.run(
                        ["git", "rev-list", "--left-right", "--count", f"HEAD...origin/{base}"],
                        cwd=path, capture_output=True, text=True, timeout=3,
                    )
                    if result.returncode == 0:
                        parts = result.stdout.strip().split("\t")
                        self.repo_sync[rid] = (int(parts[0]), int(parts[1]))
                    else:
                        self.repo_sync[rid] = (0, 0)
                except Exception:
                    self.repo_sync[rid] = (0, 0)
            else:
                self.repo_sync[rid] = (0, 0)

    def _cycle_repo(self):
        """Cycle to next repo."""
        self.active_repo_index = (self.active_repo_index + 1) % len(REPOS)
        self._refresh_active_branch()
        self.draw_chrome()

    # -------------------------------------------------------------------------
    # Terminal setup
    # -------------------------------------------------------------------------

    def setup_terminal(self):
        self.old_settings = termios.tcgetattr(sys.stdin)
        tty.setraw(sys.stdin.fileno())
        self.last_cols, self.last_rows = get_terminal_size()
        cols, rows = self.last_cols, self.last_rows
        write_raw("\033[?7l")  # disable auto-wrap to prevent line wrapping on resize
        # Scroll old content into scrollback (preserved, not destroyed)
        write_raw(f"\033[{rows}S")
        set_scroll_region(1, rows - 2)
        write_raw("\033]0;odev\007")
        move_cursor(rows - 2, 1)
        self.draw_chrome()

    def restore_terminal(self):
        write_raw("\033[?7h")  # re-enable auto-wrap
        reset_scroll_region()
        show_cursor()
        _, rows = get_terminal_size()
        # Clear the chrome lines before exiting
        move_cursor(rows - 1, 1)
        clear_line()
        move_cursor(rows, 1)
        clear_line()
        move_cursor(rows, 1)
        write_raw("\n")
        if self.old_settings:
            termios.tcsetattr(sys.stdin, termios.TCSADRAIN, self.old_settings)

    # -------------------------------------------------------------------------
    # Drawing the fixed bottom chrome
    # -------------------------------------------------------------------------

    def draw_chrome(self):
        cols, rows = get_terminal_size()

        # --- Status bar (row - 1) — colored background, acts as separator ---
        bar_row = rows - 1
        move_cursor(bar_row, 1)
        # Set background color and clear the full line (no characters = no wrap on resize)
        write_raw("\033[48;5;236m")  # dark gray background
        clear_line()

        # odev label, then repo tabs, then target + server status
        write_raw("\033[1;38;5;208;48;5;236modev \033[0;48;5;236m")
        target_repo_ids = set()
        if self.resolved:
            target_repo_ids = {r["id"] for r in self.resolved["repos"]}

        pipe = "\033[90;48;5;236m|\033[0;48;5;236m"
        write_raw(pipe)
        for i, repo in enumerate(REPOS):
            rid = repo["id"]
            ahead, behind = self.repo_sync.get(rid, (0, 0))
            dirty = self.repo_dirty.get(rid, False)
            dirty_str = "(*)" if dirty else ""
            sync_parts = []
            if ahead:
                sync_parts.append(f"↑{ahead}")
            if behind:
                sync_parts.append(f"↓{behind}")
            sync_str = f" \033[33m{''.join(sync_parts)}" if sync_parts else ""
            if i == self.active_repo_index:
                write_raw(f"\033[44;1;37m {rid}{dirty_str}{sync_str} \033[0;48;5;236m")
            elif rid in target_repo_ids:
                write_raw(f"\033[36;48;5;236m {rid}{dirty_str}{sync_str} \033[0;48;5;236m")
            else:
                write_raw(f"\033[90;48;5;236m {rid}{dirty_str}{sync_str} \033[0;48;5;236m")
        write_raw(pipe)

        target_label = self.active_target_id or "none"
        if self.server_status == "running":
            version = self._get_odoo_version()
            version_str = f" (v{version})" if version else ""
            server_str = f"\033[32mrunning{version_str}\033[48;5;236m"
        elif self.server_status == "starting":
            server_str = "\033[33mstarting\033[48;5;236m"
        elif self.server_status == "testing":
            server_str = "\033[34mtesting\033[48;5;236m"
        else:
            server_str = "\033[31mstopped\033[48;5;236m"
        write_raw(f" \033[37;48;5;236mtarget: \033[1;37m{target_label}\033[0;48;5;236m {pipe} \033[37;48;5;236mserver: {server_str}")
        write_raw("\033[0m")

        # --- Prompt line (last row) ---
        prompt_row = rows
        move_cursor(prompt_row, 1)
        clear_line()

        repo_label = self._active_repo()["id"]
        branch_label = self.active_branch or "?"
        prompt_visible = f"{repo_label}@{branch_label}> "
        prompt_colored = f"\033[32;1m{repo_label}@{branch_label}> \033[0m"
        if self.show_placeholder and not self.input_buffer:
            write_raw(f"{prompt_colored}\033[90mtype h for help\033[0m")
        else:
            write_raw(f"{prompt_colored}{self.input_buffer}")

        move_cursor(prompt_row, len(prompt_visible) + 1 + self.cursor_pos)
        show_cursor()

    # -------------------------------------------------------------------------
    # Output to scroll region
    # -------------------------------------------------------------------------

    @staticmethod
    @staticmethod
    def _build_test_url(filt=""):
        """Build the /web/tests URL with optional filter."""
        url = "http://localhost:8069/web/tests?debug=assets"
        if filt:
            parts = filt.split()
            id_parts = [p for p in parts if p.startswith("@")]
            text_parts = [p for p in parts if not p.startswith("@")]
            for p in id_parts:
                url += f"&id={hoot_hash(p)}"
            if text_parts:
                url += f"&filter={' '.join(text_parts)}"
        return url

    @staticmethod
    def _get_odoo_version():
        """Read Odoo version from release.py."""
        try:
            release_path = os.path.join(REPO_MAP["community"]["path"], "odoo", "release.py")
            with open(release_path) as f:
                for line in f:
                    if line.startswith("serie"):
                        # serie = major_version = '...'
                        # Extract the quoted string
                        m = re.search(r"version_info\[:2\]", line)
                        if m:
                            # It's computed, fall back to version_info
                            break
            # Parse version_info directly
            with open(release_path) as f:
                for line in f:
                    m = re.match(r"version_info\s*=\s*\((.+?)\)", line)
                    if m:
                        parts = m.group(1).split(",")
                        major = parts[0].strip()
                        minor = parts[1].strip()
                        return f"{major}.{minor}"
        except Exception:
            pass
        return None

    def append_output(self, text):
        _, rows = get_terminal_size()
        hide_cursor()
        scroll_bottom = rows - 2
        move_cursor(scroll_bottom, 1)
        for line in text.split("\n"):
            write_raw("\n")
            clear_line()
            write_raw(line)
        self.draw_chrome()

    def replace_last_output(self, text):
        _, rows = get_terminal_size()
        hide_cursor()
        scroll_bottom = rows - 2
        move_cursor(scroll_bottom, 1)
        clear_line()
        write_raw(text)
        self.draw_chrome()

    # -------------------------------------------------------------------------
    # Process management (server)
    # -------------------------------------------------------------------------

    def fd_reader(self, fd):
        buf = b""
        try:
            while self.running:
                if select.select([fd], [], [], 0.1)[0]:
                    try:
                        data = os.read(fd, 4096)
                    except OSError:
                        break
                    if not data:
                        break
                    buf += data
                    while b"\n" in buf:
                        line, buf = buf.split(b"\n", 1)
                        text = line.decode("utf-8", errors="replace").rstrip("\r")
                        if self.server_status == "starting" and "odoo.registry: Registry loaded" in text:
                            self.server_status = "running"
                            if self._pending_chrome_url:
                                subprocess.Popen(
                                    ["google-chrome", self._pending_chrome_url],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                )
                                self.append_output(f"{TAG} Opening {self._pending_chrome_url} in Chrome...")
                                self._pending_chrome_url = None
                        with self.lock:
                            self.append_output(text)
            if buf:
                text = buf.decode("utf-8", errors="replace").rstrip("\r")
                with self.lock:
                    self.append_output(text)
        except (OSError, ValueError):
            pass
        finally:
            self.server_status = "stopped"
            try:
                os.close(fd)
            except OSError:
                pass
            with self.lock:
                self.draw_chrome()

    def _build_odoo_base_cmd(self):
        """Build the common odoo-bin command prefix. Returns (cmd_str, db) or (None, None)."""
        resolved = self.resolved
        if not resolved:
            self.append_output(f"{TAG} No active target. Use 't <id>' first.")
            return None, None
        db = resolved.get("db")
        if not db:
            self.append_output(f"{TAG} No database configured for target '{resolved['id']}'.")
            return None, None

        community_path = REPO_MAP["community"]["path"]
        addons_parts = []
        for repo_entry in resolved["repos"]:
            repo = REPO_MAP.get(repo_entry["id"])
            if not repo:
                continue
            if repo_entry["id"] == "community":
                addons_parts.append("addons")
            else:
                addons_parts.append(os.path.relpath(repo["path"], community_path))
        addons_path = ",".join(addons_parts)

        base = (
            f"{VENV_ACTIVATE} && "
            f"cd {community_path} && "
            f"./odoo-bin "
            f"-r {DB_USER} -w {DB_PASSWORD} -d {db} "
            f"--database {db} --no-database-list --with-demo "
            f"--addons-path {addons_path}"
        )
        return base, db

    def start_odoo(self):
        if self.process and self.process.poll() is None:
            self.append_output(f"{TAG} Server already running. Stop it first with 'x'.")
            return

        base_cmd, db = self._build_odoo_base_cmd()
        if not base_cmd:
            return

        # Check if DB exists
        db_list = subprocess.run(
            ["psql", "-lqt"], capture_output=True, text=True,
        ).stdout
        existing_dbs = {line.split("|")[0].strip() for line in db_list.split("\n") if "|" in line}
        is_new_db = db not in existing_dbs

        other_args = self.resolved.get("other_args", "")
        on_create_args = self.resolved.get("on_create_args", "")
        extra = f" {other_args}" if other_args else ""
        if is_new_db and on_create_args:
            extra += f" {on_create_args}"
            self.append_output(f"{TAG} New database '{db}', applying on_create_args: {on_create_args}")

        cmd = f"{base_cmd}{extra}"

        self.server_status = "starting"
        self.append_output(f"{TAG} Starting Odoo ({self.resolved['id']})...")
        self.append_output(f"{TAG} {cmd}")

        master_fd, slave_fd = pty.openpty()
        self.process = subprocess.Popen(
            cmd, shell=True, executable="/bin/bash",
            stdout=slave_fd, stderr=slave_fd, stdin=slave_fd,
            preexec_fn=os.setsid,
        )
        os.close(slave_fd)
        self.master_fd = master_fd

        t = threading.Thread(target=self.fd_reader, args=(master_fd,), daemon=True)
        t.start()

    def run_tests(self, test_tags):
        """Run odoo tests with given --test-tags spec."""
        if self.process and self.process.poll() is None:
            self.stop_process()
            self.append_output(f"{TAG} Server stopped to run tests.")

        base_cmd, db = self._build_odoo_base_cmd()
        if not base_cmd:
            return

        cmd = f"{base_cmd} --test-tags {test_tags} --stop-after-init"

        self.server_status = "testing"
        self.append_output(f"{TAG} Running tests: {test_tags}")
        self.append_output(f"{TAG} {cmd}")

        master_fd, slave_fd = pty.openpty()
        self.process = subprocess.Popen(
            cmd, shell=True, executable="/bin/bash",
            stdout=slave_fd, stderr=slave_fd, stdin=slave_fd,
            preexec_fn=os.setsid,
        )
        os.close(slave_fd)
        self.master_fd = master_fd

        t = threading.Thread(target=self.fd_reader, args=(master_fd,), daemon=True)
        t.start()

    def run_tour(self, tour_name):
        """Shortcut to run a specific tour test."""
        self.run_tests(f"/{tour_name}")

    def stop_process(self, silent=False):
        self.server_status = "stopped"
        if self.process and self.process.poll() is None:
            if not silent:
                self.append_output(f"{TAG} Stopping server...")
            try:
                pgid = os.getpgid(self.process.pid)
                os.killpg(pgid, signal.SIGTERM)
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(pgid, signal.SIGKILL)
                    self.process.wait(timeout=3)
            except (ProcessLookupError, OSError):
                pass
            self._kill_port(8069)
            self.process = None
            if not silent:
                self.append_output(f"{TAG} Server stopped.")

    @staticmethod
    def _kill_port(port):
        try:
            result = subprocess.run(
                ["lsof", "-ti", f":{port}"],
                capture_output=True, text=True, timeout=3,
            )
            for pid_str in result.stdout.strip().split("\n"):
                if pid_str.strip():
                    try:
                        os.kill(int(pid_str.strip()), signal.SIGKILL)
                    except (ProcessLookupError, ValueError, OSError):
                        pass
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

    # -------------------------------------------------------------------------
    # Git helpers
    # -------------------------------------------------------------------------

    @staticmethod
    def _git_run(args, cwd, timeout=120):
        return subprocess.run(
            ["git"] + args, cwd=cwd,
            capture_output=True, text=True, timeout=timeout,
        )

    def _is_dirty(self, path):
        result = self._git_run(["status", "--porcelain"], cwd=path)
        return bool(result.stdout.strip())

    # -------------------------------------------------------------------------
    # Target management
    # -------------------------------------------------------------------------

    def list_targets(self):
        all_targets = get_all_targets()
        if not all_targets:
            self.append_output(f"{TAG} No targets defined.")
            return

        # Pre-compute all rows for column width calculation
        rows = []
        for t in all_targets:
            resolved = resolve_target(t["id"], all_targets)
            if not resolved:
                continue
            repos_str = ", ".join(f"{r['id']}:{r['branch']}" for r in resolved["repos"])
            rows.append((t, resolved, repos_str))

        w_idx = len(str(len(rows)))
        w_id = max(len(t["id"]) for t, _, _ in rows)
        w_parent = max((len(t.get("parent", "")) for t, _, _ in rows), default=0)
        w_parent = max(w_parent, 6)
        w_db = max((len(r.get("db", "")) for _, r, _ in rows), default=2)
        w_db = max(w_db, 8)
        w_repos = max((len(rs) for _, _, rs in rows), default=5)

        w_name_col = w_id + 2  # +2 for " ●" or "  "
        header = (
            f"  {'':<{w_idx}}  \033[1m{'Target':<{w_name_col}}\033[0m  "
            f"\033[1m{'Parent':<{w_parent}}\033[0m  "
            f"\033[1m{'Database':<{w_db}}\033[0m  "
            f"\033[1m{'Repos':<{w_repos}}\033[0m"
        )
        self.append_output(header)

        for idx, (t, resolved, repos_str) in enumerate(rows, 1):
            is_active = self.active_target_id == t["id"]
            num = f"\033[90m{idx:>{w_idx}}\033[0m"
            if is_active:
                name = f"\033[32;1m{t['id']}\033[0m \033[32m●\033[0m" + " " * (w_id - len(t["id"]))
            else:
                name = f"{t['id']:<{w_name_col}}"
            parent = t.get("parent", "")
            db = resolved.get("db", "")
            self.append_output(
                f"  {num}  {name}  {parent:<{w_parent}}  {db:<{w_db}}  {repos_str}"
            )

    def activate_target(self, target_id):
        all_targets = get_all_targets()
        resolved = resolve_target(target_id, all_targets)
        if not resolved:
            self.append_output(f"{TAG} Unknown target: '{target_id}'")
            ids = [t["id"] for t in all_targets]
            self.append_output(f"{TAG} Available: {', '.join(ids)}")
            return

        # Check all repos are clean
        for repo_entry in resolved["repos"]:
            repo = REPO_MAP.get(repo_entry["id"])
            if not repo:
                self.append_output(f"{TAG} \033[31mUnknown repo: {repo_entry['id']}\033[0m")
                return
            self.append_output(f"{TAG} {repo_entry['id']}: checking for uncommitted changes...")
            if self._is_dirty(repo["path"]):
                self.replace_last_output(
                    f"{TAG} \033[31m{repo_entry['id']} has uncommitted changes! Commit or stash first.\033[0m"
                )
                return
            self.replace_last_output(f"{TAG} {repo_entry['id']}: \033[32mclean\033[0m")

        # Stop server if running
        if self.process and self.process.poll() is None:
            self.append_output(f"{TAG} Stopping current server...")
            self.stop_process()

        # Switch branches and fetch
        for repo_entry in resolved["repos"]:
            repo = REPO_MAP[repo_entry["id"]]
            branch = repo_entry["branch"]
            path = repo["path"]

            # Fetch if stale
            did_fetch = False
            if self._should_fetch(repo_entry["id"], branch):
                self.append_output(f"{TAG} {repo_entry['id']}: fetching origin/{branch}...")
                fetch_result = self._git_run(["fetch", "origin", branch], cwd=path)
                if fetch_result.returncode == 0:
                    self._set_fetch_time(repo_entry["id"], branch)
                    self.replace_last_output(f"{TAG} {repo_entry['id']}: fetched origin/{branch}")
                    did_fetch = True
                else:
                    self.replace_last_output(
                        f"{TAG} {repo_entry['id']}: \033[33mfetch failed (offline?), continuing...\033[0m"
                    )
            else:
                self.append_output(f"{TAG} {repo_entry['id']}: origin/{branch} recently fetched, skipping")

            # Checkout
            self.append_output(f"{TAG} {repo_entry['id']}: checking out \033[36m{branch}\033[0m...")
            checkout = self._git_run(["checkout", branch], cwd=path)
            if checkout.returncode != 0:
                checkout = self._git_run(["checkout", "-b", branch, f"origin/{branch}"], cwd=path)
            if checkout.returncode != 0:
                self.replace_last_output(
                    f"{TAG} \033[31m{repo_entry['id']}: failed to checkout {branch}\033[0m"
                )
                self.append_output(f"{TAG} {checkout.stderr.strip()}")
                return
            self.replace_last_output(f"{TAG} {repo_entry['id']}: on \033[36m{branch}\033[0m")

            # Pull if fetched
            if did_fetch:
                self.append_output(f"{TAG} {repo_entry['id']}: pulling {branch}...")
                pull = self._git_run(["pull", "--ff-only", "origin", branch], cwd=path)
                if pull.returncode == 0:
                    self.replace_last_output(f"{TAG} {repo_entry['id']}: \033[32m{branch} up to date\033[0m")
                else:
                    self.replace_last_output(
                        f"{TAG} {repo_entry['id']}: \033[33mpull failed, branch may have diverged\033[0m"
                    )

        # Activate
        self.active_target_id = target_id
        self.resolved = resolved
        self._refresh_active_branch()
        self._refresh_repo_sync()
        self._save_state()
        self.draw_chrome()

        if resolved.get("auto_start"):
            self.append_output(f"{TAG} Target \033[1m{target_id}\033[0m activated, starting server...")
            self.start_odoo()
        else:
            self.append_output(f"{TAG} Target \033[1m{target_id}\033[0m activated. Use 's' to start.")

    # -------------------------------------------------------------------------
    # Drop database
    # -------------------------------------------------------------------------

    def drop_db(self):
        if not self.resolved:
            self.append_output(f"{TAG} No active target.")
            return
        db = self.resolved.get("db")
        if not db:
            self.append_output(f"{TAG} No database configured.")
            return
        if self.process and self.process.poll() is None:
            self.append_output(f"{TAG} Stopping server before dropping database...")
            self.stop_process()
        self.append_output(f"{TAG} Dropping database '{db}'...")
        result = subprocess.run(["dropdb", db], capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            self.replace_last_output(f"{TAG} \033[32mDatabase '{db}' dropped.\033[0m")
        else:
            self.replace_last_output(f"{TAG} \033[33mFailed to drop '{db}' (may not exist).\033[0m")

    # -------------------------------------------------------------------------
    # Status
    # -------------------------------------------------------------------------

    def show_status(self, out=None):
        out = out or self.append_output

        def git_info(path):
            try:
                branch = subprocess.run(
                    ["git", "branch", "--show-current"],
                    cwd=path, capture_output=True, text=True, timeout=3,
                ).stdout.strip() or "(detached)"
            except Exception:
                branch = "?"
            try:
                dirty = subprocess.run(
                    ["git", "status", "--porcelain"],
                    cwd=path, capture_output=True, text=True, timeout=3,
                ).stdout.strip()
                dirty_marker = "*" if dirty else ""
            except Exception:
                dirty_marker = ""
            try:
                result = subprocess.run(
                    ["git", "log", "-1", "--format=%ad\t%an\t%s", "--date=short"],
                    cwd=path, capture_output=True, text=True, timeout=3,
                ).stdout.strip()
                date, author, subject = result.split("\t", 2)
            except Exception:
                date, author, subject = "", "", ""
            return branch, dirty_marker, date, author, subject

        rows = []
        for repo in REPOS:
            if os.path.isdir(repo["path"]):
                rows.append((repo["id"], *git_info(repo["path"])))

        w_repo = max((len(r[0]) for r in rows), default=10)
        w_branch = max((len(r[1]) + len(r[2]) for r in rows), default=10)
        w_date = 10
        w_author = max((len(r[4]) for r in rows), default=8)

        cols, _ = get_terminal_size()
        fixed_width = 2 + w_repo + 2 + w_branch + 2 + w_date + 2 + w_author + 2
        w_subject = max(cols - fixed_width, 10)

        target_label = self.active_target_id or "none"
        header = (
            f"  \033[1m{'Repo':<{w_repo}}\033[0m  "
            f"\033[1m{'Branch':<{w_branch}}\033[0m  "
            f"\033[1m{'Date':<{w_date}}\033[0m  "
            f"\033[1m{'Author':<{w_author}}\033[0m  "
            f"\033[1m{'Commit':<{w_subject}}\033[0m"
        )
        out(f"\033[1m--- Status [{target_label}] ---\033[0m")
        out(header)

        for repo_name, branch, dirty, date, author, subject in rows:
            dirty_col = f"\033[33m{dirty}\033[0m" if dirty else ""
            branch_pad = w_branch - len(branch) - len(dirty)
            if len(subject) > w_subject:
                subject = subject[:w_subject - 3] + "..."
            row = (
                f"  \033[36m{repo_name:<{w_repo}}\033[0m  "
                f"{branch}{dirty_col}{' ' * max(0, branch_pad)}  "
                f"{date:<{w_date}}  "
                f"{author:<{w_author}}  "
                f"{subject}"
            )
            out(row)

    # -------------------------------------------------------------------------
    # PR tracking
    # -------------------------------------------------------------------------

    def _get_tracked_prs(self):
        data = load_data()
        return data.get("prs", [])

    def _save_tracked_prs(self, prs):
        data = load_data()
        data["prs"] = prs
        save_data(data)

    @staticmethod
    def _fetch_pr_info(url):
        try:
            result = subprocess.run(
                ["gh", "pr", "view", url, "--json", "title,state"],
                capture_output=True, text=True, timeout=15,
            )
            if result.returncode == 0:
                d = json.loads(result.stdout)
                state_map = {"OPEN": "pending", "CLOSED": "closed", "MERGED": "merged"}
                return d.get("title", ""), state_map.get(d.get("state", ""), "unknown")
        except Exception:
            pass
        return "", "unknown"

    @staticmethod
    def _github_to_mergebot_url(url):
        m = re.match(r"https://github\.com/(odoo/[^/]+/pull/\d+)", url)
        return f"https://mergebot.odoo.com/{m.group(1)}" if m else None

    @staticmethod
    def _fetch_mergebot_info(mergebot_url):
        runbot_status = ""
        review_status = ""
        ci_status = ""
        try:
            req = urllib.request.Request(mergebot_url, headers={"User-Agent": "odev/1.0"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                html = resp.read().decode("utf-8", errors="replace")

            if re.search(r'Staged\s+\d+\s+\w+\s+ago', html) or re.search(r'\bstaged\b', html):
                runbot_status = "Staged"
                review_status = "r+"
            elif re.search(r'merged\s+\d+\s+\w+\s+ago', html, re.IGNORECASE):
                runbot_status = "Merged"
                review_status = "r+"
            else:
                m = re.search(r'<p class="alert-\w+">\s*(.+?)\s*</p>', html)
                if m:
                    runbot_status = m.group(1).strip()
                m = re.search(r'<li class="(\w*)">\s*Review\s*</li>', html)
                if m:
                    cls = m.group(1).strip()
                    review_status = "r+" if cls == "ok" else "missing"
                m = re.search(r'<li class="\s*(\w*)\s*">\s*<a[^>]*>ci/runbot</a>', html)
                if m:
                    cls = m.group(1).strip()
                    ci_status = {"ok": "ok", "fail": "fail"}.get(cls, "pending")
        except Exception:
            pass
        return runbot_status, review_status, ci_status

    def track_pr(self, url, out=None):
        out = out or self.append_output
        if not url.startswith("https://github.com/") or "/pull/" not in url:
            out(f"{TAG} Invalid PR URL. Expected: https://github.com/<owner>/<repo>/pull/<number>")
            return
        prs = self._get_tracked_prs()
        if any(pr["url"] == url for pr in prs):
            out(f"{TAG} PR already tracked: {url}")
            return
        out(f"{TAG} Fetching PR info...")
        title, state = self._fetch_pr_info(url)
        if not title:
            out(f"{TAG} \033[33mCould not fetch PR info, tracking with URL only.\033[0m")
            title = "(unknown)"
        mergebot_url = self._github_to_mergebot_url(url)
        runbot_status, review_status, ci_status = "", "", ""
        if mergebot_url:
            runbot_status, review_status, ci_status = self._fetch_mergebot_info(mergebot_url)
        prs.append({
            "url": url, "title": title, "state": state,
            "runbot": runbot_status, "review": review_status, "ci": ci_status,
        })
        self._save_tracked_prs(prs)
        out(f"{TAG} \033[32mTracking:\033[0m {title} [{state}]")

    def show_prs(self, out=None):
        out = out or self.append_output
        prs = self._get_tracked_prs()
        if not prs:
            out(f"{TAG} No tracked PRs.")
            return

        out(f"{TAG} Refreshing PR statuses...")
        from concurrent.futures import ThreadPoolExecutor

        def _refresh_pr(pr):
            with ThreadPoolExecutor(max_workers=2) as inner:
                gh_future = inner.submit(self._fetch_pr_info, pr["url"])
                mergebot_url = self._github_to_mergebot_url(pr["url"])
                mb_future = inner.submit(self._fetch_mergebot_info, mergebot_url) if mergebot_url else None
                _, state = gh_future.result()
                runbot, review, ci = mb_future.result() if mb_future else ("", "", "")
            return state, runbot, review, ci

        with ThreadPoolExecutor(max_workers=len(prs)) as pool:
            results = list(pool.map(_refresh_pr, prs))

        for pr, (state, runbot, review, ci) in zip(prs, results):
            if state != "unknown":
                pr["state"] = state
            if runbot:
                pr["runbot"] = runbot
            if review:
                pr["review"] = review
            if ci:
                pr["ci"] = ci
        self._save_tracked_prs(prs)

        cols, _ = get_terminal_size()
        STATE_COLORS = {
            "pending": "\033[33m", "merged": "\033[32m",
            "closed": "\033[31m", "unknown": "\033[37m",
        }
        REVIEW_COLORS = {"r+": "\033[32m", "missing": "\033[31m"}

        def _repo_from_url(url):
            m = re.match(r"https://github\.com/[^/]+/([^/]+)/pull/", url)
            return m.group(1) if m else ""

        w_state = 7
        w_review = 7
        w_runbot = max((len(pr.get("runbot", "")) + (2 if pr.get("ci") else 0) for pr in prs), default=6)
        w_runbot = max(w_runbot, 6)
        w_repo = max((len(_repo_from_url(pr["url"])) for pr in prs), default=4)
        w_repo = max(w_repo, 4)
        fixed = 2 + w_state + 2 + w_review + 2 + w_runbot + 2 + w_repo + 2 + 2
        w_title = max(cols - fixed, 20)

        header = (
            f"  \033[1m{'Status':<{w_state}}\033[0m  "
            f"\033[1m{'Review':<{w_review}}\033[0m  "
            f"\033[1m{'Runbot':<{w_runbot}}\033[0m  "
            f"\033[1m{'Repo':<{w_repo}}\033[0m  "
            f"\033[1mTitle\033[0m"
        )
        out(header)

        for pr in prs:
            state_color = STATE_COLORS.get(pr["state"], "\033[37m")
            review = pr.get("review", "")
            review_color = REVIEW_COLORS.get(review, "\033[37m")
            runbot = pr.get("runbot", "")
            ci = pr.get("ci", "")
            repo_name = _repo_from_url(pr["url"])
            ci_icons = {"ok": "\033[32m✓\033[0m ", "fail": "\033[31m✗\033[0m ", "pending": "○ "}
            ci_prefix = ci_icons.get(ci, "")
            if ci == "pending" and "Blocked" in runbot:
                runbot = "pending"
            if "Ready" in runbot or runbot in ("Staged", "Merged"):
                runbot_color = "\033[32m"
            elif "Blocked" in runbot:
                runbot_color = "\033[31m"
            elif runbot == "pending":
                runbot_color = "\033[37m"
            else:
                runbot_color = "\033[33m"
            title = pr["title"]
            if len(title) > w_title:
                title = title[:w_title - 3] + "..."
            url_link = f"\033]8;;{pr['url']}\033\\{title}\033]8;;\033\\"
            runbot_visible_len = len(runbot) + (2 if ci else 0)
            runbot_pad = max(0, w_runbot - runbot_visible_len)
            runbot_cell = f"{ci_prefix}{runbot_color}{runbot}\033[0m{' ' * runbot_pad}"
            row = (
                f"  {state_color}{pr['state']:<{w_state}}\033[0m  "
                f"{review_color}{review:<{w_review}}\033[0m  "
                f"{runbot_cell}  "
                f"\033[36m{repo_name:<{w_repo}}\033[0m  "
                f"{url_link}"
            )
            out(row)

    def untrack_pr(self, url, out=None):
        out = out or self.append_output
        prs = self._get_tracked_prs()
        new_prs = [pr for pr in prs if pr["url"] != url]
        if len(new_prs) == len(prs):
            out(f"{TAG} PR not found: {url}")
            return
        self._save_tracked_prs(new_prs)
        out(f"{TAG} \033[32mUntracked:\033[0m {url}")

    # -------------------------------------------------------------------------
    # Help
    # -------------------------------------------------------------------------

    def show_help(self, out=None):
        out = out or self.append_output
        lines = [
            f"\033[1modev — Odoo Development Tool\033[0m",
            f"",
            f"\033[1mServer\033[0m",
            f"  \033[36ms\033[0m              Start the Odoo server with the active target",
            f"  \033[36mx\033[0m              Stop the running server",
            f"  \033[36mtest <tags>\033[0m    Run tests (e.g. test /web, test :TestClass.test_method)",
            f"  \033[36mtestjs\033[0m         Run JS unit tests (web:WebSuite) headless",
            f"  \033[36mtour <name>\033[0m    Run a specific tour (shortcut for test /<name>)",
            f"  \033[36mdropdb\033[0m         Drop the database for the active target",
            f"",
            f"\033[1mTargets\033[0m",
            f"  \033[36mt\033[0m              List all targets",
            f"  \033[36mt <id>\033[0m         Activate a target (checkout branches, fetch, start if auto_start)",
            f"",
            f"\033[1mBrowser\033[0m",
            f"  \033[36moo\033[0m             Open Odoo (localhost:8069) in Chrome",
            f"  \033[36mot [filter]\033[0m    Open the JS test runner in Chrome (optional filter)",
            f"  \033[36mop\033[0m             Open PR on runbot (TODO)",
            f"",
            f"\033[1mPR tracking\033[0m",
            f"  \033[36mp\033[0m              List tracked PRs with status",
            f"  \033[36mtrack <url>\033[0m    Track a GitHub PR",
            f"  \033[36muntrack <url>\033[0m  Remove a PR from tracking",
            f"",
            f"\033[1mTools\033[0m",
            f"  \033[36mtig\033[0m            Open tig in the active repo",
            f"  \033[36mgit [args]\033[0m     Run git in the active repo (default: status)",
            f"  \033[36mst\033[0m             Show status of all repositories",
            f"  \033[36mTab\033[0m            Cycle active repo",
            f"",
            f"\033[1mGeneral\033[0m",
            f"  \033[36mh\033[0m or \033[36m?\033[0m         Show this help",
            f"  \033[36mq\033[0m              Quit odev",
            f"  \033[36mCtrl-C\033[0m         Quit odev",
            f"",
            f"\033[1mCLI usage\033[0m (outside the TUI)",
            f"  \033[36modev\033[0m           Launch the interactive TUI",
            f"  \033[36modev st\033[0m        Print status and exit",
            f"  \033[36modev pr\033[0m        List tracked PRs and exit",
            f"  \033[36modev help\033[0m      Print this help and exit",
        ]
        for line in lines:
            out(line)

    # -------------------------------------------------------------------------
    # Fullscreen subprocess (tig, etc.)
    # -------------------------------------------------------------------------

    def run_fullscreen(self, *cmd, cwd=None):
        """Run a fullscreen TUI app, suspending odev's terminal control."""
        reset_scroll_region()
        show_cursor()
        if self.old_settings:
            termios.tcsetattr(sys.stdin, termios.TCSADRAIN, self.old_settings)
        try:
            subprocess.run(cmd, cwd=cwd)
        except FileNotFoundError:
            pass
        # Re-setup our terminal
        self.old_settings = termios.tcgetattr(sys.stdin)
        tty.setraw(sys.stdin.fileno())
        _, rows = get_terminal_size()
        set_scroll_region(1, rows - 2)
        move_cursor(rows - 2, 1)
        self.draw_chrome()

    # -------------------------------------------------------------------------
    # Command handling
    # -------------------------------------------------------------------------

    def handle_command(self, cmd):
        cmd = cmd.strip()
        if not cmd:
            return

        if cmd == "s":
            self.start_odoo()
        elif cmd == "x":
            if self.process and self.process.poll() is None:
                self.stop_process()
            else:
                self.append_output(f"{TAG} No server running.")
        elif cmd == "oo":
            if not (self.process and self.process.poll() is None):
                self.append_output(f"{TAG} Server is not running.")
            else:
                subprocess.Popen(
                    ["google-chrome", "http://localhost:8069"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
                self.append_output(f"{TAG} Opening http://localhost:8069 in Chrome...")
        elif cmd == "ot" or cmd.startswith("ot "):
            if not (self.process and self.process.poll() is None):
                self.start_odoo()
                self.append_output(f"{TAG} Waiting for server to be ready...")
                # Chrome will be opened once server is running; store pending URL
                filt = cmd.split(" ", 1)[1].strip() if cmd.startswith("ot ") else ""
                self._pending_chrome_url = self._build_test_url(filt)
            else:
                filt = cmd.split(" ", 1)[1].strip() if cmd.startswith("ot ") else ""
                url = self._build_test_url(filt)
                subprocess.Popen(
                    ["google-chrome", url],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
                self.append_output(f"{TAG} Opening {url} in Chrome...")
        elif cmd == "op":
            self.append_output(f"{TAG} TODO: open PR on runbot")
        elif cmd == "t":
            self.list_targets()
        elif cmd.startswith("t "):
            arg = cmd.split(" ", 1)[1].strip()
            if arg.isdigit():
                idx = int(arg)
                all_targets = get_all_targets()
                if 1 <= idx <= len(all_targets):
                    self.activate_target(all_targets[idx - 1]["id"])
                else:
                    self.append_output(f"{TAG} Invalid index: {idx} (1-{len(all_targets)})")
            else:
                self.activate_target(arg)
        elif cmd.startswith("test "):
            self.run_tests(cmd.split(" ", 1)[1].strip())
        elif cmd == "testjs":
            self.run_tests("/web:WebSuite")
        elif cmd.startswith("tour "):
            self.run_tour(cmd.split(" ", 1)[1].strip())
        elif cmd == "dropdb":
            self.drop_db()
        elif cmd == "st":
            self.show_status()
        elif cmd == "tig":
            self.run_fullscreen("tig", cwd=self._active_repo_path())
        elif cmd == "git" or cmd.startswith("git "):
            self._run_git_command(cmd)
        elif cmd == "p":
            self.show_prs()
        elif cmd.startswith("track "):
            self.track_pr(cmd.split(" ", 1)[1].strip())
        elif cmd.startswith("untrack "):
            self.untrack_pr(cmd.split(" ", 1)[1].strip())
        elif cmd in ("h", "?", "help"):
            self.show_help()
        elif cmd == "q":
            self.stop_process()
            self.running = False
        else:
            self.append_output(f"{TAG} Unknown command: '{cmd}'. Type 'h' for help.")

    # Git subcommands that may open an editor
    _GIT_INTERACTIVE = {"commit", "rebase", "merge", "tag", "stash"}

    def _run_git_command(self, cmd):
        """Run git in the active repo. Defaults to 'git status'."""
        parts = cmd.split(None, 1)
        git_args = parts[1] if len(parts) > 1 else "status"
        path = self._active_repo_path()
        repo_id = self._active_repo()["id"]

        # Detect if git subcommand may need an editor (interactive)
        git_sub = git_args.split()[0] if git_args else ""
        if git_sub in self._GIT_INTERACTIVE:
            self.append_output(f"{TAG} [{repo_id}] git {git_args}")
            self.run_fullscreen("git", *git_args.split(), cwd=path)
            self._refresh_repo_sync()
            return

        self.append_output(f"{TAG} [{repo_id}] git {git_args}")
        result = subprocess.run(
            f"git {git_args}", shell=True, cwd=path,
            capture_output=True, text=True, timeout=30,
        )
        output = result.stdout.strip() or result.stderr.strip()
        if output:
            for line in output.split("\n"):
                self.append_output(line)
        self._refresh_repo_sync()
        self.draw_chrome()

    # -------------------------------------------------------------------------
    # Input reading (raw mode)
    # -------------------------------------------------------------------------

    def read_key(self):
        if not select.select([sys.stdin], [], [], 0.1)[0]:
            return None
        ch = os.read(sys.stdin.fileno(), 1)
        if not ch:
            return None
        b = ch[0]

        if b == 27:  # ESC
            if select.select([sys.stdin], [], [], 0.05)[0]:
                seq = os.read(sys.stdin.fileno(), 5)
                if seq == b"[A":
                    return "UP"
                elif seq == b"[B":
                    return "DOWN"
                elif seq == b"[C":
                    return "RIGHT"
                elif seq == b"[D":
                    return "LEFT"
                elif seq == b"[H":
                    return "HOME"
                elif seq == b"[F":
                    return "END"
            return "ESC"
        elif b == 9:  # Tab
            return "TAB"
        elif b == 13:
            return "ENTER"
        elif b in (127, 8):
            return "BACKSPACE"
        elif b == 3:  # Ctrl-C
            return "CTRL_C"
        elif 32 <= b <= 126:
            return chr(b)
        return None

    # -------------------------------------------------------------------------
    # Handle terminal resize
    # -------------------------------------------------------------------------

    def handle_resize(self):
        cols, rows = get_terminal_size()
        reset_scroll_region()
        set_scroll_region(1, rows - 2)
        self.last_cols, self.last_rows = cols, rows
        self.draw_chrome()

    # -------------------------------------------------------------------------
    # Main loop
    # -------------------------------------------------------------------------

    def run(self):
        atexit.register(lambda: self.stop_process(silent=True))
        signal.signal(signal.SIGWINCH, lambda *_: self.handle_resize())

        self.setup_terminal()
        try:
            self.show_placeholder = True
            self._background_fetch_all()

            while self.running:
                key = self.read_key()
                if key is None:
                    continue

                if self.show_placeholder and key not in ("TAB", "ESC", None):
                    self.show_placeholder = False

                if key == "TAB":
                    self._cycle_repo()
                elif key == "ENTER":
                    cmd = self.input_buffer.strip()
                    if cmd:
                        # Add to history (avoid consecutive duplicates)
                        if not self.command_history or self.command_history[-1] != cmd:
                            self.command_history.append(cmd)
                            if len(self.command_history) > self.max_history:
                                self.command_history.pop(0)
                    self.history_index = -1
                    self.handle_command(self.input_buffer)
                    self.input_buffer = ""
                    self.cursor_pos = 0
                    self.draw_chrome()
                elif key == "BACKSPACE":
                    if self.cursor_pos > 0:
                        self.input_buffer = (
                            self.input_buffer[:self.cursor_pos - 1]
                            + self.input_buffer[self.cursor_pos:]
                        )
                        self.cursor_pos -= 1
                        self.draw_chrome()
                elif key == "LEFT":
                    if self.cursor_pos > 0:
                        self.cursor_pos -= 1
                        self.draw_chrome()
                elif key == "RIGHT":
                    if self.cursor_pos < len(self.input_buffer):
                        self.cursor_pos += 1
                        self.draw_chrome()
                elif key == "HOME":
                    self.cursor_pos = 0
                    self.draw_chrome()
                elif key == "END":
                    self.cursor_pos = len(self.input_buffer)
                    self.draw_chrome()
                elif key == "CTRL_C":
                    self.stop_process()
                    self.running = False
                elif key == "UP":
                    if self.command_history:
                        if self.history_index == -1:
                            self.history_saved_input = self.input_buffer
                            self.history_index = len(self.command_history) - 1
                        elif self.history_index > 0:
                            self.history_index -= 1
                        self.input_buffer = self.command_history[self.history_index]
                        self.cursor_pos = len(self.input_buffer)
                        self.draw_chrome()
                elif key == "DOWN":
                    if self.history_index != -1:
                        if self.history_index < len(self.command_history) - 1:
                            self.history_index += 1
                            self.input_buffer = self.command_history[self.history_index]
                        else:
                            self.history_index = -1
                            self.input_buffer = self.history_saved_input
                        self.cursor_pos = len(self.input_buffer)
                        self.draw_chrome()
                elif key == "ESC":
                    pass
                elif len(key) == 1:
                    self.input_buffer = (
                        self.input_buffer[:self.cursor_pos]
                        + key
                        + self.input_buffer[self.cursor_pos:]
                    )
                    self.cursor_pos += 1
                    self.draw_chrome()
        finally:
            self.stop_process()
            self.restore_terminal()


# =============================================================================
# CLI entry point
# =============================================================================

CLI_COMMANDS = {"st", "help", "pr", "track", "untrack"}

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else None
    if cmd in CLI_COMMANDS:
        app = Odev()
        if cmd == "st":
            app.show_status(out=print)
        elif cmd == "help":
            app.show_help(out=print)
        elif cmd == "pr":
            app.show_prs(out=print)
        elif cmd == "track" and len(sys.argv) > 2:
            app.track_pr(sys.argv[2], out=print)
        elif cmd == "untrack" and len(sys.argv) > 2:
            app.untrack_pr(sys.argv[2], out=print)
        else:
            print(f"Usage: odev {cmd} <url>")
    else:
        app = Odev()
        app.run()
