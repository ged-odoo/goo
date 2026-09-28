"""goo - GED Odoo Overseer: the HTTP server and request handlers.

The implementation of goo; the repo-root `goo.py` is a thin launcher that calls
main() here. The frontend (static/) holds the configuration and posts it with each
start request; the backend is stateless apart from the server-side caches.

Self-contained pieces live in sibling modules and are re-imported here, so
`server.<name>` keeps working: the SSE bus in events.py, the port/process/editor
helpers, the service-free command builders, the WebSocket frame helpers and
`_Entry` in processes.py, the self-update git probes in update.py, and the Claude
chat in claude.py. What reads the module-level singletons below (the route
handlers, WorkspaceManager, the DATABASE-probing command builders, the update
state/loop) stays here.
"""

import argparse
import atexit
import fcntl
import json
import mimetypes
import os
import pty
import queue
import re
import shlex
import signal
import struct
import subprocess
import sys
import termios
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from . import effects, services
from .cache import TTLCache
from .claude import ClaudeManager
from .effects import TAG
from .events import EventBus
from .models import RunSnapshot, ServerSnapshot
from .processes import (
    ADDONS_DIR,
    GOO_DIR,
    HOST,
    RAW_BUF_MAX,
    _docker_run_prefix,
    _Entry,
    _odoo_cmd_base,
    _ws_accept_key,
    _ws_recv_frame,
    _ws_send_frame,
    build_docker_shell_cmd,
    build_shell_cmd,
    free_port,
    kill_port,
    open_in_editor,
    port_busy,
    port_is_free,
    terminate_process,
)
from .update import _git_goo, goo_fast_forward, goo_update_status

PORT = 8068
ODOO_PORT = 8069
READY_MARKER = "odoo.registry: Registry loaded"
STATIC_DIR = os.path.join(GOO_DIR, "static")


def check_goo_update() -> bool:
    """Fetch origin/master, then record how goo's checkout compares and announce it
    when new commits appear. Silent on anything unusual (not a git repo, no origin
    remote, offline) — never nags on failure. Only re-announces when `behind` grows,
    so the hourly re-check (see goo_update_loop) doesn't spam an unchanged state.
    Returns True when the fetch + recompute succeeded (used by the manual check)."""
    global GOO_UPDATE
    inside = _git_goo("rev-parse", "--is-inside-work-tree")
    if not inside or inside.returncode != 0 or inside.stdout.strip() != "true":
        return False
    remotes = _git_goo("remote")
    if not remotes or remotes.returncode != 0 or "origin" not in remotes.stdout.split():
        return False
    fetch = _git_goo("fetch", "origin", "master", timeout=30)
    if not fetch or fetch.returncode != 0:
        return False  # offline / no such branch — stay quiet
    prev_behind = GOO_UPDATE.get("behind", 0)
    GOO_UPDATE = goo_update_status()
    n = GOO_UPDATE["behind"]
    if n != prev_behind:  # state changed → push it so the navbar badge stays in sync
        BUS.publish_goo_update({**GOO_UPDATE, "boot": BOOT_ID})
    if n > prev_behind:  # new commits since we last looked
        msg = f"goo update available — {n} commit{'s' if n != 1 else ''} behind origin/master"
        if GOO_UPDATE["ahead"]:
            m = GOO_UPDATE["ahead"]
            msg += f", {m} local commit{'s' if m != 1 else ''} ahead"
        BUS.publish_event(msg)
    return True


def goo_update_loop() -> None:
    """Check for a goo update at startup and then hourly, so a permanently running
    goo keeps surfacing new commits on origin/master. Skipped (but still ticking,
    so re-enabling needs no restart) when the update check is turned off in the
    config's Miscellaneous section."""
    while True:
        if (CONFIG.get()["config"] or {}).get("update_check", True) is not False:
            check_goo_update()
        time.sleep(3600)


def restart_goo() -> None:
    """Restart goo in place (re-exec) so a just-applied update is loaded. Stops the
    managed odoo processes first — execv keeps the same PID but does NOT run atexit
    handlers, and the new goo starts with a fresh WORKSPACES that wouldn't know
    about leftover children. The listening socket is close-on-exec, so the new
    process rebinds the port. `--open` is dropped so no extra browser tab opens
    (the client reloads its existing tab)."""
    WORKSPACES.shutdown()
    CLAUDE.shutdown()
    args = [a for a in sys.argv[1:] if a != "--open"]
    os.execv(sys.executable, [sys.executable, os.path.join(GOO_DIR, "goo.py"), *args])


class AutoReloader:
    """Fetches master for opted-in repos every INTERVAL seconds, in the background.
    The repo set is read from the server's own config each tick (`repos_getter`, which
    returns the config's `autoreload`-flagged repos) — no frontend push. Each repo's
    first fetch is one interval after it is first seen, so starting goo never triggers
    a fetch storm."""

    INTERVAL = 4 * 3600

    def __init__(self, repos_getter: Callable[[], list[dict[str, Any]]]) -> None:
        self._repos_getter = repos_getter  # () -> [{id, path, github}, …]
        self._next: dict[str, float] = {}  # path -> earliest next fetch time
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self) -> None:
        while True:
            time.sleep(60)
            now = time.time()
            repos = [r for r in self._repos_getter() if r.get("path")]
            due = []
            for r in repos:
                nxt = self._next.setdefault(r["path"], now + self.INTERVAL)
                if now >= nxt:
                    self._next[r["path"]] = now + self.INTERVAL
                    due.append(r)
            for r in due:
                GIT.fetch_master(r)


def _filestore(body: dict[str, Any] | None) -> str | None:
    """The filestore root from a request body, or None when absent/blank. Lets the
    database endpoints keep each db's <filestore>/<db> directory in lockstep."""
    fs = (body or {}).get("filestore")
    return fs if isinstance(fs, str) and fs.strip() else None


def _odoo_bin_invocation(
    config: dict[str, Any], prefix: str, db: str, addons_path: str, dump_dir: str | None = None
) -> tuple[str, bool]:
    """The odoo-bin argument tail — db/addons-path/demo, then whichever of
    test-tags / install-upgrade / plain-server mode `start` selects — appended
    onto `prefix` (the invocation up to and including the odoo-bin path itself:
    a local `cd ... && odoo-bin` chain today, or a `docker run ... image
    python3 .../odoo-bin` container invocation for Docker launch mode). Shared
    between build_odoo_cmd and its Docker-mode counterpart — the arguments
    odoo-bin itself receives are identical either way; only `prefix` differs.
    `dump_dir` is the memcheck dump directory build_odoo_cmd already resolved
    (also threaded into `prefix`'s MEMCHECK_DUMP_DIR env var), reused here for
    the post-run memlab analysis paths.
    Returns (cmd, is_new_db)."""
    start = config.get("start") or {}
    memcheck = bool(start.get("memcheck") and start.get("test_tags"))
    db_user = config.get("db_user", "odoo")
    db_password = config.get("db_password", "odoo")
    without_demo = "false" if start.get("demo_data", True) else "all"
    cmd = prefix + (
        f" -r {db_user} -w {db_password} -d {db} "
        f"--database {db} --no-database-list --without-demo {without_demo} "
        f"--addons-path {addons_path}"
    )
    if config.get("log_level"):
        cmd += f" --log-level {shlex.quote(config['log_level'])}"

    # test mode: run the given --test-tags and exit, skipping the server-only
    # extras (other_args / on_create_args), mirroring the old odev behaviour
    test_tags = start.get("test_tags")
    if test_tags:
        if memcheck and DATABASE.installed_modules(db).get("memleak_check") != "installed":
            # memleak_check isn't installed yet: install it via a SEPARATE,
            # prior odoo-bin invocation rather than bundling -i into this
            # run's own --test-tags call. Odoo only scans to-install/to-upgrade
            # modules for post_install tests the moment ANY -i/-u is active
            # this run (loader.make_suite via registry.updated_modules) — if
            # -i memleak_check were part of THIS invocation, this run's own
            # target module (whatever --test-tags selects) would be silently
            # excluded from that scan, since it's normally not itself being
            # installed/upgraded (see the regression this replaced: a memcheck
            # run on an already-installed target module executed 0 tests).
            # Once installed, memleak_check stays part of every future boot's
            # module graph on its own — no repeat install/upgrade needed.
            cmd = f"{cmd} -i memleak_check --stop-after-init && {cmd}"
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
        is_new = not DATABASE.db_initialized(db)
        on_create_args = start.get("on_create_args", "")
        if is_new and on_create_args:
            cmd += f" {on_create_args}"
        if memcheck:
            # build_odoo_cmd always resolves a dump dir for a memcheck run (and
            # build_docker_cmd refuses memcheck outright)
            assert dump_dir is not None
            # chained as one more shell command rather than a second
            # subprocess: the whole cmd already runs via shell=True, so
            # memlab's offline analysis of the 3 snapshots odoo-bin just wrote
            # runs right after, streamed into the same log the Tests tab
            # already shows
            cmd += (
                f" && npx --yes memlab@latest find-leaks"
                f" --baseline {shlex.quote(os.path.join(dump_dir, 'baseline.heapsnapshot'))}"
                f" --target {shlex.quote(os.path.join(dump_dir, 'target.heapsnapshot'))}"
                f" --final {shlex.quote(os.path.join(dump_dir, 'final.heapsnapshot'))}"
                f" --work-dir {shlex.quote(dump_dir)}"
            )
        return cmd, is_new

    # install / upgrade modules and exit
    install, upgrade = start.get("install"), start.get("upgrade")
    if install or upgrade:
        if install:
            cmd += f" -i {install}"
        if upgrade:
            cmd += f" -u {upgrade}"
        cmd += " --stop-after-init"
        return cmd, False

    other_args = start.get("other_args", "")
    if other_args:
        cmd += f" {other_args}"

    is_new = not DATABASE.db_initialized(db)
    on_create_args = start.get("on_create_args", "")
    if is_new and on_create_args:
        cmd += f" {on_create_args}"
    return cmd, is_new


def build_odoo_cmd(config: dict[str, Any]) -> tuple[str, str, bool]:
    """Build the odoo-bin shell command from a client config.

    Returns (cmd, db, is_new_db). Raises ValueError on invalid config.
    """
    start = config.get("start") or {}
    db = start.get("db")
    if not db:
        raise ValueError("no database configured (start.db)")

    # memory-perf check: goo's Tests tab "Memory check" checkbox is a plain
    # option on the classic --test-tags run below, not a separate mode — it
    # needs MEMCHECK_DUMP_DIR set on the odoo-bin invocation itself, so this
    # is resolved before _odoo_cmd_base runs rather than as a plain cmd += after
    memcheck = bool(start.get("memcheck") and start.get("test_tags"))
    extra_env = None
    dump_dir = None
    if memcheck:
        community_path = next(
            (
                os.path.expanduser(r["path"])
                for r in config.get("repos", [])
                if isinstance(r, dict) and r.get("id") == "community" and r.get("path")
            ),
            None,
        )
        if not community_path:
            raise ValueError("no 'community' repo defined in repos")
        worktree_parent = os.path.dirname(community_path)
        stamp = time.strftime("%Y%m%d_%H%M%S")
        # same location convention as the odoo-memory-perf skill's
        # run_check.sh, so a UI-triggered run and a Claude-triggered one land
        # in the same place
        dump_dir = os.path.join(
            worktree_parent,
            ".claude",
            "skills",
            "odoo-memory-perf",
            "dumps",
            f"memcheck_{stamp}",
        )
        extra_env = {"MEMCHECK_DUMP_DIR": dump_dir}

    prefix, addons_path = _odoo_cmd_base(config, start.get("repos", []), extra_env=extra_env)
    cmd, is_new = _odoo_bin_invocation(config, prefix, db, addons_path, dump_dir)
    return cmd, db, is_new


