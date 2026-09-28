"""Process helpers: port probes, process-group termination, the external-editor
launch, the odoo-bin shell / docker shell command builders that need no service
state, the stdlib WebSocket frame helpers, and the per-workspace `_Entry` state
that WorkspaceManager (server.py) owns."""

import base64
import collections
import hashlib
import os
import queue
import shlex
import signal
import socket
import struct
import subprocess
import threading
from typing import Any

from . import effects, services
from .effects import run

HOST = "127.0.0.1"
# the repo root (parent of this backend/ package) — goo's own git checkout, and where
# static/ and addons/ live. Used for the self-update git, the launcher re-exec, etc.
GOO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ADDONS_DIR = os.path.join(GOO_DIR, "addons")


def free_port() -> int:
    """An OS-assigned free TCP port, so a CLI test run can use its own http /
    gevent ports and not clash with the running server's."""
    with socket.socket() as s:
        s.bind((HOST, 0))
        return s.getsockname()[1]


def port_busy(port: int) -> bool:
    try:
        with socket.create_connection((HOST, port), timeout=0.3):
            return True
    except OSError:
        return False


def port_is_free(port: int) -> bool:
    """Whether we can actually bind the port — used to honor a workspace's stable
    port with a safe fallback when a stale process still holds it."""
    try:
        with socket.socket() as s:
            s.bind((HOST, port))
            return True
    except OSError:
        return False


