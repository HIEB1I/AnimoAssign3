from fastapi import APIRouter, Query
from typing import Any, Dict, Optional

router = APIRouter(prefix="/chair", tags=["chair"])

@router.post("/inbox")
async def chair_inbox(
    userId: Optional[str] = Query(None),
    action: str = Query("fetch")  # fetch
) -> Dict[str, Any]:
    return {"ok": True, "messages": []}
