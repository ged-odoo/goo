"""Runbot / mergebot HTML scraping: starred bundles, mergebot PR state, the CI
(stagings) dashboard, and hoot [MEMINFO] memory logs."""

import html as html_lib
import json
import re
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any

from ..cache import TTLCache

RUNBOT_BASE = "https://runbot.odoo.com"
MERGEBOT_BASE = "https://mergebot.odoo.com"


# ─────────────────────────── Runbot (HTML scraping) ─────────────────────────

# runbot's rd-1 page lists every bundle of the R&D project; the starred ones are the
# sticky series (master, 19.0, saas-19.4, …). The dump lookup (which needs a
# series' canonical bundle id — see RunbotService._bundle_html) reads it through here.
_BUNDLE_ROW_RE = re.compile(r'class="row bundle_row"')
_BUNDLE_LINK_RE = re.compile(r'href="/runbot/bundle/(\d+)"[^>]*title="View Bundle ([^"]+)"')


def parse_starred_bundles(html: str) -> list[tuple[str, str]]:
    """[(version, bundle_id)] for the starred bundles on a runbot project page, in
    page order (newest series first)."""
    starts = [m.start() for m in _BUNDLE_ROW_RE.finditer(html or "")]
    out = []
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else start + 4000
        chunk = html[start:end]
        if "fa fa-star" not in chunk:
            continue
        m = _BUNDLE_LINK_RE.search(chunk)
        if m:
            out.append((m.group(2), m.group(1)))
    return out


