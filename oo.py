#!/usr/bin/env python3
"""oo - Odoo development toolkit"""

import argparse
import os
import pty
import signal
import subprocess
import sys

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib


# =============================================================================
# Constants
# =============================================================================

CONFIG_DIR = os.path.expanduser("~/.config/oo")
CONFIG_FILE = os.path.join(CONFIG_DIR, "config.toml")
STATE_FILE = os.path.join(CONFIG_DIR, "state.toml")
PID_FILE = os.path.join(CONFIG_DIR, "server.pid")

TAG = "\033[38;5;208m[oo]\033[0m"

DEFAULT_ARGS = {
    "on_create_args": "-i sale_management",
    "other_args": "--dev all",
}

CONFIG_TEMPLATE = """\
# oo configuration
# Edit this file or run: oo config

# ---------------------------------------------------------------------------
# General settings
# ---------------------------------------------------------------------------

# Working directory containing your Odoo repos
# work_dir = "/home/odoo/work"

# Python virtualenv activation command (run before odoo-bin)
# venv_activate = "source /home/odoo/work/env20/bin/activate"

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

# [database]
# user = "odoo"
# password = "odoo"

# ---------------------------------------------------------------------------
# Default server arguments
# ---------------------------------------------------------------------------

# [defaults]
# on_create_args = "-i sale_management"   # applied only when db is new
# other_args = "--dev all"                 # always applied

# ---------------------------------------------------------------------------
# Repositories
# ---------------------------------------------------------------------------
# Each [[repos]] entry defines a repo with an id and a filesystem path.

# [[repos]]
# id = "community"
# path = "/home/odoo/work/community"

# [[repos]]
# id = "enterprise"
# path = "/home/odoo/work/enterprise"

# [[repos]]
# id = "tutorials"
# path = "/home/odoo/work/tutorials"

# ---------------------------------------------------------------------------
# Targets
# ---------------------------------------------------------------------------
# Targets define what "oo start" runs. Children inherit from parents.
#
# Fields:
#   id             - unique name (required)
#   parent         - id of parent target (optional, for inheritance)
#   repos          - list of repo ids to use (inherited if omitted)
#   branch         - git branch (inherited if omitted; if set without repos,
#                    overrides branch for ALL inherited repos)
#   db             - database name
#   on_create_args - extra args when db is created for the first time
#   other_args     - extra args always applied

# [[targets]]
# id = "community"
# repos = ["community"]
# branch = "master"
# db = "test_db"

# [[targets]]
# id = "enterprise"
# repos = ["community", "enterprise"]
# branch = "master"
# db = "test_db_e"

# [[targets]]
# id = "19.0"
# repos = ["community"]
# branch = "19.0"
# db = "test_db_19"

# [[targets]]
# id = "19.0e"
# repos = ["community", "enterprise"]
# branch = "19.0"
# db = "test_db_19e"

# Example child target (inherits repos from parent, overrides branch):
# [[targets]]
# id = "my-task"
# parent = "enterprise"
# branch = "master-my-task-ged"
# db = "test_db_task"
"""


# =============================================================================
# Config
# =============================================================================

def ensure_config():
    """Create config dir and template file if they don't exist."""
    os.makedirs(CONFIG_DIR, exist_ok=True)
    if not os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "w") as f:
            f.write(CONFIG_TEMPLATE)
        print(f"{TAG} Config file created at {CONFIG_FILE}")
        print(f"{TAG} Run 'oo config' to edit it.")
        return True
    return False


def load_config():
    """Load and parse the config file. Returns dict."""
    ensure_config()
    with open(CONFIG_FILE, "rb") as f:
        return tomllib.load(f)


def load_state():
    """Load the state file. Returns dict."""
    if not os.path.exists(STATE_FILE):
        return {}
    with open(STATE_FILE, "rb") as f:
        return tomllib.load(f)


def save_state(state):
    """Write state to the state file (simple key=value TOML)."""
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with open(STATE_FILE, "w") as f:
        for key, value in state.items():
            if isinstance(value, str):
                f.write(f'{key} = "{value}"\n')
            else:
                f.write(f"{key} = {value}\n")


# =============================================================================
# Target resolution
# =============================================================================

def find_target(target_id, targets):
    """Find a target by id in the target list."""
    for t in targets:
        if t.get("id") == target_id:
            return t
    return None


