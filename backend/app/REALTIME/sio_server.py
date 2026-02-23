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
# Online presence (for Delivered status)
#
# "Delivered" in the UI means: at least one recipient currently has an active
# socket connection (i.e., is online) at the moment the message is sent.
#
# We track:
# - _user_sids: user_id -> set(sid)
# - _sid_conv_ids: sid -> set(conversation_id) (for cleanup on disconnect)
# - _conv_user_counts: conversation_id -> { user_id: join_count }
# ----------------------------
_user_sids: Dict[str, set] = {}
_sid_conv_ids: Dict[str, set] = {}
_conv_user_counts: Dict[str, Dict[str, int]] = {}

# ----------------------------
# Load Assignment collaboration (realtime LA)
#
# Goals:
# - Broadcast row updates (including auto-assign) in real time to other users
#   viewing the same department + term.
# - Show "who is editing" presence similar to Google Docs (best-effort).
#
# Notes:
# - This is intentionally IN-MEMORY only. It does NOT persist drafts/changes.
# - The existing Save/Approve flows remain the source of truth in Mongo.
# ----------------------------
LA_ROOM_PREFIX = "la:"
_la_room_users: Dict[str, Dict[str, Dict[str, Any]]] = {}  # room -> user_id -> info
_sid_la_rooms: Dict[str, set] = {}  # sid -> set(room)


def _la_room_id(term_id: str, dept_id: str) -> str:
    return f"{LA_ROOM_PREFIX}{str(term_id).strip()}:{str(dept_id).strip()}"


def _loadassignment_department_ids_sync(user_id: str) -> List[str]:
    """Best-effort department scopes for Load Assignment collaboration.

    Mirrors backend/app/OM/OM_LoadAssignment._loadassignment_department_ids()
    but uses pymongo collections (sync) for Socket.IO.
    """

    uid = (user_id or "").strip()
    if not uid:
        return []

    eligible_patterns = [
        r"^Office\s*Manager$",
        r"^Department\s*Chair$",
        r"^Deparment\s*Chair$",
        r"^GS\s*Coordinator$",
    ]

    role_ids: List[str] = []
    try:
        roles = get_collection("user_roles").find(
            {"$or": [{"role_type": {"$regex": p, "$options": "i"}} for p in eligible_patterns]},
            {"_id": 0, "role_id": 1},
        )
        for rdoc in roles:
            rid = str((rdoc or {}).get("role_id") or "").strip()
            if rid and rid not in role_ids:
                role_ids.append(rid)
    except Exception:
        # fallback to common known ids
        role_ids = ["ROLE0006", "ROLE0002", "ROLE0007"]

    def _norm_scope_list(scope_val: Any) -> List[Dict[str, Any]]:
        """role_assignments.scope can be dict | list[dict] | missing."""
        if not scope_val:
            return []
        if isinstance(scope_val, dict):
            return [scope_val]
        if isinstance(scope_val, list):
            return [s for s in scope_val if isinstance(s, dict)]
        return []

    def _resolve_department_id_from_hint(hint: Any) -> str:
        """Resolve a canonical department_id from an id/name/code hint.

        Some deployments store role scopes as:
          - department_id (e.g., "DEPT0001")
          - dept_id
          - dept_code (e.g., "ST")
          - dept_name (e.g., "Department of Software Technology")
        We normalize to department_id so all eligible roles join the SAME LA room.
        """
        h = str(hint or "").strip()
        if not h:
            return ""
        # Already looks like a department_id
        if re.match(r"^DEPT\d+\s*$", h, flags=re.IGNORECASE):
            return h.strip()
        # Try dept_code or dept_name mapping
        try:
            q = {
                "$or": [
                    {"department_id": {"$regex": rf"^{re.escape(h)}$", "$options": "i"}},
                    {"dept_code": {"$regex": rf"^{re.escape(h)}$", "$options": "i"}},
                    {"dept_name": {"$regex": rf"^{re.escape(h)}$", "$options": "i"}},
                ]
            }
            d = get_collection("departments").find_one(q, {"_id": 0, "department_id": 1}) or {}
            did = str(d.get("department_id") or "").strip()
            return did
        except Exception:
            return ""

    dept_ids: List[str] = []
    try:
        cur = get_collection("role_assignments").find(
            {"user_id": uid, "role_id": {"$in": role_ids}},
            {"_id": 0, "scope": 1, "department_id": 1, "dept_id": 1},
        )
        for ra in cur:
            # 1) Direct fields (some deployments store dept here instead of scope)
            direct = str((ra or {}).get("department_id") or (ra or {}).get("dept_id") or "").strip()
            if direct:
                did = _resolve_department_id_from_hint(direct) or direct
                if did and did not in dept_ids:
                    dept_ids.append(did)

            # 2) Scoped departments (dict | list[dict])
            for sc in _norm_scope_list((ra or {}).get("scope")):
                stype = str(sc.get("type") or "").strip().lower()
                if stype != "department":
                    continue
                # support multiple key variants
                cand = (
                    sc.get("id")
                    or sc.get("department_id")
                    or sc.get("dept_id")
                    or sc.get("dept_code")
                    or sc.get("dept_name")
                )
                did = _resolve_department_id_from_hint(cand) or str(cand or "").strip()
                if did and did not in dept_ids:
                    dept_ids.append(did)
    except Exception:
        pass

    if not dept_ids:
        try:
            sp = get_collection("staff_profiles").find_one(
                {"user_id": uid},
                {"_id": 0, "department_id": 1, "dept_id": 1},
            ) or {}
            did = str(sp.get("department_id") or sp.get("dept_id") or "").strip()
            if did:
                dept_ids.append(_resolve_department_id_from_hint(did) or did)
        except Exception:
            pass

    # Stable ordering so the client can safely treat the first room as "primary".
    try:
        dept_ids = sorted({str(d).strip() for d in dept_ids if str(d).strip()})
    except Exception:
        dept_ids = [d for d in dept_ids if str(d).strip()]

    return dept_ids


