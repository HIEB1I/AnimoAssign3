from fastapi import APIRouter, Query
from ..main import db

router = APIRouter(prefix="/admin", tags=["admin"])

@router.get("/inbox")
async def get_admin_inbox(userId: str = Query(...)):
    inbox = await db.admin_inbox.find({"user_id": userId}, {"_id": 0}).to_list(None)
    return {"ok": True, "inbox": inbox or []}
