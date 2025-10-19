# backend/app/Login/Login.py
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, EmailStr
from ..main import db  # <-- reuse the db created in main.py

router = APIRouter(tags=["login"])

class LoginRequest(BaseModel):
    email: EmailStr

class LoginResponse(BaseModel):
    userId: str
    email: EmailStr
    fullName: str
    roles: list[str]

@router.post("/login", response_model=LoginResponse)
async def login(payload: LoginRequest):
    # seed has users with: user_id, email, first_name, last_name, ...  :contentReference[oaicite:0]{index=0}
    user = await db["users"].find_one({"email": payload.email})
    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    user_id = user["user_id"]
    roles_cur = db["user_roles"].find({"user_id": user_id})
    role_names = [r async for r in roles_cur]
    role_names = [r.get("role_type", "User") for r in role_names] or ["User"]

    full_name = f'{(user.get("first_name") or "").strip()} {(user.get("last_name") or "").strip()}'.strip() or user["email"]

    return LoginResponse(
        userId=user_id,
        email=user["email"],
        fullName=full_name,
        roles=role_names,
    )