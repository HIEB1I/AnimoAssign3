from fastapi import APIRouter, Body, HTTPException, Query
from pydantic import BaseModel, EmailStr
from typing import Any, Dict, List, Optional
from datetime import datetime

from ..main import db


router = APIRouter(prefix="/apo", tags=["apo"])


class SendInboxPayload(BaseModel):
    to: EmailStr
    subject: Optional[str] = ""
    body: Optional[str] = ""


async def _roles_for_user(user_id: str) -> List[str]:
    # role_assignments.user_id -> role_id -> user_roles.role_type
    ra_cursor = db["role_assignments"].find(
        {"user_id": user_id},
        {"_id": 0, "role_id": 1},
    )
    role_ids = [doc.get("role_id") async for doc in ra_cursor if doc.get("role_id")]
    if not role_ids:
        return []

    ur_cursor = db["user_roles"].find(
        {"role_id": {"$in": role_ids}},
        {"_id": 0, "role_type": 1},
    )
    raw = [doc.get("role_type") for doc in await ur_cursor.to_list(None)]
    return [str(r).strip().lower() for r in raw if r]


def _inbox_collection_for_roles(roles: List[str]) -> str:
    rset = set([r.strip().lower() for r in roles if r])
    if "office manager" in rset or "gs coordinator" in rset:
        return "om_inbox"
    if any(r.startswith("apo") for r in rset):
        return "apo_inbox"
    if "faculty" in rset:
        return "faculty_inbox"
    if "department chair" in rset or "chair" in rset or "deparment chair" in rset:
        return "chair_inbox"
    if "admin" in rset:
        return "admin_inbox"
    return "user_inbox"


async def _user_display(user_id: str) -> Dict[str, str]:
    u = await db["users"].find_one(
        {"user_id": user_id},
        {"_id": 0, "first_name": 1, "last_name": 1, "email": 1},
    ) or {}
    first = (u.get("first_name") or "").strip()
    last = (u.get("last_name") or "").strip()
    name = f"{first} {last}".strip() or user_id
    email = (u.get("email") or "").strip()
    return {"name": name, "email": email}


@router.get("/inbox")
async def get_apo_inbox(userId: str = Query(...)) -> Dict[str, Any]:
    """APO Inbox feed."""
    inbox = await db.apo_inbox.find({"user_id": userId}, {"_id": 0}).to_list(None)
    return {"ok": True, "inbox": inbox or []}


@router.post("/inbox")
async def post_apo_inbox(
    userId: str = Query(...),
    action: str = Query("send"),
    payload: SendInboxPayload = Body(...),
) -> Dict[str, Any]:
    """Minimal send/save used by the APO Inbox Compose/Reply buttons.

    Saves a record in the sender's APO inbox (as "sent") and, if the recipient email
    matches a user, stores a copy in the recipient's role-based inbox collection.
    """
    if action != "send":
        raise HTTPException(status_code=400, detail="Unsupported action")

    now = datetime.utcnow()
    msg_id = int(now.timestamp() * 1000)
    sender = await _user_display(userId)

    subject = (payload.subject or "").strip() or "(No subject)"
    body = (payload.body or "").strip()
    preview = body[:200]

    sent_doc = {
        "id": msg_id,
        "user_id": userId,
        "from": sender["name"],
        "email": str(payload.to),
        "subject": subject,
        "preview": preview,
        "body": body,
        "receivedAt": now,
        "direction": "sent",
        "to": str(payload.to),
        "from_user_id": userId,
    }
    await db.apo_inbox.insert_one(sent_doc)

    delivered = False
    recipient_user = await db["users"].find_one(
        {"email": str(payload.to)},
        {"_id": 0, "user_id": 1},
    )
    if recipient_user and recipient_user.get("user_id"):
        rid = str(recipient_user["user_id"])
        roles = await _roles_for_user(rid)
        col = _inbox_collection_for_roles(roles)
        recv_doc = {
            "id": msg_id,
            "user_id": rid,
            "from": sender["name"],
            "email": sender["email"] or "",
            "subject": subject,
            "preview": preview,
            "body": body,
            "receivedAt": now,
            "direction": "inbox",
            "to": str(payload.to),
            "from_user_id": userId,
        }
        await db[col].insert_one(recv_doc)
        delivered = True

    return {"ok": True, "sent": True, "delivered": delivered}
