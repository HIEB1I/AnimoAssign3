from datetime import datetime, timezone
from typing import Any, Dict, Optional, List

from fastapi import APIRouter, HTTPException, Query, Body
from pymongo import ReturnDocument

from ..main import db

router = APIRouter(prefix="/student", tags=["student"])

# ---------------- collections ----------------
COL_USERS = "users"
COL_SPECIAL = "special_class"          # ✅ ONLY special class table/collection
COL_DEPARTMENTS = "departments"
COL_COURSES = "courses"
COL_PROGRAMS = "programs"
COL_TERMS = "terms"
COL_CURRICULUM = "curriculum"
COL_PREEN_COUNT = "preenlistment_count"

# ---------------- helpers ----------------

def _now_dt() -> datetime:
    return datetime.now(timezone.utc)

async def _active_term() -> Dict[str, Any]:
    """
    Same logic as petition: find working/planning term.

    Priority:
    1) active pre-enlistment batch (preenlistment_count where not archived)
    2) next term after current term (status=active OR is_current=True)
    3) fallback current
    """
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

    current = await db[COL_TERMS].find_one(
        {"$or": [{"status": "active"}, {"is_current": True}]},
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
    )

    if not current:
        fallback = await db[COL_TERMS].find(
            {},
            {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
        ).sort([("acad_year_start", -1), ("term_number", -1)]).limit(1).to_list(1)
        current = fallback[0] if fallback else None

    if not current:
        return {}

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

async def _find_course_by_code(code: str) -> Optional[Dict[str, Any]]:
    """
    Match courses where course_code could be a string or array; return ids & display fields.
    """
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
        {"_id": 0, "course_id": 1, "course_code": 1, "course_title": 1, "department_id": 1, "units": 1},
    )
    if doc:
        cc = doc.get("course_code")
        if isinstance(cc, list):
            doc["course_code"] = cc[0] if cc else ""
    return doc

async def _get_department_by_name(name: str) -> Optional[Dict[str, Any]]:
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

# ✅ fixed list based on your spec
ALLOWED_PROGRAM_CODES = [
    "BSCS-ST",
    "BSCS-NIS",
    "BSCS-CSE",
    "BSMS-CS",
    "BS IET-GD",
    "BS IET-AD",
    "BSIT",
    "BSIS",
]

ALLOWED_DEPARTMENTS = [
    "Department of Software Technology",
    "Department of Computer Technology",
    "Department of Information Technology",
]

async def _get_special_config() -> Dict[str, Any]:
    """
    Same pattern as petition: config doc lives INSIDE the same table/collection.
    """
    cfg = await db[COL_SPECIAL].find_one(
        {"_id": "config", "doc_type": {"$in": ["config", "Config"]}},
        {"_id": 0, "reasons": 1, "statuses": 1, "next_seq": 1},
    )
    if not cfg:
        cfg = {
            "reasons": [
                "Graduating at the end of this Term and course is not offered",
                "Graduating at the end of this Term and course offered is conflict with other enrolled courses",
                "The course is indicated in the program flowchart as a regular offering for the term but is not offered",
                "Other",
            ],
            "statuses": [
                "Submitted",
                "Forwarded To Associate Dean",
                "Forwarded To Department",
                "Approved",
                "Disapproved",
            ],
            "next_seq": 0,
        }
        await db[COL_SPECIAL].update_one(
            {"_id": "config"},
            {"$setOnInsert": {"doc_type": "config", **cfg}},
            upsert=True,
        )
    return cfg