def build_docker_cmd(config: dict[str, Any], image: str) -> tuple[str, str, bool]:
    """Build the `docker run` shell command from a client config + the already-
    resolved image tag (WorkspaceManager.start resolves/builds it via
    DockerInfraService.ensure_image before calling this — pulling/building an
    image can take minutes and must never happen under WorkspaceManager's
    lock). Shares odoo-bin's own argument tail with build_odoo_cmd via
    _odoo_bin_invocation — only the invocation prefix differs (a `docker run`
    container instead of a local `cd ... && odoo-bin` subprocess).

    Returns (cmd, db, is_new_db). Raises ValueError on invalid config.
    """
    start = config.get("start") or {}
    db = start.get("db")
    if not db:
        raise ValueError("no database configured (start.db)")
    if start.get("memcheck"):
        # MEMCHECK_DUMP_DIR/the memlab post-analysis both read/write a HOST
        # path today (see build_odoo_cmd) — not yet wired to a matching
        # in-container mount, so fail clearly instead of writing nowhere
        raise ValueError("memory-perf checks aren't supported in Docker launch mode yet")
    container = config.get("docker_container")
    if not container:
        raise ValueError("no container name resolved for this Docker workspace")

    run, mount_path, main_repo_id, addons_path = _docker_run_prefix(config, container)
    pg_container = config.get("docker_postgres_container") or "goo-postgres"
    user_flag = (
        f"--user {shlex.quote(config['docker_container_user'])} "
        if config.get("docker_container_user")
        else ""
    )
    extra_args = config.get("docker_extra_run_args") or ""
    if extra_args:
        extra_args += " "

    if config.get("docker_headed_browser"):
        # --shm-size: Chrome's default /dev/shm (64MB) is too small and crashes
        # under real page load, headed or not. --privileged: the image's own
        # iptables install (network-restriction during tests) needs it to
        # actually do anything. Both apply whenever this is on, regardless of
        # DISPLAY — a headless-over-SSH Chrome test still benefits from them.
        run += "--privileged --shm-size=1g "
        # DISPLAY + the X11 socket is what actually makes a headed Chrome
        # (watch=True, a debugged tour) render on THIS desktop instead of
        # nowhere — skipped outright with no DISPLAY to forward (this session
        # has no X server, so there's nothing meaningful to mount in).
        display = os.environ.get("DISPLAY")
        if display:
            run += f"-e DISPLAY={shlex.quote(display)} -v /tmp/.X11-unix:/tmp/.X11-unix:rw "
    # odoo-bin needs an EXPLICIT --db_host/--db_port here, unlike build_odoo_cmd's
    # local invocation, which gets away with none at all: a local subprocess
    # inherits goo's own process env (PGHOST/PGPORT, seeded once at startup — see
    # main()), but `docker run` does NOT propagate the host's environment into the
    # container, so psycopg2 would otherwise fall back to a local unix socket that
    # doesn't exist in there. Always port 5432 — that's postgres's fixed
    # in-container port; docker_postgres_port is only the host-published one,
    # irrelevant for container-to-container traffic on the shared network.
    # --http-interface 0.0.0.0: odoo-bin's default HTTP bind is loopback-only,
    # invisible to nginx reaching in from its own container over the bridge
    # network (unlike local mode, where the browser's "localhost" IS that same
    # loopback). oe.fish needs this exact flag for the same reason (its own
    # comment: "no idea why, but necessary since" a specific odoo-bin change) —
    # confirmed live: nginx's DNS resolution to the container succeeds, but the
    # TCP connect is refused without this.
    # --db-filter: goo-postgres hosts every docker-mode workspace's database
    # together (same as a shared local Postgres would) — --no-database-list
    # below only hides the picker, --db-filter actually scopes this instance to
    # its own db. --limit-time-cpu/--limit-time-real: disabled outright, so a
    # request paused at a breakpoint doesn't get killed by Odoo's own worker
    # watchdog mid-debug — always-safe for a dev server, never wanted in prod.
    run += (
        f"{user_flag}{extra_args}{shlex.quote(image)} python3 {mount_path}/{main_repo_id}/odoo-bin "
        f"--db_host {shlex.quote(pg_container)} --db_port 5432 --http-interface 0.0.0.0 "
        f"--db-filter {shlex.quote('^' + db + '$')} "
        f"--limit-time-cpu 9999999999 --limit-time-real 9999999999"
    )

    cmd, is_new = _odoo_bin_invocation(config, run, db, addons_path, None)
    return cmd, db, is_new


def warn_if_rust_bundler_missing(
    config: dict[str, Any] | None, bus: EventBus, context: str = ""
) -> threading.Thread | None:
    """goo auto-installs the rust_bundler addon in every database it launches, but
    the speedup only happens when the rust_bundler config key is on AND Goo's
    native Rust extension is current in the instance's venv — otherwise
    the addon falls back to the slow Python bundler and its only warning lands in
    the odoo log, easy to miss. When the feature is on, probe the venv in the
    background and explain in the goo log when the extension is missing. Returns
    the probe thread (callers may ignore it; tests join it), or None when off."""
    if not (config or {}).get("rust_bundler"):
        return None  # feature off — the addon won't engage, nothing to warn about

    def check() -> None:
        status = RUST_BUNDLER.status(config)
        if not status.get("current"):
            where = f" ({context})" if context else ""
            detail = "not installed"
            if status.get("installed"):
                detail = (
                    f"version {status.get('version')} is stale "
                    f"(expected {status.get('expected_version')})"
                )
            bus.publish_log(
                f"{TAG} rust_bundler{where}: Goo's native extension is {detail}; "
                "JS asset bundling stays on the Python path. Use Configuration > "
                "Build / update Rust bundler, then restart Odoo."
            )

    thread = threading.Thread(target=check, daemon=True)
    thread.start()
    return thread


# =============================================================================
# Workspace process manager
# =============================================================================


