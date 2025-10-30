# backend/app/OM/OM_Inbox.py
from fastapi import APIRouter, Query
from ..main import db

router = APIRouter(prefix="/om", tags=["om"])

@router.get("/inbox")
async def get_om_inbox(userId: str = Query(...)):
    """
    Office Manager Inbox feed, mirroring Faculty's /faculty/inbox pattern.
    Returns messages for the given userId from the 'om_inbox' collection.
    Document shape is flexible; UI maps common fields: id, from, email, subject, preview/body, receivedAt.
    """
    inbox = await db.om_inbox.find({"user_id": userId}, {"_id": 0}).to_list(None)
    return {"ok": True, "inbox": inbox or []}
