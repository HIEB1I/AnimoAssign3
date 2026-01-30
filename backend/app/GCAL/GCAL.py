# backend/app/GCAL/GCAL.py
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone, time
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

import httpx
from fastapi import APIRouter, HTTPException, Query, Body
from pydantic import BaseModel, Field
from zoneinfo import ZoneInfo

from app.main import db

router = APIRouter(tags=["Google Calendar"])

GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GCAL_BASE = "https://www.googleapis.com/calendar/v3/calendars"

DAY_MAP = {
    "monday": 0, "mon": 0,
    "tuesday": 1, "tue": 1,
    "wednesday": 2, "wed": 2,
    "thursday": 3, "thu": 3,
    "friday": 4, "fri": 4,
    "saturday": 5, "sat": 5,
    "sunday": 6, "sun": 6,
}

RRULE_BYDAY = {0: "MO", 1: "TU", 2: "WE", 3: "TH", 4: "FR", 5: "SA", 6: "SU"}


# ----------------------------
# Helpers: parsing
# ----------------------------
def _safe_str(x: Any) -> str:
    return ("" if x is None else str(x)).strip()


def _parse_day_to_weekday(day: str) -> Optional[int]:
    if not day:
        return None
    return DAY_MAP.get(day.strip().lower())


def _parse_time_hhmm(t: str) -> Optional[time]:
    """
    Accepts:
      "07:30"
      "7:30"
      "0730"
      "730"
    """
    if not t:
        return None
    s = t.strip()

    # digits-only forms
    if s.isdigit():
        if len(s) == 4:
            hh = int(s[:2]); mm = int(s[2:])
            return time(hour=hh, minute=mm)
        if len(s) == 3:
            hh = int(s[:1]); mm = int(s[1:])
            return time(hour=hh, minute=mm)
        return None

    parts = s.split(":")
    if len(parts) != 2:
        return None
    try:
        hh = int(parts[0])
        mm = int(parts[1])
        return time(hour=hh, minute=mm)
    except Exception:
        return None


def _normalize_time_range(s: str) -> str:
    """
    Converts common dash variants to "-" and removes spaces:
      "7:30 – 9:00" -> "7:30-9:00"
      "7:30 — 9:00" -> "7:30-9:00"
      "7:30 − 9:00" -> "7:30-9:00"
    """
    if not s:
        return ""
    out = s.strip()
    out = out.replace("–", "-").replace("—", "-").replace("−", "-")
    out = out.replace(" ", "")
    return out


def _parse_time_range(range_s: str) -> Optional[Tuple[time, time]]:
    """
    Accepts:
      "7:30-9:00"
      "7:30 - 9:00"
      "7:30 – 9:00"
      "0730-0900"
    """
    if not range_s:
        return None
    raw = _normalize_time_range(range_s)
    if "-" not in raw:
        return None
    a, b = raw.split("-", 1)
    start_t = _parse_time_hhmm(a)
    end_t = _parse_time_hhmm(b)
    if not start_t or not end_t:
        return None
    return start_t, end_t


# ----------------------------
# Helpers: token handling
# ----------------------------
async def _refresh_access_token(refresh_token: str) -> Dict[str, Any]:
    client_id = (os.getenv("GOOGLE_CLIENT_ID") or "").strip()
    client_secret = (os.getenv("GOOGLE_CLIENT_SECRET") or "").strip()

    if not client_id or not client_secret:
        raise HTTPException(500, "Missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET in backend env.")

    data = {
        "client_id": client_id,
        "client_secret": client_secret,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }

    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(
            GOOGLE_TOKEN_URL,
            data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )

    if r.status_code >= 400:
        raise HTTPException(status_code=r.status_code, detail=r.text)

    return r.json()


