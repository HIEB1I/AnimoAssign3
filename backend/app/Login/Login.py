# backend/app/Login/Login.py
from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import List, Dict, Any

import httpx
from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, EmailStr

from app.db import get_db
from app.AUTH.session_token import COOKIE_NAME, encode_session, cookie_set_options

router = APIRouter(tags=["Login"])
db = get_db()

# ----------------------------
# Models
# ----------------------------
class LoginRequest(BaseModel):
    email: EmailStr

class LoginResponse(BaseModel):
    userId: str
    email: EmailStr
    fullName: str
    roles: List[str]

# ----------------------------
# Helpers (SYNC pymongo)
# ----------------------------
def _roles_for_user(user_id: str) -> List[str]:
    role_ids = [doc.get("role_id") for doc in db["role_assignments"].find({"user_id": user_id}, {"_id": 0, "role_id": 1})]
    role_ids = [r for r in role_ids if r]
    if not role_ids:
        return []

    raw = [doc.get("role_type") for doc in db["user_roles"].find({"role_id": {"$in": role_ids}}, {"_id": 0, "role_type": 1})]
    return [str(r).strip().lower() for r in raw if r]

def _fullname(user: Dict[str, Any]) -> str:
    first = (user.get("first_name") or "").strip()
    last = (user.get("last_name") or "").strip()
    full = f"{first} {last}".strip()
    return full or (user.get("email") or user.get("gmail") or "").strip() or "User"

def _set_session_cookie(resp: Response, payload: Dict[str, Any]) -> None:
    token = encode_session(payload)
    resp.set_cookie(
        key=COOKIE_NAME,
        value=token,
        **cookie_set_options(),
    )

# ----------------------------
# Email login (optional)
# ----------------------------
@router.post("/login", response_model=LoginResponse)
def login(payload: LoginRequest, response: Response):
    user = db["users"].find_one({"email": payload.email}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    roles = _roles_for_user(user["user_id"]) or ["user"]
    out = LoginResponse(
        userId=user["user_id"],
        email=user["email"],
        fullName=_fullname(user),
        roles=roles,
    )

    _set_session_cookie(response, out.model_dump())
    return out

# ----------------------------
# Google auth
# ----------------------------
TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"

class GoogleAuthCodeRequest(BaseModel):
    code: str

class GoogleConnectRequest(BaseModel):
    userId: str
    code: str

async def _exchange_code_for_tokens(code: str) -> Dict[str, Any]:
    client_id = os.getenv("GOOGLE_CLIENT_ID")
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET")
    redirect_uri = os.getenv("GOOGLE_REDIRECT_URI", "postmessage")

    if not client_id or not client_secret:
        raise HTTPException(status_code=500, detail="Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.")

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
        raise HTTPException(status_code=r.status_code, detail=r.text)

    return r.json()

async def _google_email_from_access_token(access_token: str) -> str:
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"})

    if r.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid Google token (userinfo failed).")

    email = (r.json().get("email") or "").strip().lower()
    if not email:
        raise HTTPException(status_code=401, detail="Google account has no email.")
    return email

# ----------------------------
# 1) Google LOGIN (identity only cookie set)
# ----------------------------
@router.post("/auth/google/login", response_model=LoginResponse)
async def google_login(payload: GoogleAuthCodeRequest, response: Response):
    tokens = await _exchange_code_for_tokens(payload.code)
    access_token = tokens.get("access_token")
    if not access_token:
        raise HTTPException(status_code=401, detail="Google did not return access_token.")

    google_email = await _google_email_from_access_token(access_token)

    user = db["users"].find_one({"$or": [{"gmail": google_email}, {"email": google_email}]}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=403, detail="This Google account is not registered in AnimoAssign.")

    roles = _roles_for_user(user["user_id"]) or ["user"]

    out = LoginResponse(
        userId=user["user_id"],
        email=user.get("email") or google_email,
        fullName=_fullname(user),
        roles=roles,
    )

    #  create cookie session
    _set_session_cookie(response, out.model_dump())
    return out

# ----------------------------
# 2) Google CONNECT (store refresh token once)
# ----------------------------
@router.post("/auth/google/connect")
async def google_connect(payload: GoogleConnectRequest):
    user = db["users"].find_one({"user_id": payload.userId}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")

    tokens = await _exchange_code_for_tokens(payload.code)

    access_token = tokens.get("access_token")
    refresh_token = tokens.get("refresh_token")  # might only appear once
    scope = tokens.get("scope")
    expires_in = tokens.get("expires_in")

    if not access_token:
        raise HTTPException(status_code=401, detail="Google did not return access_token.")

    google_email = await _google_email_from_access_token(access_token)

    allowed_emails = set(
        x.strip().lower()
        for x in [user.get("gmail") or "", user.get("email") or ""]
        if x
    )
    if google_email not in allowed_emails:
        raise HTTPException(status_code=403, detail="Selected Google account does not match this AnimoAssign user.")

    existing = db["users"].find_one(
        {"user_id": payload.userId},
        {"_id": 0, "google_token.refresh_token": 1}
    ) or {}
    existing_refresh = ((existing.get("google_token") or {}) or {}).get("refresh_token")

    now = datetime.now(timezone.utc)
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

    #  creates google_token field if missing
    db["users"].update_one(
        {"user_id": payload.userId},
        {"$set": {"google_token": token_doc}},
        upsert=False
    )

    return {"ok": True, "connected_email": google_email, "has_refresh": bool(token_doc.get("refresh_token"))}

# ----------------------------
# 3) Status endpoint
# ----------------------------
@router.get("/auth/google/status")
def google_status(userId: str = Query(...)):
    user = db["users"].find_one(
        {"user_id": userId},
        {"_id": 0, "google_token": 1}
    )
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")

    gt = (user.get("google_token") or {})
    return {
        "ok": True,
        "connected_email": gt.get("connected_email"),
        "has_google_token": bool(gt),
        "has_refresh": bool(gt.get("refresh_token")),
        "scope": gt.get("scope"),
        "updated_at": gt.get("updated_at"),
    }
