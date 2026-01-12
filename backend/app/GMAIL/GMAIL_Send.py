from __future__ import annotations

import base64
from email.mime.text import MIMEText
from typing import Optional

import httpx
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, EmailStr, Field

router = APIRouter(tags=["Gmail"])

PREFIX = "[AnimoAssign] "


class GmailSendRequest(BaseModel):
    to: EmailStr
    subject: str = Field(default="", max_length=200)  # user-provided part only
    body: str = Field(min_length=1)
    accessToken: Optional[str] = None  # fallback; prefer Authorization header


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

    # Build RFC 2822 message
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
