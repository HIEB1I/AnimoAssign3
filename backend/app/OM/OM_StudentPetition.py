from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException, Query, Body
from ..main import db

router = APIRouter(prefix="/om", tags=["om"])

# --- collections ---
COL_PETITIONS = "student_petitions"
COL_TERMS = "terms"
COL_COURSES = "courses"
COL_DEPARTMENTS = "departments"
COL_USERS = "users"
COL_ROLE_ASSIGN = "role_assignments"
COL_USER_ROLES = "user_roles"


# --- helpers ---
async def _active_term() -> Dict[str, Any]:
    """Return the active term; fallback to latest AY/term_number."""
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


def _course_code_expr():
    # Normalize string | array to a single display code
    return {
        "$cond": [
            {"$isArray": "$course.course_code"},
            {"$ifNull": [{"$arrayElemAt": ["$course.course_code", 0]}, ""]},
            {"$ifNull": ["$course.course_code", ""]},
        ]
    }


# --- route ---
@router.post("/student-petition")
async def om_student_petitions_handler(
    action: str = Query("list", description="options | list | update | bulkForward | header"),
    status: Optional[str] = Query(None, description="Filter by last status (list)"),
    search: Optional[str] = Query(None, description="Search by course code/title (list)"),
    courseId: Optional[str] = Query(None, description="For single update"),
    termId: Optional[str] = Query(None, description="Override active term"),
    userEmail: Optional[str] = Query(None, description="Header: user email"),
    userId: Optional[str] = Query(None, description="Header: user id"),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    """
    Single endpoint for OM Student Petition:
      - header:     topbar profile name + subtitle (role | department)
      - options:    statuses + active term label
      - list:       groups petitions by course in active term (count + latest status/remarks)
      - update:     updates status/remarks for all petitions of a course in active term
      - bulkForward:set status for multiple course_ids in active term
    """

    # ---------- HEADER (Topbar identity) ----------
    if action == "header":
        if not userEmail and not userId:
            raise HTTPException(status_code=400, detail="userEmail or userId is required.")

        match: Dict[str, Any] = {"user_id": userId} if userId else {"email": userEmail}

        pipeline: List[Dict[str, Any]] = [
            {"$match": match},
            {"$project": {"_id": 0, "user_id": 1, "email": 1, "first_name": 1, "last_name": 1}},

            # Link role assignments (may be multiple; we just take the first)
            {"$lookup": {
                "from": COL_ROLE_ASSIGN,
                "let": {"uid": "$user_id"},
                "pipeline": [{"$match": {"$expr": {"$eq": ["$user_id", "$$uid"]}}}],
                "as": "ra_list"
            }},
            {"$unwind": {"path": "$ra_list", "preserveNullAndEmptyArrays": True}},

            # Compute department_id from scope[] (scope elements look like {type:"department", id:"DEPT0003"})
            {"$addFields": {
                "ra": "$ra_list",
                "department_id": {
                    "$let": {
                        "vars": {"sc": {"$ifNull": ["$ra_list.scope", []]}},
                        "in": {"$first": {
                            "$map": {
                                "input": {
                                    "$filter": {
                                        "input": "$$sc",
                                        "as": "s",
                                        "cond": {"$eq": ["$$s.type", "department"]}
                                    }
                                },
                                "as": "d",
                                "in": "$$d.id"
                            }
                        }}
                    }
                }
            }},

            # Join department using computed department_id
            {"$lookup": {
                "from": COL_DEPARTMENTS,
                "localField": "department_id",
                "foreignField": "department_id",
                "as": "dept"
            }},
            {"$unwind": {"path": "$dept", "preserveNullAndEmptyArrays": True}},

            # Resolve role_type through user_roles
            {"$lookup": {
                "from": COL_USER_ROLES,
                "localField": "ra.role_id",
                "foreignField": "role_id",
                "as": "role"
            }},
            {"$unwind": {"path": "$role", "preserveNullAndEmptyArrays": True}},

            {"$addFields": {
                "full_name": {
                    "$trim": {"input": {"$concat": [
                        {"$ifNull": ["$first_name", ""]}, " ", {"$ifNull": ["$last_name", ""]}
                    ]}}
                },
                "dept_name": {"$ifNull": ["$dept.department_name", "$dept.dept_name"]},
                "role_type": {"$ifNull": ["$role.role_type", ""]},
            }},

            {"$project": {
                "_id": 0,
                "email": 1,
                "department_id": 1,  # computed above
                "role_type": 1,
                "profileName": "$full_name",
                "profileSubtitle": {
                    "$trim": {"input": {"$concat": [
                        {"$ifNull": ["$role_type", ""]},
                        {"$cond": [{"$ifNull": ["$dept_name", False]}, " | ", ""]},
                        {"$ifNull": ["$dept_name", ""]},
                    ]}}
                }
            }},
            {"$limit": 1}
        ]

        docs = [d async for d in db[COL_USERS].aggregate(pipeline)]
        if not docs:
            return {"ok": False, "message": "User not found."}
        return {"ok": True, **docs[0]}

    # Everything else needs an active term
    active = await _active_term()
    current_term_id = termId or active.get("term_id")
    if not current_term_id and action in {"list", "update", "bulkForward"}:
        raise HTTPException(status_code=503, detail="No active term configured.")

    # ---------- OPTIONS ----------
    if action == "options":
        cfg = await db[COL_PETITIONS].find_one(
            {"_id": "config", "doc_type": {"$in": ["config", "Config"]}},
            {"_id": 0, "statuses": 1},
        )
        statuses = (cfg or {}).get("statuses") or []
        return {
            "ok": True,
            "statuses": statuses,
            "activeTerm": {
                "term_id": active.get("term_id", ""),
                "acad_year_start": active.get("acad_year_start"),
                "term_number": active.get("term_number"),
            },
        }

    # ---------- LIST (grouped by course) ----------
    if action == "list":
        pipeline: List[Dict[str, Any]] = [
            {"$match": {"term_id": current_term_id, "petition_id": {"$exists": True}}},
            {"$sort": {"submitted_at": 1}},  # ensure $last is latest
            {"$group": {
                "_id": "$course_id",
                "count": {"$sum": 1},
                "last_status": {"$last": "$status"},
                "last_remarks": {"$last": "$remarks"},
            }},
            {"$lookup": {
                "from": COL_COURSES,
                "localField": "_id",
                "foreignField": "course_id",
                "as": "course"
            }},
            {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},
            {"$addFields": {
                "course_code": _course_code_expr(),
                "course_title": {"$ifNull": ["$course.course_title", ""]},
            }},
        ]

        # client filters
        post: Dict[str, Any] = {}
        if status and status.strip().lower() != "all status":
            post["last_status"] = status.strip()
        if search and search.strip():
            s = search.strip()
            post["$or"] = [
                {"course_code": {"$regex": s, "$options": "i"}},
                {"course_title": {"$regex": s, "$options": "i"}},
            ]
        if post:
            pipeline.append({"$match": post})

        pipeline += [
            {"$project": {
                "_id": 0,
                "course_id": {"$ifNull": ["$_id", ""]},
                "course_code": 1,
                "course_title": 1,
                "count": 1,
                "status": "$last_status",
                "remarks": {"$ifNull": ["$last_remarks", ""]},
            }},
            {"$sort": {"course_code": 1}},
        ]

        rows = [r async for r in db[COL_PETITIONS].aggregate(pipeline)]
        return {"ok": True, "rows": rows, "term_id": current_term_id}

    # ---------- UPDATE (single course) ----------
    if action == "update":
        if not courseId:
            raise HTTPException(status_code=400, detail="courseId is required.")
        if not payload:
            raise HTTPException(status_code=400, detail="payload is required.")
        new_status = (payload.get("status") or "").strip()

        # Allow clearing remarks (""), only if key is present
        remarks_present = "remarks" in payload
        new_remarks = (payload.get("remarks") or "") if remarks_present else None

        # validate against config.statuses (optional)
        if new_status:
            cfg = await db[COL_PETITIONS].find_one(
                {"_id": "config", "doc_type": {"$in": ["config", "Config"]}},
                {"_id": 0, "statuses": 1},
            )
            allowed = set((cfg or {}).get("statuses") or [])
            if allowed and new_status not in allowed:
                raise HTTPException(status_code=400, detail="Invalid status value.")

        updates: Dict[str, Any] = {}
        if new_status:
            updates["status"] = new_status
        if remarks_present:
            updates["remarks"] = new_remarks

        if not updates:
            return {"ok": False, "message": "Nothing to update."}

        res = await db[COL_PETITIONS].update_many(
            {"term_id": current_term_id, "course_id": courseId, "petition_id": {"$exists": True}},
            {"$set": updates},
        )
        return {"ok": True, "matched": res.matched_count, "modified": res.modified_count}

    # ---------- BULK FORWARD ----------
    if action == "bulkForward":
        if not payload or not isinstance(payload.get("course_ids"), list):
            raise HTTPException(status_code=400, detail="payload.course_ids must be an array.")
        target_status = (payload.get("status") or "Forwarded To Department").strip()

        cfg = await db[COL_PETITIONS].find_one(
            {"_id": "config", "doc_type": {"$in": ["config", "Config"]}},
            {"_id": 0, "statuses": 1},
        )
        allowed = set((cfg or {}).get("statuses") or [])
        if allowed and target_status not in allowed:
            raise HTTPException(status_code=400, detail="Invalid status value.")

        res = await db[COL_PETITIONS].update_many(
            {"term_id": current_term_id, "course_id": {"$in": payload["course_ids"]}, "petition_id": {"$exists": True}},
            {"$set": {"status": target_status}},
        )
        return {"ok": True, "matched": res.matched_count, "modified": res.modified_count, "status": target_status}

    raise HTTPException(status_code=400, detail="Invalid action parameter.")
