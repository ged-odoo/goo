"""The wire contract — the one place field names are defined.

stdlib `@dataclass` types shared between the services (which build them) and the
HTTP handlers (which `dataclasses.asdict()` them onto the wire). Field names on
the wire are snake_case; the backend normalizes GitHub's camelCase at the source
(see `GitHubService`), and the frontend mirrors these shapes in
`static/src/models.js`.

This module is introduced by Step 1 of the state-model restructuring, which wires
only the PullRequest family (`PullRequest`, `CiCheck`, `CiRollup`). The request
DTOs below (`RepoRef`, `Checkout`, `LaunchSpec`) are declared as the shared
contract but are wired into the endpoints in later steps.
"""

from dataclasses import dataclass, field

# ─────────────────────────── Observed: pull requests ─────────────────────────


@dataclass
class CiCheck:
    """One CI status/check on a PR's status rollup."""

    context: str
    state: str  # success | failure | pending | ""
    url: str = ""


@dataclass
class CiRollup:
    """A PR's compressed statusCheckRollup: the overall verdict, the ci/runbot
    context's state, and the per-check breakdown."""

    overall: str = ""  # failure if any failed, else pending, else success, else ""
    runbot: str = ""  # the ci/runbot context's state
    checks: list[CiCheck] = field(default_factory=list)


@dataclass
class PullRequest:
    """A pull request in one unified shape, whether authored by the user
    (`relation="authored"`, from `gh pr list`) or reviewed by them
    (`relation="reviewed"`, from the global GitHub search). Identity is
    `(github, number)`; `branch` is the head ref (the join to a local branch)."""

    github: str  # canonical slug, e.g. "odoo/odoo"
    number: int
    title: str
    url: str
    state: str  # open | closed | merged (lowercased at the source)
    branch: str  # head ref name — the join to a local Branch
    relation: str  # authored | reviewed
    draft: bool = False
    created_at: str = ""  # iso; authored PRs only (reviewed carry no created date)
    updated_at: str = ""  # iso
    ci: CiRollup | None = None  # authored PRs only (from the status rollup)


# ─────────────────────────── Request DTOs (declared; wired later) ─────────────
# The shared request schemas the launch endpoints validate at the API boundary.
# Declared here as the contract; the endpoints are moved onto them in a later step.


@dataclass
class RepoRef:
    """A repository as referenced in a request body."""

    id: str
    path: str
    github: str = ""
    external: bool = False


@dataclass
class Checkout:
    """A (repo, branch) pair in a target's checkout list."""

    repo: str
    branch: str


@dataclass
class LaunchSpec:
    """The launch profile the odoo-command builder consumes."""

    repos: list[str]  # repo ids, in addons-path order
    db: str
    on_create_args: str = ""  # applied only when the db is uninitialized
    other_args: str = ""  # server mode only
    test_tags: str | None = None  # → test mode, one-shot
    install: str | None = None  # → install mode, one-shot
    upgrade: str | None = None  # → upgrade mode, one-shot


# ─────────────────────────── Runtime snapshots ───────────────────────────────
# Live-process state the backend owns and mirrors to the browser over SSE. Step 5
# unifies the main odoo (OdooManager) and each worktree odoo (WorktreeManager) —
# the same thing, a server bound to a db + port — into one shape keyed by id
# ("main" | target id), published on a single "server" event.


@dataclass
class ServerSnapshot:
    """One odoo server, whether the main process (`id="main"`, `terminal=True`) or a
    worktree server (`id=target`). Keyed by `id`. Every field is always present so a
    client-side spread-merge behaves as a full replace for the complete "main"
    snapshot while still preserving a worktree's client-only `exists` across the
    partial updates the SSE stream carries."""

    id: str  # "main" | target id — the map key
    state: str  # stopped | starting | running | stopping (| disconnected, client-only)
    terminal: bool = False  # only "main" has the PTY/xterm channel
    target: str | None = None  # the target this server runs
    db: str | None = None
    port: int | None = None  # 8069 for main (implicit), an assigned free port for worktrees
    mode: str | None = None  # server | test | install | upgrade (main only; → Run in Step 6)
    pid: int | None = None
    cmd: str | None = None
    started_at: float | None = None
    exited_unexpectedly: bool = False
    returncode: int | None = None
    # main-only observed enrichment
    odoo_port_busy: bool = False
    odoo_version: str | None = None
    enterprise: bool | None = None
    # worktree-only, client-facing: checkout present on disk (bootstrap; None for main)
    exists: bool | None = None


@dataclass
class RunSnapshot:
    """A one-shot run occupying the shared odoo slot — a test / install / upgrade,
    backend-minted and keyed by `id`. `spec` carries the run's parameters
    (`{"tags": …}` for a test, `{"module": …}` for install/upgrade); `resume` records
    that a real server was interrupted to make room, so the backend restarts it when
    the run ends (survives a mid-run reload — the point of owning this server-side)."""

    id: str  # backend-minted (e.g. "run-3")
    kind: str  # test | install | upgrade
    state: str  # running | done | failed
    server: str = "main"  # the slot it occupies
    target: str | None = None
    db: str | None = None
    spec: dict = field(default_factory=dict)  # {"tags": …} | {"module": …}
    returncode: int | None = None
    ok: bool | None = None  # None while running / when manually stopped
    resume: bool = False  # a server was interrupted for this run and will be resumed
    started_at: float | None = None
