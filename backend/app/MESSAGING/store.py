# backend/app/MESSAGING/store.py
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
from uuid import uuid4

from pymongo import ASCENDING, DESCENDING, ReturnDocument
from pymongo.errors import DuplicateKeyError

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

    # Store participants sorted to keep consistency
    participants = sorted([user_id, target_user_id])

    # Use atomic upsert to avoid race duplicates
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

    # Ensure per-user state exists (for unread later)
    st = convo_state_col()
    for uid in participants:
        st.update_one(
            {"conversation_id": doc["conversation_id"], "user_id": uid},
            {"$setOnInsert": {"last_read_at": None, "created_at": now}},
            upsert=True,
        )

    return doc


def insert_message(conversation_id: str, sender_id: str, body: str) -> Dict[str, Any]:
    """
    Insert a message, update conversation last_message/updated_at.
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

    # Return without Mongo _id
    msg_doc.pop("_id", None)
    return msg_doc


def list_conversations_for_user(user_id: str, limit: int = 50) -> List[Dict[str, Any]]:
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
