from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, HTTPException, Query
from pymongo import ReturnDocument

from ..main import db

router = APIRouter(prefix="/om", tags=["om"])

COL_USERS = "users"
COL_STAFF = "staff_profiles"
COL_FACULTY = "faculty_profiles"
COL_ASSIGN = "faculty_assignments"
COL_SECTIONS = "sections"
COL_SCHED = "section_schedules"
COL_ROOMS = "rooms"
COL_COURSES = "courses"
COL_TERMS = "terms"
COL_DEPTS = "departments"
COL_CAMPUSES = "campuses"

def _utcnow() -> datetime:
    return datetime.now(timezone.utc)

async def _active_term() -> Dict[str, Any]:
    t = await db[COL_TERMS].find_one(
        {"$or": [{"status": "active"}, {"is_current": True}]},
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
    )
    return t or {}

def _fmt_time(hhmm: Optional[str]) -> str:
    if not hhmm:
        return ""
    s = str(hhmm).strip()
    return s if len(s) in (3,4) else ""

async def _fetch_rows(userId: str) -> Dict[str, Any]:
    """
    Build UI rows (display-ready) from assignments + sections + schedules (+rooms,+courses,+users)
    Stores only IDs in DB; display fields are joined here.
    """
    active = await _active_term()
    term_id_active = active.get("term_id")

    pipeline: List[Dict[str, Any]] = [
        # If you want to scope by term: uncomment next line
        # {"$match": {"is_archived": {"$ne": True}}},
        {"$lookup": {"from": COL_SECTIONS, "localField": "section_id", "foreignField": "section_id", "as": "sec"}},
        {"$unwind": {"path": "$sec", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {"from": COL_SCHED, "localField": "section_id", "foreignField": "section_id", "as": "scheds"}},
        {"$lookup": {"from": COL_COURSES, "localField": "sec.course_id", "foreignField": "course_id", "as": "course"}},
        {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {"from": COL_FACULTY, "localField": "faculty_id", "foreignField": "faculty_id", "as": "fac"}},
        {"$unwind": {"path": "$fac", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {"from": COL_USERS, "localField": "fac.user_id", "foreignField": "user_id", "as": "u"}},
        {"$unwind": {"path": "$u", "preserveNullAndEmptyArrays": True}},
        # Normalize course_code: array|string -> string
        {"$addFields": {
            "course_code_display": {
                "$cond": [
                    {"$isArray": "$course.course_code"},
                    {"$ifNull": [{"$arrayElemAt": ["$course.course_code", 0]}, ""]},
                    {"$ifNull": ["$course.course_code", ""]},
                ]
            },
            "faculty_name_display": {
                "$trim": { "input": {
                    "$concat": [
                        {"$ifNull": ["$u.first_name", ""]},
                        {"$cond": [{"$and":[{"$ne":["$u.first_name", None]},{"$ne":["$u.last_name", None]}]}, " ", ""]},
                        {"$ifNull": ["$u.last_name", ""]},
                    ]
                }}
            },
        }},
        {"$sort": {"_id": -1}},
        {"$limit": 200},
    ]

    items = [x async for x in db[COL_ASSIGN].aggregate(pipeline)]

    def schedule_pair(scheds: List[Dict[str, Any]]) -> Dict[str, str]:
        # Pick up to 2 distinct meetings
        s1 = (scheds[0] if len(scheds) > 0 else {}) or {}
        s2 = (scheds[1] if len(scheds) > 1 else {}) or {}
        def room_label(s: Dict[str, Any]) -> str:
            # Prefer explicit Online/TBA if provided; else join to rooms later if needed
            t = (s.get("room_type") or "").strip()
            if t in ("Online", "TBA"):
                return t
            rid = s.get("room_id")
            return rid or ""
        return {
            "day1": s1.get("day", "") or "",
            "begin1": _fmt_time(s1.get("start_time")) or "",
            "end1": _fmt_time(s1.get("end_time")) or "",
            "room1": room_label(s1),
            "day2": s2.get("day", "") or "",
            "begin2": _fmt_time(s2.get("start_time")) or "",
            "end2": _fmt_time(s2.get("end_time")) or "",
            "room2": room_label(s2),
        }

    rows: List[Dict[str, Any]] = []
    for it in items:
        scheds = it.get("scheds") or []
        pair = schedule_pair(scheds)

        rows.append({
            "id": it.get("assignment_id") or it.get("_id") or "",
            "course": it.get("course_code_display") or "",
            "title": (it.get("course") or {}).get("course_title", "") or "",
            "units": (it.get("course") or {}).get("units", "") or "",
            "section": (it.get("sec") or {}).get("section_code", "") or "",
            "faculty": it.get("faculty_name_display") or "",
            **pair,
            "capacity": (it.get("sec") or {}).get("enrollment_cap", "") or "",
            "status": "Pending" if it.get("faculty_id") else "Unassigned",
        })

    return {
        "term": (f"AY {active.get('acad_year_start')}-{(active.get('acad_year_start') or 0)+1} T{active.get('term_number')}"
                 if active else ""),
        "rows": rows,
    }

@router.post("/loadassignment")
async def loadassignment_handler(
    userId: str = Query(..., min_length=3),
    action: str = Query("fetch", description="fetch | options | profile | submit"),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    if action == "fetch":
        data = await _fetch_rows(userId)
        return data

    if action == "options":
        # Keep minimal for now; extend dropdowns later if UI needs them
        depts = [d async for d in db[COL_DEPTS].find(
            {}, {"_id": 0, "department_id": 1, "department_name": 1, "dept_name": 1}
        )]
        return {
            "ok": True,
            "departments": [ (d.get("department_name") or d.get("dept_name") or "").strip() for d in depts if d ],
            "statuses": ["Confirmed", "Pending", "Unassigned", "Conflict"],
        }

    if action == "profile":
        staff = await db[COL_STAFF].find_one({"user_id": userId}, {"_id": 0, "staff_id": 1, "position_title": 1})
        return {"ok": bool(staff), **(staff or {})}

    if action == "submit":
        # Validate
        if not isinstance(payload, dict) or not isinstance(payload.get("rows"), list):
            raise HTTPException(status_code=400, detail="Invalid payload; expected { rows: [...] }")

        # This is intentionally minimal: we don’t alter schema here.
        # In a real flow you might upsert assignments, set approvals, etc.
        # We return rows in a display-ready shape immediately (optimistic UI).
        submitted_rows = payload["rows"]
        # TODO: enforce active-term scope; map faculty display -> faculty_id, etc.
        return {"ok": True, "rows": submitted_rows}

    raise HTTPException(status_code=400, detail="Invalid action parameter.")
