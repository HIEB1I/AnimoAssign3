from fastapi import APIRouter, Query
from typing import Any, Dict, Optional

router = APIRouter(prefix="/chair", tags=["chair"])

@router.post("/class-retention")
async def chair_class_retention(
    userId: Optional[str] = Query(None),
    action: str = Query("fetch")  # fetch | options
) -> Dict[str, Any]:
    if action == "fetch":
        return {"ok": True, "rows": []}
    if action == "options":
        return {"ok": True, "statuses": []}
    return {"ok": False}
