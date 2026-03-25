# backend/app/MESSAGING/store.py
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
import re
from uuid import uuid4

from pymongo import ASCENDING, DESCENDING, ReturnDocument

from ..db import get_collection


# ----------------------------
# Small utilities
# ----------------------------
def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _dm_key(a: str, b: str) -> str:
    """
    Stable key for a 1-on-1 DM conversation to prevent duplicates.
    Always sort (a,b) so "A+B" equals "B+A".
    """
    x, y = sorted([str(a), str(b)])
    return f"{x}:{y}"


def _preview(text: str, n: int = 80) -> str:
    t = (text or "").strip()
    if len(t) <= n:
        return t
    return t[:n].rstrip() + "…"


# ----------------------------
# Collections
# ----------------------------
def conversations_col():
    return get_collection("conversations")


def messages_col():
    return get_collection("messages")


def convo_state_col():
    return get_collection("conversation_state")


# ----------------------------
# Index creation (run at startup)
# ----------------------------
def ensure_messaging_indexes() -> None:
    conv = conversations_col()
    msg = messages_col()
    st = convo_state_col()

    # Conversations
    conv.create_index([("conversation_id", ASCENDING)], unique=True, name="conversation_id_uq")

    # List a user's conversations quickly + allow sorting by updated_at
    conv.create_index([("participants", ASCENDING), ("updated_at", DESCENDING)], name="participants_updated_at")

    # DM uniqueness: only DMs have dm_key, and dm_key must be unique among DMs
    conv.create_index(
        [("dm_key", ASCENDING)],
        unique=True,
        name="dm_key_uq",
        partialFilterExpression={"type": "dm"},
    )

    # Messages
    msg.create_index([("message_id", ASCENDING)], unique=True, name="message_id_uq")
    msg.create_index([("conversation_id", ASCENDING), ("created_at", ASCENDING)], name="conversation_created_at")

    # Conversation state (per user per conversation)
    st.create_index([("conversation_id", ASCENDING), ("user_id", ASCENDING)], unique=True, name="state_uq")
    st.create_index([("user_id", ASCENDING), ("last_read_at", DESCENDING)], name="state_user_last_read")

    # Optional (helps if you later want to sort/filter by unread)
    st.create_index([("user_id", ASCENDING), ("unread", DESCENDING), ("updated_at", DESCENDING)], name="state_user_unread_updated")




# ----------------------------
# Notification + email helpers
# ----------------------------
def users_col():
    return get_collection("users")


def notifications_col():
    return get_collection("notifications")


def email_queue_col():
    return get_collection("email_queue")


def _safe_str(v: Any) -> str:
    return str(v).strip() if v is not None else ""


def _sender_display_name(user_id: str) -> str:
    try:
        user = users_col().find_one(
            {"$or": [{"user_id": user_id}, {"userId": user_id}]},
            {"_id": 0, "first_name": 1, "last_name": 1, "firstName": 1, "lastName": 1, "full_name": 1, "fullName": 1, "name": 1, "email": 1},
        ) or {}
    except Exception:
        return "Someone"

    parts = [
        _safe_str(user.get("full_name")),
        _safe_str(user.get("fullName")),
        " ".join([x for x in [_safe_str(user.get("first_name") or user.get("firstName")), _safe_str(user.get("last_name") or user.get("lastName"))] if x]).strip(),
        _safe_str(user.get("name")),
        _safe_str(user.get("email")),
    ]
    for part in parts:
        if part:
            return part
    return "Someone"


def _user_email_and_route(user_id: str) -> tuple[str, str]:
    try:
        user = users_col().find_one(
            {"$or": [{"user_id": user_id}, {"userId": user_id}]},
            {"_id": 0, "email": 1, "role": 1, "roles": 1},
        ) or {}
    except Exception:
        return "", "/inbox"

    role_bits: list[str] = []
    raw_role = user.get("role")
    if raw_role is not None:
        role_bits.append(str(raw_role))
    raw_roles = user.get("roles")
    if isinstance(raw_roles, list):
        role_bits.extend([str(x) for x in raw_roles])
    joined = " ".join(role_bits).lower()
    route = "/inbox"
    if re.search(r"\bstudent\b", joined):
        route = "/student/inbox"
    elif re.search(r"\bfaculty\b", joined):
        route = "/faculty/inbox"
    elif re.search(r"office\s*manager|\bom\b", joined):
        route = "/om/inbox"
    return _safe_str(user.get("email")), route


