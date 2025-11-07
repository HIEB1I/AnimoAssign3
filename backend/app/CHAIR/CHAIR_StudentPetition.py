from fastapi import APIRouter, Query
from typing import Any, Dict, Optional

router = APIRouter(prefix="/chair", tags=["chair"])

@router.post("/student-petitions")
async def chair_student_petitions(
    userId: Optional[str] = Query(None),
    action: str = Query("fetch")  # fetch | options | update
) -> Dict[str, Any]:
    if action == "fetch":
        return {"ok": True, "rows": []}
    if action == "options":
        return {"ok": True, "statuses": ["Pending", "Approved", "Rejected"]}
    return {"ok": False}
