# app/Login/Login.py
import os
import json
import base64
import secrets
import uuid
from typing import List, Optional
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse, HTMLResponse
from pydantic import BaseModel, EmailStr

from app.main import db

router = APIRouter(tags=["Login"])  # still mounted in main.py (no /api here)

# --- Config ---
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET")
GOOGLE_REDIRECT_URI = os.getenv("GOOGLE_REDIRECT_URI")  # e.g. https://api.example.com/api/auth/google/callback
ALLOWED_DOMAIN = (os.getenv("ALLOWED_DOMAIN") or "dlsu.edu.ph").lower()
FRONTEND_FALLBACK = os.getenv("FRONTEND_FALLBACK") or "http://localhost:5173/auth/callback"

# --- Models ---
class LoginResponse(BaseModel):
    userId: str
    email: EmailStr
    fullName: str
    roles: List[str]

# --- Helpers ---
async def _roles_for_user(user_id: str) -> List[str]:
    ra_cursor = db["role_assignments"].find(
        {"user_id": user_id},
        {"_id": 0, "role_id": 1},
    )
    role_ids = [doc["role_id"] async for doc in ra_cursor]
    if not role_ids:
        return []

    ur_cursor = db["user_roles"].find(
        {"role_id": {"$in": role_ids}},
        {"_id": 0, "role_type": 1},
    )
    raw = [doc["role_type"] for doc in await ur_cursor.to_list(None)]
    return [str(r).strip().lower() for r in raw if r]

def _b64url(obj: dict) -> str:
    # URL-safe base64 without padding
    j = json.dumps(obj, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(j).decode().rstrip("=")

# --- Google OAuth entry ---
@router.get("/auth/google/start")
async def google_start(request: Request, return_to: Optional[str] = None):
    if not (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI):
        raise HTTPException(500, "Google OAuth not configured")

    state = secrets.token_urlsafe(24)

    params = {
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": "openid email profile",
        "access_type": "offline",
        "prompt": "select_account",
        "state": state,
    }

    resp = RedirectResponse(
        url="https://accounts.google.com/o/oauth2/v2/auth?" + urlencode(params)
    )
    # short-lived cookies to validate the flow and pass the SPA return url
    resp.set_cookie(
        "oauth_state",
        state,
        max_age=600,
        secure=True,
        httponly=True,
        samesite="lax",
    )
    return resp
