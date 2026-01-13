from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
import hashlib

from fastapi import APIRouter, Body, HTTPException, Query
from pymongo import ASCENDING

from ..main import db

router = APIRouter(prefix="/om", tags=["om"])

# ---------------- collections ----------------
COL_SPECIAL = "special_class"
COL_TERMS = "terms"
COL_USERS = "users"
COL_PROGRAMS = "programs"
COL_DEPARTMENTS = "departments"
COL_COURSES = "courses"
COL_SECTIONS = "sections"
COL_SECTION_SCHEDULES = "section_schedules"
COL_FAC_ASSIGN = "faculty_assignments"
COL_FAC_PROFILES = "faculty_profiles"
COL_PREEN_COUNT = "preenlistment_count"

COL_USER_ROLES = "user_roles"
COL_ROLE_ASSIGN = "role_assignments"

DEFAULT_STATUSES = ["Submitted", "Under Review", "Approved", "Rejected"]

# ---------------- indexes (safe) ----------------
try:
    db[COL_SPECIAL].create_index([("term_id", ASCENDING)])
    db[COL_SPECIAL].create_index([("course_id", ASCENDING)])
    db[COL_SPECIAL].create_index([("department_id", ASCENDING)])
    db[COL_SPECIAL].create_index([("status", ASCENDING)])
    db[COL_SPECIAL].create_index([("submitted_at", ASCENDING)])
    db[COL_SPECIAL].create_index([("special_id", ASCENDING)], unique=True)
except Exception:
    pass

# ---------------- constants/helpers ----------------
DAY_ORDER = {"M": 1, "T": 2, "W": 3, "H": 4, "F": 5, "S": 6, "U": 7}
ALLOWED_DAYS = {"M", "T", "W", "H", "F", "S"}


def _hash_key(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:14]


def _normalize_day(d: Any) -> str:
    if d is None:
        return ""
    s = str(d).strip().upper()
    if not s:
        return ""
    if s in {"M", "T", "W", "H", "F", "S"}:
        return s

    if s in {"TH", "THU", "THUR", "THURS", "THURSDAY"}:
        return "H"
    if s in {"MO", "MON", "MONDAY"}:
        return "M"
    if s in {"TU", "TUE", "TUES", "TUESDAY"}:
        return "T"
    if s in {"WE", "WED", "WEDNESDAY"}:
        return "W"
    if s in {"FR", "FRI", "FRIDAY"}:
        return "F"
    if s in {"SA", "SAT", "SATURDAY"}:
        return "S"

    if "MON" in s:
        return "M"
    if "TUE" in s:
        return "T"
    if "WED" in s:
        return "W"
    if "THU" in s or "THR" in s:
        return "H"
    if "FRI" in s:
        return "F"
    if "SAT" in s:
        return "S"

    return ""


def _to_hhmm(t: Any) -> str:
    if t is None:
        return ""
    s = str(t).strip()
    if not s:
        return ""
    s = s.replace(":", "").replace(" ", "")
    if not s.isdigit():
        return ""
    if len(s) == 3:
        s = "0" + s
    if len(s) != 4:
        return ""
    return s


def _is_valid_hhmm(hhmm: str) -> bool:
    if not hhmm or len(hhmm) != 4 or (not hhmm.isdigit()):
        return False
    hh = int(hhmm[:2])
    mm = int(hhmm[2:])
    return 0 <= hh <= 23 and 0 <= mm <= 59


def _mins(hhmm: str) -> int:
    return int(hhmm[:2]) * 60 + int(hhmm[2:])


