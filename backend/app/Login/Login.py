# app/Login/Login.py
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, EmailStr
from typing import List, Set
from app.main import db
import re

router = APIRouter(tags=["Login"])

class LoginRequest(BaseModel):
    email: EmailStr

class LoginResponse(BaseModel):
    userId: str
    email: EmailStr
    fullName: str
    roles: List[str]  # normalized: snake_case, lowercase

def _slugify(s: str) -> str:
    # "Office Manager" -> "office_manager", "APO" -> "apo"
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")

async def _roles_for_user(user_id: str) -> List[str]:
    roles: Set[str] = set()

    # 1) Primary source: role_assignments -> user_roles
    ra = db["role_assignments"].find({"user_id": user_id}, {"_id": 0, "role_id": 1})
    role_ids = [doc["role_id"] async for doc in ra]
    if role_ids:
        ur = db["user_roles"].find({"role_id": {"$in": role_ids}}, {"_id": 0, "role_type": 1})
        for doc in await ur.to_list(None):
            if doc.get("role_type"):
                roles.add(_slugify(doc["role_type"]))  # e.g., "APO" -> "apo"

    # 2) Fallback inference based on existing profile docs (still DB-driven)
    if not roles:
        if await db["faculty_profiles"].find_one({"user_id": user_id}, {"_id": 1}):
            roles.add("faculty")
        if await db["student_profiles"].find_one({"user_id": user_id}, {"_id": 1}):
            roles.add("student")
        staff = await db["staff_profiles"].find_one({"user_id": user_id}, {"_id": 0, "position_title": 1})
        if staff and staff.get("position_title"):
            pos = _slugify(staff["position_title"])
            if "office_manager" in pos or pos.endswith("_om"):
                roles.add("office_manager")
            if "apo" in pos:
                roles.add("apo")

    return sorted(roles)

@router.post("/login", response_model=LoginResponse)
async def login(payload: LoginRequest):
    user = await db["users"].find_one({"email": payload.email}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    roles = await _roles_for_user(user["user_id"]) or ["user"]

    first = (user.get("first_name") or "").strip()
    last  = (user.get("last_name") or "").strip()
    full  = f"{first} {last}".strip() or user["email"]

    return LoginResponse(
        userId=user["user_id"],
        email=user["email"],
        fullName=full,
        roles=roles,
    )
