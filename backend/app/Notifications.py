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
import time
from typing import Any, Dict, Optional
from uuid import uuid4

import httpx

from fastapi import APIRouter, Body, HTTPException, Query

from .main import db

router = APIRouter(prefix="/notifications", tags=["notifications"])

COL_NOTIFS = "notifications"

logger = logging.getLogger("animoassign.notifications")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


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

    for key in ("gmail", "email", "dlsu_email", "google_email", "connected_email"):
        val = (user.get(key) or "")
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""



def _build_notif_link(route: str) -> str:
    base = (os.getenv("ANIMOASSIGN_WEB_URL") or "").strip() or "http://ccscloud.dlsu.edu.ph:11160/"
    base = base.rstrip("/")
    route = (route or "").strip()
    if not route:
        return base
    if not route.startswith("/"):
        route = "/" + route
    return base + route


def _make_email_subject(title: str) -> str:
    t = (title or "").strip() or "Notification"
    if t.lower().startswith("[animoassign]"):
        return t
    return f"[AnimoAssign] {t}"


def _build_notification_email_text(*, name: str, title: str, details: str, link: str) -> str:
    # Keep this readable in plain text clients.
    safe_name = (name or "User").strip() or "User"
    safe_title = (title or "Notification").strip() or "Notification"
    safe_details = (details or "").strip()
    safe_link = (link or "").strip()
    return (
        f"Hi {safe_name},\n\n"
        f"{safe_title}\n\n"
        f"{safe_details}\n\n"
        f"Open in AnimoAssign: {safe_link}\n\n"
        "— AnimoAssign"
    )


def _build_notification_email_html(*, name: str, title: str, details: str, link: str) -> str:
    # Simple, email-client-friendly HTML (tables + inline styles).
    safe_name = _html_escape((name or "User").strip() or "User")
    safe_title = _html_escape((title or "Notification").strip() or "Notification")
    safe_details = _html_escape((details or "").strip()).replace("\n", "<br>")
    safe_link = _html_escape((link or "").strip())
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
              <td style="padding:20px 24px;background:#0B6B3A;color:#ffffff;font-family:Arial,Helvetica,sans-serif;">
                <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.9;">AnimoAssign</div>
                <div style="font-size:20px;font-weight:700;margin-top:6px;line-height:1.25;">{safe_title}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:22px 24px;font-family:Arial,Helvetica,sans-serif;color:#111827;font-size:14px;line-height:1.55;">
                <p style="margin:0 0 12px 0;">Hi {safe_name},</p>
                <p style="margin:0 0 18px 0;color:#374151;">{safe_details}</p>
                <div style="text-align:center;margin:0 0 18px 0;">
                  <a href="{safe_link}" style="display:inline-block;background:#16A34A;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700;">Open in AnimoAssign</a>
                </div>
                <p style="margin:18px 0 0 0;color:#6b7280;font-size:12px;">If the button doesn't work, copy and paste this link:</p>
                <p style="margin:8px 0 0 0;font-size:12px;">
                  <a href="{safe_link}" style="color:#16A34A;word-break:break-all;">{safe_link}</a>
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:14px 24px;background:#f9fafb;font-family:Arial,Helvetica,sans-serif;color:#6b7280;font-size:12px;line-height:1.4;">
                You're receiving this email because you have a notification in AnimoAssign.
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
                    access_token = (tok.get("access_token") or "").strip()
                    refresh_token = (tok.get("refresh_token") or "").strip()
                    if access_token or refresh_token:
                        return candidate
            except Exception:
                # Ignore and fall back to env sender.
                pass

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
        sender_user_id = await _resolve_sender_user_id(email_from_user_id)
        if not sender_user_id:
            return

        recipient = await db[COL_USERS].find_one({"user_id": recipient_user_id}, {"_id": 0})
        if not recipient:
            return

        to_email = _user_email(recipient)
        if not to_email:
            return

        name = _user_display_name(recipient)
        route = ((meta or {}) if isinstance(meta, dict) else {}).get("route") or ""
        link = _build_notif_link(str(route))

        subject = _make_email_subject(title)
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

        await _send_email_via_user_gmail(
            sender_user_id=sender_user_id,
            to_email=to_email,
            subject=subject,
            text_body=text_body,
            html_body=html_body,
        )
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
    userId: str = Query(..., description="Current logged-in user's id"),
    limit: int = Query(25, ge=1, le=100),
) -> Dict[str, Any]:
    cur = (
        db[COL_NOTIFS]
        .find({"user_id": userId}, {"_id": 0})
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
    await create_notification(user_id=user_id, title=title, details=details, meta=m)


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

    # Only remind while the window is open and not past the deadline
    if now < open_dt or now > deadline_dt:
        return {"ok": True, "did": "noop", "reason": "outside_window"}

    seconds_left = (deadline_dt - now).total_seconds()
    days_left = 0

    # days_left = int(seconds_left // 86400)  # floor

    # Trigger days: 7, 1, 0
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

@router.post("/mark-seen")
async def mark_seen(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    user_id = payload.get("userId")
    if not user_id:
        raise HTTPException(status_code=400, detail="userId is required")

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
