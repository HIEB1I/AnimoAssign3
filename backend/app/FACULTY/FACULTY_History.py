from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
from fastapi import APIRouter, HTTPException, Query, Body
from ..main import db

"""
FACULTY • HISTORY (Teaching History)
Pattern parity with STUDENT_Petition: one POST endpoint with action=fetch|options|profile
• Stores nothing (read-only); returns UI-ready rows with joined labels
• "Campus should still show when Online/TBA" — we fall back to the faculty's department campuses when no room campus
"""

router = APIRouter(prefix="/faculty", tags=["faculty"])

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

async def _faculty_by_user(user_id: str) -> Optional[Dict[str, Any]]:
    return await db.faculty_profiles.find_one({"user_id": user_id}, {"_id": 0})

async def _dept_fallback_campus_name(department_id: Optional[str]) -> Optional[str]:
    if not department_id:
        return None
    dept = await db.departments.find_one({"department_id": department_id}, {"_id": 0, "campus_id": 1})
    campus_ids = (dept or {}).get("campus_id") or []
    first = campus_ids[0] if isinstance(campus_ids, list) and campus_ids else None
    if not first:
        return None
    camp = await db.campuses.find_one({"campus_id": first}, {"_id": 0, "campus_name": 1})
    return (camp or {}).get("campus_name")

