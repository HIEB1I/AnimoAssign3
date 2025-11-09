# backend/app/CHAIR/CHAIR_CourseManagement.py
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query, Body
from ..main import db

router = APIRouter(prefix="/chair", tags=["chair"])

COL_USERS = "users"
COL_DEPARTMENTS = "departments"
COL_USER_ROLES = "user_roles"
COL_ROLE_ASSIGN = "role_assignments"

COL_TERMS = "terms"
COL_COURSES = "courses"
COL_KACS = "kacs"
COL_FACULTY = "faculty_profiles"
COL_FACULTY_ASG = "faculty_assignments"
COL_SECTIONS = "sections"


def _now():
    return datetime.utcnow()


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


async def _user_scope(userId: Optional[str], userEmail: Optional[str]) -> Dict[str, Any]:
    """
    Resolve department scope for the user. Primary path = role_assignments.scope(type=department).
    Fallback path = faculty_profiles.department_id joined to departments.
    Uses only Mongo operators compatible with 4.4+ (no array-style $first).
    """
    if not userId and not userEmail:
        return {}

    match = {"user_id": userId} if userId else {"email": userEmail}
    pipe: List[Dict[str, Any]] = [
        {"$match": match},
        {"$project": {"_id": 0, "user_id": 1, "email": 1, "first_name": 1, "last_name": 1}},
        {"$lookup": {
            "from": COL_ROLE_ASSIGN,
            "localField": "user_id",
            "foreignField": "user_id",
            "as": "ra"
        }},
        {"$unwind": {"path": "$ra", "preserveNullAndEmptyArrays": True}},
        # deptScope = first element of filtered ra.scope where type == "department"
        {"$addFields": {
            "deptScope": {
                "$let": {
                    "vars": {
                        "arr": {
                            "$filter": {
                                "input": {"$ifNull": ["$ra.scope", []]},
                                "as": "s",
                                "cond": {"$eq": ["$$s.type", "department"]}
                            }
                        }
                    },
                    "in": {"$arrayElemAt": ["$$arr", 0]}
                }
            },
            "role_id_from_ra": {"$ifNull": ["$ra.role_id", None]}
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
            "dept_id": "$deptScope.id",
            "dept_name": {"$ifNull": ["$dept.department_name", "$dept.dept_name"]},
            "full_name": {
                "$trim": {"input": {"$concat": [
                    {"$ifNull": ["$first_name", ""]}, " ",
                    {"$ifNull": ["$last_name",  ""]}
                ]}}
            },
            "role_type": {"$ifNull": ["$role.role_type", ""]},
        }},
        {"$project": {"_id": 0, "user_id": 1, "dept_id": 1, "dept_name": 1, "full_name": 1, "role_type": 1}}
    ]
    head = [x async for x in db[COL_USERS].aggregate(pipe)]
    meta = head[0] if head else {}

    # Fallback: infer department from faculty_profiles if role scope not wired yet
    if meta and not meta.get("dept_id") and meta.get("user_id"):
        fp = await db[COL_FACULTY].find_one(
            {"user_id": meta["user_id"]},
            {"_id": 0, "department_id": 1}
        )
        if fp and fp.get("department_id"):
            d = await db[COL_DEPARTMENTS].find_one(
                {"department_id": fp["department_id"]},
                {"_id": 0, "department_name": 1, "dept_name": 1, "department_id": 1}
            )
            meta["dept_id"] = fp["department_id"]
            meta["dept_name"] = (d.get("department_name") or d.get("dept_name")) if d else None

    return meta


