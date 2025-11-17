# backend/app/CHAIR/facultymanagement.py
from typing import Any, Dict, List, Optional, Tuple
from fastapi import APIRouter, HTTPException, Query, Body
from datetime import datetime, timezone
import re

from ..main import db

router = APIRouter(prefix="/chair", tags=["chair"])

# ---------- Collections ----------
COL_USERS = "users"
COL_FACULTY = "faculty_profiles"
COL_DEPARTMENTS = "departments"
COL_TERMS = "terms"
COL_SECTIONS = "sections"
COL_ASSIGNMENTS = "faculty_assignments"
COL_PREFS = "faculty_preferences"
COL_ROLE_ASSIGN = "role_assignments"
COL_USER_ROLES = "user_roles"
COL_COURSES = "courses"
COL_PREEN_COUNT = "preenlistment_count"
COL_CAMPUSES = "campuses"

WEEKDAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

# ---------- Day / time helpers ----------
# Updated to include single letter codes (M, T, W, H, F, S)
_DAY_MAP = {
    "M": "Monday", "MON": "Monday",
    "T": "Tuesday", "TU": "Tuesday", "TUE": "Tuesday",
    "W": "Wednesday", "WED": "Wednesday",
    "TH": "Thursday", "THU": "Thursday", "R": "Thursday", "H": "Thursday",
    "F": "Friday", "FRI": "Friday",
    "S": "Saturday", "SAT": "Saturday",
}
DAY_ORDER_MAP = {"Monday": 1, "Tuesday": 2, "Wednesday": 3, "Thursday": 4, "Friday": 5, "Saturday": 6}

def _to_full_day(day_val: str) -> str:
    s = (day_val or "").strip().upper()
    return _DAY_MAP.get(s, (day_val or "").strip() or "")

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

def _fmt_time_band(start_raw: Any, end_raw: Any) -> str:
    st = _fmt_hhmm(start_raw)
    en = _fmt_hhmm(end_raw)
    return f"{st} – {en}".strip(" –")

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

# ---------- Campus Fallback Helper ----------
async def _dept_fallback_campus_name(department_id: Optional[str]) -> Optional[str]:
    if not department_id:
        return None
    dept = await db[COL_DEPARTMENTS].find_one({"department_id": department_id}, {"_id": 0, "campus_id": 1})
    campus_ids = (dept or {}).get("campus_id") or []
    first = campus_ids[0] if isinstance(campus_ids, list) and campus_ids else None
    if not first:
        return None
    camp = await db[COL_CAMPUSES].find_one({"campus_id": first}, {"_id": 0, "campus_name": 1})
    return (camp or {}).get("campus_name")

# ---------- Small helpers for IDs & coercion ----------

async def _next_id(collection_name: str, field: str, prefix: str) -> str:
    coll = db[collection_name]
    cursor = coll.find(
        {field: {"$regex": f"^{re.escape(prefix)}[0-9]+$"}},
        {field: 1, "_id": 0},
    ).sort(field, -1).limit(1)
    docs = [d async for d in cursor]
    if docs:
        last = str(docs[0].get(field, "") or "")
        num_part = "".join(ch for ch in last if ch.isdigit())
        try:
            n = int(num_part)
        except (TypeError, ValueError):
            n = 0
    else:
        n = 0
    return f"{prefix}{n + 1:04d}"

def _normalize_certifications(raw: Any) -> List[str]:
    if raw is None:
        return []
    parts: List[str] = []
    if isinstance(raw, list):
        for item in raw:
            for piece in str(item or "").split(","):
                parts.append(piece)
    else:
        for piece in str(raw or "").split(","):
            parts.append(piece)
    return [p.strip() for p in parts if p and p.strip()]

def _coerce_int(val: Any) -> Optional[int]:
    if val is None or val == "":
        return None
    try:
        return int(val)
    except (TypeError, ValueError):
        return None

