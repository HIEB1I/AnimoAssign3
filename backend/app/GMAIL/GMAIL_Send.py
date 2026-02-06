from __future__ import annotations

import base64
from email.mime.text import MIMEText
from typing import Optional

import httpx
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, EmailStr, Field

from app.main import db

router = APIRouter(tags=["Gmail"])

PREFIX = "[AnimoAssign] "


class GmailSendRequest(BaseModel):
    to: EmailStr
    subject: str = Field(default="", max_length=200)  
    body: str = Field(min_length=1)
    accessToken: Optional[str] = None
    body_html: Optional[str] = None   

class GmailSendByUserRequest(BaseModel):
    userId: str
    to: EmailStr = "john_fredrick_tario@dlsu.edu.ph"
    subject: str = Field(default="", max_length=200)  
    body: str = Field(min_length=1)
    body_html: Optional[str] = None  


import os
from datetime import datetime, timezone
from typing import Any, Dict

TOKEN_URL = "https://oauth2.googleapis.com/token"
 
async def _build_gmail_raw_message(
    *,
    to_email: str,
    subject: str,
    body_text: str,
    body_html: str | None = None,
    from_email: str,
    from_name: str = "AnimoAssign",
) -> str:
    msg = EmailMessage()
    msg["To"] = to_email
    msg["From"] = f"{from_name} <{from_email}>"
    msg["Subject"] = subject

    # plain text fallback
    msg.set_content(body_text or "")

    # HTML alternative (only if provided)
    if body_html:
        msg.add_alternative(body_html, subtype="html")

    return base64.urlsafe_b64encode(msg.as_bytes()).decode("utf-8")

async def _refresh_access_token(refresh_token: str) -> Dict[str, Any]:
    client_id = os.getenv("GOOGLE_CLIENT_ID")
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise HTTPException(
            status_code=500,
            detail="Missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET in backend container env.",
        )

    data = {
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }

    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(TOKEN_URL, data=data)

    if r.status_code >= 400:
        raise HTTPException(status_code=r.status_code, detail=r.text)

    return r.json()


async def _send_raw_gmail(raw_b64: str, token: str) -> httpx.Response:
    url = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(timeout=20) as client:
        return await client.post(url, headers=headers, json={"raw": raw_b64})


@router.post("/gmail/send/by-user")
async def gmail_send_by_user(payload: GmailSendByUserRequest):
    user = await db.users.find_one({"user_id": payload.userId})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    gt = (user.get("google_token") or {})
    access_token = (gt.get("access_token") or "").strip()
    refresh_token = (gt.get("refresh_token") or "").strip()

    if not access_token and not refresh_token:
        raise HTTPException(status_code=401, detail="User has no connected Google token. Please log in with Google again.")

    user_subject = (payload.subject or "").strip()
    final_subject = PREFIX + user_subject if user_subject else PREFIX.rstrip()

   
    connected_email = (gt.get("connected_email") or user.get("gmail") or user.get("email") or "").strip() or str(payload.to)

    if payload.body_html:
        raw_b64 = _build_gmail_raw_message(
            to_email=str(payload.to),
            subject=final_subject,
            body_text=payload.body,
            body_html=payload.body_html,
            from_email=connected_email,
            from_name="AnimoAssign",
        )
    else:
        msg = MIMEText(payload.body, _subtype="plain", _charset="utf-8")
        msg["To"] = str(payload.to)
        msg["Subject"] = final_subject
        raw_b64 = base64.urlsafe_b64encode(msg.as_bytes()).decode("utf-8")

    
    if access_token:
        r = await _send_raw_gmail(raw_b64, access_token)
        if r.status_code < 400:
            return r.json()

    
        if r.status_code != 401:
            raise HTTPException(status_code=403 if r.status_code == 403 else r.status_code, detail=r.text)

    if not refresh_token:
        raise HTTPException(status_code=401, detail="Gmail token is invalid/expired and no refresh_token is available. Reconnect Gmail.")

    tokens = await _refresh_access_token(refresh_token)
    new_access = (tokens.get("access_token") or "").strip()
    if not new_access:
        raise HTTPException(status_code=401, detail="Failed to refresh Google access token.")

    now = datetime.now(timezone.utc)
    await db.users.update_one(
        {"user_id": payload.userId},
        {"$set": {
            "google_token.access_token": new_access,
            "google_token.updated_at": now,
            "google_token.expires_in": tokens.get("expires_in"),
            "google_token.scope": tokens.get("scope")
        }}
    )

    r2 = await _send_raw_gmail(raw_b64, new_access)
    if r2.status_code == 401:
        raise HTTPException(status_code=401, detail="Gmail token is invalid/expired. Reconnect Gmail.")
    if r2.status_code >= 400:
        raise HTTPException(status_code=403 if r2.status_code == 403 else r2.status_code, detail=r2.text)

    return r2.json()

@router.post("/gmail/send")
async def gmail_send(payload: GmailSendRequest, authorization: Optional[str] = Header(default=None)):
    # Prefer Authorization: Bearer <token>
    token: Optional[str] = None
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
    elif payload.accessToken:
        token = payload.accessToken.strip()

    if not token:
        raise HTTPException(
            status_code=401,
            detail="Missing Gmail access token. Provide Authorization: Bearer <token>.",
        )

    user_subject = (payload.subject or "").strip()
    final_subject = PREFIX + user_subject if user_subject else PREFIX.rstrip()

    if payload.body_html:
        raw = _build_gmail_raw_message(
            to_email=str(payload.to),
            subject=final_subject,
            body_text=payload.body,
            body_html=payload.body_html,
            from_email=str(payload.to),   
            from_name="AnimoAssign",
        )
    else:
        msg = MIMEText(payload.body, _subtype="plain", _charset="utf-8")
        msg["To"] = payload.to
        msg["Subject"] = final_subject
        raw = base64.urlsafe_b64encode(msg.as_bytes()).decode("utf-8")
    
    url = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
    headers = {"Authorization": f"Bearer {token}"}

    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(url, headers=headers, json={"raw": raw})

    if r.status_code == 401:
        raise HTTPException(status_code=401, detail="Gmail token is invalid/expired. Reconnect Gmail.")
    if r.status_code >= 400:
        raise HTTPException(status_code=r.status_code, detail=r.text)

    return r.json()