@router.post("/course-management")
async def course_management(
    action: str = Query("list", description="header | options | list"),
    userEmail: Optional[str] = Query(None),
    userId: Optional[str] = Query(None),
    cluster: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    try:
        if action not in {"header", "options", "list"}:
            raise HTTPException(status_code=400, detail="Invalid action.")

        meta = await _user_scope(userId, userEmail)

        # ----- HEADER -----
        if action == "header":
            if not meta:
                return {"ok": False}
            subtitle = meta.get("role_type") or ""
            if meta.get("dept_name"):
                subtitle = (subtitle + " | " + meta["dept_name"]).strip(" |")
            return {"ok": True, "profileName": meta.get("full_name", ""), "profileSubtitle": subtitle}

        # options/list require a department
        if action in {"options", "list"} and not meta.get("dept_id"):
            raise HTTPException(status_code=400, detail="User department not found.")

        # ----- OPTIONS -----
        if action == "options":
            dept_id = meta["dept_id"]
            clusters = [k.get("kac_name") for k in await db[COL_KACS]
                        .find({"department_id": dept_id}, {"_id": 0, "kac_name": 1})
                        .sort([("kac_name", 1)]).to_list(500)]
            clusters = [c for c in clusters if c]
            return {"ok": True, "clusters": clusters, "activeTerm": await _active_term()}

        # ----- LIST -----
        term = await _active_term()
        term_id = term.get("term_id", "")
        dept_id = meta["dept_id"]

        pipeline: List[Dict[str, Any]] = [
            {"$match": {"department_id": dept_id}},

            # Normalize course_code -> array + display
            {"$addFields": {
                "code_list": {
                    "$cond": [
                        {"$isArray": "$course_code"},
                        {"$ifNull": ["$course_code", []]},
                        {"$cond": [{"$ne": ["$course_code", None]}, ["$course_code"], []]}
                    ]
                }
            }},
            {"$addFields": {
                "code_display": {
                    "$cond": [
                        {"$gt": [{"$size": "$code_list"}, 0]},
                        {"$reduce": {
                            "input": "$code_list",
                            "initialValue": "",
                            "in": {"$concat": ["$$value",
                                               {"$cond": [{"$eq": ["$$value", ""]}, "", " / "]},
                                               {"$toString": "$$this"}]}
                        }},
                        ""
                    ]
                }
            }},

            # Coordinator IDs (support array or single)
            {"$addFields": {
                "coord_ids": {
                    "$cond": [
                        {"$isArray": "$course_coordinator"},
                        {"$filter": {
                            "input": {"$ifNull": ["$course_coordinator", []]},
                            "as": "tid",
                            "cond": {"$and": [{"$ne": ["$$tid", None]}, {"$ne": ["$$tid", ""]}]}
                        }},
                        {"$cond": [
                            {"$ne": [{"$type": "$course_coordinator"}, "missing"]},
                            [{"$ifNull": ["$course_coordinator", ""]}],
                            []
                        ]}
                    ]
                }
            }},
            {"$lookup": {
                "from": COL_USERS,
                "let": {"ids": "$coord_ids"},
                "pipeline": [
                    {"$match": {"$expr": {"$in": ["$user_id", {"$ifNull": ["$$ids", []]}]}}},
                    {"$project": {"_id": 0, "first_name": 1, "last_name": 1, "email": 1}},
                    {"$addFields": {"name": {
                        "$trim": {"input": {"$concat": [
                            {"$ifNull": ["$first_name", ""]}, " ",
                            {"$ifNull": ["$last_name",  ""]}
                        ]}}
                    }}},
                    {"$project": {"first_name": 0, "last_name": 0}}
                ],
                "as": "coord_users"
            }},
            {"$addFields": {
                "coordinators": {
                    "$map": {
                        "input": {"$ifNull": ["$coord_users", []]},
                        "as": "c",
                        "in": {"name": "$$c.name", "email": {"$ifNull": ["$$c.email", ""]}}
                    }
                },
                # MongoDB 4.4-safe: use arrayElemAt instead of array-style $first
                "coordinator_email": {"$ifNull": [{"$arrayElemAt": ["$coord_users.email", 0]}, ""]},
                "coordinator_name": {
                    "$reduce": {
                        "input": {"$map": {"input": {"$ifNull": ["$coord_users", []]}, "as": "c", "in": "$$c.name"}},
                        "initialValue": "",
                        "in": {"$concat": ["$$value", {"$cond": [{"$eq": ["$$value", ""]}, "", "; "]}, "$$this"]}
                    }
                }
            }},

            # sections → assignments → faculty names as fallback composition
            {"$lookup": {
                "from": COL_SECTIONS,
                "let": {"cid": "$course_id", "codes": "$code_list"},
                "pipeline": [
                    {"$match": {"$expr": {"$and": [
                        {"$eq": ["$term_id", term_id]},
                        {"$or": [
                            {"$eq": ["$course_id", "$$cid"]},
                            {"$in": ["$course_code", {"$ifNull": ["$$codes", []]}]}
                        ]}
                    ]}}},
                    {"$project": {"_id": 0, "section_id": 1}}
                ],
                "as": "_secs"
            }},
            {"$addFields": {"_sec_ids": {"$map": {"input": {"$ifNull": ["$_secs", []]}, "as": "s", "in": "$$s.section_id"}}}},
            {"$lookup": {
                "from": COL_FACULTY_ASG,
                "let": {"sids": "$_sec_ids"},
                "pipeline": [
                    {"$match": {"$expr": {"$in": ["$section_id", {"$ifNull": ["$$sids", []]}]}}},
                    {"$project": {"_id": 0, "faculty_id": 1}}
                ],
                "as": "_asg"
            }},
            {"$addFields": {
                "_fac_ids_from_sections": {
                    "$filter": {
                        "input": {"$map": {"input": {"$ifNull": ["$_asg", []]}, "as": "a", "in": "$$a.faculty_id"}},
                        "as": "id",
                        "cond": {"$and": [{"$ne": ["$$id", None]}, {"$ne": ["$$id", ""]}]}
                    }
                }
            }},
            {"$addFields": {
                "_fac_ids_all": {"$setUnion": [{"$ifNull": ["$teaching_team", []]}, {"$ifNull": ["$_fac_ids_from_sections", []]}]}
            }},
            {"$lookup": {
                "from": COL_FACULTY,
                "let": {"fids": "$_fac_ids_all"},
                "pipeline": [
                    {"$match": {"$expr": {"$in": ["$faculty_id", {"$ifNull": ["$$fids", []]}]}}},
                    {"$project": {"_id": 0, "faculty_id": 1, "user_id": 1}}
                ],
                "as": "_fp"
            }},
            {"$lookup": {
                "from": COL_USERS,
                "let": {"uids": {"$map": {"input": {"$ifNull": ["$_fp", []]}, "as": "f", "in": "$$f.user_id"}}},
                "pipeline": [
                    {"$match": {"$expr": {"$in": ["$user_id", {"$ifNull": ["$$uids", []]}]}}},
                    {"$project": {"_id": 0, "first_name": 1, "last_name": 1}}
                ],
                "as": "_fu"
            }},
            {"$addFields": {
                "composition": {
                    "$setUnion": [
                        {"$map": {
                            "input": {"$ifNull": ["$_fu", []]},
                            "as": "u",
                            "in": {"$trim": {"input": {"$concat": [
                                {"$ifNull": ["$$u.first_name", ""]}, " ",
                                {"$ifNull": ["$$u.last_name",  ""]}
                            ]}}}
                        }},
                        []
                    ]
                }
            }},

            # KAC mapping
            {"$lookup": {
                "from": COL_KACS,
                "let": {"cid": "$course_id", "deptId": dept_id},
                "pipeline": [
                    {"$match": {"$expr": {"$and": [
                        {"$in": ["$$cid", {"$ifNull": ["$course_list", []]}]},
                        {"$eq": ["$department_id", "$$deptId"]}
                    ]}}},
                    {"$project": {"_id": 0, "kac_name": 1}}
                ],
                "as": "_kacs"
            }},
            {"$addFields": {"kac_names": {"$map": {"input": {"$ifNull": ["$_kacs", []]}, "as": "k", "in": "$$k.kac_name"}}}},
            {"$addFields": {
                "kac_label": {
                    "$cond": [
                        {"$gt": [{"$size": "$kac_names"}, 0]},
                        {"$reduce": {
                            "input": "$kac_names",
                            "initialValue": "",
                            "in": {"$concat": ["$$value", {"$cond": [{"$eq": ["$$value", ""]}, "", " / "]}, "$$this"]}
                        }},
                        "—"
                    ]
                },
                "syllabus_display": {
                    "$cond": [
                        {"$or": [
                            {"$eq": [{"$type": "$syllabus"}, "missing"]},
                            {"$eq": ["$syllabus", None]},
                            {"$eq": [{"$toLower": {"$ifNull": ["$syllabus", ""]}}, "n/a"]},
                            {"$eq": ["$syllabus", ""]}
                        ]},
                        "",
                        "$syllabus"
                    ]
                }
            }}
        ]

        if cluster and cluster.strip() and cluster.strip().lower() != "all clusters":
            pipeline.append({"$match": {"kac_names": cluster.strip()}})

        if search and search.strip():
            s = search.strip()
            pipeline.append({"$match": {"$or": [
                {"code_display": {"$regex": s, "$options": "i"}},
                {"course_title": {"$regex": s, "$options": "i"}},
                {"coordinator_name": {"$regex": s, "$options": "i"}},
                {"kac_label": {"$regex": s, "$options": "i"}},
            ]}})

        pipeline.extend([
            {"$project": {
                "_id": 0,
                "course_id": 1,
                "kac": "$kac_label",
                "code": "$code_display",
                "title": "$course_title",
                "units": {"$ifNull": ["$units", ""]},
                "coordinator_name": 1,
                "coordinator_email": 1,
                "coordinators": 1,
                "composition": 1,
                "syllabus": "$syllabus_display",
            }},
            {"$sort": {"kac": 1, "code": 1}}
        ])

        rows = [r async for r in db[COL_COURSES].aggregate(pipeline)]
        return {"ok": True, "rows": rows, "term": term}

    except HTTPException:
        # re-throw HTTPExceptions as-is
        raise
    except Exception as e:
        # helpful error to surface the underlying problem instead of a generic 500
        raise HTTPException(status_code=400, detail=f"CHAIR course-management failed: {e}")
