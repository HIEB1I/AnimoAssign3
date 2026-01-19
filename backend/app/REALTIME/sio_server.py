# backend/app/REALTIME/sio_server.py
import logging
from typing import Any, Dict, Optional
from datetime import datetime
from typing import List
from pymongo import DESCENDING

import re
from pymongo import ASCENDING

import socketio
from fastapi.concurrency import run_in_threadpool

from ..db import get_collection
from ..MESSAGING.store import open_dm_conversation, insert_message

logger = logging.getLogger("uvicorn.error")

# Socket.IO server (ASGI mode)
sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",   # ok for dev; lock down later if needed
    ping_interval=25,
    ping_timeout=60,
)

CONV_ROOM_PREFIX = "conv:"
USER_ROOM_PREFIX = "user:"

def _json_safe(v):
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, dict):
        return {k: _json_safe(val) for k, val in v.items()}
    if isinstance(v, list):
        return [_json_safe(x) for x in v]
    return v

def _find_user(user_id: str, email: str = "") -> Optional[Dict[str, Any]]:
    col = get_collection("users")
    user_id = str(user_id).strip()
    email = (email or "").strip().lower()

    # Try common keys
    user = col.find_one({"user_id": user_id}, {"_id": 0})
    if user:
        return user

    user = col.find_one({"userId": user_id}, {"_id": 0})
    if user:
        return user

    user = col.find_one({"id": user_id}, {"_id": 0})
    if user:
        return user

    # If email provided, allow finding by email/gmail too
    if email:
        user = col.find_one(
            {"$or": [{"email": email}, {"gmail": email}]},
            {"_id": 0},
        )
        if user:
            return user

    return None

def _full_name(u: Dict[str, Any]) -> str:
    first = (u.get("first_name") or "").strip()
    last = (u.get("last_name") or "").strip()
    full = f"{first} {last}".strip()
    return full or (u.get("email") or u.get("gmail") or "User")


