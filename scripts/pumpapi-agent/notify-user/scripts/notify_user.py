"""
Send a message to a user, regardless of platform.

Usage from any bot:

    from notify import notify
    notify("api_server", "0db44d63f25b499eb3d4f2a7338f29ae", "hello")
    notify("telegram",   "-1001234567890",                   "hello")
    notify("discord",    "999888777",                        "hello", thread_id="555")
    notify("api_server", chat_id, "see chart", image="/tmp/chart.png")

`platform` and `chat_id` are exactly what the agent receives in its
"Current Session Context" block — pass them through verbatim.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from typing import Optional

HERMES_LIB = "/usr/local/lib/hermes-agent"
APP_DB = "/root/pumpapi-agent/data/app.db"
NOTIFY_HOOK_URL = "http://127.0.0.1:61318/internal/notify"

if HERMES_LIB not in sys.path:
    sys.path.insert(0, HERMES_LIB)

# When this module is used from a standalone script (e.g. python test.py),
# Hermes CLI/gateway entrypoints are not running, so ~/.hermes/.env is not
# loaded into os.environ automatically. Load it here so TELEGRAM_BOT_TOKEN,
# DISCORD_BOT_TOKEN, etc. are available to send_message_tool.
try:
    from hermes_cli.env_loader import load_hermes_dotenv

    load_hermes_dotenv()
except Exception:
    # Keep notify importable even if Hermes env loading is unavailable; the
    # send step below will return the underlying configuration error.
    pass


def _write_to_website_chat(chat_id: str, text: str, image: Optional[str]) -> dict:
    """Append an assistant message to a website chat (app.db tree structure)."""
    now = time.time()
    attachments = json.dumps([{"path": image}]) if image else None

    with sqlite3.connect(APP_DB) as con:
        con.execute("BEGIN IMMEDIATE")

        row = con.execute(
            "SELECT root_message_id FROM chats WHERE id = ?", (chat_id,)
        ).fetchone()
        if not row or not row[0]:
            raise ValueError(f"chat {chat_id} not found or has no root message")

        # Walk active_child_id chain to the current leaf.
        leaf = row[0]
        while True:
            child = con.execute(
                "SELECT active_child_id FROM messages WHERE id = ?", (leaf,)
            ).fetchone()
            if not child or not child[0]:
                break
            leaf = child[0]

        content = text + (f"\nMEDIA:{image}" if image else "")
        cur = con.execute(
            "INSERT INTO messages(chat_id, parent_id, role, content, "
            "attachments, created_at) VALUES (?, ?, 'assistant', ?, ?, ?)",
            (chat_id, leaf, content, attachments, now),
        )
        msg_id = cur.lastrowid
        con.execute(
            "UPDATE messages SET active_child_id = ? WHERE id = ?", (msg_id, leaf)
        )
        con.execute("UPDATE chats SET updated_at = ? WHERE id = ?", (now, chat_id))

    _ping_sse(chat_id)
    return {"success": True, "platform": "api_server", "message_id": msg_id}


def _ping_sse(chat_id: str) -> None:
    """Wake up SSE subscribers in the running backend. Best-effort: any
    failure (backend down, network blip) is swallowed — the row is already
    in the DB, so a page reload would still show the message."""
    try:
        req = urllib.request.Request(
            NOTIFY_HOOK_URL,
            data=json.dumps({"chat_id": chat_id}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=1).close()
    except (urllib.error.URLError, OSError, TimeoutError):
        pass


def notify(
    platform: str,
    chat_id: str,
    text: str,
    thread_id: Optional[str] = None,
    image: Optional[str] = None,
) -> dict:
    """Deliver `text` (and optional `image`) to (`platform`, `chat_id`)."""
    if platform == "api_server":
        return _write_to_website_chat(chat_id, text, image)

    from tools.send_message_tool import send_message_tool

    target = f"{platform}:{chat_id}" + (f":{thread_id}" if thread_id else "")
    message = text + (f"\nMEDIA:{image}" if image else "")
    raw = send_message_tool({"action": "send", "target": target, "message": message})
    return json.loads(raw) if isinstance(raw, str) else raw