def _la_upsert_presence(room_id: str, user_id: str, full_name: str, sid: str) -> None:
    room_id = str(room_id)
    uid = str(user_id).strip()
    if not room_id or not uid:
        return
    _la_room_users.setdefault(room_id, {})[uid] = {
        "userId": uid,
        "fullName": full_name,
        "sid": str(sid),
        "cursor": None,
        "updatedAt": _iso(datetime.now(timezone.utc)),
    }


def _la_remove_presence(room_id: str, user_id: str) -> None:
    room_id = str(room_id)
    uid = str(user_id).strip()
    if not room_id or not uid:
        return
    m = _la_room_users.get(room_id)
    if not m:
        return
    m.pop(uid, None)
    if not m:
        _la_room_users.pop(room_id, None)


def _la_room_snapshot(room_id: str) -> List[Dict[str, Any]]:
    m = _la_room_users.get(str(room_id)) or {}
    out: List[Dict[str, Any]] = []
    for _, info in m.items():
        out.append(
            {
                "userId": info.get("userId"),
                "fullName": info.get("fullName"),
                "cursor": info.get("cursor"),
                "updatedAt": info.get("updatedAt"),
            }
        )
    return out


def _track_user_connect(user_id: str, sid: str) -> None:
    user_id = str(user_id).strip()
    if not user_id:
        return
    _user_sids.setdefault(user_id, set()).add(str(sid))


def _track_user_disconnect(user_id: str, sid: str) -> None:
    user_id = str(user_id).strip()
    sid = str(sid)
    if not user_id:
        return
    sids = _user_sids.get(user_id)
    if not sids:
        return
    sids.discard(sid)
    if not sids:
        _user_sids.pop(user_id, None)


def _track_conv_join(user_id: str, sid: str, conversation_id: str) -> None:
    user_id = str(user_id).strip()
    conversation_id = str(conversation_id).strip()
    sid = str(sid)
    if not user_id or not conversation_id:
        return

    _sid_conv_ids.setdefault(sid, set()).add(conversation_id)
    cmap = _conv_user_counts.setdefault(conversation_id, {})
    cmap[user_id] = int(cmap.get(user_id) or 0) + 1


