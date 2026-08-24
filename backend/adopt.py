"""Automatically register worktree directories that aren't yet known to goo.

Runs as a daemon thread (loop()) started from server.main() -- periodically
scans config's worktree_dir for subdirectories containing a git checkout of
any configured repo, and registers any that aren't already a workspace, so
worktrees created by hand, by an external script, or by anything else all show
up in the dashboard without a manual step.
"""

import datetime
import os
import subprocess
import time

from .server import CONFIG

SCAN_INTERVAL = 60


def _current_branch(path):
    if not os.path.exists(os.path.join(path, ".git")):
        return None
    try:
        r = subprocess.run(
            ["git", "branch", "--show-current"],
            cwd=path,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except subprocess.TimeoutExpired:
        return None
    if r.returncode != 0:
        return None
    return r.stdout.strip() or None


def scan_and_register():
    snapshot = CONFIG.get()
    config = snapshot.get("config") or {}
    rev = snapshot.get("rev", 0)
    worktree_dir = os.path.expanduser(config.get("worktree_dir") or "")
    repo_ids = [r["id"] for r in config.get("repos", []) if r.get("id")]
    if not worktree_dir or not os.path.isdir(worktree_dir) or not repo_ids:
        return

    existing_ids = {w.get("id") for w in (config.get("workspaces") or [])}
    # never adopt whatever directory holds a configured repo's own main
    # checkout (e.g. worktree_dir/master, which holds .../master/odoo)
    main_dirs = {
        os.path.dirname(os.path.expanduser(r["path"]))
        for r in config.get("repos", [])
        if r.get("path")
    }

    adopted = []
    for name in sorted(os.listdir(worktree_dir)):
        if name in existing_ids:
            continue
        ws_dir = os.path.join(worktree_dir, name)
        if ws_dir in main_dirs or not os.path.isdir(ws_dir):
            continue
        checkouts = []
        for rid in repo_ids:
            branch = _current_branch(os.path.join(ws_dir, rid))
            if branch:
                checkouts.append({"repo": rid, "branch": branch})
        if not checkouts:
            continue
        db = checkouts[0]["branch"]
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        adopted.append(
            {
                "id": name,
                "name": name,
                "created_at": now,
                "last_activity": now,
                "favorite": False,
                "category": "",
                "parent": "",
                "db": db,
                "on_create_args": "",
                "demo_data": True,
                "location": "worktree",
                "checkouts": checkouts,
                "worktree": {"base": "", "dir": ws_dir},
            }
        )

    if not adopted:
        return

    for attempt in range(3):
        ok, result = CONFIG.save(
            rev, config={**config, "workspaces": [*(config.get("workspaces") or []), *adopted]}
        )
        if ok:
            names = [w["id"] for w in adopted]
            print(f"[goo] adopted {len(adopted)} workspace(s): {names}", flush=True)
            return
        if result.get("conflict") and attempt < 2:
            rev = result.get("rev", rev)
            config = result.get("config") or config
            continue
        print(f"[goo] adopt scan: config write failed: {result}", flush=True)
        return


def loop():
    """Run the scan at startup and then every SCAN_INTERVAL seconds, for as
    long as this goo process stays up. A failed scan is logged, never takes
    the server down."""
    while True:
        try:
            scan_and_register()
        except Exception as e:
            print(f"[goo] adopt scan failed: {e}", flush=True)
        time.sleep(SCAN_INTERVAL)
