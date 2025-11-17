# backend/app/FACULTY/FACULTY_Overview.py
from fastapi import APIRouter, Query, HTTPException, Body
from ..main import db
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

router = APIRouter(prefix="/faculty", tags=["faculty"])

def _now_utc():
    return datetime.now(timezone.utc)


# --- Helpers tied to your actual terms schema (augmented JSON) ---

# --- NEW: Added _active_term helper (copied from OM_LoadAssignment.py) ---
async def _active_term() -> Dict[str, Any]:
    # 1) find the current anchor (must be is_current=True)
    cur = await db.terms.find_one(
        {"is_current": True},
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
    )
    if not cur:
        return {} # No anchor, so no "next" term

    # 2) get the next term in chronological order
    nxt = await db.terms.find(
        {
            "$or": [
                {"acad_year_start": {"$gt": cur["acad_year_start"]}},
                {
                    "acad_year_start": cur["acad_year_start"],
                    "term_number": {"$gt": cur["term_number"]},
                },
            ]
        },
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1, "is_current": 1}, # Added is_current
    ).sort([("acad_year_start", 1), ("term_number", 1)]).to_list(1)
    
    # Return the next term, or an empty dict if no "next" term is found
    return (nxt[0] if nxt else {})

async def _get_current_term() -> Optional[Dict[str, Any]]:
    # 1) prefer is_current == True
    term = await db.terms.find_one({"is_current": True}, {"_id": 0})
    if term:
        term["term_label"] = _term_label(term)
        return term
    # No current term -> just say None here (we will fetch "previous" elsewhere)
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
    # --- MODIFIED Fallback ---
    return "Term"

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
    "H": "Thursday", # <-- ADDED "H"
    "R": "Thursday",   # sometimes used
    "F": "Friday",
    "FRI": "Friday",
    "S": "Saturday",
    "SAT": "Saturday",
}
# --- NEW: Day order for sorting meetings ---
_DAY_ORDER = {"Monday": 1, "Tuesday": 2, "Wednesday": 3, "Thursday": 4, "Friday": 5, "Saturday": 6}


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
        # --- MODIFIED: Fetch planning term first, fallback to current ---
        term = await _active_term()
        if not term:
            term = await _get_current_term()
        
        if not term:
            term = {"term_id": None, "term_label": "No Term Found"}
        else:
            # --- MODIFIED: Re-label if it's the planning term ---
            if not term.get("is_current"):
                term["term_label"] = _term_label(term) + " (Planning)"
            else:
                 term.setdefault("term_label", _term_label(term))

        # Single pipeline: assignments -> sections -> courses -> schedules -> rooms -> campuses
        pipeline: List[Dict[str, Any]] = [
            {"$match": {"faculty_id": faculty.get("faculty_id"), "is_archived": False}},
            {"$lookup": {"from": "sections", "localField": "section_id", "foreignField": "section_id", "as": "sec"}},
            {"$unwind": {"path": "$sec", "preserveNullAndEmptyArrays": True}},

            # --- MODIFIED: Filter by TERM_ID here ---
            # This ensures we only get sections for the term we care about
            {"$match": {"sec.term_id": term.get("term_id")}},

            {"$lookup": {"from": "courses", "localField": "sec.course_id", "foreignField": "course_id", "as": "course"}},
            {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},

            {"$lookup": {"from": "section_schedules", "localField": "sec.section_id", "foreignField": "section_id", "as": "sched"}},
            # --- MODIFIED: preserveNullAndEmptyArrays must be True ---
            # This keeps sections even if they have NO schedule (e.g., TBA)
            {"$unwind": {"path": "$sched", "preserveNullAndEmptyArrays": True}},

            {"$lookup": {"from": "rooms", "localField": "sched.room_id", "foreignField": "room_id", "as": "room"}},
            {"$unwind": {"path": "$room", "preserveNullAndEmptyArrays": True}},

            {"$lookup": {"from": "campuses", "localField": "room.campus_id", "foreignField": "campus_id", "as": "camp"}},
            {"$unwind": {"path": "$camp", "preserveNullAndEmptyArrays": True}},

            {"$addFields": {
                "syllabus_display": {
                    "$cond": [
                        {"$or": [
                            {"$eq": [{"$type": "$course.syllabus"}, "missing"]},
                            {"$eq": ["$course.syllabus", None]},
                            {"$eq": [{"$toLower": {"$ifNull": ["$course.syllabus", ""]}}, "n/a"]},
                            {"$eq": ["$course.syllabus", ""]}
                        ]},
                        "",
                        "$course.syllabus"
                    ]
                },

                "day_display": {
                    "$switch": {
                        "branches": [
                            {"case": {"$in": [{"$toUpper": "$sched.day"}, ["M","MON"]]}, "then": "Monday"},
                            {"case": {"$in": [{"$toUpper": "$sched.day"}, ["T","TU","TUE"]]}, "then": "Tuesday"},
                            {"case": {"$in": [{"$toUpper": "$sched.day"}, ["W","WED"]]}, "then": "Wednesday"},
                            # --- *** THE FIX IS HERE *** ---
                            {"case": {"$in": [{"$toUpper": "$sched.day"}, ["TH","THU","R", "H"]]}, "then": "Thursday"},
                            {"case": {"$in": [{"$toUpper": "$sched.day"}, ["F","FRI"]]}, "then": "Friday"},
                            {"case": {"$in": [{"$toUpper": "$sched.day"}, ["S","SAT"]]}, "then": "Saturday"},
                        ],
                        "default": "$sched.day"
                    }
                },
            }},
            
            # --- *** MODIFIED: Project section_id, remove sort *** ---
            {"$project": {
                "_id": 0,
                "section_id": "$sec.section_id", 
                "day": "$day_display",
                "course_code": {"$ifNull": ["$course.course_code", ""]},
                "course_title": "$course.course_title",
                "section": "$sec.section_code",
                "units": {"$ifNull": ["$course.units", 0]},
                "campus": {"$ifNull": ["$camp.campus_name", "Online"]},
                "mode": {"$ifNull": ["$sched.room_type", "Online"]},
                "room": {"$ifNull": ["$room.room_number", "Online"]},
                "start_raw": "$sched.start_time",
                "end_raw": "$sched.end_time",
                "syllabus": "$syllabus_display"
            }},
            
            # --- *** NEW: Group by section_id *** ---
            {"$group": {
                "_id": "$section_id",
                "course_code": {"$first": "$course_code"},
                "course_title": {"$first": "$course_title"},
                "section": {"$first": "$section"},
                "units": {"$first": "$units"},
                "syllabus": {"$first": "$syllabus"},
                
                "meetings": {"$push": {
                    "day": "$day",
                    "room_type": "$mode",
                    "start": "$start_raw",
                    "end": "$end_raw",
                    "room": "$room",
                    "campus": "$campus",
                }},
            }},
        ]

        rows = [r async for r in db.faculty_assignments.aggregate(pipeline)]

        # Final display normalization (time formatting)
        final_teaching_load: List[Dict[str, Any]] = []
        unique_units_calc = {}

        for r in rows:
            sec_id = r.get("_id")
            if sec_id:
                unique_units_calc[sec_id] = r.get("units", 0) or 0
            
            meetings = r.get("meetings", [])
            
            # Normalize and sort meetings
            norm_meet: List[Tuple[int, Dict[str, Any]]] = []
            for m in meetings:
                day = m.get("day", "")
                # Only add if it has schedule info
                if day or m.get("start") or m.get("end"):
                    order = _DAY_ORDER.get(day, 99)
                    norm_meet.append((order, m))
            
            norm_meet.sort(key=lambda x: x[0])
            
            # Extract schedule info
            day1, room1, mode, time1 = "TBA", "Online", "Online", "TBA"
            day2, room2, time2 = None, None, None
            
            if norm_meet:
                m1 = norm_meet[0][1]
                day1 = m1.get("day") or "TBA"
                room1 = m1.get("room") or "Online"
                mode = m1.get("room_type") or "Online"
                time1 = _fmt_time_band(m1.get("start"), m1.get("end")) or "TBA"

            if len(norm_meet) > 1:
                m2 = norm_meet[1][1]
                day2 = m2.get("day") or "TBA"
                room2 = m2.get("room") or "Online"
                time2 = _fmt_time_band(m2.get("start"), m2.get("end")) or "TBA"
                # Use mode from first entry, or second if first was blank
                mode = mode if mode != "Online" else (m2.get("room_type") or "Online")


            final_teaching_load.append({
                "course_code": _as_code_str(r.get("course_code")),
                "course_title": r.get("course_title", ""),
                "section": r.get("section", ""),
                "units": r.get("units", 0) or 0,
                "mode": mode, # Use mode from first schedule
                "day1": day1,
                "day2": day2,
                "room1": room1,
                "room2": room2,
                "time1": time1,
                "time2": time2,
                "syllabus": r.get("syllabus", ""),
            })
            
        # Sort the final list by course code then section
        final_teaching_load.sort(key=lambda x: (x.get("course_code", ""), x.get("section", "")))

        # --- *** MODIFIED: Calculate units/preps based on preferences *** ---
        faculty_id = faculty.get("faculty_id")
        term_id = term.get("term_id")
        prefs = await db.faculty_preferences.find_one(
            {"faculty_id": faculty_id, "term_id": term_id},
            {"_id": 0, "preferred_units": 1, "on_break": 1}
        ) or {}

        on_break = prefs.get("on_break", False)
        preferred_units = float(prefs.get("preferred_units", 0) or 0)
        
        pref_units_for_calc = 0.0 if on_break else preferred_units
        
        if pref_units_for_calc >= 12:
            max_preps = 3
        elif pref_units_for_calc >= 6:
            max_preps = 2
        elif pref_units_for_calc > 0:
            max_preps = 1 # Assuming 1 prep for 3 units
        else: # 0 units or on break
            max_preps = 0
            
        total_units = sum(unique_units_calc.values())
        course_preps = len(set(r.get("course_code", "") for r in final_teaching_load if r.get("course_code")))
        # --- *** END OF MODIFICATION *** ---


        load_header = await db.faculty_loads.find_one(
            {"department_id": faculty.get("department_id"), "term_id": term.get("term_id")},
            {"_id": 0, "status": 1},
        )
        status = (load_header or {}).get("status", "pending").capitalize()

        summary = {
            # --- *** MODIFIED: Use new preference-based denominators *** ---
            "teaching_units": f"{total_units}/{int(pref_units_for_calc)}",
            "course_preps": f"{course_preps}/{max_preps}",
            "load_status": status,
            "percent": int((total_units / pref_units_for_calc) * 100) if pref_units_for_calc > 0 else 0,
        }

        return {"ok": True, "term": term, "summary": summary, "teaching_load": final_teaching_load}

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
    # --- MODIFIED: Fetch planning term first, fallback to current ---
    term = await _active_term()
    if not term:
        term = await _get_current_term()
    
    if not term:
        term = {"term_id": None, "term_label": "No Active Term"}
    else:
        # --- MODIFIED: Re-label if it's the planning term ---
        if not term.get("is_current"):
            term["term_label"] = _term_label(term) + " (Planning)"
        else:
                term.setdefault("term_label", _term_label(term))

    # --- *** MODIFIED: Replaced N+1 queries with single pipeline *** ---
    
    # Single pipeline: assignments -> sections -> courses -> schedules -> rooms -> campuses
    pipeline: List[Dict[str, Any]] = [
        {"$match": {"faculty_id": faculty.get("faculty_id"), "is_archived": False}},
        {"$lookup": {"from": "sections", "localField": "section_id", "foreignField": "section_id", "as": "sec"}},
        {"$unwind": {"path": "$sec", "preserveNullAndEmptyArrays": True}},
        {"$match": {"sec.term_id": term.get("term_id")}},
        {"$lookup": {"from": "courses", "localField": "sec.course_id", "foreignField": "course_id", "as": "course"}},
        {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {"from": "section_schedules", "localField": "sec.section_id", "foreignField": "section_id", "as": "sched"}},
        {"$unwind": {"path": "$sched", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {"from": "rooms", "localField": "sched.room_id", "foreignField": "room_id", "as": "room"}},
        {"$unwind": {"path": "$room", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {"from": "campuses", "localField": "room.campus_id", "foreignField": "campus_id", "as": "camp"}},
        {"$unwind": {"path": "$camp", "preserveNullAndEmptyArrays": True}},
        {"$addFields": {
            "day_display": {
                "$switch": {
                    "branches": [
                        {"case": {"$in": [{"$toUpper": "$sched.day"}, ["M","MON"]]}, "then": "Monday"},
                        {"case": {"$in": [{"$toUpper": "$sched.day"}, ["T","TU","TUE"]]}, "then": "Tuesday"},
                        {"case": {"$in": [{"$toUpper": "$sched.day"}, ["W","WED"]]}, "then": "Wednesday"},
                        # --- *** THE FIX IS HERE *** ---
                        {"case": {"$in": [{"$toUpper": "$sched.day"}, ["TH","THU","R", "H"]]}, "then": "Thursday"},
                        {"case": {"$in": [{"$toUpper": "$sched.day"}, ["F","FRI"]]}, "then": "Friday"},
                        {"case": {"$in": [{"$toUpper": "$sched.day"}, ["S","SAT"]]}, "then": "Saturday"},
                    ],
                    "default": "$sched.day"
                }
            },
        }},
        {"$project": {
            "_id": 0,
            "section_id": "$sec.section_id", 
            "day": "$day_display",
            "course_code": {"$ifNull": ["$course.course_code", ""]},
            "course_title": "$course.course_title",
            "section": "$sec.section_code",
            "units": {"$ifNull": ["$course.units", 0]},
            "campus": {"$ifNull": ["$camp.campus_name", "Online"]},
            "mode": {"$ifNull": ["$sched.room_type", "Online"]},
            "room": {"$ifNull": ["$room.room_number", "Online"]},
            "start_raw": "$sched.start_time",
            "end_raw": "$sched.end_time",
            "syllabus": "$course.syllabus" # Simplified from POST, assuming it's just a field
        }},
        # --- *** NEW: Group by section_id *** ---
        {"$group": {
            "_id": "$section_id",
            "course_code": {"$first": "$course_code"},
            "course_title": {"$first": "$course_title"},
            "section": {"$first": "$section"},
            "units": {"$first": "$units"},
            "syllabus": {"$first": "$syllabus"},
            
            "meetings": {"$push": {
                "day": "$day",
                "room_type": "$mode",
                "start": "$start_raw",
                "end": "$end_raw",
                "room": "$room",
                "campus": "$campus",
            }},
        }},
    ]

    rows = [r async for r in db.faculty_assignments.aggregate(pipeline)]

    # Final display normalization (time formatting)
    final_teaching_load: List[Dict[str, Any]] = []
    unique_units_calc = {}

    for r in rows:
        sec_id = r.get("_id")
        if sec_id:
            unique_units_calc[sec_id] = r.get("units", 0) or 0
        
        meetings = r.get("meetings", [])
        
        # Normalize and sort meetings
        norm_meet: List[Tuple[int, Dict[str, Any]]] = []
        for m in meetings:
            day = m.get("day", "")
            # Only add if it has schedule info
            if day or m.get("start") or m.get("end"):
                order = _DAY_ORDER.get(day, 99)
                norm_meet.append((order, m))
        
        norm_meet.sort(key=lambda x: x[0])
        
        # Extract schedule info
        day1, room1, mode, time1 = "TBA", "Online", "Online", "TBA"
        day2, room2, time2 = None, None, None
        
        if norm_meet:
            m1 = norm_meet[0][1]
            day1 = m1.get("day") or "TBA"
            room1 = m1.get("room") or "Online"
            mode = m1.get("room_type") or "Online"
            time1 = _fmt_time_band(m1.get("start"), m1.get("end")) or "TBA"

        if len(norm_meet) > 1:
            m2 = norm_meet[1][1]
            day2 = m2.get("day") or "TBA"
            room2 = m2.get("room") or "Online"
            time2 = _fmt_time_band(m2.get("start"), m2.get("end")) or "TBA"
            # Use mode from first entry, or second if first was blank
            mode = mode if mode != "Online" else (m2.get("room_type") or "Online")


        final_teaching_load.append({
            "course_code": _as_code_str(r.get("course_code")),
            "course_title": r.get("course_title", ""),
            "section": r.get("section", ""),
            "units": r.get("units", 0) or 0,
            "mode": mode, # Use mode from first schedule
            "day1": day1,
            "day2": day2,
            "room1": room1,
            "room2": room2,
            "time1": time1,
            "time2": time2,
            "syllabus": r.get("syllabus", ""),
        })
        
    # Sort the final list by course code then section
    final_teaching_load.sort(key=lambda x: (x.get("course_code", ""), x.get("section", "")))

    # --- *** END OF PIPELINE REPLACEMENT *** ---


    # --- *** MODIFIED: Calculate units/preps based on preferences *** ---
    faculty_id = faculty.get("faculty_id")
    term_id = term.get("term_id")
    prefs = await db.faculty_preferences.find_one(
        {"faculty_id": faculty_id, "term_id": term_id},
        {"_id": 0, "preferred_units": 1, "on_break": 1}
    ) or {}

    on_break = prefs.get("on_break", False)
    preferred_units = float(prefs.get("preferred_units", 0) or 0)
    
    pref_units_for_calc = 0.0 if on_break else preferred_units
    
    if pref_units_for_calc >= 12:
        max_preps = 3
    elif pref_units_for_calc >= 6:
        max_preps = 2
    elif pref_units_for_calc > 0:
        max_preps = 1 # Assuming 1 prep for 3 units
    else: # 0 units or on break
        max_preps = 0
        
    total_units = sum(unique_units_calc.values())
    # --- *** FIX 1: Corrected variable name *** ---
    course_preps = len(set(r.get("course_code", "") for r in final_teaching_load if r.get("course_code")))
    # --- *** END OF MODIFICATION *** ---

    # Try to read a load header for status, but keep graceful default
    load_header = await db.faculty_loads.find_one(
        {"department_id": faculty.get("department_id"), "term_id": term.get("term_id")},
        {"_id": 0, "status": 1},
    )
    status = (load_header or {}).get("status", "pending").capitalize()

    summary = {
        # --- *** MODIFIED: Use new preference-based denominators *** ---
        "teaching_units": f"{total_units}/{int(pref_units_for_calc)}",
        "course_preps": f"{course_preps}/{max_preps}",
        "load_status": status,
        "percent": int((total_units / pref_units_for_calc) * 100) if pref_units_for_calc > 0 else 0,
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
            
    # --- *** FIX 2: Corrected variable name *** ---
    final_teaching_load.sort(key=lambda x: (x.get("day", ""), x.get("time", ""), x.get("section", "")))

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
        "teaching_load": final_teaching_load,
        "notifications": notifications,
    }

async def _get_previous_term() -> Optional[Dict[str, Any]]:
    # newest first
    docs = await db.terms.find({}, {"_id": 0}) \
        .sort([("acad_year_start", -1), ("term_number", -1)]) \
        .to_list(length=2)

    if not docs:
        return None

    # If we have at least 2, the second is "previous".
    # If there is only 1 term in the DB, use that one.
    t = docs[1] if len(docs) >= 2 else docs[0]
    t["term_label"] = _term_label(t)
    return t