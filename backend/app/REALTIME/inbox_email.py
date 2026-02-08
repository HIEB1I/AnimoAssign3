# backend/app/REALTIME/inbox_email.py
# -----------------------------------------------------------------------------
# Best-effort Gmail email notification for realtime inbox messages.
#
# Design goal:
# - Mirror the existing Notifications -> Gmail approach (Google token stored on
#   users.google_token, refresh via refresh_token when needed).
# - Keep Socket.IO message_send fast: email is sent in a background task.
# - Avoid spamming: message_send only calls this when unread becomes 1.
#
# Configuration:
# - ANIMOASSIGN_INBOX_EMAIL_ENABLED=1 (default on; set 0/false to disable)
# - ANIMOASSIGN_EMAIL_SENDER_USER_ID=<user_id> (recommended)
#   OR ANIMOASSIGN_EMAIL_SENDER_EMAIL=<email> (fallback lookup)
# - ANIMOASSIGN_WEB_URL=<base url> (optional; defaults to CCS Cloud URL)
# - GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET must be set for refresh.
# -----------------------------------------------------------------------------

from __future__ import annotations

import base64
import logging
import os
import time
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from html import escape as _html_escape
from typing import Any, Dict, Optional

import httpx
from fastapi.concurrency import run_in_threadpool

from ..db import get_collection


logger = logging.getLogger("animoassign.inbox_email")

GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _env_flag(name: str, default: str = "1") -> bool:
    v = (os.getenv(name) or default).strip().lower()
    return v not in ("0", "false", "no", "off", "")


def _user_display_name(user: Dict[str, Any]) -> str:
    first = (user.get("first_name") or "").strip()
    last = (user.get("last_name") or "").strip()
    full = f"{first} {last}".strip()
    return full or (user.get("email") or user.get("gmail") or "").strip() or "User"


def _user_email(user: Dict[str, Any]) -> str:
    return (user.get("gmail") or user.get("email") or "").strip()


def _build_link(route: str) -> str:
    base = (os.getenv("ANIMOASSIGN_WEB_URL") or "").strip() or "http://ccscloud.dlsu.edu.ph:11160/"
    base = base.rstrip("/")
    r = (route or "").strip()
    if not r:
        return base
    if not r.startswith("/"):
        r = "/" + r
    return base + r


def _make_subject(title: str) -> str:
    t = (title or "").strip() or "Message"
    if t.lower().startswith("[animoassign]"):
        return t
    return f"[AnimoAssign] {t}"


def _infer_inbox_route_for_user_sync(user_id: str) -> str:
    """Best-effort inference of the correct inbox route for the recipient.

    Mirrors frontend Topbar inference (role-based): /om/inbox, /apo/inbox, etc.
    """
    uid = str(user_id or "").strip()
    if not uid:
        return "/om/inbox"

    users = get_collection("users")
    ras = get_collection("role_assignments")
    roles = get_collection("user_roles")

    udoc = users.find_one({"user_id": uid}, {"_id": 0, "role": 1}) or {}
    user_role_field = str(udoc.get("role") or "").strip().lower()

    role_ids = [
        str(x.get("role_id") or "").strip()
        for x in (ras.find({"user_id": uid}, {"_id": 0, "role_id": 1}) or [])
        if str(x.get("role_id") or "").strip()
    ]

    role_types: list[str] = []
    if role_ids:
        role_docs = list(roles.find({"role_id": {"$in": role_ids}}, {"_id": 0, "role_type": 1}))
        role_types = [str(r.get("role_type") or "").strip().lower() for r in role_docs if r.get("role_type")]

    # Combine (role_assignments + users.role) for best coverage.
    blob = " | ".join([user_role_field] + role_types)

    if "admin" in blob:
        return "/admin/inbox"
    if "chair" in blob:
        return "/chair/inbox"
    if "apo" in blob:
        return "/apo/inbox"
    if "office manager" in blob or blob.strip() == "om" or "gs coordinator" in blob:
        return "/om/inbox"
    if "faculty" in blob:
        return "/faculty/inbox"

    # Safe fallback.
    return "/om/inbox"


def _get_user_google_token_sync(user_id: str) -> Optional[Dict[str, Any]]:
    users = get_collection("users")
    u = users.find_one({"user_id": user_id}, {"_id": 0, "google_token": 1}) or {}
    tok = (u or {}).get("google_token")
    return tok if isinstance(tok, dict) else None


