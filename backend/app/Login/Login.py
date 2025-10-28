# app/Login/Login.py
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, EmailStr
from typing import List
from app.main import db

# NO /api here – we'll mount it in main.py
router = APIRouter(tags=["Login"])

class LoginRequest(BaseModel):
    email: EmailStr

class LoginResponse(BaseModel):
    userId: str
    email: EmailStr
    fullName: str
    roles: List[str]   # normalized, lowercase

async def _roles_for_user(user_id: str) -> List[str]:
    # role_assignments.user_id → role_id → user_roles.role_type
    ra_cursor = db["role_assignments"].find(
        {"user_id": user_id},
        {"_id": 0, "role_id": 1}
    )
    role_ids = [doc["role_id"] async for doc in ra_cursor]
    if not role_ids:
        return []

    ur_cursor = db["user_roles"].find(
        {"role_id": {"$in": role_ids}},
        {"_id": 0, "role_type": 1}
    )
    raw = [doc["role_type"] for doc in await ur_cursor.to_list(None)]
    return [str(r).strip().lower() for r in raw if r]

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
