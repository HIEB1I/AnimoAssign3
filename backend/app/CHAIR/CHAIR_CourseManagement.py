# backend/app/CHAIR/CHAIR_CourseManagement.py
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Query, Body
from ..main import db

router = APIRouter(prefix="/chair", tags=["chair"])

COL_USERS = "users"
COL_DEPARTMENTS = "departments"
COL_USER_ROLES = "user_roles"
COL_ROLE_ASSIGN = "role_assignments"

COL_TERMS = "terms"
COL_PREEN_COUNT = "preenlistment_count"
COL_COURSES = "courses"
COL_KACS = "kacs"
COL_FACULTY = "faculty_profiles"
COL_FACULTY_ASG = "faculty_assignments"
COL_SECTIONS = "sections"


def _now():
    return datetime.utcnow()


async def _active_term() -> Dict[str, Any]:
    """
    Return the WORKING / PLANNING term for CHAIR modules.
    """
    # (a) Try to derive from an active pre-enlistment batch
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

    # (b) Fallback: "current" term
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
            {},
            {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
        ).sort([("acad_year_start", -1), ("term_number", -1)]).limit(1).to_list(1)
        current = last[0] if last else None

    # (c) No terms at all
    if not current:
        return {}

    # (d) Compute the "next" term after the current term
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
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
    ).sort([("acad_year_start", 1), ("term_number", 1)]).limit(1).to_list(1)

    if next_terms:
        return next_terms[0]

    return current