class RunbotService:
    """Runbot CI status for a branch's bundle, scraped from runbot.odoo.com."""

    def __init__(self, io: Any, cache: TTLCache) -> None:
        self.io = io
        self.cache = cache

    def statuses(self, branches: list[str], refresh: bool = False) -> dict[str, dict[str, Any]]:
        """{branch: {result, running}} for the given branches, cached per branch
        and fetched in parallel. Pass refresh=True to bypass the cache."""
        branches = [b for b in dict.fromkeys(branches) if b]  # unique, non-empty
        if not branches:
            return {}
        if refresh:
            for b in branches:
                self.cache.invalidate(b)
        with ThreadPoolExecutor(max_workers=min(8, len(branches))) as pool:
            states = pool.map(lambda b: self.cache.get(b, lambda b=b: self._status(b)), branches)
            return dict(zip(branches, states, strict=False))

    def _status(self, branch: str) -> dict[str, Any]:
        """{result, running, url} for a branch's runbot bundle.

        `/runbot/bundle/<name>` resolves the *name* and 302-redirects to the bundle's
        canonical URL. But when no bundle has that name, runbot/Odoo instead treats a
        trailing "-<n>" as a record id and 301-redirects to whatever bundle has id n —
        a *different* branch (e.g. a fresh, never-pushed `master-test-33` resolves to
        bundle 33, `master-decimal-rounding-fix-jar`). We must not report that foreign
        bundle's status, so we don't follow redirects ourselves: a 302 is a real name
        match (follow it), a 301 means "no such bundle" (the trailing number was read
        as an id), and 404 is plainly absent.

        `result` ("success"/"failure"/"") comes from the bundle page favicon
        (icon_ok/icon_ko/icon_killed …). `running` is true when the latest batch still
        has a build in progress: runbot tints the batch card `bg-info-subtle` (vs
        `bg-success-subtle`/`bg-danger-subtle` once done) and spins the building slot's
        icon (`fa-spin`). NB: a bare `btn-info` is *not* a running signal — every
        finished slot carries an `fa-sign-in btn-info` "connect to live build" link.
        `url` is the canonical bundle page (""=no bundle); the UI links to it."""
        url = f"{RUNBOT_BASE}/runbot/bundle/{urllib.parse.quote(branch)}"
        status, location, html, _ = self.io.http_get_nofollow(url)
        if status == 302:  # name match → the canonical bundle page
            url = urllib.parse.urljoin(RUNBOT_BASE, location)
            html, _ = self.io.http_get(url)
        elif status != 200:  # 301 (id-misresolve to a foreign bundle), 404, or error
            return {"result": "", "running": False, "url": ""}
        if not html:  # canonical page unreadable → fall back to the name-keyed badge
            s = self._badge(branch)
            r = s if s in ("success", "failure") else ""
            return {"result": r, "running": s == "pending", "url": url}
        m = re.search(r'rel="[^"]*icon"[^>]*href="[^"]*?icon_([a-z]+)\.', html)
        state = m.group(1) if m else ""
        result = "failure" if state in ("ko", "killed") else "success" if state == "ok" else ""
        parts = html.split('class="batch_tile', 1)
        latest = parts[1].split('class="batch_tile', 1)[0] if len(parts) > 1 else ""
        running = "bg-info-subtle" in latest or "fa-spin" in latest
        return {"result": result, "running": running, "url": url}

    def bundle_info(self, url: str | None) -> tuple[dict[str, Any] | None, str | None]:
        """The bundle a pasted runbot URL names: (info, error) with info =
        {name, branches, prs}. `name` is the bundle (= branch) name from the
        page title; `branches` lists the github repos carrying the branch (the
        page's `tree` links — dev forks for colleagues' work); `prs` the pull
        requests the bundle shows. Accepts canonical (/runbot/bundle/<id>) and
        name URLs — same 302-follow / 301-misresolve rules as _status."""
        m = re.match(r"https?://runbot\.odoo\.com(/runbot/bundle/[^\s?#]+)", (url or "").strip())
        if not m:
            return None, "not a runbot bundle URL (https://runbot.odoo.com/runbot/bundle/…)"
        status, location, html, _ = self.io.http_get_nofollow(RUNBOT_BASE + m.group(1))
        if status == 302:  # name URL → the canonical bundle page
            html, _ = self.io.http_get(urllib.parse.urljoin(RUNBOT_BASE, location))
        elif status != 200:  # 301 (id-misresolve), 404, or error
            return None, f"no such bundle (HTTP {status or 'unreachable'})"
        if not html:
            return None, "could not read the bundle page"
        tm = re.search(r"<title>\s*Bundle\s+([^<]+?)\s*</title>", html)
        if not tm:
            return None, "that page is not a runbot bundle"
        branches, prs, seen = [], [], set()
        for github, branch in re.findall(r'github\.com/([\w.-]+/[\w.-]+)/tree/([^"\s<>]+)', html):
            if ("t", github, branch) not in seen:
                seen.add(("t", github, branch))
                branches.append({"github": github, "branch": branch})
        for github, number in re.findall(r"github\.com/([\w.-]+/[\w.-]+)/pull/(\d+)", html):
            if ("p", github, number) not in seen:
                seen.add(("p", github, number))
                prs.append({"github": github, "number": int(number)})
        dumps = self.bundle_dumps(html)
        return {"name": tm.group(1), "branches": branches, "prs": prs, "dumps": dumps}, None

    # ── database dumps ───────────────────────────────────────────────────────
    # Every runbot build leaves its databases dumped next to its logs, as
    # <host>/runbot/static/build/<dest>/logs/<dest>-<db_suffix>.zip (an odoo dump:
    # dump.sql + filestore/) — that's the very URL runbot's own `restore` build step
    # downloads to seed a child build. The bundle page never links it, but the
    # <build-options-dropdown> element on each build slot carries all three parts as
    # data attributes, so we can address it ourselves. Used by "Restore runbot
    # database" in the create-workspace wizard — for a pasted bundle (bundle_info)
    # and for a workspace forked off a sticky series (dumps).

    _SLOT_NAME_RE = re.compile(r'class="[^"]*slot_name"[^>]*>\s*<span>\s*([^<]*?)\s*</span>')

    @staticmethod
    def _dump_url(host: str, dest: str, db: str) -> str:
        return f"https://{host}/runbot/static/build/{dest}/logs/{dest}-{db}.zip"

    @staticmethod
    def _data_attr(attrs: str, name: str) -> str:
        """One data-<name> value out of a raw tag's attribute string ("" if absent)."""
        m = re.search(rf'data-{name}="([^"]*)"', attrs)
        return html_lib.unescape(m.group(1)) if m else ""

    def dumps(self, branch: str, refresh: bool = False) -> list[dict[str, Any]]:
        """The dumps of `branch`'s bundle — "the runbot database for master / 19.0 /
        saas-19.4 / …", for a workspace forked off a sticky series rather than picked
        up from a pasted bundle URL. Works for any branch with a bundle (see
        _bundle_html for how each kind is resolved); [] when there's none, in which
        case the create form simply doesn't offer the restore.

        Cached under a tuple key, out of the way of the bare branch names the status
        cache uses — the create form asks on every open, and a bundle's latest batch
        doesn't change from one dialog to the next."""
        key = ("dumps", branch)
        if refresh:
            self.cache.invalidate(key)
        return self.cache.get(key, lambda: self._dumps(branch))

    def _dumps(self, branch: str) -> list[dict[str, Any]]:
        return self.bundle_dumps(self._bundle_html(branch))

    def sticky_bundles(self, refresh: bool = False) -> dict[str, str]:
        """{version: bundle id} for runbot's sticky (starred) series — master, 19.0,
        saas-19.4, … Cached under a tuple key, so it can never collide with the bare
        branch names the status cache uses. {} if the page can't be read."""
        key = ("sticky",)
        if refresh:
            self.cache.invalidate(key)
        return self.cache.get(key, self._fetch_sticky)

    def _fetch_sticky(self) -> dict[str, str]:
        html, err = self.io.http_get(f"{RUNBOT_BASE}/runbot/rd-1", timeout=20)
        return {} if err else dict(parse_starred_bundles(html))

    def _bundle_html(self, branch: str) -> str:
        """The bundle page for `branch` ("" when there's none to read).

        A sticky series is addressed by the bundle id runbot's own starred list gives
        it, never by name: /runbot/bundle/saas-19.4 redirects to `saas-194`, an
        unrelated (and private → 403) dev bundle, so name resolution silently answers
        for the wrong series. By id, the 301 to the canonical slug is the right
        canonicalization and is simply followed.

        Any other branch is a real branch name, resolved under the usual rules — a
        302 is a genuine name match, a 301 means runbot read a trailing "-<n>" as
        some other bundle's id (see _status)."""
        bundle_id = self.sticky_bundles().get(branch)
        if bundle_id:
            html, _ = self.io.http_get(f"{RUNBOT_BASE}/runbot/bundle/{bundle_id}")
            return html or ""
        url = f"{RUNBOT_BASE}/runbot/bundle/{urllib.parse.quote(branch)}"
        status, location, html, _ = self.io.http_get_nofollow(url)
        if status == 302:  # name match → the canonical bundle page
            html, _ = self.io.http_get(urllib.parse.urljoin(RUNBOT_BASE, location))
            return html or ""
        if status != 200:  # 301 (id-misresolve to a foreign bundle), 404, or error
            return ""
        return html or ""

    _MAX_BATCHES = 4  # how far back bundle_dumps looks for a batch that still has dumps

    def bundle_dumps(self, html: str) -> list[dict[str, Any]]:
        """[{build, slot, db, url, size}] — one entry per database dumped by the
        builds of the bundle's newest USABLE batch ("all" and "base" for the Community
        and Enterprise runs, "design-theme" for Design-themes; the Documentation build
        dumps none, and says so with an empty data-databases).

        Newest batch first, falling back to the one before it when that yields
        nothing — neither "the latest" nor "any" batch is the right one to read. A
        batch created moments ago has no build slots yet (runbot fills them in over
        the following minutes), and runbot prunes old builds' directories, so what we
        want is the newest batch that still HAS its dumps. Bounded to the few most
        recent, so a bundle whose dumps are all long gone costs a handful of probes
        rather than fifty.

        Each candidate is HEAD-probed (in parallel) and only offered if it is really
        still served — the alternative is letting the user tick a restore that only
        fails once the workspace has already been created — and that probe doubles as
        the size we label it with."""
        for tile in html.split('class="batch_tile')[1 : self._MAX_BATCHES + 1]:
            dumps = self._probe_dumps(self._batch_dump_candidates(tile))
            if dumps:
                return dumps
        return []

    def _batch_dump_candidates(self, tile: str) -> list[dict[str, str]]:
        """[{build, slot, db, url}] for one batch tile, read off its build slots' data
        attributes — before any check that the dump is still on disk."""
        candidates = []
        for container in tile.split('class="slot_container"')[1:]:
            attrs_m = re.search(r"<build-options-dropdown\b([^>]*)>", container)
            if not attrs_m:
                continue
            attrs = attrs_m.group(1)
            host = self._data_attr(attrs, "host")
            dest = self._data_attr(attrs, "dest")
            if not host or not dest:
                continue
            try:  # data-databases is a JSON list, e.g. ["all", "base"]
                databases = json.loads(self._data_attr(attrs, "databases") or "[]")
            except ValueError:
                continue
            slot_m = self._SLOT_NAME_RE.search(container)
            slot = slot_m.group(1) if slot_m else dest
            build = self._data_attr(attrs, "id")
            for db in databases:
                if isinstance(db, str) and db:
                    candidates.append(
                        {
                            "build": build,
                            "slot": slot,
                            "db": db,
                            "url": self._dump_url(host, dest, db),
                        }
                    )
        return candidates

    def _probe_dumps(self, candidates: list[dict[str, str]]) -> list[dict[str, Any]]:
        """The candidates whose zip is actually still served, each with its size."""
        if not candidates:
            return []
        with ThreadPoolExecutor(max_workers=min(8, len(candidates))) as pool:
            probes = list(pool.map(lambda c: self.io.http_head(c["url"]), candidates))
        return [
            {**c, "size": size}
            for c, (status, size, _err) in zip(candidates, probes, strict=False)
            if status == 200
        ]

    def _badge(self, branch: str) -> str:
        """Parse the runbot badge SVG: "success" / "failure" / "pending" / ""."""
        svg, _ = self.io.http_get(f"{RUNBOT_BASE}/runbot/badge/1/{urllib.parse.quote(branch)}.svg")
        if not svg:
            return ""
        texts = re.findall(r"<text[^>]*>([^<]*)</text>", svg)
        label = texts[-1].strip().lower() if texts else ""
        if "success" in label:
            return "success"
        if any(k in label for k in ("fail", "ko", "error", "killed")):
            return "failure"
        if any(k in label for k in ("pending", "running", "testing", "progress")):
            return "pending"
        return ""


