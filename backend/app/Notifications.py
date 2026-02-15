# backend/app/Notifications.py
# -----------------------------------------------------------------------------
# In-app notifications stored in MongoDB.
# This powers the reusable Topbar bell across roles.
# -----------------------------------------------------------------------------

from __future__ import annotations

from datetime import datetime, timezone, timedelta
import asyncio
import base64
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from html import escape as _html_escape
import logging
import os
import re
import time
from typing import Any, Dict, Optional
from uuid import uuid4

import httpx

from fastapi import APIRouter, Body, HTTPException, Query

from .main import db

try:
    # Optional dependency in most FastAPI+Mongo stacks.
    # If bson is unavailable, we simply won't attempt ObjectId -> user_id mapping.
    from bson import ObjectId  # type: ignore
except Exception:  # pragma: no cover
    ObjectId = None  # type: ignore

router = APIRouter(prefix="/notifications", tags=["notifications"])

COL_NOTIFS = "notifications"

logger = logging.getLogger("animoassign.notifications")

# Best-effort reminder runner throttling (no background scheduler in dev).
_LAST_REMINDER_RUN_AT: float = 0.0
_REMINDER_MIN_INTERVAL_S: float = 60.0


async def _resolve_canonical_user_id(uid: str) -> str:
    """Normalize a user identifier into the canonical `users.user_id`.

    Why:
    - Some frontends historically stored `animo.user.id` as Mongo ObjectId.
    - Notifications are stored under `notifications.user_id` (e.g., "USR0155").
    - If the UI queries /notifications?userId=<ObjectId>, the list will be empty
      even though notifications exist and Gmail emails were sent.

    We keep compatibility by resolving ObjectId -> users.user_id when possible.
    """

    s = (uid or "").strip()
    if not s:
        return ""

    # If this is already a canonical id (e.g., USRxxxx), keep it.
    if s.upper().startswith("USR"):
        return s

    # Best-effort: resolve Mongo ObjectId to users.user_id
    if ObjectId is not None:
        try:
            if len(s) == 24:
                oid = ObjectId(s)
                u = await db.get_collection("users").find_one(
                    {"_id": oid},
                    {"_id": 0, "user_id": 1},
                )
                resolved = str((u or {}).get("user_id") or "").strip()
                if resolved:
                    return resolved
        except Exception:
            pass

    return s


def _scope_has_gmail_send(scope_val: Any) -> bool:
    """Return True if the provided scope value contains gmail.send."""
    try:
        s = " ".join(scope_val) if isinstance(scope_val, list) else str(scope_val or "")
        return "gmail.send" in s.lower()
    except Exception:
        return False


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _normalize_campus_id(raw: str) -> str:
    """Normalize a campus identifier to campuses.campus_id when possible."""
    v = str(raw or "").strip()
    if not v:
        return ""

    # Direct campus_id match
    try:
        doc = await db["campuses"].find_one({"campus_id": v}, {"_id": 0, "campus_id": 1})
        if doc and doc.get("campus_id"):
            return str(doc["campus_id"]).strip()
    except Exception:
        pass

    # Case-normalized campus_id match
    try:
        doc = await db["campuses"].find_one({"campus_id": v.upper()}, {"_id": 0, "campus_id": 1})
        if doc and doc.get("campus_id"):
            return str(doc["campus_id"]).strip()
    except Exception:
        pass

    # campus_name match (exact)
    try:
        doc = await db["campuses"].find_one(
            {"campus_name": {"$regex": f"^{re.escape(v)}$", "$options": "i"}},
            {"_id": 0, "campus_id": 1},
        )
        if doc and doc.get("campus_id"):
            return str(doc["campus_id"]).strip()
    except Exception:
        pass

    return v


def _user_display_name(user: Dict[str, Any]) -> str:
    first = (user.get("first_name") or "").strip()
    last = (user.get("last_name") or "").strip()
    full = f"{first} {last}".strip()
    return full or (user.get("email") or user.get("gmail") or "").strip() or "User"


def _user_email(user: Dict[str, Any]) -> str:
    """Best-effort resolve the recipient email address.

    Different deployments / roles may store the user's address under different keys.
    We prefer `gmail` (historical), then fall back to other common fields.
    """

    # 1) Common top-level fields
    for key in ("gmail", "email", "dlsu_email", "google_email", "connected_email"):
        val = user.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()

    # 2) Version 2 stores the connected Google email under users.google_token.connected_email.
    # Some accounts (especially imported/legacy records) may not have users.gmail/users.email populated.
    gt = user.get("google_token")
    if isinstance(gt, dict):
        nested = gt.get("connected_email") or gt.get("email")
        if isinstance(nested, str) and nested.strip():
            return nested.strip()

    return ""



def _build_notif_link(route: str) -> str:
    # IMPORTANT: For email, always point to the app root.
    # Deep-links may not work if the user is not authenticated / has no active session.
    return "http://ccscloud.dlsu.edu.ph:11160/"


def _make_email_subject(title: str) -> str:
    t = (title or "").strip() or "Notification"
    if t.lower().startswith("[animoassign]"):
        return t
    return f"[AnimoAssign] {t}"


def _build_notification_email_text(*, name: str, title: str, details: str, link: str) -> str:
    """Plain-text Gmail notification for an in-app notification.

    We keep the same tone and structure as the Inbox email template:
    - Encourage the user to log in
    - Avoid implying deep links will work without authentication
    """

    safe_name = (name or "User").strip() or "User"
    safe_title = (title or "Notification").strip() or "Notification"
    safe_details = (details or "").strip()
    safe_link = (link or "").strip()

    return (
        f"Hi {safe_name},\n\n"
        "You have a new notification in AnimoAssign.\n\n"
        f"{safe_title}\n"
        f"{safe_details}\n\n"
        f"To view it, please log in to AnimoAssign:\n{safe_link}\n\n"
        "After logging in, open Notifications from the top bar.\n\n"
        "— AnimoAssign"
    )


