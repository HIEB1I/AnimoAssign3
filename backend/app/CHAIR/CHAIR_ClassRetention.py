# backend/app/CHAIR/CHAIR_ClassRetention.py
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException, Query, Body
from ..main import db

router = APIRouter(prefix="/chair", tags=["chair"])

# --- collections ---
COL_TERMS = "terms"
COL_COURSES = "courses"
COL_SECTIONS = "sections"
COL_ASSIGN = "faculty_assignments"
COL_PROFILES = "faculty_profiles"
COL_USERS = "users"
COL_DEPARTMENTS = "departments"
COL_ROLE_ASSIGN = "role_assignments"
COL_USER_ROLES = "user_roles"

# Class retention docs live here (1 doc per section per term)
# Suggested shape:
# { retention_id, term_id, section_id, course_id, status, remarks?, requested_at?, enrolled? }
COL_CLASS_RETENTION = "class_retention"


async def _active_term() -> Dict[str, Any]:
    """Return the active term; fallback to latest AY/term_number."""
    t = await db[COL_TERMS].find_one(
        {"$or": [{"status": "active"}, {"is_current": True}]},
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
    )
    if t:
        return t
    last = (
        await db[COL_TERMS]
        .find({}, {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1})
        .sort([("acad_year_start", -1), ("term_number", -1)])
        .limit(1)
        .to_list(1)
    )
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


