# backend/app/OM/OM_Profile.py
from fastapi import APIRouter, HTTPException, Query
from ..main import db  # reuse db

router = APIRouter(prefix="/om", tags=["om"])

@router.get("/profile")
async def om_profile(userId: str = Query(..., min_length=3)):
    user = await db["users"].find_one({"user_id": userId}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    roles = [r async for r in db["user_roles"].find({"user_id": userId}, {"_id": 0})]

    dept_ids = list({r.get("department_id") for r in roles if r.get("department_id")})
    departments = []
    if dept_ids:
        departments = [d async for d in db["departments"].find({"department_id": {"$in": dept_ids}}, {"_id": 0})]

    staff = await db["staff_profiles"].find_one({"user_id": userId}, {"_id": 0})

    return {
        "user": user,
        "roles": roles,
        "departments": departments,
        "staffProfile": staff,
    }