def _build_notification_email_html(*, name: str, title: str, details: str, link: str) -> str:
    # Email-client-friendly HTML (tables + inline styles).
    # NOTE: Notification emails should NOT show an avatar/initials circle (per UI request).
    safe_name = _html_escape((name or "User").strip() or "User")
    safe_title = _html_escape((title or "Notification").strip() or "Notification")
    safe_details = _html_escape((details or "").strip()).replace("\n", "<br>")
    safe_link = _html_escape((link or "").strip() or "http://ccscloud.dlsu.edu.ph:11160/")
    preheader = _html_escape(((details or "").strip() or title or "Notification")[:120])

    # NOTE: Avoid escaping quotes (\" ) inside triple-quoted strings—some clients can display them literally.
    # Also avoid curly apostrophes for maximum email-client compatibility.
    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{safe_title}</title>
  </head>
  <body style="margin:0;padding:0;background:#f6f7fb;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">{preheader}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7fb;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:92vw;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 6px 18px rgba(17,24,39,0.08);">
            <tr>
              <td style=\"padding:20px 24px;background:#0B6B3A;color:#ffffff;font-family:Arial,Helvetica,sans-serif;\">
                <div style=\"font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.9;\">AnimoAssign</div>
                <div style=\"font-size:20px;font-weight:700;margin-top:6px;line-height:1.25;\">Notification</div>
              </td>
            </tr>
            <tr>
              <td style=\"padding:22px 24px;font-family:Arial,Helvetica,sans-serif;color:#111827;font-size:14px;line-height:1.55;\">
                <p style=\"margin:0 0 12px 0;\">Hi {safe_name},</p>
                <p style=\"margin:0 0 12px 0;color:#374151;\">You have a new notification in AnimoAssign.</p>

                <div style=\"font-size:16px;font-weight:800;color:#111827;margin:0 0 10px 0;\">{safe_title}</div>

                <div style=\"margin:0 0 18px 0;padding:12px 14px;border-radius:12px;background:#f3f4f6;color:#111827;\">{safe_details}</div>

                <div style=\"text-align:center;margin:0 0 14px 0;\"><a href=\"{safe_link}\" style=\"display:inline-block;background:#16A34A;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700;\">Log in to AnimoAssign</a></div>

                <p style=\"margin:0;color:#6b7280;font-size:12px;\">After logging in, open <b>Notifications</b> from the top bar to view. If the button doesn’t work, copy and paste this link: <a href=\"{safe_link}\" style=\"color:#16A34A;word-break:break-all;\">{safe_link}</a></p>
              </td>
            </tr>
            <tr>
              <td style=\"padding:14px 24px;background:#f9fafb;font-family:Arial,Helvetica,sans-serif;color:#6b7280;font-size:12px;line-height:1.4;\">
                You’re receiving this email because you received a notification in AnimoAssign.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>"""


def _build_inbox_email_text(*, name: str, title: str, details: str, link: str) -> str:
    """Plain-text Gmail email for Inbox-style messages (RFC replies, etc.)."""

    safe_name = (name or "User").strip() or "User"
    safe_title = (title or "New Message").strip() or "New Message"
    safe_details = (details or "").strip()
    safe_link = (link or "").strip()

    return (
        f"Hi {safe_name},\n\n"
        "You have a new message in your AnimoAssign Inbox.\n\n"
        f"{safe_title}\n"
        f"{safe_details}\n\n"
        f"To view and reply, please log in to AnimoAssign:\n{safe_link}\n\n"
        "After logging in, open Inbox from the top bar.\n\n"
        "— AnimoAssign"
    )


def _build_inbox_email_html(*, name: str, title: str, details: str, link: str) -> str:
    """Email-client-friendly HTML for Inbox-style messages."""

    safe_name = _html_escape((name or "User").strip() or "User")
    safe_title = _html_escape((title or "New Message").strip() or "New Message")
    safe_details = _html_escape((details or "").strip()).replace("\n", "<br>")
    safe_link = _html_escape((link or "").strip() or "http://ccscloud.dlsu.edu.ph:11160/")
    preheader = _html_escape(((details or "").strip() or title or "New Message")[:120])

    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{safe_title}</title>
  </head>
  <body style="margin:0;padding:0;background:#f6f7fb;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">{preheader}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7fb;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:92vw;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 6px 18px rgba(17,24,39,0.08);">
            <tr>
              <td style="padding:20px 24px;background:#0B6B3A;color:#ffffff;font-family:Arial,Helvetica,sans-serif;">
                <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.9;">AnimoAssign</div>
                <div style="font-size:20px;font-weight:700;margin-top:6px;line-height:1.25;">New Message</div>
              </td>
            </tr>
            <tr>
              <td style="padding:22px 24px;font-family:Arial,Helvetica,sans-serif;color:#111827;font-size:14px;line-height:1.55;">
                <p style="margin:0 0 12px 0;">Hi {safe_name},</p>
                <p style="margin:0 0 12px 0;color:#374151;">You have a new message in your AnimoAssign Inbox.</p>

                <div style="font-size:16px;font-weight:800;color:#111827;margin:0 0 10px 0;">{safe_title}</div>
                <div style="margin:0 0 18px 0;padding:12px 14px;border-radius:12px;background:#f3f4f6;color:#111827;">{safe_details}</div>

                <div style="text-align:center;margin:0 0 14px 0;"><a href="{safe_link}" style="display:inline-block;background:#16A34A;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700;">Open AnimoAssign Inbox</a></div>

                <p style="margin:0;color:#6b7280;font-size:12px;">After logging in, open <b>Inbox</b> from the top bar to view and reply. If the button doesn’t work, copy and paste this link: <a href="{safe_link}" style="color:#16A34A;word-break:break-all;">{safe_link}</a></p>
              </td>
            </tr>
            <tr>
              <td style="padding:14px 24px;background:#f9fafb;font-family:Arial,Helvetica,sans-serif;color:#6b7280;font-size:12px;line-height:1.4;">
                You’re receiving this email because you received a message in AnimoAssign.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>"""



