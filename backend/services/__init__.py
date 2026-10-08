"""Domain services over the IO seam (effects.py).

Each service takes an `io` object (the effects module, or a fake in tests) and a
TTLCache, so it can be unit-tested without real subprocesses or network. This is
where external state (GitHub PRs, runbot, mergebot) is fetched, parsed, and cached
server-side; the HTTP handlers in goo.py just delegate here.

One module per area (github, runbot, database, git, odoo, config, docker); this
package re-exports all of their names so callers keep using `services.X`.
"""

from ..models import CiCheck, CiRollup, PullRequest
from .config import (
    _KEEP,
    ConfigStore,
    _worktree_dir,
    _worktree_slug,
    build_start_config,
)
from .database import (
    _DB_NAME_RE,
    _RUNBOT_DUMP_URL_RE,
    DUMP_TMP_DIR,
    RESTORE_CLEANUPS,
    DatabaseService,
    _valid_db_name,
)
from .docker import (
    DockerInfraService,
    resolve_docker_image,
)
from .git import (
    _BASE_BRANCH_RE,
    _GITHUB_REMOTE_RE,
    _OWL_HASH_RE,
    _OWL_VERSION_RE,
    GitService,
    base_branch,
    is_base_branch,
    parse_github_slug,
)
from .github import (
    GitHubService,
    _ci_rollup,
    _ci_state,
)
from .odoo import (
    AddonsService,
    AssetsService,
    RustBundlerService,
    VenvService,
)
from .runbot import (
    _BUNDLE_LINK_RE,
    _BUNDLE_ROW_RE,
    _NEXT_UNTIL_RE,
    _PR_RE,
    _STAGED_AT_RE,
    _STAGING_ROW_RE,
    _STAGING_STATE,
    MERGEBOT_BASE,
    MERGEBOT_STATES,
    RUNBOT_BASE,
    CiService,
    MemoryService,
    MergebotService,
    NightlyService,
    RunbotService,
    parse_starred_bundles,
)

__all__ = [
    "DUMP_TMP_DIR",
    "RESTORE_CLEANUPS",
    "CiCheck",
    "CiRollup",
    "PullRequest",
    "_ci_state",
    "_ci_rollup",
    "GitHubService",
    "RUNBOT_BASE",
    "MERGEBOT_BASE",
    "_BUNDLE_ROW_RE",
    "_BUNDLE_LINK_RE",
    "parse_starred_bundles",
    "RunbotService",
    "MERGEBOT_STATES",
    "MergebotService",
    "_STAGING_STATE",
    "_STAGING_ROW_RE",
    "_STAGED_AT_RE",
    "_PR_RE",
    "_NEXT_UNTIL_RE",
    "CiService",
    "NightlyService",
    "MemoryService",
    "_DB_NAME_RE",
    "_RUNBOT_DUMP_URL_RE",
    "_valid_db_name",
    "DatabaseService",
    "_BASE_BRANCH_RE",
    "base_branch",
    "_OWL_VERSION_RE",
    "_OWL_HASH_RE",
    "is_base_branch",
    "_GITHUB_REMOTE_RE",
    "parse_github_slug",
    "GitService",
    "VenvService",
    "AddonsService",
    "AssetsService",
    "RustBundlerService",
    "_KEEP",
    "ConfigStore",
    "_worktree_slug",
    "_worktree_dir",
    "build_start_config",
    "resolve_docker_image",
    "DockerInfraService",
]
