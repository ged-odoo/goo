"""PostgreSQL databases (list/create/drop/restore runbot dumps)."""

import os
import re
import subprocess
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from ..cache import TTLCache

# ─────────────────────────── PostgreSQL databases ───────────────────────────


# a safe database name: letters/digits then letters/digits/._- (no leading dash so
# it can't be read as a CLI flag, no quotes/spaces so it's safe to quote in SQL).
# Covers typical odoo db names (master, 19.0, master-feat-xyz, test_db).
_DB_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

# A runbot build's dump, as RunbotService._dump_url builds it. restore_dump checks
# the URL it is handed against this: the endpoint feeds a downloaded file straight
# into psql, so it may fetch runbot dumps and nothing else — never an arbitrary
# "download this and run it through my database" primitive.
_RUNBOT_DUMP_URL_RE = re.compile(
    r"^https?://[\w.-]+\.odoo\.com/runbot/static/build/[\w.-]+/logs/[\w.-]+\.zip$"
)


def _valid_db_name(name: object) -> bool:
    return bool(name) and isinstance(name, str) and bool(_DB_NAME_RE.match(name))


class DatabaseService:
    """PostgreSQL databases: the list (with odoo version + last activity), the
    existence/info probes, and drop. The list is cached server-side and fetched
    with parallel per-db probes; drop invalidates the cache. The probes are quiet
    (a non-zero exit just means "no such db" / "not an odoo db")."""

    def __init__(self, io: Any, cache: TTLCache) -> None:
        self.io = io
        self.cache = cache

    def databases(self, refresh: bool = False) -> list[dict[str, Any]]:
        """All non-template databases with their odoo info. Cached; pass
        refresh=True to bypass. Raises RuntimeError if psql can't be reached."""
        if refresh:
            self.cache.invalidate("list")
        return self.cache.get("list", self._list)

    def _list(self) -> list[dict[str, Any]]:
        try:
            r = self.io.run(
                [
                    "psql",
                    "-d",
                    "postgres",
                    "-tAc",
                    "SELECT datname FROM pg_database"
                    " WHERE NOT datistemplate AND datname <> 'postgres'"
                    " ORDER BY datname",
                ],
                timeout=5,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            raise RuntimeError(f"cannot list databases: {e}") from e
        if r.returncode != 0:
            raise RuntimeError(r.stderr.strip() or "psql failed")
        names = [ln.strip() for ln in r.stdout.split("\n") if ln.strip()]
        if not names:
            return []
        created = self._creation_times()
        sizes = self._sizes()
        with ThreadPoolExecutor(max_workers=min(8, len(names))) as pool:
            infos = list(pool.map(self.odoo_info, names))  # one psql per db, in parallel
        return [
            {
                "name": n,
                "odoo_version": v,
                "enterprise": e,
                "demo_data": d,
                "last_update": u,
                "created": created.get(n),
                "size": sizes.get(n),
            }
            for n, (v, e, d, u) in zip(names, infos, strict=False)
        ]

    # ── filestore: an Odoo database's attachments live in <filestore>/<dbname>.
    # goo keeps it in lockstep with the database — dropped/renamed/cloned to match —
    # so a target's attachments survive a clone and don't leak after a drop. These
    # are best-effort: a filestore failure is logged, never failing the DB op (the
    # database change already happened). Names are charset-validated, so the joined
    # path can't traverse out of the filestore root.
    def _filestore_dir(self, filestore: str | None, name: str) -> str | None:
        if not filestore or not _valid_db_name(name):
            return None
        return os.path.join(os.path.expanduser(filestore), name)

    def _log_filestore(self, action: str, src: str, dst: str | None, err: str | None) -> None:
        tag = getattr(self.io, "TAG", "[goo]")
        where = f"{src} → {dst}" if dst else src
        self.io.log(f"{tag} could not {action} filestore {where}: {err}")

    def drop(self, name: str, filestore: str | None = None) -> tuple[bool, str | None]:
        """Drop a database (and its filestore). Returns (ok, error); invalidates the
        list cache. --if-exists: a target's db may never have been created (or was
        already dropped) — that's not a failure, so dropdb shouldn't error on it."""
        try:
            r = self.io.run(["dropdb", "--if-exists", name], timeout=15)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e)
        if r.returncode != 0:
            return False, r.stderr.strip() or "dropdb failed"
        self.cache.invalidate("list")
        store = self._filestore_dir(filestore, name)
        if store and self.io.is_dir(store):
            ok, err = self.io.remove_tree(store)
            if not ok:
                self._log_filestore("delete", store, None, err)
        return True, None

    def clone(
        self, source: str, target: str, filestore: str | None = None
    ) -> tuple[bool, str | None]:
        """Clone `source` into a new database `target` (createdb -T) and copy its
        filestore. Returns (ok, error); invalidates the list cache on success. The
        source must have no active connections (a postgres requirement) — stop the
        server if it's on it."""
        if not _valid_db_name(source):
            return False, f"invalid source name: {source}"
        if not _valid_db_name(target):
            return False, f"invalid target name: {target}"
        try:
            r = self.io.run(["createdb", "-T", source, target], timeout=120)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e)
        if r.returncode != 0:
            return False, r.stderr.strip() or "createdb failed"
        self.cache.invalidate("list")
        src = self._filestore_dir(filestore, source)
        dst = self._filestore_dir(filestore, target)
        if src and dst and self.io.is_dir(src):
            ok, err = self.io.copy_tree(src, dst)
            if not ok:
                self._log_filestore("copy", src, dst, err)
        return True, None

    def exists(self, name: str) -> bool:
        """Whether a database of that name exists. False on any probe error (no
        psql, a timeout) — the callers treat "can't tell" as "go ahead and try",
        and the real createdb/dropdb below reports the truth either way."""
        if not _valid_db_name(name):
            return False
        # the name is validated to the safe charset above, so quoting is injection-free
        sql = f"SELECT 1 FROM pg_database WHERE datname = '{name}'"
        try:
            r = self.io.run(["psql", "-d", "postgres", "-tAc", sql], timeout=5, quiet=True)
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False
        return r.returncode == 0 and r.stdout.strip() == "1"

    def restore_dump(
        self, name: str, url: str, filestore: str | None = None, log_progress: bool = True
    ) -> tuple[bool, str | None]:
        """Download a runbot database dump and restore it into a NEW database `name`.
        Returns (ok, error); invalidates the list cache on success.

        The dump is an odoo one — a zip of dump.sql plus the build's filestore/ — so
        this is odoo's own restore: create the database the way odoo would
        (template0 / unicode / LC_COLLATE C, which is what its dumps expect), replay
        dump.sql through psql, and drop the filestore alongside as <filestore>/<name>
        so the restored attachments actually resolve.

        `name` must not exist yet: replaying a dump over a live database would merge
        two schemas into rubble. A failure after the database was created takes it
        back down rather than leaving an unusable shell behind, and the download +
        extraction live in a temp directory that's removed either way."""
        if not _valid_db_name(name):
            return False, f"invalid database name: {name}"
        if not _RUNBOT_DUMP_URL_RE.match(url or ""):
            return False, "not a runbot dump URL"
        if self.exists(name):
            return False, f'database "{name}" already exists'
        tmp = self.io.make_temp_dir("goo-dump-")
        if not tmp:
            return False, "could not create a temporary directory"
        try:
            return self._restore_dump(name, url, tmp, filestore, log_progress)
        finally:
            ok, err = self.io.remove_tree(tmp)
            if not ok:
                self.io.log(f"{getattr(self.io, 'TAG', '[goo]')} could not clean up {tmp}: {err}")

    def _restore_dump(
        self, name: str, url: str, tmp: str, filestore: str | None, log_progress: bool
    ) -> tuple[bool, str | None]:
        """The body of restore_dump, inside the temp directory it cleans up."""
        zip_path = os.path.join(tmp, "dump.zip")
        ok, err = self.io.http_download(
            url,
            zip_path,
            timeout=1800,
            on_progress=self._download_logger(url) if log_progress else None,
        )
        if not ok:
            return False, f"could not download the dump: {err}"
        unpacked = os.path.join(tmp, "dump")
        ok, err = self.io.unzip(zip_path, unpacked)
        if not ok:
            return False, f"could not unpack the dump: {err}"
        sql = os.path.join(unpacked, "dump.sql")
        if not self.io.is_file(sql):
            return False, "the archive holds no dump.sql — not an odoo database dump"
        # odoo's own database shape (see odoo.service.db._create_empty_database):
        # its dumps are taken from such a cluster and restore cleanly into no other
        try:
            r = self.io.run(
                ["createdb", "--template=template0", "--encoding=unicode", "--lc-collate=C", name],
                timeout=120,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e)
        if r.returncode != 0:
            return False, r.stderr.strip() or "createdb failed"
        self.cache.invalidate("list")
        try:
            r = self.io.run(["psql", "--quiet", "--dbname", name, "--file", sql], timeout=3600)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            self._drop_quietly(name)
            return False, str(e)
        if r.returncode != 0:
            self._drop_quietly(name)
            return False, r.stderr.strip() or "psql restore failed"
        # the filestore rides along in the archive; without it every attachment in
        # the restored database 404s. Best-effort, like every other filestore step.
        src = os.path.join(unpacked, "filestore")
        dst = self._filestore_dir(filestore, name)
        if not self.io.is_dir(src):
            return True, None
        if not dst:
            # unlike clone/rename, a restore HAS the attachments in hand and would be
            # dropping them — worth a word, or the database comes up with every
            # attachment 404ing and nothing anywhere saying why
            tag = getattr(self.io, "TAG", "[goo]")
            self.io.log(f"{tag} no filestore configured: {name}'s attachments were not restored")
            return True, None
        ok, err = self.io.make_dirs(os.path.dirname(dst))
        if ok:
            ok, err = self.io.move_path(src, dst)
        if not ok:
            self._log_filestore("install", src, dst, err)
        return True, None

    def _drop_quietly(self, name: str) -> None:
        """Take a half-restored database back down — the restore failed, so the shell
        left behind is worse than nothing. Its filestore isn't installed yet."""
        try:
            self.io.run(["dropdb", "--if-exists", name], timeout=15, quiet=True)
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass
        self.cache.invalidate("list")

    def _download_logger(self, url: str) -> Callable[[int, int], None]:
        """An on_progress callback that narrates a download to the goo log every 10%.
        A dump runs to hundreds of megabytes; a silent multi-minute step looks hung."""
        tag = getattr(self.io, "TAG", "[goo]")
        state = {"decile": -1}

        def on_progress(done: int, total: int) -> None:
            decile = int(done * 10 / total) if total else -1
            if decile == state["decile"]:
                return
            state["decile"] = decile
            self.io.log(f"{tag} downloading {url}: {done * 100 // total}% of {total >> 20} MiB")

        return on_progress

    def rename(self, old: str, new: str, filestore: str | None = None) -> tuple[bool, str | None]:
        """Rename database `old` to `new` (ALTER DATABASE … RENAME) and move its
        filestore. Returns (ok, error); invalidates the list cache on success. `old`
        must have no active connections (a postgres requirement)."""
        if not _valid_db_name(old):
            return False, f"invalid name: {old}"
        if not _valid_db_name(new):
            return False, f"invalid name: {new}"
        # names are validated to the safe charset above, so quoting is injection-free
        sql = f'ALTER DATABASE "{old}" RENAME TO "{new}"'
        try:
            r = self.io.run(["psql", "-d", "postgres", "-tAc", sql], timeout=15)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return False, str(e)
        if r.returncode != 0:
            return False, r.stderr.strip() or "rename failed"
        self.cache.invalidate("list")
        src = self._filestore_dir(filestore, old)
        dst = self._filestore_dir(filestore, new)
        if src and dst and self.io.is_dir(src):
            ok, err = self.io.move_path(src, dst)
            if not ok:
                self._log_filestore("move", src, dst, err)
        return True, None

    def db_initialized(self, db: str) -> bool:
        """Whether the database exists AND holds an initialized odoo schema. A db
        can exist as an empty shell; odoo refuses to load it without -i, so treat
        that as new. On a probe error (no psql), assume initialized to avoid a
        surprise reinstall."""
        try:
            r = self.io.run(
                [
                    "psql",
                    "-d",
                    db,
                    "-tAc",
                    "SELECT 1 FROM information_schema.tables WHERE table_name = 'ir_module_module'",
                ],
                timeout=5,
                quiet=True,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return True
        if r.returncode != 0:
            return False  # database doesn't exist
        return r.stdout.strip() == "1"

    def odoo_info(self, db: str) -> tuple[str | None, bool, bool, str | None]:
        """(version, is_enterprise, has_demo_data, last_update) of the odoo in a
        database, or (None, False, False, None) if it holds no odoo. has_demo_data
        reflects ir_module_module.demo — set per-module by odoo itself when that
        module's demo data was actually loaded (i.e. not `--without-demo all`).
        last_update is the UTC timestamp of the last detectable activity (cron
        writes, login rows)."""
        try:
            r = self.io.run(
                [
                    "psql",
                    "-d",
                    db,
                    "-tAc",
                    "SELECT (SELECT latest_version FROM ir_module_module WHERE name = 'base'),"
                    " EXISTS (SELECT 1 FROM ir_module_module"
                    " WHERE name = 'web_enterprise' AND state = 'installed'),"
                    " EXISTS (SELECT 1 FROM ir_module_module WHERE demo),"
                    " GREATEST((SELECT max(write_date) FROM ir_cron),"
                    " (SELECT max(create_date) FROM res_users_log))",
                ],
                timeout=5,
                quiet=True,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return None, False, False, None
        line = r.stdout.strip()
        if r.returncode != 0 or not line:
            return None, False, False, None  # no odoo tables: not an odoo database
        version, enterprise, demo_data, last_update = line.split("|", 3)
        return version or None, enterprise == "t", demo_data == "t", last_update or None

    def installed_modules(self, db: str) -> dict[str, str]:
        """Map of module name -> state for a database (empty if unreadable)."""
        try:
            r = self.io.run(
                ["psql", "-d", db, "-tAc", "SELECT name, state FROM ir_module_module"],
                timeout=5,
                quiet=True,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return {}
        if r.returncode != 0:
            return {}
        out = {}
        for line in r.stdout.splitlines():
            if "|" in line:
                name, state = line.split("|", 1)
                out[name] = state
        return out

    def _creation_times(self) -> dict[str, str | None]:
        """Map db name -> creation timestamp (naive UTC ISO) from each database's
        PG_VERSION mtime. Needs superuser / pg_read_server_files; {} if not."""
        try:
            r = self.io.run(
                [
                    "psql",
                    "-d",
                    "postgres",
                    "-tAc",
                    "SELECT datname,"
                    " (pg_stat_file('base/' || oid || '/PG_VERSION')).modification AT TIME ZONE 'UTC'"
                    " FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres'",
                ],
                timeout=5,
                quiet=True,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return {}
        if r.returncode != 0:
            return {}
        out = {}
        for line in r.stdout.splitlines():
            if "|" in line:
                name, ts = line.split("|", 1)
                out[name] = ts or None
        return out

    def _sizes(self) -> dict[str, int]:
        """Map db name -> on-disk size in bytes (pg_database_size). Best-effort: {}
        on any error — the size is just informational, never blocks the listing."""
        try:
            r = self.io.run(
                [
                    "psql",
                    "-d",
                    "postgres",
                    "-tAc",
                    "SELECT datname, pg_database_size(datname)"
                    " FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres'",
                ],
                timeout=5,
                quiet=True,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return {}
        if r.returncode != 0:
            return {}
        out = {}
        for line in r.stdout.splitlines():
            if "|" in line:
                name, size = line.split("|", 1)
                try:
                    out[name] = int(size)
                except ValueError:
                    pass
        return out