# ─────────────────────────── Mergebot (HTML scraping) ───────────────────────

MERGEBOT_STATES = frozenset(
    (
        "merged",
        "staged",
        "staging",
        "blocked",
        "ready",
        "approved",
        "validated",
        "mergeable",
        "reviewed",
        "squashed",
        "pending",
        "error",
        "closed",
    )
)


class MergebotService:
    """Mergebot merge-queue state for a PR, scraped from mergebot.odoo.com."""

    def __init__(self, io: Any, cache: TTLCache) -> None:
        self.io = io
        self.cache = cache

    def statuses(
        self, prs: list[dict[str, Any]], refresh: bool = False
    ) -> tuple[dict[str, str], dict[str, str], dict[str, list[dict[str, Any]]], list[str]]:
        """Return ({"github#number": state}, {"github#number": detail},
        {"github#number": forward-port matrix}, [unsupported repos]) for the given
        PRs, cached per PR and fetched in parallel. Pass refresh=True to bypass the
        cache. `detail` (omitted when empty) lists the unmet merge requirements behind
        a blocked state, e.g. "Review, CI". Forward-port rows only contain branches
        after the requested PR's target branch; empty cells are retained so the UI can
        show branches which are still waiting for fw-bot.

        A repo is reported "unsupported" when, in this batch, at least one of its PRs
        404s (no mergebot page) and none of its PRs is reachable — so the caller can
        remember it and stop asking. A repo with one un-indexed 404 but another
        reachable PR is NOT unsupported (its reachable PR clears it)."""
        prs = [p for p in prs if p.get("github") and p.get("number")]
        if not prs:
            return {}, {}, {}, []
        if refresh:
            for p in prs:
                self.cache.invalidate(f"{p['github']}#{p['number']}")
        with ThreadPoolExecutor(max_workers=min(8, len(prs))) as pool:
            results = list(
                pool.map(
                    lambda p: self.cache.get(
                        f"{p['github']}#{p['number']}",
                        lambda p=p: self._status(p["github"], p["number"]),
                    ),
                    prs,
                )
            )
        states, details, forward_ports, reachable, missing = {}, {}, {}, set(), set()
        for p, (state, detail, ports, supported) in zip(prs, results, strict=False):
            key = f"{p['github']}#{p['number']}"
            states[key] = state
            if detail:
                details[key] = detail
            if supported:
                # An empty list is meaningful: the page was parsed, but this PR has
                # no subsequent branches. It also distinguishes a fetched merged PR
                # from a client-side persisted "merged" seed.
                forward_ports[key] = ports
            if supported is None:
                # transient failure — don't pin a blank for the whole TTL
                self.cache.invalidate(key)
            elif supported:
                reachable.add(p["github"])
            else:
                # 404 — the repo may genuinely not be on mergebot, OR the PR is just
                # too fresh to be indexed (a new PR appears within minutes). Report it
                # for this batch's unsupported bookkeeping, but drop the cache entry:
                # pinning the blank for the full TTL (8h) would hide the real state
                # long after mergebot picks the PR up. Callers dedup per session, so
                # the re-asks stay cheap.
                self.cache.invalidate(key)
                missing.add(p["github"])
        unsupported = sorted(missing - reachable)
        return states, details, forward_ports, unsupported

    def _status(
        self, github: str, number: int
    ) -> tuple[str, str, list[dict[str, Any]], bool | None]:
        """(merge state, detail, forward ports, supported).

        `supported` is False on a 404 and None on a transient failure. State is
        rendered inconsistently (a colored <p> for blocked/staged/ready/…, an alert
        <div> for merged/closed), so scan for the first colored element whose leading
        word is known. The same page's table is the authoritative forward-port chain.
        """
        html, err = self.io.http_get(f"{MERGEBOT_BASE}/{github}/pull/{number}")
        if err:
            return "", "", [], (False if "404" in err else None)
        state = ""
        for m in re.finditer(
            r'<\w+[^>]*class="[^"]*(?:\bbg-\w+|\balert\b)[^"]*"[^>]*>(.*?)</', html, re.S
        ):
            txt = re.sub(r"<[^>]+>", " ", m.group(1)).strip()
            if not txt:
                continue
            word = re.sub(r"[^a-z]", "", txt.split()[0].lower())
            if word in MERGEBOT_STATES:
                state = word
                break
        return state, self._blocked_reasons(html), self._forward_ports(html, github, number), True

    @staticmethod
    def _html_text(fragment: str) -> str:
        text = re.sub(r"<[^>]+>", " ", fragment)
        return re.sub(r"\s+", " ", html_lib.unescape(text)).strip()

    @staticmethod
    def _html_attr(attrs: str, name: str) -> str:
        match = re.search(rf"\b{re.escape(name)}\s*=\s*(?:\"([^\"]*)\"|'([^']*)')", attrs, re.I)
        return (
            (match.group(1) if match and match.group(1) is not None else match.group(2))
            if match
            else ""
        )

    def _forward_ports(self, html: str, github: str, number: int | str) -> list[dict[str, Any]]:
        """Parse the forward-port matrix below a PR and return subsequent rows.

        Each row keeps one cell per repository because linked community/enterprise
        chains can progress independently. A cell can contain multiple PRs (conflict
        resolutions sometimes create siblings), hence the nested ``pulls`` list.
        """
        table = re.search(
            r'<table\b[^>]*class="[^"]*\btable-bordered\b[^"]*"[^>]*>(.*?)</table>',
            html,
            re.S | re.I,
        )
        if not table:
            return []
        table_html = table.group(1)
        head = re.search(r"<thead\b[^>]*>(.*?)</thead>", table_html, re.S | re.I)
        if not head:
            return []
        repositories = [
            self._html_text(body)
            for _, body in re.findall(r"<th\b([^>]*)>(.*?)</th>", head.group(1), re.S | re.I)
        ][1:]
        repositories = [repo for repo in repositories if re.fullmatch(r"[^/\s]+/[^/\s]+", repo)]
        if not repositories:
            return []

        body = re.search(r"<tbody\b[^>]*>(.*?)</tbody>", table_html, re.S | re.I)
        if not body:
            return []
        rows = []
        target_index = None
        wanted_number = int(number)
        for _row_attrs, row_html in re.findall(
            r"<tr\b([^>]*)>(.*?)</tr>", body.group(1), re.S | re.I
        ):
            raw_cells = re.findall(r"<td\b([^>]*)>(.*?)</td>", row_html, re.S | re.I)
            if not raw_cells:
                continue
            branch = self._html_text(raw_cells[0][1])
            if not branch:
                continue
            cells = []
            contains_requested = False
            for repository, (cell_attrs, cell_html) in zip(
                repositories, raw_cells[1:], strict=False
            ):
                cell_classes = self._html_attr(cell_attrs, "class").split()
                pulls = []
                for span_attrs, span_html in re.findall(
                    r"<span\b([^>]*)>(.*?)</span>", cell_html, re.S | re.I
                ):
                    title = self._html_attr(span_attrs, "title")
                    details = [
                        self._html_text(sup)
                        for sup in re.findall(r"<sup\b[^>]*>(.*?)</sup>", span_html, re.S | re.I)
                    ]
                    detail = ", ".join(part for part in details if part)
                    for slug, pull_number in re.findall(
                        r'href=["\']/([^"\']+?/[^"\']+?)/pull/(\d+)["\']', span_html, re.I
                    ):
                        pull_number = int(pull_number)
                        category = "pending"
                        if "table-success" in cell_classes:
                            category = "success"
                        elif "table-warning" in cell_classes:
                            category = "warning"
                        elif "table-danger" in cell_classes:
                            category = "danger"
                        pulls.append(
                            {
                                "github": slug,
                                "number": pull_number,
                                "status": title or "pending",
                                "detail": detail,
                                "category": category,
                            }
                        )
                        if slug == github and pull_number == wanted_number:
                            contains_requested = True
                cells.append({"repository": repository, "pulls": pulls})
            rows.append({"branch": branch, "cells": cells})
            if contains_requested:
                target_index = len(rows) - 1

        if target_index is None:
            return []
        # The target row itself is already represented by the workspace checkout.
        return rows[target_index + 1 :]

    def _blocked_reasons(self, html: str) -> str:
        """The unmet merge requirements from the page's `todo` checklist: the labels
        of the top-level <li> items not marked satisfied (class 'ok'), joined like
        "Review, CI". Nested per-CI-check items begin with an <a>, so their empty
        leading text excludes them. Returns '' when nothing is unmet / no checklist."""
        start = re.search(r'<ul\b[^>]*class="[^"]*\btodo\b[^"]*"[^>]*>', html, re.I)
        if not start:
            return ""
        depth = 1
        end = len(html)
        for tag in re.finditer(r"</?ul\b[^>]*>", html[start.end() :], re.I):
            depth += -1 if tag.group(0).lower().startswith("</") else 1
            if depth == 0:
                end = start.end() + tag.start()
                break
        checklist = html[start.end() : end]
        reasons = []
        for m in re.finditer(r'<li(?:[^>]*\bclass="([^"]*)")?[^>]*>([^<]*)', checklist):
            label = re.sub(r"\s+", " ", m.group(2)).strip()
            if not label or "ok" in (m.group(1) or "").split():
                continue
            reasons.append(label)
        return ", ".join(reasons)[:200]


