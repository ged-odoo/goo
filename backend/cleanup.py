"""Optional daily cleanup of merged worktree workspaces.

Off by default (see the cleanup_enabled setting) — this deletes things
automatically, so it's opt-in. When enabled, runs as a daemon thread (loop())
started from server.main(): at startup, then every 24h, for as long as goo
stays running. Also runnable directly — `python3 -m backend.cleanup
[--dry-run]` — which always runs once regardless of the setting, since running
it by hand is an explicit request.

Deletes a workspace's worktrees, local branches, database, and filestore once
every checkout that has a PR shows it merged (skipped entirely if no checkout
has a PR yet — work in progress), and only if no worktree has uncommitted or
unpushed changes. Branches are deleted locally only, never on the remote —
recoverable from there if this ever gets something wrong.
"""

import argparse
import logging
import logging.handlers
import os
import subprocess
import sys
import time

from . import effects
from .server import CONFIG, GIT, GITHUB

STATE_DIR = os.path.expanduser("~/.local/state/goo")
LOG_PATH = os.path.join(STATE_DIR, "cleanup.log")
DAY = 86400

log = logging.getLogger("goo.cleanup")


def _setup_logging():
    if log.handlers:  # loop() calls run() repeatedly — only wire handlers once
        return
    os.makedirs(STATE_DIR, exist_ok=True)
    log.setLevel(logging.INFO)
    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(logging.Formatter("%(message)s"))
    log.addHandler(stream)
    rotating = logging.handlers.RotatingFileHandler(LOG_PATH, maxBytes=1_000_000, backupCount=3)
    rotating.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
    log.addHandler(rotating)


def _notify(summary):
    try:
        subprocess.run(["notify-send", "goo cleanup", summary], timeout=5)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass


def _merge_gate(ws, repo_map):
    """(ok, reason): ok is True only once every checkout with a PR is merged
    (a checkout with no PR at all is ignored — e.g. a repo this change never
    touched); False (with the reason) if nothing has a PR yet, or anything
    that does isn't merged."""
    pairs = []
    for c in ws.get("checkouts", []):
        repo = repo_map.get(c.get("repo"))
        github = repo.get("github") if repo else None
        if github and c.get("branch"):
            pairs.append({"github": github, "branch": c["branch"]})
    if not pairs:
        return False, "no repo/github info for its checkouts"
    prs = GITHUB.prs_for_branches(pairs)
    pr_by_key = {(pr["github"], pr["branch"]): pr for pr in prs}
    has_any_pr = False
    for p in pairs:
        pr = pr_by_key.get((p["github"], p["branch"]))
        if not pr:
            continue
        has_any_pr = True
        if pr["state"] != "merged":
            return False, f"{p['branch']} ({p['github']}) PR is {pr['state']}, not merged"
    if not has_any_pr:
        return False, "no PR yet (WIP)"
    return True, "every checkout with a PR is merged"


def _safety_guard(ws, repo_map):
    """None if clean; else a reason string to skip on."""
    repos = []
    for c in ws.get("checkouts", []):
        repo = repo_map.get(c.get("repo"))
        if not repo:
            continue
        repos.append(
            {
                "id": c["repo"],
                "path": f"{ws['worktree']['dir']}/{c['repo']}",
                "pull_remote": repo.get("pull_remote"),
            }
        )
    for entry in GIT.branches(repos):
        if entry.get("error"):
            return f"{entry['id']}: {entry['error']}"
        if entry.get("dirty"):
            return f"{entry['id']}: uncommitted changes"
        if not entry.get("head_pushed"):
            return f"{entry['id']}: unpushed commits"
    return None


