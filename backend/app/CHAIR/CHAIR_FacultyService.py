# backend/app/CHAIR/CHAIR_FacultyService.py
# -----------------------------------------------------------------------------
# Collections used:
#   - faculty_service    : stores request/response records
#   - courses            : course lookups (by course_code), filtered by department if provided
#   - faculty_profiles   : faculty dropdown (by receiving department)
#   - users              : fetch faculty email
#   - email_logs         : stub for outbound emails
# -----------------------------------------------------------------------------

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from uuid import uuid4

from fastapi import APIRouter, Body, HTTPException, Query
from ..main import db
from ..Notifications import create_notification

router = APIRouter(prefix="/chair/faculty-service", tags=["chair", "faculty-service"])

# --- collections for term logic ---
COL_TERMS = "terms"
COL_PREEN_COUNT = "preenlistment_count"

# --- constants per spec ---
DAYS = ["M", "T", "W", "H", "F", "S"]
BEGIN = ["07:30", "09:15", "11:00", "12:45", "14:30", "16:15", "18:00", "19:45"]
END_BY_BEGIN = {

    "07:30": "09:00",
    "09:15": "10:45",
    "11:00": "12:30",
    "12:45": "14:15",
    "14:30": "16:00",
    "16:15": "17:45",
    "18:00": "19:30",
    "19:45": "21:00",
}

# Department directory (spec)
DEPTS = [
    "Department of Computer Technology",
    "Department of Information Technology",
    "Department of Literature",
    "Department of Software Technology",
]

# Safe default recipients (email logging is optional; lack of mapping must NOT break send)
RECIPIENT = {
    "Department of Information Technology": ("Danny Cheng", "danny.cheng@dlsu.edu.ph"),
    "Department of Computer Technology": ("Katrina Ysabel Solomon", "katrina.solomon@dlsu.edu.ph"),
    "Department of Literature": ("Shirley Lua", "shirley.lua@dlsu.edu.ph"),
    "Department of Software Technology": ("Neil Patrick Del Gallego", "neil.delgallego@dlsu.edu.ph"),
}

