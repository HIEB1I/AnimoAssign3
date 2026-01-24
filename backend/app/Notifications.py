# backend/app/Notifications.py
# -----------------------------------------------------------------------------
# In-app notifications stored in MongoDB.
# This powers the reusable Topbar bell across roles.
# -----------------------------------------------------------------------------

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional
from uuid import uuid4

from fastapi import APIRouter, Body, HTTPException, Query

from .main import db

router = APIRouter(prefix="/notifications", tags=["notifications"])

COL_NOTIFS = "notifications"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def create_notification(
    user_id: str,
    title: str,
    details: str,
    meta: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Create a single notification for a user."""

    doc: Dict[str, Any] = {
        "notif_id": f"NTF{uuid4().hex[:12].upper()}",
        "user_id": user_id,
        "title": title,
        "details": details,
        "created_at": _now_iso(),
        "seen": False,
        "seen_at": None,
        "meta": meta or {},
    }

    await db[COL_NOTIFS].insert_one(doc)
    doc.pop("_id", None)
    return doc


@router.get("")
async def list_notifications(
    userId: str = Query(..., description="Current logged-in user's id"),
    limit: int = Query(25, ge=1, le=100),
) -> Dict[str, Any]:
    cur = (
        db[COL_NOTIFS]
        .find({"user_id": userId}, {"_id": 0})
        .sort([("created_at", -1)])
        .limit(limit)
    )
    rows = [doc async for doc in cur]
    return {"ok": True, "rows": rows}


@router.post("/mark-seen")
async def mark_seen(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    user_id = payload.get("userId")
    if not user_id:
        raise HTTPException(status_code=400, detail="userId is required")

    ids = payload.get("ids") or []
    mark_all = bool(payload.get("all"))

    q: Dict[str, Any] = {"user_id": user_id}
    if mark_all:
        q["seen"] = {"$ne": True}
    else:
        if not ids:
            raise HTTPException(status_code=400, detail="Provide ids[] or set all=true")
        q["notif_id"] = {"$in": ids}

    await db[COL_NOTIFS].update_many(
        q,
        {"$set": {"seen": True, "seen_at": _now_iso()}},
    )

    return {"ok": True}