def _has_any_google_token_sync(user_id: str) -> bool:
    tok = _get_user_google_token_sync(user_id)
    if not tok:
        return False
    return bool((tok.get("access_token") or "").strip() or (tok.get("refresh_token") or "").strip())


def _resolve_sender_user_id_sync(preferred_sender_user_id: str | None) -> str:
    """Resolve which account to send emails from.

    Priority:
      1) preferred_sender_user_id (only if it has a google_token)
      2) ANIMOASSIGN_EMAIL_SENDER_USER_ID
      3) ANIMOASSIGN_EMAIL_SENDER_EMAIL (lookup in users.email/users.gmail)
    """
    if preferred_sender_user_id:
        uid = str(preferred_sender_user_id).strip()
        if uid and _has_any_google_token_sync(uid):
            return uid

    env_uid = (os.getenv("ANIMOASSIGN_EMAIL_SENDER_USER_ID") or "").strip()
    if env_uid and _has_any_google_token_sync(env_uid):
        return env_uid

    env_email = (os.getenv("ANIMOASSIGN_EMAIL_SENDER_EMAIL") or "").strip().lower()
    if not env_email:
        return ""

    users = get_collection("users")
    u = users.find_one({"$or": [{"email": env_email}, {"gmail": env_email}]}, {"_id": 0, "user_id": 1}) or {}
    uid = str(u.get("user_id") or "").strip()
    return uid if uid and _has_any_google_token_sync(uid) else ""


async def _refresh_access_token(refresh_token: str) -> Optional[Dict[str, Any]]:
    client_id = (os.getenv("GOOGLE_CLIENT_ID") or "").strip()
    client_secret = (os.getenv("GOOGLE_CLIENT_SECRET") or "").strip()
    if not client_id or not client_secret or not refresh_token:
        return None

    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(
            GOOGLE_TOKEN_URL,
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
        )
    if r.status_code != 200:
        return None
    data = r.json() or {}
    at = (data.get("access_token") or "").strip()
    if not at:
        return None
    exp = time.time() + float(data.get("expires_in") or 3600) - 60
    return {"access_token": at, "expires_at": exp, "expires_in": data.get("expires_in"), "scope": data.get("scope")}


async def _send_email_via_user_gmail(
    *,
    sender_user_id: str,
    to_email: str,
    subject: str,
    text_body: str,
    html_body: str | None,
) -> None:
    """Send mail using Gmail API; refresh on 401 if possible."""

    tok = await run_in_threadpool(_get_user_google_token_sync, sender_user_id)
    if not tok:
        raise RuntimeError("sender_missing_google_token")

    access_token = (tok.get("access_token") or "").strip()
    refresh_token = (tok.get("refresh_token") or "").strip()
    expires_at = tok.get("expires_at")

    # Proactively refresh if we can tell it's expired
    if (not access_token) or (isinstance(expires_at, (int, float)) and time.time() >= float(expires_at)):
        if not refresh_token:
            raise RuntimeError("sender_missing_refresh_token")
        refreshed = await _refresh_access_token(refresh_token)
        if not refreshed:
            raise RuntimeError("sender_token_refresh_failed")
        access_token = refreshed["access_token"]
        expires_at = refreshed["expires_at"]

        def _update_token():
            users = get_collection("users")
            users.update_one(
                {"user_id": sender_user_id},
                {
                    "$set": {
                        "google_token.access_token": access_token,
                        "google_token.expires_at": expires_at,
                        "google_token.updated_at": _now_utc(),
                        "google_token.expires_in": refreshed.get("expires_in"),
                        "google_token.scope": refreshed.get("scope"),
                    }
                },
            )

        await run_in_threadpool(_update_token)

    # Build raw
    if html_body:
        msg = MIMEMultipart("alternative")
        msg["To"] = to_email
        msg["Subject"] = subject
        msg.attach(MIMEText(text_body or "", "plain", "utf-8"))
        msg.attach(MIMEText(html_body, "html", "utf-8"))
        raw_bytes = msg.as_bytes()
    else:
        msg = MIMEText(text_body or "", "plain", "utf-8")
        msg["To"] = to_email
        msg["Subject"] = subject
        raw_bytes = msg.as_bytes()

    raw = base64.urlsafe_b64encode(raw_bytes).decode("utf-8")

    async def _try_send(token: str) -> httpx.Response:
        async with httpx.AsyncClient(timeout=20) as client:
            return await client.post(
                GMAIL_SEND_URL,
                headers={"Authorization": f"Bearer {token}"},
                json={"raw": raw},
            )

    # First attempt
    r = await _try_send(access_token)
    if r.status_code < 400:
        return

    # If not auth issue, fail
    if r.status_code != 401:
        raise RuntimeError(f"gmail_send_failed:{r.status_code}:{r.text}")

    # Refresh on 401
    if not refresh_token:
        raise RuntimeError("sender_missing_refresh_token")

    refreshed2 = await _refresh_access_token(refresh_token)
    if not refreshed2:
        raise RuntimeError("sender_token_refresh_failed")

    new_access = refreshed2["access_token"]
    new_expires_at = refreshed2["expires_at"]

    def _update_token2():
        users = get_collection("users")
        users.update_one(
            {"user_id": sender_user_id},
            {
                "$set": {
                    "google_token.access_token": new_access,
                    "google_token.expires_at": new_expires_at,
                    "google_token.updated_at": _now_utc(),
                    "google_token.expires_in": refreshed2.get("expires_in"),
                    "google_token.scope": refreshed2.get("scope"),
                }
            },
        )

    await run_in_threadpool(_update_token2)

    r2 = await _try_send(new_access)
    if r2.status_code >= 400:
        raise RuntimeError(f"gmail_send_failed:{r2.status_code}:{r2.text}")