class WorkspaceManager:
    """Owns every workspace's odoo server — the permanent "main" entry (the primary
    checkout's server, on odoo's default port) plus one entry per worktree
    workspace, each on its own stable port, all running concurrently. Each entry
    carries a PTY terminal channel, readiness detection, a one-shot run slot with
    backend-owned resume-after, and per-server log routing on the single 'log'
    {server, line} SSE stream (main lines also feed the shared backlog ring; other
    servers keep a bounded per-entry tail).

    Locking: `self.lock` guards the entries dict and every entry's lifecycle
    fields; each entry's `raw_lock` guards only its raw_buf/ws_clients (terminal
    fan-out never contends with lifecycle ops). Lock order: lock -> raw_lock,
    never the reverse. build_odoo_cmd (psql probe) and status()'s odoo_info are
    never called under `self.lock`.
    """

    def __init__(self, bus: EventBus) -> None:
        self.bus = bus
        self.lock = threading.Lock()
        # wsid -> _Entry; entries never removed
        self.entries: dict[str, _Entry] = {"main": _Entry("main")}
        self._run_seq = 0  # manager-level so run ids stay unique across workspaces

    # ── snapshots ────────────────────────────────────────────────────────────────

    def status(self) -> dict[str, Any]:
        """The enriched "main" snapshot (GET /api/status + SSE priming)."""
        with self.lock:
            e = self.entries["main"]
            active = e.state in ("starting", "running")
            snap = ServerSnapshot(
                id="main",
                state=e.state,
                terminal=True,  # the main server owns the default PTY/xterm channel
                pid=e.process.pid if (active and e.process) else None,
                db=e.db if active else None,
                workspace=e.workspace if active else None,
                cmd=e.cmd if active else None,
                mode=e.mode if active else None,
                started_at=e.started_at if active else None,
                exited_unexpectedly=e.exited_unexpectedly,
                returncode=e.returncode if e.exited_unexpectedly else None,
            )
        # asdict → every field present (odoo_version/enterprise/exists = None here),
        # so the client's spread-merge behaves as a full replace for "main"
        status = asdict(snap)
        status["odoo_port_busy"] = port_busy(ODOO_PORT)
        if status["db"]:
            version, enterprise, _demo_data, _ = DATABASE.odoo_info(status["db"])
            status["odoo_version"] = version
            status["enterprise"] = enterprise
        return status

    def _public(self, entry: _Entry) -> dict[str, Any]:
        """The SSE/JSON-safe view of a non-main entry. `exists` is dropped here:
        it's a client-facing on-disk fact added only by status_for on bootstrap, so
        the live SSE stream carries just state/port and the client's spread-merge
        preserves the bootstrapped `exists` rather than clobbering it with null.
        terminal=True: every entry has carried its own PTY channel since the
        manager unification (the synthesized never-started snapshot in status_for
        keeps False — no entry, no PTY yet)."""
        snap = asdict(
            ServerSnapshot(
                id=entry.id,
                state=entry.state,
                terminal=True,
                workspace=entry.id,
                db=entry.db,
                port=entry.port,
                docker_container=entry.docker_container,
            )
        )
        del snap["exists"]
        return snap

    def _echo(self, entry: _Entry, line: str) -> None:
        """An orchestration message (port fallback, stopping, errors) on a non-main
        server's own log stream, recorded in its scrollback deque like process
        output so /api/workspace/logs replays it."""
        entry.log.append(line)
        self.bus.publish_log(line, server=entry.id)

    def _snapshot(self, wsid: str, public: dict[str, Any] | None) -> dict[str, Any] | None:
        """The wire snapshot for a publish: main's enriched status() (must run
        outside self.lock — psql), else the `public` view computed under it."""
        return self.status() if wsid == "main" else public

    def public_snapshots(self) -> list[dict[str, Any]]:
        """One wire snapshot per known entry, main first — for SSE priming."""
        with self.lock:
            others = [self._public(e) for w, e in self.entries.items() if w != "main"]
        return [self.status()] + others

    def run_snapshots(self) -> list[dict[str, Any]]:
        """Every workspace's current/last run — primed on SSE connect."""
        with self.lock:
            return [dict(e.run) for e in self.entries.values() if e.run]

    def server_config(self, wsid: str) -> dict[str, Any] | None:
        """The config of a workspace's last plain-server start, for resume-after."""
        with self.lock:
            e = self.entries.get(wsid)
            return e.server_config if e else None

    def entry_for_terminal(self, wsid: str) -> _Entry | None:
        """The entry whose PTY a terminal WebSocket attaches to, or None."""
        with self.lock:
            return self.entries.get(wsid)

    # ── lifecycle ────────────────────────────────────────────────────────────────

    def _db_conflict(self, wsid: str, db: str) -> str | None:
        """The refusal message when `db` is held by another active workspace, else
        None (two odoo processes on one db corrupt it). Called under self.lock."""
        for other, e in self.entries.items():
            if other == wsid or e.state not in ("starting", "running"):
                continue
            if e.db != db:
                continue
            if other == "main":
                return f"database '{db}' is in use by the main server"
            if wsid == "main":
                return f"database '{db}' is in use by the '{other}' workspace server"
            return f"database '{db}' is in use by another workspace's server"
        return None

    def start(
        self, wsid: str, config: dict[str, Any], resume_config: dict[str, Any] | None = None
    ) -> tuple[bool, Any]:
        """Launch a workspace's odoo process. A one-shot (test/install/upgrade) is
        minted as a first-class Run occupying the slot; `resume_config` (set by
        oneshot() when a running server was interrupted) is the server config to
        restart when the run ends. "main" runs on odoo's default ports; other
        workspaces on their stable cfg["worktree_port"] when set and free, else an
        OS-assigned one. Returns (ok, detail): detail is {"cmd", "port"} on
        success, else an error code."""
        if not wsid:
            return False, "missing workspace"
        main = wsid == "main"
        is_docker = not main and config.get("launch_mode") == "docker"
        # build the command before taking the lock — it runs a psql probe
        # (db_initialized) that must never stall the other workspaces; the
        # docker-mode ensure_*/image build/pull below can take minutes, for the
        # exact same reason
        if is_docker:
            net_ok, net_err = DOCKER_INFRA.ensure_network(
                config.get("docker_network") or "goo_odoo"
            )
            if not net_ok:
                return False, f"docker network: {net_err}"
            pg_ok, pg_err = DOCKER_INFRA.ensure_postgres(config)
            if not pg_ok:
                return False, f"docker postgres: {pg_err}"
            nginx_ok, nginx_err = DOCKER_INFRA.ensure_nginx(config)
            if not nginx_ok:
                return False, f"docker nginx: {nginx_err}"
            image, img_err = DOCKER_INFRA.ensure_image(config, config.get("docker_branch") or "")
            if img_err:
                return False, f"docker image: {img_err}"
            assert image is not None  # ensure_image returns (tag, None) or (None, error)
            # a "dev"/"dev1"/"dev2" pooled slot, picked fresh every start (not
            # a fixed name per workspace) — see next_container_slot
            container = DOCKER_INFRA.next_container_slot()
            if not container:
                return False, "docker: no free dev slot found"
            config = {**config, "docker_container": container}
            try:
                cmd, db, is_new = build_docker_cmd(config, image)
            except ValueError as e:
                return False, f"invalid_config: {e}"
        else:
            try:
                cmd, db, is_new = build_odoo_cmd(config)
            except ValueError as e:
                return False, f"invalid_config: {e}"
        with self.lock:
            entry = self.entries.get(wsid)
            if entry is None:
                entry = self.entries[wsid] = _Entry(wsid)
            if entry.state != "stopped":
                return False, "already_running"
            conflict = self._db_conflict(wsid, db)
            if conflict:
                return False, conflict

            entry.exited_unexpectedly = False
            entry.returncode = None
            entry.db = db
            entry.workspace = config.get("workspace")
            s = config.get("start") or {}
            entry.mode = (
                "test"
                if s.get("test_tags")
                else "install"
                if s.get("install")
                else "upgrade"
                if s.get("upgrade")
                else "server"
            )
            entry.started_at = time.time()
            if main or is_docker:
                # docker mode has no OS port to allocate either — the container
                # binds its own default 8069/8072 inside the network namespace,
                # reached only through nginx (docker_container.localhost)
                entry.port = None
                entry.gport = None
                entry.docker_container = config.get("docker_container") if is_docker else None
                full_cmd = cmd
            else:
                wanted = config.get("worktree_port")
                if wanted and port_is_free(wanted):
                    port = wanted
                else:
                    if wanted:
                        self._echo(
                            entry,
                            f"{TAG} port {wanted} is busy — falling back to a free port",
                        )
                    port = free_port()
                entry.port = port
                entry.gport = free_port()
                entry.docker_container = None
                full_cmd = f"{cmd} --http-port {port} --gevent-port {entry.gport}"
            entry.cmd = full_cmd
            # a plain server clears any active run and is remembered so a later run can
            # resume it; a one-shot run is minted as a Run and records its resume config
            if entry.mode == "server":
                entry.run = None
                entry.server_config = config
                entry.resume_config = None
            else:
                self._run_seq += 1
                spec = (
                    {"tags": s.get("test_tags")}
                    if entry.mode == "test"
                    else {"module": s.get("install") or s.get("upgrade")}
                )
                entry.run = asdict(
                    RunSnapshot(
                        id=f"run-{self._run_seq}",
                        kind=entry.mode,
                        state="running",
                        server=wsid,
                        workspace=entry.workspace,
                        db=db,
                        spec=spec,
                        resume=bool(resume_config),
                        started_at=entry.started_at,
                    )
                )
                entry.resume_config = resume_config
            if main:
                if is_new:
                    self.bus.publish_log(
                        f"{TAG} database '{db}' not initialized, applying on_create_args"
                    )
                self.bus.publish_log(f"{TAG} starting odoo: {full_cmd}")
                warn_if_rust_bundler_missing(config, self.bus)
            else:
                # the workspace's own stream — its log pane shows the exact launch cmd
                self.bus.publish_log(f"{TAG} starting odoo: {full_cmd}", server=wsid)
                warn_if_rust_bundler_missing(config, self.bus, context=f"workspace {wsid}")

            entry.log.clear()
            with entry.raw_lock:
                entry.raw_buf.clear()

            effects.trace("run", full_cmd)
            master_fd, slave_fd = pty.openpty()
            entry.process = subprocess.Popen(
                full_cmd,
                shell=True,
                executable="/bin/bash",
                stdout=slave_fd,
                stderr=slave_fd,
                stdin=slave_fd,
                preexec_fn=os.setsid,
            )
            os.close(slave_fd)
            entry.master_fd = master_fd
            entry.state = "starting"
            entry.reader_thread = threading.Thread(
                target=self._reader,
                args=(wsid, master_fd, entry.process),
                daemon=True,
            )
            entry.reader_thread.start()
            run = entry.run
            port_out = entry.port
            public = None if main else self._public(entry)
        self.bus.publish_server(self._snapshot(wsid, public))
        if run:
            self.bus.publish_run(dict(run))  # a fresh one-shot run went "running"
        return True, {"cmd": full_cmd, "port": port_out}

    def stop(self, wsid: str) -> tuple[bool, str]:
        """Stop a workspace's server. Idempotent; frees its port (for "main", only
        as a fallback when something still holds the default odoo port — orphans,
        external servers)."""
        main = wsid == "main"
        with self.lock:
            entry = self.entries.get(wsid)
            if not entry:
                return True, "stopped"  # unknown workspace — nothing to do
            if entry.state == "stopping":
                # someone else is finishing the job; main keeps its historical
                # refusal (the UI disables Stop on it), workspaces stay idempotent
                return (False, "already_stopping") if main else (True, "stopped")
            was_active = entry.state in ("starting", "running")
            process = entry.process
            reader = entry.reader_thread
            port = entry.port
            docker_container = entry.docker_container
            if was_active:
                entry.state = "stopping"

        if was_active:
            if main:
                self.bus.publish_server(self.status())
                self.bus.publish_log(f"{TAG} stopping odoo...")
            else:
                self._echo(entry, f"{TAG} stopping odoo...")
            # never let an exception leave us stuck in "stopping" (the guard
            # above would then refuse every future stop until goo restarts)
            try:
                terminate_process(process)
            except Exception as e:
                if main:
                    self.bus.publish_log(f"{TAG} error while stopping: {e}")
                else:
                    self._echo(entry, f"{TAG} error while stopping: {e}")
            # terminate_process already SIGKILLed odoo's whole process group, so the
            # port is normally free now — the lsof kill is the orphan fallback ("main"
            # only when something still listens; workspaces always, as before)
            if main:
                if port_busy(ODOO_PORT):
                    kill_port(ODOO_PORT)
            elif docker_container:
                # terminate_process signaled the local `docker run` client —
                # Docker's --sig-proxy default forwards a graceful SIGTERM into
                # the container, but a killed/hung client doesn't reliably stop
                # the REMOTE container (it isn't a child process of it). `docker
                # stop` is the authoritative signal, and — since the container
                # was started with --rm — also removes it on success.
                try:
                    effects.run(
                        ["docker", "stop", "-t", "10", docker_container], quiet=True, timeout=20
                    )
                except (FileNotFoundError, subprocess.TimeoutExpired):
                    pass
            elif port:
                kill_port(port)
            if reader:
                reader.join(timeout=2)
            with self.lock:
                entry.state = "stopped"
                entry.process = None
                entry.master_fd = None
                if main:
                    entry.db = None
                    entry.workspace = None
                    entry.cmd = None
                    entry.started_at = None
                public = None if main else self._public(entry)
            if main:
                self.bus.publish_log(f"{TAG} odoo stopped")
        else:
            if main and port_busy(ODOO_PORT):
                kill_port(ODOO_PORT)
                self.bus.publish_log(f"{TAG} killed process on port {ODOO_PORT}")
            elif not main and port:
                kill_port(port)
            with self.lock:
                public = None if main else self._public(entry)

        self.bus.publish_server(self._snapshot(wsid, public))
        return True, "stopped"

    def restart(self, wsid: str, config: dict[str, Any]) -> tuple[bool, Any]:
        ok, detail = self.stop(wsid)
        if not ok:
            return ok, detail
        return self.start(wsid, config)

    def oneshot(self, wsid: str, config: dict[str, Any]) -> tuple[bool, Any]:
        """Run a one-shot (tests/install/upgrade) on a workspace's slot: interrupt
        its plain server if one is running (remembering its config so the run's end
        restarts it — resume-after, owned server-side), then start the one-shot."""
        with self.lock:
            entry = self.entries.get(wsid)
            active = entry and entry.state in ("starting", "running")
            resume = entry.server_config if (entry and active and entry.mode == "server") else None
        self.stop(wsid)
        return self.start(wsid, config, resume_config=resume)

    def stop_and_finalize(self, wsid: str) -> tuple[bool, str]:
        """Stop a workspace's server; if that manually killed an active one-shot
        run, finalize it (returncode None → failed) and resume the server it had
        interrupted — the mirror of the reader thread's natural-finish path (which
        bails out on manual stops because stop() owns the exit)."""
        ok, detail = self.stop(wsid)
        if ok:
            resume = self.finish_run(wsid, None)
            if resume:
                self.start(wsid, resume)
        return ok, detail

    def finish_run(self, wsid: str, returncode: int | None) -> dict[str, Any] | None:
        """Finalize a workspace's active run (if any) and return the server config
        to resume, or None. `returncode` is the process exit code, or None when the
        run was stopped manually. Publishes the finished run. The caller holds no
        lock and, if a config is returned, restarts the server via start()."""
        with self.lock:
            entry = self.entries.get(wsid)
            run = entry.run if entry else None
            if entry is None or not run or run.get("state") != "running":
                return None
            if returncode is None:  # manually stopped mid-run
                run["state"] = "failed"
                run["ok"] = False
            else:
                run["state"] = "failed" if returncode else "done"
                run["ok"] = returncode == 0
            run["returncode"] = returncode
            snapshot = dict(run)
            resume = entry.resume_config
            entry.resume_config = None
        self.bus.publish_run(snapshot)
        return resume

    def shutdown(self) -> None:
        """Cleanup on goo exit/restart: stop every server we started, but never
        touch an external odoo we didn't start."""
        with self.lock:
            active = [w for w, e in self.entries.items() if e.state in ("starting", "running")]
        for w in active:
            self.stop(w)

    # ── output plumbing ──────────────────────────────────────────────────────────

    def _emit_raw(self, entry: _Entry, data: bytes) -> None:
        """Append raw PTY bytes to the entry's ring buffer and fan out to its
        terminal WS clients."""
        with entry.raw_lock:
            entry.raw_buf += data
            if len(entry.raw_buf) > RAW_BUF_MAX:
                entry.raw_buf = entry.raw_buf[-RAW_BUF_MAX:]
            clients = list(entry.ws_clients)
        for q in clients:
            q.put(data)

    def _reader(self, wsid: str, fd: int, process: subprocess.Popen[bytes]) -> None:
        """Read a workspace's PTY, fan lines out, detect readiness and unexpected
        exit. One thread per running entry."""
        entry = self.entries[wsid]
        buf = b""
        while True:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            self._emit_raw(entry, data)
            buf += data
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                self._handle_line(wsid, process, raw.decode("utf-8", errors="replace").rstrip("\r"))
        if buf:
            self._handle_line(wsid, process, buf.decode("utf-8", errors="replace").rstrip("\r"))
        try:
            os.close(fd)
        except OSError:
            pass

        ret = process.wait()
        main = wsid == "main"
        with self.lock:
            # stop() owns intentional exits; a stale reader (post-restart)
            # must not touch the new process state
            if entry.state == "stopping" or entry.process is not process:
                return
            entry.state = "stopped"
            entry.process = None
            entry.master_fd = None
            if main:
                entry.db = None
                entry.workspace = None
                entry.cmd = None
                entry.started_at = None
            entry.exited_unexpectedly = True
            entry.returncode = ret
            public = None if main else self._public(entry)
        if main:
            self.bus.publish_log(f"{TAG} odoo exited unexpectedly (code {ret})")
        else:
            self.bus.publish_event(
                f"workspace server ({wsid}) exited unexpectedly (code {ret})", level="error"
            )
        self.bus.publish_server(self._snapshot(wsid, public))
        # a one-shot run just ended on its own: finalize it and, if it had interrupted
        # a server, bring that server back (resume-after, owned here so it survives a
        # mid-run reload). start() runs a fresh process + reader thread.
        resume = self.finish_run(wsid, ret)
        if resume:
            self.start(wsid, resume)

    def _handle_line(self, wsid: str, process: subprocess.Popen[bytes], line: str) -> None:
        """Route one output line to its server's log stream (SSE 'log'
        {server, line}; main's lines also feed the shared backlog ring) and flip
        starting→running on the ready marker. A stale process's lines are dropped."""
        entry = self.entries.get(wsid)
        main = wsid == "main"
        with self.lock:
            if not entry or entry.process is not process:
                return
            entry.log.append(line)
            ready = READY_MARKER in line and entry.state == "starting"
            if ready:
                entry.state = "running"
            public = None if main else self._public(entry)
        self.bus.publish_log(line, server=wsid)
        if ready:
            self.bus.publish_server(self._snapshot(wsid, public))

    # ── bootstrap reads ──────────────────────────────────────────────────────────

    def logs_for(self, wsid: str) -> list[str]:
        """The buffered log tail (list of lines) for one workspace server, or []."""
        with self.lock:
            entry = self.entries.get(wsid)
            return list(entry.log) if entry else []

    def status_for(self, workspaces: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
        """workspaces: [{"id", "dirPath"}]. Returns {id: ServerSnapshot-dict}, merging
        each workspace's on-disk worktree existence with its live server state (or
        a stopped snapshot when no server has run yet)."""
        with self.lock:
            servers = {w: self._public(e) for w, e in self.entries.items() if w != "main"}
        out = {}
        for t in workspaces:
            tid = t.get("id")
            if not tid:
                continue
            snap = servers.get(tid) or asdict(
                ServerSnapshot(id=tid, state="stopped", terminal=False, workspace=tid)
            )
            snap["exists"] = effects.is_dir(t.get("dirPath", ""))
            out[tid] = snap
        return out


BUS = EventBus()
WORKSPACES = WorkspaceManager(BUS)
# services layer over the IO seam (effects): external state fetched + parsed +
# cached server-side. TTLs: PRs 10 min, runbot/mergebot 5 min, databases 1 min.
# A `refresh` flag on the read endpoints bypasses the cache (the UI's manual Refresh).
GITHUB = services.GitHubService(effects, TTLCache(600))
RUNBOT = services.RunbotService(effects, TTLCache(300))
MERGEBOT = services.MergebotService(effects, TTLCache(8 * 3600))  # 8h TTL (states change slowly)
DATABASE = services.DatabaseService(effects, TTLCache(60))
# git on the user's repos — uncached (branch reads are volatile + fast); notify
# routes the fetch/rebase progress phases to the browser event log
GIT = services.GitService(effects, notify=BUS.publish_event)
# builds a worktree workspace's dedicated venv from its own requirements.txt
VENV = services.VenvService(effects, notify=BUS.publish_event)
ADDONS = services.AddonsService(effects)
ASSETS = services.AssetsService(effects, TTLCache(30))
RUST_BUNDLER = services.RustBundlerService(
    effects,
    os.path.join(ADDONS_DIR, "rust_bundler", "native"),
    notify=BUS.publish_event,
)
# 24h is just a safety net for the versions/night-index keys (refresh=True bypasses
# them); per-build detail keys are never invalidated — see NightlyService's docstring.
NIGHTLY = services.NightlyService(effects, TTLCache(24 * 3600))
MEMORY = services.MemoryService(effects)


def _default_config_path() -> str:
    """goo's server-owned config file, outside the checkout (so the --ff-only
    self-updater never touches it). Honors XDG_CONFIG_HOME. Overridable with
    `goo --config <path>` (resolved in main())."""
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "goo", "config.json")


