# backend/app/OM/facultymanagement.py
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException, Query, Body
from ..main import db

router = APIRouter(prefix="/om", tags=["om"])

# ---------- Collections ----------
COL_USERS = "users"
COL_FACULTY = "faculty_profiles"
COL_DEPARTMENTS = "departments"
COL_TERMS = "terms"
COL_PREEN_COUNT = "preenlistment_count"   # NEW: for working/ planning term
COL_SECTIONS = "sections"                 # adjust if your collection name differs
COL_ASSIGNMENTS = "faculty_assignments" 
COL_PREFS = "faculty_preferences"
COL_ROLE_ASSIGN = "role_assignments"
COL_USER_ROLES = "user_roles"             # uses { role_id, role_type, ... }
COL_COURSES = "courses"                   # NEW: to fetch course_title/units for schedule

WEEKDAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

# ---------- Day / time helpers ----------
_DAY_MAP = {
    "M": "Monday", "MON": "Monday",
    "T": "Tuesday", "TU": "Tuesday", "TUE": "Tuesday",
    "W": "Wednesday", "WED": "Wednesday",
    "TH": "Thursday", "THU": "Thursday", "R": "Thursday",
    "F": "Friday", "FRI": "Friday",
    "S": "Saturday", "SAT": "Saturday",
}
def _to_full_day(day_val: str) -> str:
    s = (day_val or "").strip().upper()
    return _DAY_MAP.get(s, (day_val or "").strip() or "")

# Day initials expected by OM tables (M/T/W/H/F/S)
_DAY_INITIAL_MAP = {
    "M": "M", "MON": "M", "MONDAY": "M",
    "T": "T", "TU": "T", "TUE": "T", "TUESDAY": "T",
    "W": "W", "WED": "W", "WEDNESDAY": "W",
    "H": "H", "TH": "H", "THU": "H", "THUR": "H", "THURS": "H", "THURSDAY": "H", "R": "H",
    "F": "F", "FRI": "F", "FRIDAY": "F",
    "S": "S", "SAT": "S", "SATURDAY": "S",
    "U": "U", "SUN": "U", "SUNDAY": "U",
}

_DAY_INITIAL_ORDER = {"M": 1, "T": 2, "W": 3, "H": 4, "F": 5, "S": 6, "U": 7}

def _to_day_initial(day_val: Any) -> str:
    s = (str(day_val) if day_val is not None else "").strip()
    if not s:
        return ""
    up = s.strip().upper()

    # Exact known tokens
    if up in _DAY_INITIAL_MAP:
        return _DAY_INITIAL_MAP[up]

    # Full day names / prefixes
    if up.startswith("MON"):
        return "M"
    if up.startswith("TUE"):
        return "T"
    if up.startswith("WED"):
        return "W"
    if up.startswith("THU") or up.startswith("THR") or up.startswith("TH"):
        return "H"
    if up.startswith("FRI"):
        return "F"
    if up.startswith("SAT"):
        return "S"
    if up.startswith("SUN"):
        return "U"

    # Fall back as-is (better than losing information)
    return s

def _extract_mode_from_remarks(remarks: Any) -> str:
    """Mode is stored on sections.remarks (e.g., Hybrid, FOL, F2F/FTF, Online)."""
    if remarks is None:
        return "Online"
    if isinstance(remarks, dict):
        for k in ("mode", "delivery_mode", "class_mode", "section_mode"):
            v = remarks.get(k)
            if v:
                return str(v).strip()
        # fall back to a stringy representation
        remarks = " ".join(str(v) for v in remarks.values() if v)

    if isinstance(remarks, list):
        remarks = " ".join(str(x) for x in remarks if x)

    s = str(remarks).strip()
    if not s:
        return "Online"

    up = s.upper()
    if "HYBRID" in up:
        return "Hybrid"
    if "FOL" in up:
        return "FOL"
    if "F2F" in up:
        return "F2F"
    if "FTF" in up or "FACE" in up:
        return "FTF"
    if "ONLINE" in up:
        return "Online"
    if "BLENDED" in up:
        return "Blended"

    # Last-resort: keep whatever is in remarks (trimmed)
    return s
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
    if not s.isdigit():
        return s
    if len(s) == 3:
        h, m = int(s[0]), int(s[1:])
    elif len(s) == 4:
        h, m = int(s[:2]), int(s[2:])
    else:
        return s
    return f"{h:02d}:{m:02d}"