def kill_port(port: int) -> None:
    """Kill any process listening on the given port."""
    try:
        # -sTCP:LISTEN so we only kill the process *listening* on the port, not
        # every process that merely has a client connection open to it (a browser,
        # psql, or goo itself) — plain `lsof -ti :PORT` matches those too.
        result = run(
            ["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"],
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


def terminate_process(process: subprocess.Popen[Any] | None) -> None:
    """Signal-escalate a process group until it exits: graceful SIGTERM, then a
    second SIGTERM (odoo needs a second signal to force shutdown when graceful
    hangs), then SIGKILL as a last resort. Safe on an already-gone process."""
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


def open_in_editor(editor: str | None, paths: str | list[str] | None) -> tuple[bool, str | None]:
    """Launch the configured editor (e.g. `code`) on one or more repo directories,
    detached so it outlives goo and isn't part of its process group. The editor
    string may carry flags (`code --reuse-window`), so it's run through bash with
    each path quoted; passing several dirs (`code repo1 repo2`) opens them in one
    window. `paths` may be a single string or a list. Returns (ok, error).

    A missing/failing editor command exits quickly with a non-zero code — we wait
    briefly to catch that and return its stderr (so the UI shows why it failed,
    e.g. `code: command not found`). A GUI editor that keeps running past the
    grace period is taken as a successful launch."""
    editor = (editor or "").strip()
    if isinstance(paths, str):
        paths = [paths]
    dirs = [os.path.expanduser(p) for p in (paths or []) if p]
    if not editor:
        return False, "no editor configured"
    if not dirs:
        return False, "no path"
    for path in dirs:
        if not os.path.isdir(path):
            return False, f"not a directory: {path}"
    cmd = f"{editor} {' '.join(shlex.quote(p) for p in dirs)}"
    effects.trace("run", cmd)
    try:
        proc = subprocess.Popen(
            cmd,
            shell=True,
            executable="/bin/bash",
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            start_new_session=True,
            text=True,
        )
    except OSError as e:
        return False, str(e)
    try:
        _, stderr = proc.communicate(timeout=2)
    except subprocess.TimeoutExpired:
        return True, None  # still running → launched OK
    if proc.returncode:
        err = (stderr or "").strip() or f"editor exited with code {proc.returncode}"
        print(f"$ {cmd}\n{err}", flush=True)  # log the raw failure to the goo log too
        return False, err
    return True, None


def _odoo_cmd_base(
    config: dict[str, Any],
    addons_repo_ids: list[str] | None = None,
    extra_env: dict[str, str] | None = None,
) -> tuple[str, str]:
    """The invocation prefix build_odoo_cmd and build_shell_cmd share: resolve the
    repo map + community checkout, assemble the addons path (over `addons_repo_ids`,
    or every configured repo when None) and the venv/rust/odoo-bin launch prefix.
    `extra_env` (optional {name: value}) is prefixed right before the odoo-bin
    invocation itself, same spot as the existing RUST_BUNDLER=1 prefix — not
    before the whole `cd ... &&` chain, where a bare env assignment wouldn't
    scope to the actual command.
    Returns (cmd_prefix, addons_path). Raises ValueError on invalid config."""
    main_repo_id = config.get("main_repo_id") or "community"
    repo_map = {
        r["id"]: {**r, "path": os.path.expanduser(r["path"])}
        for r in config.get("repos", [])
        if isinstance(r, dict) and "id" in r and "path" in r
    }
    community = repo_map.get(main_repo_id)
    if not community:
        raise ValueError(f"no '{main_repo_id}' repo defined in repos")
    community_path = community["path"]

    if addons_repo_ids is None:
        addons_repo_ids = list(repo_map)
    addons_parts = []
    for repo_id in addons_repo_ids:
        repo = repo_map.get(repo_id)
        if not repo:
            raise ValueError(f"unknown repo '{repo_id}' in start.repos")
        if repo_id == main_repo_id:
            addons_parts.append("addons")
        else:
            addons_parts.append(os.path.relpath(repo["path"], community_path))
    if not addons_parts:
        raise ValueError("no repos selected in start.repos")
    addons_parts.append(ADDONS_DIR)  # goo's own addons (autologin, auto-installed)
    addons_path = ",".join(addons_parts)

    # the odoo-bin executable; goo cd's into the community checkout and appends the
    # dynamic args. Defaults to that checkout's own odoo-bin, so a worktree start
    # config — which passes the worktree's community path — automatically runs the
    # worktree's odoo-bin without any extra wiring.
    server_path = config.get("server_path") or os.path.join(community_path, "odoo-bin")
    # a dedicated per-workspace venv (config["venv_python"], set by
    # build_start_config for a worktree with worktree.venv) invokes odoo-bin's
    # interpreter explicitly instead of relying on odoo-bin's own shebang line to
    # pick up the activated venv via PATH — correct either way, but doesn't
    # depend on it being `#!/usr/bin/env python3`
    venv_python = config.get("venv_python")
    invocation = f"{venv_python} {server_path}" if venv_python else server_path
    parts = []
    if config.get("venv_activate"):
        parts.append(config["venv_activate"])
    rust = "RUST_BUNDLER=1 " if config.get("rust_bundler") else ""
    env_prefix = "".join(f"{k}={shlex.quote(v)} " for k, v in (extra_env or {}).items())
    parts.append(f"cd {community_path} && {rust}{env_prefix}{invocation}")
    return " && ".join(parts), addons_path


# fixed in-container mount point for goo's own addons (autologin, …) — GOO_DIR
# is goo's own checkout, not per-workspace, so it's bind-mounted read-only at
# a stable path rather than living under the worktree mount like the repos do
_DOCKER_GOO_ADDONS = "/goo-addons"


def _docker_run_prefix(
    config: dict[str, Any], container: str | None = None
) -> tuple[str, str, str, str]:
    """The `docker run` setup shared by build_docker_cmd (a workspace's own
    server) and build_docker_shell_cmd (a one-off odoo-bin shell REPL): repo
    validation, network, mounts, addons-path. `container` is omitted for the
    shell variant (--rm, no fixed name, so it can run alongside an
    already-started server of the same workspace instead of colliding with it).

    Returns (run_prefix_ending_after_the_mounts, mount_path, main_repo_id,
    addons_path). Raises ValueError on invalid config."""
    main_repo_id = config.get("main_repo_id") or "community"
    addons_repo_ids = list((config.get("start") or {}).get("repos") or [])
    if not addons_repo_ids:
        raise ValueError("no repos selected in start.repos")
    if main_repo_id not in addons_repo_ids:
        raise ValueError(f"'{main_repo_id}' (main_repo_id) must be one of start.repos")
    host_dir = config.get("docker_worktree_dir")
    if not host_dir:
        raise ValueError("no worktree directory resolved for this Docker workspace")

    # every repo mounts as a direct SIBLING of the main repo — build_start_config's
    # worktree branch already gives every repo the uniform HOST path <dir>/<repo_id>,
    # so the in-container equivalent is just <mount_path>/<repo_id> regardless of the
    # actual host path. --workdir below is <mount_path>/<main_repo_id> (mirroring
    # build_odoo_cmd's `cd {community_path}`), so a sibling repo's addons_path entry
    # must climb back out one level first — "../enterprise", not bare "enterprise" —
    # exactly what _odoo_cmd_base's real os.path.relpath(repo path, community path)
    # would compute for this same sibling layout.
    mount_path = (config.get("docker_mount_path") or "/src").rstrip("/")
    addons_path = (
        ",".join("addons" if rid == main_repo_id else f"../{rid}" for rid in addons_repo_ids)
        + f",{_DOCKER_GOO_ADDONS}"
    )

    network = config.get("docker_network") or "goo_odoo"
    filestore_host = os.path.expanduser(config.get("filestore") or "")
    filestore_mount = config.get("docker_filestore_mount") or (
        "/home/odoo_user/.local/share/Odoo/filestore"
    )
    name_flag = f"--name {shlex.quote(container)} " if container else ""

    # --workdir is docker's own equivalent of build_odoo_cmd's `cd {community_path}
    # &&` — without it, addons_path's relative entries ("addons", "enterprise")
    # resolve against the image's own default WORKDIR (or /), not the checkout,
    # exactly the same way a local odoo-bin invocation would break without its cd
    run = (
        f"docker run --rm -it --network {shlex.quote(network)} {name_flag}"
        f"--workdir {shlex.quote(f'{mount_path}/{main_repo_id}')} "
        f"-v {shlex.quote(host_dir)}:{shlex.quote(mount_path)} "
        f"-v {shlex.quote(ADDONS_DIR)}:{shlex.quote(_DOCKER_GOO_ADDONS)}:ro "
    )
    if filestore_host:
        run += f"-v {shlex.quote(filestore_host)}:{shlex.quote(filestore_mount)} "
    return run, mount_path, main_repo_id, addons_path


def build_docker_shell_cmd(config: dict[str, Any], db: str, image: str) -> str:
    """Build a one-off `docker run --rm -it ... odoo-bin shell -d <db>` command:
    an interactive Python REPL against a Docker-mode workspace's database,
    independent of whether the workspace's own server container is running (no
    --name, so it never collides with one). Mirrors build_docker_cmd's
    mounts/addons-path, minus the server-only flags (headed browser,
    --db-filter, --limit-time-*, --http-interface). Raises ValueError on
    invalid config/db name."""
    if not services._valid_db_name(db):
        raise ValueError("invalid database name")
    run, mount_path, main_repo_id, addons_path = _docker_run_prefix(config)
    pg_container = config.get("docker_postgres_container") or "goo-postgres"
    db_user = config.get("db_user", "odoo")
    db_password = config.get("db_password", "odoo")
    user_flag = (
        f"--user {shlex.quote(config['docker_container_user'])} "
        if config.get("docker_container_user")
        else ""
    )
    extra_args = config.get("docker_extra_run_args") or ""
    if extra_args:
        extra_args += " "
    run += (
        f"{user_flag}{extra_args}{shlex.quote(image)} python3 {mount_path}/{main_repo_id}/odoo-bin shell "
        f"-d {db} -r {db_user} -w {db_password} --no-http --no-database-list "
        f"--addons-path {addons_path} --db_host {shlex.quote(pg_container)} --db_port 5432 "
        f"--log-level=warn"
    )
    return run


def build_shell_cmd(config: dict[str, Any], db: str) -> str:
    """Build an `odoo-bin shell -d <db>` command (Python read from its stdin) for a
    one-off task like pregenerating assets. Mirrors build_odoo_cmd's venv prefix and
    addons-path, but spans ALL configured repos (not just start.repos) so whatever
    is installed in <db> can load. Raises ValueError on invalid config/db name."""
    if not services._valid_db_name(db):
        raise ValueError("invalid database name")
    cmd, addons_path = _odoo_cmd_base(config)  # ALL repos
    db_user = config.get("db_user", "odoo")
    db_password = config.get("db_password", "odoo")
    cmd += (
        f" shell -d {db} --no-http --no-database-list"
        f" -r {db_user} -w {db_password} --addons-path {addons_path} --log-level=warn"
    )
    return cmd


# =============================================================================
# WebSocket helpers (no external deps — only stdlib hashlib/base64/struct)
# =============================================================================

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
RAW_BUF_MAX = 256 * 1024  # raw PTY byte ring buffer for terminal replay


def _ws_accept_key(key: str) -> str:
    digest = hashlib.sha1((key + _WS_GUID).encode()).digest()
    return base64.b64encode(digest).decode()


def _ws_send_frame(sock: socket.socket, payload: bytes | bytearray, opcode: int = 2) -> None:
    """Send one unmasked WebSocket frame (server→client). opcode 2 = binary."""
    n = len(payload)
    if n < 126:
        header = bytes([0x80 | opcode, n])
    elif n < 65536:
        header = bytes([0x80 | opcode, 126]) + struct.pack(">H", n)
    else:
        header = bytes([0x80 | opcode, 127]) + struct.pack(">Q", n)
    sock.sendall(header + (payload if isinstance(payload, bytes) else bytes(payload)))


def _ws_recv_frame(sock: socket.socket) -> tuple[int, bytes]:
    """Receive one WebSocket frame (client→server, always masked).
    Returns (opcode, payload_bytes). Raises OSError on disconnect."""

    def _recv(n: int) -> bytes:
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


class _Entry:
    """The full per-workspace server state — one per workspace id. Every entry has
    the complete kit: a PTY (terminal channel), a one-shot run slot with
    resume-after, per-server log scrollback, and its own port bookkeeping ("main"
    keeps port None — odoo's implicit default)."""

    LOG_TAIL = 500  # lines kept per server so a freshly-selected workspace has scrollback

    def __init__(self, wsid: str) -> None:
        self.id = wsid
        # process/lifecycle: stopped -> starting -> running -> stopping -> stopped
        self.state = "stopped"
        self.process: subprocess.Popen[bytes] | None = None
        self.master_fd: int | None = None
        self.reader_thread: threading.Thread | None = None
        self.db: str | None = None
        self.workspace: str | None = None  # the workspace this server runs
        self.cmd: str | None = None
        self.mode = "server"  # server | test | install | upgrade
        self.started_at: float | None = None
        self.exited_unexpectedly = False
        self.returncode: int | None = None
        # None for "main" (odoo default); the bound http port otherwise
        self.port: int | None = None
        self.gport: int | None = None
        # launch_mode="docker": the container name (see build_docker_cmd) — set
        # while running so stop() can issue an authoritative `docker stop` (the
        # local `docker run` client's own process/signal handling isn't a
        # reliable way to stop the remote container, see WorkspaceManager.stop)
        self.docker_container: str | None = None
        # one-shot Run occupying the slot (test/install/upgrade) — None for a plain
        # server or when stopped; kept as the last finished snapshot until superseded.
        # resume-after: the config of the server interrupted to run the one-shot.
        self.run: dict[str, Any] | None = None
        self.server_config: dict[str, Any] | None = None
        self.resume_config: dict[str, Any] | None = None
        # per-server log tail (worktree screens prime their scrollback from it)
        self.log: collections.deque[str] = collections.deque(maxlen=self.LOG_TAIL)
        # raw PTY byte ring buffer: replayed to each new terminal WebSocket client
        # so xterm.js can reconstruct the current terminal state on connect
        self.raw_buf = bytearray()
        self.raw_lock = threading.Lock()
        # set of queue.Queue, one per terminal WS connection
        self.ws_clients: set[queue.Queue[bytes | None]] = set()