# the server-owned config: {rev, config, state}. The frontend owns the schema and
# mirrors this file; the CLI / auto-reloader / update-check read it directly. `.path`
# may be reassigned in main() from --config before any request/loop reads it.
CONFIG_PATH = _default_config_path()
CONFIG = services.ConfigStore(effects, CONFIG_PATH, notify=BUS.publish_config)

# CI dashboard: per-day mergebot merge stats. Its immutable-completed-day cache
# lives next to config.json (outside GOO_DIR, so the self-updater never touches it).
CI = services.CiService(effects, os.path.join(os.path.dirname(CONFIG_PATH), "ci_merge_stats.json"))

# launch_mode="docker" global services (network/Postgres/nginx) + per-image
# resolution. The generated nginx.conf lives next to config.json too, same
# reasoning as CI's cache path above.
DOCKER_INFRA = services.DockerInfraService(
    effects, os.path.join(os.path.dirname(CONFIG_PATH), "docker", "nginx.conf")
)

# The user-editable Claude review prompt template: a real .md file (not a config.json
# field) so it's comfortable to edit as prose. Lives next to config.json, same
# reasoning as CI/DOCKER_INFRA above.
REVIEW_PROMPT_PATH = os.path.join(os.path.dirname(CONFIG_PATH), "review_prompt.md")

# Persisted Claude review results: one directory of numbered markdown versions per
# workspace (<id>/1.md, 2.md, …), so every past review survives a goo restart
# (ClaudeManager's transcript below is in-memory only) and a re-review never loses
# the one before it. Lives next to config.json, same reasoning as REVIEW_PROMPT_PATH
# above.
REVIEWS_DIR = os.path.join(os.path.dirname(CONFIG_PATH), "reviews")
CLAUDE = ClaudeManager(BUS, REVIEWS_DIR)


DEFAULT_REVIEW_PROMPT = (
    "Review the changes on branch {{branch}} (repos: {{repos}}).\n\n"
    "Focus on correctness bugs, edge cases, and anything inconsistent with the rest "
    "of the codebase. Call out risky assumptions and missing test coverage. Suggest "
    "a simpler alternative only where it genuinely improves the change — skip pure "
    "style nitpicks. Order findings most- to least-important, and say plainly when "
    "you're not confident rather than guessing.\n"
)


def _review_prompt_text() -> str:
    """The template's current text, bootstrapping the shipped default to disk on
    first access."""
    text = effects.read_text(REVIEW_PROMPT_PATH)
    if text is None:
        effects.write_text(REVIEW_PROMPT_PATH, DEFAULT_REVIEW_PROMPT)
        return DEFAULT_REVIEW_PROMPT
    return text


def _autoreload_repos() -> list[dict[str, Any]]:
    """The config's repos opted into the 4h background `git fetch master`."""
    cfg = CONFIG.get()["config"] or {}
    return [
        {"id": r.get("id"), "path": r.get("path"), "pull_remote": r.get("pull_remote")}
        for r in (cfg.get("repos") or [])
        if r.get("autoreload") and r.get("path")
    ]


AUTORELOAD = AutoReloader(_autoreload_repos)
# how goo's own checkout compares to origin/master (filled by check_goo_update at
# startup; the navbar reads it via GET /api/goo/update)
GOO_UPDATE: dict[str, Any] = {
    "checked": False,
    "is_repo": False,
    "branch": "",
    "behind": 0,
    "ahead": 0,
    "dirty": False,
    "can_fast_forward": False,
}
# per-process boot id (changes on every (re-)exec) so the client can tell a
# restarted goo apart from the still-shutting-down old one when it polls
BOOT_ID = time.time()


# =============================================================================
# POST routes
# =============================================================================
# Each route is a plain function fn(body) -> payload dict (sent as 200) or a
# (status, payload) tuple. The shared read-json / validate-required / send-json
# envelope lives once in Handler.do_POST; routes that need the raw request
# (config save, the CLI test relay) stay Handler methods.

# a route's reply: a payload dict (sent as 200) or a (status, payload) tuple
RouteResult = dict[str, Any] | tuple[int, dict[str, Any]]
RouteFn = Callable[[dict[str, Any]], RouteResult]
POST_ROUTES: dict[str, tuple[RouteFn, tuple[str, ...], str]] = {}


def _field_ok(body: dict[str, Any], spec: str) -> bool:
    """One `required` entry: "name" = truthy, "name:str" = non-empty string,
    "name:strip" = a string with non-blank content, "name:list" = a list,
    "name:list+" = a non-empty list."""
    name, _, kind = spec.partition(":")
    v = body.get(name)
    if kind == "list":
        return isinstance(v, list)
    if kind == "list+":
        return isinstance(v, list) and bool(v)
    if kind == "str":
        return isinstance(v, str) and bool(v)
    if kind == "strip":
        return isinstance(v, str) and bool(v.strip())
    return bool(v)


def post_route(path: str, *required: str, missing: str = "") -> Callable[[RouteFn], RouteFn]:
    """Register a POST handler, validating `required` body fields (see _field_ok)
    into a standard 400 before the handler runs. `missing` overrides the
    generated "missing <name>" message."""
    if not missing:
        names = " or ".join(s.partition(":")[0] for s in required)
        suffix = " list" if len(required) == 1 and "list" in required[0] else ""
        missing = f"missing {names}{suffix}"

    def deco(fn: RouteFn) -> RouteFn:
        POST_ROUTES[path] = (fn, required, missing)
        return fn

    return deco


# ── server lifecycle (main + worktree workspaces, one-shot runs) ─────────────


def _build_launch(body: dict[str, Any]) -> dict[str, Any] | None:
    """Resolve a thin {workspace, overrides} launch request against the server's
    own config into the dict build_odoo_cmd consumes (handles main + worktree
    workspaces). Returns None if the workspace is missing/unknown."""
    target = body.get("workspace")
    if not target:
        return None
    return services.build_start_config(CONFIG.get()["config"], target, body.get("overrides") or {})


def _launch(
    body: dict[str, Any],
    action: Callable[[dict[str, Any]], tuple[bool, Any]],
    reply: Callable[[Any], RouteResult],
) -> RouteResult:
    """The shared launch envelope: resolve the config, run the action, and map
    the failure detail onto 400 (invalid config) / 409 (slot busy)."""
    cfg = _build_launch(body)
    if cfg is None:
        return 400, {"ok": False, "error": "unknown workspace"}
    ok, detail = action(cfg)
    if ok:
        return reply(detail)
    return (400 if str(detail).startswith("invalid_config") else 409), {
        "ok": False,
        "error": detail,
    }


def _starting(detail: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True, "state": "starting", "cmd": detail["cmd"]}


@post_route("/api/start")
def _api_start(body: dict[str, Any]) -> RouteResult:
    return _launch(body, lambda cfg: WORKSPACES.start("main", cfg), _starting)


@post_route("/api/restart")
def _api_restart(body: dict[str, Any]) -> RouteResult:
    return _launch(body, lambda cfg: WORKSPACES.restart("main", cfg), _starting)


def _api_oneshot(body: dict[str, Any]) -> RouteResult:
    """Start a one-shot run (tests / install / upgrade) on a workspace's server
    slot — body["slot"] (default "main"). The slot's own server is stopped
    first; if a real server was interrupted, its config is handed to the run so
    the backend restarts it when the run ends (resume-after, owned server-side)."""
    slot = body.get("slot") or "main"
    return _launch(body, lambda cfg: WORKSPACES.oneshot(slot, cfg), _starting)


POST_ROUTES["/api/tests/run"] = POST_ROUTES["/api/addons/run"] = (_api_oneshot, (), "")


@post_route("/api/stop")
def _api_stop(body: dict[str, Any]) -> RouteResult:
    ok, detail = WORKSPACES.stop_and_finalize("main")
    if ok:
        return {"ok": True, "state": "stopped"}
    return 409, {"ok": False, "error": detail}


@post_route("/api/workspace/start", "workspace")
def _api_workspace_start(body: dict[str, Any]) -> RouteResult:
    return _launch(
        body,
        lambda cfg: WORKSPACES.start(body["workspace"], cfg),
        lambda detail: {"ok": True, "port": detail["port"]},
    )


