# analytics/app/OM_REPORTS_ANALYTICS/OM_RP_FacultyTeachingHistory.py

from typing import Any, Dict, List, Optional, Tuple
from fastapi import APIRouter, Query, HTTPException

from ..db_async import get_db

router = APIRouter(tags=["OM Reports • Faculty Teaching History"])

# ---------------------------------------------------------
# Helpers (Ported from FACULTY_History)
# ---------------------------------------------------------

DAY_MAP = {
    "M": "Monday", "MON": "Monday",
    "T": "Tuesday", "TU": "Tuesday", "TUE": "Tuesday",
    "W": "Wednesday", "WED": "Wednesday",
    "TH": "Thursday", "THU": "Thursday", "R": "Thursday", "H": "Thursday",
    "F": "Friday", "FRI": "Friday",
    "S": "Saturday", "SAT": "Saturday",
}
DAY_ORDER = {"Monday": 1, "Tuesday": 2, "Wednesday": 3, "Thursday": 4, "Friday": 5, "Saturday": 6}

def _to_full_day(d: Any) -> str:
    s = str(d or "").strip().upper()
    return DAY_MAP.get(s, str(d or ""))

def _fmt_hhmm(raw: Any) -> str:
    if raw is None: return ""
    s = str(raw).strip()
    if ":" in s: return s
    if not s.isdigit(): return s
    if len(s) == 3:
        h, m = int(s[0]), int(s[1:])
    elif len(s) == 4:
        h, m = int(s[:2]), int(s[2:])
    else:
        return s
    return f"{h:02d}:{m:02d}"

def _band(start: Any, end: Any) -> str:
    return f"{_fmt_hhmm(start)} – {_fmt_hhmm(end)}".strip(" –")

def _ay_label(ay_start: Optional[int]) -> str:
    if ay_start is None: return "AY —"
    try:
        n = int(ay_start)
        return f"AY {n}-{n+1}"
    except Exception:
        return "AY —"

def _code_as_str(v: Any) -> str:
    if isinstance(v, list):
        return (v[0] if v else "") or ""
    return str(v or "")

# ---------------------------------------------------------
# Core Logic
# ---------------------------------------------------------

async def _dept_fallback_campus_name(db, department_id: Optional[str]) -> Optional[str]:
    if not department_id:
        return None
    dept = await db.departments.find_one({"department_id": department_id}, {"_id": 0, "campus_id": 1})
    campus_ids = (dept or {}).get("campus_id") or []
    first = campus_ids[0] if isinstance(campus_ids, list) and campus_ids else None
    if not first:
        return None
    camp = await db.campuses.find_one({"campus_id": first}, {"_id": 0, "campus_name": 1})
    return (camp or {}).get("campus_name")


