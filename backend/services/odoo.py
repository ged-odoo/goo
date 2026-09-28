"""Odoo worktree tooling: venvs, the addons scan, asset bundles, the Rust bundler."""

import ast
import base64
import json
import os
import re
import shlex
import subprocess
import threading
import uuid
from collections.abc import Callable
from typing import Any

from ..cache import TTLCache
from .database import _valid_db_name

# ─────────────────────────── Venv (worktree Python environments) ────────────


class VenvService:
    """Build a dedicated Python venv for a worktree workspace, from its own
    requirements.txt (python3 -m venv, then pip install -r if the file is
    present), plus websocket-client (best-effort — needed by Odoo's
    ChromeBrowser for the Tests tab's memory-check option, since memleak_check
    is available in every worktree but isn't itself an Odoo dependency). Same
    notify-timed-event shape as GitService's mutations."""

    def __init__(self, io: Any, notify: Callable[..., None] | None = None) -> None:
        self.io = io
        self.notify = notify or (lambda *a, **k: None)

    def _pip(self, pip: str, *args: str, timeout: float, err: str) -> tuple[bool, str | None]:
        """Run one pip command in the venv. Returns (ok, error): error is the last
        stderr line (or <err> when pip was silent), or a raised
        FileNotFoundError/TimeoutExpired's message."""
        try:
            result = self.io.run([pip, *args], timeout=timeout)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e)
        if result.returncode != 0:
            lines = (result.stderr or "").strip().splitlines()
            return False, (lines[-1] if lines else err)
        return True, None

    def create(
        self, venv_path: str, requirements_path: str, timeout: float = 600
    ) -> tuple[bool, str | None]:
        """Create the venv at <venv_path> and install <requirements_path> into it
        if that file exists. Returns (ok, error). Announced as a timed event."""
        vp = os.path.expanduser(venv_path)
        label = os.path.basename(os.path.dirname(vp.rstrip("/")))
        eid = uuid.uuid4().hex
        creating = f"creating venv ({label})"
        self.notify(creating, event_id=eid, status="start")
        try:
            result = self.io.run(["python3", "-m", "venv", vp], timeout=60)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            self.notify(creating, event_id=eid, status="error")
            return False, str(e)
        if result.returncode != 0:
            error = (result.stderr or "python3 -m venv failed").strip().splitlines()[-1]
            self.notify(creating, event_id=eid, status="error")
            return False, error

        pip = os.path.join(vp, "bin", "pip")

        # a missing requirements.txt is not an error — just nothing to install
        if self.io.read_text(requirements_path) is not None:
            req = os.path.expanduser(requirements_path)
            ok, error = self._pip(pip, "install", "-r", req, timeout=timeout, err="pip failed")
            if not ok:
                self.notify(creating, event_id=eid, status="error")
                return False, error

        # best-effort: not an Odoo dependency, so it's never in requirements.txt,
        # but memleak_check (available in every worktree) needs it for
        # ChromeBrowser — a failure here shouldn't fail the whole venv
        self._pip(pip, "install", "websocket-client", timeout=60, err="pip failed")

        self.notify(creating, event_id=eid, status="done")
        return True, None


# ─────────────────────────── Addons (filesystem scan) ───────────────────────


class AddonsService:
    """Odoo modules discovered by scanning each repo's addons roots for a
    __manifest__.py. Over the IO seam (filesystem reads), so it's testable without
    a real checkout. The install state per db comes from DatabaseService."""

    def __init__(self, io: Any) -> None:
        self.io = io

    def modules(
        self, repos: list[dict[str, Any]], main_repo_id: str = "community"
    ) -> list[dict[str, Any]]:
        """Scan each repo {id, path} for modules with a manifest. A module name
        found in an earlier repo wins (community before enterprise, etc.)."""
        mods = []
        seen = set()
        for repo in repos:
            rid, path = repo.get("id"), repo.get("path")
            if not rid or not path:
                continue
            for root in self._roots(rid, path, main_repo_id):
                if not self.io.is_dir(root):
                    continue
                for name in self.io.list_dir(root):
                    if name.startswith((".", "_")) or name in seen:
                        continue
                    man = self._manifest(os.path.join(root, name))
                    if not man:
                        continue
                    seen.add(name)
                    mods.append(
                        {
                            "name": name,
                            "repo": rid,
                            "category": man.get("category") or "",
                            "summary": man.get("summary") or "",
                            "application": bool(man.get("application")),
                            "installable": man.get("installable", True),
                        }
                    )
        return mods

    @staticmethod
    def _roots(rid: str, path: str, main_repo_id: str = "community") -> list[str]:
        """Directories that hold modules for a repo, matching the addons-path."""
        p = os.path.expanduser(path)
        if rid == main_repo_id:
            return [os.path.join(p, "addons"), os.path.join(p, "odoo", "addons")]
        return [p]

    def _manifest(self, module_path: str) -> dict[str, Any] | None:
        """Parse a module's __manifest__.py into a dict, or None."""
        content = self.io.read_text(os.path.join(module_path, "__manifest__.py"))
        if content is None:
            return None
        try:
            tree = ast.parse(content)
        except SyntaxError:
            return None
        for node in ast.walk(tree):
            if isinstance(node, ast.Dict):
                try:
                    return ast.literal_eval(node)
                except (ValueError, TypeError):
                    return None
        return None