@post_route("/api/workspace/stop", "workspace")
def _api_workspace_stop(body: dict[str, Any]) -> RouteResult:
    # stop_and_finalize: a stop mid-run finalizes the run + resumes the
    # server it interrupted, exactly like /api/stop does for main
    ok, detail = WORKSPACES.stop_and_finalize(body["workspace"])
    return (200 if ok else 409), {"ok": ok, "error": None if ok else detail}


def _configured_repos() -> dict[str, dict[str, Any]]:
    """{id: repo-config-dict} for every repo in goo's own config that has both an
    id and a path — used to auto-fork "well-known" extra repos (documentation, …)
    into a new workspace without the frontend needing to know about them."""
    return {
        r["id"]: r
        for r in (CONFIG.get()["config"] or {}).get("repos", [])
        if isinstance(r, dict) and r.get("id") and r.get("path")
    }


@post_route("/api/workspace/create", "repos:list+")
def _api_workspace_create(body: dict[str, Any]) -> dict[str, Any]:
    # add a git worktree per repo (the frontend computes every path); git creates
    # the parent <worktree_dir>/<target>/ folder on the first add.
    #
    # "documentation"/"owl" get special handling below instead of the generic loop —
    # but ONLY when the user actually ticked them in the create dialog's
    # Repositories checkboxes (i.e. the frontend sent an entry for them at all):
    # - documentation sometimes DOES carry a real, bundle/PR-linked branch (someone
    #   documented the feature) — dialogs.js's startNewWorkspaceWizard matches it
    #   like any other configured repo, so an already-fetched "attach existing
    #   branch" entry for it may arrive here. Try that first; if it doesn't
    #   actually exist there, fork fresh from the matching Odoo series instead
    #   (base_branch) — never the dev branch itself, the doc repo has no
    #   per-feature branches of its own.
    # - owl never carries per-feature branches at all (it's a different project,
    #   versioned on its own) — forked from the exact commit
    #   community/addons/web/static/lib/owl/owl.js vendors (or "master" as a
    #   fallback), regardless of anything the frontend sends for its branch.
    # Both are best-effort extras: a failure is reported in `results` (visible in
    # the event log) but never fails the whole workspace creation the way a
    # failure in one of the actually-requested repos does. Neither is ticked by
    # default (templates/bundles don't list them as checkouts), so silently
    # forking them regardless of the checkboxes surprised users who never asked
    # for them — hence the explicit request check below.
    doc_requested = any(r.get("repo") == "documentation" for r in body["repos"])
    owl_requested = any(r.get("repo") == "owl" for r in body["repos"])
    doc_attach = next(
        (
            r
            for r in body["repos"]
            if r.get("repo") == "documentation" and r.get("branch") and not r.get("newBranch")
        ),
        None,
    )
    repos = [r for r in body["repos"] if r.get("repo") != "owl" and r is not doc_attach]
    cfg = CONFIG.get()["config"] or {}
    main_repo_id = cfg.get("main_repo_id") or "community"
    community = next((r for r in repos if r.get("repo") == main_repo_id), None)
    dev_branch = community and (community.get("newBranch") or community.get("branch"))

    results = []
    for r in repos:
        ok, error = GIT.worktree_add(
            r.get("mainPath"),
            r.get("worktreePath"),
            r.get("newBranch") or r.get("branch"),
            r.get("repo", ""),
            new_branch=bool(r.get("newBranch")),
            start_point=r.get("startPoint"),
            fresh_start=True,
            pull_remote=r.get("pull_remote"),
        )
        results.append({"repo": r.get("repo"), "ok": ok, "error": error})
    ok = all(x["ok"] for x in results)

    # documentation: a manually-selected entry (ticked like any other repo in the
    # regular create dialog) already went through the loop above with a proper
    # base-branch start point (dialogs.js falls back to baseBranchOf() for any repo
    # without a template start point) — nothing more to do for it here.
    documentation_path = None
    manual_doc = next((r for r in repos if r.get("repo") == "documentation"), None)
    if manual_doc:
        documentation_path = manual_doc["worktreePath"] if ok else None
    elif doc_requested and ok and community and community.get("worktreePath") and dev_branch:
        doc_cfg = _configured_repos().get("documentation")
        if doc_cfg:
            worktree_parent = os.path.dirname(community["worktreePath"])
            doc_worktree_path = os.path.join(worktree_parent, "documentation")
            if doc_attach:
                attached_ok, _ = GIT.worktree_add(
                    doc_cfg["path"], doc_worktree_path, doc_attach["branch"], "documentation"
                )
                if attached_ok:
                    results.append({"repo": "documentation", "ok": True, "error": None})
                    documentation_path = doc_worktree_path
            if documentation_path is None:
                forked_ok, forked_error = GIT.worktree_add(
                    doc_cfg["path"],
                    doc_worktree_path,
                    dev_branch,
                    "documentation",
                    new_branch=True,
                    start_point=services.base_branch(dev_branch),
                    fresh_start=True,
                    pull_remote=doc_cfg.get("pull_remote"),
                )
                results.append({"repo": "documentation", "ok": forked_ok, "error": forked_error})
                if forked_ok:
                    documentation_path = doc_worktree_path

    # owl: only *after* community is a real checkout — its start point is the
    # exact commit community/addons/web/static/lib/owl/owl.js actually vendors,
    # which can only be read once that file exists on disk
    # (GitService.resolve_owl_worktree_start; falls back to "master" when that
    # commit isn't reachable in the local owl clone).
    owl_path = None
    if owl_requested and ok and community and community.get("worktreePath") and dev_branch:
        owl_cfg = _configured_repos().get("owl")
        if owl_cfg:
            worktree_parent = os.path.dirname(community["worktreePath"])
            owl_worktree_path = os.path.join(worktree_parent, "owl")
            start = GIT.resolve_owl_worktree_start(
                community["worktreePath"], owl_cfg["path"], owl_cfg.get("pull_remote")
            )
            owl_ok, owl_error = GIT.worktree_add(
                owl_cfg["path"],
                owl_worktree_path,
                dev_branch,
                "owl",
                new_branch=True,
                start_point=start,
                fresh_start=True,
                pull_remote=owl_cfg.get("pull_remote"),
            )
            results.append({"repo": "owl", "ok": owl_ok, "error": owl_error})
            if owl_ok:
                owl_path = owl_worktree_path

    # odoo.conf + CLAUDE.md/skills need every repo's path to be known — generate
    # them here (once all of them exist), not per-repo inside worktree_add, where a
    # later sibling (enterprise, documentation, owl) wouldn't be known about yet
    if ok and community and community.get("worktreePath") and dev_branch:
        community_path = community["worktreePath"]
        worktree_parent = os.path.dirname(community_path)
        has_enterprise = any(r.get("repo") == "enterprise" for r in repos)

        # documentation/owl aren't addons dirs — excluded from the addons_path,
        # unlike every other extra repo (enterprise, …)
        addon_repo_paths = [
            r["worktreePath"]
            for r in repos
            if r.get("repo") not in (main_repo_id, "documentation", "owl") and r.get("worktreePath")
        ]
        addons_path = ",".join(
            [os.path.join(community_path, "addons"), *addon_repo_paths, ADDONS_DIR]
        )
        GIT.write_odoo_conf(
            worktree_parent, addons_path, cfg.get("db_user", "odoo"), cfg.get("db_password", "odoo")
        )
        GIT.create_worktree_claude_md(
            worktree_parent, dev_branch, has_enterprise, documentation_path, owl_path
        )
        GIT.create_worktree_skills(
            community_path, worktree_parent, dev_branch, documentation_path, owl_path
        )
    return {"ok": ok, "results": results}


@post_route("/api/workspace/venv/create", "venvPath", "requirementsPath")
def _api_workspace_venv_create(body: dict[str, Any]) -> RouteResult:
    # best-effort step after a worktree's own /api/workspace/create: paths are
    # precomputed by the frontend (venvPath = <worktree.dir>/.venv), same
    # division of labor as /api/workspace/create's repos list
    ok, error = VENV.create(body["venvPath"], body["requirementsPath"])
    return (200 if ok else 400), {"ok": ok, "error": error}


@post_route("/api/workspace/remove", "repos:list")
def _api_workspace_remove(body: dict[str, Any]) -> dict[str, Any]:
    results = []
    for r in body["repos"]:
        ok, error = GIT.worktree_remove(r.get("mainPath"), r.get("worktreePath"), r.get("repo", ""))
        results.append({"repo": r.get("repo"), "ok": ok, "error": error})
    # "documentation"/"owl" get their OWN worktree paths at creation (see
    # _api_workspace_create) rather than the ones the frontend computed for the
    # repos it ticked — even when ticked, they aren't necessarily where a generic
    # per-repo removal loop would look. Scan for them by their well-known
    # <dirPath>/<repo_id> location instead (skipped if the directory was never
    # created — e.g. neither was ticked at creation), or the main repo's
    # `git worktree list` goes stale.
    dir_path = body.get("dirPath")
    if dir_path:
        configured = _configured_repos()
        for repo_id in ("documentation", "owl"):
            cfg = configured.get(repo_id)
            path = os.path.join(dir_path, repo_id)
            if cfg and effects.is_dir(path):
                GIT.worktree_remove(cfg["path"], path, repo=repo_id)
        effects.remove_tree(dir_path)  # sweep the now-empty parent folder
    if body.get("workspace"):
        CLAUDE.forget(body["workspace"])  # its checkout is gone; drop the chat + any run
    return {"ok": all(x["ok"] for x in results), "results": results}


@post_route("/api/workspace/list", "workspaces:list")
def _api_workspace_list(body: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True, "servers": WORKSPACES.status_for(body["workspaces"])}


@post_route("/api/workspace/external_status", "name:str")
def _api_workspace_external_status(body: dict[str, Any]) -> dict[str, Any]:
    """Read-only: is a container serving database `name` currently running,
    reachable at http://<container>.localhost/? goo never starts or stops this
    container itself — this only reports on one someone else (e.g. a launcher
    script) may have started, for launch_mode="external" workspaces (goo's own
    subprocess/Docker Start/Stop is unused there). There's no universal
    convention for what such a script names its container (ours might be
    "dev", "dev1", anything), so every running container is checked by its
    launch command instead of assuming a naming scheme. Reports "not running"
    (rather than erroring) when docker itself isn't available — "external"
    doesn't imply Docker specifically, just "launched outside of goo"."""
    name = body["name"]
    try:
        ps = effects.run(["docker", "ps", "--format", "{{.Names}}"], quiet=True, timeout=10)
        if ps.returncode != 0:
            return {"ok": True, "running": False, "url": None}
        for container in ps.stdout.split():
            cmd = effects.run(
                ["docker", "inspect", "-f", "{{.Config.Cmd}}", container], quiet=True, timeout=10
            )
            if cmd.returncode == 0 and f" -d {name} " in f" {cmd.stdout.strip()} ":
                return {"ok": True, "running": True, "url": f"http://{container}.localhost/"}
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return {"ok": True, "running": False, "url": None}


@post_route("/api/workspace/logs", "workspace")
def _api_workspace_logs(body: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True, "lines": WORKSPACES.logs_for(body["workspace"])}


@post_route(
    "/api/workspace/claude",
    "workspace",
    "prompt",
    "cwd",
    missing="missing workspace, prompt or cwd",
)
def _api_workspace_claude(body: dict[str, Any]) -> RouteResult:
    ok, detail = CLAUDE.send(
        body["workspace"],
        body["prompt"],
        body["cwd"],
        body.get("addDirs") or [],
        model=body.get("model"),
        review=bool(body.get("review")),
        git=GIT,
    )
    if ok:
        return {"ok": True, "state": detail["state"]}
    return (409 if detail == "already_running" else 400), {"ok": False, "error": detail}


@post_route("/api/workspace/claude/stop", "workspace")
def _api_workspace_claude_stop(body: dict[str, Any]) -> dict[str, Any]:
    ok, detail = CLAUDE.stop(body["workspace"])
    return {"ok": ok, "error": None if ok else detail}


@post_route("/api/workspace/claude/history", "workspace")
def _api_workspace_claude_history(body: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True, **CLAUDE.history_for(body["workspace"])}


