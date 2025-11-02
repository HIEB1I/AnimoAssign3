from typing import Any, Dict, List, Optional, Tuple
from fastapi import APIRouter, Query, Body

from ..main import db

router = APIRouter(prefix="/analytics", tags=["analytics"])

# --- Collections ---
COL_USERS = "users"
COL_FACULTY = "faculty_profiles"
COL_ASSIGN = "faculty_assignments"
COL_SECTIONS = "sections"
COL_SCHED = "section_schedules"
COL_COURSES = "courses"
COL_TERMS = "terms"
COL_ROOMS = "rooms"
COL_CAMPUSES = "campuses"

# --- Helpers (mirror FM history) ---
DAY_MAP = {
    "M": "Monday", "MON": "Monday",
    "T": "Tuesday", "TU": "Tuesday", "TUE": "Tuesday",
    "W": "Wednesday", "WED": "Wednesday",
    "TH": "Thursday", "THU": "Thursday", "R": "Thursday",
    "F": "Friday", "FRI": "Friday",
    "S": "Saturday", "SAT": "Saturday",
}
DAY_ORDER = {"Monday": 1, "Tuesday": 2, "Wednesday": 3, "Thursday": 4, "Friday": 5, "Saturday": 6}

def _to_full_day(d: Any) -> str:
    s = str(d or "").strip().upper()
    return DAY_MAP.get(s, str(d or ""))

def _fmt_hhmm(raw: Any) -> str:
    if raw is None:
        return ""
    s = str(raw).strip()
    if ":" in s:
        return s
    if not s.isdigit():
        return s
    if len(s) == 3:
        h, m = int(s[0]), int(s[1:])
    elif len(s) == 4:
        h, m = int(s[:2]), int(s[2:])
    else:
        return s
    return f"{h:02d}:{m:02d}"

def _band(start: Any, end: Any) -> str:
    st, en = _fmt_hhmm(start), _fmt_hhmm(end)
    return f"{st} – {en}".strip(" –")

def _ay_label(ay_start: Optional[int]) -> str:
    if not isinstance(ay_start, int):
        return ""
    return f"AY {ay_start}–{ay_start + 1}"

async def _latest_ay() -> Optional[int]:
    doc = await db[COL_TERMS].find({}, {"_id": 0, "acad_year_start": 1}).sort([("acad_year_start", -1)]).limit(1).to_list(1)
    return (doc[0]["acad_year_start"] if doc else None)

async def _academic_years() -> List[int]:
    items = [t async for t in db[COL_TERMS].find({}, {"_id": 0, "acad_year_start": 1}).sort([("acad_year_start", -1)])]
    out = []
    for it in items:
        ay = it.get("acad_year_start")
        if isinstance(ay, int) and ay not in out:
            out.append(ay)
    return out

def _normalize_course_code(code_any: Any) -> str:
    if isinstance(code_any, list):
        return (code_any[0] if code_any else "") or ""
    return str(code_any or "")

