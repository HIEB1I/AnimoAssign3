# backend/app/FACULTY/FACULTY_Overview.py
from fastapi import APIRouter, Query, HTTPException
from ..main import db
from datetime import datetime, timezone
from typing import Any, Dict, List

router = APIRouter(prefix="/faculty", tags=["faculty"])

def _now_utc():
    return datetime.now(timezone.utc)

async def _get_current_term() -> Dict[str, Any] | None:
    # 1) prefer is_current == True
    term = await db.terms.find_one({"is_current": True}, {"_id": 0})
    if term:
        return term

    # 2) within date range (if dates exist)
    now = _now_utc()
    term = await db.terms.find_one(
        {"start_date": {"$lte": now}, "end_date": {"$gte": now}},
        {"_id": 0},
    )
    if term:
        return term

    # 3) newest by term_index (or start_date desc)
    term = await db.terms.find_one({}, {"_id": 0}, sort=[("term_index", -1)])
    if term:
        return term

    return None

def _term_label(t: Dict[str, Any]) -> str:
    ay = str(t.get("acad_year_start", "")).strip()
    try:
        ay_next = str(int(ay) + 1)
    except Exception:
        ay_next = ""
    tn = t.get("term_number", "")
    if ay and ay_next and tn:
        return f"AY {ay}-{ay_next} • Term {tn}"
    if tn:
        return f"Term {tn}"
    return "Current Term"

@router.get("/overview")
async def get_faculty_overview(userId: str = Query(...)):
    """
    Faculty overview:
    - profile
    - current term
    - summary
    - teaching load (per day rows)
    - notifications
    """
    # ---- Faculty profile (required) ----
    faculty = await db.faculty_profiles.find_one({"user_id": userId}, {"_id": 0})
    if not faculty:
        raise HTTPException(status_code=404, detail="Faculty not found")

    # ---- Department (optional) ----
    dept = await db.departments.find_one(
        {"department_id": faculty.get("department_id")},
        {"_id": 0, "dept_name": 1},
    )

    # ---- Term (graceful resolve) ----
    term = await _get_current_term()
    if not term:
        term = {"term_id": None, "term_label": "No Active Term"}
    else:
        term.setdefault("term_label", _term_label(term))

    # ---- Load + assignments (optional) ----
    load = await db.faculty_loads.find_one(
        {
            "department_id": faculty.get("department_id"),
            **({"term_id": term.get("term_id")} if term.get("term_id") else {}),
        },
        {"_id": 0},
    ) or {}

    assignments: List[Dict[str, Any]] = await db.faculty_assignments.find(
        {"faculty_id": faculty.get("faculty_id"), "is_archived": False},
        {"_id": 0},
    ).to_list(None)

    section_ids = [a["section_id"] for a in assignments if "section_id" in a]
    sections: List[Dict[str, Any]] = []
    if section_ids:
        sections = await db.sections.find(
            {"section_id": {"$in": section_ids}}, {"_id": 0}
        ).to_list(None)

    schedules: List[Dict[str, Any]] = []
    if section_ids:
        schedules = await db.section_schedules.find(
            {"section_id": {"$in": section_ids}}, {"_id": 0}
        ).to_list(None)

    # courses
    course_ids = [s.get("course_id") for s in sections if "course_id" in s]
    courses: List[Dict[str, Any]] = []
    if course_ids:
        courses = await db.courses.find(
            {"course_id": {"$in": course_ids}}, {"_id": 0}
        ).to_list(None)

    # build teaching load rows (safe defaults)
    teaching_load: List[Dict[str, Any]] = []
    for sc in schedules:
        sec = next((s for s in sections if s.get("section_id") == sc.get("section_id")), {})
        course = next((c for c in courses if c.get("course_id") == sec.get("course_id")), {})
        room = None
        if sc.get("room_id"):
            room = await db.rooms.find_one({"room_id": sc["room_id"]}, {"_id": 0})
        teaching_load.append(
            {
                "day": sc.get("day", ""),
                "course_code": course.get("course_code", ""),
                "course_title": course.get("course_title", ""),
                "section": sec.get("section_code", ""),
                "units": course.get("units", 0) or 0,
                "campus": (room or {}).get("campus_id", "Online"),
                "mode": sc.get("room_type", "Online"),
                "room": (room or {}).get("room_number", "Online"),
                "time": f"{sc.get('start_time','')} - {sc.get('end_time','')}".strip(" -"),
            }
        )

    # summary
    total_units = sum((row.get("units") or 0) for row in teaching_load)
    max_units = faculty.get("max_units", 18) or 18
    course_preps = len(set(r.get("course_code", "") for r in teaching_load if r.get("course_code")))
    status = (load.get("status") or "pending").capitalize()

    summary = {
        "teaching_units": f"{total_units}/{max_units}",
        "course_preps": f"{course_preps}/{faculty.get('max_preps', 3) or 3}",
        "load_status": status,
        "percent": int((total_units / max_units) * 100) if max_units else 0,
    }

    notifications = await db.faculty_notifications.find(
        {"user_id": userId}, {"_id": 0}
    ).to_list(None)

    return {
        "ok": True,
        "faculty": {
            "full_name": f"{faculty.get('first_name','').strip()} {faculty.get('last_name','').strip()}".strip(),
            "role": "Faculty",
            "department": (dept or {}).get("dept_name", "—"),
        },
        "term": term,
        "summary": summary,
        "teaching_load": teaching_load,
        "notifications": notifications,
    }
