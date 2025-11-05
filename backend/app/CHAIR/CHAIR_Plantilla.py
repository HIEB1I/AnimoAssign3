from fastapi import APIRouter, Query
from typing import Any, Dict, Optional

router = APIRouter(prefix="/chair", tags=["chair"])

@router.get("/plantilla")
async def chair_plantilla(
    userId: Optional[str] = Query(None),
    action: str = Query("header")  # header | options
) -> Dict[str, Any]:
    if action == "header":
        return {"ok": True, "profileName": "Chair", "profileSubtitle": "Department Chair"}
    if action == "options":
        return {"ok": True, "buttons": [
            {"label": "Plantilla", "to": "/chair/plantilla"},
            {"label": "Faculty Directory", "to": "/chair/faculty-management"},
            {"label": "Course Management", "to": "/chair/course-management"},
            {"label": "Faculty Service", "to": "/chair/faculty-service"},
            {"label": "Student Petition", "to": "/chair/student-petitions"},
            {"label": "Class Retention", "to": "/chair/class-retention"},
        ]}
    return {"ok": False}
