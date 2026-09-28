"""git over the user's repos (+ worktrees, the Claude dev-context skills)."""

import os
import re
import shlex
import shutil
import subprocess
import tempfile
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any


def _template(rel: str) -> str:
    """A static file bundled under templates/ (package data, not user IO)."""
    with open(os.path.join(os.path.dirname(__file__), "templates", rel), encoding="utf-8") as f:
        return f.read()


# ─────────────────────────── git (user repos) ───────────────────────────

_BASE_BRANCH_RE = re.compile(r"^(saas-\d+\.\d+|\d+\.\d+|master)")


def base_branch(name: str | None) -> str:
    """The canonical base a branch derives from (master-owl-update -> master,
    19.0-fix -> 19.0). Defaults to master."""
    m = _BASE_BRANCH_RE.match(name or "")
    return m.group(1) if m else "master"


# the vendored owl.js bundle exports a literal `version = "X.Y.Z"` plus an
# `__info__ = {..., hash: "<short sha>"}` — used to pin the odoo-frontend-owl skill's
# doc links to the Owl build actually checked out (see GitService._resolve_owl_docs).
_OWL_VERSION_RE = re.compile(r'version = "(\d+)\.[^"]*"')
_OWL_HASH_RE = re.compile(r'hash:\s*"([0-9a-f]+)"')


def is_base_branch(name: str | None) -> bool:
    """Whether <name> IS a base branch (exact match — master-foo is a work branch)."""
    return bool(_BASE_BRANCH_RE.fullmatch(name or ""))


_GITHUB_REMOTE_RE = re.compile(r"github\.com(?::\d+)?[:/]+([^/]+)/(.+?)(?:\.git)?/?$")


def parse_github_slug(url: str | None) -> str | None:
    """The "owner/repo" GitHub slug a remote URL points to (SSH, HTTPS, or
    ssh:// forms), or None if it's not a github.com URL. A repo's push remote
    can be a fork under a different owner — and even a differently-renamed
    repo — than its `github` (upstream) slug, so this is resolved from the
    remote's actual URL rather than assumed."""
    m = _GITHUB_REMOTE_RE.search(url or "")
    return f"{m.group(1)}/{m.group(2)}" if m else None