async def _user_scope(userId: Optional[str], userEmail: Optional[str]) -> Dict[str, Any]:
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
        {"$addFields": {
            "deptScope": {
                "$let": {
                    "vars": { "arr": {
                        "$filter": {
                            "input": {"$ifNull": ["$ra.scope", []]},
                            "as": "s",
                            "cond": {"$eq": ["$$s.type", "department"]}
                        }
                    }},
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

    # Fallback: check faculty profile if role assignment didn't yield a dept
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


# ---- helpers for edit ----
async def _find_user_ids_by_names(pairs: List[Dict[str, str]], prefer_dept_id: Optional[str]) -> List[Tuple[str, str]]:
    results: List[Tuple[str, str]] = []
    for p in pairs:
        fn = (p.get("first_name") or "").strip()
        ln = (p.get("last_name") or "").strip()
        if not fn and not ln:
            continue

        q: Dict[str, Any] = {}
        if fn:
            q["first_name"] = {"$regex": f"^{fn}$", "$options": "i"}
        if ln:
            q["last_name"] = {"$regex": f"^{ln}$", "$options": "i"}

        candidates = await db[COL_USERS].find(q, {"_id": 0, "user_id": 1, "email": 1}).to_list(50)
        if not candidates:
            # fuzzy fallback
            q2 = {
                "$or": [
                    {"first_name": {"$regex": f"^{fn}\\b", "$options": "i"}},
                    {"last_name": {"$regex": f"\\b{ln}$", "$options": "i"}},
                ]
            }
            candidates = await db[COL_USERS].find(q2, {"_id": 0, "user_id": 1, "email": 1}).to_list(50)

        if not candidates:
            continue

        if prefer_dept_id:
            uids = [c["user_id"] for c in candidates if c.get("user_id")]
            if uids:
                fps = await db[COL_FACULTY].find(
                    {"user_id": {"$in": uids}, "department_id": prefer_dept_id},
                    {"_id": 0, "user_id": 1}
                ).to_list(50)
                preferred_uids = {x["user_id"] for x in fps}
                preferred = [c for c in candidates if c["user_id"] in preferred_uids]
                if preferred:
                    uid = preferred[0]["user_id"]; email = preferred[0].get("email") or ""
                    results.append((uid, email))
                    continue

        uid = candidates[0]["user_id"]; email = candidates[0].get("email") or ""
        results.append((uid, email))
    return results


async def _user_ids_to_faculty_ids(user_ids: List[str]) -> List[str]:
    if not user_ids:
        return []
    fps = await db[COL_FACULTY].find(
        {"user_id": {"$in": user_ids}},
        {"_id": 0, "faculty_id": 1}
    ).to_list(200)
    return [x["faculty_id"] for x in fps if x.get("faculty_id")]


@router.post("/course-management")
async def course_management(
    action: str = Query("list", description="header | options | list | editPeople"),
    userEmail: Optional[str] = Query(None),
    userId: Optional[str] = Query(None),
    cluster: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    courseId: Optional[str] = Query(None),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    try:
        if action not in {"header", "options", "list", "editPeople"}:
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

        if action in {"options", "list", "editPeople"} and not meta.get("dept_id"):
            raise HTTPException(status_code=400, detail="User department not found.")

        # ----- OPTIONS -----
        if action == "options":
            dept_id = meta["dept_id"]
            clusters = [k.get("kac_name") for k in await db[COL_KACS]
                        .find({"department_id": dept_id}, {"_id": 0, "kac_name": 1})
                        .sort([("kac_name", 1)]).to_list(500)]
            clusters = [c for c in clusters if c]
            return {"ok": True, "clusters": clusters, "activeTerm": await _active_term()}

        # ----- EDIT PEOPLE (Manual Override) -----
        if action == "editPeople":
            if not courseId:
                raise HTTPException(status_code=400, detail="Missing courseId.")
            dept_id = meta["dept_id"]

            course = await db[COL_COURSES].find_one(
                {"course_id": courseId, "department_id": dept_id},
                {"_id": 0, "course_id": 1, "department_id": 1, "course_title": 1}
            )
            if not course:
                raise HTTPException(status_code=404, detail="Course not found for department.")

            p = payload or {}
            coord_pairs = p.get("coordinators") or []
            team_pairs = p.get("teaching_team") or []

            coord_resolved = await _find_user_ids_by_names(coord_pairs, dept_id)
            coord_user_ids = [u for (u, _email) in coord_resolved]
            coord_emails = {u: e for (u, e) in coord_resolved}

            team_user_ids = [u for (u, _e) in await _find_user_ids_by_names(team_pairs, dept_id)]
            team_faculty_ids = await _user_ids_to_faculty_ids(team_user_ids)

            update_doc: Dict[str, Any] = {}
            update_doc["course_coordinator"] = coord_user_ids
            update_doc["teaching_team"] = team_faculty_ids

            result = await db[COL_COURSES].update_one(
                {"course_id": courseId},
                {"$set": update_doc, "$setOnInsert": {"updated_at": _now()}}
            )
            if result.matched_count == 0:
                raise HTTPException(status_code=404, detail="Course not found.")

            coord_users = []
            if coord_user_ids:
                cu = await db[COL_USERS].find(
                    {"user_id": {"$in": coord_user_ids}},
                    {"_id": 0, "first_name": 1, "last_name": 1, "email": 1}
                ).to_list(100)
                for u in cu:
                    name = f"{(u.get('first_name') or '').strip()} {(u.get('last_name') or '').strip()}".strip()
                    coord_users.append({"name": name, "email": (u.get("email") or coord_emails.get(u.get("user_id",""), ""))})

            team_display = []
            if team_faculty_ids:
                fps = await db[COL_FACULTY].find(
                    {"faculty_id": {"$in": team_faculty_ids}},
                    {"_id": 0, "user_id": 1}
                ).to_list(200)
                uids = [f.get("user_id") for f in fps if f.get("user_id")]
                if uids:
                    us = await db[COL_USERS].find(
                        {"user_id": {"$in": uids}},
                        {"_id": 0, "first_name": 1, "last_name": 1}
                    ).to_list(200)
                    for u in us:
                        name = f"{(u.get('first_name') or '').strip()} {(u.get('last_name') or '').strip()}".strip()
                        team_display.append({"name": name})

            return {
                "ok": True,
                "updated": int(result.modified_count),
                "coordinators": coord_users,
                "teaching_team": team_display,
            }

        # ----- LIST -----
        term = await _active_term()
        dept_id = meta["dept_id"]

        pipeline: List[Dict[str, Any]] = [
            {"$match": {"department_id": dept_id}},

            # Normalize course_code
            {"$addFields": {
                "code_list": {
                    "$cond": [
                        {"$isArray": "$course_code"},
                        "$course_code",
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
                                               "$$this"]}
                        }},
                        ""
                    ]
                }
            }},

            # Coordinators
            {"$addFields": {
                "coord_ids": {
                    "$cond": [
                        {"$isArray": "$course_coordinator"},
                        {"$ifNull": ["$course_coordinator", []]},
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
                "coordinator_email": {"$ifNull": [{"$first": "$coord_users.email"}, ""]},
                "coordinator_name": {
                    "$reduce": {
                        "input": {"$map": {"input": {"$ifNull": ["$coord_users", []]}, "as": "c", "in": "$$c.name"}},
                        "initialValue": "",
                        "in": {"$concat": ["$$value", {"$cond": [{"$eq": ["$$value", ""]}, "", "; "]}, "$$this"]}
                    }
                }
            }},

            # -------------------------------------------------------------------------
            # TEACHING COMPOSITION LOGIC
            #
            # Requirement (mirror OM):
            #   Only show faculty who have a past teaching history for the specific course.
            #
            # Notes:
            #   - We still compute KACs for cluster filtering and label display.
            #   - We do NOT include KAC-qualified faculty who have never taught the course.
            # -------------------------------------------------------------------------

            # 1. Identify KACs for this course (for cluster filtering / label display)
            {"$lookup": {
                "from": COL_KACS,
                "let": {"cid": "$course_id", "deptId": dept_id},
                "pipeline": [
                    {"$match": {"$expr": {"$and": [
                        {"$in": ["$$cid", {"$ifNull": ["$course_list", []]}]},
                        {"$eq": ["$department_id", "$$deptId"]}
                    ]}}},
                    {"$project": {"_id": 0, "kac_id": 1, "kac_name": 1}}
                ],
                "as": "_kac_data"
            }},
            {"$addFields": {
                "kac_names": {"$map": {"input": "$_kac_data", "as": "k", "in": "$$k.kac_name"}},
                "kac_ids":   {"$map": {"input": "$_kac_data", "as": "k", "in": "$$k.kac_id"}}
            }},

            # 2. Find Faculty via History (Past Assignments for this course)
            {"$lookup": {
                "from": COL_SECTIONS,
                "let": {"cid": "$course_id", "codes": "$code_list"},
                "pipeline": [
                    {"$match": {"$expr": {"$or": [
                        {"$eq": ["$course_id", "$$cid"]},
                        {"$in": ["$course_code", {"$ifNull": ["$$codes", []]}]}
                    ]}}},
                    {"$project": {"_id": 0, "section_id": 1}}
                ],
                "as": "_hist_secs"
            }},
            {"$lookup": {
                "from": COL_FACULTY_ASG,
                "let": {"sids": {"$map": {"input": "$_hist_secs", "as": "s", "in": "$$s.section_id"}}},
                "pipeline": [
                    {"$match": {"$expr": {"$in": ["$section_id", "$$sids"]}}},
                    {"$project": {"_id": 0, "faculty_id": 1}}
                ],
                "as": "_fac_via_hist"
            }},

            # 3. Unique Faculty IDs from history
            {"$addFields": {
                "_all_qual_fids": {
                    "$setUnion": [
                        {"$map": {"input": "$_fac_via_hist", "as": "f", "in": "$$f.faculty_id"}}
                    ]
                }
            }},

            # 5. Resolve Names
            {"$lookup": {
                "from": COL_FACULTY,
                "let": {"fids": "$_all_qual_fids"},
                "pipeline": [
                    {"$match": {"$expr": {"$in": ["$faculty_id", "$$fids"]}}},
                    {"$project": {"_id": 0, "user_id": 1}}
                ],
                "as": "_qual_fps"
            }},
            {"$lookup": {
                "from": COL_USERS,
                "let": {"uids": {"$map": {"input": "$_qual_fps", "as": "fp", "in": "$$fp.user_id"}}},
                "pipeline": [
                    {"$match": {"$expr": {"$in": ["$user_id", "$$uids"]}}},
                    {"$project": {"_id": 0, "first_name": 1, "last_name": 1}},
                    {"$sort": {"last_name": 1, "first_name": 1}}
                ],
                "as": "_qual_users"
            }},

            # 6. Format Composition
            {"$addFields": {
                "composition": {
                    "$map": {
                        "input": "$_qual_users",
                        "as": "u",
                        "in": {"$trim": {"input": {"$concat": [
                            {"$ifNull": ["$$u.first_name", ""]}, " ",
                            {"$ifNull": ["$$u.last_name",  ""]}
                        ]}}}
                    }
                }
            }},

            # -------------------------------------------------------------------------
            # END TEACHING COMPOSITION LOGIC
            # -------------------------------------------------------------------------

            # Kac Label & Syllabus
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
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"CHAIR course-management failed: {e}")