async def _resolve_sender_user_id(email_from_user_id: str | None) -> str:
    """Choose which user's Gmail token to use to send email.

    Priority:
      1) email_from_user_id (explicit actor)
      2) ANIMOASSIGN_EMAIL_SENDER_USER_ID env
      3) ANIMOASSIGN_EMAIL_SENDER_EMAIL env (resolve in users collection)
    """

    # If an explicit actor is provided, use it only if they actually have a usable
    # Google token. If not, fall back to the configured system sender.
    #
    # This matches the "best-effort" email notification contract: in-app notifications
    # should still be created even if the actor never connected Gmail (or their token
    # was stored without a refresh_token), while email delivery can gracefully fall
    # back to a service sender account.
    if email_from_user_id:
        candidate = email_from_user_id.strip()
        if candidate:
            try:
                tok = await _get_user_google_token(candidate)
                if tok:
                    # Ensure the candidate can actually send Gmail.
                    if not _scope_has_gmail_send(tok.get("scope")):
                        raise RuntimeError("sender_missing_gmail_send_scope")

                    access_token = (tok.get("access_token") or "").strip()
                    refresh_token = (tok.get("refresh_token") or "").strip()

                    # Prefer candidates that can refresh (most reliable).
                    if refresh_token:
                        return candidate

                    # If we only have an access token, only use it if it does not appear expired.
                    # Otherwise, fall back to the configured service sender to avoid silent failures.
                    if access_token:
                        exp = _compute_expires_at(tok)
                        if exp is None or time.time() < float(exp):
                            return candidate
            except Exception:
                # Ignore and fall back to env sender.
                pass

    sender_user_id = (os.getenv("ANIMOASSIGN_EMAIL_SENDER_USER_ID") or "").strip()
    if sender_user_id:
        # Only use the env sender if it can send Gmail.
        try:
            tok = await _get_user_google_token(sender_user_id)
            if tok and _scope_has_gmail_send(tok.get("scope")):
                return sender_user_id
        except Exception:
            pass

    sender_email = (os.getenv("ANIMOASSIGN_EMAIL_SENDER_EMAIL") or "").strip()
    if sender_email:
        sdoc = await db[COL_USERS].find_one(
            {"$or": [{"email": sender_email}, {"gmail": sender_email}]},
            {"_id": 0, "user_id": 1},
        ) or {}
        uid = (sdoc.get("user_id") or "").strip()
        if uid:
            try:
                tok = await _get_user_google_token(uid)
                if tok and _scope_has_gmail_send(tok.get("scope")):
                    return uid
            except Exception:
                pass

    # Last-resort fallback:
    # If the deployment forgot to configure a service sender via env vars and the
    # actor has no usable token, try to find *any* connected account that can send
    # Gmail (has a refresh token and gmail.send scope).
    #
    # This is intentionally best-effort: if it finds nothing, email sending will
    # be skipped while in-app notifications still work.
    try:
        q = {
            "google_token.refresh_token": {"$exists": True, "$ne": ""},
            "google_token.scope": {"$regex": r"gmail\\.send", "$options": "i"},
            "status": {"$ne": False},
        }
        sdoc = (
            await db[COL_USERS]
            .find(q, {"_id": 0, "user_id": 1, "google_token.updated_at": 1})
            .sort([("google_token.updated_at", -1), ("user_id", 1)])
            .to_list(length=1)
        )
        if sdoc:
            uid = (sdoc[0].get("user_id") or "").strip()
            if uid:
                return uid
    except Exception:
        pass

    return ""


async def _pick_any_gmail_sender_excluding(excluded_user_ids: list[str]) -> str:
    """Pick any connected account that can send Gmail (refresh token + gmail.send scope).

    Used as a last-chance fallback when configured/actor senders fail.
    """

    try:
        q = {
            "google_token.refresh_token": {"$exists": True, "$ne": ""},
            "google_token.scope": {"$regex": r"gmail\\.send", "$options": "i"},
            "status": {"$ne": False},
        }

        cur = (
            db[COL_USERS]
            .find(q, {"_id": 0, "user_id": 1, "google_token.updated_at": 1})
            .sort([("google_token.updated_at", -1), ("user_id", 1)])
        )

        async for d in cur:
            uid = str(d.get("user_id") or "").strip()
            if uid and uid not in (excluded_user_ids or []):
                return uid
    except Exception:
        pass
    return ""


async def _get_env_sender_user_id() -> str:
    """Resolve the configured service sender only (no actor fallback)."""

    sender_user_id = (os.getenv("ANIMOASSIGN_EMAIL_SENDER_USER_ID") or "").strip()
    if sender_user_id:
        return sender_user_id

    sender_email = (os.getenv("ANIMOASSIGN_EMAIL_SENDER_EMAIL") or "").strip()
    if not sender_email:
        return ""

    sdoc = await db[COL_USERS].find_one(
        {"$or": [{"email": sender_email}, {"gmail": sender_email}]},
        {"_id": 0, "user_id": 1},
    ) or {}
    return (sdoc.get("user_id") or "").strip()


async def _get_user_google_token(user_id: str) -> Optional[Dict[str, Any]]:
    user = await db[COL_USERS].find_one({"user_id": user_id}, {"_id": 0, "google_token": 1})
    tok = (user or {}).get("google_token")
    return tok if isinstance(tok, dict) else None


def _compute_expires_at(tok: Dict[str, Any]) -> Optional[float]:
    """Best-effort compute token expiry epoch seconds.

    Different parts of the codebase store expiry differently:
      - expires_at (epoch seconds)
      - updated_at + expires_in (seconds)

    This normalizes so we can decide whether to refresh proactively.
    """

    try:
        expires_at = tok.get("expires_at")
        if isinstance(expires_at, (int, float)):
            return float(expires_at)

        expires_in = tok.get("expires_in")
        if not isinstance(expires_in, (int, float)):
            return None

        updated_at = tok.get("updated_at")
        if isinstance(updated_at, datetime):
            base_ts = updated_at.replace(tzinfo=timezone.utc).timestamp() if updated_at.tzinfo is None else updated_at.timestamp()
        elif isinstance(updated_at, str) and updated_at.strip():
            dt = _parse_iso_dt(updated_at.strip())
            if not dt:
                return None
            base_ts = dt.timestamp()
        else:
            return None

        # subtract 60s as a safety buffer
        return float(base_ts) + float(expires_in) - 60.0
    except Exception:
        return None


