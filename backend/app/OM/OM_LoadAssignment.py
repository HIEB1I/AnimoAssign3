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
        # Scope to active term if present; otherwise fetch latest 200
        # (keeps DB-only source of truth; no UI changes)
        {"$lookup": {"from": COL_SECTIONS, "localField": "section_id", "foreignField": "section_id", "as": "sec"}},
        {"$unwind": {"path": "$sec", "preserveNullAndEmptyArrays": True}},
        # If we have an active term_id, filter to sections in that term
        *(([{"$match": {"sec.term_id": term_id_active}}] if term_id_active else [])),
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

    # --- inside loadassignment_handler(), replace the current "profile" branch ---
    if action == "profile":
        # --- existing lookups (users/staff) can stay as-is ---
        staff = await db["staff_profiles"].find_one(
            {"user_id": userId},
            {"_id": 0, "staff_id": 1, "position_title": 1}
        ) or {}

        u = await db["users"].find_one(
            {"user_id": userId},
            {"_id": 0, "first_name": 1, "last_name": 1}
        ) or {}
        full_name = " ".join([p for p in [(u.get("first_name") or "").strip(),
                                        (u.get("last_name") or "").strip()] if p])

        # --- NEW: resolve department via role_assignments -> departments ---
        # Grab the most recent active role assignment for this user
        ra = await db["role_assignments"].find(
            {
                "user_id": userId,
                # treat null/absent as active; you can tighten this if you track current term
                "$or": [{"is_active": True}, {"is_active": {"$exists": False}}],
            },
            {
                "_id": 0,
                "role_id": 1,
                "scope": 1,
                "updated_at": 1,
                "created_at": 1,
                "until_term_id": 1,
            },
        ).sort([("updated_at", -1), ("created_at", -1)]).to_list(5)

        dept_id = None
        role_id = None
        for row in ra or []:
            role_id = role_id or row.get("role_id")
            scopes = row.get("scope") or []
            # find the first department scope
            dep_scope = next((s for s in scopes if (s.get("type") == "department" and s.get("id"))), None)
            if dep_scope:
                dept_id = dep_scope["id"]
                break

        dept_name = ""
        if dept_id:
            d = await db["departments"].find_one(
                {"department_id": dept_id},
                {"_id": 0, "dept_name": 1, "department_name": 1, "name": 1, "dept_code": 1},
            ) or {}
            dept_name = (d.get("dept_name") or d.get("department_name") or d.get("name") or "").strip()

        # Optional: normalize role display (example for ROLE0006)
        position_title = staff.get("position_title") or ""
        if not position_title and role_id == "ROLE0006":
            position_title = "Office Manager"

        return {
            "ok": True,
            "full_name": full_name,
            "position_title": position_title,
            "dept_name": dept_name,
            # keep any other fields you already return
        }



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
