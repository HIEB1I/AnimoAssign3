# app/routes/student_petition.py
from datetime import datetime, timezone
from typing import Any, Dict, Optional, List
from fastapi import APIRouter, HTTPException, Query, Body
from ..main import db
from pymongo import ReturnDocument

router = APIRouter(prefix="/student", tags=["student"])

COL_USERS = "users"
COL_PETITIONS = "student_petitions"  # holds petitions AND the single config doc
COL_DEPARTMENTS = "departments"
COL_COURSES = "courses"
COL_PROGRAMS = "programs"
COL_TERMS = "terms"

# ---------------- helpers ----------------

def _now_dt() -> datetime:
    return datetime.now(timezone.utc)

async def _active_term() -> Dict[str, Any]:
    """Return minimal active term info."""
    t = await db[COL_TERMS].find_one(
        {"$or": [{"status": "active"}, {"is_current": True}]},
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
    )
    return t or {}

async def _find_course_by_code(code: str) -> Optional[Dict[str, Any]]:
    """Match courses where course_code could be a string or array; return ids & display fields."""
    if not code:
        return None
    code = code.strip().upper()
    doc = await db[COL_COURSES].find_one(
        {
            "$or": [
                {"course_code": code},
                {"course_code": {"$in": [code]}},
                {"course_code": {"$elemMatch": {"$regex": f"^{code}$", "$options": "i"}}},
            ]
        },
        {"_id": 0, "course_id": 1, "course_code": 1, "course_title": 1, "department_id": 1},
    )
    if doc:
        cc = doc.get("course_code")
        if isinstance(cc, list):
            doc["course_code"] = cc[0] if cc else ""
    return doc

async def _get_department_by_name(name: str) -> Optional[Dict[str, Any]]:
    """Departments may use 'department_name' (preferred). Fallback to 'dept_name'."""
    if not name:
        return None
    name = name.strip()
    doc = await db[COL_DEPARTMENTS].find_one(
        {"$or": [{"department_name": name}, {"dept_name": name}]},
        {"_id": 0, "department_id": 1, "department_name": 1, "dept_name": 1},
    )
    return doc

async def _get_program_by_code(program_code: str) -> Optional[Dict[str, Any]]:
    if not program_code:
        return None
    return await db[COL_PROGRAMS].find_one(
        {"program_code": program_code.strip()},
        {"_id": 0, "program_id": 1, "program_code": 1},
    )

async def _get_petition_config() -> Dict[str, Any]:
    cfg = await db[COL_PETITIONS].find_one(
        {"_id": "config", "doc_type": "config"},
        {"_id": 0, "reasons": 1, "statuses": 1, "next_seq": 1},
    )
    if not cfg:
        cfg = {
            "reasons": ["Out of Slots", "Schedule Conflict"],
            "statuses": [
                "Less Than Minimum",
                "Forwarded To Department",
                "Rejected",
                "Wait For Frosh Block",
                "Wait For College Enlistment",
                "Open Slots Available",
                "New Class Opened",
                "Advised For Special Class",
                "Slots Increased",
            ],
            "next_seq": 0,
        }
        await db[COL_PETITIONS].update_one(
            {"_id": "config"},
            {"$setOnInsert": {"doc_type": "config", **cfg}},
            upsert=True,
        )
    return cfg