def _validate_day_fields(payload: Dict[str, Any]) -> Dict[str, str]:
    day1 = _normalize_day(payload.get("day1"))
    begin1 = _to_hhmm(payload.get("begin1"))
    end1 = _to_hhmm(payload.get("end1"))

    day2 = _normalize_day(payload.get("day2"))
    begin2 = _to_hhmm(payload.get("begin2"))
    end2 = _to_hhmm(payload.get("end2"))

    if any([day1, begin1, end1]):
        if day1 not in ALLOWED_DAYS:
            raise HTTPException(status_code=400, detail="day1 must be one of M,T,W,H,F,S.")
        if not (_is_valid_hhmm(begin1) and _is_valid_hhmm(end1)):
            raise HTTPException(status_code=400, detail="begin1/end1 must be valid HHMM.")
        if _mins(end1) <= _mins(begin1):
            raise HTTPException(status_code=400, detail="end1 must be greater than begin1.")

    if any([day2, begin2, end2]):
        if day2 not in ALLOWED_DAYS:
            raise HTTPException(status_code=400, detail="day2 must be one of M,T,W,H,F,S.")
        if not (_is_valid_hhmm(begin2) and _is_valid_hhmm(end2)):
            raise HTTPException(status_code=400, detail="begin2/end2 must be valid HHMM.")
        if _mins(end2) <= _mins(begin2):
            raise HTTPException(status_code=400, detail="end2 must be greater than begin2.")

    return {
        "day1": day1,
        "begin1": begin1,
        "end1": end1,
        "day2": day2,
        "begin2": begin2,
        "end2": end2,
    }


def _course_code_expr():
    return {
        "$cond": [
            {"$isArray": "$course.course_code"},
            {"$ifNull": [{"$arrayElemAt": ["$course.course_code", 0]}, ""]},
            {"$ifNull": ["$course.course_code", ""]},
        ]
    }