async def _refresh_access_token(refresh_token: str) -> Optional[Dict[str, Any]]:
    client_id = (os.getenv("GOOGLE_CLIENT_ID") or "").strip()
    client_secret = (os.getenv("GOOGLE_CLIENT_SECRET") or "").strip()
    if not client_id or not client_secret or not refresh_token:
        return None

    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(
            "https://oauth2.googleapis.com/token",
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
        access_token = data.get("access_token")
        expires_in = data.get("expires_in")
        if not access_token:
            return None
        exp = time.time() + float(expires_in or 3600) - 60
        return {"access_token": access_token, "expires_at": exp}


async def _send_email_via_user_gmail(
    *,
    sender_user_id: str,
    to_email: str,
    subject: str,
    text_body: str,
    html_body: str | None = None,
) -> None:
    """Send an email using the sender's Google token stored on users.google_token.

    Uses a multipart/alternative message when html_body is provided.
    Mirrors the Faculty RFC email flow.
    """

    tok = await _get_user_google_token(sender_user_id)
    if not tok:
        raise RuntimeError("sender_missing_google_token")

    access_token = (tok.get("access_token") or "").strip()
    refresh_token = (tok.get("refresh_token") or "").strip()
    expires_at = _compute_expires_at(tok)

    async def _refresh_and_persist() -> str:
        if not refresh_token:
            raise RuntimeError("sender_missing_refresh_token")
        refreshed = await _refresh_access_token(refresh_token)
        if not refreshed:
            raise RuntimeError("sender_token_refresh_failed")
        new_access = (refreshed.get("access_token") or "").strip()
        new_expires_at = refreshed.get("expires_at")
        if not new_access:
            raise RuntimeError("sender_token_refresh_failed")
        await db[COL_USERS].update_one(
            {"user_id": sender_user_id},
            {"$set": {"google_token.access_token": new_access, "google_token.expires_at": new_expires_at}},
        )
        return new_access

    # Proactive refresh if we can tell it's expired.
    if (not access_token) or (isinstance(expires_at, (int, float)) and time.time() >= float(expires_at)):
        access_token = await _refresh_and_persist()

    if html_body:
        msg = MIMEMultipart("alternative")
        msg["To"] = to_email
        msg["Subject"] = subject
        # "From" is intentionally omitted so Gmail sets the actual account address.

        msg.attach(MIMEText(text_body or "", "plain", "utf-8"))
        msg.attach(MIMEText(html_body, "html", "utf-8"))
        raw_bytes = msg.as_bytes()
    else:
        msg = MIMEText(text_body or "", "plain", "utf-8")
        msg["To"] = to_email
        msg["Subject"] = subject
        raw_bytes = msg.as_bytes()

    raw = base64.urlsafe_b64encode(raw_bytes).decode("utf-8")

    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
            headers={"Authorization": f"Bearer {access_token}"},
            json={"raw": raw},
        )

        # If token is stale and we have a refresh token, refresh and retry once.
        if r.status_code == 401:
            try:
                access_token = await _refresh_and_persist()
            except Exception:
                raise RuntimeError(f"gmail_send_failed:{r.status_code}:{r.text}")

            r = await client.post(
                "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
                headers={"Authorization": f"Bearer {access_token}"},
                json={"raw": raw},
            )

        if r.status_code >= 400:
            raise RuntimeError(f"gmail_send_failed:{r.status_code}:{r.text}")


async def _pick_om_sender_user_id() -> str:
    """Best-effort pick an OM user_id that can send Gmail.

    Used for system notifications that must appear to come from the Office Manager.
    """

    try:
        om_ids = await _get_all_om_user_ids()
        if not om_ids:
            return ""

        for uid in om_ids:
            try:
                tok = await _get_user_google_token(uid)
                if not tok:
                    continue

                refresh_token = (tok.get("refresh_token") or "").strip()
                access_token = (tok.get("access_token") or "").strip()
                if refresh_token:
                    return uid

                # Access-token-only accounts can still work if token is not expired.
                if access_token:
                    exp = _compute_expires_at(tok)
                    if exp is None or time.time() < float(exp):
                        return uid
            except Exception:
                continue
    except Exception:
        return ""

    return ""


async def _send_notification_email_best_effort(
    *,
    recipient_user_id: str,
    title: str,
    details: str,
    meta: Optional[Dict[str, Any]],
    email_from_user_id: str | None,
) -> None:
    """Best-effort: never raise to callers."""

    try:
        recipient = await db[COL_USERS].find_one({"user_id": recipient_user_id}, {"_id": 0})
        if not recipient:
            return

        to_email = _user_email(recipient)
        if not to_email:
            return

        meta_dict = (meta if isinstance(meta, dict) else {}) or {}
        kind = (meta_dict.get("kind") or "").strip()

        # Some notifications must always be sent from an OM account (not the recipient).
        # This prevents faculty-facing system emails (e.g., preference deadline updates/reminders)
        # from appearing to come from a Faculty account due to fallback sender selection.
        if kind in {"prefs_deadline_changed", "prefs_deadline"}:
            om_sender = await _pick_om_sender_user_id()
            if om_sender:
                email_from_user_id = om_sender

        sender_user_id = await _resolve_sender_user_id(email_from_user_id)
        env_sender_user_id = await _get_env_sender_user_id()

        # Build a retry list: primary sender (actor or env), then env (if different).
        # If neither is configured, fall back to sending from the recipient's own
        # connected Gmail. This guarantees that every in-app notification can still
        # have a corresponding Gmail email as long as the recipient has connected Google.
        sender_candidates: list[str] = []
        if sender_user_id:
            sender_candidates.append(sender_user_id)
        if env_sender_user_id and env_sender_user_id not in sender_candidates:
            sender_candidates.append(env_sender_user_id)
        if not sender_candidates:
            sender_candidates.append(recipient_user_id)

        name = _user_display_name(recipient)
        route = meta_dict.get("route") or ""
        link = _build_notif_link(str(route))

        subject = _make_email_subject(title)

        # If this is a reply notification from an RFC thread, use the Inbox email template.
        # (Applies to both Faculty->OM and OM->Faculty RFC replies.)
        is_rfc_reply = ("rfc" in kind.lower()) and ("reply" in kind.lower())
        if is_rfc_reply:
            text_body = _build_inbox_email_text(name=name, title=title, details=details, link=link)
            html_body = _build_inbox_email_html(name=name, title=title, details=details, link=link)
        else:
            text_body = _build_notification_email_text(
                name=name,
                title=title,
                details=details,
                link=link,
            )
            html_body = _build_notification_email_html(
                name=name,
                title=title,
                details=details,
                link=link,
            )

        last_err: Optional[Exception] = None
        for sid in sender_candidates:
            try:
                await _send_email_via_user_gmail(
                    sender_user_id=sid,
                    to_email=to_email,
                    subject=subject,
                    text_body=text_body,
                    html_body=html_body,
                )
                last_err = None
                break
            except Exception as e:
                last_err = e

        # If configured/actor senders fail (e.g., refresh token exists but lacks gmail.send
        # scope), try a best-effort global sender so Gmail notifications still go out.
        if last_err is not None:
            try:
                fallback_sid = await _pick_any_gmail_sender_excluding(sender_candidates)
                if fallback_sid:
                    await _send_email_via_user_gmail(
                        sender_user_id=fallback_sid,
                        to_email=to_email,
                        subject=subject,
                        text_body=text_body,
                        html_body=html_body,
                    )
                    last_err = None
            except Exception as e:
                last_err = e

        if last_err is not None:
            raise last_err
    except Exception as e:
        try:
            logger.warning("Notif email send failed to %s: %s", recipient_user_id, str(e))
        except Exception:
            pass


