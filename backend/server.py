"""PumpApi Agent - lightweight aiohttp backend that proxies to Hermes api_server."""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import mimetypes
import os
import re
import sqlite3
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Optional

import aiohttp
from aiohttp import web

# ---------------------------------------------------------------------------
# Paths & config
# ---------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT / "frontend"
DATA_DIR = ROOT / "data"
UPLOADS_DIR = DATA_DIR / "uploads"
DB_PATH = DATA_DIR / "app.db"
MODELS_CACHE = DATA_DIR / "models.json"
HERMES_HOME = Path(os.path.expanduser("~/.hermes"))
HERMES_ENV = HERMES_HOME / ".env"
HERMES_MEM_DIR = HERMES_HOME / "memories"
HERMES_SKILLS_DIR = HERMES_HOME / "skills"

DATA_DIR.mkdir(parents=True, exist_ok=True)
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 61318 

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("pumpapi-agent")

ALLOWED_SETTING_KEYS = {
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_ALLOWED_USERS",
    "DISCORD_BOT_TOKEN",
    "DISCORD_ALLOWED_USERS",
    "WHATSAPP_ACCOUNT_SID",
    "WHATSAPP_AUTH_TOKEN",
    "WHATSAPP_FROM_NUMBER",
    "WHATSAPP_HOME_NUMBER",
}


def _parse_env(path: Path) -> dict:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip()
        if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
            v = v[1:-1]
        out[k] = v
    return out


def _load_config() -> dict:
    env = _parse_env(HERMES_ENV)
    cfg = {
        "PUMPAPI_API_KEY": env.get("PUMPAPI_API_KEY", ""),
        "API_SERVER_KEY": env.get("API_SERVER_KEY", ""),
        "API_SERVER_HOST": env.get("API_SERVER_HOST", "127.0.0.1"),
        "API_SERVER_PORT": env.get("API_SERVER_PORT", "61317"),
    }
    if not cfg["PUMPAPI_API_KEY"] or not cfg["API_SERVER_KEY"]:
        log.warning("Missing PUMPAPI_API_KEY or API_SERVER_KEY in %s", HERMES_ENV)
    return cfg