def _build_inbox_email_text(
    *,
    name: str,
    sender_name: str,
    sender_email: str | None,
    preview: str,
    login_link: str,
) -> str:
    """Plain-text Gmail notification for a new message.

    Important UX note:
    We intentionally link to the *login / app root* instead of a deep inbox route,
    because deep links may not be usable without an authenticated session.
    """

    safe_name = (name or "User").strip() or "User"
    safe_sender = (sender_name or "User").strip() or "User"
    safe_sender_email = (sender_email or "").strip()
    safe_preview = (preview or "").strip()
    safe_link = (login_link or "").strip()

    sender_line = safe_sender
    if safe_sender_email:
        sender_line = f"{safe_sender} <{safe_sender_email}>"

    return (
        f"Hi {safe_name},\n\n"
        f"You have a new message from {sender_line} in AnimoAssign.\n\n"
        f"Message preview:\n{safe_preview}\n\n"
        f"To view and reply, please log in to AnimoAssign:\n{safe_link}\n\n"
        "After logging in, open Inbox from the top bar.\n\n"
        "— AnimoAssign"
    )


def _build_inbox_email_html(
    *,
    name: str,
    sender_name: str,
    sender_email: str | None,
    preview: str,
    login_link: str,
) -> str:
    safe_name = _html_escape((name or "User").strip() or "User")
    safe_sender = _html_escape((sender_name or "User").strip() or "User")
    safe_sender_email = _html_escape((sender_email or "").strip())
    safe_preview = _html_escape((preview or "").strip()).replace("\n", "<br>")
    safe_link = _html_escape((login_link or "").strip())
    preheader = _html_escape(((preview or "").strip() or f"New message from {sender_name}")[:120])

    # Initials badge (email-safe, no external images)
    initials = ""
    for part in (sender_name or "").strip().split():
        if part:
            initials += part[0].upper()
        if len(initials) >= 2:
            break
    initials = _html_escape(initials or "NA")

    sender_email_line = f"<div style=\"font-size:12px;color:#6b7280;margin-top:2px;\">{safe_sender_email}</div>" if safe_sender_email else ""

    return f"""<!doctype html>
<html lang=\"en\">
  <head>
    <meta charset=\"utf-8\" />
    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
    <title>New message from {safe_sender}</title>
  </head>
  <body style=\"margin:0;padding:0;background:#f6f7fb;\">
    <div style=\"display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;\">{preheader}</div>
    <table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"background:#f6f7fb;padding:24px 0;\">
      <tr>
        <td align=\"center\">
          <table role=\"presentation\" width=\"600\" cellpadding=\"0\" cellspacing=\"0\" style=\"width:600px;max-width:92vw;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 6px 18px rgba(17,24,39,0.08);\">
            <tr>
              <td style=\"padding:20px 24px;background:#0B6B3A;color:#ffffff;font-family:Arial,Helvetica,sans-serif;\">
                <div style=\"font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.9;\">AnimoAssign</div>
                <div style=\"font-size:20px;font-weight:700;margin-top:6px;line-height:1.25;\">Inbox Message</div>
              </td>
            </tr>
            <tr>
              <td style=\"padding:22px 24px;font-family:Arial,Helvetica,sans-serif;color:#111827;font-size:14px;line-height:1.55;\">
                <p style=\"margin:0 0 12px 0;\">Hi {safe_name},</p>
                <p style=\"margin:0 0 12px 0;color:#374151;\">You have a new message in AnimoAssign.</p>

                <table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" style=\"width:100%;margin:0 0 16px 0;\">
                  <tr>
                    <td width=\"44\" valign=\"middle\" style=\"padding-right:10px;\">
                      <div style=\"width:40px;height:40px;border-radius:999px;background:#e5e7eb;color:#111827;font-weight:700;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:40px;text-align:center;\">{initials}</div>
                    </td>
                    <td valign=\"middle\" style=\"font-family:Arial,Helvetica,sans-serif;\">
                      <div style=\"font-size:14px;font-weight:700;color:#111827;\">{safe_sender}</div>
                      {sender_email_line}
                    </td>
                  </tr>
                </table>

                <div style=\"margin:0 0 18px 0;padding:12px 14px;border-radius:12px;background:#f3f4f6;color:#111827;\">{safe_preview}</div>

                <div style=\"text-align:center;margin:0 0 14px 0;\"><a href=\"{safe_link}\" style=\"display:inline-block;background:#16A34A;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700;\">Log in to AnimoAssign</a></div>

                <p style=\"margin:0;color:#6b7280;font-size:12px;\">After logging in, open <b>Inbox</b> from the top bar to view and reply. If the button doesn’t work, copy and paste this link: <a href=\"{safe_link}\" style=\"color:#16A34A;word-break:break-all;\">{safe_link}</a></p>
              </td>
            </tr>
            <tr>
              <td style=\"padding:14px 24px;background:#f9fafb;font-family:Arial,Helvetica,sans-serif;color:#6b7280;font-size:12px;line-height:1.4;\">
                You’re receiving this email because you received a new message in AnimoAssign.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>"""