def _fmt_time_band(start_raw: Any, end_raw: Any) -> str:
    st = _fmt_hhmm(start_raw)
    en = _fmt_hhmm(end_raw)
    return f"{st} – {en}".strip(" –")

# ---------- Expression helpers ----------
def _dept_name_expr():
    return {"$ifNull": ["$dept.department_name", "$dept.dept_name"]}

def _full_name_expr():
    return {
        "$trim": {
            "input": {"$concat": [
                {"$ifNull": ["$u.first_name", ""]}, " ",
                {"$ifNull": ["$u.last_name",  ""]}
            ]}
        }
    }

def _role_display_expr():
    return {"$ifNull": ["$role.role_type", ""]}

async def _active_term() -> Dict[str, Any]:
    """
    Return the WORKING / PLANNING term for OM Faculty Management.

    Priority:
    1) If there is an active (non-archived) pre-enlistment batch in
       preenlistment_count, use that term_id.
    2) Otherwise, use the *next* term after the current term
       (where is_current/status flags it as current/active).
    3) If there is no "next" term configured, fall back to the current/latest term.
    """

    # 1) Try to derive from an active pre-enlistment batch
    pre_doc = await db[COL_PREEN_COUNT].find_one(
        {"is_archived": {"$ne": True}},
        {"_id": 0, "term_id": 1},
    )
    if pre_doc and pre_doc.get("term_id"):
        t = await db[COL_TERMS].find_one(
            {"term_id": pre_doc["term_id"]},
            {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
        )
        if t:
            return t

    # 2) Fallback: "current" term (any of the usual flags)
    current = await db[COL_TERMS].find_one(
        {
            "$or": [
                {"status": "active"},
                {"status": "Active"},
                {"is_current": True},
                {"is_active": True},
                {"active": True},
            ]
        },
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
    )

    if not current:
        # If nothing is flagged, use the latest by AY + term_number
        last = await db[COL_TERMS].find(
            {}, {"_id": 0, "term_id": 1, "term_number": 1, "acad_year_start": 1},
        ).sort([("acad_year_start", -1), ("term_number", -1)]).limit(1).to_list(1)
        current = last[0] if last else None

    if not current:
        # No terms at all
        return {}

    # 3) Compute the "next" term after the current term
    next_terms = await db[COL_TERMS].find(
        {
            "$or": [
                {"acad_year_start": {"$gt": current["acad_year_start"]}},
                {
                    "acad_year_start": current["acad_year_start"],
                    "term_number": {"$gt": current["term_number"]},
                },
            ]
        },
        {"_id": 0, "term_id": 1, "term_number": 1, "acad_year_start": 1},
    ).sort([("acad_year_start", 1), ("term_number", 1)]).limit(1).to_list(1)

    if next_terms:
        # Use the next term as the working/planning term
        return next_terms[0]

    # If no next term, stick with current (still better than nothing)
    return current

# ---------- Route ----------
@router.post("/facultymanagement")
async def facultymanagement_handler(
    action: str = Query("list", description="header | options | list | schedule | history"),

    # header (who’s logged in)
    userEmail: Optional[str] = Query(None),
    userId: Optional[str] = Query(None),

    # list filters
    department: Optional[str] = Query(None),
    facultyType: Optional[str] = Query(None, description="Full-Time | Part-Time | All Type"),
    search: Optional[str] = Query(None),

    # details
    facultyId: Optional[str] = Query(None),
    termId: Optional[str] = Query(None),
    acadYearStart: Optional[int] = Query(None),

    payload: Optional[Dict[str, Any]] = Body(None),
):
    # ----- HEADER -----
    if action == "header":
        if not userEmail and not userId:
            raise HTTPException(status_code=400, detail="userEmail or userId is required.")

        user_match: Dict[str, Any] = {"user_id": userId} if userId else {"email": userEmail}

        pipeline: List[Dict[str, Any]] = [
            {"$match": user_match},
            {"$project": {"_id": 0, "user_id": 1, "email": 1, "first_name": 1, "last_name": 1}},
            {"$lookup": {
                "from": COL_ROLE_ASSIGN,
                "localField": "user_id",
                "foreignField": "user_id",
                "as": "ra_list"
            }},
            {"$unwind": {"path": "$ra_list", "preserveNullAndEmptyArrays": True}},
            {"$addFields": {
                "deptScope": {
                    "$first": {
                        "$filter": {
                            "input": {"$ifNull": ["$ra_list.scope", []]},
                            "as": "s",
                            "cond": {"$eq": ["$$s.type", "department"]}
                        }
                    }
                },
                "role_id_from_ra": "$ra_list.role_id",
            }},
            {"$lookup": {
                "from": COL_DEPARTMENTS,
                "localField": "deptScope.id",
                "foreignField": "department_id",
                "as": "dept"
            }},
            {"$unwind": {"path": "$dept", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {
                "from": COL_USER_ROLES,
                "localField": "role_id_from_ra",
                "foreignField": "role_id",
                "as": "role"
            }},
            {"$unwind": {"path": "$role", "preserveNullAndEmptyArrays": True}},
            {"$addFields": {
                "full_name": {
                    "$trim": {"input": {"$concat": [
                        {"$ifNull": ["$first_name", ""]}, " ",
                        {"$ifNull": ["$last_name",  ""]}
                    ]}}
                },
                "dept_name": {"$ifNull": ["$dept.department_name", "$dept.dept_name"]},
                "role_display": _role_display_expr(),
            }},
            {"$project": {
                "_id": 0,
                "email": 1,
                "role_type": "$role.role_type",
                "department_id": "$deptScope.id",
                "profileName": "$full_name",
                "profileSubtitle": {
                    "$trim": {
                        "input": {
                            "$concat": [
                                {"$ifNull": ["$role_display", ""]},
                                {"$cond": [{"$ifNull": ["$dept_name", False]}, " | ", ""]},
                                {"$ifNull": ["$dept_name", ""]},
                            ]
                        }
                    }
                }
            }},
            {"$limit": 1}
        ]

        docs = [d async for d in db[COL_USERS].aggregate(pipeline)]
        if not docs:
            return {"ok": False, "message": "User not found."}
        return {"ok": True, **docs[0]}

    # ----- OPTIONS -----
    if action == "options":
        depts = [d async for d in db[COL_DEPARTMENTS]
                 .find({}, {"_id": 0, "department_name": 1, "dept_name": 1})]
        department_options = sorted({
            (d.get("department_name") or d.get("dept_name") or "").strip()
            for d in depts if (d.get("department_name") or d.get("dept_name"))
        })

        codes = await db[COL_FACULTY].distinct("employment_type")  # FT / PT
        type_map = {"FT": "Full-Time", "PT": "Part-Time"}
        faculty_types = sorted({type_map.get(c, c) for c in codes if c})

        terms = [t async for t in db[COL_TERMS]
                 .find({}, {"_id": 0, "acad_year_start": 1})
                 .sort([("acad_year_start", -1)])]
        ay_list = sorted({t.get("acad_year_start") for t in terms if t.get("acad_year_start")},
                         reverse=True)

        active = await _active_term()

        return {
            "ok": True,
            "departments": department_options,
            "facultyTypes": faculty_types,
            "academicYears": ay_list,
            "activeTerm": active,   # NEW: working / planning term for subtitle
        }

    # ----- LIST -----
    if action == "list":

        # Determine active term to prioritize its preferences
        active = await _active_term()
        active_term_id = active.get("term_id")

        early_match: Dict[str, Any] = {}
        if facultyType and facultyType.strip().lower() != "all type":
            code = {"Full-Time": "FT", "Part-Time": "PT"}.get(facultyType.strip())
            if code:
                early_match["employment_type"] = code

        dept_filter = (department or "").strip()
        if dept_filter.lower() == "all departments":
            dept_filter = ""

        pipeline: List[Dict[str, Any]] = [
            {"$match": early_match},
            {"$lookup": {
                "from": COL_DEPARTMENTS,
                "localField": "department_id",
                "foreignField": "department_id",
                "as": "dept",
            }},
            {"$unwind": {"path": "$dept", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {
                "from": COL_USERS,
                "let": {"uid": "$user_id", "femail": "$email"},
                "pipeline": [
                    {"$match": {"$expr": {"$or": [
                        {"$and": [{"$ne": ["$$uid", None]}, {"$eq": ["$user_id", "$$uid"]}]},
                        {"$and": [{"$ne": ["$$femail", None]}, {"$eq": ["$email", "$$femail"]}]},
                    ]}}},  # noqa: E231
                    {"$project": {"_id": 0, "first_name": 1, "last_name": 1, "status": 1, "email": 1}}
                ],
                "as": "u"
            }},
            {"$unwind": {"path": "$u", "preserveNullAndEmptyArrays": True}},
                        {
                "$lookup": {
                    "from": COL_PREFS,
                    "let": {"fid": "$faculty_id"},
                    "pipeline": [
                        {
                            # All prefs for this faculty
                            "$match": {
                                "$expr": {"$eq": ["$faculty_id", "$$fid"]},
                            }
                        },
                        {
                            # Flag rows that belong to the active term (if we have one)
                            "$addFields": {
                                "_is_active_term": {
                                    "$cond": [
                                        {
                                            "$and": [
                                                {"$ne": [active_term_id, None]},
                                                {"$eq": ["$term_id", active_term_id]},
                                            ]
                                        },
                                        1,
                                        0,
                                    ]
                                }
                            }
                        },
                        {
                            # Prefer active-term row, then latest submission
                            "$sort": {
                                "_is_active_term": -1,
                                "submitted_at": -1,
                                "_id": -1,
                            }
                        },
                        {
                            # We only ever want one doc per faculty
                            "$limit": 1
                        },
                        {
                            "$project": {
                                "_id": 0,
                                "preferred_units": 1,
                                "on_break": 1,  # <-- NEW: we need this for status logic
                            }
                        },

                    ],
                    "as": "pref",
                }
            },
            # Take the first (and only) element from the lookup array; null if none
            {"$addFields": {"pref": {"$first": "$pref"}}},

            {"$addFields": {
                "department_display": _dept_name_expr(),
                "name": _full_name_expr(),
                "email_display": {"$ifNull": ["$u.email", "$email"]},
                "status_display": {
                    "$cond": [
                        {"$eq": ["$pref.on_break", True]},
                        "On Leave",
                        {
                            "$cond": [
                                {"$eq": ["$u.status", True]},
                                "Active",
                                "On Leave",
                            ]
                        },
                    ]
                },
                "faculty_type_display": {
                    "$switch": {
                        "branches": [
                            {"case": {"$eq": ["$employment_type", "FT"]}, "then": "Full-Time"},
                            {"case": {"$eq": ["$employment_type", "PT"]}, "then": "Part-Time"},
                        ],
                        "default": {"$ifNull": ["$employment_type", ""]},
                    }
                },
                "teaching_units_display": {"$ifNull": ["$pref.preferred_units", "N/A"]},
            }},
            {"$match": {"$expr": {"$or": [
                {"$eq": [dept_filter, ""]},
                {"$eq": ["$department_display", dept_filter]}
            ]}}}
        ]

        if search and search.strip():
            s = search.strip()
            pipeline.append({"$match": {"$or": [
                {"name": {"$regex": s, "$options": "i"}},
                {"email_display": {"$regex": s, "$options": "i"}},
                {"user_id": {"$regex": s, "$options": "i"}},
            ]}})

        pipeline.extend([
            {"$project": {
                "_id": 0,
                "faculty_id": 1,
                "name": 1,
                "email": "$email_display",
                "department": "$department_display",
                "position": {"$ifNull": ["$position", {"$ifNull": ["$fac_position", ""]}]},
                "teaching_units": "$teaching_units_display",
                "faculty_type": "$faculty_type_display",
                "status": "$status_display",
            }},
            {"$sort": {"name": 1}},
        ])

        rows = [r async for r in db[COL_FACULTY].aggregate(pipeline)]
        return {"ok": True, "rows": rows}

        # ----- SCHEDULE: current/selected term sections (reuse FACULTY_Overview logic) -----
    if action == "schedule":
        if not facultyId:
            raise HTTPException(status_code=400, detail="facultyId is required.")

        # Resolve working term if not provided
        if not termId:
            active = await _active_term()
            termId = active.get("term_id")

        # faculty_assignments -> sections (filter by term) -> courses -> section_schedules
        pipeline: List[Dict[str, Any]] = [
            {"$match": {"faculty_id": facultyId, "is_archived": False}},
            {"$lookup": {"from": COL_SECTIONS, "localField": "section_id", "foreignField": "section_id", "as": "sec"}},
            {"$unwind": {"path": "$sec", "preserveNullAndEmptyArrays": True}},
        ]

        if termId:
            pipeline.append({"$match": {"sec.term_id": termId}})

        pipeline.extend([
            {"$lookup": {"from": COL_COURSES, "localField": "sec.course_id", "foreignField": "course_id", "as": "course"}},
            {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": "section_schedules", "localField": "sec.section_id", "foreignField": "section_id", "as": "sched"}},
            {"$unwind": {"path": "$sched", "preserveNullAndEmptyArrays": True}},

            {"$addFields": {
                "course_code_display": {
                    "$cond": [
                        {"$isArray": "$course.course_code"},
                        {"$ifNull": [{"$arrayElemAt": ["$course.course_code", 0]}, ""]},
                        {"$ifNull": ["$course.course_code", ""]},
                    ]
                }
            }},

            {"$project": {
                "_id": 0,
                "section_id": "$sec.section_id",
                "section": "$sec.section_code",
                "course_code": "$course_code_display",
                "course_title": "$course.course_title",
                "units": {"$ifNull": ["$course.units", 0]},
                "sched_day": "$sched.day",
                "sched_start": "$sched.start_time",
                "sched_end": "$sched.end_time",
                "section_remarks": "$sec.remarks",
            }},

            {"$group": {
                "_id": "$section_id",
                "section": {"$first": "$section"},
                "course_code": {"$first": "$course_code"},
                "course_title": {"$first": "$course_title"},
                "units": {"$first": "$units"},
                "section_remarks": {"$first": "$section_remarks"},
                "meetings": {"$push": {
                    "day": "$sched_day",
                    "start": "$sched_start",
                    "end": "$sched_end",
                    
                }},
            }},
        ])

        raw_rows = [r async for r in db[COL_ASSIGNMENTS].aggregate(pipeline)]

        # Flatten: 1 row per section, up to 2 meetings (Day/Begin/End)
        day_order = _DAY_INITIAL_ORDER

        out_rows: List[Dict[str, Any]] = []
        for r in raw_rows:
            meets = r.get("meetings") or []

            norm = []
            for m in meets:
                if not (m.get("day") or m.get("start") or m.get("end")):
                    continue
                day = _to_day_initial(m.get("day"))
                begin = _fmt_hhmm(m.get("start"))
                end = _fmt_hhmm(m.get("end"))
                norm.append((day_order.get(day, 99), begin, {
                    "day": day,
                    "begin": begin,
                    "end": end,
                                    }))

            norm.sort(key=lambda x: (x[0], x[1] or ""))

            day1 = begin1 = end1 = day2 = begin2 = end2 = ""
            mode_val = _extract_mode_from_remarks(r.get("section_remarks"))
            if norm:
                day1 = norm[0][2]["day"]
                begin1 = norm[0][2]["begin"]
                end1 = norm[0][2]["end"]
            if len(norm) > 1:
                day2 = norm[1][2]["day"]
                begin2 = norm[1][2]["begin"]
                end2 = norm[1][2]["end"]

            code = r.get("course_code") or ""
            if isinstance(code, list):
                code = " / ".join(str(x) for x in code if x).strip()

            out_rows.append({
                "course_code": code,
                "course_title": r.get("course_title") or "",
                "section": r.get("section") or "",
                "mode": mode_val,
                "units": r.get("units", 0) or 0,
                "day1": day1,
                "begin1": begin1,
                "end1": end1,
                "day2": day2,
                "begin2": begin2,
                "end2": end2,
            })

        out_rows.sort(key=lambda x: (x.get("course_code") or "", x.get("section") or ""))

        return {"ok": True, "term_id": termId, "teaching_load": out_rows}


    # ----- HISTORY: per AY grouped by term -----
    # ----- HISTORY: per AY grouped by term -----
    if action == "history":
        if not facultyId:
            raise HTTPException(status_code=400, detail="facultyId is required.")

        # Default AY = most recent
        if acadYearStart is None:
            latest = await db[COL_TERMS].find({}, {"_id": 0, "acad_year_start": 1}) \
                .sort([("acad_year_start", -1)]).limit(1).to_list(1)
            acadYearStart = latest[0]["acad_year_start"] if latest else None
            if acadYearStart is None:
                return {"ok": True, "acad_year_start": None, "terms": {}}

        # Build like FACULTY_History: assign -> section -> course -> term -> schedules -> room -> campus
        pipeline = [
            {"$match": {"faculty_id": facultyId, "is_archived": False}},
            {"$lookup": {"from": "sections", "localField": "section_id", "foreignField": "section_id", "as": "sec"}},
            {"$unwind": {"path": "$sec", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": "courses", "localField": "sec.course_id", "foreignField": "course_id", "as": "course"}},
            {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": "terms", "localField": "sec.term_id", "foreignField": "term_id", "as": "t"}},
            {"$unwind": {"path": "$t", "preserveNullAndEmptyArrays": True}},
            # Filter by AY via joined terms (not on the assignment doc)
            {"$match": {"t.acad_year_start": acadYearStart}},
            # schedules fan-out
            {"$lookup": {"from": "section_schedules", "localField": "sec.section_id", "foreignField": "section_id", "as": "scheds"}},
            {"$unwind": {"path": "$scheds", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": "rooms", "localField": "scheds.room_id", "foreignField": "room_id", "as": "room"}},
            {"$unwind": {"path": "$room", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": "campuses", "localField": "room.campus_id", "foreignField": "campus_id", "as": "camp"}},
            {"$unwind": {"path": "$camp", "preserveNullAndEmptyArrays": True}},
            {"$project": {
                "_id": 0,
                "section_id": "$sec.section_id",
                "section_code": "$sec.section_code",
                "course_code_raw": "$course.course_code",
                "course_title": "$course.course_title",
                "units": {"$ifNull": ["$course.units", 0]},
                "term_number": "$t.term_number",
                "sched_day": "$scheds.day",
                "sched_room_type": "$scheds.room_type",
                "sched_start": "$scheds.start_time",
                "sched_end": "$scheds.end_time",
                "room_number": "$room.room_number",
                "campus_name": "$camp.campus_name",
            }},
            # Group back to section and collect meetings (sorted later)
            {"$group": {
                "_id": "$section_id",
                "section_code": {"$first": "$section_code"},
                "course_code_raw": {"$first": "$course_code_raw"},
                "course_title": {"$first": "$course_title"},
                "units": {"$first": "$units"},
                "term_number": {"$first": "$term_number"},
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
        day_order = _DAY_INITIAL_ORDER

        rows = [r async for r in db[COL_ASSIGNMENTS].aggregate(pipeline)]

        # Section → flat UI row (take up to 2 meetings, sorted by day)
        flat = []
        for r in rows:
            meets = r.get("meetings") or []
            norm = []
            for m in meets:
                if not (m.get("day") or m.get("start") or m.get("end")):
                    continue
                day = _to_day_initial(m.get("day"))
                begin = _fmt_hhmm(m.get("start"))
                end = _fmt_hhmm(m.get("end"))
                norm.append((day_order.get(day, 99), begin, {
                    "day": day,
                    "begin": begin,
                    "end": end,
                }))
            norm.sort(key=lambda x: (x[0], x[1] or ""))

            day1 = begin1 = end1 = day2 = begin2 = end2 = None
            if norm:
                day1 = norm[0][2]["day"]
                begin1 = norm[0][2]["begin"]
                end1 = norm[0][2]["end"]
            if len(norm) > 1:
                day2 = norm[1][2]["day"]
                begin2 = norm[1][2]["begin"]
                end2 = norm[1][2]["end"]

            # normalize course code if array
            code = r.get("course_code_raw")
            if isinstance(code, list):
                code = (code[0] if code else "") or ""

            flat.append({
                "term": f"Term {r.get('term_number') or ''}".strip(),
                "code": code or "",
                "title": r.get("course_title") or "",
                "section": r.get("section_code") or "",
                "units": r.get("units", 0) or 0,
                "day1": day1 or "",
                "begin1": begin1 or "",
                "end1": end1 or "",
                "day2": day2 or "",
                "begin2": begin2 or "",
                "end2": end2 or "",
            })

        # Group by term for OM payload → { terms: { "Term 1": [...] } }
        grouped = {"Term 1": [], "Term 2": [], "Term 3": []}
        for r in flat:
            grouped.setdefault(r["term"] or "Term 1", []).append({
                "code": r["code"],
                "title": r["title"],
                "section": r["section"],
                "units": r.get("units", 0),
                "day1": r.get("day1"),
                "begin1": r.get("begin1"),
                "end1": r.get("end1"),
                "day2": r.get("day2"),
                "begin2": r.get("begin2"),
                "end2": r.get("end2"),
            })

        return {"ok": True, "acad_year_start": acadYearStart, "terms": grouped}


    raise HTTPException(status_code=400, detail="Invalid action parameter.")
