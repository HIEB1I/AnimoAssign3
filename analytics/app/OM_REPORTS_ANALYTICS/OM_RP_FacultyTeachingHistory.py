# analytics/app/OM_REPORTS_ANALYTICS/OM_RP_FacultyTeachingHistory.py

from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Query

from ..config import get_settings
from ..db_async import get_db  # reuse the shared Mongo client/db

router = APIRouter(tags=["OM Reports • Faculty Teaching History"])

def _fmt_hhmm(raw: Optional[str]) -> str:
    s = (raw or "").strip()
    if not s:
        return ""
    s = s.zfill(4)
    return f"{s[:-2]}:{s[-2:]}"

def _derive_room_type_from_room(room_value: Optional[str]) -> Optional[str]:
    val = (room_value or "").strip()
    if val == "" or val.lower() == "online":
        return "Online"
    if val.upper() == "TBA":
        return None
    return "Classroom"

def _ay_label(start: Optional[int]) -> Optional[str]:
    if start is None:
        return None
    try:
        return f"AY {start}–{start + 1}"
    except Exception:
        return None

async def fetch_teaching_history(faculty_id: str) -> List[Dict[str, Any]]:
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
            raw_room_id = (s.get("room_id") or "").strip()
 
            display_room = "TBA"

            if raw_room_id:
                room_doc = await db["rooms"].find_one({"room_id": raw_room_id})
                print("sched debug:", s, "room_doc:", room_doc)  # TEMP DEBUG

                if room_doc:
                    rn = (room_doc.get("room_number") or "").strip()
                    if rn:
                        display_room = rn

            print("sched debug:", s, "display_room:", display_room)

            formatted_sched.append({
                "day": s.get("day"),
                "start_time": _fmt_hhmm(s.get("start_time")),
                "end_time": _fmt_hhmm(s.get("end_time")),
                "room": display_room,
            })

        def _course_code(val):
            if isinstance(val, list):
                return val[0] if val else None
            return val

        ay_start: Optional[int] = term.get("acad_year_start") if term else None
        ay_label = _ay_label(ay_start)
        term_number: Optional[int] = term.get("term_number") if term else None

        results.append({
            # keep raw ids if you still need them downstream
            "term_id": term["term_id"] if term else None,

            # <<< changed: use Academic Year for display/grouping >>>
            "term_name": ay_label or "AY N/A",

            # optional extras (not required by your UI, but handy)
            "acad_year_start": ay_start,
            "term_number": term_number,

            "course_code": _course_code(course.get("course_code") if course else None),
            "course_title": course.get("course_title") if course else None,
            "section_code": section.get("section_code"),
            "units": course.get("units") if course else None,
            "modality": None,
            "campus_id": None,
            "schedule": formatted_sched,
        })

    # sort by academic year then term number then course/section
    results.sort(key=lambda r: (
        r.get("acad_year_start") if r.get("acad_year_start") is not None else -1,
        r.get("term_number") if r.get("term_number") is not None else -1,
        (r.get("course_code") or ""),
        (r.get("section_code") or ""),
    ))
    return results

@router.get("/analytics/teaching-history")
async def get_teaching_history(faculty_id: str = Query(...)):
    rows = await fetch_teaching_history(faculty_id)
    return {"faculty_id": faculty_id, "count": len(rows), "rows": rows}
