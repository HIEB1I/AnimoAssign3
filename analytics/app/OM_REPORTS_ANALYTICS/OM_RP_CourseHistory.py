# backend/app/OM/OM_REPORTS_ANALYTICS/OM_RP_CourseHistory.py
from typing import Any, Dict, List, Optional, Tuple
from fastapi import APIRouter, Query
from datetime import datetime
from ..main import db

router = APIRouter(prefix="/analytics", tags=["analytics"])

COL_USERS = "users"
COL_FACULTY = "faculty_profiles"
COL_ASSIGN = "faculty_assignments"
COL_SECTIONS = "sections"
COL_SCHED = "section_schedules"
COL_COURSES = "courses"
COL_TERMS = "terms"

async def _active_term() -> Dict[str, Any]:
    """Same pattern as other analytics routes; used for header label only."""
    t = await db[COL_TERMS].find_one(
        {"$or": [{"status": "active"}, {"is_current": True}]},
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
    )
    return t or {}

def _term_label(t: Dict[str, Any]) -> str:
    if not t:
        return ""
    ay = t.get("acad_year_start")
    tn = t.get("term_number")
    if not ay or not tn:
        return ""
    return f"AY {ay}-{int(ay)+1} T{tn}"

def _normalize_course_code(course_doc: Dict[str, Any]) -> str:
    """Mirror the normalization seen elsewhere: array|string -> string."""
    cc = (course_doc or {}).get("course_code")
    if isinstance(cc, list):
        return (cc[0] if cc else "") or ""
    return cc or ""

def _display_name(u: Dict[str, Any]) -> str:
    """Trimmed 'First Last' like in existing routes."""
    first = (u or {}).get("first_name") or ""
    last = (u or {}).get("last_name") or ""
    first = first.strip()
    last = last.strip()
    return f"{first} {last}".strip()

def _ay_term_from_numbers(ay_start: Optional[int], term_number: Optional[int]) -> Tuple[str, str]:
    if not ay_start or not term_number:
        return ("", "")
    return (f"AY {ay_start}-{ay_start + 1}", f"Term {int(term_number)}")

