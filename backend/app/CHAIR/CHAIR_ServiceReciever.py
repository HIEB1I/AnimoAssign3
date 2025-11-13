# backend/app/CHAIR/CHAIR_ServiceReciever.py
# -----------------------------------------------------------------------------
# Receiver-only API (list received, faculty dropdown, respond, reject)
# Collections:
#   - faculty_service
#   - courses
#   - faculty_profiles
#   - users
#   - email_logs
# -----------------------------------------------------------------------------

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, HTTPException, Query
from ..main import db

router = APIRouter(prefix="/chair/service-receiver", tags=["chair", "service-receiver"])

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

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

async def _find_department(query: str) -> Optional[Dict[str, Any]]:
    return await db.departments.find_one(
        {"$or": [{"dept_name": query}, {"dept_code": query}, {"department_id": query}]},
        {"_id": 0, "department_id": 1, "dept_name": 1}
    )

async def _faculty_dropdown(dept_name: Optional[str]) -> List[Dict[str, Any]]:
    if not dept_name:
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

@router.get("/options")
async def sr_options(
    toDepartment: Optional[str] = Query(None, description="Populate faculty options for this TO dept"),
):
    faculty_opts = await _faculty_dropdown(toDepartment) if toDepartment else []
    return {
        "ok": True,
        "timeBegins": BEGIN,
        "days": DAYS,
        "facultyOptions": faculty_opts,
    }

@router.get("/list")
async def sr_list(
    dept: str = Query(..., description="Receiver department name"),
    status: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
):
    q: Dict[str, Any] = {"to_department": dept}
    if status:
        q["status"] = status
    if search:
        q["$or"] = [
            {"course_code": {"$regex": search, "$options": "i"}},
            {"course_title": {"$regex": search, "$options": "i"}},
        ]

    cur = db.faculty_service.find(q, {"_id": 0}).sort([("created_at", -1)])
    rows = [doc async for doc in cur]
    return {"ok": True, "rows": rows}

@router.post("/respond/{fs_id}")
async def sr_respond(fs_id: str, payload: Dict[str, Any] = Body(...)):
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

@router.post("/reject/{fs_id}")
async def sr_reject(fs_id: str, payload: Dict[str, Any] = Body(default={})):
    row = await db.faculty_service.find_one({"fs_id": fs_id})
    if not row:
        raise HTTPException(status_code=404, detail="Not found.")

    remarks = (payload.get("remarks") or "").strip()
    await db.faculty_service.update_one(
        {"fs_id": fs_id},
        {"$set": {"status": "rejected", "remarks": remarks, "updated_at": _now_iso()}}
    )
    await db.email_logs.insert_one({
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
