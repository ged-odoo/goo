"""Docs must not point at files that no longer exist.

goo is written almost entirely with Claude Code, and every session trusts what
CLAUDE.md and the code comments say — a reference left behind by a refactor
(a moved module, a split file) silently misleads the next one. Checked: every
path in CLAUDE.md, and every reference to one of goo's own source files
(backend/, static/src/, static/tests/ .py/.js/.ts) in the code. Paths inside Odoo
(addons/web/…, runbot URLs, Odoo's docs) are out of scope.
"""

import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# CLAUDE.md names paths relative to the section they're in (e.g. `core/` under
# static/src/, `services/` under backend/), so resolve against those roots too
CLAUDE_MD_ROOTS = ["", "static/src", "backend", "addons"]
# not preceded by a path character: "addons/web/static/src/x.js" is Odoo's, not goo's
CODE_REF_RE = re.compile(
    r"(?<![\w./-])((?:backend|static/src|static/tests)/[\w./-]*\.(?:py|js|ts))\b"
)
# a bare file name in CLAUDE.md (`events.py`) must exist somewhere in the repo
BARE_FILE_RE = re.compile(r"^[\w.-]+\.(?:py|js|ts|json|toml|md|sh|yml|yaml|html|css)$")
CODE_DIRS = ["backend", "static/src", "static/tests", "tests"]
SKIP_DIRS = {"templates", "__pycache__", "node_modules"}


def _exists(path: str, roots: list[str]) -> bool:
    return any(os.path.exists(os.path.join(ROOT, r, path)) for r in roots)


class DocPathsTest(unittest.TestCase):
    def test_claude_md_paths_exist(self) -> None:
        with open(os.path.join(ROOT, "CLAUDE.md"), encoding="utf-8") as f:
            tokens = set(re.findall(r"`([^`\s]+)`", f.read()))
        paths = [
            t
            for t in tokens
            if "/" in t
            and not t.startswith(("#", "@", "http", "~", "$", "/", "-", "_", "."))
            and not re.search(r"[{}<>*…|=:]", t)
        ]
        missing = sorted(p for p in paths if not _exists(p, CLAUDE_MD_ROOTS))
        self.assertEqual(missing, [], "CLAUDE.md references paths that don't exist")

    def test_claude_md_bare_file_names_exist(self) -> None:
        with open(os.path.join(ROOT, "CLAUDE.md"), encoding="utf-8") as f:
            tokens = set(re.findall(r"`([^`\s]+)`", f.read()))
        names = set()
        for _dirpath, dirnames, filenames in os.walk(ROOT):
            dirnames[:] = [n for n in dirnames if n not in SKIP_DIRS and n != ".git"]
            names.update(filenames)
        missing = sorted(t for t in tokens if BARE_FILE_RE.match(t) and t not in names)
        self.assertEqual(missing, [], "CLAUDE.md names files that don't exist")

    def test_code_references_to_goo_files_exist(self) -> None:
        missing = []
        for d in CODE_DIRS:
            for dirpath, dirnames, filenames in os.walk(os.path.join(ROOT, d)):
                dirnames[:] = [n for n in dirnames if n not in SKIP_DIRS]
                for name in filenames:
                    if not name.endswith((".py", ".js", ".ts")):
                        continue
                    path = os.path.join(dirpath, name)
                    with open(path, encoding="utf-8") as f:
                        for lineno, line in enumerate(f, 1):
                            for ref in CODE_REF_RE.findall(line):
                                if not _exists(ref, [""]):
                                    missing.append(
                                        f"{os.path.relpath(path, ROOT)}:{lineno} → {ref}"
                                    )
        self.assertEqual(missing, [], "code comments reference goo files that don't exist")


if __name__ == "__main__":
    unittest.main()