@post_route("/api/workspace/claude/review", "workspace")
def _api_workspace_claude_review(body: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True, **CLAUDE.review_text(body["workspace"], body.get("version"))}


@post_route("/api/review-prompt")
def _api_review_prompt_save(body: dict[str, Any]) -> RouteResult:
    ok, error = effects.write_text(REVIEW_PROMPT_PATH, body.get("content") or "")
    if ok:
        return {"ok": True}
    return 500, {"ok": False, "error": error or "write failed"}


# ── git: branches, checkouts, commits, history ───────────────────────────────


@post_route("/api/code/branches", "repos:list")
def _api_code_branches(body: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True, "repos": GIT.branches(body["repos"])}


@post_route("/api/code/checkout", "repos:list")
def _api_code_checkout(body: dict[str, Any]) -> dict[str, Any]:
    # check out each repo in parallel — independent working trees, so a
    # multi-repo target switches in one checkout's time, not the sum
    def co(r: dict[str, Any]) -> dict[str, Any]:
        ok, error = GIT.checkout(r.get("path"), r.get("branch"), r.get("repo", ""))
        return {"branch": r.get("branch"), "ok": ok, "error": error}

    repos = body["repos"]
    if repos:
        with ThreadPoolExecutor(max_workers=min(8, len(repos))) as pool:
            results = list(pool.map(co, repos))
    else:
        results = []
    return {"ok": True, "results": results}


@post_route("/api/code/rebase", "repos:list")
def _api_code_rebase(body: dict[str, Any]) -> dict[str, Any]:
    # fetch + rebase each repo in parallel — independent working trees, so the
    # slow network fetches overlap instead of running back-to-back (each phase
    # reports under its own event id, so the progress log stays unambiguous)
    def fr(r: dict[str, Any]) -> dict[str, Any]:
        ok, error = GIT.fetch_rebase(
            r.get("path"), r.get("base"), r.get("pull_remote"), r.get("repo")
        )
        return {"repo": r.get("repo"), "ok": ok, "error": error}

    repos = body["repos"]
    if repos:
        with ThreadPoolExecutor(max_workers=min(8, len(repos))) as pool:
            results = list(pool.map(fr, repos))
    else:
        results = []
    return {"ok": True, "results": results}


@post_route("/api/code/branches/create", "branches:list")
def _api_code_branches_create(body: dict[str, Any]) -> dict[str, Any]:
    # create each branch in parallel — independent working trees, so a
    # multi-repo target's branches are created in one create's time, not the sum
    def mk(b: dict[str, Any]) -> dict[str, Any]:
        ok, error = GIT.create_branch(
            b.get("path"),
            b.get("name"),
            b.get("start_point"),
            fresh_start=bool(b.get("fresh_start")),
            pull_remote=b.get("pull_remote"),
            repo=b.get("repo", ""),
        )
        return {"name": b.get("name"), "ok": ok, "error": error}

    branches = body["branches"]
    if branches:
        with ThreadPoolExecutor(max_workers=min(8, len(branches))) as pool:
            results = list(pool.map(mk, branches))
    else:
        results = []
    return {"ok": True, "results": results}


@post_route("/api/code/branches/delete", "path", "branch")
def _api_code_branches_delete(body: dict[str, Any]) -> RouteResult:
    ok, error, remote_error = GIT.delete_branch(
        body["path"], body["branch"], bool(body.get("delete_remote")), body.get("push_remote")
    )
    if ok:
        return {"ok": True, "remote_error": remote_error}
    return 400, {"ok": False, "error": error}


@post_route("/api/code/branch/remote", "path", "branch")
def _api_code_branch_remote(body: dict[str, Any]) -> RouteResult:
    exists, error = GIT.remote_branch_exists(
        body["path"], body["branch"], push_remote=body.get("push_remote")
    )
    if error:
        return 400, {"ok": False, "error": error}
    return {"ok": True, "exists": exists}


@post_route("/api/code/branch/push", "path", "branch")
def _api_code_branch_push(body: dict[str, Any]) -> RouteResult:
    ok, error = GIT.push_branch(
        body["path"], body["branch"], bool(body.get("force")), push_remote=body.get("push_remote")
    )
    return (200 if ok else 400), {"ok": ok, "error": error}


@post_route("/api/code/remote-branches/search", "query", missing="missing query or repos")
def _api_code_remote_branches_search(body: dict[str, Any]) -> RouteResult:
    repos = body.get("repos", [])
    if not isinstance(repos, list):
        return 400, {"ok": False, "error": "missing query or repos"}
    return {"ok": True, "results": GITHUB.search_branches(repos, body["query"])}


@post_route("/api/code/remote-branch/fetch", "path", "branch")
def _api_code_remote_branch_fetch(body: dict[str, Any]) -> RouteResult:
    ok, error, non_ff = GIT.fetch_remote_branch(
        body["path"],
        body["branch"],
        pull_remote=body.get("pull_remote"),
        force=bool(body.get("force")),
    )
    return (200 if ok else 400), {"ok": ok, "error": error, "non_ff": non_ff}


@post_route("/api/code/remote-branch/fetch-pr", "path", "github", "number", "branch")
def _api_code_remote_branch_fetch_pr(body: dict[str, Any]) -> RouteResult:
    ok, error, non_ff = GIT.fetch_pr_head(
        body["path"],
        body["github"],
        body["number"],
        body["branch"],
        force=bool(body.get("force")),
    )
    return (200 if ok else 400), {"ok": ok, "error": error, "non_ff": non_ff}


@post_route("/api/code/remote-branch/sync-pr", "path", "github", "number")
def _api_code_remote_branch_sync_pr(body: dict[str, Any]) -> RouteResult:
    ok, error = GIT.sync_pr_worktree(
        body["path"], body["github"], body["number"], repo=body.get("repo", "")
    )
    return (200 if ok else 400), {"ok": ok, "error": error}


@post_route("/api/code/wip-commit", "path")
def _api_code_wip_commit(body: dict[str, Any]) -> RouteResult:
    ok, error = GIT.wip_commit(body["path"])
    return (200 if ok else 400), {"ok": ok, "error": error}


@post_route("/api/code/commit", "path", "message:strip")
def _api_code_commit(body: dict[str, Any]) -> RouteResult:
    ok, error = GIT.commit(body["path"], body["message"])
    return (200 if ok else 400), {"ok": ok, "error": error}


@post_route("/api/code/amend", "path", "message:strip")
def _api_code_amend(body: dict[str, Any]) -> RouteResult:
    ok, error = GIT.amend_commit(body["path"], body["message"])
    return (200 if ok else 400), {"ok": ok, "error": error}


@post_route(
    "/api/code/reword", "path", "sha", "message:strip", missing="missing path, sha, or message"
)
def _api_code_reword(body: dict[str, Any]) -> RouteResult:
    ok, error = GIT.reword_commit(
        body["path"],
        body["sha"],
        body["message"],
        base=body.get("base") or "",
        pull_remote=body.get("pull_remote") or "origin",
    )
    return (200 if ok else 400), {"ok": ok, "error": error}


@post_route(
    "/api/code/rebase-plan", "path", "base", "plan:list", missing="missing path, base, or plan"
)
def _api_code_rebase_plan(body: dict[str, Any]) -> RouteResult:
    ok, error, in_progress = GIT.rewrite_history(
        body["path"], body["base"], body["plan"], pull_remote=body.get("pull_remote") or "origin"
    )
    return (200 if ok else 400), {"ok": ok, "error": error, "in_progress": in_progress}


@post_route("/api/code/rebase-abort", "path")
def _api_code_rebase_abort(body: dict[str, Any]) -> RouteResult:
    ok, error = GIT.abort_rebase(body["path"])
    return (200 if ok else 400), {"ok": ok, "error": error}


@post_route("/api/code/rebase-status", "path")
def _api_code_rebase_status(body: dict[str, Any]) -> RouteResult:
    in_progress, error = GIT.rebase_status(body["path"])
    ok = error is None
    return (200 if ok else 400), {"ok": ok, "in_progress": in_progress, "error": error}


@post_route("/api/code/discard", "path")
def _api_code_discard(body: dict[str, Any]) -> RouteResult:
    ok, error = GIT.discard(body["path"])
    return (200 if ok else 400), {"ok": ok, "error": error}


@post_route("/api/code/log", "path")
def _api_code_log(body: dict[str, Any]) -> RouteResult:
    commits, error = GIT.log(
        body["path"],
        int(body.get("count") or 20),
        body.get("ref") or "",
        body.get("base") or "",
        body.get("pull_remote") or "origin",
    )
    ok = error is None
    return (200 if ok else 400), {"ok": ok, "commits": commits or [], "error": error}


@post_route("/api/code/commit/diff", "path", "sha")
def _api_code_commit_diff(body: dict[str, Any]) -> RouteResult:
    diff, error = GIT.commit_diff(body["path"], body["sha"])
    ok = error is None
    return (200 if ok else 400), {"ok": ok, "diff": diff or "", "error": error}


# ── GitHub / runbot / mergebot / nightly ─────────────────────────────────────


@post_route("/api/prs", "repos:list")
def _api_prs(body: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True, "repos": GITHUB.prs(body["repos"], refresh=bool(body.get("refresh")))}


@post_route("/api/prs/for-branches", "branches:list")
def _api_prs_for_branches(body: dict[str, Any]) -> dict[str, Any]:
    prs = GITHUB.prs_for_branches(body["branches"], refresh=bool(body.get("refresh")))
    return {"ok": True, "prs": prs}


@post_route("/api/prs/info", "prs:list")
def _api_prs_info(body: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True, "prs": GITHUB.pr_infos(body["prs"], refresh=bool(body.get("refresh")))}


@post_route("/api/prs/review-status", "prs:list")
def _api_prs_review_status(body: dict[str, Any]) -> dict[str, Any]:
    statuses = GITHUB.review_statuses(body["prs"], refresh=bool(body.get("refresh")))
    return {"ok": True, "statuses": statuses}


@post_route("/api/prs/close", "repo", "number")
def _api_prs_close(body: dict[str, Any]) -> RouteResult:
    ok, error = GITHUB.close_pr(body["repo"], body["number"])
    if ok:
        return {"ok": True}
    return 400, {"ok": False, "error": error}


@post_route("/api/prs/ready")
def _api_prs_ready(body: dict[str, Any]) -> RouteResult:
    repo, number = body.get("repo"), body.get("number")
    valid_repo = isinstance(repo, str) and re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo)
    if not isinstance(repo, str) or not valid_repo or type(number) is not int or number <= 0:
        return 400, {"ok": False, "error": "invalid repo or number"}
    ok, error = GITHUB.ready_pr(repo, number)
    return (200 if ok else 400), {"ok": ok, **({} if ok else {"error": error})}


@post_route("/api/prs/head")
def _api_prs_head(body: dict[str, Any]) -> RouteResult:
    repo, number = body.get("repo"), body.get("number")
    valid_repo = isinstance(repo, str) and re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo)
    if not isinstance(repo, str) or not valid_repo or type(number) is not int or number <= 0:
        return 400, {"ok": False, "error": "invalid repo or number"}
    branch, error = GITHUB.pr_head(repo, number)
    if branch:
        return {"ok": True, "branch": branch}
    return 400, {"ok": False, "error": error}


@post_route("/api/prs/r-plus")
def _api_prs_r_plus(body: dict[str, Any]) -> RouteResult:
    repo, number = body.get("repo"), body.get("number")
    valid_repo = isinstance(repo, str) and re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo)
    if not isinstance(repo, str) or not valid_repo or type(number) is not int or number <= 0:
        return 400, {"ok": False, "error": "invalid repo or number"}
    ok, error = GITHUB.post_r_plus(repo, number)
    return (200 if ok else 400), {"ok": ok, **({} if ok else {"error": error})}


@post_route("/api/mergebot", "prs:list")
def _api_mergebot(body: dict[str, Any]) -> dict[str, Any]:
    states, details, forward_ports, unsupported = MERGEBOT.statuses(
        body["prs"], refresh=bool(body.get("refresh"))
    )
    return {
        "ok": True,
        "states": states,
        "details": details,
        "forward_ports": forward_ports,
        "unsupported": unsupported,
    }