async def create_notification(
    user_id: str,
    title: str,
    details: str,
    meta: Optional[Dict[str, Any]] = None,
    *,
    send_email: bool = False,
    email_from_user_id: str | None = None,
) -> Dict[str, Any]:
    """Create a single notification for a user."""

    # Normalize to canonical users.user_id so listing works even if callers
    # accidentally pass Mongo ObjectId from localStorage.
    user_id = await _resolve_canonical_user_id(user_id)

    doc: Dict[str, Any] = {
        "notif_id": f"NTF{uuid4().hex[:12].upper()}",
        "user_id": user_id,
        "title": title,
        "details": details,
        "created_at": _now_iso(),
        "seen": False,
        "seen_at": None,
        "meta": meta or {},
    }

    await db[COL_NOTIFS].insert_one(doc)
    doc.pop("_id", None)

    if send_email:
        try:
            asyncio.create_task(
                _send_notification_email_best_effort(
                    recipient_user_id=user_id,
                    title=title,
                    details=details,
                    meta=meta or {},
                    email_from_user_id=email_from_user_id,
                )
            )
        except Exception:
            pass
    return doc


@router.get("")
async def list_notifications(
    # NOTE: Historically some frontends called this with `user_id` instead of `userId`.
    # Keep both to avoid silent 422s (which can look like "no in-app notifications").
    userId: Optional[str] = Query(None, description="Current logged-in user's id"),
    user_id: Optional[str] = Query(None, description="Alias for userId"),
    limit: int = Query(25, ge=1, le=100),
) -> Dict[str, Any]:
    # Auto-run deadline reminders (best effort) so users still receive notifications
    # even if a background scheduler is not configured.
    global _LAST_REMINDER_RUN_AT
    try:
        now_ts = time.time()
        if now_ts - _LAST_REMINDER_RUN_AT >= _REMINDER_MIN_INTERVAL_S:
            _LAST_REMINDER_RUN_AT = now_ts

            async def _kick() -> None:
                try:
                    await run_prefs_deadline_reminders()
                except Exception:
                    pass
                try:
                    await run_om_submit_deadline_reminders()
                except Exception:
                    pass

            asyncio.create_task(_kick())
    except Exception:
        pass

    uid = (userId or user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=400, detail="userId is required")

    uid = await _resolve_canonical_user_id(uid)

    cur = (
        db[COL_NOTIFS]
        .find({"user_id": uid}, {"_id": 0})
        .sort([("created_at", -1)])
        .limit(limit)
    )
    rows = [doc async for doc in cur]
    return {"ok": True, "rows": rows}

# --- Deadline reminders (Faculty Preferences) --------------------------------

COL_TERMS = "terms"
COL_PRE_ENLIST = "preenlistment_count"
COL_PREFS_WINDOWS = "faculty_prefs_windows"
COL_FACULTY_PROFILES = "faculty_profiles"
COL_FACULTY_PREFS = "faculty_preferences"
COL_USERS = "users"  # adjust if your user collection name differs

# OM/GS schedule + faculty encoding deadline windows (set by APO per campus)
COL_OM_SUBMIT_WINDOWS = "om_submit_windows"
COL_USER_ROLES = "user_roles"
COL_ROLE_ASSIGN = "role_assignments"
COL_DEPARTMENTS = "departments"
COL_APO_SUBMISSIONS = "apo_scheduling_submissions"
COL_SECTIONS = "sections"