async def _get_user_google_tokens(user_id: str) -> Dict[str, Any]:
    user = await db["users"].find_one(
        {"user_id": user_id},
        {"_id": 0, "google_token": 1, "gmail": 1, "email": 1},
    )
    if not user:
        raise HTTPException(404, "User not found")

    gt = user.get("google_token") if isinstance(user.get("google_token"), dict) else {}
    gt = gt or {}

    access_token = (gt.get("access_token") or "").strip()
    refresh_token = (gt.get("refresh_token") or "").strip()
    connected_email = (gt.get("connected_email") or "").strip().lower()

    if not connected_email:
        connected_email = (user.get("gmail") or user.get("email") or "").strip().lower()

    # Access token may be empty but refresh token exists; we can refresh later.
    if not access_token and not refresh_token:
        raise HTTPException(401, "User has no Google token stored. Please login with Google again.")

    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "connected_email": connected_email,
    }


async def _insert_event(access_token: str, calendar_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    cal = quote(calendar_id, safe="")
    url = f"{GCAL_BASE}/{cal}/events"

    headers = {"Authorization": f"Bearer {access_token}"}
    async with httpx.AsyncClient(timeout=25) as client:
        r = await client.post(url, headers=headers, json=body)

    ct = r.headers.get("content-type", "")
    data = r.json() if ct.startswith("application/json") else None
    return {"status_code": r.status_code, "text": r.text, "json": data}


async def _insert_event_with_refresh(user_id: str, calendar_id: str, event_body: Dict[str, Any]) -> Dict[str, Any]:
    tokens = await _get_user_google_tokens(user_id)
    access_token = (tokens.get("access_token") or "").strip()
    refresh_token = (tokens.get("refresh_token") or "").strip()

    # If no access token but we have refresh, refresh first
    if not access_token and refresh_token:
        new_tokens = await _refresh_access_token(refresh_token)
        access_token = (new_tokens.get("access_token") or "").strip()
        if not access_token:
            raise HTTPException(401, "Failed to refresh Google token. Please login again.")
        await db["users"].update_one(
            {"user_id": user_id},
            {"$set": {"google_token.access_token": access_token, "google_token.updated_at": datetime.now(timezone.utc)}},
        )

    first = await _insert_event(access_token, calendar_id, event_body)
    if first["status_code"] != 401:
        if first["status_code"] >= 400:
            raise HTTPException(status_code=first["status_code"], detail=first["text"])
        return first["json"] or {}

    # 401 -> refresh and retry
    if not refresh_token:
        raise HTTPException(401, "Google token expired/invalid. Please login with Google again.")

    new_tokens = await _refresh_access_token(refresh_token)
    new_access = (new_tokens.get("access_token") or "").strip()
    if not new_access:
        raise HTTPException(401, "Failed to refresh Google token. Please login again.")

    await db["users"].update_one(
        {"user_id": user_id},
        {"$set": {"google_token.access_token": new_access, "google_token.updated_at": datetime.now(timezone.utc)}},
    )

    second = await _insert_event(new_access, calendar_id, event_body)
    if second["status_code"] >= 400:
        raise HTTPException(status_code=second["status_code"], detail=second["text"])
    return second["json"] or {}


# ----------------------------
# Request model
# ----------------------------
class TeachingLoadAcceptRequest(BaseModel):
    # allow userId either in body OR query param
    userId: Optional[str] = None
    items: List[Dict[str, Any]] = Field(default_factory=list)
    weeks: int = 5


# ----------------------------
# Endpoint
# ----------------------------
@router.post("/gcal/teaching-load/accept")
async def accept_teaching_load(
    payload: TeachingLoadAcceptRequest = Body(...),
    userId: str = Query("", alias="userId"),
):
    """
    Creates Google Calendar events on the user's PRIMARY calendar using stored Google tokens.
    Creates ONE event per schedule item, weekly recurrence for N weeks.
    Prevents timezone shifting by using timezone-aware datetimes (+08:00) and BYDAY in RRULE.
    """
    uid = (payload.userId or userId or "").strip()
    if not uid:
        raise HTTPException(400, "Missing userId")
    if not payload.items:
        raise HTTPException(400, "No schedule items to add")

    weeks = payload.weeks or 5
    if weeks < 1:
        weeks = 1

    tz = ZoneInfo("Asia/Manila")
    now_local = datetime.now(tz)
    accepted_date = now_local.date()
    week_start = accepted_date - timedelta(days=accepted_date.weekday())  # Monday anchor

    calendar_id = "primary"
    tok = await _get_user_google_tokens(uid)
    connected_email = tok.get("connected_email")

    created: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []

    for item in payload.items:
        code = _safe_str(item.get("code") or item.get("course_code") or item.get("data", {}).get("code"))
        title = _safe_str(item.get("title") or item.get("course_title") or item.get("data", {}).get("title"))
        section = _safe_str(item.get("section") or item.get("sec") or item.get("data", {}).get("sec"))
        mode = _safe_str(item.get("mode") or item.get("modality") or item.get("data", {}).get("mode"))
        room = _safe_str(item.get("room") or item.get("data", {}).get("room"))
        day = _safe_str(item.get("day"))
        time_range = _safe_str(item.get("time") or item.get("data", {}).get("time"))

        if not day or day.lower() == "tba" or not time_range:
            skipped.append({"item": item, "reason": "TBA or missing day/time"})
            continue

        wd = _parse_day_to_weekday(day)
        tr = _parse_time_range(time_range)

        if wd is None:
            skipped.append({"item": item, "reason": f"Unknown day value: {day}"})
            continue
        if tr is None:
            skipped.append({"item": item, "reason": f"Bad time range: {time_range}"})
            continue

        start_t, end_t = tr

        # pick first occurrence: acceptance week day, else next week
        first_date = week_start + timedelta(days=wd)

        # If the date is already behind accepted date, push next week
        if first_date < accepted_date:
            first_date = first_date + timedelta(days=7)

        # If it's today but time already passed, also push next week
        if first_date == accepted_date:
            start_dt_test = datetime.combine(first_date, start_t, tzinfo=tz)
            if start_dt_test <= now_local:
                first_date = first_date + timedelta(days=7)

        start_dt = datetime.combine(first_date, start_t, tzinfo=tz)
        end_dt = datetime.combine(first_date, end_t, tzinfo=tz)
        if end_dt <= start_dt:
            end_dt = end_dt + timedelta(days=1)

        byday = RRULE_BYDAY.get(wd, None)

        event_title = f'[{code}][{section}][{mode}]'.strip()
        if event_title == "[][][]":
            event_title = "[AnimoAssign] Class"

        if not room:
            room = "Online"

        event_body: Dict[str, Any] = {
            "summary": event_title,
            "location": room,
            "description": (
                f"Code: {code}\n"
                f"Title: {title}\n"
                f"Section: {section}\n"
                f"Mode: {mode}\n"
                f"Room: {room}\n"
                f"Time: {time_range}\n\n"
                "Created by AnimoAssign on acceptance week."
            ),
            # timezone-aware ISO like 2026-01-28T07:30:00+08:00 (prevents 11:30pm shift)
           "start": {"dateTime": start_dt.isoformat(), "timeZone": "Asia/Manila"},
            "end": {"dateTime": end_dt.isoformat(), "timeZone": "Asia/Manila"},
            "recurrence": [
                f"RRULE:FREQ=WEEKLY;COUNT={weeks}" + (f";BYDAY={byday}" if byday else "")
            ],
            "reminders": {"useDefault": False, "overrides": [{"method": "popup", "minutes": 30}]},
        }

        created_event = await _insert_event_with_refresh(uid, calendar_id, event_body)

        created.append({
            "summary": created_event.get("summary"),
            "id": created_event.get("id"),
            "htmlLink": created_event.get("htmlLink"),
            "start": created_event.get("start"),
            "end": created_event.get("end"),
        })

    return {
        "calendarId": calendar_id,
        "connected_email": connected_email,
        "created_count": len(created),
        "skipped_count": len(skipped),
        "created": created,
        "skipped": skipped,
        "weeks": weeks,
        "accepted_date": str(accepted_date),
    }
