# backend/app/CHAIR/CHAIR_Inbox.py
from fastapi import APIRouter, Query
from ..main import db

router = APIRouter(prefix="/chair", tags=["chair"])

@router.get("/inbox")
async def get_chair_inbox(userId: str = Query(...)):
    """
    Chair Inbox feed, mirroring OM's /om/inbox.
    Returns messages for userId from 'chair_inbox'.
    UI expects: id, from, email, subject, preview/body, receivedAt.
    """
    inbox = await db.chair_inbox.find({"user_id": userId}, {"_id": 0}).to_list(None)
    return {"ok": True, "inbox": inbox or []}
