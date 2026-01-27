# backend/app/AUTH/session_token.py
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any, Dict, Optional

COOKIE_NAME = "animo_session"

def _b64url_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("utf-8").rstrip("=")

def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode((s + pad).encode("utf-8"))

def _secret() -> bytes:
    # IMPORTANT: set this in env in production
    # Example: SESSION_SECRET="superlongrandomstring"
    sec = os.getenv("SESSION_SECRET") or "dev-session-secret-change-me"
    return sec.encode("utf-8")

def encode_session(payload: Dict[str, Any], max_age_seconds: int = 60 * 60 * 24 * 30) -> str:
    now = int(time.time())
    exp = now + int(max_age_seconds)
    body = dict(payload)
    body["iat"] = now
    body["exp"] = exp

    data = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    data_b64 = _b64url_encode(data)

    sig = hmac.new(_secret(), data_b64.encode("utf-8"), hashlib.sha256).digest()
    sig_b64 = _b64url_encode(sig)

    return f"{data_b64}.{sig_b64}"

def decode_session(token: str) -> Optional[Dict[str, Any]]:
    try:
        data_b64, sig_b64 = token.split(".", 1)
    except ValueError:
        return None

    expected = hmac.new(_secret(), data_b64.encode("utf-8"), hashlib.sha256).digest()
    expected_b64 = _b64url_encode(expected)
    if not hmac.compare_digest(expected_b64, sig_b64):
        return None

    try:
        data = _b64url_decode(data_b64)
        payload = json.loads(data.decode("utf-8"))
    except Exception:
        return None

    exp = int(payload.get("exp", 0) or 0)
    if exp and int(time.time()) > exp:
        return None

    return payload

def cookie_set_options() -> Dict[str, Any]:
    # NOTE: secure should be True in https production
    secure = (os.getenv("COOKIE_SECURE") or "0") == "1"
    return {
        "httponly": True,
        "samesite": "lax",
        "secure": secure,
        "path": "/",
        "max_age": 60 * 60 * 24 * 30,
    }

def cookie_delete_options() -> Dict[str, Any]:
    # delete_cookie does NOT accept max_age in Starlette (your error)
    secure = (os.getenv("COOKIE_SECURE") or "0") == "1"
    return {
        "path": "/",
        "samesite": "lax",
        "secure": secure,
    }
