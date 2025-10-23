# backend/app/Login/Login.py
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, EmailStr
from app.main import db  # import the shared db instance

router = APIRouter(prefix="/api", tags=["Login"])

# ---------- Pydantic Models ----------
class LoginRequest(BaseModel):
    email: EmailStr

class LoginResponse(BaseModel):
    userId: str
    email: EmailStr
    fullName: str
    roles: list[str]

# ---------- Route ----------
@router.post("/login", response_model=LoginResponse)
async def login(payload: LoginRequest):
    """
    Login endpoint — validates user by email, fetches their active roles,
    and returns basic user info + roles.
    """
    # Find user by email
    user = await db["users"].find_one({"email": payload.email})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Fetch active roles for this user
    roles_cursor = db["user_roles"].find(
        {"user_id": user["user_id"], "is_active": True},
        {"role_type": 1, "_id": 0}
    )
    roles = [doc["role_type"] async for doc in roles_cursor]

    # Default fallback if user has no active roles
    if not roles:
        roles = ["user"]

    # Compose full name
    first = (user.get("first_name") or "").strip()
    last = (user.get("last_name") or "").strip()
    full_name = f"{first} {last}".strip() or user["email"]

    # Return unified response
    return LoginResponse(
        userId=user["user_id"],
        email=user["email"],
        fullName=full_name,
        roles=roles,
    )