def _parse_iso_dt(s: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


async def _notif_exists(user_id: str, dedupe_key: str) -> bool:
    # Dedupe based on meta.dedupe_key to avoid repeated reminders
    hit = await db[COL_NOTIFS].find_one(
        {"user_id": user_id, "meta.dedupe_key": dedupe_key},
        {"_id": 1},
    )
    return bool(hit)


async def _create_notification_once(
    user_id: str,
    title: str,
    details: str,
    *,
    dedupe_key: str,
    meta: Optional[Dict[str, Any]] = None,
) -> None:
    if await _notif_exists(user_id, dedupe_key):
        return

    m = dict(meta or {})
    m["dedupe_key"] = dedupe_key
    # Mirror APO behavior: every in-app notification should also trigger a best-effort Gmail email.
    await create_notification(user_id=user_id, title=title, details=details, meta=m, send_email=True)


async def _get_active_term_doc() -> Optional[Dict[str, Any]]:
    """
    Mirrors how other modules resolve the active term via preenlistment_count -> term. (See Faculty/OM options behavior.)
    """
    latest = (
        await db[COL_PRE_ENLIST]
        .find({}, {"_id": 0, "term_id": 1})
        .sort([("created_at", -1)])
        .to_list(length=1)
    )
    if not latest:
        return None

    term_id = (latest[0] or {}).get("term_id")
    if not term_id:
        return None

    term = await db[COL_TERMS].find_one({"term_id": term_id}, {"_id": 0})
    return term


async def _get_prefs_window_for_term(term_id: str) -> Dict[str, str]:
    """
    Reads the manual/override window that both OM and Faculty UIs consume (openISO/deadlineISO).
    """
    w = await db[COL_PREFS_WINDOWS].find_one({"term_id": term_id}, {"_id": 0})
    return {
        "openISO": (w or {}).get("openISO") or "",
        "deadlineISO": (w or {}).get("deadlineISO") or "",
    }


async def _om_and_gs_user_ids_for_campus(campus_id: Optional[str]) -> list[str]:
    """Resolve OM + GS Coordinator user_id(s) for a campus (best effort).

    This is intentionally inclusive: if scopes are malformed/legacy, we prefer
    notifying rather than silently dropping recipients.

    Supported scope shapes:
      - dict / list[dict]
      - str (treated as campus identifier)
      - list[str] (treated as list of campus identifiers)
    """

    campus_raw = str(campus_id or "").strip()
    campus_id_norm = (await _normalize_campus_id(campus_raw)) if campus_raw else ""
    campus_id_norm = str((campus_id_norm or campus_raw) or "").strip()

    # Build campus alias map once: lower(campus_id|campus_name) -> campus_id
    campus_alias: dict[str, str] = {}
    try:
        cur_c = db["campuses"].find({}, {"_id": 0, "campus_id": 1, "campus_name": 1})
        async for c in cur_c:
            cid = str(c.get("campus_id") or "").strip()
            cname = str(c.get("campus_name") or "").strip()
            if cid:
                campus_alias[cid.lower()] = cid
            if cname:
                campus_alias[cname.lower()] = cid
    except Exception:
        campus_alias = {}

    def _norm_cid(v: Any) -> str:
        s = str(v or "").strip()
        if not s:
            return ""
        return campus_alias.get(s.lower(), s)

    campus_id_norm = _norm_cid(campus_id_norm)

    # Role IDs for OM + GS Coordinator (generous matching)
    role_q = {
        "$or": [
            {"role_type": {"$regex": r"(^OM$|Office\s*Manager|Office\s*Management|Operations\s*Manager)", "$options": "i"}},
            {"role_type": {"$regex": r"(GS\s*Coordinator|Graduate\s*Studies|Grad\s*Studies)", "$options": "i"}},
        ]
    }
    roles = await db[COL_USER_ROLES].find(role_q, {"_id": 0, "role_id": 1}).to_list(400)
    role_ids = [str(r.get("role_id") or "").strip() for r in roles if str(r.get("role_id") or "").strip()]

    # Department -> campus map
    dept_to_campus: dict[str, str] = {}
    try:
        cur_depts = db[COL_DEPARTMENTS].find({}, {"_id": 0, "department_id": 1, "campus_id": 1, "campus": 1, "dept_id": 1, "id": 1})
        async for d in cur_depts:
            did = str(d.get("department_id") or d.get("dept_id") or d.get("id") or "").strip()
            cid = _norm_cid(d.get("campus_id") or d.get("campus") or "")
            if did and cid:
                dept_to_campus[did] = cid
    except Exception:
        dept_to_campus = {}

    def _scope_items(scope_val: Any) -> list[dict]:
        if not scope_val:
            return []
        if isinstance(scope_val, dict):
            return [scope_val]
        if isinstance(scope_val, str):
            return [{"type": "campus", "id": scope_val}]
        if isinstance(scope_val, list):
            out: list[dict] = []
            for x in scope_val:
                if isinstance(x, dict):
                    out.append(x)
                elif isinstance(x, str):
                    out.append({"type": "campus", "id": x})
            return out
        return []

    def _is_global_scope(scope_val: Any) -> bool:
        if isinstance(scope_val, str):
            s = scope_val.strip().lower()
            return s in ("all", "all campuses", "global", "*")
        if isinstance(scope_val, list):
            for x in scope_val:
                if isinstance(x, str) and x.strip().lower() in ("all", "all campuses", "global", "*"):
                    return True
        return False

    def _scope_has_campus(scope_val: Any, cid_norm: str) -> bool:
        if not cid_norm:
            return True
        for s in _scope_items(scope_val):
            stype = str(s.get("type") or s.get("scope_type") or "").strip().lower()
            raw = (
                s.get("id")
                or s.get("scope_id")
                or s.get("campus_id")
                or s.get("campus")
                or s.get("campus_name")
                or ""
            )
            sid = _norm_cid(raw)
            if sid and sid == cid_norm and (not stype or stype in ("campus", "campuses") or "campus" in stype):
                return True
        return False

    def _scope_department_ids(scope_val: Any) -> list[str]:
        out: list[str] = []
        for s in _scope_items(scope_val):
            stype = str(s.get("type") or s.get("scope_type") or "").strip().lower()
            if "dept" in stype or stype == "department":
                sid = str(s.get("id") or s.get("scope_id") or s.get("department_id") or s.get("dept_id") or "").strip()
                if sid:
                    out.append(sid)
        return out

    recipients: list[str] = []

    # role_assignments (preferred)
    if role_ids:
        ras = await db[COL_ROLE_ASSIGN].find(
            {"role_id": {"$in": role_ids}},
            {"_id": 0, "user_id": 1, "scope": 1, "campus_id": 1, "department_id": 1},
        ).to_list(8000)

        for ra in ras:
            uid = str(ra.get("user_id") or "").strip()
            if not uid:
                continue

            scope = ra.get("scope")

            if not scope or _is_global_scope(scope):
                recipients.append(uid)
                continue

            ra_campus = _norm_cid(ra.get("campus_id") or "")
            if ra_campus and ra_campus == campus_id_norm:
                recipients.append(uid)
                continue

            ra_dept = str(ra.get("department_id") or "").strip()
            if ra_dept and dept_to_campus.get(ra_dept) == campus_id_norm:
                recipients.append(uid)
                continue

            if _scope_has_campus(scope, campus_id_norm):
                recipients.append(uid)
                continue

            matched = False
            for did in _scope_department_ids(scope):
                if dept_to_campus.get(did) == campus_id_norm:
                    recipients.append(uid)
                    matched = True
                    break
            if matched:
                continue

            # Unknown scope format -> include
            recipients.append(uid)

    # legacy fallback: users.role / users.campus_id
    if not recipients:
        try:
            cur_users = db[COL_USERS].find(
                {"role": {"$regex": r"(^OM$|Office\s*Manager|GS\s*Coordinator|Graduate\s*Studies)", "$options": "i"}},
                {"_id": 0, "user_id": 1, "campus_id": 1},
            )
            async for u in cur_users:
                uid = str(u.get("user_id") or "").strip()
                if not uid:
                    continue
                if not campus_id_norm:
                    recipients.append(uid)
                    continue
                if _norm_cid(u.get("campus_id")) == campus_id_norm:
                    recipients.append(uid)
        except Exception:
            pass

    # final fallback: global notify all OM/GS role_assignments
    if not recipients and role_ids:
        try:
            ras2 = await db[COL_ROLE_ASSIGN].find(
                {"role_id": {"$in": role_ids}},
                {"_id": 0, "user_id": 1},
            ).to_list(8000)
            for ra in ras2:
                uid = str(ra.get("user_id") or "").strip()
                if uid:
                    recipients.append(uid)
        except Exception:
            pass

    out: list[str] = []
    seen = set()
    for u in recipients:
        if u and u not in seen:
            seen.add(u)
            out.append(u)
    return out


async def _get_all_om_user_ids() -> list[str]:
    """
    Best-effort: find all OM accounts. Adjust query if your schema differs.
    - If you store role in users.role: query that.
    - If you store it in a separate OM profile collection: switch to that.
    """
    # Option A: users.role == "OM"
    cur = db[COL_USERS].find({"role": {"$in": ["OM", "Office Manager"]}}, {"_id": 0, "user_id": 1})
    rows = [r async for r in cur]
    ids = [r.get("user_id") for r in rows if r.get("user_id")]
    return list(dict.fromkeys(ids))


async def _get_not_finished_faculty_user_ids(term_id: str) -> list[str]:
    # find faculty_ids that already finished for this term
    finished_ids = await db[COL_FACULTY_PREFS].distinct(
        "faculty_id",
        {"term_id": term_id, "is_finished": True},
    )
    finished_set = set([x for x in finished_ids if x])

    # map faculty_profiles -> user_id for those not finished
    cur = db[COL_FACULTY_PROFILES].find({}, {"_id": 0, "faculty_id": 1, "user_id": 1})
    out: list[str] = []
    async for fp in cur:
        fid = fp.get("faculty_id")
        uid = fp.get("user_id")
        if not uid or not fid:
            continue
        if fid in finished_set:
            continue
        out.append(uid)

    return list(dict.fromkeys(out))


@router.post("/run-prefs-deadline-reminders")
async def run_prefs_deadline_reminders() -> Dict[str, Any]:
    """
    Call this from:
      - a cron/scheduler (recommended),
      - OR on page load (Faculty Preferences + OM Faculty Form),
    to generate deadline reminders for BOTH faculty and OM.

    Reminder timings:
      - 7 days left
      - 1 day left
      - day-of (0 days left)
    """
    term = await _get_active_term_doc()
    if not term or not term.get("term_id"):
        return {"ok": True, "did": "noop", "reason": "no_active_term"}

    term_id = term["term_id"]
    w = await _get_prefs_window_for_term(term_id)
    deadlineISO = w.get("deadlineISO") or ""
    openISO = w.get("openISO") or ""

    deadline_dt = _parse_iso_dt(deadlineISO)
    open_dt = _parse_iso_dt(openISO)

    if not deadline_dt or not open_dt:
        return {"ok": True, "did": "noop", "reason": "no_window"}

    now = datetime.now(timezone.utc)
    manila = timezone(timedelta(hours=8))

    # Only remind while the window is open and not past the deadline
    if now < open_dt or now > deadline_dt:
        return {"ok": True, "did": "noop", "reason": "outside_window"}

    # Whole-day countdown in the user's expected sense (date-difference in UTC).
    # Example: if deadline is tomorrow, days_left == 1.
    days_left = (deadline_dt.astimezone(manila).date() - now.astimezone(manila).date()).days
    if days_left < 0:
        return {"ok": True, "did": "noop", "reason": "past_deadline"}

    # Trigger days: 7, 1, 0 (day-of)
    if days_left not in (7, 1, 0):
        return {"ok": True, "did": "noop", "reason": f"not_reminder_day:{days_left}"}

    # Build message
    when_txt = deadline_dt.astimezone(timezone.utc).strftime("%b %d, %Y %H:%M UTC")
    if days_left == 0:
        title = "Faculty Preferences Due Today"
        details = f"Faculty Preferences submission deadline is today ({when_txt}). Please finalize submissions."
    else:
        title = f"Faculty Preferences Due in {days_left} day{'s' if days_left != 1 else ''}"
        details = f"Faculty Preferences submission deadline is on {when_txt}. Please finalize submissions before the deadline."

    # Targets
    faculty_user_ids = await _get_not_finished_faculty_user_ids(term_id)
    om_user_ids = await _get_all_om_user_ids()

    # Dedupe key per (term, days_left, role target)
    base_key = f"prefs_deadline::{term_id}::{days_left}"

    # Notify faculty who haven't finished
    for uid in faculty_user_ids:
        await _create_notification_once(
            uid,
            title,
            details,
            dedupe_key=f"{base_key}::faculty::{uid}",
            meta={
                "kind": "prefs_deadline",
                "term_id": term_id,
                "days_left": days_left,
                "route": "/faculty/home/preferences",  # adjust to your real route
            },
        )

    # Notify all OM users (include count pending)
    pending_count = len(faculty_user_ids)
    om_details = details + f" Pending faculty submissions: {pending_count}."
    for uid in om_user_ids:
        await _create_notification_once(
            uid,
            title,
            om_details,
            dedupe_key=f"{base_key}::om::{uid}",
            meta={
                "kind": "prefs_deadline",
                "term_id": term_id,
                "days_left": days_left,
                "pending_count": pending_count,
                "route": "/om/home/load-assignment",  # safe existing route used elsewhere
            },
        )

    return {
        "ok": True,
        "did": "sent",
        "term_id": term_id,
        "days_left": days_left,
        "faculty_notified": len(faculty_user_ids),
        "om_notified": len(om_user_ids),
    }


@router.post("/run-om-submit-deadline-reminders")
async def run_om_submit_deadline_reminders() -> Dict[str, Any]:
    """Generate deadline reminders for OM/GS schedule + faculty encoding.

    Reminders are campus-specific (Manila vs Laguna) and are based on the
    APO-set deadline window stored in `om_submit_windows`.

    Trigger days:
      - 7, 3, 2, 1 day(s) before deadline

    NOTE: This is designed to be called by a scheduler/cron. As a fallback,
    `list_notifications()` auto-triggers this runner (throttled).
    """

    term = await _get_active_term_doc()
    if not term or not term.get("term_id"):
        return {"ok": True, "did": "noop", "reason": "no_active_term"}

    term_id = str(term["term_id"]).strip()
    windows = await db[COL_OM_SUBMIT_WINDOWS].find(
        {"term_id": term_id},
        {"_id": 0, "campus_id": 1, "openISO": 1, "deadlineISO": 1},
    ).to_list(None)

    if not windows:
        return {"ok": True, "did": "noop", "reason": "no_windows", "term_id": term_id}

    now = datetime.now(timezone.utc)
    manila = timezone(timedelta(hours=8))

    sent_total = 0
    campuses_checked = 0

    for w in windows:
        campus_raw = str((w or {}).get("campus_id") or "").strip()
        campus_id = (await _normalize_campus_id(campus_raw)) or campus_raw
        open_dt = _parse_iso_dt(str((w or {}).get("openISO") or ""))
        deadline_dt = _parse_iso_dt(str((w or {}).get("deadlineISO") or ""))
        if not open_dt or not deadline_dt:
            continue

        # Only remind while the window is open and not past deadline
        if now < open_dt or now > deadline_dt:
            continue

        days_left = (deadline_dt.astimezone(manila).date() - now.astimezone(manila).date()).days
        if days_left not in (7, 3, 2, 1):
            continue

        campuses_checked += 1

        # Determine if APO already submitted course offerings for this campus.
        # If not yet submitted, the reminder wording should reflect that OM/GS
        # cannot start encoding until submission is available.
        has_apo_submit = False
        try:
            sub = await db[COL_APO_SUBMISSIONS].find_one(
                {"term_id": term_id, "campus_id": campus_id},
                {"_id": 0, "submit_count": 1},
            ) or {}
            has_apo_submit = int(sub.get("submit_count") or 0) > 0
        except Exception:
            has_apo_submit = False

        # Backward-compat if old windows stored campus as a name and normalization changed it.
        if (not has_apo_submit) and campus_raw and campus_raw != campus_id:
            try:
                sub = await db[COL_APO_SUBMISSIONS].find_one(
                    {"term_id": term_id, "campus_id": campus_raw},
                    {"_id": 0, "submit_count": 1},
                ) or {}
                has_apo_submit = int(sub.get("submit_count") or 0) > 0
            except Exception:
                pass

        if not has_apo_submit:
            try:
                prior = await db[COL_SECTIONS].find_one(
                    {"term_id": term_id, "campus_id": campus_id, "submitted_for_scheduling": True},
                    {"_id": 0, "section_id": 1},
                )
                has_apo_submit = bool(prior)
            except Exception:
                has_apo_submit = False

        if (not has_apo_submit) and campus_raw and campus_raw != campus_id:
            try:
                prior = await db[COL_SECTIONS].find_one(
                    {"term_id": term_id, "campus_id": campus_raw, "submitted_for_scheduling": True},
                    {"_id": 0, "section_id": 1},
                )
                has_apo_submit = bool(prior)
            except Exception:
                pass

        # Campus name (best effort)
        campus_name = campus_raw or campus_id
        try:
            camp = await db["campuses"].find_one(
                {"campus_id": campus_id},
                {"_id": 0, "campus_name": 1},
            ) or {}
            campus_name = (camp.get("campus_name") or campus_raw or campus_id or "").strip() or (campus_raw or campus_id)
        except Exception:
            campus_name = campus_raw or campus_id

        when_txt = deadline_dt.astimezone(manila).strftime("%b %d, %Y %H:%M PHT")

        title = (
            "Schedule & Faculty Encoding Due in 1 day"
            if days_left == 1
            else f"Schedule & Faculty Encoding Due in {days_left} days"
        )

        if has_apo_submit:
            details = (
                f"Please complete schedule and faculty encoding for APO-submitted course offerings "
                f"for term {term_id} ({campus_name}) before {when_txt}."
            )
        else:
            details = (
                f"APO has not submitted course offerings yet for term {term_id} ({campus_name}). "
                f"Once submitted, please complete schedule and faculty encoding before {when_txt}."
            )

        recipients = await _om_and_gs_user_ids_for_campus(campus_id)
        if not recipients:
            continue

        # Dedupe per (term, campus, days_left, exact deadline)
        dedupe_base = f"om_schedule_deadline::{term_id}::{campus_id}::{days_left}::{(w or {}).get('deadlineISO') or ''}"

        for uid in recipients:
            await _create_notification_once(
                uid,
                title,
                details,
                dedupe_key=f"{dedupe_base}::{uid}",
                meta={
                    "kind": "om_schedule_deadline_reminder",
                    "term_id": term_id,
                    "campus_id": campus_id,
                    "days_left": days_left,
                    "deadlineISO": (w or {}).get("deadlineISO") or "",
                    "route": "/om/home/load-assignment",
                },
            )
            sent_total += 1

    return {
        "ok": True,
        "did": "sent" if sent_total else "noop",
        "term_id": term_id,
        "campuses_checked": campuses_checked,
        "sent": sent_total,
    }

@router.post("/mark-seen")
async def mark_seen(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    # Accept both `userId` and `user_id` for backward compatibility.
    user_id = (payload.get("userId") or payload.get("user_id") or "").strip()
    if not user_id:
        raise HTTPException(status_code=400, detail="userId is required")

    user_id = await _resolve_canonical_user_id(user_id)

    ids = payload.get("ids") or []
    mark_all = bool(payload.get("all"))

    q: Dict[str, Any] = {"user_id": user_id}
    if mark_all:
        q["seen"] = {"$ne": True}
    else:
        if not ids:
            raise HTTPException(status_code=400, detail="Provide ids[] or set all=true")
        q["notif_id"] = {"$in": ids}

    await db[COL_NOTIFS].update_many(
        q,
        {"$set": {"seen": True, "seen_at": _now_iso()}},
    )

    return {"ok": True}