CONFIG = _load_config()
HERMES_URL = f"http://{CONFIG['API_SERVER_HOST']}:{CONFIG['API_SERVER_PORT']}/v1/chat/completions"

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    with db() as c:
        # 1. Bare-bones schema (CREATE TABLE IF NOT EXISTS only). New columns
        #    are added via ALTER below — keeping the CREATE clean lets us run
        #    CREATE INDEX safely on the (now fully-migrated) tables further down.
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS chats (
                id TEXT PRIMARY KEY,
                title TEXT,
                pinned INTEGER DEFAULT 0,
                created_at REAL,
                updated_at REAL,
                model TEXT
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id TEXT,
                role TEXT,
                content TEXT,
                attachments TEXT,
                created_at REAL,
                FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
            );
            """
        )
        # 2. Additive migrations (idempotent — checked via PRAGMA table_info).
        cols_chats = {r["name"] for r in c.execute("PRAGMA table_info(chats)").fetchall()}
        if "root_message_id" not in cols_chats:
            c.execute("ALTER TABLE chats ADD COLUMN root_message_id INTEGER")
        cols_msgs = {r["name"] for r in c.execute("PRAGMA table_info(messages)").fetchall()}
        if "parent_id" not in cols_msgs:
            c.execute("ALTER TABLE messages ADD COLUMN parent_id INTEGER")
        if "active_child_id" not in cols_msgs:
            c.execute("ALTER TABLE messages ADD COLUMN active_child_id INTEGER")
        if "tool_events" not in cols_msgs:
            c.execute("ALTER TABLE messages ADD COLUMN tool_events TEXT")
        # 3. Indexes (require all columns to exist first).
        c.execute("CREATE INDEX IF NOT EXISTS idx_msgs_chat ON messages(chat_id, id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_msgs_parent ON messages(parent_id)")
        # Sidebar list query: ORDER BY pinned DESC, updated_at DESC. Without an
        # index this scans the whole chats table on every list request — fine
        # at 100 chats, painful at 10k+. The composite (pinned, updated_at)
        # index lets SQLite stream rows in final order without sorting.
        c.execute(
            "CREATE INDEX IF NOT EXISTS idx_chats_sort "
            "ON chats(pinned DESC, updated_at DESC)"
        )
        # 4. Backfill linear parent/child chains for chats that pre-date the
        #    branching schema. Idempotent: only touches chats with no root set.
        chats_to_backfill = c.execute(
            "SELECT id FROM chats WHERE root_message_id IS NULL"
        ).fetchall()
        for ch in chats_to_backfill:
            cid = ch["id"]
            rows = c.execute(
                "SELECT id FROM messages WHERE chat_id=? ORDER BY id ASC", (cid,)
            ).fetchall()
            if not rows:
                continue
            ids = [r["id"] for r in rows]
            c.execute("UPDATE chats SET root_message_id=? WHERE id=?", (ids[0], cid))
            for prev, cur in zip(ids, ids[1:]):
                c.execute("UPDATE messages SET parent_id=? WHERE id=?", (prev, cur))
                c.execute("UPDATE messages SET active_child_id=? WHERE id=?", (cur, prev))


init_db()

# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
COOKIE_NAME = "papi_auth"


def is_authed(request: web.Request) -> bool:
    return request.cookies.get(COOKIE_NAME) == CONFIG["PUMPAPI_API_KEY"]


def require_auth(handler):
    async def inner(request: web.Request) -> web.StreamResponse:
        if not is_authed(request):
            return web.json_response({"error": "unauthorized"}, status=401)
        return await handler(request)

    return inner


def set_auth_cookie(resp: web.StreamResponse) -> None:
    resp.set_cookie(
        COOKIE_NAME,
        CONFIG["PUMPAPI_API_KEY"],
        httponly=True,
        max_age=60 * 60 * 24 * 365,
        path="/",
        samesite="Lax",
    )


# ---------------------------------------------------------------------------
# Static / page handlers
# ---------------------------------------------------------------------------

async def root_handler(request: web.Request) -> web.StreamResponse:
    key = request.query.get("key")
    if key and key == CONFIG["PUMPAPI_API_KEY"]:
        resp = web.HTTPFound("/")
        set_auth_cookie(resp)
        raise resp
    if not is_authed(request):
        raise web.HTTPFound("/login")
    return web.FileResponse(FRONTEND_DIR / "index.html")


async def login_page(request: web.Request) -> web.StreamResponse:
    return web.FileResponse(FRONTEND_DIR / "login.html")


async def serve_static(request: web.Request) -> web.StreamResponse:
    rel = request.match_info["filename"]
    # Normalise + prevent traversal
    safe = (FRONTEND_DIR / rel).resolve()
    if not str(safe).startswith(str(FRONTEND_DIR.resolve())):
        raise web.HTTPNotFound()
    if not safe.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(safe)


# ---------------------------------------------------------------------------
# Auth API
# ---------------------------------------------------------------------------

async def api_login(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid_json"}, status=400)
    ident = (body.get("identifier") or "").strip()
    if ident != CONFIG["PUMPAPI_API_KEY"]:
        return web.json_response({"error": "invalid_key"}, status=401)
    resp = web.json_response({"ok": True})
    set_auth_cookie(resp)
    return resp


async def api_logout(request: web.Request) -> web.Response:
    resp = web.json_response({"ok": True})
    resp.del_cookie(COOKIE_NAME, path="/")
    return resp


async def api_me(request: web.Request) -> web.Response:
    return web.json_response({"api_key": CONFIG["PUMPAPI_API_KEY"]})


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

async def api_models(request: web.Request) -> web.Response:
    if MODELS_CACHE.exists():
        try:
            cached = json.loads(MODELS_CACHE.read_text())
            if isinstance(cached, list) and cached:
                return web.json_response(cached)
        except Exception:
            pass
    # fetch from upstream
    headers = {"Authorization": f"Bearer {CONFIG['PUMPAPI_API_KEY']}"}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get("https://api.pumpapi.ai/v1/models", headers=headers, timeout=aiohttp.ClientTimeout(total=15)) as r:
                data = await r.json()
        items = data.get("data", []) if isinstance(data, dict) else []
        models = [{"id": m.get("id")} for m in items if m.get("id")]
        if not models:
            models = [{"id": "hermes-agent"}]
    except Exception as e:
        log.warning("models fetch failed: %s", e)
        models = [{"id": "hermes-agent"}]
    try:
        MODELS_CACHE.write_text(json.dumps(models))
    except Exception:
        pass
    return web.json_response(models)


# ---------------------------------------------------------------------------
# Chats CRUD
# ---------------------------------------------------------------------------

def _row_to_chat(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "title": r["title"] or "",
        "pinned": bool(r["pinned"]),
        "created_at": r["created_at"],
        "updated_at": r["updated_at"],
        "model": r["model"] or "",
    }


async def api_list_chats(request: web.Request) -> web.Response:
    """Cursor-paginated chat list for the sidebar.

    Query params:
      limit  — page size (default 50, max 200)
      cursor — opaque cursor from previous page's `next_cursor`. Encodes
               (pinned, updated_at, id) of the last item so we can resume
               in stable sort order even if rows are added/updated between
               requests.
      q      — optional case-insensitive substring match on title.

    Returns: {items: [...], next_cursor: str|None}

    Sort order: pinned DESC, updated_at DESC, id DESC (id breaks ties so
    cursor pagination is fully deterministic).
    """
    try:
        limit = int(request.query.get("limit", "50"))
    except ValueError:
        limit = 50
    limit = max(1, min(limit, 200))

    q = (request.query.get("q") or "").strip()
    cursor = request.query.get("cursor") or ""

    where = ["EXISTS(SELECT 1 FROM messages WHERE messages.chat_id = chats.id AND messages.role='user')"]
    params: list = []

    if q:
        where.append("LOWER(COALESCE(title, '')) LIKE ?")
        params.append(f"%{q.lower()}%")

    if cursor:
        try:
            raw = base64.urlsafe_b64decode(cursor.encode()).decode()
            cur_pinned, cur_updated, cur_id = raw.split("|", 2)
            cur_pinned_i = int(cur_pinned)
            cur_updated_f = float(cur_updated)
            # Tuple comparison: (pinned DESC, updated_at DESC, id DESC) means
            # "next page" = rows where (pinned, updated_at, id) <
            # (cur_pinned, cur_updated, cur_id) lexicographically with the
            # DESC ordering. SQLite doesn't natively compare tuples, so we
            # expand it manually.
            where.append(
                "(pinned < ? "
                " OR (pinned = ? AND updated_at < ?) "
                " OR (pinned = ? AND updated_at = ? AND id < ?))"
            )
            params.extend([
                cur_pinned_i,
                cur_pinned_i, cur_updated_f,
                cur_pinned_i, cur_updated_f, cur_id,
            ])
        except Exception:
            # Malformed cursor → start from the top instead of 400ing.
            pass

    sql = (
        "SELECT chats.* FROM chats "
        f"WHERE {' AND '.join(where)} "
        "ORDER BY pinned DESC, updated_at DESC, id DESC "
        "LIMIT ?"
    )
    # Fetch limit+1 to detect if there's a next page without a count query.
    params.append(limit + 1)

    with db() as c:
        rows = c.execute(sql, params).fetchall()

    has_more = len(rows) > limit
    rows = rows[:limit]
    items = [_row_to_chat(r) for r in rows]

    next_cursor = None
    if has_more and rows:
        last = rows[-1]
        token = f"{int(last['pinned'] or 0)}|{float(last['updated_at'] or 0)}|{last['id']}"
        next_cursor = base64.urlsafe_b64encode(token.encode()).decode()

    return web.json_response({"items": items, "next_cursor": next_cursor})


async def api_get_chat(request: web.Request) -> web.Response:
    """Fetch a single chat row by id. Used for optimistic refresh after
    create/rename/pin without reloading the whole list."""
    chat_id = request.match_info["chat_id"]
    with db() as c:
        row = c.execute("SELECT * FROM chats WHERE id=?", (chat_id,)).fetchone()
    if not row:
        return web.json_response({"error": "not_found"}, status=404)
    return web.json_response(_row_to_chat(row))


async def api_create_chat(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        body = {}
    chat_id = uuid.uuid4().hex
    now = time.time()
    model = (body or {}).get("model", "")
    with db() as c:
        c.execute(
            "INSERT INTO chats(id,title,pinned,created_at,updated_at,model) VALUES(?,?,?,?,?,?)",
            (chat_id, "", 0, now, now, model),
        )
    return web.json_response({"id": chat_id})


async def api_patch_chat(request: web.Request) -> web.Response:
    chat_id = request.match_info["chat_id"]
    try:
        body = await request.json()
    except Exception:
        body = {}
    fields = []
    values = []
    if "title" in body:
        fields.append("title=?")
        values.append(str(body["title"])[:200])
    if "pinned" in body:
        fields.append("pinned=?")
        values.append(1 if body["pinned"] else 0)
    if "model" in body:
        fields.append("model=?")
        values.append(str(body["model"])[:120])
    if not fields:
        return web.json_response({"ok": True})
    values.append(chat_id)
    with db() as c:
        c.execute(f"UPDATE chats SET {', '.join(fields)} WHERE id=?", values)
    return web.json_response({"ok": True})


async def api_delete_chat(request: web.Request) -> web.Response:
    chat_id = request.match_info["chat_id"]
    with db() as c:
        c.execute("DELETE FROM messages WHERE chat_id=?", (chat_id,))
        c.execute("DELETE FROM chats WHERE id=?", (chat_id,))
    return web.json_response({"ok": True})


def _row_to_msg(r: sqlite3.Row) -> dict:
    try:
        atts = json.loads(r["attachments"]) if r["attachments"] else []
    except Exception:
        atts = []
    try:
        tools = json.loads(r["tool_events"]) if r["tool_events"] else []
    except Exception:
        tools = []
    return {
        "id": r["id"],
        "chat_id": r["chat_id"],
        "role": r["role"],
        "content": r["content"] or "",
        "attachments": atts,
        "tool_events": tools,
        "created_at": r["created_at"],
        "parent_id": r["parent_id"],
        "active_child_id": r["active_child_id"],
    }


def _active_chain(c: sqlite3.Connection, chat_id: str) -> list[sqlite3.Row]:
    """Walk parent → active_child_id from the chat's root and return rows in order.

    Falls back to the legacy id-ascending order when no root is set (defensive —
    init_db backfills root_message_id on startup, so this should be rare).
    """
    chat = c.execute("SELECT root_message_id FROM chats WHERE id=?", (chat_id,)).fetchone()
    if not chat or not chat["root_message_id"]:
        return c.execute(
            "SELECT * FROM messages WHERE chat_id=? ORDER BY id ASC", (chat_id,)
        ).fetchall()
    out: list[sqlite3.Row] = []
    cur_id = chat["root_message_id"]
    seen: set[int] = set()
    while cur_id and cur_id not in seen:
        seen.add(cur_id)
        row = c.execute("SELECT * FROM messages WHERE id=?", (cur_id,)).fetchone()
        if not row:
            break
        out.append(row)
        cur_id = row["active_child_id"]
    return out


def _siblings(c: sqlite3.Connection, msg_id: int, chat_id: str, parent_id: Optional[int]) -> list[int]:
    """Return all sibling message IDs that share the same parent (including self), id-ASC."""
    if parent_id is None:
        # Roots: siblings are all messages in the chat with parent_id IS NULL
        rows = c.execute(
            "SELECT id FROM messages WHERE chat_id=? AND parent_id IS NULL ORDER BY id ASC",
            (chat_id,),
        ).fetchall()
    else:
        rows = c.execute(
            "SELECT id FROM messages WHERE parent_id=? ORDER BY id ASC",
            (parent_id,),
        ).fetchall()
    return [r["id"] for r in rows]


async def api_list_messages(request: web.Request) -> web.Response:
    chat_id = request.match_info["chat_id"]
    with db() as c:
        rows = _active_chain(c, chat_id)
        out = []
        for r in rows:
            m = _row_to_msg(r)
            sibs = _siblings(c, r["id"], chat_id, r["parent_id"])
            m["versions"] = sibs
            m["version_index"] = sibs.index(r["id"]) if r["id"] in sibs else 0
            m["version_count"] = len(sibs)
            out.append(m)
    return web.json_response(out)


async def api_patch_message(request: web.Request) -> web.Response:
    msg_id = int(request.match_info["msg_id"])
    try:
        body = await request.json()
    except Exception:
        body = {}
    fields, values = [], []
    if "content" in body:
        fields.append("content=?")
        values.append(str(body["content"]))
    if "attachments" in body:
        fields.append("attachments=?")
        values.append(json.dumps(body["attachments"] or []))
    if not fields:
        return web.json_response({"ok": True})
    values.append(msg_id)
    with db() as c:
        c.execute(f"UPDATE messages SET {', '.join(fields)} WHERE id=?", values)
    return web.json_response({"ok": True})


async def api_delete_message(request: web.Request) -> web.Response:
    msg_id = int(request.match_info["msg_id"])
    with db() as c:
        c.execute("DELETE FROM messages WHERE id=?", (msg_id,))
    return web.json_response({"ok": True})


# ---------------------------------------------------------------------------
# Uploads
# ---------------------------------------------------------------------------
TEXT_EXT = {".txt", ".md", ".log", ".csv", ".json", ".yaml", ".yml", ".py", ".js", ".ts", ".html", ".css", ".sh"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}


async def api_upload(request: web.Request) -> web.Response:
    reader = await request.multipart()
    field = await reader.next()
    while field is not None and field.name != "file":
        field = await reader.next()
    if field is None:
        return web.json_response({"error": "no_file"}, status=400)
    filename = field.filename or "upload.bin"
    ext = os.path.splitext(filename)[1].lower()
    file_id = uuid.uuid4().hex
    data = b""
    size = 0
    chunk_size = 64 * 1024
    while True:
        chunk = await field.read_chunk(chunk_size)
        if not chunk:
            break
        data += chunk
        size += len(chunk)
        if size > 25 * 1024 * 1024:
            return web.json_response({"error": "too_large"}, status=413)
    is_image = ext in IMAGE_EXT
    if not ext:
        # Sniff mime from content
        if data[:8].startswith(b"\x89PNG"):
            ext = ".png"; is_image = True
        elif data[:3] == b"\xff\xd8\xff":
            ext = ".jpg"; is_image = True
    out_name = f"{file_id}{ext or '.bin'}"
    out_path = UPLOADS_DIR / out_name
    out_path.write_bytes(data)
    mime = mimetypes.guess_type(filename)[0] or ("image/" + ext.lstrip(".") if is_image else "text/plain")
    kind = "image" if is_image else "text"
    return web.json_response({
        "id": file_id,
        "url": f"/api/uploads/{out_name}",
        "filename": filename,
        "type": kind,
        "mime": mime,
        "size": size,
    })


async def api_get_upload(request: web.Request) -> web.StreamResponse:
    name = request.match_info["name"]
    safe = (UPLOADS_DIR / name).resolve()
    if not str(safe).startswith(str(UPLOADS_DIR.resolve())) or not safe.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(safe)


# Whitelist of file extensions that can be served via /api/media. Mirrors what
# the assistant might emit via "MEDIA:/abs/path" (images, audio, video, common docs).
MEDIA_EXT_ALLOWED = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg",
    ".mp4", ".webm", ".mov",
    ".mp3", ".ogg", ".wav", ".m4a",
    ".txt", ".md", ".log", ".csv", ".json", ".yaml", ".yml", ".html", ".pdf",
}
# Only allow reading from these prefixes. Anything else → 403, even if the path
# resolves to a real file. This avoids leaking arbitrary host files via the cookie.
MEDIA_PATH_PREFIXES = (
    "/tmp/",
    "/root/.hermes/cache/",
    "/root/.hermes/audio_cache/",
    "/root/.hermes/uploads/",
    "/root/voice-memos/",
    str(UPLOADS_DIR) + "/",
)


async def api_get_media(request: web.Request) -> web.StreamResponse:
    """Serve a local file referenced by an absolute path (the "MEDIA:" convention).

    The assistant emits lines like "MEDIA:/tmp/foo.png" — Telegram resolves these
    natively. The web frontend post-processes the same lines and fetches them
    through this endpoint.
    """
    raw = request.query.get("path", "")
    if not raw:
        raise web.HTTPBadRequest(text="missing path")
    try:
        resolved = Path(raw).resolve(strict=True)
    except (OSError, RuntimeError):
        raise web.HTTPNotFound()
    p = str(resolved)
    if not any(p == pref.rstrip("/") or p.startswith(pref) for pref in MEDIA_PATH_PREFIXES):
        raise web.HTTPForbidden(text="path not allowed")
    if resolved.suffix.lower() not in MEDIA_EXT_ALLOWED:
        raise web.HTTPForbidden(text="extension not allowed")
    if not resolved.is_file():
        raise web.HTTPNotFound()
    ctype, _ = mimetypes.guess_type(str(resolved))
    headers = {"Cache-Control": "private, max-age=3600"}
    if ctype:
        headers["Content-Type"] = ctype
    return web.FileResponse(resolved, headers=headers)


# ---------------------------------------------------------------------------
# Settings (write-back to ~/.hermes/.env)
# ---------------------------------------------------------------------------

async def api_get_settings(request: web.Request) -> web.Response:
    env = _parse_env(HERMES_ENV)
    out = {k: env.get(k, "") for k in ALLOWED_SETTING_KEYS}
    return web.json_response(out)


# ---------------------------------------------------------------------------
# Model selection: write to hermes config + restart gateway so api_server
# rebuilds its AIAgent with the new model. The api_server platform reads
# model.default from ~/.hermes/config.yaml on startup — no in-process reload.
# ---------------------------------------------------------------------------

async def _run(*cmd: str, timeout: int = 20, max_output: int = 4000) -> tuple[bool, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            return False, "timeout"
        msg = (out or b"").decode("utf-8", "replace").strip()[:max_output]
        return proc.returncode == 0, msg
    except Exception as e:
        return False, str(e)[:200]


async def api_get_model(request: web.Request) -> web.Response:
    # Reads current model from hermes config (source of truth). No CLI 'get'
    # exists, so parse the YAML directly.
    try:
        import yaml
        cfg = yaml.safe_load(Path("/root/.hermes/config.yaml").read_text()) or {}
        return web.json_response({"model": (cfg.get("model") or {}).get("default") or ""})
    except Exception as e:
        return web.json_response({"model": "", "error": str(e)[:200]})


async def api_set_model(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid_json"}, status=400)
    model = (body.get("model") or "").strip()
    if not model or len(model) > 200:
        return web.json_response({"error": "bad_model"}, status=400)
    ok, msg = await _run("hermes", "config", "set", "model.default", model)
    if not ok:
        return web.json_response({"error": "config_set_failed", "detail": msg}, status=500)
    ok2, msg2 = await _run("systemctl", "restart", "hermes-gateway", timeout=90)
    if not ok2:
        return web.json_response({"error": "restart_failed", "detail": msg2}, status=500)
    return web.json_response({"ok": True, "model": model})


_GATEWAY_KEY_MAP = {
    "TELEGRAM_BOT_TOKEN": "hermes-gateway",
    "TELEGRAM_ALLOWED_USERS": "hermes-gateway",
    "DISCORD_BOT_TOKEN": "hermes-gateway",
    "DISCORD_ALLOWED_USERS": "hermes-gateway",
    "WHATSAPP_ACCOUNT_SID": "hermes-gateway",
    "WHATSAPP_AUTH_TOKEN": "hermes-gateway",
    "WHATSAPP_FROM_NUMBER": "hermes-gateway",
    "WHATSAPP_HOME_NUMBER": "hermes-gateway",
}


async def _restart_service(unit: str) -> tuple[bool, str]:
    """Restart a systemd unit. Returns (ok, message)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "systemctl", "restart", unit,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=15)
        except asyncio.TimeoutError:
            proc.kill()
            return False, "timeout"
        if proc.returncode == 0:
            return True, "ok"
        err = (stderr or b"").decode("utf-8", "replace").strip() or (stdout or b"").decode("utf-8", "replace").strip()
        return False, err[:200] or f"exit={proc.returncode}"
    except FileNotFoundError:
        return False, "systemctl not found"
    except Exception as e:
        return False, str(e)[:200]


