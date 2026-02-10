# backend/app/REALTIME/sio_server.py
import logging
import re
import asyncio
from datetime import datetime, timezone
from typing import Any, Dict, Optional, List

from pymongo import DESCENDING
import socketio
from fastapi.concurrency import run_in_threadpool

from ..db import get_collection
from ..MESSAGING.store import open_dm_conversation, insert_message

# Best-effort Gmail notification when a new inbox message arrives.
# Mirrors the Notifications -> Gmail flow style (refresh token + HTML email).
from .inbox_email import maybe_send_inbox_email_notification

# Optional imports (only exist if you applied the Phase 9 store.py drop-in)
try:
    from ..MESSAGING.store import mark_read as store_mark_read  # type: ignore
except Exception:
    store_mark_read = None

try:
    from ..MESSAGING.store import get_state_map_for_user as store_get_state_map_for_user  # type: ignore
except Exception:
    store_get_state_map_for_user = None


logger = logging.getLogger("uvicorn.error")

# If your store.insert_message() already bumps unread in conversation_state, keep True.
# If your store.py is still old (no unread bump), set False and this server will bump unread itself.
STORE_HANDLES_UNREAD = True

# Socket.IO server (ASGI mode)
sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",   # ok for dev; lock down later if needed
    ping_interval=25,
    ping_timeout=60,
)

CONV_ROOM_PREFIX = "conv:"
USER_ROOM_PREFIX = "user:"


# ----------------------------
# JSON-safe helpers
# ----------------------------
def _json_safe(v):
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, dict):
        return {k: _json_safe(val) for k, val in v.items()}
    if isinstance(v, list):
        return [_json_safe(x) for x in v]
    return v


# ----------------------------
# User helpers
# ----------------------------
def _find_user(user_id: str, email: str = "") -> Optional[Dict[str, Any]]:
    col = get_collection("users")
    user_id = str(user_id).strip()
    email = (email or "").strip().lower()

    user = col.find_one({"user_id": user_id}, {"_id": 0})
    if user:
        return user

    user = col.find_one({"userId": user_id}, {"_id": 0})
    if user:
        return user

    user = col.find_one({"id": user_id}, {"_id": 0})
    if user:
        return user

    if email:
        user = col.find_one({"$or": [{"email": email}, {"gmail": email}]}, {"_id": 0})
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


# ----------------------------
# conversation_state helpers (Phase 9)
# ----------------------------
def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _ensure_state(conversation_id: str, participants: List[str]) -> None:
    """
    Ensure conversation_state documents exist for each participant,
    and that 'unread' field exists without resetting existing counts.
    """
    st = get_collection("conversation_state")
    now = _now_utc()

    for uid in participants:
        uid = str(uid).strip()
        if not uid:
            continue

        # Upsert base doc
        st.update_one(
            {"conversation_id": conversation_id, "user_id": uid},
            {
                "$setOnInsert": {
                    "conversation_id": conversation_id,
                    "user_id": uid,
                    "unread": 0,
                    "last_read_at": None,
                    "created_at": now,
                    "updated_at": now,
                }
            },
            upsert=True,
        )

        # If doc existed but unread missing, add it (does not reset if already present)
        st.update_one(
            {"conversation_id": conversation_id, "user_id": uid, "unread": {"$exists": False}},
            {"$set": {"unread": 0, "updated_at": now}},
        )


def _get_unread_for_user(conversation_id: str, user_id: str) -> int:
    st = get_collection("conversation_state")
    doc = st.find_one(
        {"conversation_id": conversation_id, "user_id": user_id},
        {"_id": 0, "unread": 1},
    ) or {}
    try:
        return int(doc.get("unread") or 0)
    except Exception:
        return 0


def _get_state_map_for_user(user_id: str, conversation_ids: List[str]) -> Dict[str, int]:
    """
    Returns { conversation_id: unread_int } for the given user_id.
    Uses store.get_state_map_for_user if present (Phase 9 store drop-in),
    otherwise queries conversation_state directly.
    """
    user_id = str(user_id).strip()
    ids = [str(x).strip() for x in (conversation_ids or []) if str(x).strip()]
    if not user_id or not ids:
        return {}

    # Prefer store helper if available
    if store_get_state_map_for_user:
        try:
            m = store_get_state_map_for_user(user_id, ids)  # type: ignore
            out = {}
            for cid, v in (m or {}).items():
                try:
                    out[str(cid)] = int((v or {}).get("unread") or 0)
                except Exception:
                    out[str(cid)] = 0
            return out
        except Exception:
            pass

    st = get_collection("conversation_state")
    docs = list(
        st.find(
            {"user_id": user_id, "conversation_id": {"$in": ids}},
            {"_id": 0, "conversation_id": 1, "unread": 1},
        )
    )
    out: Dict[str, int] = {}
    for d in docs:
        cid = str(d.get("conversation_id") or "")
        if not cid:
            continue
        try:
            out[cid] = int(d.get("unread") or 0)
        except Exception:
            out[cid] = 0
    return out