@router.post("/history")
async def history_handler(
    userId: str = Query(..., min_length=3),
    action: str = Query("fetch", description="fetch | options | profile"),
    payload: Optional[Dict[str, Any]] = Body(None),
    ay: Optional[str] = Query(None, description='Accepts "AY 2024-2025", "2024-2025", or "2024"'),
    q: Optional[str] = Query(None, description="Free-text search across fields"),
):
    """
    Returns teaching history rows grouped by term for the faculty (by userId).
    UI shape per FACULTY_History.tsx (code/title/section/units/campus/mode/day1/room1/day2/room2/time + ay, term).
    """
    # ---------- Resolve faculty/profile ----------
    faculty = await _faculty_by_user(userId)
    if not faculty:
        raise HTTPException(status_code=404, detail="Faculty not found for the given userId")

    # ---------- options ----------
    if action == "options":
        # Distinct AYs derived from sections -> terms
        pipeline: List[Dict[str, Any]] = [
            {"$match": {"faculty_id": faculty.get("faculty_id"), "is_archived": False}},
            {"$lookup": {"from": "sections", "localField": "section_id", "foreignField": "section_id", "as": "sec"}},
            {"$unwind": {"path": "$sec", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": "terms", "localField": "sec.term_id", "foreignField": "term_id", "as": "t"}},
            {"$unwind": {"path": "$t", "preserveNullAndEmptyArrays": True}},
            {"$project": {"_id": 0, "ay": "$t.acad_year_start"}},
            {"$group": {"_id": "$ay"}},
        ]
        vals = [r async for r in db.faculty_assignments.aggregate(pipeline)]
        starts = [int(r["_id"]) for r in vals if isinstance(r.get("_id"), int)]
        labels = [_ay_label(s) for s in sorted(starts, reverse=True)]
        return {"ok": True, "ays": labels}

    # ---------- profile ----------
    if action == "profile":
        # minimal – align with overview's pattern
        user_doc = await db.users.find_one(
            {"user_id": userId},
            {"_id": 0, "first_name": 1, "last_name": 1, "email": 1},
        ) or {}
        first = (user_doc.get("first_name") or "").strip()
        last = (user_doc.get("last_name") or "").strip()
        if not (first or last):
            email_local = (user_doc.get("email") or "").split("@")[0]
            full = email_local.replace(".", " ").replace("_", " ").title() if email_local else "Faculty"
            first, last = full, ""
        return {"ok": True, "first_name": first, "last_name": last}

    # ---------- fetch (list) ----------
    if action == "fetch":
        # Normalize AY filter
        ay_norm = None
        if ay:
            s = str(ay).upper().replace("AY", "").strip()
            # accept "2024-2025" or "2024"
            try:
                ay_norm = int(s.split("-")[0].strip())
            except Exception:
                ay_norm = None

        # Full join: assignments -> sections -> courses -> terms -> schedules -> rooms -> campuses
        pipeline: List[Dict[str, Any]] = [
            {"$match": {"faculty_id": faculty.get("faculty_id"), "is_archived": False}},
            {"$lookup": {"from": "sections", "localField": "section_id", "foreignField": "section_id", "as": "sec"}},
            {"$unwind": {"path": "$sec", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": "courses", "localField": "sec.course_id", "foreignField": "course_id", "as": "course"}},
            {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": "terms", "localField": "sec.term_id", "foreignField": "term_id", "as": "t"}},
            {"$unwind": {"path": "$t", "preserveNullAndEmptyArrays": True}},
            # schedules fan-out
            {"$lookup": {"from": "section_schedules", "localField": "sec.section_id", "foreignField": "section_id", "as": "scheds"}},
            {"$unwind": {"path": "$scheds", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": "rooms", "localField": "scheds.room_id", "foreignField": "room_id", "as": "room"}},
            {"$unwind": {"path": "$room", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": "campuses", "localField": "room.campus_id", "foreignField": "campus_id", "as": "camp"}},
            {"$unwind": {"path": "$camp", "preserveNullAndEmptyArrays": True}},
            # flatten for group
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
                "room_number": "$room.room_number",
                "campus_name": "$camp.campus_name",
            }},
        ]

        # Server-side filtering by AY if provided
        if ay_norm is not None:
            pipeline.append({"$match": {"ay_start": ay_norm}})

        # Group back per section, collect up to 2 meeting patterns (sorted by day)
        pipeline += [
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

        rows = [r async for r in db.faculty_assignments.aggregate(pipeline)]

        # Build UI rows
        dept_fallback_campus = await _dept_fallback_campus_name(faculty.get("department_id"))
        out: List[Dict[str, Any]] = []
        for r in rows:
            meetings = r.get("meetings") or []
            # Normalize and sort by day order
            norm_meet: List[Tuple[int, Dict[str, Any]]] = []
            for m in meetings:
                full_day = _to_full_day(m.get("day"))
                norm_meet.append((DAY_ORDER.get(full_day, 99), {
                    "day": full_day,
                    "room": m.get("room") or None,
                    "mode": (m.get("room_type") or "Online"),
                    "time": _band(m.get("start"), m.get("end")),
                    "campus": m.get("campus") or None,
                }))
            norm_meet.sort(key=lambda x: (x[0], (x[1].get("time") or "")))
            # Take first two for day1/room1 and day2/room2
            day1 = room1 = day2 = room2 = None
            mode = None
            time_band = ""
            campus_name = None
            if norm_meet:
                day1 = norm_meet[0][1]["day"]
                room1 = norm_meet[0][1]["room"] or "Online"
                mode = norm_meet[0][1]["mode"]
                time_band = norm_meet[0][1]["time"]
                campus_name = norm_meet[0][1]["campus"]
            if len(norm_meet) > 1:
                day2 = norm_meet[1][1]["day"]
                room2 = norm_meet[1][1]["room"] or "Online"
                # Prefer a campus if first was None
                campus_name = campus_name or norm_meet[1][1]["campus"]

            # Campus fallback rule: if still None, use department campus
            campus_name = campus_name or dept_fallback_campus or "Online"

            out.append({
                "ay": _ay_label(r.get("ay_start")),
                "term": f"Term {r.get('term_number') or ''}".strip(),
                "code": _code_as_str(r.get("course_code_raw")),
                "title": r.get("course_title") or "",
                "section": r.get("section_code") or "",
                "units": r.get("units") or 0,
                "campus": campus_name,
                "mode": mode or "Online",
                "day1": day1, "room1": room1,
                "day2": day2, "room2": room2,
                "time": time_band,
            })

        # Server-side 'q' filter (simple contains across key fields)
        if q and isinstance(q, str) and q.strip():
            qq = q.strip().lower()
            def hit(row: Dict[str, Any]) -> bool:
                hay = " ".join(str(row.get(k) or "") for k in
                               ["code","title","section","campus","mode","day1","room1","day2","room2","time","term","ay"])
                return qq in hay.lower()
            out = [r for r in out if hit(r)]

        # Sort newest first by AY then Term number
        def sort_key(row: Dict[str, Any]):
            ay_part = row.get("ay", "AY —").replace("AY", "").strip()
            try:
                ay0 = int((ay_part.split("-")[0] or "").strip())
            except Exception:
                ay0 = -1
            try:
                tnum = int(str(row.get("term","")).split()[-1])
            except Exception:
                tnum = -1
            return (-ay0, -tnum, row.get("code",""))
        out.sort(key=sort_key)

        return {"ok": True, "rows": out}

    raise HTTPException(status_code=400, detail="Invalid action parameter.")