@post_route("/api/runbot", "branches:list")
def _api_runbot(body: dict[str, Any]) -> dict[str, Any]:
    return {
        "ok": True,
        "states": RUNBOT.statuses(body["branches"], refresh=bool(body.get("refresh"))),
    }


@post_route("/api/runbot/bundle-info", "url")
def _api_runbot_bundle_info(body: dict[str, Any]) -> RouteResult:
    # resolve a pasted bundle URL to its branch name + repos + PRs (the
    # "workspace from a runbot bundle" wizard step)
    info, error = RUNBOT.bundle_info(body["url"])
    if error:
        return 400, {"ok": False, "error": error}
    assert info is not None  # bundle_info returns (info, None) or (None, error)
    return {"ok": True, **info}


@post_route("/api/runbot/dumps", "branch:str")
def _api_runbot_dumps(body: dict[str, Any]) -> dict[str, Any]:
    # the database dumps runbot's latest batch for this branch's bundle left behind
    # — "Restore runbot database" when the workspace forks off a base version
    # (master / 19.0) rather than a pasted bundle URL
    return {"ok": True, "dumps": RUNBOT.dumps(body["branch"], refresh=bool(body.get("refresh")))}


@post_route("/api/nightly")
def _api_nightly(body: dict[str, Any]) -> dict[str, Any]:
    max_nights = min(max(int(body.get("max_nights", 14)), 7), 84)
    return {"ok": True, **NIGHTLY.builds(refresh=bool(body.get("refresh")), max_nights=max_nights)}


@post_route("/api/ci/merge-stats")
def _api_ci_merge_stats(body: dict[str, Any]) -> dict[str, Any]:
    days = min(max(int(body.get("days", 14)), 1), 60)
    return {
        "ok": True,
        "days": CI.merge_stats(days=days, refresh=bool(body.get("refresh"))),
        "awaiting": CI.queue(),
    }


@post_route("/api/nightly/errors")
def _api_nightly_errors(body: dict[str, Any]) -> RouteResult:
    url = body.get("url", "")
    if not re.match(r"^/runbot/batch/\d+/build/\d+$", url):
        return 400, {"ok": False, "error": "invalid url"}
    return {"ok": True, **NIGHTLY.build_errors(url)}


@post_route("/api/memory/batch", "url")
def _api_memory_batch(body: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True, "builds": NIGHTLY.batch_builds(body["url"])}


@post_route("/api/memory/fetch", "builds:list")
def _api_memory_fetch(body: dict[str, Any]) -> dict[str, Any]:
    data = MEMORY.fetch(body["builds"], with_mobile=bool(body.get("with_mobile", False)))
    return {"ok": True, "data": data}


# ── addons / assets / databases ──────────────────────────────────────────────


@post_route("/api/addons", "repos:list")
def _api_addons(body: dict[str, Any]) -> dict[str, Any]:
    db = body.get("db")
    main_repo_id = (CONFIG.get()["config"] or {}).get("main_repo_id") or "community"
    mods = ADDONS.modules(body["repos"], main_repo_id)
    state = DATABASE.installed_modules(db) if db else {}
    for m in mods:
        m["state"] = state.get(m["name"])
    return {"ok": True, "modules": mods, "db": db}


@post_route("/api/assets", "db:str")
def _api_assets(body: dict[str, Any]) -> dict[str, Any]:
    db = body["db"]
    return {"ok": True, "db": db, "bundles": ASSETS.bundles(db, refresh=bool(body.get("refresh")))}


@post_route("/api/assets/generate", "db:str")
def _api_assets_generate(body: dict[str, Any]) -> RouteResult:
    db = body["db"]
    try:
        # the shell cmd is built from the server's own config; an optional
        # `workspace` resolves through the launch builder so a worktree
        # workspace's bundles are generated with ITS checkout's code
        cfg = CONFIG.get()["config"]
        wsid = body.get("workspace")
        if wsid:
            cfg = services.build_start_config(cfg, wsid) or cfg
        cmd = build_shell_cmd(cfg, db)
    except ValueError as e:
        return 400, {"ok": False, "error": str(e)}
    ok, error = ASSETS.generate(cmd, db)
    return (200 if ok else 400), {"ok": ok, "error": error}


@post_route("/api/assets/breakdown", "db:str", "bundle:str", missing="missing db or bundle")
def _api_assets_breakdown(body: dict[str, Any]) -> RouteResult:
    # read straight from the stored bundle attachment — no odoo process; the
    # configured filestore root locates <filestore>/<db>/<store_fname>. kind
    # scopes to the clicked asset ("js"/"css"); anything else reads both.
    kind = body.get("kind")
    if kind not in ("js", "css"):
        kind = None
    data, error = ASSETS.breakdown(body["db"], body["bundle"], _filestore(body), kind)
    if data is None:
        return 400, {"ok": False, "error": error}
    return {"ok": True, "bundle": body["bundle"], **data}


@post_route("/api/rust-bundler/install")
def _api_rust_bundler_install(body: dict[str, Any]) -> RouteResult:
    ok, result = RUST_BUNDLER.install(CONFIG.get().get("config") or {})
    status = 200 if ok else 409 if "already in progress" in result.get("error", "") else 500
    return status, {"ok": ok, **result}


@post_route("/api/databases/drop", "name:str", missing="missing database name")
def _api_databases_drop(body: dict[str, Any]) -> RouteResult:
    ok, error = DATABASE.drop(body["name"], _filestore(body))
    if ok:
        return {"ok": True}
    return 400, {"ok": False, "error": error}


@post_route("/api/databases/clone", "source:str", "dest:str")
def _api_databases_clone(body: dict[str, Any]) -> RouteResult:
    ok, error = DATABASE.clone(body["source"], body["dest"], _filestore(body))
    return (200 if ok else 400), {"ok": ok, "error": error}


@post_route("/api/databases/restore-dump", "name:str", "url:str")
def _api_databases_restore_dump(body: dict[str, Any]) -> RouteResult:
    # download a runbot build's database dump and restore it locally under `name`
    # (the create-from-bundle wizard's "Restore runbot database"). Long — tens to
    # hundreds of megabytes, then a psql replay — but the server is threaded, so it
    # only ties up this request; progress is narrated to the goo log.
    ok, error = DATABASE.restore_dump(body["name"], body["url"], _filestore(body))
    return (200 if ok else 400), {"ok": ok, "error": error}


@post_route("/api/databases/rename", "name:str", "new_name:str")
def _api_databases_rename(body: dict[str, Any]) -> RouteResult:
    ok, error = DATABASE.rename(body["name"], body["new_name"], _filestore(body))
    return (200 if ok else 400), {"ok": ok, "error": error}


# ── goo itself ───────────────────────────────────────────────────────────────


@post_route("/api/open-editor", missing="missing path")
def _api_open_editor(body: dict[str, Any]) -> RouteResult:
    paths = body.get("paths") or body.get("path")
    if not paths:
        return 400, {"ok": False, "error": "missing path"}
    ok, error = open_in_editor(body.get("editor"), paths)
    return (200 if ok else 400), {"ok": ok, "error": error}


@post_route("/api/goo/update")
def _api_goo_update(body: dict[str, Any]) -> RouteResult:
    global GOO_UPDATE
    ok, error = goo_fast_forward()
    if ok:
        GOO_UPDATE = goo_update_status()
    return (200 if ok else 400), {"ok": ok, "error": error}


@post_route("/api/goo/check")
def _api_goo_check(body: dict[str, Any]) -> dict[str, Any]:
    # on-demand re-check (the "Check for update" button) — fetches + recomputes
    return {"ok": check_goo_update(), **GOO_UPDATE, "boot": BOOT_ID}


@post_route("/api/goo/restart")
def _api_goo_restart(body: dict[str, Any]) -> dict[str, Any]:
    # the reply goes out first: restart_goo re-execs only after a short delay,
    # so the response reaches the client before the process is replaced
    threading.Thread(target=lambda: (time.sleep(0.5), restart_goo()), daemon=True).start()
    return {"ok": True}


@post_route("/api/event", "text")
def _api_event(body: dict[str, Any]) -> dict[str, Any]:
    # mirror the frontend event log on the goo terminal
    print(f"{TAG} {time.strftime('%H:%M:%S')} • {body['text']}", flush=True)
    return {"ok": True}


# =============================================================================
# HTTP server
# =============================================================================


