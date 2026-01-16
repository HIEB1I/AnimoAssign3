# app/Login/Login.py
from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, EmailStr

from app.main import db

# NO /api here – mount it in main.py with prefix="/api"
router = APIRouter(tags=["Login"])

# ----------------------------
# Existing email login models
# ----------------------------

class LoginRequest(BaseModel):
    email: EmailStr


class LoginResponse(BaseModel):
    userId: str
    email: EmailStr
    fullName: str
    roles: List[str]  # normalized, lowercase


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


def _fullname(user: Dict[str, Any]) -> str:
    first = (user.get("first_name") or "").strip()
    last = (user.get("last_name") or "").strip()
    full = f"{first} {last}".strip()
    return full or (user.get("email") or user.get("gmail") or "").strip() or "User"


@router.post("/login", response_model=LoginResponse)
async def login(payload: LoginRequest):
    user = await db["users"].find_one({"email": payload.email}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    roles = await _roles_for_user(user["user_id"]) or ["user"]

    return LoginResponse(
        userId=user["user_id"],
        email=user["email"],
        fullName=_fullname(user),
        roles=roles,
    )

# ----------------------------
# New Google auth-code login
# ----------------------------

TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"


class GoogleAuthCodeRequest(BaseModel):
    code: str


async def _exchange_code_for_tokens(code: str) -> Dict[str, Any]:
    client_id = os.getenv("GOOGLE_CLIENT_ID")
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET")
    redirect_uri = os.getenv("GOOGLE_REDIRECT_URI", "postmessage")

    if not client_id or not client_secret:
        raise HTTPException(
            status_code=500,
            detail="Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in backend environment.",
        )

    data = {
        "client_id": client_id,
        "client_secret": client_secret,
        "code": code,
        "grant_type": "authorization_code",
        "redirect_uri": redirect_uri,
    }

    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(TOKEN_URL, data=data)

    if r.status_code >= 400:
        # Return Google’s exact error text (super helpful for debugging)
        raise HTTPException(status_code=r.status_code, detail=r.text)

    return r.json()


async def _google_email_from_access_token(access_token: str) -> str:
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            USERINFO_URL,
            headers={"Authorization": f"Bearer {access_token}"},
        )

    if r.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid Google token (userinfo failed).")

    email = (r.json().get("email") or "").strip().lower()
    if not email:
        raise HTTPException(status_code=401, detail="Google account has no email.")
    return email


@router.post("/auth/google/login", response_model=LoginResponse)
async def google_login(payload: GoogleAuthCodeRequest):
    """
    Frontend sends:
      POST /api/auth/google/login
      { "code": "<auth_code>" }

    Backend:
      1) exchange code -> access_token (+ refresh_token sometimes)
      2) userinfo -> google email
      3) match email in users.gmail (fallback users.email)
      4) upsert google_token into that user
      5) return LoginResponse (same format as /login)
    """
    tokens = await _exchange_code_for_tokens(payload.code)

    access_token = tokens.get("access_token")
    refresh_token = tokens.get("refresh_token")  # may only appear on first consent
    scope = tokens.get("scope")
    expires_in = tokens.get("expires_in")

    if not access_token:
        raise HTTPException(status_code=401, detail="Google did not return access_token.")

    google_email = await _google_email_from_access_token(access_token)

    # Match against users collection "gmail" row (fallback to "email")
    user = await db["users"].find_one(
        {"$or": [{"gmail": google_email}, {"email": google_email}]},
        {"_id": 0}
    )
    if not user:
        # Step 5: no match -> error
        raise HTTPException(
            status_code=403,
            detail="This Google account is not registered in AnimoAssign.",
        )

    # Update token fields
    now = datetime.now(timezone.utc)

    # Keep any existing refresh_token if Google didn't return one this time
    existing = await db["users"].find_one(
        {"user_id": user["user_id"]},
        {"_id": 0, "google_token.refresh_token": 1}
    )
    existing_refresh = (
        (existing or {}).get("google_token", {}) or {}
    ).get("refresh_token")

    token_doc: Dict[str, Any] = {
        "access_token": access_token,
        "connected_email": google_email,
        "scope": scope,
        "expires_in": expires_in,
        "updated_at": now,
    }

    if refresh_token:
        token_doc["refresh_token"] = refresh_token
    elif existing_refresh:
        token_doc["refresh_token"] = existing_refresh

    # Step 3-4: insert/update under that user
    await db["users"].update_one(
        {"user_id": user["user_id"]},
        {"$set": {"google_token": token_doc}},
        upsert=False
    )

    roles = await _roles_for_user(user["user_id"]) or ["user"]

    # Return same response model
    return LoginResponse(
        userId=user["user_id"],
        email=user.get("email") or google_email,
        fullName=_fullname(user),
        roles=roles,
    )
