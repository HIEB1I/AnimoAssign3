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

router = APIRouter(prefix="/chair/faculty-service", tags=["chair", "faculty-service"])

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
RECIPIENT = {
    "Department of Information Technology": ("Danny Cheng", "danny.cheng@dlsu.edu.ph"),
    "Department of Computer Technology": ("Katrina Ysabel Solomon", "katrina.solomon@dlsu.edu.ph"),
    "Department of Literature": ("Shirley Lua", "shirley.lua@dlsu.edu.ph"),
    # You can add more here when needed
}

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def _normalize_code(code: Any) -> str:
    if isinstance(code, list):
        return (code[0] or "").upper()
    return str(code or "").upper()

async def _find_department(query: str) -> Optional[Dict[str, Any]]:
    """Find a department by name/code/id."""
    return await db.departments.find_one(
        {"$or": [{"dept_name": query}, {"dept_code": query}, {"department_id": query}]},
        {"_id": 0, "department_id": 1, "dept_name": 1}
    )

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
    if not dept_name or dept_name not in DEPTS:
        return []
    dept = await _find_department(dept_name)
    dep_id = (dept or {}).get("department_id")
    if not dep_id:
        return []
    pipeline = [
        {"$match": {"department_id": dep_id}},
        {"$project": {"_id": 0, "faculty_id": 1, "user_id": 1, "first_name": 1, "last_name": 1}},
        {"$lookup": {"from": "users", "localField": "user_id", "foreignField": "user_id", "as": "u"}},
        {"$addFields": {"email": {"$ifNull": [{"$arrayElemAt": ["$u.email", 0]}, ""]}}},
        {"$project": {"u": 0}},
        {"$sort": {"last_name": 1, "first_name": 1}},
    ]
    out: List[Dict[str, Any]] = []
    async for r in db.faculty_profiles.aggregate(pipeline):
        out.append({
            "faculty_id": r.get("faculty_id"),
            "first_name": r.get("first_name") or "",
            "last_name": r.get("last_name") or "",
            "email": r.get("email") or "",
            "label": f'{(r.get("last_name") or "").upper()}, {(r.get("first_name") or "").upper()}',
        })
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

    return {
        "ok": True,
        "courses": courses,
        # the full long-form department names (spec)
        "departments": DEPTS,
        "timeBegins": BEGIN,
        "days": DAYS,
        "facultyOptions": faculty_opts,
    }

# ---------------------------- LIST ----------------------------

@router.get("/list")
async def fs_list(
    status: Optional[str] = Query(None),
    dept: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
):
    q: Dict[str, Any] = {}
    if status:
        q["status"] = status
    if dept:
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
    # NEW: accept actual requester department from payload; fallback to name if missing
    from_department = (payload.get("from_department") or "").strip()

    if to_department not in DEPTS:
        raise HTTPException(status_code=400, detail="to_department must be one of the predefined departments.")
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

    # basic sanity on from_department (don’t let it be empty or equal to TO if clients misbehave)
    if not from_department:
        # attempt to infer from the owning course department (best effort)
        c = await _course_by_code(course_code)
        if c and c.get("department_id"):
            dept = await db.departments.find_one({"department_id": c["department_id"]}, {"_id":0, "dept_name":1})
            if dept and dept.get("dept_name"): from_department = dept["dept_name"]
    if not from_department:
        raise HTTPException(status_code=400, detail="from_department is required.")

    fs_id = f"FS{uuid4().hex[:10].upper()}"
    now = _now_iso()
    doc = {
        "fs_id": fs_id,
        "status": "sent",  # immediately mark as sent when created+emailed via UI button
        "created_at": now,
        "updated_at": now,
        "from_department": from_department,
        "to_department": to_department,
        "course_code": course_code,
        "course_title": course_title,
        "units": units,
        # owner side (empty until response)
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
    return {"ok": True, "row": doc}

# ----------------------------- SEND -----------------------------

@router.post("/send/{fs_id}")
async def fs_send(fs_id: str):
    row = await db.faculty_service.find_one({"fs_id": fs_id})
    if not row:
        raise HTTPException(status_code=404, detail="Not found.")
    to_dept = row.get("to_department")
    rec = RECIPIENT.get(to_dept or "")
    if not rec:
        raise HTTPException(status_code=400, detail="Recipient not configured for target department.")
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
    await db.faculty_service.update_one(
        {"fs_id": fs_id},
        {"$set": {"status": "sent", "updated_at": _now_iso()}},
    )
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
    # optional log stub (requester could be notified if mapped to an email)
    await db.email_logs.insert_one({
        "email_id": f"EM{uuid4().hex[:8].upper()}",
        "to_name": row.get("from_department", ""),
        "to_email": "",
        "subject": f"Faculty Service Request Rejected: {row.get('course_code','')}",
        "body": f"Request {fs_id} has been rejected.\nRemarks: {remarks}",
        "created_at": _now_iso(),
        "type": "faculty_service_reject",
        "fs_id": fs_id,
    })
    doc = await db.faculty_service.find_one({"fs_id": fs_id}, {"_id": 0})
    return {"ok": True, "row": doc}