def _validate_dlsu_email(email: str) -> bool:
    if not email:
        return False
    s = email.strip()
    at_index = s.rfind("@")
    if at_index <= 0:
        return False
    local = s[:at_index]
    domain = s[at_index + 1 :]
    if domain.lower() != "dlsu.edu.ph":
        return False
    if "." not in local or " " in local:
        return False
    if not re.match(r"^[^@\s]+@dlsu\.edu\.ph$", s, flags=re.IGNORECASE):
        return False
    return True

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

    # 2) Fallback: "current" term
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
        last = await db[COL_TERMS].find(
            {}, {"_id": 0, "term_id": 1, "term_number": 1, "acad_year_start": 1},
        ).sort([("acad_year_start", -1), ("term_number", -1)]).limit(1).to_list(1)
        current = last[0] if last else None

    if not current:
        return {}

    # 3) Compute the "next" term
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
        return next_terms[0]

    return current


# ---------- Route ----------
@router.post("/facultymanagement")
async def facultymanagement_handler(
    action: str = Query(
        "list",
        description="header | options | list | schedule | history | add | update"
    ),
    userEmail: Optional[str] = Query(None),
    userId: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    facultyType: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    facultyId: Optional[str] = Query(None),
    termId: Optional[str] = Query(None),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    payload = payload or {}

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

        active = await _active_term()
        ay = active.get("acad_year_start")
        tn = active.get("term_number")
        activeTermText = f"Term {tn} · AY {ay}-{ay + 1}" if (ay and tn) else ""

        return {
            "ok": True,
            **docs[0],
            "activeTermText": activeTermText,
        }


    # ----- OPTIONS -----
    if action == "options":
        depts = [d async for d in db[COL_DEPARTMENTS]
                 .find({}, {"_id": 0, "department_name": 1, "dept_name": 1})]
        department_options = sorted({
            (d.get("department_name") or d.get("dept_name") or "").strip()
            for d in depts if (d.get("department_name") or d.get("dept_name"))
        })

        codes = await db[COL_FACULTY].distinct("employment_type")
        type_map = {"FT": "Full-Time", "PT": "Part-Time"}
        faculty_types = sorted({type_map.get(c, c) for c in codes if c})

        terms = [t async for t in db[COL_TERMS]
                 .find({}, {"_id": 0, "acad_year_start": 1})
                 .sort([("acad_year_start", -1)])]
        ay_list = sorted(
            {t.get("acad_year_start") for t in terms if t.get("acad_year_start")},
            reverse=True
        )

        active_term_obj = await _active_term()

        return {
            "ok": True,
            "departments": department_options,
            "facultyTypes": faculty_types,
            "academicYears": ay_list,
            "activeTerm": active_term_obj,
        }

    # ----- LIST -----
    if action == "list":
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

        pipeline = [
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
                    ]}}},
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
                        {"$match": {"$expr": {"$eq": ["$faculty_id", "$$fid"]}}},
                        {"$addFields": {
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
                        }},
                        {"$sort": {"_is_active_term": -1, "submitted_at": -1, "_id": -1}},
                        {"$limit": 1},
                        {"$project": {"_id": 0, "preferred_units": 1, "on_break": 1}},
                    ],
                    "as": "pref",
                }
            },
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

    # ----- SCHEDULE -----
    if action == "schedule":
        if not facultyId:
            raise HTTPException(status_code=400, detail="facultyId is required.")
        if not termId:
            active = await _active_term()
            termId = active.get("term_id")

        pipeline = [
            {"$match": {"faculty_id": facultyId, "is_archived": False}},
            {"$lookup": {
                "from": "sections",
                "localField": "section_id",
                "foreignField": "section_id",
                "as": "sec",
            }},
            {"$unwind": {"path": "$sec", "preserveNullAndEmptyArrays": True}},
        ]

        if termId:
            pipeline.append({"$match": {"sec.term_id": termId}})

        pipeline.extend([
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
                            {"case": {"$in": [{"$toUpper": "$sched.day"}, ["M", "MON"]]}, "then": "Monday"},
                            {"case": {"$in": [{"$toUpper": "$sched.day"}, ["T", "TU", "TUE"]]}, "then": "Tuesday"},
                            {"case": {"$in": [{"$toUpper": "$sched.day"}, ["W", "WED"]]}, "then": "Wednesday"},
                            # Added "H" here for Thursday consistency
                            {"case": {"$in": [{"$toUpper": "$sched.day"}, ["TH", "THU", "R", "H"]]}, "then": "Thursday"},
                            {"case": {"$in": [{"$toUpper": "$sched.day"}, ["F", "FRI"]]}, "then": "Friday"},
                            {"case": {"$in": [{"$toUpper": "$sched.day"}, ["S", "SAT"]]}, "then": "Saturday"},
                        ],
                        "default": "$sched.day",
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
        ])

        rows = [r async for r in db[COL_ASSIGNMENTS].aggregate(pipeline)]
        teaching_load = []
        for r in rows:
            teaching_load.append({
                "day": r.get("day", ""),
                "course_code": r.get("course_code", ""),
                "course_title": r.get("course_title", ""),
                "section": r.get("section", ""),
                "units": r.get("units", 0) or 0,
                "campus": r.get("campus", "Online"),
                "mode": r.get("mode", "Online"),
                "room": r.get("room", "Online"),
                "time": _fmt_time_band(r.get("start_raw"), r.get("end_raw")),
            })

        return {"ok": True, "term_id": termId, "teaching_load": teaching_load}

    # ----- HISTORY -----
    if action == "history":
        if not facultyId:
            raise HTTPException(status_code=400, detail="facultyId is required.")

        # Fetch Faculty to get department for fallback
        fac_profile = await db[COL_FACULTY].find_one({"faculty_id": facultyId}, {"department_id": 1})
        if not fac_profile:
            raise HTTPException(status_code=404, detail="Faculty not found.")
        
        department_id = fac_profile.get("department_id")
        dept_fallback_campus = await _dept_fallback_campus_name(department_id)

        # Pipeline mirrors FACULTY_History "fetch"
        pipeline = [
            {"$match": {"faculty_id": facultyId, "is_archived": False}},
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
            # Group back per section, collect meetings
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

        rows = [r async for r in db[COL_ASSIGNMENTS].aggregate(pipeline)]

        # Build UI rows
        out = []
        for r in rows:
            meetings = r.get("meetings") or []
            # Normalize and sort by day order
            norm_meet = []
            for m in meetings:
                full_day = _to_full_day(m.get("day"))
                norm_meet.append((DAY_ORDER_MAP.get(full_day, 99), {
                    "day": full_day,
                    "room": m.get("room") or None,
                    "mode": (m.get("room_type") or "Online"),
                    "time": _fmt_time_band(m.get("start"), m.get("end")),
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
                campus_name = campus_name or norm_meet[1][1]["campus"]

            # Campus fallback rule
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

    # ----- ADD -----
    if action == "add":
        first_name = str(payload.get("first_name", "")).strip()
        last_name = str(payload.get("last_name", "")).strip()
        email = str(payload.get("email", "")).strip().lower()
        dept_name = str(payload.get("department", "")).strip()
        employment_type = str(payload.get("employment_type", "")).strip().upper()

        if not first_name or not last_name or not email:
            raise HTTPException(status_code=400, detail="Required fields missing.")
        if employment_type not in {"FT", "PT"}:
            raise HTTPException(status_code=400, detail="Invalid employment type.")
        if not _validate_dlsu_email(email):
            raise HTTPException(status_code=422, detail="Email is not a valid DLSU account")

        existing = await db[COL_USERS].find_one({"email": email}, {"_id": 1})
        if existing:
            raise HTTPException(status_code=409, detail="A user with this email already exists.")

        dept_id = "DEPT0001"
        if dept_name:
            dept_doc = await db[COL_DEPARTMENTS].find_one(
                {"$or": [{"department_name": dept_name}, {"dept_name": dept_name}]},
                {"_id": 0, "department_id": 1},
            )
            if dept_doc: dept_id = dept_doc["department_id"]

        role_doc = await db[COL_USER_ROLES].find_one({"role_type": "Faculty"})
        if not role_doc: raise HTTPException(status_code=500, detail="Faculty role config error.")
        
        user_id = await _next_id(COL_USERS, "user_id", "USR")
        faculty_id = await _next_id(COL_FACULTY, "faculty_id", "FAC")
        now = datetime.now(timezone.utc)

        await db[COL_USERS].insert_one({
            "user_id": user_id,
            "email": email,
            "first_name": first_name,
            "last_name": last_name,
            "status": True,
            "profile_image": "",
            "created_at": now,
            "last_login": now,
        })

        scope = payload.get("scope") or [
            {"type": "campus", "id": "CMPS0001"},
            {"type": "college", "id": "COLL0001"},
        ]
        if not any(s.get("type") == "department" for s in scope):
            scope.append({"type": "department", "id": dept_id})

        await db[COL_ROLE_ASSIGN].insert_one({
            "user_id": user_id,
            "role_id": role_doc["role_id"],
            "scope": scope,
        })

        await db[COL_FACULTY].insert_one({
            "faculty_id": faculty_id,
            "user_id": user_id,
            "email": email,
            "employment_type": employment_type,
            "department_id": dept_id,
            "fac_position": "Lecturer",
            "max_preps": 3,
            "certifications": _normalize_certifications(payload.get("certifications")),
            "teaching_years": _coerce_int(payload.get("teaching_years")),
        })

        return {"ok": True, "user_id": user_id, "faculty_id": faculty_id}

    # ----- UPDATE -----
    if action == "update":
        if not facultyId:
            raise HTTPException(status_code=400, detail="facultyId is required.")
        fac = await db[COL_FACULTY].find_one({"faculty_id": facultyId})
        if not fac:
            raise HTTPException(status_code=404, detail="Faculty profile not found.")

        user_id = fac.get("user_id")
        user_update = {}
        if "first_name" in payload: user_update["first_name"] = str(payload["first_name"]).strip()
        if "last_name" in payload: user_update["last_name"] = str(payload["last_name"]).strip()
        
        if "email" in payload:
            email = str(payload["email"]).strip().lower()
            if email:
                if not _validate_dlsu_email(email):
                    raise HTTPException(status_code=422, detail="Invalid email.")
                exist = await db[COL_USERS].find_one({"email": email, "user_id": {"$ne": user_id}})
                if exist: raise HTTPException(status_code=409, detail="Email already exists.")
                user_update["email"] = email

        if user_id and user_update:
            await db[COL_USERS].update_one({"user_id": user_id}, {"$set": user_update})

        fac_update = {}
        if "employment_type" in payload:
            et = str(payload["employment_type"]).strip().upper()
            if et in {"FT", "PT"}: fac_update["employment_type"] = et
        
        if "department" in payload:
            dname = str(payload["department"]).strip()
            if dname:
                dept_doc = await db[COL_DEPARTMENTS].find_one(
                    {"$or": [{"department_name": dname}, {"dept_name": dname}]}
                )
                if dept_doc: fac_update["department_id"] = dept_doc["department_id"]

        if "certifications" in payload:
            fac_update["certifications"] = _normalize_certifications(payload["certifications"])
        if "teaching_years" in payload:
            fac_update["teaching_years"] = _coerce_int(payload["teaching_years"])
        if "email" in payload:
            fac_update["email"] = str(payload["email"]).strip().lower()

        if fac_update:
            await db[COL_FACULTY].update_one({"faculty_id": facultyId}, {"$set": fac_update})

        return {"ok": True}

    raise HTTPException(status_code=400, detail="Invalid action parameter.")