def _mark_read(conversation_id: str, user_id: str) -> None:
    """
    Mark a conversation read for user_id (unread=0, last_read_at=now).
    Uses store.mark_read if available; otherwise updates conversation_state.
    """
    user_id = str(user_id).strip()
    conversation_id = str(conversation_id).strip()
    if not user_id or not conversation_id:
        return

    if store_mark_read:
        try:
            store_mark_read(conversation_id, user_id)  # type: ignore
            return
        except Exception:
            pass

    st = get_collection("conversation_state")
    now = _now_utc()
    st.update_one(
        {"conversation_id": conversation_id, "user_id": user_id},
        {
            "$set": {"unread": 0, "last_read_at": now, "updated_at": now},
            "$setOnInsert": {"conversation_id": conversation_id, "user_id": user_id, "created_at": now},
        },
        upsert=True,
    )


def _bump_unread_after_send(conversation_id: str, sender_id: str, participants: List[str]) -> Dict[str, int]:
    """
    Only used if STORE_HANDLES_UNREAD=False.
    Increments unread for all participants except sender, sets sender unread=0.
    Returns unread_map {uid: unread_int} after update.
    """
    st = get_collection("conversation_state")
    now = _now_utc()
    sender_id = str(sender_id).strip()

    _ensure_state(conversation_id, participants)

    # sender -> 0
    st.update_one(
        {"conversation_id": conversation_id, "user_id": sender_id},
        {"$set": {"unread": 0, "updated_at": now, "last_read_at": now}},
        upsert=True,
    )

    # others -> +1
    for uid in participants:
        uid = str(uid).strip()
        if not uid or uid == sender_id:
            continue
        st.update_one(
            {"conversation_id": conversation_id, "user_id": uid},
            {
                "$inc": {"unread": 1},
                "$set": {"updated_at": now},
                "$setOnInsert": {"created_at": now, "last_read_at": None},
            },
            upsert=True,
        )

    docs = list(
        st.find(
            {"conversation_id": conversation_id, "user_id": {"$in": participants}},
            {"_id": 0, "user_id": 1, "unread": 1},
        )
    )
    out: Dict[str, int] = {}
    for d in docs:
        uid = str(d.get("user_id") or "")
        if not uid:
            continue
        try:
            out[uid] = int(d.get("unread") or 0)
        except Exception:
            out[uid] = 0
    return out


def _get_unread_map(conversation_id: str, participants: List[str]) -> Dict[str, int]:
    st = get_collection("conversation_state")
    docs = list(
        st.find(
            {"conversation_id": conversation_id, "user_id": {"$in": participants}},
            {"_id": 0, "user_id": 1, "unread": 1},
        )
    )
    out: Dict[str, int] = {}
    for d in docs:
        uid = str(d.get("user_id") or "")
        if not uid:
            continue
        try:
            out[uid] = int(d.get("unread") or 0)
        except Exception:
            out[uid] = 0
    return out


# ----------------------------
# Conversation/message views
# ----------------------------
def _list_conversations_view(user_id: str, limit: int = 50) -> List[Dict[str, Any]]:
    conv = get_collection("conversations")

    convs = list(
        conv.find({"participants": user_id}, {"_id": 0})
        .sort("updated_at", DESCENDING)
        .limit(int(limit))
    )

    conv_ids = [str(c.get("conversation_id") or "") for c in convs if c.get("conversation_id")]
    unread_map = _get_state_map_for_user(user_id, conv_ids)

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
        cid = str(c.get("conversation_id") or "")
        ctype = c.get("type") or "dm"
        parts = [str(x) for x in (c.get("participants") or [])]

        peer = None
        if ctype == "dm":
            peer_id = next((p for p in parts if p != user_id), None)
            u = user_map.get(peer_id or "")
            if u:
                peer = {
                    "userId": u.get("user_id"),
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
                "unread": int(unread_map.get(cid, 0)),
            }
        )

    return out