# ─────────────────────────── Assets (asset bundles) ─────────────────────────


class AssetsService:
    """Asset-bundle attachments in a target db — the ir_attachment rows whose url
    is under /web/assets/... (one per bundle/extension/version). Read via psql,
    cached per-db with a short TTL. `generate` forces a pregeneration by piping a
    call into `odoo-bin shell` (the command is assembled in the server layer, which
    owns the odoo-bin invocation)."""

    # the shell rolls its cursor back unless we commit, so the script commits itself
    PREGEN_SCRIPT = "env['ir.qweb']._pregenerate_assets_bundles()\nenv.cr.commit()\n"

    def __init__(self, io: Any, cache: TTLCache) -> None:
        self.io = io
        self.cache = cache

    def bundles(self, db: str, refresh: bool = False) -> list[dict[str, Any]]:
        """[{id, name, url, size, created}] for a db's asset bundles, ordered by
        name. Empty if the db is unreadable or holds no odoo. refresh bypasses the
        cache."""
        if not _valid_db_name(db):
            return []
        if refresh:
            self.cache.invalidate(db)
        return self.cache.get(db, lambda: self._bundles(db))

    def _bundles(self, db: str) -> list[dict[str, Any]]:
        try:
            r = self.io.run(
                [
                    "psql",
                    "-d",
                    db,
                    "-tAc",
                    "SELECT id, name, url, COALESCE(file_size, 0), create_date"
                    " FROM ir_attachment WHERE url LIKE '/web/assets/%' ORDER BY name",
                ],
                timeout=10,
                quiet=True,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return []
        if r.returncode != 0:
            return []
        rows = []
        for line in r.stdout.splitlines():
            parts = line.split("|", 4)
            if len(parts) < 5:
                continue
            aid, name, url, size, created = parts
            rows.append(
                {
                    "id": int(aid) if aid.isdigit() else aid,
                    "name": name,
                    "url": url,
                    "size": int(size) if size.isdigit() else 0,
                    "created": created or "",
                }
            )
        return rows

    def generate(self, cmd: str, db: str, timeout: float = 900) -> tuple[bool, str | None]:
        """Run a prepared `odoo-bin shell` command, piping the pregeneration call to
        its stdin. Returns (ok, error); on success the cached bundle list for db is
        dropped so the next read reflects the new attachments."""
        try:
            r = self.io.run(
                cmd,
                shell=True,
                executable="/bin/bash",
                input=self.PREGEN_SCRIPT,
                timeout=timeout,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e)
        if r.returncode != 0:
            tail = (r.stderr or r.stdout or "").strip().splitlines()
            return False, (tail[-1] if tail else "asset generation failed")
        self.cache.invalidate(db)
        return True, None

    # the per-file separators odoo writes into a bundle: "/* /web/.../foo.js */"
    # before each file, and a stars banner before the XML templates section.
    _MARKER = re.compile(r"/\* (/\S+?) \*/")
    _TPL = re.compile(r'register(?:Template|TemplateExtension)\("([^"]+)"')
    _TPL_SPLIT = re.compile(r"/\*{6,}")
    # fallback when the client sends no filestore root (the config always has one)
    DEFAULT_FILESTORE = os.path.expanduser("~/.local/share/Odoo/filestore")

    def breakdown(
        self, db: str, bundle: str, filestore: str | None = None, kind: str | None = None
    ) -> tuple[dict[str, Any] | None, str | None]:
        """Per-file minified-size breakdown of a bundle, read straight from its
        stored attachments — the actual shipped bytes, so it's version-correct and
        needs no odoo process. `filestore` is the configured filestore root (a db's
        files live in <filestore>/<db>/<store_fname>). `kind` scopes the read to one
        asset: "js" → the .min.js (its code + XML templates), "css" → the .min.css;
        None reads both. Scoping matches the size shown for the attachment the caller
        clicked (a .min.js row is JS-only, not JS+CSS). Slices the bundle on the
        per-file "/* /path */" markers and the XML-templates banner. Returns
        (data, error); data is {js: [[path, bytes], …], css: […], xml: […]}, None on
        failure (e.g. the bundle was never generated to disk)."""
        if not _valid_db_name(db):
            return None, "invalid database name"
        if not re.match(r"^[A-Za-z0-9_.-]+$", bundle or ""):
            return None, "invalid bundle name"
        rows = self._bundle_files(db, bundle)
        if rows is None:
            return None, "could not read the database"
        filestore = filestore or self.DEFAULT_FILESTORE
        want_js = kind in (None, "js")
        want_css = kind in (None, "css")
        js_text = self._asset_text(db, filestore, rows.get("min.js")) if want_js else None
        css_text = self._asset_text(db, filestore, rows.get("min.css")) if want_css else None
        if js_text is None and css_text is None:
            return None, 'bundle not generated yet — run "Generate asset bundles" first'
        parts = self._TPL_SPLIT.split(js_text or "", maxsplit=1)
        js = self._split_markers(parts[0])
        xml = self._templates(parts[1] if len(parts) > 1 else "")
        css = self._split_markers(css_text or "")
        return {"js": js, "css": css, "xml": xml}, None

    def _bundle_files(self, db: str, bundle: str) -> dict[str, tuple[str, str]] | None:
        """{"min.js"|"min.css": (store_fname, db_datas_b64)} for a bundle's stored
        attachments, or None if the db can't be read. bundle is pre-validated."""
        names = f"'{bundle}.min.js', '{bundle}.min.css'"
        try:
            r = self.io.run(
                [
                    "psql",
                    "-d",
                    db,
                    "-tAc",
                    "SELECT name, COALESCE(store_fname, ''),"
                    " COALESCE(encode(db_datas, 'base64'), '') FROM ir_attachment"
                    f" WHERE url LIKE '/web/assets/%' AND name IN ({names})",
                ],
                timeout=15,
                quiet=True,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return None
        if r.returncode != 0:
            return None
        out = {}
        for line in r.stdout.splitlines():
            cols = line.split("|", 2)
            if len(cols) < 3:
                continue
            name, store_fname, datas = cols
            for ext in ("min.js", "min.css"):
                if name.endswith("." + ext):
                    out[ext] = (store_fname, datas)
        return out

    def _asset_text(self, db: str, filestore: str, row: tuple[str, str] | None) -> str | None:
        """One stored attachment's text — from its filestore file
        (<filestore>/<db>/<store_fname>), else its inline db_datas. None when
        absent/unreadable."""
        if not row:
            return None
        store_fname, datas = row
        if store_fname:
            path = os.path.join(os.path.expanduser(filestore), db, store_fname)
            try:
                return self.io.read_text(path)
            except ValueError:  # incl. UnicodeDecodeError on a non-utf8 file
                return None
        if datas:
            try:
                return base64.b64decode(datas).decode("utf-8", "replace")
            except ValueError:  # incl. binascii.Error
                return None
        return None

    def _split_markers(self, text: str) -> list[list[Any]]:
        """[[path, bytes], …] by slicing text on the "/* /path */" file markers; each
        file's size is the byte length of its chunk up to the next marker."""
        marks = list(self._MARKER.finditer(text))
        out = []
        for i, m in enumerate(marks):
            end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
            out.append([m.group(1), len(text[m.end() : end].encode("utf-8"))])
        return out

    def _templates(self, text: str) -> list[list[Any]]:
        """[[template, bytes], …] from a bundle's XML section (registerTemplate
        calls). Dotted names become slash paths so they nest by addon in the tree."""
        marks = list(self._TPL.finditer(text))
        out = []
        for i, m in enumerate(marks):
            end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
            out.append([m.group(1).replace(".", "/"), len(text[m.end() : end].encode("utf-8"))])
        return out


# ─────────────────────────── Rust asset bundler ───────────────────────────


class RustBundlerService:
    """Install and probe Goo's native asset bundler in the configured Odoo Python.

    The source directory is fixed by the server, while ``venv_activate`` comes from
    Goo's trusted local configuration just like every Odoo launch command. A
    process-wide lock prevents two browser tabs from building into the same venv.
    """

    PROBE_CODE = (
        "import json, goo_odoo_bundler as module; "
        'print(json.dumps({"version": module.__version__}))'
    )

    def __init__(self, io: Any, source_dir: str, notify: Callable[..., None] | None = None) -> None:
        self.io = io
        self.source_dir = os.path.abspath(source_dir)
        self.notify = notify
        self._build_lock = threading.Lock()

    def expected_version(self) -> str:
        cargo = self.io.read_text(os.path.join(self.source_dir, "Cargo.toml")) or ""
        package = re.search(r'(?ms)^\[package\].*?^version\s*=\s*"([^"]+)"', cargo)
        return package.group(1) if package else "unknown"

    @staticmethod
    def _environment_command(config: dict[str, Any] | None, command: str) -> str:
        activate = ((config or {}).get("venv_activate") or "").strip()
        return f"{activate} && {command}" if activate else command

    def install_command(self, config: dict[str, Any] | None) -> str:
        pip = f"python3 -m pip install --force-reinstall --no-deps {shlex.quote(self.source_dir)}"
        return self._environment_command(config, pip)

    def probe_command(self, config: dict[str, Any] | None) -> str:
        probe = f"python3 -c {shlex.quote(self.PROBE_CODE)}"
        return self._environment_command(config, probe)

    @staticmethod
    def _tail(result: subprocess.CompletedProcess[str], fallback: str) -> str:
        lines = ((result.stderr or result.stdout or "").strip()).splitlines()
        return "\n".join(lines[-12:])[-3000:] if lines else fallback

    def _probe(
        self, config: dict[str, Any] | None, allow_while_building: bool = False
    ) -> dict[str, Any]:
        expected = self.expected_version()
        base = {
            "installed": False,
            "current": False,
            "version": "",
            "expected_version": expected,
            "building": self._build_lock.locked(),
        }
        if base["building"] and not allow_while_building:
            return base
        try:
            result = self.io.run(
                self.probe_command(config),
                shell=True,
                executable="/bin/bash",
                quiet=True,
                timeout=30,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            return {**base, "error": str(error)}
        if result.returncode:
            return base
        try:
            payload = json.loads((result.stdout or "").strip().splitlines()[-1])
            version = payload["version"]
        except (IndexError, KeyError, TypeError, ValueError):
            return {**base, "error": "the native module returned an invalid version"}
        return {
            **base,
            "installed": True,
            "current": version == expected,
            "version": version,
        }

    def status(self, config: dict[str, Any] | None) -> dict[str, Any]:
        return self._probe(config)

    def install(
        self, config: dict[str, Any] | None, timeout: float = 900
    ) -> tuple[bool, dict[str, Any]]:
        if not self._build_lock.acquire(blocking=False):
            return False, {"error": "Rust bundler installation is already in progress"}

        event_id = f"rust-bundler-{uuid.uuid4().hex}"
        event_text = "building Goo's Rust asset bundler"
        if self.notify:
            self.notify(event_text, "", event_id, "start")
        try:
            try:
                result = self.io.run(
                    self.install_command(config),
                    shell=True,
                    executable="/bin/bash",
                    timeout=timeout,
                )
            except (OSError, subprocess.TimeoutExpired) as error:
                message = str(error) or "Rust bundler installation timed out"
                if self.notify:
                    self.notify(event_text, "error", event_id, "error")
                return False, {"error": message}
            if result.returncode:
                message = self._tail(result, "Rust bundler installation failed")
                if self.notify:
                    self.notify(event_text, "error", event_id, "error")
                return False, {"error": message}

            status = {**self._probe(config, allow_while_building=True), "building": False}
            if not status.get("current"):
                message = status.get("error") or "installed module version could not be verified"
                if self.notify:
                    self.notify(event_text, "error", event_id, "error")
                return False, {"error": message, **status}
            if self.notify:
                self.notify(event_text, "", event_id, "done")
            return True, {**status, "restart_required": True}
        finally:
            self._build_lock.release()
