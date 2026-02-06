# backend/app/CHAIR/CHAIR_Inbox.py
from fastapi import APIRouter, Query
from fastapi.concurrency import run_in_threadpool
from typing import Any, Dict, List, Optional

from ..db import get_collection

router = APIRouter(prefix="/chair", tags=["chair"])


@router.get("/inbox")
async def get_chair_inbox(userId: str = Query(...)) -> Dict[str, Any]:
    """
    Chair Inbox feed.
    Returns messages for userId from 'chair_inbox'.
    UI expects: id, from, email, subject, preview/body, receivedAt.
    """
    col = get_collection("chair_inbox")

    def _fetch() -> List[Dict[str, Any]]:
        return list(col.find({"user_id": userId}, {"_id": 0}))

    inbox = await run_in_threadpool(_fetch)
    return {"ok": True, "inbox": inbox or []}


# (Optional) Keep POST for backwards compatibility if you ever used it
@router.post("/inbox")
async def chair_inbox_compat(
    userId: Optional[str] = Query(None),
    action: str = Query("fetch"),
) -> Dict[str, Any]:
    if action != "fetch":
        return {"ok": False, "error": "Unsupported action"}
    if not userId:
        return {"ok": False, "error": "Missing userId"}
    return await get_chair_inbox(userId=userId)