# ─────────────────────────── CI dashboard (mergebot stagings) ───────────────

# staging row colour → outcome. bg-info is in-progress (not a terminal state).
_STAGING_STATE = {
    "bg-success": "merged",
    "bg-danger": "failed",
    "bg-gray-lighter": "killed",
    "bg-info": "pending",
}
_STAGING_ROW_RE = re.compile(r'<tr\b[^>]*class="\s*(bg-[a-z-]+)\s*"[^>]*>(.*?)</tr>', re.S)
_STAGED_AT_RE = re.compile(r"Staged at (\d{4}-\d{2}-\d{2}) [\d:]+Z")
_PR_RE = re.compile(r"github\.com/([^/\s\"']+/[^/\s\"']+)/pull/(\d+)")
# the "Next >" link back in time: /runbot_merge/1?until=<datetime>&state=
_NEXT_UNTIL_RE = re.compile(r'href="/runbot_merge/\d+\?until=([^&"]*)&(?:amp;)?state=')


class CiService:
    """Per-day merge-queue stats scraped from the mergebot stagings page
    (mergebot.odoo.com/runbot_merge/<branch>, master = 1).

    Each colour-coded staging row is one "batch": bg-success = merged,
    bg-danger = failed, bg-gray-lighter = killed, bg-info = in-progress. Days are
    the UTC staged date. A completed day (before today UTC) is immutable, so once
    fully scanned its stats are persisted to disk and never re-fetched; only today
    (and any gap not yet cached) is fetched live."""

    MAX_PAGES = 40  # ~1 day/page — a hard stop so a parse miss can't loop forever

    def __init__(self, io: Any, cache_path: str, branch: int | str = 1) -> None:
        self.io = io
        self.cache_path = cache_path
        self.branch = branch

    # ── on-disk cache of immutable completed days ─────────────────────────────
    # {"oldest_complete": "YYYY-MM-DD" | None, "days": {"YYYY-MM-DD": {...}}}
    def _load_cache(self) -> dict[str, Any]:
        data, _ = self.io.read_json_file(self.cache_path)
        if not isinstance(data, dict):
            return {"oldest_complete": None, "days": {}}
        data.setdefault("days", {})
        data.setdefault("oldest_complete", None)
        return data

    def _save_cache(self, cache: dict[str, Any]) -> None:
        self.io.write_json_file(self.cache_path, cache)

    def _fetch_page(self, until: str | None) -> tuple[str, str | None]:
        url = f"{MERGEBOT_BASE}/runbot_merge/{self.branch}"
        if until:
            url += f"?until={urllib.parse.quote(until)}&state="
        return self.io.http_get(url, timeout=30)

    @staticmethod
    def _blank_day(d: str) -> dict[str, Any]:
        return {
            "date": d,
            "batches": 0,
            "merged": 0,
            "failed": 0,
            "killed": 0,
            "pending": 0,
            "prs_merged": 0,
        }

    @classmethod
    def _parse_page(cls, html: str) -> tuple[list[dict[str, Any]], str | None]:
        """Return (rows, next_until). rows = [{date, state, prs}] newest-first."""
        rows = []
        for cls_name, body in _STAGING_ROW_RE.findall(html):
            m = _STAGED_AT_RE.search(body)
            if not m:
                continue
            state = _STAGING_STATE.get(cls_name)
            if not state:
                continue
            prs = {f"{repo}#{num}" for repo, num in _PR_RE.findall(body)}
            rows.append({"date": m.group(1), "state": state, "prs": len(prs)})
        nxt = _NEXT_UNTIL_RE.search(html)
        return rows, (html_lib.unescape(nxt.group(1)) if nxt else None)

    def merge_stats(self, days: int = 14, refresh: bool = False) -> list[dict[str, Any]]:
        """Per-day stats for the last `days` days (today back), newest-first.

        Walks the stagings pages back in time, folding each row into its UTC day.
        Completed days already on disk are reused; only today (or an uncached gap)
        is fetched. Returns a list of day dicts."""
        today = datetime.now(timezone.utc).date()
        cutoff = today - timedelta(days=days - 1)
        cache = self._load_cache()
        if refresh:
            cache = {"oldest_complete": None, "days": {}}
        cached_days = cache["days"]
        oldest_complete = cache.get("oldest_complete")

        # if every completed day in the window is already cached, we only need to
        # rescan today; otherwise scan the whole window down to the cutoff.
        have_window = (
            not refresh and oldest_complete is not None and oldest_complete <= cutoff.isoformat()
        )
        target = today if have_window else cutoff  # stop once a row predates this

        fresh = {}  # date -> aggregated counters, from this run's live scan
        oldest_seen = None
        exhausted = False  # reached the end of mergebot's history (no "Next >")
        until = None
        for _ in range(self.MAX_PAGES):
            html, err = self._fetch_page(until)
            if err or not html:
                break
            rows, until = self._parse_page(html)
            if not rows:
                break
            for row in rows:
                d = row["date"]
                agg = fresh.setdefault(d, self._blank_day(d))
                agg["batches"] += 1
                agg[row["state"]] += 1
                if row["state"] == "merged":
                    agg["prs_merged"] += row["prs"]
            oldest_seen = rows[-1]["date"]
            if until is None:
                exhausted = True
                break
            if oldest_seen < target.isoformat():
                break

        # A freshly scanned day is complete once we've read past it — i.e. seen a
        # row strictly older (so no more of that day can be on a later page), or hit
        # the end of history. Persist the complete days that are before today (today
        # is always volatile), and advance the "everything from here to today is
        # covered" marker so the next call can skip them.
        today_iso = today.isoformat()

        def complete(d: str) -> bool:
            return d < today_iso and (exhausted or (oldest_seen is not None and d > oldest_seen))

        for d, agg in fresh.items():
            if complete(d):
                cached_days[d] = agg
        complete_days = [d for d in fresh if complete(d)]
        if complete_days:
            oldest_complete = (
                min(complete_days)
                if oldest_complete is None
                else min(oldest_complete, min(complete_days))
            )
        cache["oldest_complete"] = oldest_complete
        self._save_cache(cache)

        # assemble the window, newest first: today (and partial days) from the live
        # scan, completed days from cache, missing days as zeros.
        out = []
        d = today
        while d >= cutoff:
            iso = d.isoformat()
            if iso == today_iso:
                out.append(fresh.get(iso) or self._blank_day(iso))
            else:
                out.append(cached_days.get(iso) or fresh.get(iso) or self._blank_day(iso))
            d -= timedelta(days=1)
        return out

    def queue(self) -> int | None:
        """The current 'Awaiting' queue size for this branch — batches approved but
        not yet staged — scraped from the root runbot_merge dashboard. Volatile (the
        queue drains constantly), so uncached. Returns the PR count, or None if the
        page can't be read."""
        html, err = self.io.http_get(f"{MERGEBOT_BASE}/runbot_merge", timeout=30)
        if err or not html:
            return None
        # isolate this branch's block: its <h2><a href="/runbot_merge/<id>"> heading
        # up to the next branch/project heading
        start = html.find(f'href="/runbot_merge/{self.branch}"')
        if start == -1:
            return None
        rest = html[start:]
        nxt = re.search(r'href="/runbot_merge/\d+"', rest[1:])
        block = rest[: nxt.start() + 1] if nxt else rest
        # the Awaiting section is class="pr-listing pr-awaiting" (the Splits section is
        # "splits pr-awaiting"); count the PR links up to the next sibling <div>
        aw = re.search(r'class="[^"]*\bpr-listing pr-awaiting\b[^"]*"', block)
        if not aw:
            return 0
        seg = block[aw.end() :]
        end = seg.find("<div")
        if end != -1:
            seg = seg[:end]
        return len(re.findall(r"/pull/\d+", seg))


