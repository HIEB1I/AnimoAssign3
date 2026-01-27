# backend/app/GCAL/GCAL.py
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone, date, time
from typing import Any, Dict, List, Optional, Tuple

from urllib.parse import quote

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from zoneinfo import ZoneInfo

from app.main import db

router = APIRouter(tags=["Google Calendar"])

GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GCAL_BASE = "https://www.googleapis.com/calendar/v3/calendars"


# ----------------------------
# Helpers: parsing
# ----------------------------

DAY_MAP = {
    "monday": 0, "mon": 0,
    "tuesday": 1, "tue": 1,
    "wednesday": 2, "wed": 2,
    "thursday": 3, "thu": 3,
    "friday": 4, "fri": 4,
    "saturday": 5, "sat": 5,
    "sunday": 6, "sun": 6,
}


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
    """
    if not t:
        return None
    s = t.strip()
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
    Converts common dash variants to a normal "-" and strips spaces:
      "7:30 – 9:00" -> "7:30-9:00"
      "7:30 — 9:00" -> "7:30-9:00"
      "7:30 − 9:00" -> "7:30-9:00"
    """
    if not s:
        return ""
    out = s.strip()

    # replace common unicode dashes with "-"
    out = out.replace("–", "-").replace("—", "-").replace("−", "-")

    # remove spaces around
    out = out.replace(" ", "")
    return out


def _parse_time_range(range_s: str) -> Optional[Tuple[time, time]]:
    """
    Accepts:
      "7:30-9:00"
      "7:30 - 9:00"
      "7:30 – 9:00"  (en dash)
      "7:30 — 9:00"  (em dash)
      "7:30 − 9:00"  (minus sign)
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
    client_id = os.getenv("GOOGLE_CLIENT_ID")
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET")

    if not client_id or not client_secret:
        raise HTTPException(500, "Missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET in backend env.")

    data = {
        "client_id": client_id,
        "client_secret": client_secret,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }

    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(GOOGLE_TOKEN_URL, data=data)

    if r.status_code >= 400:
        raise HTTPException(status_code=r.status_code, detail=r.text)

    return r.json()


async def _get_user_google_tokens(user_id: str) -> Dict[str, Any]:
    """
    Return user's stored tokens + connected email.
    connected_email is informational; we insert into "primary" calendar.
    """
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

    if not access_token:
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
    access_token = tokens["access_token"]
    refresh_token = tokens["refresh_token"]

    first = await _insert_event(access_token, calendar_id, event_body)
    if first["status_code"] != 401:
        if first["status_code"] >= 400:
            raise HTTPException(status_code=first["status_code"], detail=first["text"])
        return first["json"] or {}

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
    userId: str
    items: List[Dict[str, Any]] = Field(default_factory=list)
    weeks: int = 5  #  repeat for 5 weeks


# ----------------------------
# Endpoint
# ----------------------------

@router.post("/gcal/teaching-load/accept")
async def accept_teaching_load(payload: TeachingLoadAcceptRequest):
    """
    Expects items from FACULTY_Overview.tsx blocks:
      {
        code, title, section, mode, room, time,
        day: "Monday" | "Tuesday" | ...
      }

    Creates events on the user's PRIMARY calendar using their stored token.
    Title: [Code][Section][Mode]
    Start from acceptance week and repeat weekly for 5 weeks.
    """
    if not payload.userId:
        raise HTTPException(400, "Missing userId")
    if not payload.items:
        raise HTTPException(400, "No schedule items to add")

    weeks = payload.weeks or 5
    if weeks < 1:
        weeks = 1

    tz = ZoneInfo("Asia/Manila")

    accepted_date = datetime.now(tz).date()
    week_start = accepted_date - timedelta(days=accepted_date.weekday())  # Monday

    #  Always insert into the authenticated user's primary calendar
    calendar_id = "primary"

    tok = await _get_user_google_tokens(payload.userId)
    connected_email = tok.get("connected_email")

    created: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []

    for item in payload.items:
        code = _safe_str(item.get("code") or item.get("course_code") or item.get("data", {}).get("code"))
        title = _safe_str(item.get("title") or item.get("course_title") or item.get("data", {}).get("title"))
        section = _safe_str(item.get("section") or item.get("sec") or item.get("data", {}).get("sec"))
        mode = _safe_str(item.get("mode") or item.get("modality") or item.get("data", {}).get("mode"))
        room = _safe_str(item.get("room") or item.get("data", {}).get("room")) or "Online"
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

        # first occurrence in acceptance week
        first_date = week_start + timedelta(days=wd)

        # if the day already passed before acceptance date, schedule next week
        if first_date < accepted_date:
            first_date = first_date + timedelta(days=7)

        start_dt = datetime.combine(first_date, start_t).replace(tzinfo=tz)
        end_dt = datetime.combine(first_date, end_t).replace(tzinfo=tz)

        event_title = f"[{code}][{section}][{mode}]".strip()
        if event_title == "[][][]":
            event_title = "[AnimoAssign] Class"

        event_body: Dict[str, Any] = {
            "summary": event_title,
            "location": room if room else None,
            "description": (
                f"Code: {code}\n"
                f"Title: {title}\n"
                f"Section: {section}\n"
                f"Mode: {mode}\n"
                f"Room: {room}\n"
                f"Time: {time_range}\n\n"
                f"Created by AnimoAssign on acceptance week."
            ),
            "start": {"dateTime": start_dt.isoformat(), "timeZone": "Asia/Manila"},
            "end": {"dateTime": end_dt.isoformat(), "timeZone": "Asia/Manila"},
            "recurrence": [f"RRULE:FREQ=WEEKLY;COUNT={weeks}"],
        }

        if event_body.get("location") is None:
            event_body.pop("location", None)

        created_event = await _insert_event_with_refresh(payload.userId, calendar_id, event_body)

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
