# backend/app/SESSION/Session.py
from __future__ import annotations

from fastapi import APIRouter, Request, Response, HTTPException

from app.db import get_db
from app.AUTH.session_token import COOKIE_NAME, decode_session, cookie_delete_options

router = APIRouter(tags=["Session"])

db = get_db()

@router.get("/session/me")
def session_me(request: Request):
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=401, detail="No session cookie")

    payload = decode_session(token)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid session")

    # payload contains { userId, email, fullName, roles }
    return payload

@router.post("/session/logout")
def session_logout(response: Response):
    response.delete_cookie(COOKIE_NAME, **cookie_delete_options())
    return {"ok": True}