# ------------------------ helpers ------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _active_term() -> Dict[str, Any]:
    """
    Shared WORKING / PLANNING term logic (OM-style).

    Returns a dict with at least:
      - term_id
      - acad_year_start
      - term_number

    Selection rules:

      (a) Prefer active pre-enlistment batch
          - Look up in preenlistment_count where is_archived != True.
          - If it has a term_id and that term exists in terms, return that term.

      (b) Otherwise, find the “current” term
          - Query terms where any of these flags indicate it's current:
              status: "active" or "Active"
              is_current: True
              is_active: True
              active: True
          - Project only term_id, acad_year_start, term_number.
          - If none match, fall back to the latest term by
              acad_year_start DESC, term_number DESC.

      (c) If still nothing
          - If there are no terms at all, return {} (empty dict).

      (d) Compute the planning term (next term)
          - Given the current term from step (b), try to find the next term:
              acad_year_start > current.acad_year_start, OR
              acad_year_start == current.acad_year_start
                AND term_number > current.term_number
          - Sort by acad_year_start ASC, term_number ASC and take the first result.
          - If a “next” term exists, return that as the working / planning term.
          - If no next term exists, return the current term.
    """

    # (a) Prefer active pre-enlistment batch
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

    # (b) Otherwise, find the “current” term via flags
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

    # Fallback: latest by acad_year_start DESC, term_number DESC
    if not current:
        last = await db[COL_TERMS].find(
            {},
            {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
        ).sort([("acad_year_start", -1), ("term_number", -1)]).limit(1).to_list(1)
        current = last[0] if last else None

    # (c) If still nothing, no terms at all
    if not current:
        return {}

    # (d) Compute the planning term (next term)
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

    # If no next term exists, return the current/latest term
    return current


def _normalize_code(code: Any) -> str:
    if isinstance(code, list):
        return (code[0] or "").upper()
    return str(code or "").upper()


async def _find_department(query: str) -> Optional[Dict[str, Any]]:
    """Find a department by name/code/id.

    IMPORTANT: be tolerant of case differences and leading/trailing spaces.
    """
    q = (query or "").strip()
    if not q:
        return None

    # 1) Exact match (fast)
    doc = await db.departments.find_one(
        {"$or": [{"dept_name": q}, {"dept_code": q}, {"department_id": q}]},
        {"_id": 0, "department_id": 1, "dept_name": 1, "dept_code": 1},
    )
    if doc:
        return doc

    # 2) Case-insensitive exact match for name/code
    doc = await db.departments.find_one(
        {
            "$or": [
                {"dept_name": {"$regex": f"^{q}$", "$options": "i"}},
                {"dept_code": {"$regex": f"^{q}$", "$options": "i"}},
            ]
        },
        {"_id": 0, "department_id": 1, "dept_name": 1, "dept_code": 1},
    )
    return doc

async def _chair_user_ids_for_dept(dept_name: Optional[str]) -> List[str]:
    """Resolve chair user_id(s) for a given department name/code/id.

    Priority:
      1) staff_profiles where department matches and position_title contains 'chair'
      2) role_assignments filtered by department and active

    Returns a de-duplicated list. If nothing matches, returns [].
    """
    if not dept_name:
        return []

    dept = await _find_department(dept_name)
    dep_id = (dept or {}).get('department_id')
    if not dep_id:
        return []

    ids: List[str] = []

    # 1) staff_profiles (preferred)
    try:
        cur = db.staff_profiles.find(
            {
                '$or': [{'department_id': dep_id}, {'dept_id': dep_id}],
                'position_title': {'$regex': 'chair', '$options': 'i'},
            },
            {'_id': 0, 'user_id': 1},
        )
        async for d in cur:
            if d.get('user_id'):
                ids.append(d['user_id'])
    except Exception:
        # collection may not exist in some environments
        pass

    # 2) role_assignments fallback
    if not ids:
        try:
            cur2 = db.role_assignments.find(
                {
                    '$or': [{'department_id': dep_id}, {'dept_id': dep_id}],
                    'is_active': {'$in': [True, None]},
                },
                {'_id': 0, 'user_id': 1},
            )
            async for d in cur2:
                if d.get('user_id'):
                    ids.append(d['user_id'])
        except Exception:
            pass

    # 3) Fallback: use RECIPIENT directory email -> users.user_id
    # This is the most reliable in your current app because RECIPIENT has known chair emails.
    if not ids:
        try:
            rec = RECIPIENT.get(dept_name or "")
            if rec:
                _, email = rec
                u = await db.users.find_one(
                    {"email": {"$regex": f"^{email}$", "$options": "i"}},
                    {"_id": 0, "user_id": 1},
                )
                if u and u.get("user_id"):
                    ids.append(u["user_id"])
        except Exception:
            pass

    # De-dupe
    out: List[str] = []
    seen = set()
    for uid in ids:
        if uid not in seen:
            seen.add(uid)
            out.append(uid)
    return out


async def _course_by_code(code: str) -> Optional[Dict[str, Any]]:
    if not code:
        return None
    doc = await db.courses.find_one(
        {"$or": [{"course_code": code}, {"course_code": [code]}]},
        {"_id": 0, "course_id": 1, "course_code": 1, "course_title": 1, "units": 1, "department_id": 1},
    )
    if not doc:
        # fallback regex
        doc = await db.courses.find_one(
            {"$or": [{"course_code": {"$regex": f"^{code}$", "$options": "i"}},
                     {"course_code": {"$in": [code]}}]},
            {"_id": 0, "course_id": 1, "course_code": 1, "course_title": 1, "units": 1, "department_id": 1},
        )
    if doc:
        doc["course_code"] = _normalize_code(doc.get("course_code"))
    return doc

async def _faculty_dropdown(dept_name: Optional[str]) -> List[Dict[str, Any]]:
    if not dept_name:
        return []

    # Find department_id from any of (name / code / id)
    dept = await _find_department(dept_name)
    dep_id = (dept or {}).get("department_id")
    if not dep_id:
        return []

    pipeline = [
        {"$match": {"department_id": dep_id}},
        {
            "$lookup": {
                "from": "users",
                "localField": "user_id",
                "foreignField": "user_id",
                "as": "u",
            }
        },
        {
            "$addFields": {
                "user": {"$arrayElemAt": ["$u", 0]},
            }
        },
        {
            "$project": {
                "_id": 0,
                "faculty_id": 1,
                "user_id": 1,
                "first_name": {"$ifNull": ["$user.first_name", ""]},
                "last_name": {"$ifNull": ["$user.last_name", ""]},
            }
        },
        {"$sort": {"last_name": 1, "first_name": 1}},
    ]

    out: List[Dict[str, Any]] = []
    async for r in db.faculty_profiles.aggregate(pipeline):
        out.append(
            {
                "faculty_id": r.get("faculty_id"),
                "first_name": r.get("first_name") or "",
                "last_name": r.get("last_name") or "",
                "label": f"{(r.get('last_name') or '').upper()}, {(r.get('first_name') or '').upper()}",
            }
        )
    return out


# --------------------------- OPTIONS ---------------------------

@router.get("/options")
async def fs_options(
    q: Optional[str] = Query(None, description="Search for course code/title"),
    toDepartment: Optional[str] = Query(None, description="Populate faculty options for this TO dept"),
    requesterDepartment: Optional[str] = Query(None, description="Filter courses to this requester's department")
):
    # courses (top 20), optionally filtered to the requester's department
    courses: List[Dict[str, Any]] = []
    course_filter: Dict[str, Any] = {}
    if requesterDepartment:
        d = await _find_department(requesterDepartment)
        if d and d.get("department_id"):
            course_filter["department_id"] = d["department_id"]

    if q:
        course_filter["$or"] = [
            {"course_code": {"$regex": q, "$options": "i"}},
            {"course_title": {"$regex": q, "$options": "i"}},
        ]
    cur = db.courses.find(course_filter or {}, {"_id": 0, "course_code": 1, "course_title": 1, "units": 1}).limit(20)
    async for c in cur:
        courses.append({
            "code": _normalize_code(c.get("course_code")),
            "title": c.get("course_title") or "",
            "units": c.get("units"),
        })

    faculty_opts = await _faculty_dropdown(toDepartment) if toDepartment else []

    # NEW: shared working / planning term
    active_term = await _active_term()

    return {
        "ok": True,
        "courses": courses,
        "departments": DEPTS,
        "timeBegins": BEGIN,
        "days": DAYS,
        "facultyOptions": faculty_opts,
        "activeTerm": active_term,  # <--- added
    }


# ---------------------------- LIST ----------------------------

@router.get("/list")
async def fs_list(
    status: Optional[str] = Query(None),
    dept: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    box: Optional[str] = Query(None, description='"sent" or "received"'),
):
    q: Dict[str, Any] = {}
    if status:
        q["status"] = status
    if dept:
        if box == "sent":
            q["from_department"] = dept
        elif box == "received":
            q["to_department"] = dept
        else:
            q["$or"] = [{"from_department": dept}, {"to_department": dept}]
    if search:
        q["$or"] = q.get("$or", []) + [
            {"course_code": {"$regex": search, "$options": "i"}},
            {"course_title": {"$regex": search, "$options": "i"}},
        ]

    cur = db.faculty_service.find(q, {"_id": 0}).sort([("created_at", -1)])
    rows = [doc async for doc in cur]
    return {"ok": True, "rows": rows}

# --------------------------- CREATE ---------------------------

@router.post("/create")
async def fs_create(payload: Dict[str, Any] = Body(...)):
    course_code = _normalize_code(payload.get("course_code"))
    units = payload.get("units", None)
    to_department = payload.get("to_department")
    course_title = (payload.get("course_title") or "").strip()
    from_department = (payload.get("from_department") or "").strip()

    if to_department not in DEPTS:
        raise HTTPException(status_code=400, detail="to_department must be one of the predefined departments.")
    if from_department not in DEPTS:
        raise HTTPException(status_code=400, detail="from_department must be one of the predefined departments.")
    if to_department == from_department:
        raise HTTPException(status_code=400, detail="to_department cannot be the same as from_department.")
    if not course_code:
        raise HTTPException(status_code=400, detail="course_code is required.")

    # resolve title/units from catalog if missing
    if not course_title or units is None:
        c = await _course_by_code(course_code)
        if c:
            if not course_title:
                course_title = c.get("course_title") or ""
            if units is None:
                units = c.get("units", None)

    # from_department is now required from payload and validated above

    fs_id = f"FS{uuid4().hex[:10].upper()}"
    now = _now_iso()
    doc = {
        "fs_id": fs_id,
        "status": "sent",  # created via UI "Send" button
        "created_at": now,
        "updated_at": now,
        "from_department": from_department,
        "to_department": to_department,
        "course_code": course_code,
        "course_title": course_title,
        "units": units,
        "faculty": {},
        "day1": "",
        "begin1": "",
        "end1": "",
        "day2": "",
        "begin2": "",
        "end2": "",
        "remarks": "",
            }
    await db.faculty_service.insert_one(doc)
    
    # FIX: Remove the non-serializable ObjectId before returning
    doc.pop("_id", None) 
    
    return {"ok": True, "row": doc}
# ----------------------------- SEND -----------------------------
# Robust + idempotent: mark as sent and (optionally) log email. Lack of recipient mapping will NOT error.

@router.post("/send/{fs_id}")
async def fs_send(fs_id: str):
    row = await db.faculty_service.find_one({"fs_id": fs_id})
    if not row:
        raise HTTPException(status_code=404, detail="Not found.")

    await db.faculty_service.update_one(
        {"fs_id": fs_id}, {"$set": {"status": "sent", "updated_at": _now_iso()}}
    )

    to_dept = row.get("to_department")

    # In-app notification to receiving department chair user(s)
    try:
        recipients = await _chair_user_ids_for_dept(to_dept or "")
        for uid in recipients:
            await create_notification(
                user_id=uid,
                title="Faculty Service: New request received",
                details=f"{row.get('from_department','')} sent a request for {row.get('course_code','')} – {row.get('course_title','')}.",
                meta={"route": "/chair/faculty-service", "fs_id": fs_id, "kind": "faculty_service_received"},
            )
    except Exception:
        # notifications should not block the request flow
        pass

    rec = RECIPIENT.get(to_dept or "")
    if rec:
        name, email = rec
        subj = f"Faculty Service Request: {row.get('course_code','')} - {row.get('course_title','')}"
        body = (
            f"Requesting Dept: {row.get('from_department')}\n"
            f"Requested Dept: {to_dept}\n"
            f"Course: {row.get('course_code')} - {row.get('course_title')}\n"
            f"Units: {row.get('units')}\n"
            f"Request ID: {fs_id}\n"
            f"Open in app: /chair/faculty-service?request={fs_id}\n"
        )
        await db.email_logs.insert_one({
            "email_id": f"EM{uuid4().hex[:8].upper()}",
            "to_name": name,
            "to_email": email,
            "subject": subj,
            "body": body,
            "created_at": _now_iso(),
            "type": "faculty_service_send",
            "fs_id": fs_id,
        })

    doc = await db.faculty_service.find_one({"fs_id": fs_id}, {"_id": 0})
    return {"ok": True, "row": doc}

# --------------------------- RESPOND ---------------------------

@router.post("/respond/{fs_id}")
async def fs_respond(fs_id: str, payload: Dict[str, Any] = Body(...)):
    row = await db.faculty_service.find_one({"fs_id": fs_id})
    if not row:
        raise HTTPException(status_code=404, detail="Not found.")

    faculty = payload.get("faculty") or {}
    day1 = payload.get("day1", "")
    begin1 = payload.get("begin1", "")
    end1 = END_BY_BEGIN.get(begin1, payload.get("end1", ""))
    day2 = payload.get("day2", "")
    begin2 = payload.get("begin2", "")
    end2 = END_BY_BEGIN.get(begin2, payload.get("end2", ""))
    remarks = payload.get("remarks", "")

    fac_out = {
        "faculty_id": faculty.get("faculty_id"),
        "first_name": faculty.get("first_name"),
        "last_name": faculty.get("last_name"),
        "email": faculty.get("email"),
    }
    if fac_out["faculty_id"] and (not fac_out["first_name"] or not fac_out["last_name"] or not fac_out["email"]):
        prof = await db.faculty_profiles.find_one(
            {"faculty_id": fac_out["faculty_id"]}, {"_id": 0, "first_name": 1, "last_name": 1, "user_id": 1}
        )
        if prof:
            fac_out["first_name"] = fac_out["first_name"] or prof.get("first_name")
            fac_out["last_name"] = fac_out["last_name"] or prof.get("last_name")
            user = await db.users.find_one({"user_id": prof.get("user_id")}, {"_id": 0, "email": 1})
            fac_out["email"] = fac_out["email"] or (user or {}).get("email")

    update = {
        "faculty": fac_out,
        "day1": day1, "begin1": begin1, "end1": end1,
        "day2": day2, "begin2": begin2, "end2": end2,
        "remarks": remarks,
        "status": "responded",
        "updated_at": _now_iso(),
    }
    await db.faculty_service.update_one({"fs_id": fs_id}, {"$set": update})

    # In-app notification back to the requesting department chair user(s)
    try:
        recipients = await _chair_user_ids_for_dept(row.get('from_department') or "")
        for uid in recipients:
            await create_notification(
                user_id=uid,
                title="Faculty Service: Request responded",
                details=f"{row.get('to_department','')} responded to {row.get('course_code','')} – {row.get('course_title','')}.",
                meta={"route": "/chair/faculty-service", "fs_id": fs_id, "kind": "faculty_service_responded"},
            )
    except Exception:
        pass
    doc = await db.faculty_service.find_one({"fs_id": fs_id}, {"_id": 0})
    return {"ok": True, "row": doc}

# --------------------------- REJECT ---------------------------

@router.post("/reject/{fs_id}")
async def fs_reject(fs_id: str, payload: Dict[str, Any] = Body(default={})):
    row = await db.faculty_service.find_one({"fs_id": fs_id})
    if not row:
        raise HTTPException(status_code=404, detail="Not found.")

    remarks = (payload.get("remarks") or "").strip()
    await db.faculty_service.update_one(
        {"fs_id": fs_id},
        {"$set": {"status": "rejected", "remarks": remarks, "updated_at": _now_iso()}}
    )

    # In-app notification back to the requesting department chair user(s)
    try:
        recipients = await _chair_user_ids_for_dept(row.get('from_department') or "")
        for uid in recipients:
            await create_notification(
                user_id=uid,
                title="Faculty Service: Request rejected",
                details=f"{row.get('to_department','')} rejected {row.get('course_code','')} – {row.get('course_title','')}. Remarks: {remarks or '—'}",
                meta={"route": "/chair/faculty-service", "fs_id": fs_id, "kind": "faculty_service_rejected"},
            )
    except Exception:
        pass
    # optional log stub (requester could be notified if mapped to an email)
    from_dept = row.get("from_department", "")
    rec = RECIPIENT.get(from_dept)
    to_name, to_email = (rec[0], rec[1]) if rec else (from_dept, "")

    await db.email_logs.insert_one({
        "email_id": f"EM{uuid4().hex[:8].upper()}",
        "to_name": to_name,
        "to_email": to_email,
        "subject": f"Faculty Service Request Rejected: {row.get('course_code','')}",
        "body": f"Request {fs_id} has been rejected.\nRemarks: {remarks}",
        "created_at": _now_iso(),
        "type": "faculty_service_reject",
        "fs_id": fs_id,
    })
    doc = await db.faculty_service.find_one({"fs_id": fs_id}, {"_id": 0})
    return {"ok": True, "row": doc}
