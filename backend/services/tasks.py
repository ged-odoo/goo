"""Odoo project tasks: the stage of the tasks a branch / PR refers to, read from
odoo.com's classic /web/dataset/call_kw RPC (the same one its own web client uses),
authenticated with the user's own odoo.com session cookie — pushed to goo by its
browser extension (extension/odoo-session/) and kept in memory only, never typed in
or written to disk. (/json/2/<model>/<method>, odoo.com's newer external API, is
built for its own API-key auth and rejects a plain session cookie outright.)"""

from typing import Any

ODOO_URL = "https://www.odoo.com"
SESSION_REJECTED = (
    "Odoo rejected the session (expired, or you're logged out of odoo.com)"
    " - open an odoo.com tab you're logged into"
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
        self, session_id: str, model: str, method: str, body: dict[str, Any]
    ) -> tuple[Any, str | None]:
        """One call_kw JSON-RPC call → (result, error); a rejected/expired session is
        the "session rejected" message. `body`'s "ids" (read/write/unlink's first,
        positional arg in call_kw's legacy ids-based dispatch — see odoo.api.call_kw)
        is split out of the kwargs dict every other method takes it as (domain,
        fields, …)."""
        body = dict(body)
        ids = body.pop("ids", None)
        payload = {
            "jsonrpc": "2.0",
            "method": "call",
            "params": {
                "model": model,
                "method": method,
                "args": [ids] if ids is not None else [],
                "kwargs": body,
            },
        }
        reply, error = self.io.http_post_json(
            f"{ODOO_URL}/web/dataset/call_kw",
            payload,
            headers={"Cookie": f"session_id={session_id}"},
            timeout=15,
        )
        if error is not None:
            # a real HTTP-level 401 is unusual for this endpoint (an expired/invalid
            # session normally comes back as a 200 carrying a JSON-RPC error, handled
            # below) but treat it the same way if it happens. A 403 is a different
            # thing -- access denied for this one call, not a rejected session -- so
            # it passes through as its own error, same as any other HTTP failure.
            return None, SESSION_REJECTED if error.startswith("HTTP 401") else error
        if not isinstance(reply, dict):
            return None, "unexpected reply from Odoo"
        rpc_error = reply.get("error")
        if rpc_error:
            name = str((rpc_error.get("data") or {}).get("name") or "")
            message = str(rpc_error.get("message") or "")
            if "SessionExpired" in name or "session expired" in message.lower():
                return None, SESSION_REJECTED
            return None, message or "Odoo rejected the request"
        return reply.get("result"), None

    def read(self, session_id: str, ids: list[int]) -> tuple[dict[str, dict[str, str]], str | None]:
        """{"<id>": {name, stage}} for the tasks of `ids` the session can read (one
        `search_read`, so an unreadable or deleted task is just absent), and an error
        message if the call failed. No ids is a valid call: it only checks the session."""
        if not session_id:
            return {}, "not connected to odoo.com yet"
        ids = sorted({i for i in ids if type(i) is int and i > 0})
        rows, error = self._call(
            session_id,
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

    def detail(self, session_id: str, task_id: int) -> tuple[dict[str, Any] | None, str | None]:
        """What the Task tab shows of one task: its main fields, description (HTML) and
        chatter (HTML messages, newest first). The names behind the assignees / tags and
        the chatter are best effort: a failed side call leaves them empty, never the tab."""
        if not session_id:
            return None, "not connected to odoo.com yet"
        rows, error = self._call(
            session_id,
            "project.task",
            "search_read",
            {"domain": [["id", "=", task_id]], "fields": TASK_FIELDS},
        )
        if error is not None:
            return None, error
        if not (isinstance(rows, list) and rows and isinstance(rows[0], dict)):
            return None, "this task does not exist, or the session cannot read it"
        task = rows[0]
        messages, messages_error = self._call(
            session_id,
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
        users = self._names(session_id, "res.users", task.get("user_ids"))
        tags = self._names(session_id, "project.tags", task.get("tag_ids"))
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

    def _names(self, session_id: str, model: str, ids: Any) -> dict[int, str]:
        """{id: name} for a many2many's ids; empty when there are none or the call fails."""
        if not (isinstance(ids, list) and ids):
            return {}
        rows, _ = self._call(session_id, model, "read", {"ids": ids, "fields": ["name"]})
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