def _delete(ws, repo_map, config, dry_run):
    ws_dir = ws["worktree"]["dir"]
    db = ws.get("db")
    for c in ws.get("checkouts", []):
        repo = repo_map.get(c.get("repo"))
        if not repo:
            continue
        main_path = os.path.expanduser(repo["path"])
        worktree_path = f"{ws_dir}/{c['repo']}"
        if dry_run:
            log.info(f"  [dry-run] would remove worktree + branch: {worktree_path} ({c['branch']})")
            continue
        ok, error = GIT.worktree_remove(main_path, worktree_path, repo=c["repo"])
        if not ok:
            log.info(f"  worktree_remove {worktree_path} failed: {error}")
        # local only, never the remote -- always recoverable there if this
        # cleanup ever gets something wrong
        ok, error, _remote_error = GIT.delete_branch(main_path, c["branch"], delete_remote=False)
        if not ok:
            log.info(f"  delete_branch {c['branch']} in {main_path} failed: {error}")

    if db:
        if dry_run:
            log.info(f"  [dry-run] would drop database + filestore: {db}")
        else:
            # plain dropdb, not a docker-exec or similar -- relies on the same
            # PG* connection env vars server.main() already seeds from
            # db_user/db_host/db_port, so this works the same way goo's own
            # database queries do, whatever kind of Postgres setup it is
            db_user = config.get("db_user") or "odoo"
            try:
                r = subprocess.run(
                    ["dropdb", "-U", db_user, "--if-exists", db],
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                if r.returncode != 0:
                    log.info(f"  dropdb {db} failed (may never have run): {r.stderr.strip()}")
            except (FileNotFoundError, subprocess.TimeoutExpired) as e:
                log.info(f"  dropdb {db} failed: {e}")
            filestore = config.get("filestore")
            if filestore:
                effects.remove_tree(os.path.join(os.path.expanduser(filestore), db))

    if dry_run:
        log.info(f"  [dry-run] would remove directory: {ws_dir}")
    else:
        effects.remove_tree(ws_dir)


def run(dry_run=False):
    _setup_logging()
    snapshot = CONFIG.get()
    config = snapshot.get("config") or {}
    rev = snapshot.get("rev", 0)
    repo_map = {r["id"]: r for r in config.get("repos", []) if r.get("id")}
    workspaces = [w for w in (config.get("workspaces") or []) if w.get("location") == "worktree"]

    deleted_ids, deleted_names, warned = [], [], []
    for ws in workspaces:
        name = ws.get("name") or ws.get("id")
        ok, reason = _merge_gate(ws, repo_map)
        if not ok:
            log.info(f"skip {name}: {reason}")
            continue
        guard = _safety_guard(ws, repo_map)
        if guard:
            log.info(f"skip {name}: safety guard — {guard}")
            warned.append(f"{name}: {guard}")
            continue
        log.info(f"deleting {name}: {reason}")
        _delete(ws, repo_map, config, dry_run)
        deleted_ids.append(ws["id"])
        deleted_names.append(name)

    if deleted_ids and not dry_run:
        for attempt in range(3):
            kept = [w for w in (config.get("workspaces") or []) if w.get("id") not in deleted_ids]
            ok, result = CONFIG.save(rev, config={**config, "workspaces": kept})
            if ok:
                break
            if result.get("conflict") and attempt < 2:
                rev = result.get("rev", rev)
                config = result.get("config") or config
                continue
            log.info(f"warning: config write failed after deleting {deleted_names}: {result}")

    if deleted_names or warned:
        parts = []
        if deleted_names:
            parts.append(f"deleted {len(deleted_names)}: {', '.join(deleted_names)}")
        if warned:
            parts.append(f"skipped {len(warned)} (needs attention): {', '.join(warned)}")
        _notify("; ".join(parts))


def loop():
    """Run the cleanup at startup and then every 24h, for as long as this goo
    process stays up, but only when cleanup_enabled is on (checked fresh each
    time, so flipping it in the Config screen takes effect on the next tick
    without a restart). A failed run is logged, never takes the server down."""
    while True:
        try:
            config = CONFIG.get()["config"] or {}
            if config.get("cleanup_enabled"):
                run()
        except Exception as e:
            log.error(f"cleanup run failed: {e}")
        time.sleep(DAY)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    run(dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
