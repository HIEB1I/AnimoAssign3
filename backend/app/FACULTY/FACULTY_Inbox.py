# backend/app/FACULTY/FACULTY_History.py

from fastapi import APIRouter, Query, HTTPException
from ..main import db

router = APIRouter(prefix="/faculty", tags=["faculty"])

@router.get("/inbox")
async def get_faculty_inbox(userId: str = Query(...)):
    inbox = await db.faculty_inbox.find({"user_id": userId}, {"_id": 0}).to_list(None)
    return {"ok": True, "inbox": inbox or []}