# ------------------------------------------------------------------------------------
# POST /api/analytics/faculty-teaching-history
# Matches api.ts (POST) and returns rows in the OM_FM history shape (per faculty, per AY, grouped by term)
# ------------------------------------------------------------------------------------
@router.post("/faculty-teaching-history")
async def analytics_faculty_teaching_history(
    search: Optional[str] = Query(None),
    acad_year_start: Optional[int] = Query(None),
    payload: Optional[dict] = Body(None),   # kept to match FE POST body usage
) -> Dict[str, Any]:
    """
    Returns:
      {
        ok: true,
        acad_year_start: number | null,
        ay_label: "AY 2024–2025",
        rows: [{
          faculty_id, faculty_name, ay_label, term, code, title, section,
          mode, day1, room1, day2, room2, time
        }],
        meta: { academicYears: number[] }
      }
    """
    # Decide AY (default to latest)
    if acad_year_start is None:
        acad_year_start = await _latest_ay()

    # Build a base pipeline: assignments -> section -> term (filter AY) -> course
    # plus faculty & user for names; gather schedules then collapse meetings (up to 2)
    match_term_stage: Dict[str, Any] = {}
    if isinstance(acad_year_start, int):
        match_term_stage = {"t.acad_year_start": acad_year_start}

    pipeline: List[Dict[str, Any]] = [
        {"$match": {"is_archived": False}},
        # Section / Term / Course
        {"$lookup": {"from": COL_SECTIONS, "localField": "section_id", "foreignField": "section_id", "as": "sec"}},
        {"$unwind": {"path": "$sec", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {"from": COL_TERMS, "localField": "sec.term_id", "foreignField": "term_id", "as": "t"}},
        {"$unwind": {"path": "$t", "preserveNullAndEmptyArrays": True}},
        # Filter by AY (if provided)
        *([{"$match": match_term_stage}] if match_term_stage else []),
        {"$lookup": {"from": COL_COURSES, "localField": "sec.course_id", "foreignField": "course_id", "as": "course"}},
        {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},
        # Faculty name
        {"$lookup": {"from": COL_FACULTY, "localField": "faculty_id", "foreignField": "faculty_id", "as": "fac"}},
        {"$unwind": {"path": "$fac", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {"from": COL_USERS, "localField": "fac.user_id", "foreignField": "user_id", "as": "u"}},
        {"$unwind": {"path": "$u", "preserveNullAndEmptyArrays": True}},
        # Schedules
        {"$lookup": {"from": COL_SCHED, "localField": "sec.section_id", "foreignField": "section_id", "as": "scheds"}},
        # Room & Campus handled when collapsing meetings (first/second meeting only)
        {"$project": {
            "_id": 0,
            "faculty_id": "$faculty_id",
            "faculty_name": {
                "$trim": { "input": {
                    "$concat": [
                        {"$ifNull": ["$u.first_name", ""]}, " ",
                        {"$ifNull": ["$u.last_name",  ""]},
                    ]
                }}
            },
            "ay_start": "$t.acad_year_start",
            "term_number": "$t.term_number",
            "section_code": "$sec.section_code",
            "course_code_raw": "$course.course_code",
            "course_title": "$course.course_title",
            "section_id": "$sec.section_id",
            "scheds": "$scheds",
        }},
    ]

    docs = [d async for d in db[COL_ASSIGN].aggregate(pipeline)]

    # SEARCH: faculty-name ONLY (per request)
    q = (search or "").strip().lower()
    if q:
        def _hit(d: Dict[str, Any]) -> bool:
            name = str(d.get("faculty_name") or "").lower()
            return q in name
        docs = [d for d in docs if _hit(d)]

    # Collapse meetings (up to two), fetch room numbers and room_type
    room_ids: List[str] = []
    for d in docs:
        for s in (d.get("scheds") or []):
            rid = s.get("room_id")
            if rid:
                room_ids.append(rid)

    room_map: Dict[str, Dict[str, Any]] = {}
    if room_ids:
        room_docs = [r async for r in db[COL_ROOMS].find({"room_id": {"$in": list(set(room_ids))}},
                                                         {"_id": 0, "room_id": 1, "room_number": 1, "campus_id": 1})]
        room_map = {r["room_id"]: r for r in room_docs}
        campus_ids = list({r.get("campus_id") for r in room_docs if r.get("campus_id")})
        campus_map: Dict[str, Any] = {}
        if campus_ids:
            campus_docs = [c async for c in db[COL_CAMPUSES].find({"campus_id": {"$in": campus_ids}},
                                                                  {"_id": 0, "campus_id": 1, "campus_name": 1})]
            campus_map = {c["campus_id"]: c for c in campus_docs}
            # merge campus_name into room_map
            for rid, r in room_map.items():
                cid = r.get("campus_id")
                r["campus_name"] = (campus_map.get(cid) or {}).get("campus_name")

    def collapse_scheds(scheds: List[Dict[str, Any]]) -> Tuple[Optional[Dict[str, str]], Optional[Dict[str, str]]]:
        """Return first two meetings → ({day, room, mode, time}, {day, room})"""
        norm = []
        for s in (scheds or []):
            day = _to_full_day(s.get("day"))
            start, end = s.get("start_time"), s.get("end_time")
            time = _band(start, end)
            room_type = (s.get("room_type") or "Online").strip() or "Online"

            room_num = "Online"
            if room_type not in ("Online", "TBA"):
                rm = room_map.get(s.get("room_id") or "")
                if rm and rm.get("room_number"):
                    room_num = rm["room_number"]
            elif room_type == "TBA":
                room_num = "TBA"

            norm.append((DAY_ORDER.get(day, 99), {
                "day": day or "",
                "room": room_num,
                "mode": room_type,
                "time": time,
            }))

        norm.sort(key=lambda x: (x[0], x[1].get("time", "")))
        first = norm[0][1] if norm else None
        second = norm[1][1] if len(norm) > 1 else None
        return first, second

    rows: List[Dict[str, Any]] = []
    for d in docs:
        m1, m2 = collapse_scheds(d.get("scheds") or [])
        code = _normalize_course_code(d.get("course_code_raw"))
        term = f"Term {d.get('term_number') or ''}".strip()
        ay_start = d.get("ay_start")
        rows.append({
            "faculty_id": d.get("faculty_id") or "",
            "faculty_name": d.get("faculty_name") or "",
            "ay_label": _ay_label(ay_start),
            "term": term or "Term 1",
            "code": code or "",
            "title": d.get("course_title") or "",
            "section": d.get("section_code") or "",
            "mode": (m1 or {}).get("mode") or "Online",
            "day1": (m1 or {}).get("day"),
            "room1": (m1 or {}).get("room"),
            "day2": (m2 or {}).get("day"),
            "room2": (m2 or {}).get("room"),
            "time": (m1 or {}).get("time") or "",
        })

    # Meta AY list
    ay_list = await _academic_years()

    return {
        "ok": True,
        "acad_year_start": acad_year_start,
        "ay_label": _ay_label(acad_year_start),
        "rows": rows,
        "meta": {"academicYears": ay_list},
    }
