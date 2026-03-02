# backend/app/session.py
from __future__ import annotations

import os
import hmac
import hashlib
import secrets
from datetime import datetime, timezone, timedelta
from typing import Any, Dict

from fastapi import Response

COOKIE_NAME = os.getenv("ANIMOASSIGN_SESSION_COOKIE", "aa_session")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _secret_bytes() -> bytes:
    # IMPORTANT: set ANIMOASSIGN_SESSION_SECRET in prod
    sec = (
        os.getenv("ANIMOASSIGN_SESSION_SECRET")
        or os.getenv("SESSION_SECRET")
        or "dev-unsafe-secret-change-me"
    )
    return sec.encode("utf-8")


def session_max_age_seconds() -> int:
    # default: 30 days
    raw = os.getenv("ANIMOASSIGN_SESSION_MAX_AGE_SECONDS") or "2592000"
    try:
        v = int(raw)
        return max(60, v)
    except Exception:
        return 2592000


def cookie_settings() -> Dict[str, Any]:
    # Secure cookies in HTTPS prod, not in local dev
    raw_secure = os.getenv("ANIMOASSIGN_COOKIE_SECURE")
    if raw_secure is None:
        env = (os.getenv("ANIMOASSIGN_ENV") or os.getenv("ENV") or "").strip().lower()
        secure = env in {"prod", "production"}
    else:
        secure = raw_secure.strip().lower() in {"1", "true", "yes", "y"}

    return {
        "httponly": True,
        "secure": bool(secure),
        "samesite": (os.getenv("ANIMOASSIGN_COOKIE_SAMESITE") or "lax"),
        "path": "/",  # must include /api/socket.io too
        "max_age": session_max_age_seconds(),
    }


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def hash_session_token(token: str) -> str:
    token = (token or "").strip()
    return hmac.new(_secret_bytes(), token.encode("utf-8"), hashlib.sha256).hexdigest()


async def rotate_user_session(db, user_id: str) -> str:
    """
    Creates a NEW session token, stores only its hash in users.session.hash.
    This automatically invalidates any older cookie/session for this user.
    """
    token = new_session_token()
    now = _utcnow()
    expires_at = now + timedelta(seconds=session_max_age_seconds())
    await db["users"].update_one(
        {"user_id": user_id},
        {"$set": {"session": {"hash": hash_session_token(token), "created_at": now, "expires_at": expires_at}}},
    )
    return token


async def clear_user_session(db, user_id: str) -> None:
    await db["users"].update_one({"user_id": user_id}, {"$unset": {"session": ""}})


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(COOKIE_NAME, token, **cookie_settings())


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(COOKIE_NAME, path="/")