async def _resolve_department_for_user(userEmail: Optional[str], userId: Optional[str]) -> Optional[str]:
    """Return department_id from the user's role scope (first 'department' scope found)."""
    if not userEmail and not userId:
        return None

    match: Dict[str, Any] = {"user_id": userId} if userId else {"email": userEmail}

    pipeline: List[Dict[str, Any]] = [
        {"$match": match},
        {"$project": {"_id": 0, "user_id": 1, "email": 1}},
        {"$lookup": {
            "from": COL_ROLE_ASSIGN,
            "let": {"uid": "$user_id"},
            "pipeline": [{"$match": {"$expr": {"$eq": ["$user_id", "$$uid"]}}}],
            "as": "ra_list"
        }},
        {"$unwind": {"path": "$ra_list", "preserveNullAndEmptyArrays": True}},
        {"$addFields": {
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
        {"$project": {"department_id": 1}},
        {"$limit": 1},
    ]

    docs = [d async for d in db[COL_USERS].aggregate(pipeline)]
    if not docs:
        return None
    return docs[0].get("department_id")


@router.post("/class-retention")
async def chair_class_retention_handler(
    action: str = Query("list", description="options | list | update | bulkForward | header"),
    status: Optional[str] = Query(None, description="Filter by status (list)"),
    search: Optional[str] = Query(None, description="Search by course code/title (list)"),
    sectionId: Optional[str] = Query(None, description="For single update"),
    termId: Optional[str] = Query(None, description="Override active term"),
    userEmail: Optional[str] = Query(None, description="Header: user email (for scoping)"),
    userId: Optional[str] = Query(None, description="Header: user id (for scoping)"),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    """
    CHAIR Class Retention (department-scoped):
      - header:     topbar profile (if needed later)
      - options:    statuses + active term meta
      - list:       list retention rows for chair's department in active term
      - update:     update status/remarks of a single section in active term (scoped)
      - bulkForward:set status for multiple section_ids in active term (scoped)
    """

    # ---------- HEADER (optional symmetry with SP; kept simple) ----------
    if action == "header":
        if not userEmail and not userId:
            raise HTTPException(status_code=400, detail="userEmail or userId is required.")
        # Minimal header; can be expanded to mirror SP if you later need it.
        return {"ok": True}

    # ---------- Ensure active term for list/update/bulk ----------
    active = await _active_term()
    current_term_id = termId or active.get("term_id")
    if not current_term_id and action in {"list", "update", "bulkForward"}:
        raise HTTPException(status_code=503, detail="No active term configured.")

    # Department scoping (same as Student Petition) :contentReference[oaicite:5]{index=5}
    department_id = await _resolve_department_for_user(userEmail, userId)

    # ---------- OPTIONS ----------
    if action == "options":
        cfg = await db[COL_CLASS_RETENTION].find_one(
            {"_id": "config", "doc_type": {"$in": ["config", "Config"]}},
            {"_id": 0, "statuses": 1},
        )
        statuses = (cfg or {}).get("statuses") or [
            "Approved",
            "Under Review",
            "Dissolved",
            "Special Class",
            "Forwarded",
        ]
        return {
            "ok": True,
            "statuses": statuses,
            "activeTerm": {
                "term_id": active.get("term_id", ""),
                "acad_year_start": active.get("acad_year_start"),
                "term_number": active.get("term_number"),
            },
        }

    # ---------- LIST ----------
    if action == "list":
        pipeline: List[Dict[str, Any]] = [
            {"$match": {"term_id": current_term_id}},
            {"$lookup": {
                "from": COL_COURSES,
                "localField": "course_id",
                "foreignField": "course_id",
                "as": "course"
            }},
            {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {
                "from": COL_SECTIONS,
                "localField": "section_id",
                "foreignField": "section_id",
                "as": "section"
            }},
            {"$unwind": {"path": "$section", "preserveNullAndEmptyArrays": True}},
            # pull one faculty name (if any) assigned to this section
            {"$lookup": {
                "from": COL_ASSIGN,
                "let": {"sid": "$section_id"},
                "pipeline": [
                    {"$match": {"$expr": {"$eq": ["$section_id", "$$sid"]}}},
                    {"$sort": {"created_at": -1}},
                    {"$limit": 1},
                ],
                "as": "asg"
            }},
            {"$unwind": {"path": "$asg", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {
                "from": COL_PROFILES,
                "localField": "asg.faculty_id",
                "foreignField": "faculty_id",
                "as": "prof"
            }},
            {"$unwind": {"path": "$prof", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {
                "from": COL_USERS,
                "localField": "prof.user_id",
                "foreignField": "user_id",
                "as": "u"
            }},
            {"$unwind": {"path": "$u", "preserveNullAndEmptyArrays": True}},
            {"$addFields": {
                "course_code": _course_code_expr(),
                "course_title": {"$ifNull": ["$course.course_title", ""]},
                "department_id": {"$ifNull": ["$course.department_id", ""]},
                "section_code": {"$ifNull": ["$section.section_code", ""]},
                "faculty_name": {
                    "$trim": {"input": {"$concat": [
                        {"$ifNull": ["$u.last_name", ""]},
                        { "$cond": [{ "$ifNull": ["$u.last_name", False]}, ", ", "" ]},
                        {"$ifNull": ["$u.first_name", ""]},
                    ]}}
                },
                "student_units": {"$ifNull": ["$course.units", None]},
                "faculty_units": {"$ifNull": ["$course.units", None]},
                "enrolled": {"$ifNull": ["$enrolled", {"$ifNull": ["$section.enrolled", 0]}]},
            }},
        ]

        # Department scope filter
        post_match: Dict[str, Any] = {}
        if department_id:
            post_match["department_id"] = department_id

        # Client filters
        if status and status.strip().lower() != "all status":
            post_match["status"] = status.strip()
        if search and search.strip():
            s = search.strip()
            post_match["$or"] = [
                {"course_code": {"$regex": s, "$options": "i"}},
                {"course_title": {"$regex": s, "$options": "i"}},
                {"section_code": {"$regex": s, "$options": "i"}},
            ]

        if post_match:
            pipeline.append({"$match": post_match})

        pipeline += [
            {"$project": {
                "_id": 0,
                "section_id": 1,
                "course_id": 1,
                "course_code": 1,
                "course_title": 1,
                "section_code": 1,
                "stuUnits": "$student_units",
                "facUnits": "$faculty_units",
                "enrolled": 1,
                "faculty": {"$ifNull": ["$faculty_name", ""]},
                "status": {"$ifNull": ["$status", ""]},
                "remarks": {"$ifNull": ["$remarks", ""]},
            }},
            {"$sort": {"course_code": 1, "section_code": 1}},
        ]

        rows = [r async for r in db[COL_CLASS_RETENTION].aggregate(pipeline)]
        return {"ok": True, "rows": rows, "term_id": current_term_id}

    # ---------- UPDATE ----------
    if action == "update":
        if not sectionId:
            raise HTTPException(status_code=400, detail="sectionId is required.")
        if not payload:
            raise HTTPException(status_code=400, detail="payload is required.")

        new_status = (payload.get("status") or "").strip()
        remarks_present = "remarks" in payload
        new_remarks = (payload.get("remarks") or "") if remarks_present else None

        # validate against config.statuses (optional)
        if new_status:
            cfg = await db[COL_CLASS_RETENTION].find_one(
                {"_id": "config", "doc_type": {"$in": ["config", "Config"]}},
                {"_id": 0, "statuses": 1},
            )
            allowed = set((cfg or {}).get("statuses") or [])
            if allowed and new_status not in allowed:
                raise HTTPException(status_code=400, detail="Invalid status value.")

        # department scope check (via course)
        if department_id:
            doc = await db[COL_CLASS_RETENTION].find_one(
                {"term_id": current_term_id, "section_id": sectionId},
                {"course_id": 1},
            )
            if not doc:
                raise HTTPException(status_code=404, detail="Class retention record not found.")
            course = await db[COL_COURSES].find_one({"course_id": doc.get("course_id")}, {"department_id": 1})
            if not course or course.get("department_id") != department_id:
                raise HTTPException(status_code=403, detail="Section not in your department.")

        updates: Dict[str, Any] = {}
        if new_status:
            updates["status"] = new_status
        if remarks_present:
            updates["remarks"] = new_remarks

        if not updates:
            return {"ok": False, "message": "Nothing to update."}

        res = await db[COL_CLASS_RETENTION].update_many(
            {"term_id": current_term_id, "section_id": sectionId},
            {"$set": updates},
        )
        return {"ok": True, "matched": res.matched_count, "modified": res.modified_count}

    # ---------- BULK FORWARD ----------
    if action == "bulkForward":
        if not payload or not isinstance(payload.get("section_ids"), list):
            raise HTTPException(status_code=400, detail="payload.section_ids must be an array.")
        target_status = (payload.get("status") or "Forwarded").strip()

        cfg = await db[COL_CLASS_RETENTION].find_one(
            {"_id": "config", "doc_type": {"$in": ["config", "Config"]}},
            {"_id": 0, "statuses": 1},
        )
        allowed = set((cfg or {}).get("statuses") or [])
        if allowed and target_status not in allowed:
            raise HTTPException(status_code=400, detail="Invalid status value.")

        section_ids: List[str] = payload["section_ids"]

        # If scoped, limit sections to those in the chair's department
        scoped_ids = section_ids
        if department_id:
            # map section -> course -> dept
            rel = await db[COL_CLASS_RETENTION].aggregate([
                {"$match": {"term_id": current_term_id, "section_id": {"$in": section_ids}}},
                {"$lookup": {
                    "from": COL_COURSES,
                    "localField": "course_id",
                    "foreignField": "course_id",
                    "as": "c"
                }},
                {"$unwind": {"path": "$c", "preserveNullAndEmptyArrays": True}},
                {"$match": {"c.department_id": department_id}},
                {"$project": {"_id": 0, "section_id": 1}},
            ]).to_list(None)
            scoped_ids = [x["section_id"] for x in rel]

        if not scoped_ids:
            return {"ok": True, "matched": 0, "modified": 0, "status": target_status}

        res = await db[COL_CLASS_RETENTION].update_many(
            {"term_id": current_term_id, "section_id": {"$in": scoped_ids}},
            {"$set": {"status": target_status}},
        )
        return {"ok": True, "matched": res.matched_count, "modified": res.modified_count, "status": target_status}

    raise HTTPException(status_code=400, detail="Invalid action parameter.")