async def maybe_send_inbox_email_notification(
    *,
    recipient_user_id: str,
    sender_user_id: str,
    sender_name: str,
    preview: str,
) -> None:
    """Best-effort; never raise to callers."""
    try:
        if not _env_flag("ANIMOASSIGN_INBOX_EMAIL_ENABLED", "1"):
            return

        rid = str(recipient_user_id or "").strip()
        if not rid:
            return

        users = get_collection("users")
        recipient = await run_in_threadpool(lambda: users.find_one({"user_id": rid}, {"_id": 0}) or {})
        if not recipient:
            return

        to_email = _user_email(recipient)
        if not to_email:
            return

        name = _user_display_name(recipient)

        # Sender metadata (best-effort; used only for display)
        sdoc = await run_in_threadpool(
            lambda: users.find_one(
                {"user_id": str(sender_user_id or "").strip()},
                {"_id": 0, "first_name": 1, "last_name": 1, "email": 1, "gmail": 1},
            )
            or {}
        )
        sender_email = _user_email(sdoc) if sdoc else ""

        # IMPORTANT: link to app root/login (not a deep inbox route)
        login_link = _build_link("")

        subj = _make_subject(f"New message from {sender_name}")
        text_body = _build_inbox_email_text(
            name=name,
            sender_name=sender_name,
            sender_email=sender_email,
            preview=preview,
            login_link=login_link,
        )
        html_body = _build_inbox_email_html(
            name=name,
            sender_name=sender_name,
            sender_email=sender_email,
            preview=preview,
            login_link=login_link,
        )

        # Match Notifications -> Gmail behavior:
        # Prefer the configured system sender, then fallback to the message sender
        # (only if they happen to have a connected Google token).
        sender_uid = await run_in_threadpool(_resolve_sender_user_id_sync, None)
        if not sender_uid:
            sender_uid = await run_in_threadpool(_resolve_sender_user_id_sync, str(sender_user_id or "").strip())
        if not sender_uid:
            return

        await _send_email_via_user_gmail(
            sender_user_id=sender_uid,
            to_email=to_email,
            subject=subj,
            text_body=text_body,
            html_body=html_body,
        )

    except Exception as e:
        try:
            logger.warning("Inbox email notify failed recipient=%s: %s", recipient_user_id, str(e))
        except Exception:
            pass
