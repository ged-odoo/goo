"""Odoo project tasks: the stage of the tasks a branch / PR refers to, read from
odoo.com through its JSON-2 API with the user's API key."""

from typing import Any

ODOO_URL = "https://www.odoo.com"
KEY_REJECTED = (
    "Odoo rejects the API key (invalid or expired: odoo.com keys last 90 days at most)"
    " - create a new one"
)


# the project.task fields the Task tab shows (all of them exist from Odoo 17 on)
TASK_FIELDS = [
    "name",
    "project_id",
    "stage_id",
    "user_ids",
    "tag_ids",
    "partner_id",
    "date_deadline",
    "priority",
    "description",
    "parent_id",
    "create_date",
    "write_date",
    "create_uid",
]
# project.task's priority selection; a level it does not know shows as nothing
PRIORITIES = {"0": "Low", "1": "Medium", "2": "High", "3": "Urgent"}
MESSAGE_LIMIT = 200
MESSAGE_FIELDS = ["date", "author_id", "email_from", "body", "message_type", "subtype_id"]


class TaskService:
    def __init__(self, io: Any) -> None:
        self.io = io

    def _call(
        self, api_key: str, model: str, method: str, body: dict[str, Any]
    ) -> tuple[Any, str | None]:
        """One JSON-2 call → (reply, error); a 401 is the "key rejected" message."""
        reply, error = self.io.http_post_json(
            f"{ODOO_URL}/json/2/{model}/{method}",
            body,
            headers={"Authorization": f"bearer {api_key}"},
            timeout=15,
        )
        if error is not None:
            return None, KEY_REJECTED if error.startswith("HTTP 401") else error
        return reply, None

    def read(self, api_key: str, ids: list[int]) -> tuple[dict[str, dict[str, str]], str | None]:
        """{"<id>": {name, stage}} for the tasks of `ids` the key can read (one
        `search_read`, so an unreadable or deleted task is just absent), and an error
        message if the call failed. No ids is a valid call: it only checks the key."""
        if not api_key:
            return {}, "GOO_ODOO_API_KEY is not set"
        ids = sorted({i for i in ids if type(i) is int and i > 0})
        rows, error = self._call(
            api_key,
            "project.task",
            "search_read",
            {"domain": [["id", "in", ids]], "fields": ["name", "stage_id"]},
        )
        if error is not None:
            return {}, error
        if not isinstance(rows, list):
            return {}, "unexpected reply from Odoo"
        return {
            str(row["id"]): {"name": row.get("name") or "", "stage": _m2o_name(row.get("stage_id"))}
            for row in rows
            if isinstance(row, dict) and isinstance(row.get("id"), int)
        }, None

    def detail(self, api_key: str, task_id: int) -> tuple[dict[str, Any] | None, str | None]:
        """What the Task tab shows of one task: its main fields, description (HTML) and
        chatter (HTML messages, newest first). The names behind the assignees / tags and
        the chatter are best effort: a failed side call leaves them empty, never the tab."""
        if not api_key:
            return None, "GOO_ODOO_API_KEY is not set"
        rows, error = self._call(
            api_key,
            "project.task",
            "search_read",
            {"domain": [["id", "=", task_id]], "fields": TASK_FIELDS},
        )
        if error is not None:
            return None, error
        if not (isinstance(rows, list) and rows and isinstance(rows[0], dict)):
            return None, "this task does not exist, or the key cannot read it"
        task = rows[0]
        messages, messages_error = self._call(
            api_key,
            "mail.message",
            "search_read",
            {
                "domain": [
                    ["model", "=", "project.task"],
                    ["res_id", "=", task_id],
                    ["message_type", "in", ["comment", "email", "email_outgoing"]],
                ],
                "fields": MESSAGE_FIELDS,
                "order": "date desc, id desc",
                "limit": MESSAGE_LIMIT,
            },
        )
        users = self._names(api_key, "res.users", task.get("user_ids"))
        tags = self._names(api_key, "project.tags", task.get("tag_ids"))
        return {
            "id": task_id,
            "name": task.get("name") or "",
            "project": _m2o_name(task.get("project_id")),
            "stage": _m2o_name(task.get("stage_id")),
            "assignees": [users.get(i, "") for i in task.get("user_ids") or [] if users.get(i)],
            "tags": [tags.get(i, "") for i in task.get("tag_ids") or [] if tags.get(i)],
            "customer": _m2o_name(task.get("partner_id")),
            "deadline": task.get("date_deadline") or "",
            "priority": PRIORITIES.get(str(task.get("priority")), ""),
            "parent": _m2o_name(task.get("parent_id")),
            "created": task.get("create_date") or "",
            "updated": task.get("write_date") or "",
            "created_by": _m2o_name(task.get("create_uid")),
            "description": task.get("description") or "",
            # the chatter is best effort: say so when it failed or was cut, not just "no message"
            "messages_error": messages_error or "",
            "messages_cut": isinstance(messages, list) and len(messages) >= MESSAGE_LIMIT,
            "messages": [
                {
                    "id": m.get("id"),
                    "date": m.get("date") or "",
                    "author": _m2o_name(m.get("author_id")) or m.get("email_from") or "",
                    "kind": _m2o_name(m.get("subtype_id")),
                    "body": m.get("body") or "",
                }
                for m in (messages if isinstance(messages, list) else [])
                if isinstance(m, dict)
            ],
        }, None

    def _names(self, api_key: str, model: str, ids: Any) -> dict[int, str]:
        """{id: name} for a many2many's ids; empty when there are none or the call fails."""
        if not (isinstance(ids, list) and ids):
            return {}
        rows, _ = self._call(api_key, model, "read", {"ids": ids, "fields": ["name"]})
        return {
            r["id"]: r.get("name") or ""
            for r in (rows if isinstance(rows, list) else [])
            if isinstance(r, dict) and isinstance(r.get("id"), int)
        }


def _m2o_name(value: Any) -> str:
    """The display name of a many2one value, which comes as [id, name] (or False)."""
    if isinstance(value, (list, tuple)) and len(value) > 1:
        return str(value[1])
    return ""