def _enqueue_message_notifications(conversation_id: str, sender_id: str, body: str) -> None:
    conversation_id = _safe_str(conversation_id)
    sender_id = _safe_str(sender_id)
    body = (body or "").strip()
    if not conversation_id or not sender_id or not body:
        return

    try:
        conv = conversations_col().find_one({"conversation_id": conversation_id}, {"_id": 0, "participants": 1}) or {}
        participants = [str(x).strip() for x in (conv.get("participants") or []) if str(x).strip()]
    except Exception:
        participants = []

    if not participants:
        return

    sender_name = _sender_display_name(sender_id)
    preview = _preview(body, 180)
    now = utcnow()

    for uid in participants:
        if uid == sender_id:
            continue
        try:
            to_email, route = _user_email_and_route(uid)

            notifications_col().insert_one({
                "notification_id": str(uuid4()),
                "user_id": uid,
                "title": f"New inbox message from {sender_name}",
                "message": preview,
                "data": {
                    "route": route,
                    "kind": "inbox_message",
                    "conversation_id": conversation_id,
                    "sender_user_id": sender_id,
                },
                "is_read": False,
                "created_at": now,
                "updated_at": now,
                "channel": "in_app",
            })

            if to_email:
                email_queue_col().insert_one({
                    "email_id": f"email_{uuid4().hex}",
                    "to": to_email,
                    "subject": f"New inbox message from {sender_name}",
                    "text": f"{sender_name} sent you a new inbox message.\n\n{preview}\n\nPlease log in to AnimoAssign to reply in your inbox.",
                    "created_at": now,
                    "updated_at": now,
                    "status": "pending",
                    "provider": "gmail",
                })
        except Exception:
            continue

# ----------------------------
# State helpers
# ----------------------------
def ensure_state(conversation_id: str, participants: List[str]) -> None:
    """
    Ensure conversation_state exists for each participant.
    Creates with unread=0, last_read_at=None.
    """
    conversation_id = str(conversation_id).strip()
    now = utcnow()
    st = convo_state_col()

    for uid in participants:
        uid = str(uid).strip()
        if not uid:
            continue
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