def _list_messages_view(user_id: str, conversation_id: str, limit: int = 30) -> List[Dict[str, Any]]:
    conv = get_collection("conversations")
    msg = get_collection("messages")

    c = conv.find_one({"conversation_id": conversation_id}, {"_id": 0})
    if not c or user_id not in (c.get("participants") or []):
        return []

    docs = list(
        msg.find({"conversation_id": conversation_id}, {"_id": 0})
        .sort("created_at", DESCENDING)
        .limit(int(limit))
    )
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


def _search_users(q: str, limit: int = 10) -> List[Dict[str, Any]]:
    q = (q or "").strip()
    if not q:
        return []
    users = get_collection("users")
    rx = re.compile(re.escape(q), re.IGNORECASE)

    docs = list(
        users.find(
            {"$or": [{"user_id": rx}, {"first_name": rx}, {"last_name": rx}, {"email": rx}, {"gmail": rx}]},
            {"_id": 0, "user_id": 1, "first_name": 1, "last_name": 1, "email": 1, "gmail": 1},
        ).limit(int(limit))
    )

    out = []
    for u in docs:
        full = f"{(u.get('first_name') or '').strip()} {(u.get('last_name') or '').strip()}".strip()
        out.append(
            {
                "userId": u.get("user_id"),
                "fullName": full or (u.get("email") or u.get("gmail") or u.get("user_id") or "User"),
                "email": (u.get("email") or u.get("gmail") or "").strip(),
            }
        )
    return out


def _get_conversation_view(conversation_id: str, requester_id: str) -> Optional[Dict[str, Any]]:
    conversations = get_collection("conversations")
    users = get_collection("users")
    messages = get_collection("messages")

    conv = conversations.find_one(
        {"conversation_id": conversation_id, "participants": requester_id},
        {"_id": 0},
    )
    if not conv:
        return None

    participants = [str(x) for x in (conv.get("participants") or [])]
    other_id = next((p for p in participants if p != requester_id), None)

    peer = {}
    if other_id:
        u = users.find_one(
            {"user_id": other_id},
            {"_id": 0, "user_id": 1, "first_name": 1, "last_name": 1, "email": 1, "gmail": 1},
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
        projection={"_id": 0},
    )

    last_message = None
    if lm:
        sid = str(lm.get("sender_id") or "")
        su = users.find_one({"user_id": sid}, {"_id": 0, "first_name": 1, "last_name": 1, "email": 1, "gmail": 1}) or {}
        sender_name = _full_name(su) if su else sid

        last_message = {
            "messageId": str(lm.get("message_id") or ""),
            "preview": (lm.get("body") or "")[:80],
            "createdAt": lm.get("created_at"),
            "senderId": sid,
            "senderName": sender_name,
            "body": lm.get("body"),
        }

    unread = _get_unread_for_user(conversation_id, requester_id)

    return {
        "conversationId": conv.get("conversation_id"),
        "peer": peer,
        "updatedAt": conv.get("updated_at"),
        "lastMessage": last_message,
        "unread": unread,
    }


# ----------------------------
# Socket events
# ----------------------------
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

        await sio.save_session(sid, {"userId": user_id})
        await sio.enter_room(sid, f"{USER_ROOM_PREFIX}{user_id}")

        logger.info(f"[socket] connect sid={sid} userId={user_id}")
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
        conv_id = str(conv["conversation_id"])

        # join opener into conv room
        await sio.enter_room(sid, f"{CONV_ROOM_PREFIX}{conv_id}")

        # ensure conversation_state docs exist
        participants = [str(x) for x in (conv.get("participants") or [user_id, target_id])]
        await run_in_threadpool(_ensure_state, conv_id, participants)

        # unread_update back to opener (usually 0)
        unread0 = await run_in_threadpool(_get_unread_for_user, conv_id, str(user_id))
        await sio.emit(
            "unread_update",
            {"conversationId": conv_id, "unread": int(unread0)},
            room=f"{USER_ROOM_PREFIX}{user_id}",
        )

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

    conv_col = get_collection("conversations")
    conv = await run_in_threadpool(lambda: conv_col.find_one({"conversation_id": conv_id}, {"_id": 0}))
    if not conv or user_id not in (conv.get("participants") or []):
        return {"ok": False, "error": "Not allowed"}

    await sio.enter_room(sid, f"{CONV_ROOM_PREFIX}{conv_id}")

    # ensure state exists (safe)
    participants = [str(x) for x in (conv.get("participants") or [])]
    await run_in_threadpool(_ensure_state, conv_id, participants)

    return {"ok": True}


