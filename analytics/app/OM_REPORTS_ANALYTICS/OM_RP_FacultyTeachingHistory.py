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


def _campus_label(name: Any) -> Optional[str]:
    """Normalize campus names to stable labels used in UI filters."""
    s = str(name or "").strip()
    if not s:
        return None
    u = s.upper()
    if "MANILA" in u:
        return "Manila"
    if "LAGUNA" in u:
        return "Laguna"
    return s

# ---------------------------------------------------------
# Core Logic
# ---------------------------------------------------------

# async def _dept_fallback_campus_name(db, department_id: Optional[str]) -> Optional[str]:
#     if not department_id:
#         return None
#     dept = await db.departments.find_one({"department_id": department_id}, {"_id": 0, "campus_id": 1})
#     campus_ids = (dept or {}).get("campus_id") or []
#     first = campus_ids[0] if isinstance(campus_ids, list) and campus_ids else None
#     if not first:
#         return None
#     camp = await db.campuses.find_one({"campus_id": first}, {"_id": 0, "campus_name": 1})
#     return (camp or {}).get("campus_name")


async def fetch_teaching_history(faculty_id: str) -> List[Dict[str, Any]]:
    """Return teaching history rows for a faculty.

    Fixes missing-history cases:
      1) Some legacy data stored assignment docs under a different identifier (commonly user_id).
         We therefore match assignments where faculty_id is ANY of:
           - the requested id
           - the resolved faculty_profiles.faculty_id
           - the resolved faculty_profiles.user_id (when present)
      2) We intentionally DO NOT filter out archived assignments here.
         This matches FACULTY_History behavior: archived rows can represent past teaching loads.
    """
    db = get_db()

    # 1) Resolve faculty profile by either faculty_id OR user_id (defensive)
    faculty = await db.faculty_profiles.find_one(
        {"$or": [{"faculty_id": faculty_id}, {"user_id": faculty_id}]},
        {"_id": 0}
    )
    if not faculty:
        return []

    # Match assignments by both faculty_id and user_id to catch legacy docs
    faculty_ids = list({
        str(faculty_id),
        str(faculty.get("faculty_id") or ""),
        str(faculty.get("user_id") or ""),
    } - {""})
    
    # Standard teaching units baseline depends on employment type
    emp_type = (faculty.get("employment_type") or "").strip().upper()
    standard_load_units = 6 if (emp_type == "PT" or "PART" in emp_type) else 12  # default FT=12

    # 2) Aggregation Pipeline
    # NOTE: Intentionally no is_archived filter (match FACULTY_History behavior).
    pipeline: List[Dict[str, Any]] = [
        {"$match": {"faculty_id": {"$in": faculty_ids}}},
        
        # Join Section
        {"$lookup": {"from": "sections", "localField": "section_id", "foreignField": "section_id", "as": "sec"}},
        {"$unwind": {"path": "$sec", "preserveNullAndEmptyArrays": True}},
        
        # Join Course
        {"$lookup": {"from": "courses", "localField": "sec.course_id", "foreignField": "course_id", "as": "course"}},
        {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},
        
        # Join Term
        {"$lookup": {"from": "terms", "localField": "sec.term_id", "foreignField": "term_id", "as": "t"}},
        {"$unwind": {"path": "$t", "preserveNullAndEmptyArrays": True}},

        # Section campus fallback (more reliable than room-based campus when room_id is missing)
        {"$addFields": {
            "sec_campus_id_one": {
                "$cond": [
                    {"$isArray": "$sec.campus_id"},
                    {"$arrayElemAt": ["$sec.campus_id", 0]},
                    "$sec.campus_id"
                ]
            }
        }},
        {"$lookup": {"from": "campuses", "localField": "sec_campus_id_one", "foreignField": "campus_id", "as": "sec_camp"}},
        {"$unwind": {"path": "$sec_camp", "preserveNullAndEmptyArrays": True}},
        
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
            "room_number": {"$ifNull": ["$scheds.room", "$room.room_number"]}, 
            "campus_name": "$camp.campus_name",
            "section_campus_name": "$sec_camp.campus_name",
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
            "section_campus_name": {"$first": "$section_campus_name"},
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

        # Campus should be derived purely from room_id -> rooms -> campuses,
        # even if day/time are null. No fallback: N/A when missing.
        campus_counts: Dict[str, int] = {}
        for m in meetings:
            c = _campus_label(m.get("campus"))
            if not c:
                continue
            campus_counts[c] = campus_counts.get(c, 0) + 1

        primary_campus = "N/A"
        if campus_counts:
            primary_campus = max(campus_counts.items(), key=lambda kv: kv[1])[0]

        # Normalize meetings (dedupe) and keep per-day begin/end so Day 2 can have a different time.
        norm_meet: List[Tuple[int, str, Dict[str, Any]]] = []
        seen = set()
        for mm in meetings:
            day_raw = mm.get("day")
            if not day_raw:
                continue
            full_day = _to_full_day(day_raw)
            begin = _fmt_hhmm(mm.get("start"))
            end = _fmt_hhmm(mm.get("end"))
            room = (mm.get("room") or None)
            campus = _campus_label(mm.get("campus"))

            room_type = str(mm.get("room_type") or "").strip()
            mode_guess = room_type or ("F2F" if room else "Online")

            key = (full_day, begin, end, room or "", campus or "", mode_guess)
            if key in seen:
                continue
            seen.add(key)

            norm_meet.append((DAY_ORDER.get(full_day, 99), begin or "", {
                "day": full_day,
                "begin": begin or None,
                "end": end or None,
                "room": room,
                "mode": mode_guess,
                "campus": campus,
            }))

        norm_meet.sort(key=lambda x: (x[0], x[1]))

        day1 = room1 = day2 = room2 = None
        begin1 = end1 = begin2 = end2 = None
        mode = None
        campus_name = None

        if norm_meet:
            m1 = norm_meet[0][2]
            day1 = m1.get("day")
            begin1 = m1.get("begin")
            end1 = m1.get("end")
            mode = m1.get("mode")
            campus_name = m1.get("campus")

            is_online = "ONLINE" in str(mode or "").upper()
            if is_online:
                room1 = "N/A"
            else:
                room1 = m1.get("room") or "TBA"

        if len(norm_meet) > 1:
            m2 = norm_meet[1][2]
            day2 = m2.get("day")
            begin2 = m2.get("begin")
            end2 = m2.get("end")

            is_online = "ONLINE" in str(mode or "").upper()
            if is_online:
                room2 = "N/A"
            else:
                room2 = m2.get("room") or "TBA"

            campus_name = campus_name or m2.get("campus")

        # Campus fallback priority: meeting campus → most common meeting campus → section campus → N/A
        sec_campus = _campus_label(r.get("section_campus_name"))
        campus_name = _campus_label(campus_name) or primary_campus or sec_campus or "N/A"

        # Build time string for backwards compatibility with the frontend parser.
        band1 = _band(begin1, end1) if (begin1 or end1) else ""
        band2 = _band(begin2, end2) if (begin2 or end2) else ""
        if band1 and band2 and band2 != band1:
            time_band = f"{band1} | {band2}"
        else:
            time_band = band1 or band2 or ""

        results.append({
            "ay": _ay_label(r.get("ay_start")),
            "term_name": f"Term {r.get('term_number') or '?'}", 
            
            "course_code": _code_as_str(r.get("course_code_raw")),
            "course_title": r.get("course_title"),
            "section_code": r.get("section_code"),
            "units": r.get("units"),

            "employment_type": emp_type or None,
            "standard_load_units": standard_load_units,

            "campus": campus_name,
            "mode": mode or "Online",
            
            "day1": day1, "room1": room1,
            "begin1": begin1, "end1": end1,
            "day2": day2, "room2": room2,
            "begin2": begin2, "end2": end2,
            "time": time_band,
            
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