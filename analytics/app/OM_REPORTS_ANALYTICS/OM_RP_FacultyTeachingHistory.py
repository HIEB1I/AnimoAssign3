# analytics/app/OM_REPORTS_ANALYTICS/OM_RP_FacultyTeachingHistory.py
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Query

from ..config import get_settings
from ..db_async import get_db  # reuse the shared Mongo client/db

router = APIRouter(tags=["OM Reports • Faculty Teaching History"])

# ---------- helpers (ported from db_async) ----------
def _fmt_hhmm(raw: Optional[str]) -> str:
    """'730' → '07:30', '900' → '09:00'."""
    s = (raw or "").strip()
    if not s:
        return ""
    s = s.zfill(4)  # '730' -> '0730'
    return f"{s[:-2]}:{s[-2:]}"

def _derive_room_type_from_room(room_value: Optional[str]) -> Optional[str]:
    val = (room_value or "").strip()
    if val == "" or val.lower() == "online":
        return "Online"
    if val.upper() == "TBA":
        return None
    return "Classroom"

# ---------- core query (ported from db_async) ----------
async def fetch_teaching_history(faculty_id: str) -> List[Dict[str, Any]]:
    """
    Joins by business keys (section_id, course_id, term_id).
    Collections:
      - faculty_assignments
      - sections
      - courses
      - terms
      - section_schedules
    """
    db = get_db()

    assignments = await db["faculty_assignments"] \
        .find({"faculty_id": faculty_id, "is_archived": {"$ne": True}}) \
        .to_list(length=None)
    if not assignments:
        return []

    results: List[Dict[str, Any]] = []

    for fa in assignments:
        section = await db["sections"].find_one({"section_id": fa["section_id"]})
        if not section:
            continue

        course = await db["courses"].find_one({"course_id": section.get("course_id")})
        term   = await db["terms"].find_one({"term_id": section.get("term_id")})

        sched_docs = await db["section_schedules"] \
            .find({"section_id": section["section_id"]}) \
            .to_list(length=None)

        formatted_sched: List[Dict[str, Any]] = []
        for s in sched_docs:
            stored_rt = s.get("room_type")
            room_val = s.get("room") or s.get("room_id")
            rt = stored_rt if stored_rt is not None else _derive_room_type_from_room(room_val)
            formatted_sched.append({
                "day": s.get("day"),
                "start_time": _fmt_hhmm(s.get("start_time")),
                "end_time": _fmt_hhmm(s.get("end_time")),
                "room": room_val,
                "room_type": rt,
            })

        def _course_code(val):
            if isinstance(val, list):
                return val[0] if val else None
            return val

        results.append({
            "term_id": term["term_id"] if term else None,
            "term_name": (term["term_id"] if term else None),
            "course_code": _course_code(course.get("course_code") if course else None),
            "course_title": course.get("course_title") if course else None,
            "section_code": section.get("section_code"),
            "units": course.get("units") if course else None,
            "modality": None,
            "campus_id": None,
            "schedule": formatted_sched,
        })

    results.sort(key=lambda r: (
        (r.get("term_name") or ""),
        (r.get("course_code") or ""),
        (r.get("section_code") or ""),
    ))
    return results

# ---------- router endpoint (same URL shape used by frontend) ----------
@router.get("/analytics/teaching-history")
async def get_teaching_history(faculty_id: str = Query(...)):
    rows = await fetch_teaching_history(faculty_id)
    return {"faculty_id": faculty_id, "count": len(rows), "rows": rows}