async def _active_term() -> Dict[str, Any]:
    pre = await db[COL_PREEN_COUNT].find_one(
        {"is_archived": {"$ne": True}},
        {"_id": 0, "term_id": 1},
    )
    if pre and pre.get("term_id"):
        t = await db[COL_TERMS].find_one(
            {"term_id": pre["term_id"]},
            {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
        )
        if t:
            return t

    current = await db[COL_TERMS].find_one(
        {"$or": [{"status": "active"}, {"is_current": True}]},
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
    )

    if not current:
        last = (
            await db[COL_TERMS]
            .find({}, {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1})
            .sort([("acad_year_start", -1), ("term_number", -1)])
            .limit(1)
            .to_list(1)
        )
        return last[0] if last else {}

    next_terms = (
        await db[COL_TERMS]
        .find(
            {
                "$or": [
                    {"acad_year_start": {"$gt": current["acad_year_start"]}},
                    {
                        "acad_year_start": current["acad_year_start"],
                        "term_number": {"$gt": current["term_number"]},
                    },
                ]
            },
            {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
        )
        .sort([("acad_year_start", 1), ("term_number", 1)])
        .limit(1)
        .to_list(1)
    )
    return next_terms[0] if next_terms else current


async def _get_allowed_statuses() -> List[str]:
    cfg = await db[COL_SPECIAL].find_one(
        {"_id": "config", "doc_type": {"$in": ["config", "Config"]}},
        {"_id": 0, "statuses": 1},
    )
    statuses = (cfg or {}).get("statuses") or []
    return statuses if statuses else DEFAULT_STATUSES


async def _faculty_name_from_id(faculty_id: Optional[str]) -> str:
    if not faculty_id:
        return "UNASSIGNED"
    prof = await db[COL_FAC_PROFILES].find_one(
        {"faculty_id": faculty_id},
        {"_id": 0, "user_id": 1},
    )
    if not prof or not prof.get("user_id"):
        return "UNASSIGNED"
    u = await db[COL_USERS].find_one(
        {"$or": [{"user_id": prof["user_id"]}, {"userId": prof["user_id"]}]},
        {"_id": 0, "first_name": 1, "last_name": 1, "firstName": 1, "lastName": 1},
    )
    if not u:
        return "UNASSIGNED"
    fn = (u.get("first_name") or u.get("firstName") or "").strip()
    ln = (u.get("last_name") or u.get("lastName") or "").strip()
    name = f"{ln}, {fn}".strip().strip(",")
    return name.upper() if name else "UNASSIGNED"


async def _latest_faculty_for_section(section_id: str) -> Optional[str]:
    cur = (
        db[COL_FAC_ASSIGN]
        .find({"section_id": section_id, "is_archived": {"$ne": True}}, {"_id": 0, "faculty_id": 1})
        .sort([("created_at", -1)])
        .limit(1)
    )
    rows = await cur.to_list(1)
    if not rows:
        return None
    fid = (rows[0] or {}).get("faculty_id")
    return fid if fid else None


async def _day_fields_from_section(section_id: str) -> Dict[str, str]:
    cur = db[COL_SECTION_SCHEDULES].find(
        {"section_id": section_id},
        {"_id": 0, "day": 1, "start_time": 1, "end_time": 1},
    )
    rows = await cur.to_list(50)

    entries: List[Tuple[str, str, str]] = []
    for r in rows:
        d = _normalize_day(r.get("day"))
        if d not in ALLOWED_DAYS:
            continue
        st = _to_hhmm(r.get("start_time"))
        et = _to_hhmm(r.get("end_time"))
        if not (_is_valid_hhmm(st) and _is_valid_hhmm(et)):
            continue
        if _mins(et) <= _mins(st):
            continue
        entries.append((d, st, et))

    entries.sort(key=lambda x: (DAY_ORDER.get(x[0], 99), x[1]))
    entries = entries[:2]

    out = {"day1": "", "begin1": "", "end1": "", "day2": "", "begin2": "", "end2": ""}
    if len(entries) >= 1:
        out["day1"], out["begin1"], out["end1"] = entries[0]
    if len(entries) >= 2:
        out["day2"], out["begin2"], out["end2"] = entries[1]
    return out


def _label_from_day_fields(df: Dict[str, str]) -> str:
    parts: List[str] = []
    if df.get("day1") and df.get("begin1") and df.get("end1"):
        parts.append(f"{df['day1']} {df['begin1']}-{df['end1']}")
    if df.get("day2") and df.get("begin2") and df.get("end2"):
        parts.append(f"{df['day2']} {df['begin2']}-{df['end2']}")
    return "; ".join(parts)


async def _build_faculty_options() -> List[Dict[str, Any]]:
    profs = await db[COL_FAC_PROFILES].find(
        {},
        {"_id": 0, "faculty_id": 1, "user_id": 1, "department_id": 1},
    ).to_list(10000)

    uids = [p.get("user_id") for p in profs if p.get("user_id")]
    users = await db[COL_USERS].find(
        {"$or": [{"user_id": {"$in": uids}}, {"userId": {"$in": uids}}]},
        {"_id": 0, "user_id": 1, "userId": 1, "first_name": 1, "last_name": 1, "firstName": 1, "lastName": 1},
    ).to_list(10000)

    umap: Dict[str, Dict[str, Any]] = {}
    for u in users:
        key = u.get("user_id") or u.get("userId")
        if key:
            umap[key] = u

    out: List[Dict[str, Any]] = []
    for p in profs:
        fid = (p.get("faculty_id") or "").strip()
        if not fid:
            continue
        u = umap.get(p.get("user_id") or "", {})
        fn = (u.get("first_name") or u.get("firstName") or "").strip()
        ln = (u.get("last_name") or u.get("lastName") or "").strip()
        nm = f"{ln}, {fn}".strip().strip(",").upper()
        out.append({"faculty_id": fid, "faculty_name": nm or "UNASSIGNED", "department_id": p.get("department_id")})

    out.sort(key=lambda x: x.get("faculty_name") or "")
    return out


async def _schedule_presets(term_id: str, course_id: str) -> List[Dict[str, Any]]:
    secs = await db[COL_SECTIONS].find(
        {"term_id": term_id, "course_id": course_id},
        {"_id": 0, "section_id": 1, "section_code": 1},
    ).sort("section_code", ASCENDING).to_list(5000)

    out: List[Dict[str, Any]] = []
    for s in secs:
        sid = s.get("section_id")
        if not sid:
            continue

        df = await _day_fields_from_section(sid)
        label = _label_from_day_fields(df) or "TBA"

        fac_id = await _latest_faculty_for_section(sid)
        fac_name = await _faculty_name_from_id(fac_id)

        out.append(
            {
                "schedule_id": sid,
                "section_id": sid,
                "section_code": s.get("section_code") or "",
                "label": label,
                "faculty_id": fac_id,
                "faculty_name": fac_name,
                **df,
            }
        )

    out.sort(key=lambda x: (x.get("label") or "", x.get("section_code") or ""))
    return out


# ---------------- routes (GET) ----------------
@router.get("/specialclass")
async def om_specialclass_get(
    action: str = Query("options", description="options | schedulePresets"),
    term_id: Optional[str] = Query(None),
    course_id: Optional[str] = Query(None),
):
    if action == "options":
        active = await _active_term()
        statuses = await _get_allowed_statuses()
        faculty = await _build_faculty_options()
        return {
            "ok": True,
            "statuses": statuses,
            "activeTerm": {
                "term_id": active.get("term_id", ""),
                "acad_year_start": active.get("acad_year_start"),
                "term_number": active.get("term_number"),
            },
            "facultyOptions": faculty,
        }

    if action == "schedulePresets":
        if not term_id:
            active = await _active_term()
            term_id = active.get("term_id")
        if not term_id or not course_id:
            return {"ok": True, "presets": []}

        presets = await _schedule_presets(term_id, course_id)
        return {"ok": True, "presets": presets}

    raise HTTPException(status_code=400, detail="Unsupported action")


# ---------------- routes (POST) ----------------
@router.post("/specialclass")
async def om_specialclass_post(
    action: str = Query("list", description="list | update | bulkUpdate"),
    status: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    termId: Optional[str] = Query(None),
    specialId: Optional[str] = Query(None),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    active = await _active_term()
    current_term_id = termId or active.get("term_id")
    if action in {"list", "update", "bulkUpdate"} and not current_term_id:
        raise HTTPException(status_code=503, detail="No active term configured.")

    if action == "list":
        match: Dict[str, Any] = {"term_id": current_term_id, "special_id": {"$exists": True}}
        if status and status.strip() and status.strip() != "All Status":
            match["status"] = status.strip()

        # Faculty role IDs (fail closed)
        role_docs = await db[COL_USER_ROLES].find(
            {"role_type": {"$regex": "^faculty$", "$options": "i"}},
            {"_id": 0, "role_id": 1},
        ).to_list(50)
        faculty_role_ids = [d.get("role_id") for d in role_docs if d.get("role_id")]
        if not faculty_role_ids:
            faculty_role_ids = ["__NO_FACULTY_ROLE__"]

        pipeline: List[Dict[str, Any]] = [
            {"$match": match},
            {"$addFields": {
                "_uid": {"$ifNull": ["$user_id", "$userId"]},
                "_pid": {"$ifNull": ["$program_id", "$programId"]},
                "_did": {"$ifNull": ["$department_id", "$departmentId"]},
                "_cid": {"$ifNull": ["$course_id", "$courseId"]},
                "_fid": {"$ifNull": ["$faculty_id", "$facultyId"]},
            }},

            # student user
            {"$lookup": {
                "from": COL_USERS,
                "let": {"uid": "$_uid"},
                "pipeline": [
                    {"$match": {"$expr": {"$and": [
                        {"$ne": ["$$uid", None]},
                        {"$ne": ["$$uid", ""]},
                        {"$or": [
                            {"$eq": ["$user_id", "$$uid"]},
                            {"$eq": ["$userId", "$$uid"]},
                        ]},
                    ]}}},
                    {"$project": {"_id": 0, "first_name": 1, "last_name": 1, "firstName": 1, "lastName": 1}},
                    {"$limit": 1},
                ],
                "as": "stu",
            }},
            {"$unwind": {"path": "$stu", "preserveNullAndEmptyArrays": True}},

            # program
            {"$lookup": {
                "from": COL_PROGRAMS,
                "let": {"pid": "$_pid"},
                "pipeline": [
                    {"$match": {"$expr": {"$and": [
                        {"$ne": ["$$pid", None]},
                        {"$ne": ["$$pid", ""]},
                        {"$eq": ["$program_id", "$$pid"]},
                    ]}}},
                    {"$project": {"_id": 0, "program_id": 1, "program_code": 1}},
                    {"$limit": 1},
                ],
                "as": "prog",
            }},
            {"$unwind": {"path": "$prog", "preserveNullAndEmptyArrays": True}},

            # department
            {"$lookup": {
                "from": COL_DEPARTMENTS,
                "let": {"did": "$_did"},
                "pipeline": [
                    {"$match": {"$expr": {"$and": [
                        {"$ne": ["$$did", None]},
                        {"$ne": ["$$did", ""]},
                        {"$eq": ["$department_id", "$$did"]},
                    ]}}},
                    {"$project": {"_id": 0, "department_id": 1, "department_name": 1, "dept_name": 1}},
                    {"$limit": 1},
                ],
                "as": "dept",
            }},
            {"$unwind": {"path": "$dept", "preserveNullAndEmptyArrays": True}},

            # course
            {"$lookup": {
                "from": COL_COURSES,
                "let": {"cid": "$_cid"},
                "pipeline": [
                    {"$match": {"$expr": {"$and": [
                        {"$ne": ["$$cid", None]},
                        {"$ne": ["$$cid", ""]},
                        {"$eq": ["$course_id", "$$cid"]},
                    ]}}},
                    {"$project": {"_id": 0, "course_id": 1, "course_code": 1, "course_title": 1}},
                    {"$limit": 1},
                ],
                "as": "course",
            }},
            {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},

            # faculty_profiles (guarded)
            {"$lookup": {
                "from": COL_FAC_PROFILES,
                "let": {"fid": "$_fid"},
                "pipeline": [
                    {"$match": {"$expr": {"$and": [
                        {"$ne": ["$$fid", None]},
                        {"$ne": ["$$fid", ""]},
                        {"$eq": ["$faculty_id", "$$fid"]},
                    ]}}},
                    {"$project": {"_id": 0, "user_id": 1}},
                    {"$limit": 1},
                ],
                "as": "facp",
            }},
            {"$unwind": {"path": "$facp", "preserveNullAndEmptyArrays": True}},

            # faculty must have Faculty role (guarded)
            {"$lookup": {
                "from": COL_ROLE_ASSIGN,
                "let": {"uid": "$facp.user_id"},
                "pipeline": [
                    {"$match": {"$expr": {"$and": [
                        {"$ne": ["$$uid", None]},
                        {"$ne": ["$$uid", ""]},
                        {"$eq": ["$user_id", "$$uid"]},
                        {"$in": ["$role_id", faculty_role_ids]},
                    ]}}},
                    {"$limit": 1},
                ],
                "as": "facRole",
            }},

            # faculty user lookup (only used if facRole exists)
            {"$lookup": {
                "from": COL_USERS,
                "let": {"uid": "$facp.user_id"},
                "pipeline": [
                    {"$match": {"$expr": {"$and": [
                        {"$ne": ["$$uid", None]},
                        {"$ne": ["$$uid", ""]},
                        {"$or": [
                            {"$eq": ["$user_id", "$$uid"]},
                            {"$eq": ["$userId", "$$uid"]},
                        ]},
                    ]}}},
                    {"$project": {"_id": 0, "first_name": 1, "last_name": 1, "firstName": 1, "lastName": 1}},
                    {"$limit": 1},
                ],
                "as": "facu",
            }},
            {"$unwind": {"path": "$facu", "preserveNullAndEmptyArrays": True}},

            {"$addFields": {
                "student_name": {
                    "$let": {
                        "vars": {
                            "fn": {"$ifNull": ["$stu.first_name", {"$ifNull": ["$stu.firstName", ""]}]},
                            "ln": {"$ifNull": ["$stu.last_name", {"$ifNull": ["$stu.lastName", ""]}]},
                        },
                        "in": {
                            "$toUpper": {
                                "$trim": {
                                    "input": {
                                        "$concat": [
                                            {"$ifNull": ["$$ln", ""]},
                                            {"$cond": [
                                                {"$and": [
                                                    {"$gt": [{"$strLenCP": {"$ifNull": ["$$ln", ""]}}, 0]},
                                                    {"$gt": [{"$strLenCP": {"$ifNull": ["$$fn", ""]}}, 0]},
                                                ]},
                                                ", ",
                                                ""
                                            ]},
                                            {"$ifNull": ["$$fn", ""]},
                                        ]
                                    }
                                }
                            }
                        }
                    }
                },

                "program_code": {"$ifNull": ["$prog.program_code", ""]},
                "course_code": _course_code_expr(),
                "course_title": {"$ifNull": ["$course.course_title", ""]},
                "course_department": {"$ifNull": ["$dept.department_name", {"$ifNull": ["$dept.dept_name", ""]}]},

                # Schedule gate: do NOT display faculty unless schedule exists
                "_has_schedule": {
                    "$or": [
                        {"$and": [
                            {"$ne": [{"$ifNull": ["$section_id", ""]}, ""]},
                            {"$ne": [{"$ifNull": ["$section_id", None]}, None]},
                        ]},
                        {"$and": [
                            {"$ne": [{"$ifNull": ["$day1", ""]}, ""]},
                            {"$ne": [{"$ifNull": ["$begin1", ""]}, ""]},
                            {"$ne": [{"$ifNull": ["$end1", ""]}, ""]},
                        ]},
                        {"$and": [
                            {"$ne": [{"$ifNull": ["$day2", ""]}, ""]},
                            {"$ne": [{"$ifNull": ["$begin2", ""]}, ""]},
                            {"$ne": [{"$ifNull": ["$end2", ""]}, ""]},
                        ]},
                    ]
                },

                # Effective faculty id requires: schedule exists + faculty_profile + Faculty role
                "_effective_fid": {
                    "$cond": [
                        {"$and": [
                            "$_has_schedule",
                            {"$ne": ["$_fid", None]},
                            {"$ne": ["$_fid", ""]},
                            {"$ne": ["$facp.user_id", None]},
                            {"$ne": ["$facp.user_id", ""]},
                            {"$gt": [{"$size": {"$ifNull": ["$facRole", []]}}, 0]},
                        ]},
                        "$_fid",
                        None
                    ]
                },

                "faculty_name": {
                    "$cond": [
                        {"$or": [
                            {"$eq": ["$_effective_fid", None]},
                            {"$eq": ["$_effective_fid", ""]},
                        ]},
                        "UNASSIGNED",
                        {
                            "$let": {
                                "vars": {
                                    "fn": {"$ifNull": ["$facu.first_name", {"$ifNull": ["$facu.firstName", ""]}]},
                                    "ln": {"$ifNull": ["$facu.last_name", {"$ifNull": ["$facu.lastName", ""]}]},
                                },
                                "in": {
                                    "$let": {
                                        "vars": {
                                            "full": {"$trim": {"input": {"$concat": [
                                                {"$ifNull": ["$$ln", ""]},
                                                {"$cond": [
                                                    {"$and": [
                                                        {"$gt": [{"$strLenCP": {"$ifNull": ["$$ln", ""]}}, 0]},
                                                        {"$gt": [{"$strLenCP": {"$ifNull": ["$$fn", ""]}}, 0]},
                                                    ]},
                                                    ", ",
                                                    ""
                                                ]},
                                                {"$ifNull": ["$$fn", ""]},
                                            ]}}}
                                        },
                                        "in": {
                                            "$cond": [
                                                {"$gt": [{"$strLenCP": "$$full"}, 0]},
                                                {"$toUpper": "$$full"},
                                                "UNASSIGNED"
                                            ]
                                        }
                                    }
                                }
                            }
                        }
                    ]
                },

                "day1": {"$ifNull": ["$day1", ""]},
                "begin1": {"$ifNull": ["$begin1", ""]},
                "end1": {"$ifNull": ["$end1", ""]},
                "day2": {"$ifNull": ["$day2", ""]},
                "begin2": {"$ifNull": ["$begin2", ""]},
                "end2": {"$ifNull": ["$end2", ""]},
            }},
        ]

        if q and q.strip():
            s = q.strip()
            pipeline.append({"$match": {
                "$or": [
                    {"student_name": {"$regex": s, "$options": "i"}},
                    {"course_code": {"$regex": s, "$options": "i"}},
                    {"course_title": {"$regex": s, "$options": "i"}},
                ]
            }})

        pipeline += [
            {"$group": {"_id": "$special_id", "doc": {"$first": "$$ROOT"}}},
            {"$replaceRoot": {"newRoot": "$doc"}},
            {"$project": {
                "_id": 0,
                "special_id": 1,
                "term_id": 1,
                "user_id": {"$ifNull": ["$_uid", "$user_id"]},

                "student_name": 1,
                "student_number": {"$ifNull": ["$student_number", ""]},

                "course_id": {"$ifNull": ["$_cid", "$course_id"]},
                "course_code": 1,
                "course_title": 1,
                "course_department": 1,

                "program_id": {"$ifNull": ["$_pid", "$program_id"]},
                "program_code": 1,

                "reason": 1,
                "reason_other": {"$ifNull": ["$reason_other", ""]},

                "status": 1,
                "remarks": {"$ifNull": ["$remarks", ""]},

                # return only effective faculty id
                "faculty_id": {"$ifNull": ["$_effective_fid", None]},
                "faculty_name": 1,

                "section_id": {"$ifNull": ["$section_id", None]},

                "day1": 1, "begin1": 1, "end1": 1,
                "day2": 1, "begin2": 1, "end2": 1,

                "submitted_at": 1,
            }},
            {"$sort": {"submitted_at": -1}},
        ]

        rows = [r async for r in db[COL_SPECIAL].aggregate(pipeline)]
        return {"ok": True, "rows": rows, "term_id": current_term_id}

    if action == "update":
        if not specialId:
            raise HTTPException(status_code=400, detail="specialId is required.")
        if payload is None:
            raise HTTPException(status_code=400, detail="payload is required.")

        updates: Dict[str, Any] = {}

        if "status" in payload:
            allowed = set(await _get_allowed_statuses())
            st = (payload.get("status") or "").strip()
            if st and allowed and st not in allowed:
                raise HTTPException(status_code=400, detail="Invalid status value.")
            updates["status"] = st

        if "remarks" in payload:
            updates["remarks"] = payload.get("remarks") or ""

        # Only store faculty_id; never store faculty_name from UI
        if "faculty_id" in payload:
            fid = (payload.get("faculty_id") or "").strip()
            updates["faculty_id"] = fid if fid else None
            updates["faculty_name"] = ""  # prevent name leaks

        if "section_id" in payload:
            sid = (payload.get("section_id") or "").strip()
            updates["section_id"] = sid if sid else None

            if sid:
                if not any(k in payload for k in ["day1", "begin1", "end1", "day2", "begin2", "end2"]):
                    updates.update(await _day_fields_from_section(sid))

                if "faculty_id" not in payload:
                    dfid = await _latest_faculty_for_section(sid)
                    updates["faculty_id"] = dfid
                    updates["faculty_name"] = ""

        if any(k in payload for k in ["day1", "begin1", "end1", "day2", "begin2", "end2"]):
            updates.update(_validate_day_fields(payload))

        if not updates:
            return {"ok": False, "message": "Nothing to update."}

        updates["updated_at"] = datetime.utcnow()

        res = await db[COL_SPECIAL].update_one(
            {"term_id": current_term_id, "special_id": specialId},
            {"$set": updates},
        )
        return {"ok": True, "matched": res.matched_count, "modified": res.modified_count}

    if action == "bulkUpdate":
        if not payload or not isinstance(payload.get("special_ids"), list):
            raise HTTPException(status_code=400, detail="payload.special_ids must be an array.")
        target_status = (payload.get("status") or "").strip()
        if not target_status:
            raise HTTPException(status_code=400, detail="payload.status is required.")

        allowed = set(await _get_allowed_statuses())
        if allowed and target_status not in allowed:
            raise HTTPException(status_code=400, detail="Invalid status value.")

        res = await db[COL_SPECIAL].update_many(
            {"term_id": current_term_id, "special_id": {"$in": payload["special_ids"]}},
            {"$set": {"status": target_status, "updated_at": datetime.utcnow()}},
        )
        return {"ok": True, "matched": res.matched_count, "modified": res.modified_count, "status": target_status}

    raise HTTPException(status_code=400, detail="Invalid action parameter.")