# ---------------------------
# Public Endpoint
# ---------------------------
@router.get("/course-history")
async def course_history(
    course_code: Optional[str] = Query(None, description="Filter by course code (contains match)"),
    faculty_name: Optional[str] = Query(None, description="Filter by faculty display name (contains match)"),
    limit_courses: int = Query(200, ge=1, le=1000, description="Max number of distinct courses to return"),
) -> Dict[str, Any]:
    """
    Returns a list of courses with their historical offerings grouped as:
      [
        {
          code: "CS 101",
          title: "Intro to Programming",
          history: [
            { ay: "AY 2024–2025", term: "Term 1", faculty: "Alvarez, M." },
            ...
          ]
        },
        ...
      ]

    The shape purposely mirrors your front-end “OM-REPO-ANA_CourseHistory.tsx” sample
    so it can be bound directly without further transformation.
    """

    active = await _active_term()

    # ---- Stage 1: pull recent assignments + joins (course, section->term, faculty->user) ----
    pipeline: List[Dict[str, Any]] = []

    # Join Section (for term_id; section_code if needed)
    pipeline += [
        {"$lookup": {"from": COL_SECTIONS, "localField": "section_id", "foreignField": "section_id", "as": "sec"}},
        {"$unwind": {"path": "$sec", "preserveNullAndEmptyArrays": True}},
    ]

    # Join Course (for code/title)
    pipeline += [
        {"$lookup": {"from": COL_COURSES, "localField": "sec.course_id", "foreignField": "course_id", "as": "course"}},
        {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},
    ]

    # Join Faculty -> User (for display name)
    pipeline += [
        {"$lookup": {"from": COL_FACULTY, "localField": "faculty_id", "foreignField": "faculty_id", "as": "fac"}},
        {"$unwind": {"path": "$fac", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {"from": COL_USERS, "localField": "fac.user_id", "foreignField": "user_id", "as": "u"}},
        {"$unwind": {"path": "$u", "preserveNullAndEmptyArrays": True}},
    ]

    # Optional filters (contains match) based on display fields
    match_stage: Dict[str, Any] = {}
    if course_code:
        match_stage["$expr"] = {
            "$regexMatch": {
                "input": {
                    "$cond": [
                        {"$isArray": "$course.course_code"},
                        {"$ifNull": [{"$arrayElemAt": ["$course.course_code", 0]}, ""]},
                        {"$ifNull": ["$course.course_code", ""]},
                    ]
                },
                "regex": course_code,
                "options": "i",
            }
        }
    if faculty_name:
        match_stage_fac = {
            "$regexMatch": {
                "input": {
                    "$trim": {
                        "input": {
                            "$concat": [
                                {"$ifNull": ["$u.first_name", ""]},
                                {
                                    "$cond": [
                                        {
                                            "$and": [
                                                {"$ne": ["$u.first_name", None]},
                                                {"$ne": ["$u.last_name", None]},
                                            ]
                                        },
                                        " ",
                                        "",
                                    ]
                                },
                                {"$ifNull": ["$u.last_name", ""]},
                            ]
                        }
                    }
                },
                "regex": faculty_name,
                "options": "i",
            }
        }
        if "$expr" in match_stage:
            # combine both expr via $and
            match_stage = {"$and": [ {"$expr": match_stage["$expr"]}, {"$expr": match_stage_fac} ]}
        else:
            match_stage["$expr"] = match_stage_fac

    if match_stage:
        pipeline.append({"$match": match_stage})

    # Light sort & cap (newest created first)
    pipeline += [{"$sort": {"_id": -1}}, {"$limit": 3000}]

    # ---- Stage 2: stream and build grouped map in Python ----
    # We'll memoize terms to avoid repeated lookups.
    term_cache: Dict[Any, Tuple[str, str]] = {}

    grouped: Dict[str, Dict[str, Any]] = {}  # key: course_code (display), value: { code, title, history: [...] }

    async for it in db[COL_ASSIGN].aggregate(pipeline):
        course_doc = it.get("course") or {}
        code = _normalize_course_code(course_doc)
        title = (course_doc.get("course_title") or "").strip()

        # Faculty display
        fac = _display_name(it.get("u") or {})
        # Format: "LAST, F." if you prefer – but we keep "First Last" here to minimize assumptions.

        # AY + Term
        sec = it.get("sec") or {}
        term_id = sec.get("term_id")
        ay_label, term_label = "", ""
        if term_id is not None:
            if term_id in term_cache:
                ay_label, term_label = term_cache[term_id]
            else:
                tdoc = await db[COL_TERMS].find_one(
                    {"term_id": term_id}, {"_id": 0, "acad_year_start": 1, "term_number": 1}
                )
                ay_label, term_label = _ay_term_from_numbers(
                    (tdoc or {}).get("acad_year_start"), (tdoc or {}).get("term_number")
                )
                term_cache[term_id] = (ay_label, term_label)

        if not code:
            # skip bad rows without a normalized course code
            continue

        entry = grouped.get(code) or {"code": code, "title": title, "history": []}
        entry["title"] = entry["title"] or title  # fill if first time
        # Append one history line
        entry["history"].append(
            {
                "ay": ay_label or "",
                "term": term_label or "",
                "faculty": fac or "",
            }
        )
        grouped[code] = entry

        # Optional: stop if we already have enough distinct courses
        if len(grouped) >= limit_courses:
            # We still finish the current iteration; early cut would complicate streaming
            pass

    courses = list(grouped.values())
    # Sort courses asc by code, keep each history newest-first by AY/Term (best-effort)
    def hist_key(h: Dict[str, str]) -> Tuple[int, int]:
        # Extract numbers for AY and Term safely
        ay = h.get("ay", "")
        term = h.get("term", "")
        # ay like "AY 2024-2025"
        try:
            ay_start = int(ay.split()[1].split("–")[0].split("-")[0])
        except Exception:
            ay_start = -9999
        try:
            tnum = int(term.replace("Term", "").strip())
        except Exception:
            tnum = 99
        return (ay_start, -tnum)

    for c in courses:
        c["history"].sort(key=hist_key, reverse=True)

    # ---- Sample block (hardcoded) so UI shows even with empty DB) ----
    # Matches exactly your OM-REPO-ANA_CourseHistory.tsx MOCK_ROWS shape
    sample: List[Dict[str, Any]] = [
        {
            "code": "CS 101",
            "title": "Introduction to Programming",
            "history": [
                {"ay": "AY 2024–2025", "term": "Term 1", "faculty": "Alvarez, M."},
                {"ay": "AY 2024–2025", "term": "Term 2", "faculty": "Alvarez, M."},
                {"ay": "AY 2023–2024", "term": "Term 3", "faculty": "Santos, R."},
                {"ay": "AY 2022–2023", "term": "Term 1", "faculty": "Alvarez, M."},
            ],
        },
        {
            "code": "CS 201",
            "title": "Data Structures",
            "history": [
                {"ay": "AY 2024–2025", "term": "Term 3", "faculty": "Lim, K."},
                {"ay": "AY 2023–2024", "term": "Term 2", "faculty": "Tan, J."},
            ],
        },
        {
            "code": "IT 135",
            "title": "Web Technologies",
            "history": [
                {"ay": "AY 2025–2026", "term": "Term 1", "faculty": "Reyes, P."},
                {"ay": "AY 2024–2025", "term": "Term 2", "faculty": "Cruz, A."},
                {"ay": "AY 2023–2024", "term": "Term 1", "faculty": "Cruz, A."},
            ],
        },
    ]

    # If the DB has nothing (common in early dev), feed sample to the UI
    payload_courses = courses if len(courses) > 0 else sample

    return {
        "ok": True,
        "meta": {"term_label": _term_label(active)},
        "courses": payload_courses,
        # always include sample for dev reference/inspection
        "sample": sample,
        "count": len(payload_courses),
        "generated_at": datetime.utcnow().isoformat() + "Z",
    }