async def _next_petition_id() -> str:
    doc = await db[COL_PETITIONS].find_one_and_update(
        {"_id": "config"},
        {"$setOnInsert": {"doc_type": "config"}, "$inc": {"next_seq": 1}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    seq = int((doc or {}).get("next_seq", 1))
    return f"PTTN{seq:04d}"

# ---------------- route ----------------

@router.post("/petition")
async def petition_handler(
    userId: str = Query(..., min_length=3),
    action: str = Query("fetch", description="fetch | submit | options | profile"),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    # ---------- FETCH (list) ----------
    if action == "fetch":
        pipeline: List[Dict[str, Any]] = [
            {"$match": {"user_id": userId, "petition_id": {"$exists": True}}},
            # Join terms
            {"$lookup": {"from": COL_TERMS, "localField": "term_id", "foreignField": "term_id", "as": "term"}},
            {"$unwind": {"path": "$term", "preserveNullAndEmptyArrays": True}},
            # Join users
            {"$lookup": {"from": COL_USERS, "localField": "user_id", "foreignField": "user_id", "as": "user"}},
            {"$unwind": {"path": "$user", "preserveNullAndEmptyArrays": True}},
            # Join programs
            {"$lookup": {"from": COL_PROGRAMS, "localField": "program_id", "foreignField": "program_id", "as": "prog"}},
            {"$unwind": {"path": "$prog", "preserveNullAndEmptyArrays": True}},
            # Join departments
            {"$lookup": {"from": COL_DEPARTMENTS, "localField": "department_id", "foreignField": "department_id", "as": "dept"}},
            {"$unwind": {"path": "$dept", "preserveNullAndEmptyArrays": True}},
            # Join courses
            {"$lookup": {"from": COL_COURSES, "localField": "course_id", "foreignField": "course_id", "as": "course"}},
            {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},
            # Normalize course_code (string/array)
            {"$addFields": {
                "course_code_display": {
                    "$cond": [
                        {"$isArray": "$course.course_code"},
                        {"$ifNull": [{"$arrayElemAt": ["$course.course_code", 0]}, ""]},
                        {"$ifNull": ["$course.course_code", ""]},
                    ]
                },
                "department_name_display": {"$ifNull": ["$dept.department_name", "$dept.dept_name"]},
            }},
            {"$project": {
                "_id": 0,
                # Stored IDs (for potential FE needs)
                "petition_id": 1,
                "user_id": 1,
                "term_id": 1,
                "program_id": 1,
                "department_id": 1,
                "course_id": 1,
                "student_number": 1,
                "reason": 1,
                "status": 1,
                "submitted_at": 1,
                # Display (joined)
                "terms.term_number": "$term.term_number",
                "terms.acad_year_start": "$term.acad_year_start",
                "users.first_name": "$user.first_name",
                "users.last_name": "$user.last_name",
                "programs.program_code": "$prog.program_code",
                "departments.department_name": "$department_name_display",
                "courses.course_code": "$course_code_display",
                "courses.course_title": "$course.course_title",
            }},
            {"$sort": {"submitted_at": -1}},
        ]
        rows = [r async for r in db[COL_PETITIONS].aggregate(pipeline)]

        # Make a flat, UI-friendly shape (keeps your current frontend happy)
        def to_view(r: Dict[str, Any]) -> Dict[str, Any]:
            ay = r.get("terms", {}).get("acad_year_start")
            return {
                "petition_id": r.get("petition_id", ""),
                "user_id": r.get("user_id", ""),
                "course_id": r.get("course_id"),
                "course_code": r.get("courses", {}).get("course_code", ""),
                "course_title": r.get("courses", {}).get("course_title", ""),
                "reason": r.get("reason", ""),
                "status": r.get("status", ""),
                "submitted_at": r.get("submitted_at"),
                "acad_year_start": ay,
                "term_number": r.get("terms", {}).get("term_number"),
                "program_code": r.get("programs", {}).get("program_code", ""),
                # Not currently shown by FE, but available if needed:
                "department_name": r.get("departments", {}).get("department_name", ""),
                "first_name": r.get("users", {}).get("first_name", ""),
                "last_name": r.get("users", {}).get("last_name", ""),
            }

        return {"ok": True, "petitions": [to_view(x) for x in rows]}

    # ---------- PROFILE ----------
    if action == "profile":
        u = await db[COL_USERS].find_one(
            {"user_id": userId},
            {"_id": 0, "first_name": 1, "last_name": 1},
        )
        return {
            "ok": bool(u),
            "first_name": (u or {}).get("first_name", ""),
            "last_name": (u or {}).get("last_name", ""),
            "student_number": "",
            "program_code": "",
        }

    # ---------- OPTIONS ----------
    if action == "options":
        cfg = await _get_petition_config()

        # departments (provide names for dropdown)
        depts = [d async for d in db[COL_DEPARTMENTS].find(
            {}, {"_id": 0, "department_id": 1, "department_name": 1, "dept_name": 1}
        )]
        dept_names = [(d.get("department_name") or d.get("dept_name") or "").strip() for d in depts]
        dept_names = [x for x in dept_names if x]

        # courses joined with departments for display
        pipeline = [
            {"$lookup": {
                "from": COL_DEPARTMENTS,
                "localField": "department_id",
                "foreignField": "department_id",
                "as": "dept",
            }},
            {"$unwind": {"path": "$dept", "preserveNullAndEmptyArrays": True}},
            {"$project": {
                "_id": 0,
                "course_code": {
                    "$cond": [
                        {"$isArray": "$course_code"},
                        {"$arrayElemAt": ["$course_code", 0]},
                        "$course_code",
                    ]
                },
                "course_title": 1,
                "dept_name": {"$ifNull": ["$dept.department_name", "$dept.dept_name"]},
            }},
            {"$sort": {"dept_name": 1, "course_code": 1}},
        ]
        courses = [c async for c in db[COL_COURSES].aggregate(pipeline)]

        # programs
        programs = [p async for p in db[COL_PROGRAMS].find({}, {"_id": 0, "program_id": 1, "program_code": 1})]

        return {
            "ok": True,
            "departments": dept_names,
            "courses": courses,        # {course_code, course_title, dept_name}
            "programs": programs,      # {program_id, program_code}
            "reasons": cfg.get("reasons", []),
            "statuses": cfg.get("statuses", []),
        }

    # ---------- SUBMIT ----------
    if action == "submit":
        if not payload:
            raise HTTPException(status_code=400, detail="Missing payload")

        for k in ["department", "courseCode", "reason", "studentNumber", "degree"]:
            if not str(payload.get(k) or "").strip():
                raise HTTPException(status_code=400, detail="All required fields must be filled.")

        sn = str(payload["studentNumber"]).strip()
        if not (sn.isdigit() and len(sn) == 8):
            raise HTTPException(status_code=400, detail="Student number must be exactly 8 digits.")

        cfg = await _get_petition_config()
        if payload["reason"] not in set(cfg.get("reasons", [])):
            raise HTTPException(status_code=400, detail="Invalid reason value.")
        statuses: List[str] = cfg.get("statuses", [])
        initial_status = next((s for s in statuses if s.lower().startswith("forwarded")),
                              (statuses[0] if statuses else "PENDING"))

        # Resolve entities
        prog = await _get_program_by_code(str(payload["degree"]).strip())
        if not prog:
            raise HTTPException(status_code=400, detail="Selected program not found.")

        dept = await _get_department_by_name(str(payload["department"]).strip())
        if not dept:
            raise HTTPException(status_code=400, detail="Selected department not found.")

        course = await _find_course_by_code(str(payload["courseCode"]).strip())
        if not course:
            raise HTTPException(status_code=400, detail="Course code not found.")

        # Ensure course belongs to dept (if you want strictness)
        if course.get("department_id") and dept.get("department_id") and course["department_id"] != dept["department_id"]:
            raise HTTPException(status_code=400, detail="Course does not belong to the selected department.")

        active_term = await _active_term()
        term_id = active_term.get("term_id", "")

        # Block duplicates in active term
        dup = await db[COL_PETITIONS].find_one({
            "user_id": userId,
            "course_id": course["course_id"],
            "term_id": term_id,
            "petition_id": {"$exists": True},
        })
        if dup:
            raise HTTPException(status_code=409, detail="You already submitted a petition for this course.")

        petition_id = await _next_petition_id()

        # >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
        # STORE **ONLY IDs** (+ reason/status/student_number/submitted_at)
        # <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
        doc = {
            "petition_id": petition_id,
            "user_id": userId,
            "term_id": term_id,
            "program_id": prog["program_id"],
            "department_id": dept["department_id"],
            "course_id": course["course_id"],
            "student_number": int(sn),
            "reason": payload["reason"],
            "status": initial_status,
            "submitted_at": _now_dt(),
        }

        await db[COL_PETITIONS].insert_one(doc)

        # Reuse fetch pipeline for a single item-like response (optional fast projection)
        return {"ok": True, "petition": {
            "petition_id": petition_id,
            "user_id": userId,
            "course_id": course["course_id"],
            "course_code": course.get("course_code", ""),
            "course_title": course.get("course_title", ""),
            "reason": payload["reason"],
            "status": initial_status,
            "submitted_at": doc["submitted_at"],
            "acad_year_start": active_term.get("acad_year_start"),
            "term_number": active_term.get("term_number"),
            "program_code": prog.get("program_code", ""),
        }}

    raise HTTPException(status_code=400, detail="Invalid action parameter.")
