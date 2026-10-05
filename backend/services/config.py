"""The server-owned config store + the launch-config builder."""

import os
import re
import threading
from collections.abc import Callable
from typing import Any

# ─────────────────────────── Config store ───────────────────────────

_KEEP = object()  # sentinel: "leave this blob unchanged" in ConfigStore.save


class ConfigStore:
    """The server-owned config file: {rev, config, state}, persisted atomically.

    `config` (the user's settings/repos/targets) and `state` (app-recorded: active
    target, test history, claude model) are opaque JSON blobs — the schema
    lives in the frontend (static/src/core/config.ts); the server only versions them under
    one shared `rev`, guards concurrent writes, and reads a few well-known fields for
    the CLI / auto-reloader. A missing file reads as rev 0 with null blobs (the client
    seeds it on first boot). Writes go through the effects seam, so it's unit-testable.
    """

    def __init__(self, io: Any, path: str, notify: Callable[..., None] | None = None) -> None:
        self.io = io
        self.path = path
        self._notify = notify  # called with the new {rev, config, state} after a save
        self._lock = threading.Lock()
        self._cache = None  # {rev, config, state}, lazily loaded

    def _load(self) -> dict[str, Any]:
        data, error = self.io.read_json_file(self.path)
        if error:
            # a corrupt file: don't clobber it — surface rev 0 so the client can decide
            return {"rev": 0, "config": None, "state": None, "error": error}
        if not data:
            return {"rev": 0, "config": None, "state": None}
        return {
            "rev": data.get("rev", 0),
            "config": data.get("config"),
            "state": data.get("state"),
        }

    def get(self) -> dict[str, Any]:
        """The current {rev, config, state} (cached after first read)."""
        with self._lock:
            if self._cache is None:
                self._cache = self._load()
            return dict(self._cache)

    def save(
        self, rev: int, config: Any = _KEEP, state: Any = _KEEP
    ) -> tuple[bool, dict[str, Any]]:
        """Replace `config` and/or `state` (whichever isn't _KEEP) iff `rev` matches the
        current rev. Returns (ok, result): on success (True, {rev, config, state}) with
        rev bumped; on a stale rev (False, {conflict:True, rev, config, state}) leaving
        the file untouched; on a write failure (False, {error})."""
        with self._lock:
            cur = self._cache if self._cache is not None else self._load()
            self._cache = cur
            if rev != cur.get("rev", 0):
                return False, {
                    "conflict": True,
                    "rev": cur.get("rev", 0),
                    "config": cur.get("config"),
                    "state": cur.get("state"),
                }
            new = {
                "rev": cur.get("rev", 0) + 1,
                "config": cur.get("config") if config is _KEEP else config,
                "state": cur.get("state") if state is _KEEP else state,
            }
            ok, error = self.io.write_json_file(self.path, new)
            if not ok:
                return False, {"error": error}
            self._cache = new
            if self._notify:
                self._notify(dict(new))
            return True, dict(new)


def _worktree_slug(target: dict[str, Any]) -> str | None:
    """Filesystem-safe folder name for a worktree target — the Python twin of
    utils.js worktreeSlug (case-preserving, falls back to the stable id)."""
    s = re.sub(r"(^-+|-+$)", "", re.sub(r"[^a-zA-Z0-9._-]+", "-", target.get("name") or ""))
    return s or target.get("id")


def _worktree_dir(config: dict[str, Any], target: dict[str, Any]) -> str:
    """A worktree target's on-disk directory: its persisted `worktree.dir` (frozen at
    creation, Step 3), else the derived <worktree_dir>/<slug> fallback."""
    wt = target.get("worktree") or {}
    if wt.get("dir"):
        return wt["dir"]
    base = (config.get("worktree_dir") or "/tmp").rstrip("/")
    return f"{base}/{_worktree_slug(target)}"


