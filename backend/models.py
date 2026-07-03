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
