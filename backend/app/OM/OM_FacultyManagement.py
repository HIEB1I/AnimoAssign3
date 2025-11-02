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
    t = await db[COL_TERMS].find_one(
        {"$or": [{"status": "active"}, {"is_current": True}]},
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
    )
    if t:
        return t
    last = await db[COL_TERMS].find(
        {}, {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1}
    ).sort([("acad_year_start", -1), ("term_number", -1)]).limit(1).to_list(1)
    return last[0] if last else {}

# ---------- Route ----------
@router.post("/facultymanagement")
async def facultymanagement_handler(
    action: str = Query("list", description="header | options | list | profile | schedule | history"),

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

        return {"ok": True, "departments": department_options,
                "facultyTypes": faculty_types, "academicYears": ay_list}

    # ----- LIST -----
    if action == "list":
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
            {"$lookup": {
                "from": COL_PREFS,
                "let": {"fid": "$faculty_id"},
                "pipeline": [
                    {"$match": {"$expr": {"$eq": ["$faculty_id", "$$fid"]}}},
                    {"$match": {"$expr": {"$eq": ["$faculty_id", "$$fid"]}}},
                    {"$project": {"_id": 0, "preferred_units": 1}}
                ],
                "as": "pref"
            }},
            {"$unwind": {"path": "$pref", "preserveNullAndEmptyArrays": True}},
            {"$addFields": {
                "department_display": _dept_name_expr(),
                "name": _full_name_expr(),
                "email_display": {"$ifNull": ["$u.email", "$email"]},
                "status_display": {"$cond": [{"$eq": ["$u.status", True]}, "Active", "On Leave"]},
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
                "position": 1,
                "teaching_units": "$teaching_units_display",
                "faculty_type": "$faculty_type_display",
                "status": "$status_display",
            }},
            {"$sort": {"name": 1}},
        ])

        rows = [r async for r in db[COL_FACULTY].aggregate(pipeline)]
        return {"ok": True, "rows": rows}

    # ----- PROFILE (now includes real Course Coordinator list) -----
    if action == "profile":
        if not facultyId:
            raise HTTPException(status_code=400, detail="facultyId is required.")

        pipeline: List[Dict[str, Any]] = [
            {"$match": {"faculty_id": facultyId}},
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

            # ---- REAL course coordinator list from courses ----
            {"$lookup": {
                "from": COL_COURSES,
                "let": {"uid": {"$ifNull": ["$user_id", "$u.user_id"]}},
                "pipeline": [
                    # normalize course_coordinator to array and match
                    {"$addFields": {
                        "cc_list": {
                            "$cond": [
                                {"$isArray": "$course_coordinator"},
                                {"$ifNull": ["$course_coordinator", []]},
                                {"$cond": [
                                    {"$gt": [{"$type": "$course_coordinator"}, "missing"]},
                                    [{"$ifNull": ["$course_coordinator", ""]}],
                                    []
                                ]}
                            ]
                        }
                    }},
                    {"$match": {"$expr": {"$in": ["$$uid", "$cc_list"]}}},
                    # reduce course_code (array/string) to neat display
                    {"$addFields": {
                        "code_list": {
                            "$cond": [
                                {"$isArray": "$course_code"}, "$course_code",
                                {"$cond": [{"$ne": ["$course_code", None]}, ["$course_code"], []]}
                            ]
                        }
                    }},
                    {"$addFields": {
                        "code": {
                            "$cond": [
                                {"$gt": [{"$size": "$code_list"}, 0]},
                                {"$reduce": {
                                    "input": "$code_list",
                                    "initialValue": "",
                                    "in": {"$concat": ["$$value", {"$cond": [{"$eq": ["$$value", ""]}, "", " / "]}, "$$this"]}
                                }},
                                ""
                            ]
                        }
                    }},
                    {"$project": {"_id": 0, "code": 1, "course_title": 1}}
                ],
                "as": "cc_courses"
            }},

            {"$addFields": {
                "department_display": _dept_name_expr(),
                "name": _full_name_expr(),
                "email_display": {"$ifNull": ["$u.email", "$email"]},
                "status_display": {"$cond": [{"$eq": ["$u.status", True]}, "Active", "On Leave"]},
                "faculty_type_display": {
                    "$switch": {
                        "branches": [
                            {"case": {"$eq": ["$employment_type", "FT"]}, "then": "Full-Time"},
                            {"case": {"$eq": ["$employment_type", "PT"]}, "then": "Part-Time"},
                        ],
                        "default": {"$ifNull": ["$employment_type", ""]}
                    }
                },
                "cc_display": {
                    "$map": {
                        "input": {"$ifNull": ["$cc_courses", []]},
                        "as": "c",
                        "in": {"code": "$$c.code", "title": "$$c.course_title"}
                    }
                }
            }},
            {"$project": {
                "_id": 0,
                "faculty_id": 1,
                "name": 1,
                "email": "$email_display",
                "department": "$department_display",
                "faculty_type": "$faculty_type_display",
                "status": "$status_display",
                "position": 1,
                "admin_position": 1,
                "course_coordinator_of": "$cc_display",  # <-- final array [{code,title}]
                "load": {
                    "teaching": {"$ifNull": ["$load.teaching", 0]},
                    "admin": {"$ifNull": ["$load.admin", 0]},
                    "research": {"$ifNull": ["$load.research", 0]},
                    "faculty_units": {"$ifNull": ["$load.faculty_units", 0]},
                }
            }},
            {"$limit": 1}
        ]

        prof = [p async for p in db[COL_FACULTY].aggregate(pipeline)]
        return {"ok": bool(prof), "profile": (prof[0] if prof else {})}

        # ----- SCHEDULE: current/selected term sections (reuse FACULTY_Overview logic) -----
    if action == "schedule":
        if not facultyId:
            raise HTTPException(status_code=400, detail="facultyId is required.")

        # Resolve active term if not provided (kept for parity with OM)
        if not termId:
            active = await _active_term()
            termId = active.get("term_id")

        # === This pipeline mirrors FACULTY_Overview (/faculty/overview?action=fetch) ===
        pipeline = [
            {"$match": {"faculty_id": facultyId, "is_archived": False}},
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

        rows = [r async for r in db["faculty_assignments"].aggregate(pipeline)]

        # Format times exactly like overview
        def _fmt_hhmm(raw):
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

        def _fmt_time_band(start_raw, end_raw):
            st = _fmt_hhmm(start_raw)
            en = _fmt_hhmm(end_raw)
            return f"{st} – {en}".strip(" –")

        teaching_load = []
        for r in rows:
            # normalize course_code if list
            code = r.get("course_code")
            if isinstance(code, list):
                code = " / ".join(str(x) for x in code if x).strip()

            teaching_load.append({
                "day": r.get("day", ""),
                "course_code": code or "",
                "course_title": r.get("course_title", ""),
                "section": r.get("section", ""),
                "units": r.get("units", 0) or 0,
                "campus": r.get("campus", "Online"),
                "mode": r.get("mode", "Online"),
                "room": r.get("room", "Online"),
                "time": _fmt_time_band(r.get("start_raw"), r.get("end_raw")),
            })

        # Return the same shape the Overview returns so the FE can reuse its helper.
        return {"ok": True, "term_id": termId, "teaching_load": teaching_load}

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

        DAY_MAP = {"M":"Monday","MON":"Monday","T":"Tuesday","TU":"Tuesday","TUE":"Tuesday","W":"Wednesday","WED":"Wednesday",
                "TH":"Thursday","THU":"Thursday","R":"Thursday","F":"Friday","FRI":"Friday","S":"Saturday","SAT":"Saturday"}
        DAY_ORDER = {"Monday":1,"Tuesday":2,"Wednesday":3,"Thursday":4,"Friday":5,"Saturday":6}

        def _to_full_day(d):
            s = str(d or "").strip().upper()
            return DAY_MAP.get(s, str(d or ""))

        def _fmt_hhmm(raw):
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

        def _band(start, end):
            st, en = _fmt_hhmm(start), _fmt_hhmm(end)
            return f"{st} – {en}".strip(" –")

        rows = [r async for r in db[COL_ASSIGNMENTS].aggregate(pipeline)]

        # Section → flat UI row (take up to 2 meetings, sorted by day)
        flat = []
        for r in rows:
            meets = r.get("meetings") or []
            norm = []
            for m in meets:
                full_day = _to_full_day(m.get("day"))
                norm.append((DAY_ORDER.get(full_day, 99), {
                    "day": full_day,
                    "room": m.get("room") or "Online",
                    "mode": m.get("room_type") or "Online",
                    "time": _band(m.get("start"), m.get("end")),
                    "campus": m.get("campus") or None,
                }))
            norm.sort(key=lambda x: (x[0], x[1]["time"] or ""))

            # default fields
            day1 = room1 = day2 = room2 = None
            mode = None
            time_band = ""
            if norm:
                day1, room1, mode, time_band = norm[0][1]["day"], norm[0][1]["room"], norm[0][1]["mode"], norm[0][1]["time"]
            if len(norm) > 1:
                day2, room2 = norm[1][1]["day"], norm[1][1]["room"]

            # normalize course code if array
            code = r.get("course_code_raw")
            if isinstance(code, list):
                code = (code[0] if code else "") or ""

            flat.append({
                "term": f"Term {r.get('term_number') or ''}".strip(),
                "code": code or "",
                "title": r.get("course_title") or "",
                "section": r.get("section_code") or "",
                "mode": mode or "Online",
                "day1": day1, "room1": room1,
                "day2": day2, "room2": room2,
                "time": time_band,
            })

        # Group by term for OM payload → { terms: { "Term 1": [...] } }
        grouped = {"Term 1": [], "Term 2": [], "Term 3": []}
        for r in flat:
            grouped.setdefault(r["term"] or "Term 1", []).append({
                "code": r["code"],
                "title": r["title"],
                "section": r["section"],
                "mode": r["mode"],
                "day1": r.get("day1"), "room1": r.get("room1"),
                "day2": r.get("day2"), "room2": r.get("room2"),
                "time": r["time"],
            })

        return {"ok": True, "acad_year_start": acadYearStart, "terms": grouped}


    raise HTTPException(status_code=400, detail="Invalid action parameter.")
