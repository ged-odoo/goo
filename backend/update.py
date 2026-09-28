"""The goo self-update git probes: how goo's own checkout compares to
origin/master, and the safe fast-forward onto it. The shared update state
(GOO_UPDATE), the hourly check loop and the re-exec stay in server.py."""

import subprocess
from typing import Any

from .effects import run
from .processes import GOO_DIR


def _git_goo(*args: str, timeout: float = 10) -> subprocess.CompletedProcess[str] | None:
    """Run a git command in goo's own checkout. Returns the CompletedProcess, or
    None if git is missing / times out."""
    try:
        # probes for the update check — a non-zero exit (no repo / no origin/master)
        # is an expected outcome, not an error to log
        return run(
            ["git", "-C", GOO_DIR, *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            quiet=True,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None


def goo_update_status() -> dict[str, Any]:
    """How goo's checkout compares to (the already-fetched) origin/master — no
    network. Returns {checked, is_repo, branch, behind, ahead, dirty,
    can_fast_forward}. `behind` = commits on origin/master missing locally; `ahead`
    = local commits not on origin/master (the user's own work). A fast-forward is
    only offered when behind>0, ahead==0 and the tree is clean."""
    base = {
        "checked": True,
        "is_repo": False,
        "branch": "",
        "behind": 0,
        "ahead": 0,
        "dirty": False,
        "can_fast_forward": False,
    }
    inside = _git_goo("rev-parse", "--is-inside-work-tree")
    if not inside or inside.returncode != 0 or inside.stdout.strip() != "true":
        return base
    base["is_repo"] = True
    branch = _git_goo("rev-parse", "--abbrev-ref", "HEAD")
    base["branch"] = branch.stdout.strip() if branch and branch.returncode == 0 else ""
    # need origin/master to compare against (populated by the startup fetch)
    om = _git_goo("rev-parse", "--verify", "--quiet", "origin/master")
    if not om or om.returncode != 0:
        return base
    behind = _git_goo("rev-list", "--count", "HEAD..origin/master")
    ahead = _git_goo("rev-list", "--count", "origin/master..HEAD")
    dirty = _git_goo("status", "--porcelain")
    base["behind"] = int(behind.stdout.strip()) if behind and behind.returncode == 0 else 0
    base["ahead"] = int(ahead.stdout.strip()) if ahead and ahead.returncode == 0 else 0
    base["dirty"] = bool(dirty.stdout.strip()) if dirty and dirty.returncode == 0 else False
    base["can_fast_forward"] = base["behind"] > 0 and base["ahead"] == 0 and not base["dirty"]
    return base


def goo_fast_forward() -> tuple[bool, str | None]:
    """Fast-forward goo onto origin/master, but only when it's still provably safe
    (re-validated to avoid a TOCTOU race). Returns (ok, error)."""
    status = goo_update_status()
    if not status["can_fast_forward"]:
        if status["ahead"]:
            return False, "local commits on top of master — update manually (git pull --rebase)"
        if status["dirty"]:
            return False, "the working tree is dirty — commit or stash first"
        return False, "nothing to fast-forward"
    r = _git_goo("merge", "--ff-only", "origin/master", timeout=30)
    if not r:
        return False, "git not available or timed out"
    if r.returncode != 0:
        msg = (r.stderr.strip() or r.stdout.strip()).split("\n")[-1]
        return False, msg or "git merge --ff-only failed"
    return True, None