async def api_post_settings(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid_json"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"error": "bad_body"}, status=400)
    updates: dict[str, str] = {}
    for k, v in body.items():
        if k in ALLOWED_SETTING_KEYS:
            updates[k] = "" if v is None else str(v)
    if not updates:
        return web.json_response({"ok": True, "updated": [], "restarted": []})

    # Snapshot previous values to determine what actually changed
    prev_env = _parse_env(HERMES_ENV)

    HERMES_ENV.parent.mkdir(parents=True, exist_ok=True)
    if HERMES_ENV.exists():
        lines = HERMES_ENV.read_text(encoding="utf-8").splitlines()
    else:
        lines = []
    seen: set[str] = set()
    new_lines: list[str] = []
    for raw in lines:
        m = re.match(r"^\s*([A-Z0-9_]+)\s*=", raw)
        if m and m.group(1) in updates:
            key = m.group(1)
            seen.add(key)
            new_lines.append(f"{key}={updates[key]}")
        else:
            new_lines.append(raw)
    for k, v in updates.items():
        if k not in seen:
            new_lines.append(f"{k}={v}")
    HERMES_ENV.write_text("\n".join(new_lines) + "\n", encoding="utf-8")

    # Determine which units need a restart based on actually-changed keys
    units_to_restart: set[str] = set()
    for k, v in updates.items():
        if prev_env.get(k, "") != v:
            unit = _GATEWAY_KEY_MAP.get(k)
            if unit:
                units_to_restart.add(unit)

    restarted: list[str] = []
    restart_errors: dict[str, str] = {}
    for unit in sorted(units_to_restart):
        ok, msg = await _restart_service(unit)
        if ok:
            restarted.append(unit)
            log.info("restarted %s after settings change", unit)
        else:
            restart_errors[unit] = msg
            log.warning("failed to restart %s: %s", unit, msg)

    resp: dict = {
        "ok": True,
        "updated": sorted(updates.keys()),
        "restarted": restarted,
    }
    if restart_errors:
        resp["restart_errors"] = restart_errors
    return web.json_response(resp)


# ---------------------------------------------------------------------------
# Memory / Skills / Tools / MCP
#
# Memory: plain markdown files at ~/.hermes/memories/{MEMORY,USER}.md. Reading
# and writing them directly IS editing the agent's memory — the memory_tool
# reloads from disk on every turn.
#
# Skills: a directory tree under ~/.hermes/skills/ — each skill is a folder
# with SKILL.md (+ optional references/templates/scripts/). We list installed
# skills and shell out to `hermes skills install/uninstall` for hub installs.
# Local installs (paste SKILL.md) write directly into ~/.hermes/skills/local/.
#
# Tools: built-in toolsets are listed/enabled/disabled via `hermes tools`.
# We shell out and parse the human-readable output (no JSON mode exists yet).
#
# MCP: `hermes mcp list / add / remove`. Same human-output parsing.
# ---------------------------------------------------------------------------

_MEM_TARGETS = {"MEMORY", "USER"}


def _mem_path(target: str) -> Path:
    return HERMES_MEM_DIR / f"{target}.md"


async def api_get_memory(request: web.Request) -> web.Response:
    target = (request.match_info.get("target") or "").upper()
    if target not in _MEM_TARGETS:
        return web.json_response({"error": "bad_target"}, status=400)
    p = _mem_path(target)
    content = p.read_text(encoding="utf-8") if p.exists() else ""
    return web.json_response({"target": target, "content": content})


async def api_put_memory(request: web.Request) -> web.Response:
    target = (request.match_info.get("target") or "").upper()
    if target not in _MEM_TARGETS:
        return web.json_response({"error": "bad_target"}, status=400)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid_json"}, status=400)
    content = body.get("content")
    if not isinstance(content, str):
        return web.json_response({"error": "bad_content"}, status=400)
    if len(content) > 500_000:
        return web.json_response({"error": "too_large"}, status=413)
    HERMES_MEM_DIR.mkdir(parents=True, exist_ok=True)
    _mem_path(target).write_text(content, encoding="utf-8")
    return web.json_response({"ok": True})


# ---- Skills --------------------------------------------------------------

def _safe_skill_name(name: str) -> Optional[str]:
    """Names must be [a-z0-9_-], 1..64 chars. Matches hermes' own validator."""
    if not name or not isinstance(name, str):
        return None
    name = name.strip().lower()
    if not re.fullmatch(r"[a-z0-9_-]{1,64}", name):
        return None
    return name


def _find_skill_dir(name: str) -> Optional[Path]:
    """Skills live one or two levels deep (skills/<name>/ OR skills/<cat>/<name>/)."""
    safe = _safe_skill_name(name)
    if not safe:
        return None
    direct = HERMES_SKILLS_DIR / safe / "SKILL.md"
    if direct.exists():
        return direct.parent
    for cat in HERMES_SKILLS_DIR.iterdir():
        if not cat.is_dir():
            continue
        p = cat / safe / "SKILL.md"
        if p.exists():
            return p.parent
    return None


def _parse_skill_frontmatter(path: Path) -> dict:
    """Extract `name`, `description` from a SKILL.md frontmatter block. Cheap
    and tolerant — no full YAML parser."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return {}
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end == -1:
        return {}
    fm = text[3:end]
    out: dict[str, str] = {}
    for line in fm.splitlines():
        m = re.match(r"^([a-zA-Z_]+)\s*:\s*(.+)$", line)
        if m:
            v = m.group(2).strip().strip('"').strip("'")
            out[m.group(1)] = v
    return out


def _list_skills() -> list[dict]:
    out: list[dict] = []
    if not HERMES_SKILLS_DIR.exists():
        return out
    # Bundled skills can't be uninstalled — load the manifest once and tag them
    # so the UI can hide/disable the Delete button.
    bundled_names: set[str] = set()
    bundled = HERMES_SKILLS_DIR / ".bundled_manifest"
    if bundled.exists():
        try:
            for ln in bundled.read_text("utf-8").splitlines():
                ln = ln.strip()
                if ln:
                    bundled_names.add(ln.split(":", 1)[0].strip())
        except Exception:
            pass
    for entry in sorted(HERMES_SKILLS_DIR.iterdir()):
        if not entry.is_dir():
            continue
        # Direct skill (no category)?
        if (entry / "SKILL.md").exists():
            fm = _parse_skill_frontmatter(entry / "SKILL.md")
            nm = fm.get("name") or entry.name
            out.append({
                "name": nm,
                "category": "",
                "description": fm.get("description", ""),
                "bundled": nm in bundled_names,
            })
            continue
        # Category directory — list nested skills
        for sub in sorted(entry.iterdir()):
            if sub.is_dir() and (sub / "SKILL.md").exists():
                fm = _parse_skill_frontmatter(sub / "SKILL.md")
                nm = fm.get("name") or sub.name
                out.append({
                    "name": nm,
                    "category": entry.name,
                    "description": fm.get("description", ""),
                    "bundled": nm in bundled_names,
                })
    return out


async def api_list_skills(request: web.Request) -> web.Response:
    return web.json_response({"items": _list_skills()})


async def api_get_skill(request: web.Request) -> web.Response:
    name = request.match_info.get("name", "")
    sdir = _find_skill_dir(name)
    if not sdir:
        return web.json_response({"error": "not_found"}, status=404)
    content = (sdir / "SKILL.md").read_text(encoding="utf-8", errors="replace")
    # Bundled skills live in a tree we shouldn't mutate (next agent update
    # would overwrite them) — surface that so the UI can show a read-only mode.
    bundled = False
    try:
        manifest = HERMES_SKILLS_DIR / ".bundled_manifest"
        if manifest.exists():
            names = {ln.split(":", 1)[0].strip() for ln in manifest.read_text("utf-8").splitlines() if ln.strip()}
            bundled = name in names or sdir.name in names
    except Exception:
        pass
    return web.json_response({"name": sdir.name, "content": content, "bundled": bundled, "editable": not bundled})


async def api_update_skill(request: web.Request) -> web.Response:
    """Overwrite SKILL.md for a non-bundled skill."""
    name = request.match_info.get("name", "")
    sdir = _find_skill_dir(name)
    if not sdir:
        return web.json_response({"error": "not_found"}, status=404)
    # Block edits to bundled skills — they'd get clobbered on next agent update.
    manifest = HERMES_SKILLS_DIR / ".bundled_manifest"
    if manifest.exists():
        try:
            names = {ln.split(":", 1)[0].strip() for ln in manifest.read_text("utf-8").splitlines() if ln.strip()}
            if name in names or sdir.name in names:
                return web.json_response({"error": "bundled", "detail": "Bundled skills can't be edited — duplicate it under a new name."}, status=400)
        except Exception:
            pass
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid_json"}, status=400)
    content = body.get("content")
    if not isinstance(content, str) or not content.strip():
        return web.json_response({"error": "empty"}, status=400)
    (sdir / "SKILL.md").write_text(content, encoding="utf-8")
    asyncio.create_task(_restart_gateway())  # fire-and-forget so the new text loads
    return web.json_response({"ok": True})


async def api_install_skill(request: web.Request) -> web.Response:
    """Two modes:
      - {source: 'paste', name, content}: write SKILL.md to skills/local/<name>/
      - {source: 'github', url}: shell out to `hermes skills install <url>`
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid_json"}, status=400)
    source = body.get("source")
    if source == "paste":
        name = _safe_skill_name(body.get("name") or "")
        content = body.get("content") or ""
        if not name:
            return web.json_response({"error": "bad_name"}, status=400)
        if not isinstance(content, str) or not content.strip():
            return web.json_response({"error": "empty_content"}, status=400)
        if len(content) > 500_000:
            return web.json_response({"error": "too_large"}, status=413)
        if _find_skill_dir(name):
            return web.json_response({"error": "already_exists"}, status=409)
        sdir = HERMES_SKILLS_DIR / "local" / name
        sdir.mkdir(parents=True, exist_ok=True)
        (sdir / "SKILL.md").write_text(content, encoding="utf-8")
        await _restart_gateway()
        return web.json_response({"ok": True, "name": name, "path": str(sdir)})
    if source == "github":
        url = (body.get("url") or "").strip()
        # Cheap allow-list: github.com URLs OR plain owner/repo[/path] form.
        if not re.match(r"^(https?://(www\.)?github\.com/|[\w.-]+/[\w.-]+)", url):
            return web.json_response({"error": "bad_url"}, status=400)
        ok, msg = await _run("hermes", "skills", "install", url, timeout=120)
        if not ok:
            return web.json_response({"error": "install_failed", "detail": msg}, status=500)
        await _restart_gateway()
        return web.json_response({"ok": True, "output": msg[-1000:]})
    return web.json_response({"error": "bad_source"}, status=400)


async def api_delete_skill(request: web.Request) -> web.Response:
    name = request.match_info.get("name", "")
    sdir = _find_skill_dir(name)
    if not sdir:
        return web.json_response({"error": "not_found"}, status=404)
    # Bundled skills (shipped with Hermes) cannot be removed — they live
    # in skills/<category>/<name> and are listed in skills/.bundled_manifest.
    bundled = HERMES_SKILLS_DIR / ".bundled_manifest"
    if bundled.exists():
        try:
            names = {ln.split(":", 1)[0].strip() for ln in bundled.read_text("utf-8").splitlines() if ln.strip()}
            if name in names:
                return web.json_response({"error": "bundled", "detail": "This skill ships with the agent and can't be removed."}, status=400)
        except Exception:
            pass
    # Local skills (under skills/local/) — just rm the dir.
    try:
        rel = sdir.relative_to(HERMES_SKILLS_DIR)
    except ValueError:
        return web.json_response({"error": "outside_skills_dir"}, status=400)
    if rel.parts and rel.parts[0] == "local":
        import shutil
        shutil.rmtree(sdir, ignore_errors=True)
        asyncio.create_task(_restart_gateway())  # fire-and-forget — UX stays snappy
        return web.json_response({"ok": True, "method": "rm"})
    # Hub skills: `hermes skills uninstall` is interactive (Confirm [y/N]).
    # Feed it y\n via stdin so the agent actually removes the skill.
    try:
        proc = await asyncio.create_subprocess_exec(
            "hermes", "skills", "uninstall", sdir.name,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await asyncio.wait_for(proc.communicate(input=b"y\n"), timeout=60)
    except asyncio.TimeoutError:
        proc.kill()
        return web.json_response({"error": "timeout"}, status=504)
    msg = (out or b"").decode("utf-8", "replace")[-2000:]
    # CLI returns 0 even on logical failures ("not a hub-installed skill") —
    # surface that to the user instead of pretending success.
    if proc.returncode != 0 or "Error:" in msg or "not a hub-installed" in msg:
        return web.json_response({"error": "uninstall_failed", "detail": msg}, status=500)
    asyncio.create_task(_restart_gateway())  # fire-and-forget
    return web.json_response({"ok": True, "method": "hermes_uninstall", "output": msg[-500:]})


# ---- Tools / MCP ---------------------------------------------------------

_RE_TOOL_LINE = re.compile(
    r"^\s*(?P<state>✓\s*enabled|✗\s*disabled)\s+(?P<name>\S+)\s+(?P<label>.+?)\s*$"
)


async def api_list_tools(request: web.Request) -> web.Response:
    """Parse `hermes tools list` output. Each tool: {name, label, enabled}."""
    ok, out = await _run("hermes", "tools", "list", timeout=20, max_output=20000)
    if not ok:
        return web.json_response({"error": "list_failed", "detail": out}, status=500)
    items: list[dict] = []
    for raw in out.splitlines():
        m = _RE_TOOL_LINE.match(raw)
        if not m:
            continue
        items.append({
            "name": m.group("name"),
            "label": m.group("label").strip(),
            "enabled": "enabled" in m.group("state"),
        })
    return web.json_response({"items": items})


async def _restart_gateway() -> tuple[bool, str]:
    """Restart hermes-gateway to pick up tool / skill / MCP / config changes.
    The api_server holds its config + skill registry in memory at startup,
    so any change made via `hermes config set` / `hermes tools enable` etc.
    only takes effect after the gateway process is restarted."""
    return await _run("systemctl", "restart", "hermes-gateway", timeout=90)


async def api_toggle_tool(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid_json"}, status=400)
    name = (body.get("name") or "").strip()
    enable = bool(body.get("enable"))
    # Tool names are lowercase letters/digits/underscore (e.g. web, image_gen, computer_use)
    if not re.fullmatch(r"[a-zA-Z0-9_:.-]{1,64}", name):
        return web.json_response({"error": "bad_name"}, status=400)
    action = "enable" if enable else "disable"
    ok, msg = await _run("hermes", "tools", action, name, timeout=20)
    if not ok:
        return web.json_response({"error": "toggle_failed", "detail": msg}, status=500)
    # Gateway restart required — the running api_server caches enabled toolsets
    # at startup; without restart the change persists in config but the agent
    # keeps using the old set.
    ok2, msg2 = await _restart_gateway()
    return web.json_response({
        "ok": True,
        "output": msg[-500:],
        "restarted": ok2,
        "restart_error": None if ok2 else msg2[-200:],
    })


async def api_list_mcp(request: web.Request) -> web.Response:
    """Read MCP servers straight from ~/.hermes/config.yaml — more reliable
    than parsing the columnar `hermes mcp list` output. Returns a list of
    {name, url, enabled} objects."""
    items: list[dict] = []
    try:
        import yaml  # lazy import — yaml ships with hermes
        cfg_path = HERMES_HOME / "config.yaml"
        if cfg_path.exists():
            with cfg_path.open("r", encoding="utf-8") as f:
                cfg = yaml.safe_load(f) or {}
            servers = cfg.get("mcp_servers") or {}
            for name, spec in servers.items():
                if not isinstance(spec, dict):
                    continue
                items.append({
                    "name": name,
                    "url": spec.get("url") or spec.get("command") or "",
                    "enabled": spec.get("enabled", True),
                })
    except Exception as exc:
        return web.json_response({"error": "list_failed", "detail": str(exc)}, status=500)
    return web.json_response({"servers": items, "empty": not items})


async def api_add_mcp(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid_json"}, status=400)
    name = (body.get("name") or "").strip()
    url = (body.get("url") or "").strip()
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", name):
        return web.json_response({"error": "bad_name"}, status=400)
    if not re.match(r"^https?://", url):
        return web.json_response({"error": "bad_url"}, status=400)
    # `hermes mcp add` is interactive — it prompts for auth and tool-selection.
    # We answer the prompts via stdin: "n\n" = no auth, "y\n" = enable all tools,
    # plus a "y\n" fallback if connection fails (save config anyway).
    try:
        proc = await asyncio.create_subprocess_exec(
            "hermes", "mcp", "add", name, "--url", url,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        try:
            out, _ = await asyncio.wait_for(
                proc.communicate(input=b"n\ny\ny\n"), timeout=90
            )
        except asyncio.TimeoutError:
            proc.kill()
            return web.json_response({"error": "timeout"}, status=504)
        msg = (out or b"").decode("utf-8", "replace")[-2000:]
        if proc.returncode != 0:
            return web.json_response({"error": "add_failed", "detail": msg}, status=500)
        ok2, _ = await _restart_gateway()
        return web.json_response({"ok": True, "output": msg[-500:], "restarted": ok2})
    except Exception as e:
        return web.json_response({"error": "exception", "detail": str(e)[:200]}, status=500)


async def api_remove_mcp(request: web.Request) -> web.Response:
    name = (request.match_info.get("name") or "").strip()
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", name):
        return web.json_response({"error": "bad_name"}, status=400)
    # `hermes mcp remove` asks "Remove server? [Y/n]" — feed it y\n via stdin.
    try:
        proc = await asyncio.create_subprocess_exec(
            "hermes", "mcp", "remove", name,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await asyncio.wait_for(proc.communicate(input=b"y\n"), timeout=30)
    except asyncio.TimeoutError:
        proc.kill()
        return web.json_response({"error": "timeout"}, status=504)
    msg = (out or b"").decode("utf-8", "replace")[-2000:]
    if proc.returncode != 0:
        return web.json_response({"error": "remove_failed", "detail": msg}, status=500)
    ok2, _ = await _restart_gateway()
    return web.json_response({"ok": True, "output": msg[-500:], "restarted": ok2})


# ---------------------------------------------------------------------------
# Streaming chat
# ---------------------------------------------------------------------------

def _build_messages(chat_id: str) -> list[dict]:
    """Build the OpenAI-format messages array from the ACTIVE chain in the DB."""
    with db() as c:
        rows = _active_chain(c, chat_id)
    out: list[dict] = []
    for r in rows:
        role = r["role"]
        content = r["content"] or ""
        try:
            atts = json.loads(r["attachments"]) if r["attachments"] else []
        except Exception:
            atts = []
        if role == "user" and atts:
            # Build vision-style content; pre-pend any text-attachment as a fenced block.
            text = content
            for a in atts:
                if a.get("type") == "text" and a.get("preview"):
                    fname = a.get("filename") or "attachment.txt"
                    text = f"```{fname}\n{a['preview']}\n```\n\n" + text
            parts: list[dict] = []
            if text:
                parts.append({"type": "text", "text": text})
            for a in atts:
                if a.get("type") == "image" and a.get("data_uri"):
                    parts.append({"type": "image_url", "image_url": {"url": a["data_uri"]}})
            if parts and any(p["type"] == "image_url" for p in parts):
                out.append({"role": "user", "content": parts})
            else:
                # All-text — flatten
                flat = "\n".join(p.get("text", "") for p in parts) if parts else content
                out.append({"role": "user", "content": flat})
        else:
            out.append({"role": role, "content": content})
    return out


def _last_active_id(c: sqlite3.Connection, chat_id: str) -> Optional[int]:
    """Return the id of the last message in the active chain (the leaf), or None."""
    chain = _active_chain(c, chat_id)
    return chain[-1]["id"] if chain else None


# Active background streaming tasks keyed by assistant message id. Lets a
# reloaded tab "subscribe" to an in-progress generation by reading rows the
# task is updating in the DB. The task itself doesn't care if the client
# disconnects — it keeps reading upstream and writing to the DB until done.
_ACTIVE_STREAMS: dict[int, asyncio.Queue] = {}


async def _run_upstream_stream(
    chat_id: str,
    user_msg_id: int,
    assistant_id: int,
    payload: dict,
    headers: dict,
    fanout: asyncio.Queue,
) -> None:
    """Read the upstream SSE stream, accumulate content + tool events, and
    persist to the DB throttled every PERSIST_EVERY seconds. Fans out raw
    chunks to `fanout` for the (possibly already-disconnected) HTTP client.

    Runs as a top-level asyncio task — survives client disconnects.
    """
    accumulated = ""
    tool_events: list[dict] = []
    tool_index: dict[str, int] = {}
    PERSIST_EVERY = 0.5

    def persist_partial() -> None:
        try:
            with db() as c:
                c.execute(
                    "UPDATE messages SET content=?, tool_events=? WHERE id=?",
                    (accumulated, json.dumps(tool_events) if tool_events else None, assistant_id),
                )
        except Exception:
            pass

    last_persist = time.time()
    timeout = aiohttp.ClientTimeout(total=None, sock_read=600)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as sess:
            async with sess.post(HERMES_URL, json=payload, headers=headers) as upstream:
                if upstream.status != 200:
                    err_body = await upstream.text()
                    log.warning("upstream %s: %s", upstream.status, err_body[:300])
                    err_evt = json.dumps({"error": f"upstream_status_{upstream.status}", "detail": err_body[:500]})
                    await fanout.put(f"event: error\ndata: {err_evt}\n\n".encode())
                    await fanout.put(b"data: [DONE]\n\n")
                    return

                buffer = b""
                async for chunk in upstream.content.iter_any():
                    if not chunk:
                        continue
                    await fanout.put(chunk)

                    buffer += chunk
                    while b"\n\n" in buffer:
                        block, buffer = buffer.split(b"\n\n", 1)
                        try:
                            txt = block.decode("utf-8", errors="replace")
                        except Exception:
                            continue
                        evt_name = "message"
                        data_payload = None
                        for line in txt.splitlines():
                            if line.startswith("event:"):
                                evt_name = line[6:].strip()
                            elif line.startswith("data:"):
                                data_payload = line[5:].strip()
                        if not data_payload or data_payload == "[DONE]":
                            continue
                        if evt_name == "hermes.tool.progress":
                            try:
                                obj = json.loads(data_payload)
                            except Exception:
                                continue
                            tcid = obj.get("toolCallId")
                            if not tcid:
                                continue
                            if tcid in tool_index:
                                idx = tool_index[tcid]
                                tool_events[idx].update({
                                    k: obj.get(k) for k in ("status", "label", "emoji", "tool") if obj.get(k) is not None
                                })
                            else:
                                tool_index[tcid] = len(tool_events)
                                tool_events.append({
                                    "toolCallId": tcid,
                                    "tool": obj.get("tool") or "",
                                    "emoji": obj.get("emoji") or "🔧",
                                    "label": obj.get("label") or obj.get("tool") or "",
                                    "status": obj.get("status") or "running",
                                })
                            continue
                        try:
                            obj = json.loads(data_payload)
                        except Exception:
                            continue
                        try:
                            choices = obj.get("choices") or []
                            if choices:
                                delta = choices[0].get("delta") or {}
                                content = delta.get("content")
                                if isinstance(content, str):
                                    accumulated += content
                        except Exception:
                            pass
                    now_t = time.time()
                    if now_t - last_persist >= PERSIST_EVERY:
                        persist_partial()
                        last_persist = now_t
    except Exception as e:
        log.exception("upstream error: %s", e)
        try:
            err_evt = json.dumps({"error": "upstream_exception", "detail": str(e)[:500]})
            await fanout.put(f"event: error\ndata: {err_evt}\n\n".encode())
        except Exception:
            pass
    finally:
        # Final persist (or drop empty placeholder). NOTE: we do NOT touch
        # created_at — the placeholder row was inserted with the timestamp of
        # the stream START, and that's exactly what the UI should show.
        if accumulated.strip() or tool_events:
            with db() as c:
                c.execute(
                    "UPDATE messages SET content=?, tool_events=? WHERE id=?",
                    (
                        accumulated,
                        json.dumps(tool_events) if tool_events else None,
                        assistant_id,
                    ),
                )
                c.execute("UPDATE chats SET updated_at=? WHERE id=?", (time.time(), chat_id))
        else:
            with db() as c:
                c.execute("DELETE FROM messages WHERE id=?", (assistant_id,))
                c.execute("UPDATE messages SET active_child_id=NULL WHERE id=?", (user_msg_id,))
        try:
            await fanout.put(None)  # sentinel: stream finished
        except Exception:
            pass
        _ACTIVE_STREAMS.pop(assistant_id, None)


async def api_chat_stream(request: web.Request) -> web.StreamResponse:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid_json"}, status=400)
    chat_id = body.get("chat_id")
    msg = body.get("message") or {}
    model = body.get("model") or "hermes-agent"
    assistant_for_user_id = body.get("assistant_for_user_id")
    if not chat_id:
        return web.json_response({"error": "missing_chat_id"}, status=400)

    user_text = msg.get("content") or ""
    user_atts = msg.get("attachments") or []
    now = time.time()

    user_msg_id: Optional[int] = None
    with db() as c:
        chat = c.execute("SELECT * FROM chats WHERE id=?", (chat_id,)).fetchone()
        if not chat:
            return web.json_response({"error": "chat_not_found"}, status=404)
        if assistant_for_user_id:
            row = c.execute(
                "SELECT id FROM messages WHERE id=? AND chat_id=? AND role='user'",
                (int(assistant_for_user_id), chat_id),
            ).fetchone()
            if not row:
                return web.json_response({"error": "user_msg_not_found"}, status=404)
            user_msg_id = row["id"]
        else:
            leaf_id = _last_active_id(c, chat_id)
            cur = c.execute(
                "INSERT INTO messages(chat_id,role,content,attachments,created_at,parent_id,tool_events) VALUES(?,?,?,?,?,?,?)",
                (chat_id, "user", user_text, json.dumps(user_atts), now, leaf_id, None),
            )
            user_msg_id = cur.lastrowid
            if leaf_id is None:
                c.execute("UPDATE chats SET root_message_id=? WHERE id=?", (user_msg_id, chat_id))
            else:
                c.execute("UPDATE messages SET active_child_id=? WHERE id=?", (user_msg_id, leaf_id))
        if not chat["title"]:
            t = (user_text or "(untitled)").replace("\n", " ").strip()[:50]
            c.execute("UPDATE chats SET title=?, updated_at=?, model=? WHERE id=?", (t, now, model, chat_id))
        else:
            c.execute("UPDATE chats SET updated_at=?, model=? WHERE id=?", (now, model, chat_id))

    messages = _build_messages(chat_id)
    payload = {"model": model, "messages": messages, "stream": True}
    headers = {"Authorization": f"Bearer {CONFIG['API_SERVER_KEY']}", "Content-Type": "application/json"}

    # Pre-insert the assistant row so a reloaded tab can locate the in-progress
    # generation by id and read partial content from the DB.
    with db() as c:
        cur = c.execute(
            "INSERT INTO messages(chat_id,role,content,attachments,created_at,parent_id,tool_events) VALUES(?,?,?,?,?,?,?)",
            (chat_id, "assistant", "", json.dumps([]), time.time(), user_msg_id, None),
        )
        assistant_id = cur.lastrowid
        c.execute("UPDATE messages SET active_child_id=? WHERE id=?", (assistant_id, user_msg_id))

    # Run the upstream pump as a detached task — survives client disconnects.
    fanout: asyncio.Queue = asyncio.Queue()
    _ACTIVE_STREAMS[assistant_id] = fanout
    asyncio.create_task(_run_upstream_stream(
        chat_id, user_msg_id, assistant_id, payload, headers, fanout,
    ))

    response = web.StreamResponse(status=200, headers={
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    })
    await response.prepare(request)
    # Forward queue → client until sentinel or client disconnects.
    try:
        while True:
            item = await fanout.get()
            if item is None:
                break
            await response.write(item)
    except (ConnectionResetError, ConnectionAbortedError, asyncio.CancelledError):
        log.info("client disconnected mid-stream for chat %s (task continues)", chat_id)
    except Exception as e:
        log.exception("client write error: %s", e)
    try:
        await response.write_eof()
    except Exception:
        pass
    return response


# ---------------------------------------------------------------------------
# Branching: edit-as-new-version + version select
# ---------------------------------------------------------------------------

async def api_branch_message(request: web.Request) -> web.Response:
    """Create a NEW VERSION of an existing message instead of overwriting it.

    Request body: {content, attachments}
    The new message inherits parent_id from the original, and becomes the parent's
    new active_child_id. Subsequent messages in the active chain are NOT touched —
    the next user turn will simply append to this new branch.
    """
    msg_id = int(request.match_info["msg_id"])
    try:
        body = await request.json()
    except Exception:
        body = {}
    new_content = body.get("content")
    new_atts = body.get("attachments")
    with db() as c:
        orig = c.execute("SELECT * FROM messages WHERE id=?", (msg_id,)).fetchone()
        if not orig:
            return web.json_response({"error": "not_found"}, status=404)
        # Insert sibling
        cur = c.execute(
            "INSERT INTO messages(chat_id,role,content,attachments,created_at,parent_id,tool_events) VALUES(?,?,?,?,?,?,?)",
            (
                orig["chat_id"],
                orig["role"],
                new_content if new_content is not None else (orig["content"] or ""),
                json.dumps(new_atts if new_atts is not None else (json.loads(orig["attachments"]) if orig["attachments"] else [])),
                time.time(),
                orig["parent_id"],
                None,
            ),
        )
        new_id = cur.lastrowid
        # Wire it as the active branch
        if orig["parent_id"] is None:
            # New root → update chats.root_message_id
            c.execute("UPDATE chats SET root_message_id=? WHERE id=?", (new_id, orig["chat_id"]))
        else:
            c.execute("UPDATE messages SET active_child_id=? WHERE id=?", (new_id, orig["parent_id"]))
    return web.json_response({"id": new_id})


async def api_select_version(request: web.Request) -> web.Response:
    """Switch the active branch at this message's parent to point at the given message id."""
    msg_id = int(request.match_info["msg_id"])
    with db() as c:
        row = c.execute("SELECT chat_id, parent_id FROM messages WHERE id=?", (msg_id,)).fetchone()
        if not row:
            return web.json_response({"error": "not_found"}, status=404)
        if row["parent_id"] is None:
            c.execute("UPDATE chats SET root_message_id=? WHERE id=?", (msg_id, row["chat_id"]))
        else:
            c.execute("UPDATE messages SET active_child_id=? WHERE id=?", (msg_id, row["parent_id"]))
    return web.json_response({"ok": True})


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------

def create_app() -> web.Application:
    app = web.Application(client_max_size=30 * 1024 * 1024)

    # Pages
    app.router.add_get("/", root_handler)
    app.router.add_get("/login", login_page)

    # Auth API
    app.router.add_post("/api/login", api_login)
    app.router.add_post("/api/logout", require_auth(api_logout))
    app.router.add_get("/api/me", require_auth(api_me))

    # Models
    app.router.add_get("/api/models", require_auth(api_models))
    app.router.add_get("/api/model", require_auth(api_get_model))
    app.router.add_post("/api/model", require_auth(api_set_model))

    # Chats
    app.router.add_get("/api/chats", require_auth(api_list_chats))
    app.router.add_post("/api/chats", require_auth(api_create_chat))
    app.router.add_get("/api/chats/{chat_id}", require_auth(api_get_chat))
    app.router.add_patch("/api/chats/{chat_id}", require_auth(api_patch_chat))
    app.router.add_delete("/api/chats/{chat_id}", require_auth(api_delete_chat))
    app.router.add_get("/api/chats/{chat_id}/messages", require_auth(api_list_messages))

    # Messages
    app.router.add_patch("/api/messages/{msg_id}", require_auth(api_patch_message))
    app.router.add_delete("/api/messages/{msg_id}", require_auth(api_delete_message))
    app.router.add_post("/api/messages/{msg_id}/branch", require_auth(api_branch_message))
    app.router.add_post("/api/messages/{msg_id}/select", require_auth(api_select_version))

    # Stream
    app.router.add_post("/api/chat/stream", require_auth(api_chat_stream))

    # Uploads
    app.router.add_post("/api/upload", require_auth(api_upload))
    app.router.add_get("/api/uploads/{name}", require_auth(api_get_upload))
    app.router.add_get("/api/media", require_auth(api_get_media))

    # Settings
    app.router.add_get("/api/settings", require_auth(api_get_settings))
    app.router.add_post("/api/settings", require_auth(api_post_settings))

    # Memory (agent's saved facts about user & environment)
    app.router.add_get("/api/memory/{target}", require_auth(api_get_memory))
    app.router.add_put("/api/memory/{target}", require_auth(api_put_memory))

    # Skills
    app.router.add_get("/api/skills", require_auth(api_list_skills))
    app.router.add_get("/api/skills/{name}", require_auth(api_get_skill))
    app.router.add_put("/api/skills/{name}", require_auth(api_update_skill))
    app.router.add_post("/api/skills", require_auth(api_install_skill))
    app.router.add_delete("/api/skills/{name}", require_auth(api_delete_skill))

    # Tools (built-in toolsets, enable/disable)
    app.router.add_get("/api/tools", require_auth(api_list_tools))
    app.router.add_post("/api/tools/toggle", require_auth(api_toggle_tool))

    # MCP servers
    app.router.add_get("/api/mcp", require_auth(api_list_mcp))
    app.router.add_post("/api/mcp", require_auth(api_add_mcp))
    app.router.add_delete("/api/mcp/{name}", require_auth(api_remove_mcp))

    # Static
    app.router.add_get("/{filename:.+\\.(?:js|css|html|svg|png|jpg|jpeg|webp|ico|map|json)}", serve_static)

    return app


def main() -> None:
    app = create_app()
    log.info("PumpApi Agent starting on %s:%s", LISTEN_HOST, LISTEN_PORT)
    web.run_app(app, host=LISTEN_HOST, port=LISTEN_PORT, access_log=None)


if __name__ == "__main__":
    main()