def build_start_config(
    config: dict[str, Any], workspace_id: str | None, overrides: dict[str, Any] | None = None
) -> dict[str, Any] | None:
    """Assemble the launch config `build_odoo_cmd` consumes from the stored config, a
    workspace id, and optional `overrides` ({other_args?, test_tags?, install?,
    upgrade?, memcheck?}). This is the one server-side
    builder the thin launch endpoints resolve
    `{workspace, overrides}` to. A worktree-located workspace points its repos +
    server_path at its on-disk copies (so build_odoo_cmd cd's into the worktree's
    community and runs its odoo-bin) and forwards its stable `port` as
    cfg["worktree_port"]. Returns None if the id isn't in the config. The checkout
    branches aren't applied here — they're checked out separately."""
    target = next(
        (w for w in (config.get("workspaces") or []) if w.get("id") == workspace_id), None
    )
    if not target:
        return None
    overrides = overrides or {}
    start_cfg = config.get("start") or {}
    repo_ids = [c["repo"] for c in (target.get("checkouts") or []) if c.get("repo")]
    start = {
        "repos": repo_ids,
        # a workspace created with no explicit database (the field was left
        # blank) still needs a valid one to start against — fall back to the
        # workspace's own name, sanitized the same way its worktree folder name
        # is (_worktree_slug), rather than hard-failing with "no database
        # configured" on every start
        "db": target.get("db") or _worktree_slug(target),
        "on_create_args": target.get("on_create_args") or "",
        "other_args": overrides.get("other_args", start_cfg.get("other_args", "")),
        "demo_data": target.get("demo_data", True),
    }
    for key in ("test_tags", "install", "upgrade", "memcheck"):
        if overrides.get(key):
            start[key] = overrides[key]
    cfg = {**config, "workspace": target["id"], "start": start}
    is_worktree = (
        target.get("location")
        or target.get("kind")
        or ("worktree" if target.get("worktree") else "plain")
    ) == "worktree"
    if is_worktree:
        d = _worktree_dir(config, target)
        github = {
            r["id"]: r.get("github", "")
            for r in config.get("repos", [])
            if isinstance(r, dict) and r.get("id")
        }
        # point repos at the worktree's on-disk copies; build_odoo_cmd derives the
        # main repo's path (and thus the addons-path + odoo-bin) from these
        cfg["repos"] = [
            {"id": rid, "path": f"{d}/{rid}", "github": github.get(rid, "")} for rid in repo_ids
        ]
        main_repo_id = config.get("main_repo_id") or "community"
        cfg["server_path"] = f"{d}/{main_repo_id}/odoo-bin"
        if target.get("port"):
            cfg["worktree_port"] = target["port"]
        # a workspace with its own venv (built from ITS OWN requirements.txt at
        # creation, VenvService) always launches through it, in place of whatever
        # venv_activate the global config carries. venv_python additionally pins
        # the exact interpreter (server.py's _odoo_cmd_base), so odoo-bin runs
        # under it regardless of its own shebang line.
        if (target.get("worktree") or {}).get("venv"):
            cfg["venv_activate"] = f"source {d}/.venv/bin/activate"
            cfg["venv_python"] = f"{d}/.venv/bin/python"
        # launch_mode="docker" (server.py build_docker_cmd) needs the worktree's
        # own root dir (for its single bind mount — repos' host paths above
        # aren't otherwise usable, they're only ever cd'd into) and the main
        # repo's checked-out branch (image resolution — see
        # resolve_docker_image). docker_container is NOT set here: it's a
        # "dev"/"dev1"/"dev2" pooled slot picked live at start time
        # (DockerInfraService.next_container_slot), not a per-workspace value.
        # Harmless to always set docker_worktree_dir/docker_branch: a
        # non-docker launch just ignores these extra cfg keys.
        cfg["docker_worktree_dir"] = d
        main_checkout = next(
            (c for c in target.get("checkouts") or [] if c.get("repo") == main_repo_id), None
        )
        cfg["docker_branch"] = (main_checkout or {}).get("branch", "")
    else:
        # a main-checkout workspace in docker mode bind-mounts the directory holding
        # the repos, which are siblings there (<dir>/<repo_id>, as for a worktree)
        main_repo_id = config.get("main_repo_id") or "community"
        main_repo = next((r for r in config.get("repos", []) if r.get("id") == main_repo_id), None)
        if main_repo and main_repo.get("path"):
            cfg["docker_worktree_dir"] = os.path.dirname(os.path.expanduser(main_repo["path"]))
        main_checkout = next(
            (c for c in target.get("checkouts") or [] if c.get("repo") == main_repo_id), None
        )
        cfg["docker_branch"] = (main_checkout or {}).get("branch", "")
    return cfg
