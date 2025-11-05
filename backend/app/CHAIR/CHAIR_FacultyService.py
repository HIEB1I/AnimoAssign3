from fastapi import APIRouter, Query
from typing import Any, Dict, Optional

router = APIRouter(prefix="/chair", tags=["chair"])

@router.post("/faculty-service")
async def chair_faculty_service(
    userId: Optional[str] = Query(None),
    action: str = Query("fetch")  # fetch | options | submit
) -> Dict[str, Any]:
    if action == "fetch":
        return {"ok": True, "services": []}
    if action == "options":
        return {"ok": True, "serviceTypes": []}
    return {"ok": False}
