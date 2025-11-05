from fastapi import APIRouter, Query
from typing import Any, Dict, Optional

router = APIRouter(prefix="/chair", tags=["chair"])

@router.post("/course-management")
async def chair_course_mgt(
    userId: Optional[str] = Query(None),
    action: str = Query("fetch")  # fetch | options
) -> Dict[str, Any]:
    if action == "fetch":
        return {"ok": True, "rows": []}
    if action == "options":
        return {"ok": True, "clusters": []}
    return {"ok": False}