def _get_user_map(user_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    users = get_collection("users")
    docs = list(users.find({"user_id": {"$in": user_ids}}, {"_id": 0}))
    out = {}
    for u in docs:
        uid = str(u.get("user_id") or "").strip()
        if uid:
            out[uid] = u
    return out


def _list_conversations_view(user_id: str, limit: int = 50) -> List[Dict[str, Any]]:
    conv = get_collection("conversations")
    users = get_collection("users")

    convs = list(
        conv.find({"participants": user_id}, {"_id": 0})
        .sort("updated_at", DESCENDING)
        .limit(int(limit))
    )

    # collect peer ids for dm convs
    peer_ids = []
    for c in convs:
        if c.get("type") == "dm":
            parts = [str(x) for x in (c.get("participants") or [])]
            peer = next((p for p in parts if p != user_id), None)
            if peer:
                peer_ids.append(peer)

    user_map = _get_user_map(list(set(peer_ids))) if peer_ids else {}

    out = []
    for c in convs:
        cid = c.get("conversation_id")
        ctype = c.get("type") or "dm"
        parts = [str(x) for x in (c.get("participants") or [])]

        peer = None
        if ctype == "dm":
            peer_id = next((p for p in parts if p != user_id), None)
            u = user_map.get(peer_id or "")
            if u:
                peer = {
                    "userId": u["user_id"],
                    "fullName": _full_name(u),
                    "email": (u.get("email") or u.get("gmail") or "").strip(),
                }
            else:
                peer = {"userId": peer_id, "fullName": peer_id or "User", "email": ""}

        out.append(
            {
                "conversationId": cid,
                "type": ctype,
                "participants": parts,
                "peer": peer,
                "updatedAt": c.get("updated_at"),
                "lastMessage": c.get("last_message"),
            }
        )

    return out


def _list_messages_view(user_id: str, conversation_id: str, limit: int = 30) -> List[Dict[str, Any]]:
    conv = get_collection("conversations")
    msg = get_collection("messages")

    c = conv.find_one({"conversation_id": conversation_id}, {"_id": 0})
    if not c or user_id not in (c.get("participants") or []):
        # not allowed or does not exist
        return []

    docs = list(
        msg.find({"conversation_id": conversation_id}, {"_id": 0})
        .sort("created_at", DESCENDING)
        .limit(int(limit))
    )

    # newest->oldest; return oldest->newest for nicer display
    docs.reverse()

    sender_ids = list({str(d.get("sender_id") or "") for d in docs if d.get("sender_id")})
    sender_map = _get_user_map(sender_ids) if sender_ids else {}

    out = []
    for d in docs:
        sid = str(d.get("sender_id") or "")
        u = sender_map.get(sid)
        out.append(
            {
                "messageId": d.get("message_id"),
                "conversationId": d.get("conversation_id"),
                "senderId": sid,
                "senderName": _full_name(u) if u else sid,
                "body": d.get("body") or "",
                "createdAt": d.get("created_at"),
            }
        )
    return out


def _search_users(q: str, limit: int = 10) -> list[dict]:
    q = (q or "").strip()
    if not q:
        return []
    users = get_collection("users")

    # simple safe regex (escape user input)
    rx = re.compile(re.escape(q), re.IGNORECASE)

    docs = list(users.find(
        {"$or": [
            {"user_id": rx},
            {"first_name": rx},
            {"last_name": rx},
            {"email": rx},
            {"gmail": rx},
        ]},
        {"_id": 0, "user_id": 1, "first_name": 1, "last_name": 1, "email": 1, "gmail": 1}
    ).limit(int(limit)))

    out = []
    for u in docs:
        full = f"{(u.get('first_name') or '').strip()} {(u.get('last_name') or '').strip()}".strip()
        out.append({
            "userId": u.get("user_id"),
            "fullName": full or (u.get("email") or u.get("gmail") or u.get("user_id") or "User"),
            "email": (u.get("email") or u.get("gmail") or "").strip(),
        })
    return out

def _get_conversation_view(conversation_id: str, requester_id: str) -> dict | None:
    conversations = get_collection("conversations")
    users = get_collection("users")
    messages = get_collection("messages")

    conv = conversations.find_one(
        {"conversation_id": conversation_id, "participants": requester_id},
        {"_id": 0}
    )
    if not conv:
        return None

    participants = conv.get("participants") or []
    other_id = next((p for p in participants if p != requester_id), None)

    peer = {}
    if other_id:
        u = users.find_one(
            {"user_id": other_id},
            {"_id": 0, "user_id": 1, "first_name": 1, "last_name": 1, "email": 1, "gmail": 1}
        ) or {}
        full = f"{(u.get('first_name') or '').strip()} {(u.get('last_name') or '').strip()}".strip()
        peer = {
            "userId": u.get("user_id") or other_id,
            "fullName": full or (u.get("email") or u.get("gmail") or other_id),
            "email": (u.get("email") or u.get("gmail") or ""),
        }

    lm = messages.find_one(
        {"conversation_id": conversation_id},
        sort=[("created_at", -1)],
        projection={"_id": 0}
    )

    last_message = None
    if lm:
        last_message = {
            "messageId": str(lm.get("message_id") or ""),
            "preview": (lm.get("body") or "")[:80],
            "createdAt": lm.get("created_at"),
            "senderId": lm.get("sender_id"),
            "senderName": lm.get("sender_name"),
            "body": lm.get("body"),
        }

    return {
        "conversationId": conv.get("conversation_id"),
        "peer": peer,
        "updatedAt": conv.get("updated_at"),
        "lastMessage": last_message,
    }
    
    
@sio.event
async def connect(sid: str, environ: Dict[str, Any], auth: Optional[Dict[str, Any]]):
    """
    Client should pass auth: { userId, email? } when connecting.
    We validate user exists (pymongo, no motor), then join room user:{userId}.
    """
    try:
        auth = auth or {}
        user_id = str(auth.get("userId") or "").strip()
        email = str(auth.get("email") or "").strip().lower()

        if not user_id:
            raise ConnectionRefusedError("Missing userId")

        user = await run_in_threadpool(_find_user, user_id, email)
        if not user:
            raise ConnectionRefusedError("Invalid userId")

        # Optional stronger check: if email provided, it must match
        # if email:
        #     allowed = {
        #         str(user.get("email") or "").strip().lower(),
        #         str(user.get("gmail") or "").strip().lower(),
        #     }
        #     if email not in allowed:
        #         raise ConnectionRefusedError("Email mismatch")

        await sio.save_session(sid, {"userId": user_id})
        await sio.enter_room(sid, f"{USER_ROOM_PREFIX}{user_id}")

        logger.info(f"[socket] connect sid={sid} userId={user_id}")

        # Small handshake message (useful for frontend logs)
        await sio.emit("socket:ready", {"ok": True, "userId": user_id}, to=sid)

    except ConnectionRefusedError:
        raise
    except Exception as e:
        logger.exception(f"[socket] connect failed sid={sid}: {e}")
        raise ConnectionRefusedError("Socket auth failed")


@sio.event
async def disconnect(sid: str):
    sess = await sio.get_session(sid)
    logger.info(f"[socket] disconnect sid={sid} userId={(sess or {}).get('userId')}")


# Simple test event (so you can verify roundtrip easily)
@sio.event
async def client_hello(sid: str, data: Dict[str, Any]):
    sess = await sio.get_session(sid)
    await sio.emit("server_hello", {"ok": True, "session": sess, "echo": data}, to=sid)

@sio.event
async def conversation_list(sid: str, data: Dict[str, Any]):
    sess = await sio.get_session(sid)
    user_id = (sess or {}).get("userId")
    if not user_id:
        return {"ok": False, "error": "Not authenticated"}

    limit = int((data or {}).get("limit") or 50)

    convs = await run_in_threadpool(_list_conversations_view, user_id, limit)
    return {"ok": True, "conversations": _json_safe(convs)}


@sio.event
async def message_list(sid: str, data: Dict[str, Any]):
    sess = await sio.get_session(sid)
    user_id = (sess or {}).get("userId")
    if not user_id:
        return {"ok": False, "error": "Not authenticated"}

    conversation_id = str((data or {}).get("conversationId") or "").strip()
    if not conversation_id:
        return {"ok": False, "error": "Missing conversationId"}

    limit = int((data or {}).get("limit") or 30)

    msgs = await run_in_threadpool(_list_messages_view, user_id, conversation_id, limit)
    return {"ok": True, "messages": _json_safe(msgs)}

@sio.event
async def conversation_open(sid: str, data: Dict[str, Any]):
    sess = await sio.get_session(sid)
    user_id = (sess or {}).get("userId")
    if not user_id:
        return {"ok": False, "error": "Not authenticated"}

    target_id = str((data or {}).get("targetUserId") or "").strip()
    if not target_id:
        return {"ok": False, "error": "Missing targetUserId"}

    try:
        conv = await run_in_threadpool(open_dm_conversation, user_id, target_id)
        conv_id = conv["conversation_id"]

        # auto-join both a user room already exists (we joined on connect)
        # join sender into conv room
        await sio.enter_room(sid, f"{CONV_ROOM_PREFIX}{conv_id}")

        return {"ok": True, "conversationId": conv_id}
    except Exception as e:
        logger.exception(f"conversation_open failed: {e}")
        return {"ok": False, "error": "Failed to open conversation"}

@sio.event
async def conversation_join(sid: str, data: Dict[str, Any]):
    sess = await sio.get_session(sid)
    user_id = (sess or {}).get("userId")
    if not user_id:
        return {"ok": False, "error": "Not authenticated"}

    conv_id = str((data or {}).get("conversationId") or "").strip()
    if not conv_id:
        return {"ok": False, "error": "Missing conversationId"}

    # basic permission: user must be in participants
    conv_col = get_collection("conversations")
    conv = await run_in_threadpool(lambda: conv_col.find_one({"conversation_id": conv_id}, {"_id": 0}))
    if not conv or user_id not in (conv.get("participants") or []):
        return {"ok": False, "error": "Not allowed"}

    await sio.enter_room(sid, f"{CONV_ROOM_PREFIX}{conv_id}")
    return {"ok": True}

@sio.event
async def message_send(sid: str, data: Dict[str, Any]):
    sess = await sio.get_session(sid)
    user_id = (sess or {}).get("userId")
    if not user_id:
        return {"ok": False, "error": "Not authenticated"}

    conv_id = str((data or {}).get("conversationId") or "").strip()
    body = str((data or {}).get("body") or "").strip()

    if not conv_id or not body:
        return {"ok": False, "error": "Missing conversationId or body"}

    # permission check: must be participant
    conv_col = get_collection("conversations")
    conv = await run_in_threadpool(lambda: conv_col.find_one({"conversation_id": conv_id}, {"_id": 0}))
    if not conv or user_id not in (conv.get("participants") or []):
        return {"ok": False, "error": "Not allowed"}

    # insert message
    msg = await run_in_threadpool(insert_message, conv_id, user_id, body)

    # Build a message payload (JSON safe)
    payload = _json_safe({
        "messageId": msg["message_id"],
        "conversationId": msg["conversation_id"],
        "senderId": msg["sender_id"],
        "body": msg["body"],
        "createdAt": msg["created_at"],
    })

    # emit to everyone in the conversation room
    await sio.emit("message_new", payload, room=f"{CONV_ROOM_PREFIX}{conv_id}")

    # also notify each participant's user room so inbox list can update
    participants = conv.get("participants") or []
    for uid in participants:
        await sio.emit(
            "conversation_updated",
            _json_safe({
                "conversationId": conv_id,
                "lastMessage": {
                    "preview": (body[:80] + "…") if len(body) > 80 else body,
                    "senderId": user_id,
                    "createdAt": msg["created_at"],
                }
            }),
            room=f"{USER_ROOM_PREFIX}{uid}"
        )

    return {"ok": True, "message": payload}

@sio.event
async def user_search(sid: str, data: dict):
    sess = await sio.get_session(sid)
    user_id = (sess or {}).get("userId")
    if not user_id:
        return {"ok": False, "error": "Not authenticated"}

    q = str((data or {}).get("q") or "").strip()
    limit = int((data or {}).get("limit") or 10)
    if len(q) < 2:
        return {"ok": True, "users": []}

    users = await run_in_threadpool(_search_users, q, limit)

    # remove self
    users = [u for u in users if str(u.get("userId")) != str(user_id)]

    return {"ok": True, "users": _json_safe(users)}

@sio.event
async def conversation_get(sid: str, data: dict):
    sess = await sio.get_session(sid)
    user_id = (sess or {}).get("userId")
    if not user_id:
        return {"ok": False, "error": "Not authenticated"}

    conversation_id = str((data or {}).get("conversationId") or "").strip()
    if not conversation_id:
        return {"ok": False, "error": "Missing conversationId"}

    view = await run_in_threadpool(_get_conversation_view, conversation_id, user_id)
    if not view:
        return {"ok": False, "error": "Not found"}

    return {"ok": True, "conversation": _json_safe(view)}