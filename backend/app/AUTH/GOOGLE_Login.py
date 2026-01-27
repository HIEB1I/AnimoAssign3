from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Optional, List

import httpx
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from app.main import db  # adjust if your db is defined elsewhere

router = APIRouter(tags=["Auth"])

TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"


class GoogleLoginBody(BaseModel):
    code: Optional[str] = None
    accessToken: Optional[str] = None  # optional fallback


async def exchange_code(code: str) -> dict:
    client_id = os.getenv("GOOGLE_CLIENT_ID")
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET")
    redirect_uri = os.getenv("GOOGLE_REDIRECT_URI", "postmessage")

    if not client_id or not client_secret:
        raise HTTPException(
            status_code=500,
            detail="Missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET in backend container env.",
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
        # bubble up Google's error text so you see EXACTLY what's wrong
        raise HTTPException(status_code=r.status_code, detail=r.text)

    return r.json()


async def get_google_email(access_token: str) -> str:
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"})

    if r.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid Google token (cannot fetch userinfo).")

    email = (r.json().get("email") or "").strip().lower()
    if not email:
        raise HTTPException(status_code=401, detail="Google account has no email.")
    return email


async def get_roles_for_user(user_id: str) -> List[str]:
    assignments = await db.role_assignments.find({"user_id": user_id}).to_list(length=500)
    role_ids = [a.get("role_id") for a in assignments if a.get("role_id")]
    if not role_ids:
        return []
    roles_docs = await db.user_roles.find({"role_id": {"$in": role_ids}}).to_list(length=200)
    return [str(r.get("role_type")) for r in roles_docs if r.get("role_type")]


@router.post("/auth/google/login")
async def google_login(
    payload: GoogleLoginBody,
    authorization: Optional[str] = Header(default=None),
):
    #  Accept token from:
    # 1) auth-code in JSON body (preferred)
    # 2) Authorization: Bearer <access_token>
    # 3) accessToken in JSON body (fallback)

    access_token: Optional[str] = None
    refresh_token: Optional[str] = None
    scope: Optional[str] = None
    expires_in: Optional[int] = None

    if payload.code:
        tokens = await exchange_code(payload.code)
        access_token = tokens.get("access_token")
        refresh_token = tokens.get("refresh_token")
        scope = tokens.get("scope")
        expires_in = tokens.get("expires_in")
    elif authorization and authorization.lower().startswith("bearer "):
        access_token = authorization.split(" ", 1)[1].strip()
    elif payload.accessToken:
        access_token = payload.accessToken.strip()

    if not access_token:
        raise HTTPException(
            status_code=401,
            detail="Missing Google login 'code' in body, or Authorization: Bearer <token>.",
        )

    email = await get_google_email(access_token)

    # Step 2: match in users collection (gmail first, then email)
    user = await db.users.find_one({"$or": [{"gmail": email}, {"email": email}]})
    if not user:
        raise HTTPException(status_code=403, detail="Google email not registered in AnimoAssign.")

    now = datetime.now(timezone.utc)

    # Step 3-4: upsert token under the user
    update_doc = {
        "google_token.access_token": access_token,
        "google_token.connected_email": email,
        "google_token.scope": scope,
        "google_token.expires_in": expires_in,
        "google_token.updated_at": now,
    }
    # only save refresh_token if Google returned it
    if refresh_token:
        update_doc["google_token.refresh_token"] = refresh_token

    await db.users.update_one({"_id": user["_id"]}, {"$set": update_doc})

    user_id = user.get("user_id")
    roles = await get_roles_for_user(user_id) if user_id else []

    return {"email": email, "user_id": user_id, "roles": roles}