@sio.event
async def conversation_mark_read(sid: str, data: Dict[str, Any]):
    sess = await sio.get_session(sid)
    user_id = (sess or {}).get("userId")
    if not user_id:
        return {"ok": False, "error": "Not authenticated"}

    conv_id = str((data or {}).get("conversationId") or "").strip()
    if not conv_id:
        return {"ok": False, "error": "Missing conversationId"}

    # permission check
    conv_col = get_collection("conversations")
    conv = await run_in_threadpool(lambda: conv_col.find_one({"conversation_id": conv_id}, {"_id": 0, "participants": 1}))
    if not conv or user_id not in (conv.get("participants") or []):
        return {"ok": False, "error": "Not allowed"}

    await run_in_threadpool(_mark_read, conv_id, str(user_id))

    await sio.emit(
        "unread_update",
        {"conversationId": conv_id, "unread": 0},
        room=f"{USER_ROOM_PREFIX}{user_id}",
    )

    return {"ok": True, "conversationId": conv_id, "unread": 0}


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

    participants = [str(x) for x in (conv.get("participants") or [])]

    # Ensure state exists (safe)
    await run_in_threadpool(_ensure_state, conv_id, participants)

    # insert message (sync store)
    msg = await run_in_threadpool(insert_message, conv_id, str(user_id), body)

    # compute senderName for payload
    sender_user = await run_in_threadpool(_find_user, str(user_id), "")
    sender_name = _full_name(sender_user or {}) if sender_user else str(user_id)

    payload = _json_safe({
        "messageId": msg.get("message_id"),
        "conversationId": msg.get("conversation_id"),
        "senderId": msg.get("sender_id"),
        "senderName": sender_name,
        "body": msg.get("body"),
        "createdAt": msg.get("created_at"),
    })

    # emit to everyone in the conversation room
    await sio.emit("message_new", payload, room=f"{CONV_ROOM_PREFIX}{conv_id}")

    # If your store.py does NOT bump unread, do it here.
    unread_map: Dict[str, int] = {}
    if not STORE_HANDLES_UNREAD:
        unread_map = await run_in_threadpool(_bump_unread_after_send, conv_id, str(user_id), participants)
    else:
        # store handled bump; just read current state
        unread_map = await run_in_threadpool(_get_unread_map, conv_id, participants)

    # notify each participant's user room so inbox list can update
    preview = (body[:80].rstrip() + "…") if len(body) > 80 else body

    for uid in participants:
        await sio.emit(
            "conversation_updated",
            _json_safe({
                "conversationId": conv_id,
                "lastMessage": {
                    "preview": preview,
                    "senderId": str(user_id),
                    "senderName": sender_name,
                    "createdAt": msg.get("created_at"),
                }
            }),
            room=f"{USER_ROOM_PREFIX}{uid}",
        )

        await sio.emit(
            "unread_update",
            {"conversationId": conv_id, "unread": int(unread_map.get(uid, 0))},
            room=f"{USER_ROOM_PREFIX}{uid}",
        )

        # ✅ Gmail notification (best-effort):
        # Only email the receiver when this message is the *first unread* in the thread.
        # This prevents spamming their inbox while they already have unread messages.
        try:
            if str(uid) != str(user_id) and int(unread_map.get(uid, 0) or 0) == 1:
                asyncio.create_task(
                    maybe_send_inbox_email_notification(
                        recipient_user_id=str(uid),
                        sender_user_id=str(user_id),
                        sender_name=sender_name,
                        preview=preview,
                    )
                )
        except Exception:
            pass

    return {"ok": True, "message": payload}


@sio.event
async def user_search(sid: str, data: Dict[str, Any]):
    sess = await sio.get_session(sid)
    user_id = (sess or {}).get("userId")
    if not user_id:
        return {"ok": False, "error": "Not authenticated"}

    q = str((data or {}).get("q") or "").strip()
    limit = int((data or {}).get("limit") or 10)
    if len(q) < 2:
        return {"ok": True, "users": []}

    users = await run_in_threadpool(_search_users, q, limit)
    users = [u for u in users if str(u.get("userId")) != str(user_id)]
    return {"ok": True, "users": _json_safe(users)}


@sio.event
async def conversation_get(sid: str, data: Dict[str, Any]):
    sess = await sio.get_session(sid)
    user_id = (sess or {}).get("userId")
    if not user_id:
        return {"ok": False, "error": "Not authenticated"}

    conversation_id = str((data or {}).get("conversationId") or "").strip()
    if not conversation_id:
        return {"ok": False, "error": "Missing conversationId"}

    view = await run_in_threadpool(_get_conversation_view, conversation_id, str(user_id))
    if not view:
        return {"ok": False, "error": "Not found"}

    return {"ok": True, "conversation": _json_safe(view)}
