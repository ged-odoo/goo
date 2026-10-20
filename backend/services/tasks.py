"""Odoo project tasks: the stage of the tasks a branch / PR refers to, read from an
Odoo instance (odoo.com by default) through its JSON-2 API with the user's API key."""

from typing import Any


class TaskService:
    def __init__(self, io: Any) -> None:
        self.io = io

    def read(
        self, url: str, api_key: str, ids: list[int], database: str = ""
    ) -> tuple[dict[str, dict[str, str]], str | None]:
        """{"<id>": {name, stage}} for the tasks of `ids` the key can read (one
        `search_read`, so an unreadable or deleted task is just absent), and an error
        message if the call failed. No ids is a valid call: it only checks the key."""
        if not (url and api_key):
            return {}, "GOO_ODOO_API_KEY is not set"
        ids = sorted({i for i in ids if isinstance(i, int) and i > 0})
        rows, error = self.io.http_post_json(
            f"{url.rstrip('/')}/json/2/project.task/search_read",
            {"domain": [["id", "in", ids]], "fields": ["name", "stage_id"]},
            headers={
                "Authorization": f"bearer {api_key}",
                **({"X-Odoo-Database": database} if database else {}),  # multi-database servers
            },
            timeout=15,
        )
        if error is not None:
            return {}, error
        if not isinstance(rows, list):
            return {}, "unexpected reply from Odoo"
        return {
            str(row["id"]): {"name": row.get("name") or "", "stage": _stage_name(row)}
            for row in rows
            if isinstance(row, dict) and isinstance(row.get("id"), int)
        }, None


def _stage_name(row: dict[str, Any]) -> str:
    """The stage's name from a many2one value, which comes as [id, name] (or id only)."""
    stage = row.get("stage_id")
    if isinstance(stage, (list, tuple)) and len(stage) > 1:
        return str(stage[1])
    return ""