def get_state_map_for_user(user_id: str, conversation_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    """
    Returns: { conversation_id: { unread, last_read_at, updated_at } }
    """
    user_id = str(user_id).strip()
    ids = [str(x).strip() for x in (conversation_ids or []) if str(x).strip()]
    if not user_id or not ids:
        return {}

    st = convo_state_col()
    docs = list(
        st.find(
            {"user_id": user_id, "conversation_id": {"$in": ids}},
            {"_id": 0, "conversation_id": 1, "unread": 1, "last_read_at": 1, "updated_at": 1},
        )
    )

    out: Dict[str, Dict[str, Any]] = {}
    for d in docs:
        cid = str(d.get("conversation_id") or "").strip()
        if not cid:
            continue
        out[cid] = {
            "unread": int(d.get("unread") or 0),
            "last_read_at": d.get("last_read_at"),
            "updated_at": d.get("updated_at"),
        }
    return out


def mark_read(conversation_id: str, user_id: str) -> Dict[str, Any]:
    """
    Set unread=0 and last_read_at=now for (conversation_id, user_id).
    Returns updated state doc (without _id).
    """
    conversation_id = str(conversation_id).strip()
    user_id = str(user_id).strip()
    if not conversation_id or not user_id:
        raise ValueError("Missing conversation_id or user_id")

    now = utcnow()
    st = convo_state_col()
    doc = st.find_one_and_update(
        {"conversation_id": conversation_id, "user_id": user_id},
        {
            "$set": {
                "unread": 0,
                "last_read_at": now,
                "updated_at": now,
            },
            "$setOnInsert": {
                "conversation_id": conversation_id,
                "user_id": user_id,
                "created_at": now,
            },
        },
        upsert=True,
        return_document=ReturnDocument.AFTER,
        projection={"_id": 0},
    )
    return doc or {"conversation_id": conversation_id, "user_id": user_id, "unread": 0, "last_read_at": now}


def bump_unread_on_send(conversation_id: str, sender_id: str) -> Dict[str, int]:
    """
    Increment unread for all participants except sender.
    Keep sender unread = 0.

    Returns: { user_id: unread_int } after update (best-effort).
    """
    conversation_id = str(conversation_id).strip()
    sender_id = str(sender_id).strip()
    if not conversation_id or not sender_id:
        return {}

    conv = conversations_col()
    c = conv.find_one({"conversation_id": conversation_id}, {"_id": 0, "participants": 1})
    if not c:
        return {}

    participants = [str(x) for x in (c.get("participants") or [])]
    ensure_state(conversation_id, participants)

    now = utcnow()
    st = convo_state_col()

    # sender -> 0
    st.update_one(
        {"conversation_id": conversation_id, "user_id": sender_id},
        {"$set": {"unread": 0, "updated_at": now}},
        upsert=True,
    )

    # others -> +1
    for uid in participants:
        if uid == sender_id:
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

    # return current unread counts (best effort)
    docs = list(
        st.find(
            {"conversation_id": conversation_id, "user_id": {"$in": participants}},
            {"_id": 0, "user_id": 1, "unread": 1},
        )
    )
    out: Dict[str, int] = {}
    for d in docs:
        uid = str(d.get("user_id") or "")
        if uid:
            out[uid] = int(d.get("unread") or 0)
    return out


# ----------------------------
# Core operations (used later by Socket.IO)
# ----------------------------
def open_dm_conversation(user_id: str, target_user_id: str) -> Dict[str, Any]:
    """
    Create-or-get a DM conversation safely (no duplicates).
    Uses upsert + dm_key unique index.
    """
    user_id = str(user_id).strip()
    target_user_id = str(target_user_id).strip()
    if not user_id or not target_user_id or user_id == target_user_id:
        raise ValueError("Invalid DM participants")

    key = _dm_key(user_id, target_user_id)
    now = utcnow()
    conv = conversations_col()

    participants = sorted([user_id, target_user_id])

    doc = conv.find_one_and_update(
        {"type": "dm", "dm_key": key},
        {
            "$setOnInsert": {
                "conversation_id": str(uuid4()),
                "type": "dm",
                "dm_key": key,
                "participants": participants,
                "created_at": now,
                "updated_at": now,
                "last_message": None,
            }
        },
        upsert=True,
        return_document=ReturnDocument.AFTER,
        projection={"_id": 0},
    )

    # Ensure per-user state exists (unread persisted here)
    ensure_state(doc["conversation_id"], participants)

    return doc


def insert_message(conversation_id: str, sender_id: str, body: str) -> Dict[str, Any]:
    """
    Insert a message, update conversation last_message/updated_at,
    and bump unread counters in conversation_state.
    """
    conversation_id = str(conversation_id).strip()
    sender_id = str(sender_id).strip()
    body = (body or "").strip()

    if not conversation_id or not sender_id or not body:
        raise ValueError("Missing conversation_id, sender_id, or body")

    now = utcnow()

    msg_doc: Dict[str, Any] = {
        "message_id": str(uuid4()),
        "conversation_id": conversation_id,
        "sender_id": sender_id,
        "body": body,
        "created_at": now,
    }

    msg = messages_col()
    msg.insert_one(msg_doc)

    conv = conversations_col()
    conv.update_one(
        {"conversation_id": conversation_id},
        {
            "$set": {
                "updated_at": now,
                "last_message": {
                    "message_id": msg_doc["message_id"],
                    "sender_id": sender_id,
                    "preview": _preview(body),
                    "created_at": now,
                },
            }
        },
    )

    # Phase 9: persist unread updates (others +1, sender = 0)
    bump_unread_on_send(conversation_id, sender_id)

    # Also notify recipients through the shared in-app notifications feed + Gmail queue.
    # This keeps Inbox conversations visible to users even when they are not actively viewing the thread.
    _enqueue_message_notifications(conversation_id, sender_id, body)

    msg_doc.pop("_id", None)
    return msg_doc


def list_conversations_for_user(user_id: str, limit: int = 50) -> List[Dict[str, Any]]:
    """
    Original conversation list. (Unread is stored in conversation_state,
    so Socket.IO layer should join it in conversation_list.)
    """
    user_id = str(user_id).strip()
    if not user_id:
        return []
    conv = conversations_col()
    docs = list(
        conv.find({"participants": user_id}, {"_id": 0})
        .sort("updated_at", DESCENDING)
        .limit(int(limit))
    )
    return docs


def list_messages(conversation_id: str, limit: int = 30, before: Optional[datetime] = None) -> List[Dict[str, Any]]:
    conversation_id = str(conversation_id).strip()
    if not conversation_id:
        return []

    q: Dict[str, Any] = {"conversation_id": conversation_id}
    if before is not None:
        q["created_at"] = {"$lt": before}

    msg = messages_col()
    docs = list(
        msg.find(q, {"_id": 0})
        .sort("created_at", DESCENDING)
        .limit(int(limit))
    )
    # Return newest->oldest; frontend can reverse if needed
    return docs
