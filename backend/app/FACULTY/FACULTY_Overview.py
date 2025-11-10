# backend/app/FACULTY/FACULTY_Overview.py
from fastapi import APIRouter, Query, HTTPException, Body
from ..main import db
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

router = APIRouter(prefix="/faculty", tags=["faculty"])

def _now_utc():
    return datetime.now(timezone.utc)

# --- Helpers tied to your actual terms schema (augmented JSON) ---
async def _get_current_term() -> Optional[Dict[str, Any]]:
    # 1) prefer is_current == True
    term = await db.terms.find_one({"is_current": True}, {"_id": 0})
    if term:
        return term

    # 2) no start_date/end_date in your schema; fallback to newest AY + term_number
    term = await db.terms.find_one({}, {"_id": 0}, sort=[("acad_year_start", -1), ("term_number", -1)])
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

def _as_code_str(val) -> str:
    if isinstance(val, list):
        return " / ".join(str(x) for x in val if x).strip()
    return str(val or "").strip()

# Map single-letter or short forms to full day names per UI
_DAY_MAP = {
    "M": "Monday",
    "MON": "Monday",
    "T": "Tuesday",
    "TU": "Tuesday",
    "TUE": "Tuesday",
    "W": "Wednesday",
    "WED": "Wednesday",
    "TH": "Thursday",
    "THU": "Thursday",
    "R": "Thursday",   # sometimes used
    "F": "Friday",
    "FRI": "Friday",
    "S": "Saturday",
    "SAT": "Saturday",
}

def _to_full_day(day_val: str) -> str:
    s = (day_val or "").strip().upper()
    return _DAY_MAP.get(s, day_val or "")

def _fmt_hhmm(raw: Any) -> str:
    """
    Input like "730" or 730 -> "07:30"
    Also passes through "07:30" unchanged.
    """
    if raw is None:
        return ""
    s = str(raw).strip()
    if ":" in s:
        return s  # already hh:mm
    # normalize to 3 or 4 digits
    if not s.isdigit():
        return s
    if len(s) == 3:
        h = int(s[0])
        m = int(s[1:])
    elif len(s) == 4:
        h = int(s[:2])
        m = int(s[2:])
    else:
        return s
    return f"{h:02d}:{m:02d}"

def _fmt_time_band(start_raw: Any, end_raw: Any) -> str:
    st = _fmt_hhmm(start_raw)
    en = _fmt_hhmm(end_raw)
    return f"{st} – {en}".strip(" –")