async def fetch_teaching_history(faculty_id: str) -> List[Dict[str, Any]]:
    db = get_db()

    # 1. Get faculty profile to determine department fallback
    faculty = await db.faculty_profiles.find_one({"faculty_id": faculty_id})
    if not faculty:
        return []
    
    dept_fallback_campus = await _dept_fallback_campus_name(db, faculty.get("department_id"))

    # 2. Aggregation Pipeline (Matches FACULTY_History logic)
    pipeline: List[Dict[str, Any]] = [
        {"$match": {"faculty_id": faculty_id, "is_archived": {"$ne": True}}},
        
        # Join Section
        {"$lookup": {"from": "sections", "localField": "section_id", "foreignField": "section_id", "as": "sec"}},
        {"$unwind": {"path": "$sec", "preserveNullAndEmptyArrays": True}},
        
        # Join Course
        {"$lookup": {"from": "courses", "localField": "sec.course_id", "foreignField": "course_id", "as": "course"}},
        {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},
        
        # Join Term
        {"$lookup": {"from": "terms", "localField": "sec.term_id", "foreignField": "term_id", "as": "t"}},
        {"$unwind": {"path": "$t", "preserveNullAndEmptyArrays": True}},
        
        # Join Schedules (One-to-Many fan-out)
        {"$lookup": {"from": "section_schedules", "localField": "sec.section_id", "foreignField": "section_id", "as": "scheds"}},
        {"$unwind": {"path": "$scheds", "preserveNullAndEmptyArrays": True}},
        
        # Join Room
        {"$lookup": {"from": "rooms", "localField": "scheds.room_id", "foreignField": "room_id", "as": "room"}},
        {"$unwind": {"path": "$room", "preserveNullAndEmptyArrays": True}},
        
        # Join Campus
        {"$lookup": {"from": "campuses", "localField": "room.campus_id", "foreignField": "campus_id", "as": "camp"}},
        {"$unwind": {"path": "$camp", "preserveNullAndEmptyArrays": True}},

        # Project necessary fields before grouping
        {"$project": {
            "_id": 0,
            "section_id": "$sec.section_id",
            "section_code": "$sec.section_code",
            "course_code_raw": "$course.course_code",
            "course_title": "$course.course_title",
            "units": {"$ifNull": ["$course.units", 0]},
            "term_number": "$t.term_number",
            "ay_start": "$t.acad_year_start",
            "sched_day": "$scheds.day",
            "sched_room_type": "$scheds.room_type",
            "sched_start": "$scheds.start_time",
            "sched_end": "$scheds.end_time",
            "room_number": {"$ifNull": ["$scheds.room", "$room.room_number"]}, # Fallback to manual room entry if id missing
            "campus_name": "$camp.campus_name",
        }},

        # Group back per section to consolidate meeting patterns
        {"$group": {
            "_id": "$section_id",
            "section_code": {"$first": "$section_code"},
            "course_code_raw": {"$first": "$course_code_raw"},
            "course_title": {"$first": "$course_title"},
            "units": {"$first": "$units"},
            "term_number": {"$first": "$term_number"},
            "ay_start": {"$first": "$ay_start"},
            "meetings": {"$push": {
                "day": "$sched_day",
                "room_type": "$sched_room_type",
                "start": "$sched_start",
                "end": "$sched_end",
                "room": "$room_number",
                "campus": "$campus_name",
            }},
        }},
    ]

    raw_rows = await db.faculty_assignments.aggregate(pipeline).to_list(length=None)
    
    results: List[Dict[str, Any]] = []

    for r in raw_rows:
        meetings = r.get("meetings") or []
        
        # Normalize and sort by day order (Monday=1 ... Saturday=6)
        norm_meet: List[Tuple[int, Dict[str, Any]]] = []
        for m in meetings:
            if not m.get("day"): continue # skip empty schedules
            full_day = _to_full_day(m.get("day"))
            norm_meet.append((DAY_ORDER.get(full_day, 99), {
                "day": full_day,
                "room": m.get("room") or None,
                "mode": (m.get("room_type") or "Online"),
                "time": _band(m.get("start"), m.get("end")),
                "campus": m.get("campus") or None,
            }))
        
        # Sort by Day then Start Time
        norm_meet.sort(key=lambda x: (x[0], (x[1].get("time") or "")))

        # Extract up to 2 distinct meeting patterns (Day1/Room1, Day2/Room2)
        day1 = room1 = day2 = room2 = None
        mode = None
        time_band = ""
        campus_name = None

        if norm_meet:
            m1 = norm_meet[0][1]
            day1 = m1["day"]
            room1 = m1["room"] or "Online"
            mode = m1["mode"]
            time_band = m1["time"]
            campus_name = m1["campus"]
        
        if len(norm_meet) > 1:
            m2 = norm_meet[1][1]
            # Simple de-duplication: if day/time/room are identical, don't list it twice
            # But usually schedules differ by day.
            day2 = m2["day"]
            room2 = m2["room"] or "Online"
            campus_name = campus_name or m2["campus"] # Prefer 1st, fallback to 2nd
        
        # Final fallback for campus
        campus_name = campus_name or dept_fallback_campus or "Online"

        # Final Mode Clean up (if Online, room is usually Online)
        if mode == "Online" and (not room1 or room1 == "Online"):
            room1 = "N/A"
        
        # Construct Flat Row
        results.append({
            "ay": _ay_label(r.get("ay_start")),
            "term_name": f"Term {r.get('term_number') or '?'}", # Used for Grouping in UI
            
            "course_code": _code_as_str(r.get("course_code_raw")),
            "course_title": r.get("course_title"),
            "section_code": r.get("section_code"),
            "units": r.get("units"),
            "campus": campus_name,
            "mode": mode or "Online",
            
            # Flattened Schedule
            "day1": day1,
            "room1": room1,
            "day2": day2,
            "room2": room2,
            "time": time_band,
            
            # Sort keys
            "ay_start_sort": r.get("ay_start") or 0,
            "term_number_sort": r.get("term_number") or 0
        })

    # Sort by AY (desc), Term (desc), Course Code (asc)
    results.sort(key=lambda x: (
        -x["ay_start_sort"], 
        -x["term_number_sort"], 
        x["course_code"]
    ))

    return results

@router.get("/analytics/teaching-history")
async def get_teaching_history(faculty_id: str = Query(...)):
    rows = await fetch_teaching_history(faculty_id)
    return {"faculty_id": faculty_id, "count": len(rows), "rows": rows}