class GitService:
    """Local git operations on the user's repos, over the IO seam. Branch reads are
    volatile (dirty / current-branch state) and fast, so they're not cached — callers
    fetch fresh each time. `notify` (optional) reports progress events (the fetch /
    rebase phases) — wired to the event bus in production, a no-op in tests."""

    def __init__(self, io: Any, notify: Callable[..., None] | None = None) -> None:
        self.io = io
        self.notify = notify or (lambda *a, **k: None)

    def _git(
        self,
        path: str,
        *args: str,
        timeout: float = 30,
        err: str = "git failed",
        quiet: bool = False,
        tail: bool = False,
    ) -> tuple[subprocess.CompletedProcess[str] | None, str | None]:
        """Run one git command in <path> (expanduser'd). Returns (result, error):
        error is None on success, else the first stderr line (or <err> when git
        was silent), or the FileNotFoundError/TimeoutExpired message — the shared
        failure envelope every simple mutation used to hand-roll. `tail` reports
        the LAST stderr line instead (push errors put the useful hint there).
        On a nonzero exit the result is still returned so callers can inspect
        the raw stderr (e.g. delete_branch's "remote ref does not exist")."""
        try:
            r = self.io.run(
                ["git", "-C", os.path.expanduser(path), *args], timeout=timeout, quiet=quiet
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return None, str(e)
        if r.returncode != 0:
            lines = r.stderr.strip().split("\n")
            return r, (lines[-1] if tail else lines[0]) or err
        return r, None

    def current_branch(self, path: str) -> str:
        """The branch currently checked out at <path> ("" if detached/unreadable).
        A lightweight single-subprocess alternative to branches() for callers that
        only need the current branch name (e.g. the headless Claude chat, which
        needs it on every fresh conversation and shouldn't pay for the full
        dirty/ahead-behind/remote-refs read)."""
        r, error = self._git(path, "branch", "--show-current", timeout=10)
        return "" if error or r is None else (r.stdout or "").strip()

    def branches(self, repos: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """For each repo {id, path}: the checked-out branch and all local branches
        with their last-commit date, plus dirty / pushed / ahead-behind state and
        the push remote's resolved "owner/repo" (push_github, None if the remote
        is missing/unparseable). Each repo's git reads (~8 subprocesses) are
        independent, so repos are read in parallel — keeping a multi-repo target's
        refresh snappy."""
        valid = [r for r in repos if r.get("id") and r.get("path")]
        if not valid:
            return []

        def one(repo: dict[str, Any]) -> dict[str, Any]:
            rid = repo.get("id")
            path = os.path.expanduser(repo.get("path", ""))
            entry = {
                "id": rid,
                "current": None,
                "dirty": False,
                "head_subject": "",
                "head_date": "",
                "head_sha": "",  # HEAD commit sha
                "head_pushed": False,  # HEAD is reachable from some remote (so linkable)
                "head_remote": False,  # the current branch has a remote-tracking ref
                "ahead": 0,  # current branch commits not on its base (target) branch
                "behind": 0,  # base branch commits not on the current branch
                "branches": [],
                "push_github": None,  # "owner/repo" the push remote's URL actually points to
                "error": None,
            }
            try:
                r = self.io.run(["git", "-C", path, "branch", "--show-current"], timeout=10)
                if r.returncode != 0:
                    entry["error"] = r.stderr.strip().split("\n")[0] or "not a git repository"
                    return entry
                entry["current"] = r.stdout.strip() or "(detached)"
                # uncommitted changes in the working tree (only the current branch)
                st = self.io.run(["git", "-C", path, "status", "--porcelain"], timeout=10)
                entry["dirty"] = bool(st.stdout.strip())
                # the push remote's actual fork owner/repo — a repo's fork can live
                # under a different GitHub owner (or even a renamed repo) than its
                # upstream `github` slug, and that can vary independently per repo
                # (e.g. one repo forked under a personal username, another under a
                # team org), so it's resolved from the remote itself, not assumed
                push_remote = repo.get("push_remote") or "dev"
                pu = self.io.run(
                    ["git", "-C", path, "remote", "get-url", push_remote], timeout=10, quiet=True
                )
                if pu.returncode == 0:
                    entry["push_github"] = parse_github_slug(pu.stdout.strip())
                # HEAD's sha + last commit subject + date (for the branch summaries)
                hl = self.io.run(
                    ["git", "-C", path, "log", "-1", "--format=%H%n%s%n%cI"], timeout=10
                )
                if hl.returncode == 0:
                    lines = hl.stdout.splitlines()
                    entry["head_sha"] = lines[0] if lines else ""
                    entry["head_subject"] = lines[1] if len(lines) > 1 else ""
                    entry["head_date"] = lines[2] if len(lines) > 2 else ""
                # is HEAD reachable from any remote ref? (i.e. pushed -> linkable)
                rp = self.io.run(
                    ["git", "-C", path, "rev-list", "HEAD", "--not", "--remotes", "--count"],
                    timeout=10,
                )
                if rp.returncode == 0:
                    entry["head_pushed"] = rp.stdout.strip() == "0"
                # how far the current branch diverges from its canonical base (the
                # "target" it would rebase onto), e.g. master-owl-update vs origin/master
                base = base_branch(entry["current"])
                ref = f"{repo.get('pull_remote') or 'origin'}/{base}"
                # quiet: the base ref may not be fetched locally (→ "bad revision"); that's
                # expected, we just leave ahead/behind at 0 rather than log every refresh
                ad = self.io.run(
                    ["git", "-C", path, "rev-list", "--left-right", "--count", f"{ref}...HEAD"],
                    timeout=10,
                    quiet=True,
                )
                if ad.returncode == 0 and len(ad.stdout.split()) == 2:
                    behind, ahead = ad.stdout.split()
                    entry["behind"], entry["ahead"] = int(behind), int(ahead)
                # remote-tracking refs: the branch names (pushed from this clone at
                # some point) and the sha each ref points at. The sha lets a branch
                # tell whether its local tip is actually what's on the remote — a
                # stale same-named ref (e.g. an ancient dev/<branch> whose name got
                # reused for fresh, unpushed local work) is present but NOT in sync.
                rr = self.io.run(
                    [
                        "git",
                        "-C",
                        path,
                        "for-each-ref",
                        "refs/remotes",
                        "--format=%(refname:lstrip=3)%09%(objectname)",
                    ],
                    timeout=10,
                )
                remote_branches = set()
                remote_shas = {}  # branch name -> {sha, …} across remotes
                for line in rr.stdout.splitlines():
                    parts = line.split("\t")
                    nm = parts[0]
                    if not nm:
                        continue
                    remote_branches.add(nm)
                    if len(parts) > 1:
                        remote_shas.setdefault(nm, set()).add(parts[1])
                entry["head_remote"] = entry["current"] in remote_branches
                r = self.io.run(
                    [
                        "git",
                        "-C",
                        path,
                        "for-each-ref",
                        "refs/heads",
                        "--format=%(refname:short)%09%(committerdate:iso8601-strict)%09%(contents:subject)%09%(objectname)",
                    ],
                    timeout=10,
                )
                for line in r.stdout.splitlines():
                    parts = line.split("\t")
                    name = parts[0]
                    if name:
                        sha = parts[3] if len(parts) > 3 else ""
                        entry["branches"].append(
                            {
                                "name": name,
                                "date": parts[1] if len(parts) > 1 else "",
                                "subject": parts[2] if len(parts) > 2 else "",
                                "sha": sha,
                                "remote": name in remote_branches,
                                # local tip == a same-named remote ref (truly pushed
                                # and current, not just a stale ref of the same name)
                                "synced": bool(sha) and sha in remote_shas.get(name, ()),
                            }
                        )
            except (FileNotFoundError, subprocess.TimeoutExpired) as e:
                entry["error"] = str(e)
            return entry

        with ThreadPoolExecutor(max_workers=min(8, len(valid))) as pool:
            return list(pool.map(one, valid))

    def checkout(
        self, path: str | None, branch: str | None, repo: str | None = ""
    ) -> tuple[bool, str | None]:
        """Checkout a local branch in a repo. Returns (ok, error). Announced as a
        timed event via notify so the browser shows a live "..." that resolves to
        "ok"/"failed"."""
        if not path or not branch:
            return False, "missing path or branch"
        label = repo or os.path.basename(os.path.expanduser(path))
        eid = uuid.uuid4().hex
        checking = f"checking out {branch} ({label})"
        self.notify(checking, event_id=eid, status="start")
        _, error = self._git(path, "checkout", branch, timeout=60, err="git checkout failed")
        self.notify(checking, event_id=eid, status="error" if error else "done")
        return error is None, error

    def fresh_start_point(
        self, path: str, branch: str | None, pull_remote: str | None = "origin", repo: str = ""
    ) -> tuple[str | None, str | None]:
        """Resolve a workspace branch's start point. If the configured pull remote
        has <branch>, fetch it and return FETCH_HEAD so branch/worktree creation
        starts from the freshly fetched commit. If the branch is local-only, return
        its local name unchanged. A remote lookup/fetch error is not silently treated
        as local-only: doing so could create a workspace from stale local state."""
        if not path or not branch:
            return None, "missing path or start point"
        p = os.path.expanduser(path)
        remote = pull_remote or "origin"
        label = repo or os.path.basename(p)
        self.io.log_request(f"git ls-remote {remote} {branch}  (workspace base {label})")
        try:
            exists = self.io.run(
                ["git", "-C", p, "ls-remote", "--exit-code", "--heads", remote, branch],
                timeout=30,
                quiet=True,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return None, str(e)
        # --exit-code uses 2 for a successful query with no matching refs: this is
        # the expected local-only branch case.
        if exists.returncode == 2 or (exists.returncode == 0 and not exists.stdout.strip()):
            return branch, None
        if exists.returncode != 0:
            return None, (exists.stderr.strip() or "remote branch lookup failed").split("\n")[0]

        eid = uuid.uuid4().hex
        fetching = f"fetching {branch} ({label})"
        self.notify(fetching, event_id=eid, status="start")
        _, error = self._git(p, "fetch", remote, branch, timeout=180, err="git fetch failed")
        self.notify(fetching, event_id=eid, status="error" if error else "done")
        return (None, error) if error else ("FETCH_HEAD", None)

    def worktree_add(
        self,
        main_path: str,
        worktree_path: str,
        branch: str,
        repo: str = "",
        new_branch: bool = False,
        start_point: str | None = None,
        fresh_start: bool = False,
        pull_remote: str | None = "origin",
    ) -> tuple[bool, str | None]:
        """Add a git worktree at <worktree_path>, linked to the repo at <main_path>
        (sharing its .git); git creates intermediate dirs. With new_branch, create
        <branch> at <start_point> in the new worktree (git worktree add -b) — the
        usual case, since a branch already checked out in the main tree can't be
        checked out again elsewhere. Otherwise attach the existing <branch>. Returns
        (ok, error). Announced as a timed event via notify."""
        if not main_path or not worktree_path or not branch:
            return False, "missing path, worktree path or branch"
        if new_branch and not start_point:
            return False, "missing start point for the new branch"
        p = os.path.expanduser(main_path)
        base = start_point
        if new_branch and fresh_start:
            start_point, error = self.fresh_start_point(p, start_point, pull_remote, repo)
            if error:
                return False, error
        wp = os.path.expanduser(worktree_path)
        label = repo or os.path.basename(p)
        eid = uuid.uuid4().hex
        creating = f"creating worktree {branch} ({label})"
        self.notify(creating, event_id=eid, status="start")
        if new_branch:
            args = ["worktree", "add", "-b", branch, wp, start_point]
        else:
            args = ["worktree", "add", wp, branch]
        _, error = self._git(p, *args, timeout=120, err="git worktree add failed")
        if not error and start_point == "FETCH_HEAD":
            # forked from a freshly fetched remote base: FETCH_HEAD isn't a
            # remote-tracking ref, so git sets no upstream and a bare `git pull`
            # fails — track <pull_remote>/<base> so it pulls the base in. Written as
            # config (not --set-upstream-to) so it doesn't need refs/remotes/<base>.
            remote = pull_remote or "origin"
            self._git(p, "config", f"branch.{branch}.remote", remote)
            self._git(p, "config", f"branch.{branch}.merge", f"refs/heads/{base}")
        self.notify(creating, event_id=eid, status="error" if error else "done")
        return error is None, error

    def create_worktree_claude_md(
        self,
        worktree_parent: str,
        branch: str,
        has_enterprise: bool,
        documentation_path: str | None = None,
        owl_path: str | None = None,
    ) -> None:
        """Create a .claude/CLAUDE.md file at the worktree's parent dir for Claude Code
        context — outside any git-tracked repo (<worktree_dir>/<slug>/.claude/CLAUDE.md,
        <worktree_dir>/<slug>/{community,enterprise,documentation,owl}/ are its
        siblings). Called once, explicitly, after every repo in the workspace has been
        created (server.py's _api_workspace_create) — so has_enterprise/
        documentation_path/owl_path are known for certain rather than guessed."""
        claude_md_path = os.path.join(worktree_parent, ".claude", "CLAUDE.md")
        if self.io.read_text(claude_md_path) is not None:
            return
        self.io.write_text(
            claude_md_path,
            self._claude_md_content(branch, has_enterprise, documentation_path, owl_path),
        )

    def _claude_md_content(
        self,
        branch: str,
        has_enterprise: bool,
        documentation_path: str | None = None,
        owl_path: str | None = None,
    ) -> str:
        repo_lines = [
            "- `community/` — an independent `git worktree` checkout of odoo/odoo, on "
            f"branch **{branch}**. It shares git history/objects with the main checkout "
            "but is its own working tree — commits, checkouts, and file edits here "
            "don't touch the main one.",
        ]
        if has_enterprise:
            repo_lines.append(
                f"- `enterprise/` — same, for odoo/enterprise, on branch **{branch}**."
            )
        if documentation_path:
            repo_lines.append(
                f"- `documentation/` — same, for odoo/documentation, forked from "
                f"**{base_branch(branch)}** (not `{branch}` — the doc repo doesn't have "
                "per-feature branches). The skills below read it directly from disk, no "
                "network fetch needed; `git pull --rebase` it here if the docs feel stale."
            )
        if owl_path:
            repo_lines.append(
                "- `owl/` — same, for odoo/owl, forked from the exact commit vendored at "
                "`community/addons/web/static/lib/owl/owl.js` (odoo/owl's `master` branch "
                "when that exact commit wasn't locally reachable). The frontend skill "
                "reads it directly from disk too."
            )
        repos_section = "\n".join(repo_lines)
        return f"""# Odoo Development Worktree

This worktree is checked out on branch **{branch}**.

## About this worktree

This worktree was created from the main development repository. Use Claude Code here
for development tasks, debugging, refactoring, and code review.

## Repos in this worktree

{repos_section}

## Database

Local Postgres, direct access with `psql <dbname>` (peer auth — no user/password
needed for the standard local dev setup). By convention in this app the database is
named after the branch/workspace (**{branch}**), but it's a free-text field the user
could have changed — check goo's Workspaces screen if unsure, or `psql -l`.

## Running the server / tests

An `odoo.conf` already sits one level up (`../odoo.conf`), generated at creation
with this workspace's real `addons_path` and db role — no need to reconstruct
`--addons-path` by hand. From `community/`:

```bash
./odoo-bin -c ../odoo.conf -d <dbname> --without-demo all
```

Default port is 8069 — add `--http-port <N>` if something else (goo's main server,
another workspace) is already using it.

Run a specific test:

```bash
./odoo-bin -c ../odoo.conf -d <dbname> --test-tags /module_name --dev all --stop-after-init
```

(`--dev all` enables dev features — asset reload/qweb/xml — matching what goo itself
passes for test runs; JS/hoot tests need Chrome on PATH.) If goo is running, its
Workspaces screen's Start button remains the simplest path.

## Key Claude Code skills for Odoo development

Project skills (generated for this worktree, in `.claude/skills/` — version-matched
to branch {branch}):

- **`/odoo-orm`** — models, fields, ORM methods, security, module manifests, mixins,
  HTTP controllers.
- **`/odoo-views`** — view XML (form/list/kanban/search), actions, qweb reports.
- **`/odoo-frontend-owl`** — the JS framework layer (services, registries, hooks,
  assets) and the Owl component framework itself.
- **`/odoo-testing`** — Python tests (TransactionCase/HttpCase/tours) and JS unit
  tests (hoot).

Other useful (user-level) skills:

- **`/run`** — Start the Odoo application to test changes in real-time. Use this before
  submitting PRs to verify the UI works as expected.
- **`/simplify`** — Review and optimize your code changes for reuse and efficiency.
- **`/security-review`** — Complete a security review of pending changes on this branch.
- **`/check-commit`** — Validate commit messages against Odoo Git guidelines before pushing.

## Development workflow

1. **Branch work** — Make your changes in this worktree
2. **Test locally** — Use `/run` to start the app and verify behavior
3. **Code review** — Use `/simplify` and `/security-review` to audit changes
4. **Commit & push** — Use `/check-commit` to ensure your commit message is compliant

## Browser & memory debugging (MCP)

If the `chrome-devtools` and `memlab` MCP servers are configured (`claude mcp list`),
prefer them over guessing at UI/memory behavior from the code alone:

- **`chrome-devtools`** — drive a real Chrome against the running Odoo instance to
  click through the UI, take snapshots/screenshots, and read console/network output.
- **`memlab`** — analyze heap snapshots for memory leaks (pairs with `/leak-check`
  and the `memleak_check` addon).

If `chrome-devtools` fails to connect ("Could not connect to Chrome" / "Target
closed"), it's likely pinned to a fixed `--browserUrl` expecting an
already-running debuggable Chrome, or the sandbox here can't launch Chrome with
its default sandbox. Reconfigure it to launch its own headless browser instead:
`claude mcp remove chrome-devtools -s user`, then `claude mcp add chrome-devtools
-s user -- <command from the old config> --headless --isolated
--chromeArg=--no-sandbox --chromeArg=--disable-setuid-sandbox` (drop any
`--browserUrl`/`--wsEndpoint` arg). Editing the MCP config only takes effect after
Claude Code restarts.

---

*This file was auto-generated. Feel free to edit it.*
"""

    def _resolve_owl_docs(self, community_path: str) -> tuple[str, str, str]:
        """(ref, doc_base_path, major) to fetch odoo/owl docs matching the Owl build
        actually vendored at <community_path>/addons/web/static/lib/owl/owl.js — the
        bundle exports a literal `version = "X.Y.Z..."` plus `__info__.hash` (a short
        commit sha). Tries the exact vendored commit first (perfect API match, no
        drift from an alpha framework's fast-moving master), then odoo/owl's own
        master branch (current doc/v{2,3}/... layout) for the matching major version.
        A canary file fetch decides each candidate: raw.githubusercontent.com 404s
        for a ref/layout that doesn't exist (e.g. old commits predate the v2/v3 doc
        split, and some alpha-build hashes aren't reachable on the public mirror at
        all)."""
        owl_js = (
            self.io.read_text(os.path.join(community_path, "addons/web/static/lib/owl/owl.js"))
            or ""
        )
        v_match = _OWL_VERSION_RE.search(owl_js)
        major = v_match.group(1) if v_match else "2"  # undetectable -> assume the long-stable v2
        h_match = _OWL_HASH_RE.search(owl_js)
        versioned_path = "doc/v3/owl/reference" if major == "3" else "doc/v2/reference"
        candidates = []
        if h_match:
            h = h_match.group(1)
            if major != "3":
                candidates.append((h, "doc/reference"))  # pre-v2/v3-split layout
            candidates.append((h, versioned_path))
        candidates.append(("master", versioned_path))  # always-good fallback
        for ref, path in candidates:
            text, error = self.io.http_get(
                f"https://raw.githubusercontent.com/odoo/owl/{ref}/{path}/component.md"
            )
            if not error and text:
                return ref, path, major
        return "master", versioned_path, major

    def resolve_owl_worktree_start(
        self, community_path: str, owl_main_path: str, pull_remote: str | None = "origin"
    ) -> str:
        """The odoo/owl ref to fork an owl worktree from, matching the Owl build
        actually vendored at <community_path> (an already-created worktree — this is
        called after community's own worktree_add, once its owl.js is real). Returns
        the exact vendored commit if it's reachable, else "master" — same fallback
        rationale as _resolve_owl_docs's remote lookup (some alpha-build hashes
        aren't reachable at all, e.g. built from a commit never pushed publicly).
        Checked in two steps: the LOCAL owl clone's object store first (free), then
        an explicit `git fetch <remote> <commit>` (most hosts, GitHub included,
        allow fetching by sha when it's reachable there — this catches a commit
        that's genuinely available upstream but predates however much history the
        local clone happens to have fetched so far)."""
        owl_js = (
            self.io.read_text(os.path.join(community_path, "addons/web/static/lib/owl/owl.js"))
            or ""
        )
        h_match = _OWL_HASH_RE.search(owl_js)
        if not h_match:
            return "master"
        commit = h_match.group(1)
        _, error = self._git(owl_main_path, "cat-file", "-e", commit, timeout=10, quiet=True)
        if error:
            _, error = self._git(
                owl_main_path, "fetch", pull_remote or "origin", commit, timeout=30, quiet=True
            )
        return commit if not error else "master"

    def create_worktree_skills(
        self,
        community_path: str,
        worktree_parent: str,
        branch: str,
        documentation_path: str | None = None,
        owl_path: str | None = None,
    ) -> None:
        """Create the .claude/skills/ Odoo-dev skills at the worktree's parent dir
        (alongside .claude/CLAUDE.md — see create_worktree_claude_md), one per domain,
        each pointing at documentation matched to this worktree's Odoo version (and,
        for the frontend skill, its exact vendored Owl build) — read locally from
        <documentation_path>/<owl_path> when the workspace has those checkouts (see
        create_worktree_claude_md's sibling note), else fetched from
        raw.githubusercontent.com. Called once, explicitly, from server.py after every
        repo in the workspace has been created."""
        skills_dir = os.path.join(worktree_parent, ".claude", "skills")
        marker = os.path.join(skills_dir, "odoo-orm", "SKILL.md")
        if self.io.read_text(marker) is not None:
            return
        contents = self._skill_contents(community_path, branch, documentation_path, owl_path)
        for slug, files in contents.items():
            for rel_path, content in files.items():
                self.io.write_text(os.path.join(skills_dir, slug, rel_path), content)

    def _owl_local_layout(self, owl_path: str, major: str) -> str:
        """Which on-disk doc/ layout an owl worktree checkout actually has — probed
        directly (the checkout is real, so there's no need to guess/retry like
        _resolve_owl_docs's remote canary-fetch does): the pre-v2/v3-split flat
        layout (older commits), or the newer doc/v{2,3}/... split."""
        split = f"doc/v{major}/owl/reference" if major == "3" else f"doc/v{major}/reference"
        if self.io.is_dir(os.path.join(owl_path, "doc", "reference")):
            return "doc/reference"
        return split

    def _skill_contents(
        self,
        community_path: str,
        branch: str,
        documentation_path: str | None = None,
        owl_path: str | None = None,
    ) -> dict[str, dict[str, str]]:
        """{slug: full SKILL.md content (frontmatter + body)} for the four Odoo-dev
        skills, version-matched to <branch> (and, for odoo-frontend-owl, the Owl
        build actually vendored at <community_path>). Odoo/Owl doc references read
        <documentation_path>/<owl_path> directly (local worktree checkouts — see
        create_worktree_claude_md) when given, else fall back to
        raw.githubusercontent.com/gh api at <branch>'s/the vendored build's matching
        doc-repo ref."""
        doc_branch = base_branch(branch)
        if documentation_path:
            doc_base = f"{documentation_path}/content/developer"
            doc_fetch = "Read the file directly"

            def doc_browse(subdir: str) -> str:
                return f"`find {documentation_path}/content/developer/{subdir} -type f`"
        else:
            doc_base = f"https://raw.githubusercontent.com/odoo/documentation/{doc_branch}/content/developer"
            doc_fetch = "WebFetch the raw URL"

            def doc_browse(subdir: str) -> str:
                return (
                    f"`gh api repos/odoo/documentation/contents/content/developer/"
                    f"{subdir}?ref={doc_branch}`"
                )

        if owl_path:
            v_match = _OWL_VERSION_RE.search(
                self.io.read_text(os.path.join(community_path, "addons/web/static/lib/owl/owl.js"))
                or ""
            )
            major = v_match.group(1) if v_match else "2"
            owl_layout = self._owl_local_layout(owl_path, major)
            owl_base = f"{owl_path}/{owl_layout}"
            owl_pin_note = "checked out locally in `owl/` — always exactly matches what's vendored"
            owl_key_files = f"Read the file directly, e.g. `{owl_base}/component.md`"
            owl_browse = f"`find {owl_path}/{owl_layout} -type f`"
        else:
            owl_ref, owl_doc_path, major = self._resolve_owl_docs(community_path)
            owl_pinned = owl_ref != "master"
            owl_base = f"https://raw.githubusercontent.com/odoo/owl/{owl_ref}/{owl_doc_path}"
            owl_pin_note = (
                f"pinned to the exact vendored commit `{owl_ref}`"
                if owl_pinned
                else "exact commit docs weren't reachable — using odoo/owl's master branch "
                f"instead, latest v{major} docs"
            )
            owl_key_files = f"WebFetch the raw URL, e.g. `{owl_base}/component.md`"
            owl_browse = f"`gh api repos/odoo/owl/contents/{owl_doc_path}?ref={owl_ref}`"

        skills = {
            "odoo-orm": (
                "Use when writing or editing Odoo backend Python code: models, fields, "
                "compute/onchange/constrain methods, recordsets, the environment, "
                "security (ir.model.access.csv, record rules), module manifests, "
                "mixins, data files, or HTTP controllers/routing.",
                f"""# Odoo ORM & backend reference (branch: {doc_branch})

This worktree targets Odoo **{doc_branch}**. The ORM API, security model, and
manifest format change across versions — prefer these version-matched docs over
general/training knowledge.

Base URL: `{doc_base}/`

Key files ({doc_fetch}):
- `reference/backend/orm.rst` — fields, recordsets, environment, ORM methods
- `reference/backend/security.rst` — ACL, record rules, groups
- `reference/backend/module.rst` — manifest format, module structure
- `reference/backend/mixins.rst` — mail.thread and other mixins
- `reference/backend/data.rst` — data/demo XML/CSV files
- `reference/backend/http.rst` — controllers, routing, JSON-RPC
- `reference/backend/actions.rst` — server actions, window actions
- `reference/backend/performance.rst` — batching, prefetching, N+1 pitfalls
- `tutorials/server_framework_101.rst` (+ numbered chapters 01_ to 15_ under
  `tutorials/server_framework_101/`) — the guided from-scratch walkthrough

Not listed above? Browse the directory: {doc_browse("reference/backend")}
""",
            ),
            "odoo-views": (
                "Use when writing or editing Odoo view XML (form/list/kanban/search), "
                "window actions, menus, or qweb PDF reports.",
                f"""# Odoo views, actions & reports reference (branch: {doc_branch})

This worktree targets Odoo **{doc_branch}**. View architecture and attributes change
across versions — prefer these version-matched docs over general/training knowledge.

Base URL: `{doc_base}/`

Key files ({doc_fetch}):
- `reference/backend/actions.rst` — window/server actions, menus
- `reference/backend/reports.rst` — qweb PDF reports
- `reference/user_interface/view_architectures.rst` — view XML attributes reference
- `reference/user_interface/view_records.rst` — <record> declarations for views
- `reference/user_interface/icons.rst` — icon widgets/classes

Not listed above? Browse the directories:
{doc_browse("reference/user_interface")}
{doc_browse("reference/user_interface/view_architectures")}
(the latter has one short file per view attribute)
""",
            ),
            "odoo-frontend-owl": (
                "Use when writing or editing Odoo frontend JS: Owl components, "
                "services, registries, hooks, assets bundling, qweb templates, or "
                "patching existing code.",
                f"""# Odoo frontend & Owl framework reference (branch: {doc_branch})

This worktree targets Odoo **{doc_branch}**, which vendors Owl **major v{major}**
({owl_pin_note}).
Owl's API differs significantly between v2 and v3 (v3 is still alpha and fast-moving)
— prefer these version-matched docs over general/training knowledge.

## Odoo's frontend layer
Base URL: `{doc_base}/reference/frontend/`

Key files ({doc_fetch}):
- `framework_overview.rst` — how the pieces fit together
- `owl_components.rst` — Odoo-specific Owl conventions
- `services.rst` — the service layer (registry, useService)
- `registries.rst` — fields/views/actions registries
- `hooks.rst` — Odoo's own hooks on top of Owl's
- `assets.rst` — bundles, asset targets
- `qweb.rst` — template directives
- `patching_code.rst` — patch()/the monkey-patch helper
- `javascript_modules.rst` — module system (`/** @odoo-module **/`)
- `unit_testing/{{hoot,mock_server,web_helpers}}.rst` — JS unit tests (hoot)

Not listed above? Browse: {doc_browse("reference/frontend")}

## The Owl framework itself
Base URL: `{owl_base}/`

Key files ({owl_key_files}): `component.md`,
`hooks.md`, `props.md`, `reactivity.md`, `slots.md`, `event_handling.md`,
`error_handling.md`, `app.md`, `refs.md`, `concurrency_model.md`.

Not listed above (v3 adds several concepts v2 doesn't have — signals, effects,
resources, plugins, scope, proxies, error boundaries)? Browse: {owl_browse}
""",
            ),
            "odoo-testing": (
                "Use when writing or debugging Odoo tests: Python TransactionCase/"
                "HttpCase/tours, or JS unit tests (hoot).",
                f"""# Odoo testing reference (branch: {doc_branch})

This worktree targets Odoo **{doc_branch}**. Prefer these version-matched docs over
general/training knowledge.

Base URL: `{doc_base}/`

Key files ({doc_fetch}):
- `reference/backend/testing.rst` — TransactionCase, HttpCase, tours, tags
- `reference/frontend/unit_testing/hoot.rst` — the hoot JS test runner
- `reference/frontend/unit_testing/mock_server.rst` — mocking RPCs in JS tests
- `reference/frontend/unit_testing/web_helpers.rst` — DOM/query test helpers
- `tutorials/unit_tests.rst` — guided walkthrough

Not listed above? Browse: {doc_browse("reference/backend/testing")}
""",
            ),
        }

        result = {
            slug: {"SKILL.md": f"---\nname: {slug}\ndescription: '{description}'\n---\n\n{body}"}
            for slug, (description, body) in skills.items()
        }
        result["odoo-memory-perf"] = self._memory_perf_skill_files()
        result["odoo-bootstrap-leak-audit"] = self._bootstrap_leak_audit_skill_files()
        result["odoo-leak-bisect"] = self._leak_bisect_skill_files()
        return result

    def _memory_perf_skill_files(self) -> dict[str, str]:
        """{relative_path: content} for the odoo-memory-perf skill — unlike the
        four doc-reference skills above, this one is a runnable tool (empirical
        heap-diff memory check via memlab + an existing Odoo tour), bundled with
        its own scripts rather than pointing at documentation."""
        return {
            "SKILL.md": _template("odoo-memory-perf/SKILL.md"),
            "scripts/run_check.sh": _template("odoo-memory-perf/scripts/run_check.sh"),
        }

    def _bootstrap_leak_audit_skill_files(self) -> dict[str, str]:
        """{relative_path: content} for the odoo-bootstrap-leak-audit skill — a
        *static* grep-and-read methodology for one specific, recurring,
        already-proven memory-leak anti-pattern in Odoo's JS: a vendored
        Bootstrap 5 component instance created without a matching .dispose()
        call. Complements odoo-memory-perf's *empirical* heap-diff approach:
        this finds candidate sites by pattern-matching code; that one confirms
        and quantifies a specific site by actually running it and diffing heap
        snapshots. The mechanism below was verified against a real checkout's
        vendored addons/web/static/lib/bootstrap/js/dist/{dom/data.js,
        base-component.js} before being written up here."""
        return {
            "SKILL.md": _template("odoo-bootstrap-leak-audit/SKILL.md"),
        }

    def _leak_bisect_skill_files(self) -> dict[str, str]:
        """{relative_path: content} for the odoo-leak-bisect skill — a from-scratch
        methodology for bisecting a JS memory leak reported on CI/runbot down to the
        introducing commit, for when neither the goo `memleak_check` addon nor a
        `chrome-devtools` MCP connection is available (a bare/sandboxed checkout):
        reads runbot's own hoot `[MEMINFO]` log lines first, then (if a local repro
        is needed) drives headless Chrome over raw CDP via the bundled
        `heapcheck_cdp.py` to reproduce the same per-suite memory curve locally.
        Complements odoo-memory-perf (which needs the addon + a live goo workspace)
        and odoo-bootstrap-leak-audit (a different, unrelated leak pattern)."""
        return {
            "SKILL.md": _template("odoo-leak-bisect/SKILL.md"),
            "scripts/heapcheck_cdp.py": _template("odoo-leak-bisect/scripts/heapcheck_cdp.py"),
        }

    def write_dev_context(self, out_dir: str, community_path: str, branch: str) -> None:
        """Materialize the Odoo-dev CLAUDE.md + skills straight into <out_dir>/.claude/
        (no existence guard — meant for a fresh, throwaway directory, e.g. the headless
        Claude chat's per-conversation temp dir). Unlike the persisted worktree copy
        (create_worktree_claude_md/create_worktree_skills, generated once at worktree
        creation), this always reflects goo's current skill templates and <branch>'s
        current state — and works for a main-located checkout too, which has no
        worktree parent dir of its own to persist into. Detects (but never creates)
        enterprise/documentation/owl siblings next to <community_path> — present for
        a worktree-based target created via the auto-fork flow, absent otherwise."""
        parent = os.path.dirname(community_path)
        has_enterprise = self.io.is_dir(os.path.join(parent, "enterprise"))

        def sibling_or_none(name: str) -> str | None:
            path = os.path.join(parent, name)
            return path if self.io.is_dir(path) else None

        documentation_path = sibling_or_none("documentation")
        owl_path = sibling_or_none("owl")
        self.io.write_text(
            os.path.join(out_dir, ".claude", "CLAUDE.md"),
            self._claude_md_content(branch, has_enterprise, documentation_path, owl_path),
        )
        contents = self._skill_contents(community_path, branch, documentation_path, owl_path)
        for slug, files in contents.items():
            for rel_path, content in files.items():
                self.io.write_text(
                    os.path.join(out_dir, ".claude", "skills", slug, rel_path), content
                )

    def write_odoo_conf(
        self, worktree_parent: str, addons_path: str, db_user: str, db_password: str
    ) -> None:
        """Write a ready-to-use odoo.conf at the worktree root (sibling to
        community/enterprise, alongside .claude/ — see create_worktree_claude_md), so
        `./odoo-bin -c ../odoo.conf -d <db>` just works from within community/ without
        hand-reconstructing --addons-path. Only if absent — like its .claude/ siblings,
        never overwritten (the caller may have edited it)."""
        path = os.path.join(worktree_parent, "odoo.conf")
        if self.io.read_text(path) is not None:
            return
        self.io.write_text(
            path,
            "[options]\n"
            "; auto-generated by goo — feel free to edit\n"
            f"addons_path = {addons_path}\n"
            f"db_user = {db_user}\n"
            f"db_password = {db_password}\n",
        )

    def worktree_remove(
        self, main_path: str, worktree_path: str, repo: str = ""
    ) -> tuple[bool, str | None]:
        """Remove the git worktree at <worktree_path> (--force, so it goes even with
        local changes or a running server). Returns (ok, error). Timed event."""
        if not main_path or not worktree_path:
            return False, "missing path or worktree path"
        p = os.path.expanduser(main_path)
        wp = os.path.expanduser(worktree_path)
        label = repo or os.path.basename(p)
        eid = uuid.uuid4().hex
        removing = f"removing worktree ({label})"
        self.notify(removing, event_id=eid, status="start")
        _, error = self._git(
            p, "worktree", "remove", "--force", wp, timeout=60, err="git worktree remove failed"
        )
        self.notify(removing, event_id=eid, status="error" if error else "done")
        return error is None, error

    def create_branch(
        self,
        path: str | None,
        name: str | None,
        start_point: str | None,
        fresh_start: bool = False,
        pull_remote: str | None = "origin",
        repo: str = "",
    ) -> tuple[bool, str | None]:
        """Create a new local branch <name> at <start_point> WITHOUT checking it
        out (working tree / current branch untouched). Returns (ok, error)."""
        if not path or not name or not start_point:
            return False, "missing path, name or start point"
        if fresh_start:
            start_point, error = self.fresh_start_point(path, start_point, pull_remote, repo)
            if error:
                return False, error
            assert start_point is not None  # fresh_start_point: no error => a start point
        _, error = self._git(path, "branch", name, start_point, timeout=10, err="git branch failed")
        return error is None, error

    def delete_branch(
        self, path: str, branch: str, delete_remote: bool = False, push_remote: str | None = "dev"
    ) -> tuple[bool, str | None, str | None]:
        """Force-delete a local branch, and optionally its branch on the configured
        push remote too. Returns (ok, error, remote_error): the first two are for the
        local delete; remote_error is set when the local delete succeeded but the
        remote branch could not be removed (None otherwise)."""
        _, error = self._git(path, "branch", "-D", branch, timeout=10, err="git branch -D failed")
        if error:
            return False, error, None
        remote_error = None
        if delete_remote:
            if is_base_branch(branch):
                return True, None, f"refusing to delete base branch {branch} on the remote"
            # delete straight away — no `ls-remote` pre-check (a round-trip per branch).
            # If the branch was never pushed, git fails with "remote ref does not
            # exist", which we treat as success: there was nothing to remove.
            remote = push_remote or "dev"
            self.io.log_request(f"git push {remote} --delete {branch}")
            r, remote_error = self._git(
                path,
                "push",
                remote,
                "--delete",
                branch,
                timeout=120,
                err="git push --delete failed",
                tail=True,
            )
            if remote_error and r is not None and "remote ref does not exist" in r.stderr:
                remote_error = None
        return True, None, remote_error

    def commit(self, path: str, message: str) -> tuple[bool, str | None]:
        """Stage all changes and create a commit with the given message. Returns
        (ok, error)."""
        _, error = self._git(path, "add", "-A", err="git add failed")
        if error:
            return False, error
        _, error = self._git(path, "commit", "--no-verify", "-m", message, err="git commit failed")
        return error is None, error

    def wip_commit(self, path: str) -> tuple[bool, str | None]:
        """Stage all changes and create a WIP commit. Returns (ok, error)."""
        return self.commit(path, "[WIP]")

    def amend_commit(self, path: str, message: str) -> tuple[bool, str | None]:
        """Stage all changes and fold them into the HEAD commit with the given
        message (git commit --amend). Returns (ok, error)."""
        _, error = self._git(path, "add", "-A", err="git add failed")
        if error:
            return False, error
        _, error = self._git(
            path, "commit", "--no-verify", "--amend", "-m", message, err="git commit --amend failed"
        )
        return error is None, error

    def _ahead_shas(
        self, path: str, ref: str, base: str, pull_remote: str | None
    ) -> set[str] | None:
        """The set of commit shas reachable from <ref> (default HEAD) but not from
        the base branch — its fetched <pull_remote>/<base> tip, falling back to a
        local <base> branch — i.e. unique to this branch, not inherited from base.
        None if neither resolves (caller should then treat nothing as safe)."""
        for candidate in (f"{pull_remote or 'origin'}/{base}", base):
            r = self.io.run(
                ["git", "-C", path, "rev-list", f"{candidate}..{ref or 'HEAD'}"],
                timeout=15,
                quiet=True,
            )
            if r.returncode == 0:
                return set(r.stdout.split())
        return None

    def _rebase_in_progress(self, path: str) -> bool:
        """Whether <path> currently has a rebase left mid-flight (conflict, or
        any other stop) — the standard `.git/rebase-merge` (interactive; what
        rewrite_history always uses) or `.git/rebase-apply` (plain am-style)
        state directories, resolved via --git-path so this also works from a
        linked worktree."""
        for kind in ("rebase-merge", "rebase-apply"):
            r = self.io.run(
                ["git", "-C", path, "rev-parse", "--git-path", kind], timeout=10, quiet=True
            )
            if r.returncode != 0:
                continue
            git_path = r.stdout.strip()
            if not os.path.isabs(git_path):
                git_path = os.path.join(path, git_path)
            if self.io.is_dir(git_path):
                return True
        return False

    def abort_rebase(self, path: str) -> tuple[bool, str | None]:
        """Abort an in-progress rebase (git rebase --abort), restoring the
        branch to its pre-rebase state. Returns (ok, error)."""
        _, error = self._git(path, "rebase", "--abort", err="git rebase --abort failed")
        return error is None, error

    def rebase_status(self, path: str) -> tuple[bool, str | None]:
        """Whether <path> already has a rebase left mid-flight — from a
        conflicted rewrite_history (or anything else, e.g. a manual rebase run
        outside goo) — checked fresh on every history view load, not just
        right after applying a plan, so a stuck rebase from a previous session
        is never silently invisible. (in_progress, error)."""
        path = os.path.expanduser(path)
        try:
            return self._rebase_in_progress(path), None
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e)

    def rewrite_history(
        self, path: str, base: str, plan: list[dict[str, Any]], pull_remote: str | None = "origin"
    ) -> tuple[bool, str | None, bool]:
        """Reorder and/or squash this branch's own commits via a scripted,
        non-interactive `git rebase -i`.

        `plan` is the desired FINAL order, oldest-first:
        [{sha, squash, drop, message?}, ...].
        squash=True folds that commit into whichever entry precedes it in the
        list — its own message is discarded. `message`, when present on a pick,
        replaces that commit's full message; for a squash group it becomes the
        resulting group's message. drop=True removes that commit and its changes.
        Re-validates
        server-side that `plan` covers exactly this branch's commits ahead of
        <base> (see reword_commit) — never touches base/shared history, and
        refuses a plan whose oldest entry is itself a squash (nothing precedes
        it). Returns (ok, error, in_progress) — in_progress is True only when
        the rebase itself conflicted and was left mid-flight (see
        _rebase_in_progress/abort_rebase for the recovery path); every earlier
        validation failure returns it False, since git was never touched.

        Mechanics: GIT_SEQUENCE_EDITOR overwrites git's default todo with our
        exact pick/reword/squash order (the same non-interactive "cp a prepared file
        over whatever git drafted" trick reword_commit uses for its fixup
        message) — no reliance on git's own reordering/autosquash. Reworded
        picks and squash groups open a message editor; GIT_EDITOR points at a
        tiny counter script that pops each prepared message off an ordered queue
        (one shared substitution isn't enough when a plan contains several edits
        and/or independent squash groups).
        """
        path = os.path.expanduser(path)
        if not plan:
            return False, "nothing to reorder", False
        for entry in plan:
            if not isinstance(entry, dict) or not isinstance(entry.get("sha"), str):
                return False, "invalid history plan", False
            if "message" in entry and (
                not isinstance(entry["message"], str) or not entry["message"].strip()
            ):
                return False, "commit messages can't be empty", False
            if entry.get("squash") and "message" in entry:
                return False, "a squashed commit can't keep an independent message", False
            if entry.get("drop") and (entry.get("squash") or "message" in entry):
                return False, "a dropped commit can't be squashed or reworded", False
        shas = [entry["sha"] for entry in plan]
        has_kept_commit = False
        previous_dropped = False
        for entry in plan:
            if entry.get("drop"):
                previous_dropped = True
                continue
            if entry.get("squash") and not has_kept_commit:
                return False, "the oldest commit can't be squashed — nothing precedes it", False
            if entry.get("squash") and previous_dropped:
                return False, "a commit can't be squashed into a dropped commit", False
            has_kept_commit = True
            previous_dropped = False
        ahead = self._ahead_shas(path, "HEAD", base, pull_remote)
        if not ahead or len(shas) != len(ahead) or set(shas) != ahead:
            return False, "the commit list changed — reload and try again", False
        base_ref = None
        for candidate in (f"{pull_remote or 'origin'}/{base}", base):
            r = self.io.run(["git", "-C", path, "rev-parse", candidate], timeout=15, quiet=True)
            if r.returncode == 0:
                base_ref = r.stdout.strip()
                break
        if not base_ref:
            return False, "couldn't resolve the base branch", False

        # Group consecutive squash entries under the pick that precedes them.
        # A lone edited pick uses `reword`; a squash group keeps (or replaces)
        # its root's message through the squash editor.
        groups = []
        for e in plan:
            if e.get("drop"):
                groups.append([e])
            elif e.get("squash") and groups and not groups[-1][0].get("drop"):
                groups[-1].append(e)
            else:
                groups.append([e])

        tmp_dir = tempfile.mkdtemp()
        try:
            todo_file = os.path.join(tmp_dir, "todo")
            todo_lines = []
            queued_messages = []
            counter = 0
            for g in groups:
                root = g[0]
                if root.get("drop"):
                    todo_lines.append(f"drop {root['sha']}")
                    continue
                if len(g) == 1:
                    todo_lines.append(f"{'reword' if 'message' in root else 'pick'} {root['sha']}")
                    if "message" in root:
                        queued_messages.append(root["message"])
                    continue
                todo_lines.append(f"pick {root['sha']}")
                todo_lines.extend(f"squash {entry['sha']}" for entry in g[1:])
                if "message" in root:
                    queued_messages.append(root["message"])
                    continue
                msg_r = self.io.run(
                    ["git", "-C", path, "log", "-1", "--format=%B", root["sha"]],
                    timeout=15,
                    quiet=True,
                )
                if msg_r.returncode != 0:
                    return False, msg_r.stderr.strip() or "couldn't read commit message", False
                queued_messages.append(msg_r.stdout)
            with open(todo_file, "w") as f:
                f.write("\n".join(todo_lines) + "\n")
            for message in queued_messages:
                with open(os.path.join(tmp_dir, f"{counter}.msg"), "w") as f:
                    f.write(message if message.endswith("\n") else message + "\n")
                counter += 1
            with open(os.path.join(tmp_dir, "counter"), "w") as f:
                f.write("0")
            editor_script = os.path.join(tmp_dir, "editor.sh")
            with open(editor_script, "w") as f:
                f.write(
                    "#!/bin/sh\n"
                    'n=$(cat "$GOO_QUEUE_DIR/counter")\n'
                    'cp "$GOO_QUEUE_DIR/$n.msg" "$1"\n'
                    'echo $((n+1)) > "$GOO_QUEUE_DIR/counter"\n'
                )
            env = {
                **os.environ,
                "GIT_SEQUENCE_EDITOR": f"cp {shlex.quote(todo_file)}",
                "GIT_EDITOR": f"sh {shlex.quote(editor_script)}",
                "GOO_QUEUE_DIR": tmp_dir,
            }
            r = self.io.run(
                ["git", "-C", path, "rebase", "--autostash", "-i", base_ref], timeout=120, env=env
            )
            if r.returncode != 0:
                in_progress = self._rebase_in_progress(path)
                return False, r.stderr.strip() or "git rebase failed", in_progress
            return True, None, False
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e), False
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    def reword_commit(
        self, path: str, sha: str, message: str, base: str = "", pull_remote: str | None = "origin"
    ) -> tuple[bool, str | None]:
        """Rewrite an existing commit's message, leaving its content untouched.

        Uses git's own non-interactive reword mechanism: an empty `--fixup=reword:`
        commit supplies the new message, then `rebase --autosquash` splices it into
        <sha> — GIT_SEQUENCE_EDITOR/GIT_EDITOR are set to the no-op `true` for that
        step since autosquash has already prepared the correct todo/message by the
        time either would run. The fixup commit's message must be provided through
        an editor (git refuses `-m`/`-F` together with `--fixup=reword:`), so
        GIT_EDITOR is pointed at `cp <tmpfile>` for that one step, copying a
        prepared file over whatever git drafted — no shell-embedding of the
        (arbitrary, possibly multi-line/quoted) message at all. That file's first
        line must be "amend! <sha>" using <sha> in full: autosquash normally matches
        by searching ancestor SUBJECTS for that trailer, which is ambiguous the
        moment two commits share a subject (e.g. several "[WIP]" commits) — using
        the full sha there instead makes the match exact.

        `base`/`pull_remote`, when given, gate this to commits actually ahead of
        the base branch (see `_ahead_shas`/`log`'s `ahead` flag) — the UI only ever
        offers rewording for those, and this re-checks it server-side too, since
        rewriting inherited/shared history is a mistake no confirmation dialog
        should be able to wave through. Returns (ok, error); on conflict the
        rebase is left in progress (mirrors fetch_rebase)."""
        path = os.path.expanduser(path)
        if base:
            ahead = self._ahead_shas(path, "HEAD", base, pull_remote)
            if not ahead or sha not in ahead:
                return False, "refusing to rewrite a commit that isn't unique to this branch"
        tmp = None
        try:
            with tempfile.NamedTemporaryFile("w", delete=False, suffix=".txt") as f:
                f.write(f"amend! {sha}\n\n{message}\n")
                tmp = f.name
            env = {**os.environ, "GIT_EDITOR": f"cp {shlex.quote(tmp)}"}
            r = self.io.run(
                ["git", "-C", path, "commit", "--allow-empty", f"--fixup=reword:{sha}"],
                timeout=30,
                env=env,
            )
            if r.returncode != 0:
                return False, r.stderr.strip() or "git commit --fixup failed"
            env = {**os.environ, "GIT_SEQUENCE_EDITOR": "true", "GIT_EDITOR": "true"}
            r = self.io.run(
                ["git", "-C", path, "rebase", "--autosquash", "--autostash", "-i", f"{sha}^"],
                timeout=60,
                env=env,
            )
            if r.returncode != 0:
                return False, r.stderr.strip() or "git rebase --autosquash failed"
            return True, None
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e)
        finally:
            if tmp and os.path.exists(tmp):
                os.unlink(tmp)

    def discard(self, path: str) -> tuple[bool, str | None]:
        """Make the working tree pristine: reset tracked files to HEAD, then remove
        untracked files/dirs (git clean -fd, leaving ignored files). (ok, error)."""
        _, error = self._git(path, "reset", "--hard", "HEAD", err="git reset failed")
        if error:
            return False, error
        _, error = self._git(path, "clean", "-fd", err="git clean failed")
        return error is None, error

    def log(
        self,
        path: str,
        n: int = 20,
        ref: str = "",
        base: str = "",
        pull_remote: str | None = "origin",
    ) -> tuple[list[dict[str, Any]] | None, str | None]:
        """The last n commits on <ref> (default HEAD). Returns (commits, error);
        commits is a list of {sha, author, date, subject, body, ahead}. Fields are
        \\x1f-separated, commits \\x1e-terminated so multi-line bodies survive.

        When `base` is given, "ahead" marks commits reachable from <ref> but not
        from the base branch (see `_ahead_shas`) — i.e. unique to this branch, not
        inherited from it. Only those are safe to reword (see `reword_commit`); if
        the base can't be resolved, every commit conservatively comes back
        not-ahead rather than guessing."""
        path = os.path.expanduser(path)
        args = ["log", "-n", str(n), "--format=%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1e"]
        if ref:
            args += [ref, "--"]  # log a specific branch; -- disambiguates ref from a path
        r, error = self._git(path, *args, err="git log failed")
        if error or r is None:
            return None, error
        ahead = self._ahead_shas(path, ref, base, pull_remote) if base else None
        commits = []
        for rec in r.stdout.split("\x1e"):
            rec = rec.strip("\n")
            if not rec:
                continue
            parts = rec.split("\x1f")
            if len(parts) < 4:
                continue
            sha = parts[0]
            commits.append(
                {
                    "sha": sha,
                    "author": parts[1],
                    "date": parts[2],
                    "subject": parts[3],
                    "body": parts[4].strip() if len(parts) > 4 else "",
                    "ahead": bool(ahead and sha in ahead),
                }
            )
        return commits, None

    def commit_diff(self, path: str, sha: str) -> tuple[str | None, str | None]:
        """Return the patch introduced by one commit as (diff, error)."""
        if not re.fullmatch(r"[0-9a-fA-F]{7,40}", sha or ""):
            return None, "invalid commit hash"
        r, error = self._git(
            path,
            "show",
            "--format=",
            "--no-ext-diff",
            "--no-color",
            "--find-renames",
            sha,
            "--",
            err="git show failed",
        )
        return (None, error) if error or r is None else (r.stdout, None)

    def fetch_remote_branch(
        self, path: str, branch: str, pull_remote: str | None = "origin", force: bool = False
    ) -> tuple[bool, str | None, bool]:
        """Fetch a remote branch and create/reset the local branch to track it
        (git fetch <pull_remote> {branch}:{branch}). Also updates the remote's
        opportunistic tracking ref (refs/remotes/<remote>/<branch>), so callers can
        pass a fork remote to make a forward-port head look pushed. Without `force`,
        a local branch that already exists and has diverged (e.g. the remote branch
        was rebased/force-pushed since the last fetch) is rejected rather than
        silently rewritten — flagged back as `non_ff` so a caller can ask the user
        before retrying with force=True. Returns (ok, error, non_ff)."""
        remote = pull_remote or "origin"
        refspec = f"{'+' if force else ''}{branch}:{branch}"
        r, error = self._git(path, "fetch", remote, refspec, timeout=60, err="git fetch failed")
        non_ff = bool(error) and r is not None and "non-fast-forward" in (r.stderr or "")
        return error is None, error, non_ff

    def fetch_pr_head(
        self, path: str, github: str, number: int, branch: str, force: bool = False
    ) -> tuple[bool, str | None, bool]:
        """Fetch a PR's head commit via GitHub's refs/pull/<number>/head, straight
        from the PR's own repo (https://github.com/<github>.git) rather than any
        locally-configured remote — refs/pull/<number>/head only ever resolves
        against the exact repo the PR was opened on, which a repo's configured
        pull_remote/push_remote (a differently-named alias, the user's own fork,
        or a shared internal staging remote used for colleagues'/fw-bot's WIP
        branches) has no guarantee of actually being. Relies on git's normal
        credential resolution for github.com (e.g. `gh auth login`'s HTTPS
        credential helper), same as any other github.com fetch. Onto the local
        branch <branch>. If <branch> is already checked out in a worktree (this
        one or another one entirely — e.g. a regular workspace someone already
        has open on it), git refuses to move the ref ("refusing to fetch into
        branch ... checked out at ..."); rather than surface that as a failure,
        detect it and fall back to sync_pr_worktree's safe fetch-into-FETCH_HEAD-
        and-reset at the worktree path git names in its own error, so the caller
        still gets an up-to-date checkout. Returns (ok, error, non_ff)."""
        url = f"https://github.com/{github}.git"
        refspec = f"{'+' if force else ''}refs/pull/{number}/head:{branch}"
        r, error = self._git(path, "fetch", url, refspec, timeout=60, err="git fetch failed")
        if error and r is not None:
            m = re.search(
                r"refusing to fetch into branch '[^']*' checked out at '([^']*)'", r.stderr or ""
            )
            if m:
                ok, sync_error = self.sync_pr_worktree(m.group(1), github, number)
                return ok, sync_error, False
        non_ff = bool(error) and r is not None and "non-fast-forward" in (r.stderr or "")
        return error is None, error, non_ff

    def sync_pr_worktree(
        self, path: str, github: str, number: int, repo: str = ""
    ) -> tuple[bool, str | None]:
        """Bring a worktree checkout whose branch IS the PR's head (a review
        workspace) up to date with the PR's current head commit. Unlike
        fetch_pr_head, this never writes to a branch ref by name — git refuses
        that for a branch checked out in a worktree ("refusing to fetch into
        branch ... checked out at ...") — so it fetches refs/pull/<number>/head
        into FETCH_HEAD at <path> itself, then hard-resets <path> onto it.
        Refuses to clobber uncommitted changes. Returns (ok, error)."""
        if not path:
            return False, "missing path"
        p = os.path.expanduser(path)
        st = self.io.run(["git", "-C", p, "status", "--porcelain"], timeout=10)
        if st.stdout.strip():
            return False, "worktree has uncommitted changes"
        label = repo or os.path.basename(p)
        url = f"https://github.com/{github}.git"
        fid = uuid.uuid4().hex
        fetching = f"fetching PR #{number} ({label})"
        self.notify(fetching, event_id=fid, status="start")
        _, error = self._git(
            p, "fetch", url, f"refs/pull/{number}/head", timeout=60, err="git fetch failed"
        )
        self.notify(fetching, event_id=fid, status="error" if error else "done")
        if error:
            return False, error
        _, error = self._git(p, "reset", "--hard", "FETCH_HEAD", timeout=30, err="git reset failed")
        return error is None, error

    def fetch_rebase(
        self,
        path: str | None,
        base: str | None,
        pull_remote: str | None = "origin",
        repo: str | None = "",
    ) -> tuple[bool, str | None]:
        """Fetch the base branch from the configured pull remote and rebase the
        current branch onto it. Announces the fetch and rebase phases via notify.
        Returns (ok, error); on conflict the rebase is left in progress."""
        if not path or not base:
            return False, "missing path or base branch"
        remote = pull_remote or "origin"
        p = os.path.expanduser(path)
        label = repo or os.path.basename(p)
        # both phases are slow — track each as a timed event so the browser shows a
        # live "..." that resolves to "ok" (or "failed")
        fid = uuid.uuid4().hex
        fetching = f"fetching {base} ({label})"
        self.notify(fetching, event_id=fid, status="start")
        _, error = self._git(p, "fetch", remote, base, timeout=180, err="git fetch failed")
        self.notify(fetching, event_id=fid, status="error" if error else "done")
        if error:
            return False, error
        eid = uuid.uuid4().hex
        rebasing = f"rebasing {label} onto {base}"
        self.notify(rebasing, event_id=eid, status="start")
        r, error = self._git(p, "rebase", "FETCH_HEAD", timeout=120, err="git rebase failed")
        self.notify(rebasing, event_id=eid, status="error" if error else "done")
        if error and r is not None and not r.stderr.strip():
            # a conflicted rebase reports on stdout — surface its first line instead
            error = r.stdout.strip().split("\n")[0] or "git rebase failed"
        return error is None, error

    def remote_branch_exists(
        self, path: str, branch: str, push_remote: str | None = "dev"
    ) -> tuple[bool | None, str | None]:
        """Whether <branch> exists on the configured push remote. (exists, error)."""
        remote = push_remote or "dev"
        self.io.log_request(f"git ls-remote {remote} {branch}")
        r, error = self._git(
            path, "ls-remote", "--heads", remote, branch, timeout=20, err="git ls-remote failed"
        )
        return (None, error) if error or r is None else (bool(r.stdout.strip()), None)

    def push_branch(
        self, path: str, branch: str, force: bool = False, push_remote: str | None = "dev"
    ) -> tuple[bool, str | None]:
        """Push <branch> to the configured push remote, setting upstream. With force,
        use --force-with-lease (aborts if the remote moved unexpectedly). (ok, error).
        Base branches (master, saas-19.4, …) are never pushed."""
        if is_base_branch(branch):
            return False, f"refusing to push base branch {branch}"
        remote = push_remote or "dev"
        args = ["push", "--set-upstream"]
        if force:
            args.append("--force-with-lease")
        args += [remote, branch]
        self.io.log_request("git " + " ".join(args))
        _, error = self._git(path, *args, timeout=120, err="git push failed", tail=True)
        return error is None, error

    def fetch_master(self, repo: dict[str, Any]) -> None:
        """Fetch master objects for one repo (no merge, no working-tree change).
        Slow on stale odoo clones, so callers run this off the main thread."""
        rid = repo.get("id") or "?"
        path = repo.get("path")
        if not path:
            return
        remote = repo.get("pull_remote") or "origin"
        self.io.log_request(f"git fetch {remote} master  (auto-reload {rid})")
        tag = getattr(self.io, "TAG", "[goo]")
        try:
            r = self.io.run(
                ["git", "-C", os.path.expanduser(path), "fetch", remote, "master"],
                timeout=900,
                quiet=True,  # we print our own auto-reload summary below
            )
            if r.returncode != 0:
                tail = r.stderr.strip().splitlines()
                self.io.log(
                    f"{tag} auto-reload {rid} failed: {tail[-1] if tail else 'git fetch failed'}"
                )
            else:
                self.io.log(f"{tag} auto-reload {rid}: fetched {remote}/master")
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            self.io.log(f"{tag} auto-reload {rid} failed: {e}")