def resolve_target(target_id, targets, defaults=None):
    """Walk the parent chain and resolve repos, branches, db, args.

    Resolution rules:
    - repos: combined from all ancestors (root first, then down)
    - branch per repo: determined by the target that listed that repo.
      If a target has a branch but no repos, it overrides the branch
      for ALL inherited repos (the "task/feature branch" case).
    - db, on_create_args, other_args: first non-None value walking
      from child up to root, then defaults.
    """
    if defaults is None:
        defaults = DEFAULT_ARGS

    target = find_target(target_id, targets)
    if not target:
        return None

    # Build chain from child to root
    chain = []
    current = target
    seen = set()
    while current:
        if current["id"] in seen:
            break
        seen.add(current["id"])
        chain.append(current)
        parent_id = current.get("parent")
        current = find_target(parent_id, targets) if parent_id else None

    # Reverse: root first
    chain.reverse()

    # Resolve repos and their branches
    repo_branches = {}
    for level in chain:
        level_repos = level.get("repos", [])
        level_branch = level.get("branch")

        if level_repos and level_branch:
            for repo_id in level_repos:
                repo_branches[repo_id] = level_branch
        elif level_repos and not level_branch:
            for repo_id in level_repos:
                if repo_id not in repo_branches:
                    repo_branches[repo_id] = _find_ancestor_branch(chain, level)
        elif level_branch and not level_repos:
            for repo_id in repo_branches:
                repo_branches[repo_id] = level_branch

    # Resolve scalar fields (child overrides parent, defaults as fallback)
    resolved = {"id": target_id, "repos": []}
    for field in ("db", "on_create_args", "other_args"):
        for level in reversed(chain):  # child first
            if field in level and level[field] is not None:
                resolved[field] = level[field]
                break
        else:
            if field in defaults:
                resolved[field] = defaults[field]

    # Build ordered repo list (root repos first)
    seen_repos = []
    for level in chain:
        for repo_id in level.get("repos", []):
            if repo_id not in seen_repos:
                seen_repos.append(repo_id)
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
# Server helpers
# =============================================================================

def get_repo_map(config):
    """Build a {id: repo_dict} map from config repos."""
    return {r["id"]: r for r in config.get("repos", [])}


def build_odoo_cmd(config, resolved):
    """Build the odoo-bin shell command string. Returns (cmd, db) or (None, None)."""
    repo_map = get_repo_map(config)

    db = resolved.get("db")
    if not db:
        print(f"{TAG} No database configured for target '{resolved['id']}'.")
        return None, None

    community = repo_map.get("community")
    if not community:
        print(f"{TAG} No 'community' repo defined in config.")
        return None, None

    community_path = community["path"]

    # Build addons path
    addons_parts = []
    for repo_entry in resolved["repos"]:
        repo = repo_map.get(repo_entry["id"])
        if not repo:
            print(f"{TAG} Warning: repo '{repo_entry['id']}' not found in config, skipping.")
            continue
        if repo_entry["id"] == "community":
            addons_parts.append("addons")
        else:
            addons_parts.append(os.path.relpath(repo["path"], community_path))
    addons_path = ",".join(addons_parts)

    db_user = config.get("database", {}).get("user", "odoo")
    db_password = config.get("database", {}).get("password", "odoo")
    venv_activate = config.get("general", {}).get("venv_activate", "")

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
    return " && ".join(parts), db


def db_exists(db_name):
    """Check if a PostgreSQL database exists."""
    try:
        result = subprocess.run(
            ["psql", "-lqt"], capture_output=True, text=True, timeout=5,
        )
        existing = {
            line.split("|")[0].strip()
            for line in result.stdout.split("\n")
            if "|" in line
        }
        return db_name in existing
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return True  # assume exists if we can't check


def read_pid():
    """Read PID from pid file. Returns int or None."""
    if not os.path.exists(PID_FILE):
        return None
    try:
        with open(PID_FILE) as f:
            return int(f.read().strip())
    except (ValueError, OSError):
        return None


def is_process_alive(pid):
    """Check if a process is still running."""
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def write_pid(pid):
    """Write PID to pid file."""
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with open(PID_FILE, "w") as f:
        f.write(str(pid))


def remove_pid():
    """Remove the PID file."""
    try:
        os.remove(PID_FILE)
    except FileNotFoundError:
        pass


def kill_port(port):
    """Kill any process listening on the given port."""
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


# =============================================================================
# Commands
# =============================================================================

