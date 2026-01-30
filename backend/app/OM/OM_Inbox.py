# backend/app/OM/OM_Inbox.py
from fastapi import APIRouter, Query
from fastapi.concurrency import run_in_threadpool
from typing import Any, Dict, List

from ..db import get_collection

router = APIRouter(prefix="/om", tags=["om"])


@router.get("/inbox")
async def get_om_inbox(userId: str = Query(...)) -> Dict[str, Any]:
    """
    OM Inbox feed.
    Returns messages for userId from 'om_inbox'.
    UI expects: id, from, email, subject, preview/body, receivedAt.
    """
    col = get_collection("om_inbox")

    def _fetch() -> List[Dict[str, Any]]:
        return list(col.find({"user_id": userId}, {"_id": 0}))

    inbox = await run_in_threadpool(_fetch)
    return {"ok": True, "inbox": inbox or []}
