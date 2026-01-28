# backend/app/Notifications.py
# -----------------------------------------------------------------------------
# In-app notifications stored in MongoDB.
# This powers the reusable Topbar bell across roles.
# -----------------------------------------------------------------------------

from __future__ import annotations

from datetime import datetime, timezone, timedelta
from typing import Any, Dict, Optional
from uuid import uuid4

from fastapi import APIRouter, Body, HTTPException, Query

from .main import db

router = APIRouter(prefix="/notifications", tags=["notifications"])

COL_NOTIFS = "notifications"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def create_notification(
    user_id: str,
    title: str,
    details: str,
    meta: Optional[Dict[str, Any]] = None,
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
