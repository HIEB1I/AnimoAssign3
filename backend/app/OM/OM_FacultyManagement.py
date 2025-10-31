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
COL_SECTIONS = "sections"                 # or your actual sections coll
COL_ASSIGNMENTS = "teaching_assignments"  # optional; falls back to sections
COL_PREFS = "faculty_preferences"
COL_ROLE_ASSIGN = "role_assignments"
COL_USER_ROLES = "user_roles"
COL_COURSES = "courses"                   # <-- for course coordinator join

WEEKDAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]


# ---------- Helpers ----------
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
                    ]}}},
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
                    ]}}},
                    # include user_id so we can join to courses
                    {"$project": {"_id": 0, "user_id": 1, "first_name": 1, "last_name": 1, "status": 1, "email": 1}}
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

    # ----- SCHEDULE -----
    if action == "schedule":
        if not facultyId:
            raise HTTPException(status_code=400, detail="facultyId is required.")
        if not termId:
            active = await _active_term()
            termId = active.get("term_id")
            if not termId:
                raise HTTPException(status_code=503, detail="No active term configured.")

        items = [x async for x in db[COL_SECTIONS].aggregate([
            {"$match": {"term_id": termId, "faculty_id": facultyId}},
            {"$project": {
                "_id": 0,
                "course_code": 1,
                "section": 1,
                "campus": 1,
                "room": 1,
                "day": 1,
                "time": {"$concat": ["$start_time", "–", "$end_time"]}
            }},
            {"$sort": {"day": 1, "course_code": 1, "section": 1}}
        ])]

        by_day: Dict[str, List[Dict[str, Any]]] = {}
        for it in items:
            by_day.setdefault(it["day"], []).append({
                "code": it["course_code"],
                "section": it["section"],
                "campus": it.get("campus", ""),
                "room": it.get("room", ""),
                "time": it["time"]
            })

        days = [{"day": d, "entries": by_day[d]}
                for d in sorted(by_day.keys(), key=lambda k: WEEKDAY_ORDER.index(k) if k in WEEKDAY_ORDER else 99)]
        return {"ok": True, "term_id": termId, "days": days}

    # ----- HISTORY -----
    if action == "history":
        if not facultyId:
            raise HTTPException(status_code=400, detail="facultyId is required.")
        if acadYearStart is None:
            latest = await db[COL_TERMS].find({}, {"_id": 0, "acad_year_start": 1}) \
                .sort([("acad_year_start", -1)]).limit(1).to_list(1)
            acadYearStart = latest[0]["acad_year_start"] if latest else None
            if acadYearStart is None:
                return {"ok": True, "acad_year_start": None, "terms": {}}

        terms = [t async for t in db[COL_TERMS]
                 .find({"acad_year_start": acadYearStart}, {"_id": 0, "term_id": 1, "term_number": 1})
                 .sort([("term_number", 1)])]
        term_ids = [t["term_id"] for t in terms]

        names = await db.list_collection_names()
        col = COL_ASSIGNMENTS if COL_ASSIGNMENTS in names else COL_SECTIONS

        rows = [r async for r in db[col].aggregate([
            {"$match": {"faculty_id": facultyId, "term_id": {"$in": term_ids}}},
            {"$project": {
                "_id": 0,
                "term_id": 1,
                "course_code": 1,
                "section": 1,
                "units": {"$ifNull": ["$units", 0]},
                "mode": {"$ifNull": ["$mode", ""]},
                "schedule_label": {"$ifNull": ["$schedule_label", ""]}
            }},
            {"$sort": {"course_code": 1, "section": 1}}
        ])]

        term_map = {t["term_id"]: f"Term {t['term_number']}" for t in terms}
        grouped: Dict[str, List[Dict[str, Any]]] = {}
        for r in rows:
            key = term_map.get(r["term_id"], "Term ?")
            grouped.setdefault(key, []).append({
                "code": r["course_code"],
                "section": r["section"],
                "units": r.get("units", 0),
                "mode": r.get("mode", ""),
                "schedule": r.get("schedule_label", "")
            })

        return {"ok": True, "acad_year_start": acadYearStart, "terms": grouped}

    raise HTTPException(status_code=400, detail="Invalid action parameter.")