def _track_conv_leave_all(user_id: str, sid: str) -> None:
    """Remove a sid from all conversation join counts."""
    user_id = str(user_id).strip()
    sid = str(sid)
    conv_ids = list(_sid_conv_ids.get(sid) or [])
    if not conv_ids or not user_id:
        _sid_conv_ids.pop(sid, None)
        return

    for cid in conv_ids:
        cmap = _conv_user_counts.get(cid)
        if not cmap:
            continue
        cur = int(cmap.get(user_id) or 0)
        if cur <= 1:
            cmap.pop(user_id, None)
        else:
            cmap[user_id] = cur - 1
        if not cmap:
            _conv_user_counts.pop(cid, None)

    _sid_conv_ids.pop(sid, None)


def _online_recipients(participants: List[str], sender_id: str) -> List[str]:
    """Return recipient user_ids that currently have at least one active socket."""
    sender_id = str(sender_id).strip()
    out: List[str] = []
    for uid in participants or []:
        uid = str(uid).strip()
        if not uid or uid == sender_id:
            continue
        if _user_sids.get(uid):
            out.append(uid)
    return out


# ----------------------------
# JSON-safe helpers
# ----------------------------
def _iso(dt: datetime) -> str:
    """Return ISO timestamp in UTC with second precision and 'Z' suffix."""
    try:
        dt2 = dt.astimezone(timezone.utc).replace(microsecond=0)
    except Exception:
        dt2 = dt.replace(microsecond=0)
    s = dt2.isoformat()
    if s.endswith("+00:00"):
        s = s[:-6] + "Z"
    return s


def _json_safe(v):
    if isinstance(v, datetime):
        return _iso(v)
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