class Handler(BaseHTTPRequestHandler):
    # the origins a browser is allowed to drive goo from — goo's own UI. Anything
    # else with an Origin header is a cross-site request (CSRF) and is refused.
    ALLOWED_ORIGINS = frozenset(f"http://{host}:{PORT}" for host in ("127.0.0.1", "localhost"))

    def log_message(self, format: str, *args: Any) -> None:
        pass  # keep the terminal quiet

    def _origin_ok(self) -> bool:
        """Reject cross-site requests. goo exposes shell-equivalent endpoints on
        localhost; localhost is not an auth boundary against the user's own
        browser, so a malicious page could POST/WS to us without this check.
        Browsers attach Origin to every cross-origin POST and WebSocket handshake,
        so an Origin outside our allowlist is a CSRF attempt. A missing Origin is a
        non-browser client (curl, the --test-tags CLI) and carries no CSRF risk."""
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        return origin in self.ALLOWED_ORIGINS

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/":
            self._serve_static("index.html")
        elif path.startswith("/static/"):
            self._serve_static(path[len("/static/") :])
        elif path == "/api/status":
            self._send_json(200, WORKSPACES.status())
        elif path == "/api/goo/update":
            self._send_json(200, {**GOO_UPDATE, "boot": BOOT_ID})
        elif path == "/api/rust-bundler":
            config = CONFIG.get().get("config") or {}
            self._send_json(200, {"ok": True, **RUST_BUNDLER.status(config)})
        elif path == "/api/databases":
            refresh = "refresh" in urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try:
                self._send_json(200, {"ok": True, "databases": DATABASE.databases(refresh=refresh)})
            except RuntimeError as e:
                self._send_json(500, {"ok": False, "error": str(e)})
        elif path == "/api/events":
            self._handle_events()
        elif path == "/api/terminal":
            self._handle_terminal()
        elif path == "/api/shell":
            self._handle_shell()
        elif path == "/api/config":
            self._send_json(200, {"ok": True, **CONFIG.get()})
        elif path == "/api/review-prompt":
            self._send_json(200, {"ok": True, "content": _review_prompt_text()})
        else:
            self._send_json(404, {"ok": False, "error": "not_found"})

    def do_POST(self) -> None:
        if not self._origin_ok():
            return self._send_json(403, {"ok": False, "error": "cross-origin request refused"})
        path = self.path.split("?", 1)[0]
        # the two POSTs that need the raw request stay hand-dispatched
        if path == "/api/config":
            return self._save_config()
        if path == "/api/cli/test":
            return self._handle_cli_test()
        entry = POST_ROUTES.get(path)
        if not entry:
            return self._send_json(404, {"ok": False, "error": "not_found"})
        fn, required, missing = entry
        body, _ = self._read_json()
        body = body or {}  # a bad/absent JSON body just fails the required checks below
        for spec in required:
            if not _field_ok(body, spec):
                return self._send_json(400, {"ok": False, "error": missing})
        result = fn(body)
        status, payload = result if isinstance(result, tuple) else (200, result)
        self._send_json(status, payload)

    # --- API helpers ---

    def _read_json(self) -> tuple[dict[str, Any] | None, str | None]:
        try:
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError
            return data, None
        except (ValueError, OSError):
            return None, "invalid_config: bad JSON body"

    def _send_json(self, code: int, obj: Any) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # --- static files ---

    def _serve_static(self, name: str) -> None:
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

    def _handle_terminal(self) -> None:
        """Upgrade to WebSocket, replay a workspace server's PTY ring buffer, then
        proxy live PTY bytes to the browser and browser keystrokes to the PTY. The
        workspace is picked with ?workspace=<id> (default "main")."""
        if not self._origin_ok():
            return self._send_json(403, {"ok": False, "error": "cross-origin request refused"})
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        wsid = (qs.get("workspace") or ["main"])[0]
        entry = WORKSPACES.entry_for_terminal(wsid)
        if entry is None:
            return self._send_json(404, {"ok": False, "error": "unknown workspace"})
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
        q: queue.Queue[bytes | None] = queue.Queue()

        # snapshot buffer + register atomically so no bytes are lost
        with entry.raw_lock:
            replay = bytes(entry.raw_buf)
            entry.ws_clients.add(q)

        try:
            if replay:
                _ws_send_frame(sock, replay)

            def _sender() -> None:
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
                fd = entry.master_fd  # re-read per frame — a restart swaps the PTY
                if fd is None:
                    continue
                if opcode == 1:  # text: JSON control message (resize)
                    try:
                        msg = json.loads(payload)
                        if msg.get("type") == "resize":
                            rows = max(1, int(msg.get("rows", 24)))
                            cols = max(1, int(msg.get("cols", 80)))
                            fcntl.ioctl(
                                fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0)
                            )
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
            entry.ws_clients.discard(q)
            q.put(None)  # stop the sender thread

    def _handle_shell(self) -> None:
        """Upgrade to WebSocket and proxy an interactive shell process. Two
        modes: ?cwd=<path> for a plain bash in that directory (the Code tab's
        TerminalDialog), or ?workspace=<id> for that workspace's `odoo-bin
        shell` REPL (its own db/addons-path, Docker-mode included — the goo
        Shell popup). One process per connection, killed on disconnect.
        Independent of the Odoo server PTY."""
        if not self._origin_ok():
            return self._send_json(403, {"ok": False, "error": "cross-origin request refused"})
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        wsid = (qs.get("workspace") or [""])[0]
        if wsid:
            base_cfg = CONFIG.get().get("config") or {}
            cfg = services.build_start_config(base_cfg, wsid)
            if cfg is None:
                return self._send_json(404, {"ok": False, "error": "unknown workspace"})
            db = (cfg.get("start") or {}).get("db")
            if not db:
                return self._send_json(
                    400, {"ok": False, "error": "workspace has no database configured"}
                )
            try:
                if cfg.get("launch_mode") == "docker":
                    net_ok, net_err = DOCKER_INFRA.ensure_network(
                        cfg.get("docker_network") or "goo_odoo"
                    )
                    if not net_ok:
                        return self._send_json(
                            400, {"ok": False, "error": f"docker network: {net_err}"}
                        )
                    pg_ok, pg_err = DOCKER_INFRA.ensure_postgres(cfg)
                    if not pg_ok:
                        return self._send_json(
                            400, {"ok": False, "error": f"docker postgres: {pg_err}"}
                        )
                    image, img_err = DOCKER_INFRA.ensure_image(cfg, cfg.get("docker_branch") or "")
                    if img_err:
                        return self._send_json(
                            400, {"ok": False, "error": f"docker image: {img_err}"}
                        )
                    # ensure_image returns (tag, None) or (None, error)
                    assert image is not None
                    shell_cmd = build_docker_shell_cmd(cfg, db, image)
                else:
                    shell_cmd = build_shell_cmd(cfg, db)
            except ValueError as e:
                return self._send_json(400, {"ok": False, "error": str(e)})
            cwd = None  # shell_cmd already cd's (local) / mounts (docker) on its own
            argv = ["/bin/bash", "-c", shell_cmd]
            trace_label = f"odoo-bin shell ({wsid})"
        else:
            cwd = os.path.expanduser((qs.get("cwd") or [""])[0])
            if not cwd or not os.path.isdir(cwd):
                return self._send_json(400, {"ok": False, "error": "invalid cwd"})
            argv = ["/bin/bash", "-i"]
            trace_label = f"/bin/bash -i (cwd: {cwd})"
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

        def _preexec() -> None:
            os.setsid()
            fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)  # pty becomes controlling tty

        effects.trace("run", trace_label)
        proc = subprocess.Popen(
            argv,
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
        def _pty_to_ws() -> None:
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
                            fcntl.ioctl(
                                master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0)
                            )
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

    def _handle_events(self) -> None:
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
            # prime every workspace server (main first, enriched) + every run, so a
            # fresh tab reflects the whole runtime without extra bootstrap calls
            for snap in WORKSPACES.public_snapshots():
                self._send_event("server", snap)
            for run in WORKSPACES.run_snapshots():
                self._send_event("run", run)
            self._send_event("config", CONFIG.get())
            for line in backlog:
                self._send_event("log", {"server": "main", "line": line})
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

    def _save_config(self) -> None:
        """Persist a config and/or state write from the browser, rev-checked. Body:
        {rev, config?, state?}. On success replies {ok, rev, config, state} (rev
        bumped) and broadcasts the new config to every tab (SSE 'config'); a stale
        rev replies 409 with the current {rev, config, state} so the client can
        reconcile; a write failure replies 500."""
        body, err = self._read_json()
        if err or body is None or "rev" not in body:
            return self._send_json(400, {"ok": False, "error": "missing rev"})
        kw: dict[str, Any] = {}
        if "config" in body:
            kw["config"] = body["config"]
        if "state" in body:
            kw["state"] = body["state"]
        ok, result = CONFIG.save(body["rev"], **kw)
        if ok:
            return self._send_json(200, {"ok": True, **result})
        if result.get("conflict"):
            return self._send_json(409, {"ok": False, **result})
        return self._send_json(500, {"ok": False, "error": result.get("error", "write failed")})

    def _handle_cli_test(self) -> None:
        """Run a one-shot test (triggered by the `goo --test-tags` CLI) as its own
        odoo process — on free ports, so a running server is left untouched — and
        stream the log back as plain text. Announces the run on the server log +
        the browser event log, using the server's own config + active workspace."""
        body, err = self._read_json()
        tags = ((body or {}).get("test_tags") or "").strip()
        if err or not tags:
            return self._send_json(400, {"ok": False, "error": "missing test_tags"})
        snapshot = CONFIG.get()
        config = snapshot.get("config")
        state = snapshot.get("state") or {}
        active = state.get("active_workspace")
        cfg = (
            services.build_start_config(config, active, {"test_tags": tags})
            if config and active
            else None
        )
        if not cfg:
            return self._send_json(
                409,
                {
                    "ok": False,
                    "error": "no workspace yet — open the goo UI (with a workspace configured) once",
                },
            )
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
        effects.trace("run", cmd)
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
        assert proc.stdout is not None  # stdout=PIPE
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

    def _send_event(self, event: str, payload: Any) -> None:
        # json.dumps guarantees a single-line data field
        msg = f"event: {event}\ndata: {json.dumps(payload)}\n\n"
        self.wfile.write(msg.encode("utf-8"))
        self.wfile.flush()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request: Any, client_address: Any) -> None:
        # the client closed the connection before we finished writing (page
        # reload, aborted fetch, SSE reconnect, a superseded refresh). Harmless
        # — don't dump a traceback. Real errors still propagate.
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


def run_cli_test(tags: str) -> int:
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


def main() -> int:
    parser = argparse.ArgumentParser(description="odoo development helper (web UI)")
    parser.add_argument("--open", action="store_true", help="open the UI in the default browser")
    parser.add_argument(
        "--test-tags",
        dest="test_tags",
        metavar="TAGS",
        help="run a test with these --test-tags on the running goo server and stream the log",
    )
    parser.add_argument(
        "--config",
        dest="config",
        metavar="PATH",
        help="path to goo's config file (default: $XDG_CONFIG_HOME/goo/config.json, "
        "i.e. ~/.config/goo/config.json). Kept outside the checkout so the self-updater "
        "never touches it.",
    )
    parser.add_argument(
        "--trace",
        action="store_true",
        help="log every external operation goo runs to the goo terminal: each "
        "subprocess (git, psql, dropdb, gh, odoo-bin, the shell terminal, …) and "
        "each filesystem read/write/move/copy. Network requests are always logged. "
        "Verbose — handy for seeing exactly what goo does under the hood.",
    )
    args = parser.parse_args()

    # point the config store at --config before anything (the CLI run, the loops,
    # or the first request) reads it. Reassigning .path is safe: nothing has been
    # loaded/cached yet at startup.
    if args.config:
        CONFIG.path = os.path.expanduser(args.config)
        # keep the CI cache, generated nginx.conf, review prompt, and saved
        # reviews beside the chosen config file
        CI.cache_path = os.path.join(os.path.dirname(CONFIG.path), "ci_merge_stats.json")
        DOCKER_INFRA.nginx_conf_path = os.path.join(
            os.path.dirname(CONFIG.path), "docker", "nginx.conf"
        )
        global REVIEW_PROMPT_PATH, REVIEWS_DIR
        REVIEW_PROMPT_PATH = os.path.join(os.path.dirname(CONFIG.path), "review_prompt.md")
        REVIEWS_DIR = os.path.join(os.path.dirname(CONFIG.path), "reviews")
        CLAUDE.reviews_dir = REVIEWS_DIR

    # DatabaseService/AssetsService's psql calls never pass connection info of
    # their own -- they rely entirely on psql's defaults (a local unix socket,
    # peer auth as the OS user). That's silently wrong for any non-local
    # Postgres (e.g. running in Docker), so seed the standard PG* env vars from
    # config once at startup: PGUSER/PGPASSWORD always (harmless even for peer
    # auth), PGHOST/PGPORT only when db_host is set (empty = unchanged socket
    # behavior). Not re-read on config changes -- restart goo after editing.
    pg_config = CONFIG.get()["config"] or {}
    if pg_config.get("db_user"):
        os.environ["PGUSER"] = pg_config["db_user"]
    if pg_config.get("db_password"):
        os.environ["PGPASSWORD"] = pg_config["db_password"]
    if pg_config.get("launch_mode") == "docker":
        # goo's own Postgres container, published on docker_postgres_port —
        # db_host/db_port are hidden/unused in this mode (see config_screen/
        # config.js's SETTINGS_FIELDS `modes`), derived here instead so they
        # can't drift out of sync with a separately-edited db_host/db_port
        os.environ["PGHOST"] = "127.0.0.1"
        os.environ["PGPORT"] = str(pg_config.get("docker_postgres_port") or "5433")
    elif pg_config.get("db_host"):
        os.environ["PGHOST"] = pg_config["db_host"]
        if pg_config.get("db_port"):
            os.environ["PGPORT"] = str(pg_config["db_port"])

    # turn on tracing before any work (incl. the one-shot --test-tags run) happens
    if args.trace:
        effects.set_trace(True)

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
    atexit.register(WORKSPACES.shutdown)
    atexit.register(CLAUDE.shutdown)
    # check whether goo's checkout is behind origin/master — at startup, then hourly
    threading.Thread(target=goo_update_loop, daemon=True).start()
    # auto-register any worktree_dir subdirectory holding a configured repo's
    # checkout that isn't a workspace yet (see backend/adopt.py) — at startup,
    # then every minute. Imported here, not at module level, to avoid a
    # circular import (adopt.py imports CONFIG from this module).
    from . import adopt

    try:
        # once, synchronously, before cleanup (right below) can start: its own
        # first tick reading an empty just-booted config (before adopt's own
        # background thread gets to it) would silently find nothing to check
        adopt.scan_and_register()
    except Exception as e:
        print(f"[goo] adopt scan failed: {e}", flush=True)
    threading.Thread(target=adopt.loop, daemon=True).start()
    # optional daily cleanup of merged worktree workspaces (see
    # backend/cleanup.py) -- off by default (cleanup_enabled), and cleanup.py
    # itself re-checks the setting on every tick, so this thread is harmless
    # to always start. Imported here, not at module level, for the same
    # reason as adopt above (cleanup.py imports CONFIG/GIT/GITHUB from here).
    from . import cleanup

    threading.Thread(target=cleanup.loop, daemon=True).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print(f"\n{TAG} shutting down...")
    finally:
        WORKSPACES.shutdown()
        CLAUDE.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