@router.post("/overview")
async def overview_handler(
    userId: str = Query(..., min_length=3),
    action: str = Query("fetch", description="fetch | options | profile"),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    # ---------- FACULTY (resolve first; used by all actions) ----------
    faculty = await db.faculty_profiles.find_one({"user_id": userId}, {"_id": 0})
    if not faculty:
        raise HTTPException(status_code=404, detail="Faculty not found for the given userId")

    # ---------- options ----------
    if action == "options":
        return {
            "ok": True,
            "days": ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"],
            "timeBands": ["07:30 – 09:00","09:15 – 10:45","11:00 – 12:30","12:30 – 14:15","14:30 – 16:00","16:15 – 17:45","18:00 – 19:30","19:45 – 21:00"],
        }

    # ---------- profile ----------
    if action == "profile":
        dept = await db.departments.find_one(
            {"department_id": faculty.get("department_id")},
            {"_id": 0, "dept_name": 1},
        )
        # Best-effort full name from users.* (sample data pattern)
        user_doc = await db.users.find_one(
            {"user_id": userId},
            {"_id": 0, "first_name": 1, "last_name": 1, "firstName": 1, "lastName": 1, "email": 1},
        ) or {}
        def _pick(*vals):
            for v in vals:
                if isinstance(v, str) and v.strip():
                    return v.strip()
            return ""
        first = _pick(faculty.get("first_name"), faculty.get("firstName"), user_doc.get("first_name"), user_doc.get("firstName")).strip(" ,")
        last = _pick(faculty.get("last_name"), faculty.get("lastName"), user_doc.get("last_name"), user_doc.get("lastName")).strip(" ,")
        full_name = f"{first} {last}".strip() or _pick(faculty.get("full_name"), faculty.get("fullName"))
        if not full_name:
            email_local = _pick(user_doc.get("email"), faculty.get("email")).split("@")[0]
            if email_local:
                full_name = email_local.replace(".", " ").replace("_", " ").title()

        notifications = await db.faculty_notifications.find(
            {"user_id": userId}, {"_id": 0}
        ).to_list(None)

        return {
            "ok": True,
            "faculty": {
                "full_name": full_name,
                "fullName": full_name,   # keep both for FE consumers
                "role": "Faculty",
                "department": (dept or {}).get("dept_name", "—"),
            },
            "notifications": notifications,
        }

    # ---------- fetch (list) ----------
    if action == "fetch":
        term = await _get_current_term()
        if not term:
            term = {"term_id": None, "term_label": "No Active Term"}
        else:
            term.setdefault("term_label", _term_label(term))

        # Single pipeline: assignments -> sections -> courses -> schedules -> rooms -> campuses
        pipeline: List[Dict[str, Any]] = [
            {"$match": {"faculty_id": faculty.get("faculty_id"), "is_archived": False}},
            {"$lookup": {"from": "sections", "localField": "section_id", "foreignField": "section_id", "as": "sec"}},
            {"$unwind": {"path": "$sec", "preserveNullAndEmptyArrays": True}},

            {"$lookup": {"from": "courses", "localField": "sec.course_id", "foreignField": "course_id", "as": "course"}},
            {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},

            {"$lookup": {"from": "section_schedules", "localField": "sec.section_id", "foreignField": "section_id", "as": "sched"}},
            {"$unwind": {"path": "$sched", "preserveNullAndEmptyArrays": True}},

            {"$lookup": {"from": "rooms", "localField": "sched.room_id", "foreignField": "room_id", "as": "room"}},
            {"$unwind": {"path": "$room", "preserveNullAndEmptyArrays": True}},

            {"$lookup": {"from": "campuses", "localField": "room.campus_id", "foreignField": "campus_id", "as": "camp"}},
            {"$unwind": {"path": "$camp", "preserveNullAndEmptyArrays": True}},

            {"$addFields": {
                "course_code_display": {
                    "$cond": [
                        {"$isArray": "$course.course_code"},
                        {"$ifNull": [{"$arrayElemAt": ["$course.course_code", 0]}, ""]},
                        {"$ifNull": ["$course.course_code", ""]},
                    ]
                },
                "day_display": {
                    "$switch": {
                        "branches": [
                            {"case": {"$in": [{"$toUpper": "$sched.day"}, ["M","MON"]]}, "then": "Monday"},
                            {"case": {"$in": [{"$toUpper": "$sched.day"}, ["T","TU","TUE"]]}, "then": "Tuesday"},
                            {"case": {"$in": [{"$toUpper": "$sched.day"}, ["W","WED"]]}, "then": "Wednesday"},
                            {"case": {"$in": [{"$toUpper": "$sched.day"}, ["TH","THU","R"]]}, "then": "Thursday"},
                            {"case": {"$in": [{"$toUpper": "$sched.day"}, ["F","FRI"]]}, "then": "Friday"},
                            {"case": {"$in": [{"$toUpper": "$sched.day"}, ["S","SAT"]]}, "then": "Saturday"},
                        ],
                        "default": "$sched.day"
                    }
                },
            }},

            {"$project": {
                "_id": 0,
                "day": "$day_display",
                "course_code": "$course_code_display",
                "course_title": "$course.course_title",
                "section": "$sec.section_code",
                "units": {"$ifNull": ["$course.units", 0]},
                "campus": {"$ifNull": ["$camp.campus_name", "Online"]},
                "mode": {"$ifNull": ["$sched.room_type", "Online"]},
                "room": {"$ifNull": ["$room.room_number", "Online"]},
                "start_raw": "$sched.start_time",
                "end_raw": "$sched.end_time",
            }},
            {"$sort": {"day": 1, "start_raw": 1, "section": 1}},
        ]

        rows = [r async for r in db.faculty_assignments.aggregate(pipeline)]

        # Final display normalization (time formatting)
        teaching_load: List[Dict[str, Any]] = []
        for r in rows:
            teaching_load.append({
                "day": r.get("day", ""),
                "course_code": _as_code_str(r.get("course_code")),
                "course_title": r.get("course_title", ""),
                "section": r.get("section", ""),
                "units": r.get("units", 0) or 0,
                "campus": r.get("campus", "Online"),
                "mode": r.get("mode", "Online"),
                "room": r.get("room", "Online"),
                "time": _fmt_time_band(r.get("start_raw"), r.get("end_raw")),
            })

        total_units = sum((row.get("units") or 0) for row in teaching_load)
        max_units = faculty.get("max_units", 18) or 18
        course_preps = len(set(r.get("course_code", "") for r in teaching_load if r.get("course_code")))

        load_header = await db.faculty_loads.find_one(
            {"department_id": faculty.get("department_id"), "term_id": term.get("term_id")},
            {"_id": 0, "status": 1},
        )
        status = (load_header or {}).get("status", "pending").capitalize()

        summary = {
            "teaching_units": f"{total_units}/{max_units}",
            "course_preps": f"{course_preps}/{faculty.get('max_preps', 3) or 3}",
            "load_status": status,
            "percent": int((total_units / max_units) * 100) if max_units else 0,
        }

        return {"ok": True, "term": term, "summary": summary, "teaching_load": teaching_load}

    raise HTTPException(status_code=400, detail="Invalid action parameter.")


@router.get("/overview")
async def get_faculty_overview(userId: str = Query(...)):
    """
    Faculty overview:
    - profile (from faculty_profiles by user_id)
    - current term (per terms schema)
    - summary
    - teaching load (joins: assignments -> sections -> courses, and schedules -> rooms -> campuses)
    - notifications (optional)
    """
    # ---- Faculty profile (required) ----
    faculty = await db.faculty_profiles.find_one({"user_id": userId}, {"_id": 0})
    if not faculty:
        raise HTTPException(status_code=404, detail="Faculty not found for the given userId")

    # ---- Department (optional) ----
    dept = await db.departments.find_one(
        {"department_id": faculty.get("department_id")},
        {"_id": 0, "dept_name": 1},
    )

    # ---- Term (graceful resolve using your schema) ----
    term = await _get_current_term()
    if not term:
        term = {"term_id": None, "term_label": "No Active Term"}
    else:
        term.setdefault("term_label", _term_label(term))

    # ---- Assignments for this faculty (optional) ----
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

    # Schedules for those sections
    schedules: List[Dict[str, Any]] = []
    if section_ids:
        schedules = await db.section_schedules.find(
            {"section_id": {"$in": section_ids}}, {"_id": 0}
        ).to_list(None)

    # Courses for those sections
    course_ids = [s.get("course_id") for s in sections if "course_id" in s]
    courses: List[Dict[str, Any]] = []
    if course_ids:
        courses = await db.courses.find(
            {"course_id": {"$in": course_ids}}, {"_id": 0}
        ).to_list(None)

    # Build teaching load rows (safe defaults)
    teaching_load: List[Dict[str, Any]] = []
    for sc in schedules:
        sec = next((s for s in sections if s.get("section_id") == sc.get("section_id")), {})
        course = next((c for c in courses if c.get("course_id") == sec.get("course_id")), {})

        # Resolve room and campus name (if any)
        campus_name = "Online"
        room_label = "Online"
        if sc.get("room_id"):
            room = await db.rooms.find_one({"room_id": sc["room_id"]}, {"_id": 0})
            if room:
                room_label = room.get("room_number", room_label)
                campus_id = room.get("campus_id")
                if campus_id:
                    campus = await db.campuses.find_one({"campus_id": campus_id}, {"_id": 0})
                    if campus:
                        campus_name = campus.get("campus_name", campus_name)

        teaching_load.append(
            {
                "day": _to_full_day(sc.get("day", "")),
                "course_code": _as_code_str(course.get("course_code")),
                "course_title": course.get("course_title", ""),
                "section": sec.get("section_code", ""),
                "units": course.get("units", 0) or 0,
                "campus": campus_name,
                "mode": sc.get("room_type", "Online"),  # Online / Classroom / Hybrid
                "room": room_label,
                "time": _fmt_time_band(sc.get("start_time"), sc.get("end_time")),
            }
        )

    # Summary (defensive defaults; your faculty_profiles has min_units but no max_units in sample)
    total_units = sum((row.get("units") or 0) for row in teaching_load)
    max_units = faculty.get("max_units", 18) or 18
    course_preps = len(set(r.get("course_code", "") for r in teaching_load if r.get("course_code")))
    # Try to read a load header for status, but keep graceful default
    load_header = await db.faculty_loads.find_one(
        {"department_id": faculty.get("department_id"), "term_id": term.get("term_id")},
        {"_id": 0, "status": 1},
    )
    status = (load_header or {}).get("status", "pending").capitalize()

    summary = {
        "teaching_units": f"{total_units}/{max_units}",
        "course_preps": f"{course_preps}/{faculty.get('max_preps', 3) or 3}",
        "load_status": status,
        "percent": int((total_units / max_units) * 100) if max_units else 0,
    }

    notifications = await db.faculty_notifications.find(
        {"user_id": userId}, {"_id": 0}
    ).to_list(None)

    # ---- Full name from users.* if faculty profile lacks names (per sample data) ----
    user_doc = await db.users.find_one(
        {"user_id": userId},
        {"_id": 0, "first_name": 1, "last_name": 1, "firstName": 1, "lastName": 1, "email": 1},
    ) or {}

    def _pick(*vals):
        for v in vals:
            if isinstance(v, str) and v.strip():
                return v.strip()
        return ""

    first = _pick(
        faculty.get("first_name"),
        faculty.get("firstName"),
        user_doc.get("first_name"),
        user_doc.get("firstName"),
    ).strip(" ,")
    last = _pick(
        faculty.get("last_name"),
        faculty.get("lastName"),
        user_doc.get("last_name"),
        user_doc.get("lastName"),
    ).strip(" ,")
    full_name = f"{first} {last}".strip() or _pick(faculty.get("full_name"), faculty.get("fullName"))

    if not full_name:
        email_local = _pick(user_doc.get("email"), faculty.get("email")).split("@")[0]
        if email_local:
            full_name = email_local.replace(".", " ").replace("_", " ").title()

    return {
        "ok": True,
        "faculty": {
            "full_name": full_name,
            "fullName": full_name,  # keep both for consumers
            "role": "Faculty",
            "department": (dept or {}).get("dept_name", "—"),
        },
        "term": term,
        "summary": summary,
        "teaching_load": teaching_load,
        "notifications": notifications,
    }