def _get_last_read_at(conversation_id: str, user_id: str) -> Optional[datetime]:
    st = get_collection("conversation_state")
    doc = st.find_one(
        {"conversation_id": str(conversation_id), "user_id": str(user_id)},
        {"_id": 0, "last_read_at": 1},
    ) or {}
    v = doc.get("last_read_at")
    return v if isinstance(v, datetime) else None



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

    peer_last_read = _get_last_read_at(conversation_id, other_id) if other_id else None

    unread = _get_unread_for_user(conversation_id, requester_id)

    return {
        "conversationId": conv.get("conversation_id"),
        "peer": peer,
        "updatedAt": conv.get("updated_at"),
        "peerLastReadAt": peer_last_read,
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

        # Track online presence (for Delivered status)
        _track_user_connect(user_id, sid)

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
    uid = str((sess or {}).get("userId") or "").strip()
    try:
        if uid:
            _track_conv_leave_all(uid, sid)
            _track_user_disconnect(uid, sid)

            # Leave Load Assignment rooms + clear presence
            la_rooms = list(_sid_la_rooms.get(str(sid)) or [])
            for room_id in la_rooms:
                try:
                    _la_remove_presence(room_id, uid)
                except Exception:
                    pass
                try:
                    await sio.leave_room(sid, room_id)
                except Exception:
                    pass
                try:
                    await sio.emit(
                        "loadassignment_presence",
                        {"roomId": room_id, "users": _la_room_snapshot(room_id)},
                        room=room_id,
                    )
                except Exception:
                    pass
            _sid_la_rooms.pop(str(sid), None)
    except Exception:
        pass
    logger.info(f"[socket] disconnect sid={sid} userId={uid}")


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

        # track presence inside this conversation room (for Delivered)
        _track_conv_join(str(user_id), sid, conv_id)

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

    # track presence inside this conversation room (for Delivered)
    _track_conv_join(str(user_id), sid, conv_id)

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

    # Notify other participants (read receipt)
    try:
        seen_at = _now_utc()
        u = await run_in_threadpool(_find_user, str(user_id), "")
        name = _full_name(u or {}) if u else str(user_id)
        await sio.emit(
            "conversation_seen",
            _json_safe({"conversationId": conv_id, "userId": str(user_id), "userName": name, "seenAt": seen_at}),
            room=f"{CONV_ROOM_PREFIX}{conv_id}",
            skip_sid=sid,
        )
    except Exception:
        pass

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

    # ----------------------------
    # Delivered status
    # "Delivered" means at least one recipient currently has an active socket.
    # ----------------------------
    delivered_to = _online_recipients(participants, str(user_id))
    delivered_to_count = len(delivered_to)
    delivered_at = _now_utc() if delivered_to_count > 0 else None

    if delivered_to_count > 0:
        try:
            await sio.emit(
                "message_delivered",
                _json_safe({
                    "conversationId": conv_id,
                    "messageId": payload.get("messageId"),
                    "deliveredAt": delivered_at,
                    "deliveredToCount": delivered_to_count,
                }),
                room=f"{USER_ROOM_PREFIX}{user_id}",
            )
        except Exception:
            pass

    return {
        "ok": True,
        "message": payload,
        "delivered": _json_safe({
            "deliveredAt": delivered_at,
            "deliveredToCount": delivered_to_count,
        }),
    }




@sio.event
async def typing_start(sid: str, data: Dict[str, Any]):
    """Notify other participants that the user is typing in a conversation."""
    sess = await sio.get_session(sid)
    user_id = (sess or {}).get("userId")
    if not user_id:
        return {"ok": False, "error": "Not authenticated"}

    conv_id = str((data or {}).get("conversationId") or "").strip()
    if not conv_id:
        return {"ok": False, "error": "Missing conversationId"}

    conv_col = get_collection("conversations")
    conv = await run_in_threadpool(lambda: conv_col.find_one({"conversation_id": conv_id}, {"_id": 0, "participants": 1}))
    if not conv or user_id not in (conv.get("participants") or []):
        return {"ok": False, "error": "Not allowed"}

    try:
        u = await run_in_threadpool(_find_user, str(user_id), "")
        name = _full_name(u or {}) if u else str(user_id)
        await sio.emit(
            "typing_update",
            _json_safe({"conversationId": conv_id, "userId": str(user_id), "userName": name, "isTyping": True}),
            room=f"{CONV_ROOM_PREFIX}{conv_id}",
            skip_sid=sid,
        )
    except Exception:
        pass

    return {"ok": True}


@sio.event
async def typing_stop(sid: str, data: Dict[str, Any]):
    """Notify other participants that the user stopped typing."""
    sess = await sio.get_session(sid)
    user_id = (sess or {}).get("userId")
    if not user_id:
        return {"ok": False, "error": "Not authenticated"}

    conv_id = str((data or {}).get("conversationId") or "").strip()
    if not conv_id:
        return {"ok": False, "error": "Missing conversationId"}

    conv_col = get_collection("conversations")
    conv = await run_in_threadpool(lambda: conv_col.find_one({"conversation_id": conv_id}, {"_id": 0, "participants": 1}))
    if not conv or user_id not in (conv.get("participants") or []):
        return {"ok": False, "error": "Not allowed"}

    try:
        u = await run_in_threadpool(_find_user, str(user_id), "")
        name = _full_name(u or {}) if u else str(user_id)
        await sio.emit(
            "typing_update",
            _json_safe({"conversationId": conv_id, "userId": str(user_id), "userName": name, "isTyping": False}),
            room=f"{CONV_ROOM_PREFIX}{conv_id}",
            skip_sid=sid,
        )
    except Exception:
        pass

    return {"ok": True}
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


# ----------------------------
# Load Assignment realtime collaboration
# ----------------------------


@sio.event
async def loadassignment_join(sid: str, data: Dict[str, Any]):
    """Join the Load Assignment collaboration room(s) for this user + term.

    Client sends: { termId?: string }
    Server resolves the user's department scope(s) and joins:
      la:{termId}:{departmentId}
    """
    sess = await sio.get_session(sid)
    user_id = (sess or {}).get("userId")
    if not user_id:
        return {"ok": False, "error": "Not authenticated"}

    term_id = str((data or {}).get("termId") or (data or {}).get("term_id") or "").strip()
    if not term_id:
        return {"ok": False, "error": "Missing termId"}

    # Resolve dept scopes
    dept_ids = await run_in_threadpool(_loadassignment_department_ids_sync, str(user_id))
    dept_ids = [d for d in dept_ids if str(d).strip()]
    if not dept_ids:
        return {"ok": False, "error": "No department scope found"}

    # Resolve presence name
    u = await run_in_threadpool(_find_user, str(user_id), "")
    name = _full_name(u) if u else str(user_id)

    rooms: List[str] = []
    for dept_id in dept_ids:
        room_id = _la_room_id(term_id, dept_id)
        rooms.append(room_id)
        try:
            await sio.enter_room(sid, room_id)
        except Exception:
            continue

        _sid_la_rooms.setdefault(str(sid), set()).add(room_id)
        _la_upsert_presence(room_id, str(user_id), name, sid)

        # broadcast updated presence to the room
        try:
            await sio.emit(
                "loadassignment_presence",
                {"roomId": room_id, "users": _la_room_snapshot(room_id)},
                room=room_id,
            )
        except Exception:
            pass

    return {"ok": True, "rooms": rooms}


@sio.event
async def loadassignment_leave(sid: str, data: Dict[str, Any]):
    sess = await sio.get_session(sid)
    user_id = (sess or {}).get("userId")
    if not user_id:
        return {"ok": False, "error": "Not authenticated"}

    rooms = (data or {}).get("rooms")
    if not isinstance(rooms, list):
        rooms = []

    for room_id in rooms:
        rid = str(room_id)
        if not rid:
            continue
        try:
            await sio.leave_room(sid, rid)
        except Exception:
            pass
        try:
            _la_remove_presence(rid, str(user_id))
        except Exception:
            pass
        try:
            await sio.emit(
                "loadassignment_presence",
                {"roomId": rid, "users": _la_room_snapshot(rid)},
                room=rid,
            )
        except Exception:
            pass

        try:
            s = _sid_la_rooms.get(str(sid))
            if s:
                s.discard(rid)
                if not s:
                    _sid_la_rooms.pop(str(sid), None)
        except Exception:
            pass

    return {"ok": True}


@sio.event
async def loadassignment_cursor(sid: str, data: Dict[str, Any]):
    """Broadcast cursor/selection for presence indicator.

    Client sends: { roomId, rowId?, field? }
    """
    sess = await sio.get_session(sid)
    user_id = (sess or {}).get("userId")
    if not user_id:
        return {"ok": False, "error": "Not authenticated"}

    room_id = str((data or {}).get("roomId") or "").strip()
    if not room_id:
        return {"ok": False, "error": "Missing roomId"}

    row_id = str((data or {}).get("rowId") or "").strip() or None
    field = str((data or {}).get("field") or "").strip() or None

    try:
        m = _la_room_users.get(room_id)
        if m and str(user_id) in m:
            m[str(user_id)]["cursor"] = {"rowId": row_id, "field": field}
            m[str(user_id)]["updatedAt"] = _iso(datetime.now(timezone.utc))
    except Exception:
        pass

    payload = {
        "roomId": room_id,
        "userId": str(user_id),
        "rowId": row_id,
        "field": field,
    }
    await sio.emit("loadassignment_cursor", payload, room=room_id, skip_sid=sid)

    # Also update the presence snapshot (cheap, best-effort)
    try:
        await sio.emit(
            "loadassignment_presence",
            {"roomId": room_id, "users": _la_room_snapshot(room_id)},
            room=room_id,
        )
    except Exception:
        pass

    return {"ok": True}


@sio.event
async def loadassignment_row_update(sid: str, data: Dict[str, Any]):
    """Broadcast a finalized row object to all other editors in the room."""
    sess = await sio.get_session(sid)
    user_id = (sess or {}).get("userId")
    if not user_id:
        return {"ok": False, "error": "Not authenticated"}

    room_id = str((data or {}).get("roomId") or "").strip()
    row = (data or {}).get("row")
    if not room_id or not isinstance(row, dict):
        return {"ok": False, "error": "Invalid payload"}

    payload = {"roomId": room_id, "row": row, "senderId": str(user_id)}
    await sio.emit("loadassignment_row_update", payload, room=room_id, skip_sid=sid)
    return {"ok": True}


@sio.event
async def loadassignment_bulk_update(sid: str, data: Dict[str, Any]):
    """Broadcast many rows (used by Auto-Assign)."""
    sess = await sio.get_session(sid)
    user_id = (sess or {}).get("userId")
    if not user_id:
        return {"ok": False, "error": "Not authenticated"}

    room_id = str((data or {}).get("roomId") or "").strip()
    rows = (data or {}).get("rows")
    if not room_id or not isinstance(rows, list):
        return {"ok": False, "error": "Invalid payload"}

    payload = {"roomId": room_id, "rows": rows, "senderId": str(user_id)}
    await sio.emit("loadassignment_bulk_update", payload, room=room_id, skip_sid=sid)
    return {"ok": True}