# ─────────────────────────── Memory (hoot [MEMINFO] logs) ───────────────────


class MemoryService:
    """Hoot [MEMINFO] memory-usage comparison across build log URLs the user
    picks explicitly. Not cached — the user is comparing a hand-picked set of
    builds, not polling for updates, so every "Draw graph" fetches fresh."""

    _MEMINFO_RE = re.compile(
        r".*(\.MobileWebSuite|\.WebSuite).*:\s+\[MEMINFO\]\s+([^ ]+)\s+\(after GC\)\s+-\s+used:\s+(\d+)"
    )

    # step names whose log offers [MEMINFO] lines — checked in this order, first
    # match wins, so a build offering both takes the dedicated qunit-only run
    _MEMINFO_STEP_NAMES = ("start_qunit_only", "test_only_no_limit_no_autotags")

    def __init__(self, io: Any) -> None:
        self.io = io

    def parse_log(self, text: str) -> list[tuple[str, int, bool]]:
        """[(suite_name, used_bytes, is_mobile)] from a hoot build log."""
        results = []
        for line in text.splitlines():
            if "[MEMINFO] @" not in line:
                continue
            m = self._MEMINFO_RE.match(line)
            if m:
                suite_type, suite_name, used = m.group(1), m.group(2), int(m.group(3))
                results.append((suite_name, used, suite_type == ".MobileWebSuite"))
        return results

    def fetch(
        self, builds: list[dict[str, Any]], with_mobile: bool = False
    ) -> list[dict[str, Any]]:
        """[{suite, <label>: bytes, ...}] — one row per suite, one column per
        build — for a list of {"label", "url"} builds fetched in parallel, or
        {"label", "content"} builds (a log uploaded from disk) parsed directly."""
        to_fetch = [b for b in builds if b.get("url") and not b.get("content")]

        def fetch_one(build: dict[str, Any]) -> tuple[str, list[tuple[str, int, bool]]]:
            html, err = self.io.http_get(build["url"], timeout=60)
            return build.get("label", ""), ([] if err else self.parse_log(html))

        per_build = {}
        if to_fetch:
            with ThreadPoolExecutor(max_workers=min(16, len(to_fetch))) as pool:
                per_build = dict(pool.map(fetch_one, to_fetch))
        for b in builds:
            if b.get("content"):
                per_build[b.get("label", "")] = self.parse_log(b["content"])

        rows, seen = [], {}
        for build in builds:
            label = build.get("label", "")
            for suite_name, used, is_mobile in per_build.get(label, []):
                if not with_mobile and is_mobile:
                    continue
                if suite_name not in seen:
                    seen[suite_name] = len(rows)
                    rows.append({"suite": suite_name})
                rows[seen[suite_name]][label] = used
        return rows

    def batch_builds(self, url: str) -> list[dict[str, str]]:
        """[{"label", "url"}] of raw step-log URLs (one of `_MEMINFO_STEP_NAMES`)
        for builds offering one of those steps on a runbot batch/build page —
        the Memory panel's bulk import of a batch's builds (fetch parses [MEMINFO] lines out of the raw log text,
        not a build's HTML page). The action dropdown itself is built
        client-side by runbot's JS from a <build-options-dropdown data-id
        data-log_list data-dest data-log_url> element, so we read those data
        attributes and construct the log URL directly rather than the
        (JS-rendered, never-present-in-the-fetched-HTML) <a> links. Runbot
        dropped the once-present `data-log_url` attribute, so the log host
        is now built from `data-host` instead. Not cached: a one-off user
        action, not a periodic poll."""
        if url.startswith("/"):
            url = f"{RUNBOT_BASE}{url}"
        html, err = self.io.http_get(url, timeout=20)
        if err or not html:
            return []
        builds, seen = [], set()
        for m in re.finditer(r"<build-options-dropdown\b([^>]*)>", html):
            attrs = m.group(1)
            log_list_m = re.search(r'data-log_list="([^"]*)"', attrs)
            if not log_list_m:
                continue
            log_list = html_lib.unescape(log_list_m.group(1))
            step = next((s for s in self._MEMINFO_STEP_NAMES if s in log_list), None)
            if not step:
                continue
            id_m = re.search(r'data-id="(\d+)"', attrs)
            dest_m = re.search(r'data-dest="([^"]*)"', attrs)
            host_m = re.search(r'data-host="([^"]*)"', attrs)
            if not id_m or not dest_m or not host_m:
                continue
            build_id = id_m.group(1)
            if build_id in seen:
                continue
            seen.add(build_id)
            log_url = f"https://{html_lib.unescape(host_m.group(1))}"
            dest = html_lib.unescape(dest_m.group(1))
            builds.append(
                {
                    "label": build_id,
                    "url": f"{log_url}/runbot/static/build/{dest}/logs/{step}.txt",
                }
            )
        return builds