async def _next_special_id() -> str:
    doc = await db[COL_SPECIAL].find_one_and_update(
        {"_id": "config"},
        {"$setOnInsert": {"doc_type": "config"}, "$inc": {"next_seq": 1}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    seq = int((doc or {}).get("next_seq", 1))
    return f"SPCL{seq:04d}"

# ---------------- route ----------------

@router.post("/specialclass")
async def special_class_handler(
    userId: str = Query(..., min_length=3),
    action: str = Query("fetch", description="fetch | submit | options | profile"),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    # ---------- FETCH (list) ----------
    if action == "fetch":
        pipeline: List[Dict[str, Any]] = [
            {"$match": {"user_id": userId, "special_id": {"$exists": True}}},
            {"$lookup": {"from": COL_TERMS, "localField": "term_id", "foreignField": "term_id", "as": "term"}},
            {"$unwind": {"path": "$term", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": COL_USERS, "localField": "user_id", "foreignField": "user_id", "as": "user"}},
            {"$unwind": {"path": "$user", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": COL_PROGRAMS, "localField": "program_id", "foreignField": "program_id", "as": "prog"}},
            {"$unwind": {"path": "$prog", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": COL_DEPARTMENTS, "localField": "department_id", "foreignField": "department_id", "as": "dept"}},
            {"$unwind": {"path": "$dept", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": COL_COURSES, "localField": "course_id", "foreignField": "course_id", "as": "course"}},
            {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},
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
                "special_id": 1,
                "user_id": 1,
                "term_id": 1,
                "program_id": 1,
                "department_id": 1,
                "course_id": 1,

                "student_number": 1,
                "units_remaining": 1,
                "graduating_after_term": 1,

                "course_units": 1,
                "reason": 1,
                "reason_other": 1,
                "status": 1,
                "remarks": 1,
                "submitted_at": 1,

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

        rows = [r async for r in db[COL_SPECIAL].aggregate(pipeline)]

        def to_view(r: Dict[str, Any]) -> Dict[str, Any]:
            ay = r.get("terms", {}).get("acad_year_start")
            return {
                "special_id": r.get("special_id", ""),
                "user_id": r.get("user_id", ""),
                "course_id": r.get("course_id"),
                "course_code": r.get("courses", {}).get("course_code", ""),
                "course_title": r.get("courses", {}).get("course_title", ""),
                "department_name": r.get("departments", {}).get("department_name", ""),
                "course_units": r.get("course_units", 0),
                "units_remaining": r.get("units_remaining", 0),
                "graduating_after_term": r.get("graduating_after_term", False),
                "reason": r.get("reason", ""),
                "reason_other": r.get("reason_other", ""),
                "status": r.get("status", ""),
                "remarks": r.get("remarks", ""),
                "submitted_at": r.get("submitted_at"),
                "acad_year_start": ay,
                "term_number": r.get("terms", {}).get("term_number"),
                "program_code": r.get("programs", {}).get("program_code", ""),
                "first_name": r.get("users", {}).get("first_name", ""),
                "last_name": r.get("users", {}).get("last_name", ""),
            }

        return {"ok": True, "applications": [to_view(x) for x in rows]}

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
        cfg = await _get_special_config()

        # departments (fixed list; also try to resolve IDs later during submit)
        # We return names for dropdown to match petition FE pattern.
        dept_names = ALLOWED_DEPARTMENTS[:]

        # programs (filtered to your allowed codes)
        progs = [p async for p in db[COL_PROGRAMS].find(
            {"program_code": {"$in": ALLOWED_PROGRAM_CODES}},
            {"_id": 0, "program_id": 1, "program_code": 1},
        )]
        # If your DB has missing codes, still let FE show the fixed list (fallback)
        prog_codes_db = {p.get("program_code") for p in progs if p.get("program_code")}
        programs_out = progs[:]
        for code in ALLOWED_PROGRAM_CODES:
            if code not in prog_codes_db:
                programs_out.append({"program_id": "", "program_code": code})

        # courses: only those under the allowed departments (college restriction)
        dept_docs = [d async for d in db[COL_DEPARTMENTS].find(
            {"$or": [{"department_name": {"$in": ALLOWED_DEPARTMENTS}},
                     {"dept_name": {"$in": ALLOWED_DEPARTMENTS}}]},
            {"_id": 0, "department_id": 1, "department_name": 1, "dept_name": 1},
        )]
        dept_ids = [d["department_id"] for d in dept_docs if d.get("department_id")]

        # Join dept for display and normalize course_code
        pipeline = [
            {"$match": {"department_id": {"$in": dept_ids}}} if dept_ids else {"$match": {}},
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
                        {"$ifNull": [{"$arrayElemAt": ["$course_code", 0]}, ""]},
                        {"$ifNull": ["$course_code", ""]},
                    ]
                },
                "course_title": 1,
                "units": {"$ifNull": ["$units", 0]},
                "dept_name": {"$ifNull": ["$dept.department_name", "$dept.dept_name"]},
            }},
            {"$sort": {"dept_name": 1, "course_code": 1}},
        ]
        courses = [c async for c in db[COL_COURSES].aggregate(pipeline)]

        return {
            "ok": True,
            "departments": dept_names,
            "courses": courses,       # {course_code, course_title, units, dept_name}
            "programs": programs_out, # {program_id, program_code}
            "reasons": cfg.get("reasons", []),
            "statuses": cfg.get("statuses", []),
        }

    # ---------- SUBMIT ----------
    if action == "submit":
        if not payload:
            raise HTTPException(status_code=400, detail="Missing payload")

        # Required fields (mirrors multi-section)
        required = [
            "studentNumber",
            "degree",
            "unitsRemaining",
            "graduatingAfterTerm",
            "courseCode",
            "units",
            "reason",
            "department",
            "agree",
        ]
        for k in required:
            if payload.get(k) is None or str(payload.get(k)).strip() == "":
                raise HTTPException(status_code=400, detail="All required fields must be filled.")

        # student number
        sn = str(payload["studentNumber"]).strip()
        if not (sn.isdigit() and len(sn) == 8):
            raise HTTPException(status_code=400, detail="Student number must be exactly 8 digits.")

        # agree
        if payload.get("agree") is not True:
            raise HTTPException(status_code=400, detail="You must agree to the Terms and Conditions.")

        # program validation
        degree = str(payload["degree"]).strip()
        if degree not in set(ALLOWED_PROGRAM_CODES):
            raise HTTPException(status_code=400, detail="Invalid degree program.")
        prog = await _get_program_by_code(degree)
        if not prog:
            # Allow submit even if program_id missing in DB? Usually no.
            raise HTTPException(status_code=400, detail="Selected program not found.")

        # units remaining
        try:
            units_remaining = int(payload["unitsRemaining"])
        except:
            raise HTTPException(status_code=400, detail="Units Remaining must be a number.")
        if units_remaining < 0:
            raise HTTPException(status_code=400, detail="Units Remaining cannot be negative.")

        # graduating
        graduating_after_term = bool(payload["graduatingAfterTerm"])

        # reason validation
        cfg = await _get_special_config()
        reasons = set(cfg.get("reasons", []))
        reason = str(payload["reason"]).strip()
        if reason not in reasons:
            raise HTTPException(status_code=400, detail="Invalid reason value.")

        reason_other = str(payload.get("reasonOther") or "").strip()
        if reason == "Other" and not reason_other:
            raise HTTPException(status_code=400, detail="Please specify your reason for 'Other'.")

        # department must be one of allowed
        dept_name = str(payload["department"]).strip()
        if dept_name not in set(ALLOWED_DEPARTMENTS):
            raise HTTPException(status_code=400, detail="Invalid department value.")

        dept = await _get_department_by_name(dept_name)
        if not dept:
            raise HTTPException(status_code=400, detail="Selected department not found.")

        # course
        course = await _find_course_by_code(str(payload["courseCode"]).strip())
        if not course:
            raise HTTPException(status_code=400, detail="Course code not found.")

        # Ensure course belongs to selected dept (college restriction)
        if course.get("department_id") and dept.get("department_id") and course["department_id"] != dept["department_id"]:
            raise HTTPException(status_code=400, detail="Course does not belong to the selected department.")

        # units for course (input)
        try:
            course_units = int(payload["units"])
        except:
            raise HTTPException(status_code=400, detail="Units must be a number.")
        if course_units <= 0:
            raise HTTPException(status_code=400, detail="Units must be greater than 0.")

        # term
        active_term = await _active_term()
        term_id = active_term.get("term_id", "")
        if not term_id:
            raise HTTPException(status_code=503, detail="No active term configured.")

        # prevent duplicate per course+term
        dup = await db[COL_SPECIAL].find_one({
            "user_id": userId,
            "course_id": course["course_id"],
            "term_id": term_id,
            "special_id": {"$exists": True},
        })
        if dup:
            raise HTTPException(status_code=409, detail="You already submitted a Special Class application for this course this term.")

        # initial status
        statuses: List[str] = cfg.get("statuses", [])
        initial_status = statuses[0] if statuses else "Submitted"

        special_id = await _next_special_id()

        doc = {
            "special_id": special_id,
            "user_id": userId,
            "term_id": term_id,
            "program_id": prog["program_id"],
            "department_id": dept["department_id"],
            "course_id": course["course_id"],

            "student_number": int(sn),
            "units_remaining": units_remaining,
            "graduating_after_term": graduating_after_term,

            "course_units": course_units,
            "reason": reason,
            "reason_other": reason_other,

            "status": initial_status,
            "remarks": "",
            "submitted_at": _now_dt(),
        }

        await db[COL_SPECIAL].insert_one(doc)

        return {"ok": True, "application": {
            "special_id": special_id,
            "user_id": userId,
            "course_id": course["course_id"],
            "course_code": course.get("course_code", ""),
            "course_title": course.get("course_title", ""),
            "department_name": dept_name,
            "course_units": course_units,
            "units_remaining": units_remaining,
            "graduating_after_term": graduating_after_term,
            "reason": reason,
            "reason_other": reason_other,
            "status": doc["status"],
            "remarks": doc["remarks"],
            "submitted_at": doc["submitted_at"],
            "acad_year_start": active_term.get("acad_year_start"),
            "term_number": active_term.get("term_number"),
            "program_code": prog.get("program_code", ""),
        }}

    raise HTTPException(status_code=400, detail="Invalid action parameter.")
