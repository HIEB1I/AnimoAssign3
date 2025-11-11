# backend/app/CHAIR/CHAIR_FacultyService.py
# -----------------------------------------------------------------------------
# Collections used:
#   - faculty_service    (new)   : stores request/response records
#   - courses                     : for course lookups (by course_code)
#   - faculty_profiles            : for faculty dropdown (owner department)
#   - users                       : to fetch faculty email
#   - email_logs         (new)   : stub for outbound emails (SMTP swappable)
#
# Router wiring (add to backend/app/main.py):
#   from .CHAIR.CHAIR_FacultyService import router as chair_faculty_service_router
#   app.include_router(chair_faculty_service_router)
# -----------------------------------------------------------------------------

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from uuid import uuid4

from fastapi import APIRouter, Body, HTTPException, Query
from ..main import db

router = APIRouter(prefix="/chair/faculty-service", tags=["chair", "faculty-service"])

# --- constants per spec ---
DAYS = ["M", "T", "W", "H", "F", "S"]
TIME_SLOTS = [
    "07:30 - 09:00",
    "09:15 - 10:45",
    "11:00 - 12:30",
    "12:45 - 14:15",
    "14:30 - 16:00",
    "16:15 - 17:45",
    "18:00 - 19:30",
    "19:45 - 21:00",
]
FROM_DEPT = "Software Technology"
TO_DEPTS = ["Information Technology", "Computer Technology"]
RECIPIENT = {
    "Information Technology": ("Danny Cheng", "danny.cheng@dlsu.edu.ph"),
    "Computer Technology": ("Katrina Ysabel Solomon", "katrina.solomon@dlsu.edu.ph"),
}

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def _normalize_code(code: Any) -> str:
    if isinstance(code, list):
        return (code[0] or "").upper()
    return str(code or "").upper()

async def _course_by_code(code: str) -> Optional[Dict[str, Any]]:
    if not code:
        return None
    doc = await db.courses.find_one(
        {"$or": [{"course_code": code}, {"course_code": [code]}]},
        {"_id": 0, "course_id": 1, "course_code": 1, "course_title": 1, "units": 1},
    )
    if not doc:
        # fallback regex
        doc = await db.courses.find_one(
            {"$or": [{"course_code": {"$regex": f"^{code}$", "$options": "i"}},
                     {"course_code": {"$in": [code]}}]},
            {"_id": 0, "course_id": 1, "course_code": 1, "course_title": 1, "units": 1},
        )
    if doc:
        doc["course_code"] = _normalize_code(doc.get("course_code"))
    return doc

async def _faculty_dropdown(dept_name: Optional[str]) -> List[Dict[str, Any]]:
    if dept_name not in TO_DEPTS:
        return []
    # find department_id by name/code
    dept = await db.departments.find_one(
        {"$or": [{"dept_name": dept_name}, {"dept_code": dept_name}, {"department_id": dept_name}]},
        {"_id": 0, "department_id": 1},
    )
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
    toDepartment: Optional[str] = Query(None, description="Populate faculty options for this TO dept")
):
    # courses (simple search; top 20)
    courses: List[Dict[str, Any]] = []
    if q:
        cur = db.courses.find(
            {"$or": [{"course_code": {"$regex": q, "$options": "i"}}, {"course_title": {"$regex": q, "$options": "i"}}]},
            {"_id": 0, "course_code": 1, "course_title": 1, "units": 1},
        ).limit(20)
        async for c in cur:
            courses.append({
                "code": _normalize_code(c.get("course_code")),
                "title": c.get("course_title") or "",
                "units": c.get("units"),
            })
    else:
        cur = db.courses.find({}, {"_id": 0, "course_code": 1, "course_title": 1, "units": 1}).limit(20)
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
        "departments": TO_DEPTS,
        "timeSlots": TIME_SLOTS,
        "days": DAYS,
        "from": FROM_DEPT,
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
async def fs_create(
    payload: Dict[str, Any] = Body(...),
):
    # requester fills these
    course_code = _normalize_code(payload.get("course_code"))
    units = payload.get("units", None)
    to_department = payload.get("to_department")
    course_title = (payload.get("course_title") or "").strip()

    if to_department not in TO_DEPTS:
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

    fs_id = f"FS{uuid4().hex[:10].upper()}"
    now = _now_iso()

    doc = {
        "fs_id": fs_id,
        "status": "draft",
        "created_at": now,
        "updated_at": now,
        # requester side
        "from_department": FROM_DEPT,
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
    # email stub
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
async def fs_respond(
    fs_id: str,
    payload: Dict[str, Any] = Body(...),
):
    row = await db.faculty_service.find_one({"fs_id": fs_id})
    if not row:
        raise HTTPException(status_code=404, detail="Not found.")

    # owner dept fills these
    faculty = payload.get("faculty") or {}
    day1 = payload.get("day1", "")
    begin1 = payload.get("begin1", "")
    end1 = payload.get("end1", "")
    day2 = payload.get("day2", "")
    begin2 = payload.get("begin2", "")
    end2 = payload.get("end2", "")
    remarks = payload.get("remarks", "")

    # normalize: if faculty only has faculty_id, fetch profile/email
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