def cmd_start(args, config):
    """Start the Odoo server for the active target."""
    # Check if already running
    pid = read_pid()
    if pid and is_process_alive(pid):
        print(f"{TAG} Server already running (PID {pid}). Use 'oo restart' or 'oo stop' first.")
        return 1

    state = load_state()
    active = state.get("active_target")
    if not active:
        print(f"{TAG} No active target. Set one with 'oo target <id>'.")
        return 1

    targets = config.get("targets", [])
    resolved = resolve_target(active, targets, config.get("defaults", {}))
    if not resolved:
        available = [t["id"] for t in targets]
        print(f"{TAG} Target '{active}' not found. Available: {', '.join(available) or '(none)'}")
        return 1

    base_cmd, db = build_odoo_cmd(config, resolved)
    if not base_cmd:
        return 1

    # Check if DB is new
    is_new = not db_exists(db)
    other_args = resolved.get("other_args", "")
    on_create_args = resolved.get("on_create_args", "")

    extra = f" {other_args}" if other_args else ""
    if is_new and on_create_args:
        extra += f" {on_create_args}"
        print(f"{TAG} New database '{db}', applying on_create_args: {on_create_args}")

    cmd = f"{base_cmd}{extra}"

    print(f"{TAG} Starting Odoo ({resolved['id']})...")
    print(f"{TAG} {cmd}")

    # Spawn with PTY
    master_fd, slave_fd = pty.openpty()
    process = subprocess.Popen(
        cmd, shell=True, executable="/bin/bash",
        stdout=slave_fd, stderr=slave_fd, stdin=slave_fd,
        preexec_fn=os.setsid,
    )
    os.close(slave_fd)
    write_pid(process.pid)

    # Handle signals for clean shutdown
    def shutdown(signum, frame):
        print(f"\n{TAG} Stopping server...")
        try:
            pgid = os.getpgid(process.pid)
            os.killpg(pgid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(pgid, signal.SIGKILL)
                process.wait(timeout=3)
        except (ProcessLookupError, OSError):
            pass
        kill_port(8069)
        remove_pid()
        try:
            os.close(master_fd)
        except OSError:
            pass
        print(f"{TAG} Server stopped.")
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    # Stream output
    server_ready = False
    try:
        while True:
            try:
                data = os.read(master_fd, 4096)
            except OSError:
                break
            if not data:
                break
            text = data.decode("utf-8", errors="replace")
            sys.stdout.write(text)
            sys.stdout.flush()
            if not server_ready and "odoo.registry: Registry loaded" in text:
                server_ready = True
                print(f"\n{TAG} Server ready.")
    except KeyboardInterrupt:
        shutdown(None, None)

    # Process ended on its own
    remove_pid()
    try:
        os.close(master_fd)
    except OSError:
        pass
    ret = process.wait()
    if ret != 0:
        print(f"{TAG} Server exited with code {ret}.")
    return ret


def cmd_stop(args, config):
    """Stop the running Odoo server."""
    pid = read_pid()
    if not pid or not is_process_alive(pid):
        print(f"{TAG} Server is not running.")
        remove_pid()
        return 0

    print(f"{TAG} Stopping server (PID {pid})...")
    try:
        pgid = os.getpgid(pid)
        os.killpg(pgid, signal.SIGTERM)
        # Wait for process to exit
        for _ in range(50):  # 5 seconds
            if not is_process_alive(pid):
                break
            import time
            time.sleep(0.1)
        else:
            os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, OSError):
        pass

    kill_port(8069)
    remove_pid()
    print(f"{TAG} Server stopped.")
    return 0


def cmd_restart(args, config):
    """Stop then start the server."""
    cmd_stop(args, config)
    return cmd_start(args, config)


def cmd_config(args, config):
    """Open the config file in $EDITOR."""
    ensure_config()
    editor = os.environ.get("EDITOR", "nano")
    os.execvp(editor, [editor, CONFIG_FILE])


def cmd_target(args, config):
    """Show or set the active target."""
    state = load_state()
    targets = config.get("targets", [])

    if args.target_id:
        # Set active target
        target = find_target(args.target_id, targets)
        if not target:
            available = [t["id"] for t in targets]
            print(f"{TAG} Target '{args.target_id}' not found. Available: {', '.join(available) or '(none)'}")
            return 1
        state["active_target"] = args.target_id
        save_state(state)
        print(f"{TAG} Active target set to '{args.target_id}'.")
        return 0

    # Show active target
    active = state.get("active_target")
    if active:
        resolved = resolve_target(active, targets, config.get("defaults", {}))
        if resolved:
            repos_info = ", ".join(f"{r['id']}@{r['branch']}" for r in resolved["repos"])
            print(f"Active target: {active}")
            print(f"  repos:  {repos_info}")
            print(f"  db:     {resolved.get('db', '(not set)')}")
        else:
            print(f"Active target: {active} (not found in config)")
    else:
        print("No active target. Set one with 'oo target <id>'.")

    if targets:
        print(f"\nAvailable targets: {', '.join(t['id'] for t in targets)}")
    return 0


def cmd_status(config):
    """Print a short status summary."""
    state = load_state()
    active = state.get("active_target", "(none)")
    pid = read_pid()
    running = pid and is_process_alive(pid)

    print(f"target: {active}")
    if running:
        print(f"server: running (PID {pid})")
    else:
        print("server: stopped")
    return 0


# =============================================================================
# CLI
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        prog="oo",
        description="Odoo development toolkit (by GED)",
    )
    subparsers = parser.add_subparsers(dest="command", title="commands", metavar="")

    subparsers.add_parser("start", help="Start the Odoo server")
    subparsers.add_parser("stop", help="Stop the Odoo server")
    subparsers.add_parser("restart", help="Restart the Odoo server")
    subparsers.add_parser("config", help="Open config file in $EDITOR")

    p_target = subparsers.add_parser("target", help="Show or set the active target")
    p_target.add_argument("target_id", nargs="?", help="Target to activate")

    args = parser.parse_args()

    if args.command == "config":
        # config doesn't need to load/parse the config
        cmd_config(args, None)
        return

    config = load_config()

    if args.command is None:
        sys.exit(cmd_status(config))
    elif args.command == "start":
        sys.exit(cmd_start(args, config))
    elif args.command == "stop":
        sys.exit(cmd_stop(args, config))
    elif args.command == "restart":
        sys.exit(cmd_restart(args, config))
    elif args.command == "target":
        sys.exit(cmd_target(args, config))


if __name__ == "__main__":
    main()
