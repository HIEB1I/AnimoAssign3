# backend/app/AUTH/session_jwt.py
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Tuple

from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

COOKIE_NAME = "animo_session"

# How long the session cookie is valid (seconds)
SESSION_MAX_AGE = int(os.getenv("SESSION_MAX_AGE", str(60 * 60 * 24 * 7)))  # 7 days default

def _secret_key() -> str:
    key = os.getenv("SESSION_SECRET") or os.getenv("SECRET_KEY")
    if not key:
        # NOTE: set SESSION_SECRET in env for production
        key = "dev-insecure-session-secret-change-me"
    return key

def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(_secret_key(), salt="animoassign-session")

def encode_session_token(payload: Dict[str, Any]) -> str:
    # You can add issued-at if you want
    payload = dict(payload)
    payload["iat"] = datetime.now(timezone.utc).isoformat()
    return _serializer().dumps(payload)

def decode_session_token(token: str) -> Optional[Dict[str, Any]]:
    try:
        data = _serializer().loads(token, max_age=SESSION_MAX_AGE)
        if isinstance(data, dict):
            return data
        return None
    except (BadSignature, SignatureExpired):
        return None

def cookie_set_options() -> Dict[str, Any]:
    """
    Options for Response.set_cookie(...)
    """
    # Local dev usually needs SameSite=Lax (works for same-site requests).
    # If you are doing cross-site cookies behind different domains, you’ll need SameSite=None + Secure.
    samesite = os.getenv("SESSION_SAMESITE", "lax").lower()  # "lax" | "none" | "strict"
    secure = os.getenv("SESSION_SECURE", "0") == "1"         # 1 in prod if https

    return {
        "httponly": True,
        "samesite": samesite,
        "secure": secure,
        "path": "/",
        "max_age": SESSION_MAX_AGE,
    }

def cookie_delete_options() -> Dict[str, Any]:
    """
    Options for Response.delete_cookie(...)
    Starlette only accepts a limited set (key, path, domain).
    """
    return {
        "path": "/",
        # "domain": "your.domain.com"  # only set if you explicitly set domain on set_cookie
    }
