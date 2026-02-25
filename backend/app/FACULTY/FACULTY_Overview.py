# backend/app/FACULTY/FACULTY_Overview.py
from fastapi import APIRouter, Query, HTTPException, Body
from ..main import db

# In-app bell notifications (shared Notifications collection)
from ..Notifications import create_notification
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
import re

from html import escape as _html_escape

import os
import base64
from email.message import EmailMessage
import httpx

from urllib.parse import quote

from datetime import timedelta
try:
    from zoneinfo import ZoneInfo
except Exception:
    ZoneInfo = None  # fallback to UTC if zoneinfo isn't available

_GCAL_EVENTS_INSERT_URL = "https://calendar.googleapis.com/calendar/v3/calendars/primary/events"
_DEFAULT_TZ = (os.getenv("ANIMOASSIGN_TZ") or "Asia/Manila").strip()
_TERM_WEEK_COUNT = int(os.getenv("TERM_WEEK_COUNT") or "12")

_WEEKDAY_IDX = {
    "Monday": 0, "Tuesday": 1, "Wednesday": 2, "Thursday": 3,
    "Friday": 4, "Saturday": 5, "Sunday": 6,
}


_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
_GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
# RFC email recipient fallback.
# Prefer sending to the OM user's email (resolved at runtime) if available.
# Otherwise fall back to env RFC_EMAIL_TO, then this hardcoded value.
_RFC_EMAIL_TO = os.getenv("RFC_EMAIL_TO") or "johntario27@gmail.com"

router = APIRouter(prefix="/faculty", tags=["faculty"])

COL_NOTIFICATIONS = "notifications"
COL_FACULTY = "faculty_profiles"
COL_TERMS = "terms"
COL_ASSIGN = "faculty_assignments"
COL_SECTIONS = "sections"
COL_SCHED = "section_schedules"
COL_ROOMS = "rooms"
COL_CAMPUSES = "campuses"
COL_COURSES = "courses"
COL_DEPTS = "departments"

# Special Class reflection (OM_SpecialClass -> Faculty)
COL_SPECIAL_CLASS = "special_class"
COL_FACULTY_SERVICE = "faculty_service"

# OM <-> Faculty proposal + RFC collections
COL_LOAD_PROPOSALS = "faculty_load_proposals"
COL_LOAD_RFC = "faculty_rfc"

import uuid

def _gcal_events_insert_url(calendar_id: str = "primary") -> str:
    return f"https://www.googleapis.com/calendar/v3/calendars/{quote(calendar_id, safe='')}/events"

def _to_hhmm(v: Any) -> str:
    """Normalize various DB time formats to 4-digit HHMM used by _hhmm_to_hm.

    Accepts: "730", "0730", 730, "07:30", "7:30".
    Returns: "0730" or "" if cannot parse.
    """
    if v is None:
        return ""
    s = str(v).strip()
    if not s:
        return ""
    if re.fullmatch(r"\d{3,4}", s):
        return f"0{s}" if len(s) == 3 else s
    m = re.fullmatch(r"(\d{1,2})\s*:\s*(\d{2})", s)
    if m:
        hh = str(int(m.group(1))).zfill(2)
        mm = m.group(2)
        return f"{hh}{mm}"
    return ""


async def _room_number_from_schedule(sc: Dict[str, Any]) -> str:
    """Return room label for a schedule row.

    Rules (match CHAIR_Plantilla behavior):
    - If room_type is Online -> "ONLINE"
    - Else if room_id exists -> lookup rooms.room_number, fallback "TBA"
    - Else -> "TBA"
    """
    raw_type = str(sc.get("room_type") or "").strip()
    room_id = str(sc.get("room_id") or "").strip()

    # IMPORTANT: If a physical room_id exists, display it even if room_type was (incorrectly)
    # stored as "Online" (delivery mode). Only treat as ONLINE when room_id is blank/none or
    # explicitly equals "ONLINE".
    if raw_type.lower() == "online" and (not room_id or room_id.upper() == "ONLINE"):
        return "ONLINE"

    if room_id:
        r = await db[COL_ROOMS].find_one(
            {"room_id": room_id},
            {"_id": 0, "room_number": 1},
        )
        rn = (r or {}).get("room_number")
        return str(rn).strip() if rn else "TBA"

    return "TBA"


async def _special_class_schedule_two(
    *,
    section_id: str | None,
    schedule_id1: str | None,
    schedule_id2: str | None,
    schedule_cleared: bool,
) -> Dict[str, Any]:
    """Derive Day/Time/Room fields for a Special Class.

    The special_class collection typically stores schedule_id1/2 (not day/begin/end/room).
    Faculty Overview must compute schedule from section_schedules so List/Calendar are correct
    even when rooms are not yet assigned.
    """
    if schedule_cleared:
        return {
            "day1": "TBA",
            "begin1": "",
            "end1": "",
            "room1": "TBA",
            "day2": "",
            "begin2": "",
            "end2": "",
            "room2": "",
            "room1_room_type": "",
            "room2_room_type": "",
        }

    sids = [str(x).strip() for x in [schedule_id1, schedule_id2] if str(x or "").strip()]
    scheds: List[Dict[str, Any]] = []

    if sids:
        scheds = await db[COL_SCHED].find(
            {"schedule_id": {"$in": sids}},
            {"_id": 0, "schedule_id": 1, "day": 1, "start_time": 1, "end_time": 1, "room_type": 1, "room_id": 1},
        ).to_list(10)
        scheds.sort(key=lambda x: str(x.get("schedule_id") or ""))
    elif section_id:
        scheds = await db[COL_SCHED].find(
            {"section_id": section_id},
            {"_id": 0, "schedule_id": 1, "day": 1, "start_time": 1, "end_time": 1, "room_type": 1, "room_id": 1},
        ).to_list(10)
        scheds.sort(key=lambda x: str(x.get("schedule_id") or ""))

    def _empty():
        return {"day": "TBA", "begin": "", "end": "", "room": "TBA", "room_type": ""}

    slots = [_empty(), _empty()]
    for i in range(min(2, len(scheds))):
        sc = scheds[i] or {}
        slots[i] = {
            "day": (sc.get("day") or "TBA"),
            "begin": _to_hhmm(sc.get("start_time")),
            "end": _to_hhmm(sc.get("end_time")),
            "room": await _room_number_from_schedule(sc),
            "room_type": str(sc.get("room_type") or "").strip(),
        }

    return {
        "day1": slots[0]["day"],
        "begin1": slots[0]["begin"],
        "end1": slots[0]["end"],
        "room1": slots[0]["room"],
        "room1_room_type": slots[0]["room_type"],
        "day2": slots[1]["day"] if len(scheds) > 1 else "",
        "begin2": slots[1]["begin"] if len(scheds) > 1 else "",
        "end2": slots[1]["end"] if len(scheds) > 1 else "",
        "room2": slots[1]["room"] if len(scheds) > 1 else "",
        "room2_room_type": slots[1]["room_type"] if len(scheds) > 1 else "",
    }

async def _resolve_section_id_from_code_and_section(term_id: str, course_code: str, section_code: str) -> str:
    course_code = (course_code or "").strip()
    section_code = (section_code or "").strip()
    if not course_code or not section_code:
        return ""

    # find course_id from course_code
    course = await db[COL_COURSES].find_one(
        {"$or": [{"course_code": course_code}, {"code": course_code}]},
        {"_id": 0, "course_id": 1},
    )
    if not course:
        return ""

    course_id = (course.get("course_id") or "").strip()
    if not course_id:
        return ""

    base_q = {
        "course_id": course_id,
        "$or": [
            {"section_code": section_code},
            {"section": section_code},
            {"section_name": section_code},
        ],
    }

    # prefer term match if your sections store term_id
    sec = None
    if term_id:
        sec = await db[COL_SECTIONS].find_one({**base_q, "term_id": term_id}, {"_id": 0, "section_id": 1})
        if not sec:
            sec = await db[COL_SECTIONS].find_one({**base_q, "termId": term_id}, {"_id": 0, "section_id": 1})

    if not sec:
        sec = await db[COL_SECTIONS].find_one(base_q, {"_id": 0, "section_id": 1})

    return (sec or {}).get("section_id") or ""


async def _refresh_access_token(refresh_token: str) -> Dict[str, Any]:
    client_id = os.getenv("GOOGLE_CLIENT_ID")
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise HTTPException(
            status_code=500,
            detail="Missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET in backend env.",
        )

    data = {
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }

    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(_GOOGLE_TOKEN_URL, data=data)

    if r.status_code >= 400:
        raise HTTPException(status_code=r.status_code, detail=r.text)

    return r.json()

async def _send_email_via_user_gmail(
    user_id: str,
    to_email: str,
    subject: str,
    body: str,
     html_body: Optional[str] = None,
) -> Tuple[bool, Optional[str]]:

    user = await db["users"].find_one({"user_id": user_id}, {"_id": 0, "google_token": 1})
    if not user:
        return False, "User not found."

    gt = user.get("google_token") or {}
    access_token = (gt.get("access_token") or "").strip()
    refresh_token = (gt.get("refresh_token") or "").strip()

    if not access_token and not refresh_token:
        return False, "User has no connected Google token. Re-login with Google."

    msg = EmailMessage()
    msg["To"] = to_email
    msg["Subject"] = subject

    msg.set_content(body or "")

    if html_body:
        msg.add_alternative(html_body, subtype="html")
        
    raw_b64 = base64.urlsafe_b64encode(msg.as_bytes()).decode("utf-8")

    async def _try_send(token: str) -> httpx.Response:
        headers = {"Authorization": f"Bearer {token}"}
        async with httpx.AsyncClient(timeout=20) as client:
            return await client.post(_GMAIL_SEND_URL, headers=headers, json={"raw": raw_b64})

    # 1) Try with access token
    if access_token:
        r = await _try_send(access_token)
        if r.status_code < 400:
            return True, None
        # if not 401, fail fast (403 often means missing gmail.send scope)
        if r.status_code != 401:
            return False, r.text

    # 2) Refresh then retry
    if not refresh_token:
        return False, "Access token expired and no refresh_token available. Reconnect Google."

    try:
        tokens = await _refresh_access_token(refresh_token)
    except Exception as e:
        return False, f"Token refresh failed: {e}"

    new_access = (tokens.get("access_token") or "").strip()
    if not new_access:
        return False, "Failed to refresh Google access token."

    now = _now_utc()
    await db["users"].update_one(
        {"user_id": user_id},
        {"$set": {
            "google_token.access_token": new_access,
            "google_token.updated_at": now,
            "google_token.expires_in": tokens.get("expires_in"),
            "google_token.scope": tokens.get("scope"),
        }},
    )

    r2 = await _try_send(new_access)
    if r2.status_code < 400:
        return True, None
    return False, r2.text


def _pick_tzinfo():
    if ZoneInfo:
        try:
            return ZoneInfo(_DEFAULT_TZ)
        except Exception:
            return timezone.utc
    return timezone.utc

def _parse_time_band_to_hm(band: str):
    """
    Accepts: "07:30 – 09:00", "07:30-09:00", etc.
    Returns: ((h1,m1),(h2,m2)) or None
    """
    if not band:
        return None
    s = band.strip()
    if not s or "TBA" in s.upper():
        return None

    s = s.replace("–", "-").replace("—", "-")
    parts = [p.strip() for p in s.split("-") if p.strip()]
    if len(parts) != 2:
        return None

    def _one(t: str):
        m = re.search(r"(\d{1,2}):(\d{2})", t)
        if m:
            return int(m.group(1)), int(m.group(2))
        digits = re.sub(r"\D", "", t)
        if len(digits) == 3:
            return int(digits[0]), int(digits[1:])
        if len(digits) == 4:
            return int(digits[:2]), int(digits[2:])
        return None

    a = _one(parts[0])
    b = _one(parts[1])
    if not a or not b:
        return None
    return a, b

def _first_date_on_or_after(start_date, target_weekday: int):
    # start_date is a date() in local tz
    delta = (target_weekday - start_date.weekday()) % 7
    return start_date + timedelta(days=delta)

async def _insert_gcal_event(token: str, event_body: Dict[str, Any]) -> httpx.Response:
    headers = {"Authorization": f"Bearer {token}"}
    url = _gcal_events_insert_url("primary")
    async with httpx.AsyncClient(timeout=25) as client:
        r = await client.post(url, headers=headers, json=event_body)
    return r

async def _create_term_calendar_for_user(
    *,
    user_id: str,
    term_start_at: datetime,
    rows: List[Dict[str, Any]],
    week_count: int = _TERM_WEEK_COUNT,
) -> Tuple[bool, int, Optional[str]]:
    """
    Creates weekly recurring events (COUNT=week_count) starting from the week of term_start_at.
    Returns (ok, events_created, error)
    """
    user = await db["users"].find_one({"user_id": user_id}, {"_id": 0, "google_token": 1})
    if not user:
        return False, 0, "User not found."

    gt = user.get("google_token") or {}
    access_token = (gt.get("access_token") or "").strip()
    refresh_token = (gt.get("refresh_token") or "").strip()

    if not access_token and not refresh_token:
        return False, 0, "No Google token. User must login with Google (calendar.events scope)."

    tzinfo = _pick_tzinfo()
    term_start_local_date = _coerce_dt(term_start_at).astimezone(tzinfo).date()

    created = 0

    async def _ensure_token_and_retry(event_body: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
        nonlocal access_token

        # try current access token first
        if access_token:
            r = await _insert_gcal_event(access_token, event_body)
            if r is None:
                return False, "Calendar insert returned no response (check _insert_gcal_event return)."
            if r.status_code < 400:
                return True, None

            if r.status_code < 400:
                return True, None
            if r.status_code != 401:
                return False, r.text

        # refresh if possible
        if not refresh_token:
            return False, "Access token expired and no refresh_token available. Reconnect Google."

        tokens = await _refresh_access_token(refresh_token)
        new_access = (tokens.get("access_token") or "").strip()
        if not new_access:
            return False, "Failed to refresh Google access token."

        access_token = new_access
        await db["users"].update_one(
            {"user_id": user_id},
            {"$set": {
                "google_token.access_token": new_access,
                "google_token.updated_at": _now_utc(),
                "google_token.expires_in": tokens.get("expires_in"),
                "google_token.scope": tokens.get("scope"),
            }},
        )

        r2 = await _insert_gcal_event(new_access, event_body)
        if r2.status_code < 400:
            return True, None
        return False, r2.text

    def _make_event(*, course_code: str, section: str, day_full: str, time_band: str, room: str, mode: str):
        hm = _parse_time_band_to_hm(time_band)
        if not hm:
            return None

        (sh, sm), (eh, em) = hm
        day_full = _to_full_day(day_full)
        wd = _WEEKDAY_IDX.get(day_full)
        if wd is None:
            return None

        first_date = _first_date_on_or_after(term_start_local_date, wd)

        start_dt = datetime(first_date.year, first_date.month, first_date.day, sh, sm, tzinfo=tzinfo)
        end_dt = datetime(first_date.year, first_date.month, first_date.day, eh, em, tzinfo=tzinfo)

        title = f"{(course_code or '').strip()} {(section or '').strip()}".strip() or "Class"
        location = (room or "").strip() or "Online"
        desc = (
            f"Mode: {(mode or '').strip()}\n"
            f"Created by AnimoAssign upon schedule acceptance.\n"
            f"Login: {_aa_login_link()}"
        )

        return {
            "summary": title,
            "location": location,
            "description": desc,
            "start": {"dateTime": start_dt.isoformat(), "timeZone": _DEFAULT_TZ},
            "end": {"dateTime": end_dt.isoformat(), "timeZone": _DEFAULT_TZ},
            "recurrence": [f"RRULE:FREQ=WEEKLY;COUNT={int(week_count)}"],
        }

    for rr in rows or []:
        course_code = rr.get("course_code") or rr.get("course") or ""
        section = rr.get("section") or ""
        mode = rr.get("mode") or ""

        # Special class display rule: treat ONLINE as TBA (so email/list and calendar are consistent).
        def _room_for_calendar(raw_room: Any) -> str:
            s = ("" if raw_room is None else str(raw_room)).strip()
            if not s:
                return "TBA"
            if bool(rr.get("is_special_class")) and s.upper() == "ONLINE":
                return "TBA"
            return s

        # Meeting 1
        ev1 = _make_event(
            course_code=course_code,
            section=section,
            day_full=rr.get("day1") or "",
            time_band=rr.get("time1") or "",
            room=_room_for_calendar(rr.get("room1") or "TBA"),
            mode=mode,
        )
        if ev1:
            ok1, err1 = await _ensure_token_and_retry(ev1)
            if ok1:
                created += 1
            else:
                # don't stop everything; just return the first hard error
                return False, created, err1

        # Meeting 2 (optional)
        ev2 = _make_event(
            course_code=course_code,
            section=section,
            day_full=rr.get("day2") or "",
            time_band=rr.get("time2") or "",
            room=_room_for_calendar(rr.get("room2") or rr.get("room1") or "TBA"),
            mode=mode,
        )
        if ev2:
            ok2, err2 = await _ensure_token_and_retry(ev2)
            if ok2:
                created += 1
            else:
                return False, created, err2

    return True, created, None


RFC_TERMINAL = {"ACCEPTED", "APPROVED", "REJECTED"}


def _coerce_dt(v: Any) -> Optional[datetime]:
    """Best-effort parse for datetimes stored as datetime/ISO string/epoch seconds."""
    if v is None:
        return None
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    # epoch seconds / millis
    if isinstance(v, (int, float)):
        try:
            # heuristics: > 10^12 likely ms
            if v > 1_000_000_000_000:
                return datetime.fromtimestamp(v / 1000.0, tz=timezone.utc)
            return datetime.fromtimestamp(v, tz=timezone.utc)
        except Exception:
            return None
    s = str(v).strip()
    if not s:
        return None
    # try ISO8601
    try:
        # normalize 'Z'
        if s.endswith('Z'):
            s = s[:-1] + '+00:00'
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _pick_dt(doc: Dict[str, Any], keys: List[str]) -> Optional[datetime]:
    for k in keys:
        if k in doc and doc.get(k) is not None:
            dt = _coerce_dt(doc.get(k))
            if dt:
                return dt
    return None


def _proposal_ts(proposal: Dict[str, Any]) -> Optional[datetime]:
    # Prefer 'forwarded/sent' time if present; otherwise updated/created.
    return _pick_dt(proposal, ['forwarded_at', 'sent_at', 'submitted_at', 'updated_at', 'created_at', 'createdAt'])


def _section_ts(section: Dict[str, Any]) -> Optional[datetime]:
    # Prefer import/created time if present; otherwise updated.
    return _pick_dt(section, ['imported_at', 'created_at', 'createdAt', 'updated_at', 'updatedAt'])

def _hhmm_to_hm(v: object | None) -> str:
    """Convert 'HHMM' (e.g., '0730') to 'HH:MM'. Leaves other formats untouched."""
    if v is None:
        return ""
    s = str(v).strip()
    if re.fullmatch(r"\d{4}", s):
        return f"{s[:2]}:{s[2:]}"
    return s


def _day_code_to_long(v: Any) -> str:
    s = ("" if v is None else str(v)).strip().upper()
    if not s:
        return "TBA"
    if s in ("M", "MON"):
        return "Monday"
    if s in ("T", "TU", "TUE"):
        return "Tuesday"
    if s in ("W", "WED"):
        return "Wednesday"
    if s in ("H", "TH", "THU", "R"):
        return "Thursday"
    if s in ("F", "FRI"):
        return "Friday"
    if s in ("S", "SAT"):
        return "Saturday"
    # Already long?
    cap = s[:1].upper() + s[1:].lower()
    if cap in ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"):
        return cap
    return cap


def _fmt_band_from_hhmm(begin: Any, end: Any) -> str:
    b = _hhmm_to_hm(begin)
    e = _hhmm_to_hm(end)
    if not b or not e:
        return "TBA"
    return f"{b} – {e}"


async def _latest_faculty_id_for_section(section_id: str) -> str:
    section_id = (section_id or "").strip()
    if not section_id:
        return ""
    row = (
        await db[COL_ASSIGN]
        .find(
            {"section_id": section_id, "is_archived": {"$ne": True}},
            {"_id": 0, "faculty_id": 1},
        )
        .sort([("created_at", -1)])
        .limit(1)
        .to_list(1)
    )
    return ((row[0] or {}).get("faculty_id") or "").strip() if row else ""


async def _fetch_reflected_special_classes_for_faculty(
    *,
    term_id: str,
    faculty_id: str,
    limit: int = 500,
) -> List[Dict[str, Any]]:
    """Fetch Approved Special Class rows that belong to a faculty.

    These are reflected to Faculty calendar + list with a distinct styling and RFC disabled.
    """

    term_id = (term_id or "").strip()
    faculty_id = (faculty_id or "").strip()
    if not term_id or not faculty_id:
        return []

    docs = await db[COL_SPECIAL_CLASS].find(
        {"term_id": term_id, "status": "Approved"},
        {
            "_id": 0,
            "special_id": 1,
            "course_id": 1,
            "courseId": 1,
            "course_code": 1,
            "courseCode": 1,
            "course_title": 1,
            "courseTitle": 1,
            "course_units": 1,
            "units": 1,
            "section_id": 1,
            "section_code": 1,
            "section": 1,
            "assignment_id": 1,
            "faculty_assignment_id": 1,
            "schedule_cleared": 1,
            "schedule_id1": 1,
            "schedule_id2": 1,
            "day1": 1,
            "begin1": 1,
            "end1": 1,
            "day2": 1,
            "begin2": 1,
            "end2": 1,
            "room1": 1,
            "room2": 1,
            "room1_room_type": 1,
            "room2_room_type": 1,
            "updated_at": 1,
        },
    ).sort([("updated_at", -1)]).limit(limit).to_list(limit)

    out: List[Dict[str, Any]] = []
    # NOTE: The special_class collection can contain multiple versions of the same
    # special_id over time. The UI must show only the latest Approved row.
    # We sort by updated_at DESC above, so first-seen wins.
    seen_special: set[str] = set()

    for d in docs or []:
        special_id = (d.get("special_id") or "").strip()
        if not special_id:
            continue
        if special_id in seen_special:
            continue
        seen_special.add(special_id)

        # Determine owning faculty
        assignment_id = (d.get("assignment_id") or d.get("faculty_assignment_id") or "").strip()
        sec_id = (d.get("section_id") or "").strip()

        fac_id = ""
        if assignment_id:
            asg = await db[COL_ASSIGN].find_one(
                {"assignment_id": assignment_id, "is_archived": {"$ne": True}},
                {"_id": 0, "faculty_id": 1},
            )
            fac_id = ((asg or {}).get("faculty_id") or "").strip()
        if not fac_id and sec_id:
            fac_id = await _latest_faculty_id_for_section(sec_id)

        if not fac_id or fac_id != faculty_id:
            continue

        # Resolve course details best-effort
        course_id = (d.get("course_id") or d.get("courseId") or "").strip()
        course_code = (d.get("course_code") or d.get("courseCode") or "").strip()
        course_title = (d.get("course_title") or d.get("courseTitle") or "").strip()
        units = d.get("course_units")
        if units in (None, ""):
            units = d.get("units")

        if (not course_code or not course_title or units in (None, "")) and course_id:
            cdoc = await db[COL_COURSES].find_one(
                {"course_id": course_id},
                {"_id": 0, "course_code": 1, "course_title": 1, "units": 1, "syllabus": 1},
            ) or {}
            if not course_code:
                cc = cdoc.get("course_code")
                if isinstance(cc, list):
                    course_code = (cc[0] if cc else "") or ""
                else:
                    course_code = (cc or "").strip()
            if not course_title:
                course_title = (cdoc.get("course_title") or "").strip()
            if units in (None, ""):
                units = cdoc.get("units")

        # ---------------- SECTION (CRITICAL)
        # Special Class rows may store section_code inconsistently (or not at all).
        # CHAIR_Plantilla derives the section display from the sections table.
        # Faculty Overview must do the same so both List + Calendar views show the correct section.
        sec_id_real = (d.get("section_id") or "").strip()
        section_display = (d.get("section_code") or d.get("section") or "").strip()

        # If we have section_id but no section code text, derive it from sections.
        if sec_id_real and not section_display:
            sdoc = await db[COL_SECTIONS].find_one(
                {"section_id": sec_id_real},
                {"_id": 0, "section_code": 1, "section": 1, "section_name": 1},
            ) or {}
            section_display = (
                (sdoc.get("section_code") or sdoc.get("section") or sdoc.get("section_name") or "").strip()
            )

        # If we only have a section text but no section_id (older/edge docs), attempt to resolve.
        if (not sec_id_real) and section_display and course_code:
            resolved_sec_id = await _resolve_section_id_from_code_and_section(
                term_id=term_id,
                course_code=course_code,
                section_code=section_display,
            )
            if resolved_sec_id:
                sec_id_real = resolved_sec_id
                sdoc = await db[COL_SECTIONS].find_one(
                    {"section_id": sec_id_real},
                    {"_id": 0, "section_code": 1, "section": 1, "section_name": 1},
                ) or {}
                section_display = (
                    (sdoc.get("section_code") or sdoc.get("section") or sdoc.get("section_name") or section_display).strip()
                )

        # Schedule (IMPORTANT: special_class usually stores schedule_id1/2, not day/begin/end)
        sch = await _special_class_schedule_two(
            section_id=(sec_id_real or (d.get("section_id") or "").strip()) or None,
            schedule_id1=(d.get("schedule_id1") or "").strip() or None,
            schedule_id2=(d.get("schedule_id2") or "").strip() or None,
            schedule_cleared=bool(d.get("schedule_cleared")),
        )

        day1 = _day_code_to_long(sch.get("day1"))
        time1 = _fmt_band_from_hhmm(sch.get("begin1"), sch.get("end1"))
        room1 = (sch.get("room1") or "TBA")

        day2_raw = _day_code_to_long(sch.get("day2")) if sch.get("day2") else ""
        time2_raw = _fmt_band_from_hhmm(sch.get("begin2"), sch.get("end2")) if (sch.get("begin2") or sch.get("end2")) else ""
        room2_raw = (sch.get("room2") or "").strip()

        if day2_raw and day2_raw != "TBA" and time2_raw and time2_raw != "TBA":
            day2 = day2_raw
            time2 = time2_raw
            room2 = room2_raw or "TBA"
        else:
            day2 = None
            time2 = None
            room2 = None

        mode = (sch.get("room1_room_type") or sch.get("room2_room_type") or "Special Class")

        # Units can be stored as float/int/string; normalize to number
        units_num = 0
        try:
            units_num = int(float(units or 0))
        except Exception:
            units_num = 0

        out.append({
            # Use a unique surrogate section_id so RFC/GCal de-dup does not collide with real sections.
            "section_id": f"SPECIAL:{special_id}",
            "special_id": special_id,
            "is_special_class": True,
            "course_code": course_code,
            "course_title": course_title,
            "section": section_display or "—",
            "units": units_num,
            "mode": mode,
            "day1": day1,
            "time1": time1,
            "room1": room1,
            "day2": day2,
            "time2": time2,
            "room2": room2,
            "syllabus": "",
        })

    # Keep stable ordering: sort by course_code then section.
    out.sort(key=lambda x: (x.get("course_code", ""), x.get("section", "")))
    return out


def _is_real_room_label(room_label: str) -> bool:
    r = str(room_label or "").strip().upper()
    if not r:
        return False
    return r not in {"TBA", "ONLINE", "—", "N/A"}

def _serviced_mode_from_rooms(room1: str | None, room2: str | None) -> str:
    # Requirement: if APO assigned a room in either Room 1 or Room 2 (or both), mode should be HYB.
    # Otherwise default to FOL.
    return "HYB" if (_is_real_room_label(room1 or "") or _is_real_room_label(room2 or "")) else "FOL"

async def _serviced_section_map_for_faculty(*, term_id: str, faculty_id: str) -> Dict[str, str]:
    """Return section_id -> from_department for CHAIR-approved Faculty Service rows (status=responded).

    faculty_service rows do not store term_id directly; we validate section membership in the given term
    to avoid stale artifacts after DB restore/clean.
    """
    term_id = (term_id or "").strip()
    faculty_id = (faculty_id or "").strip()
    if not term_id or not faculty_id:
        return {}

    docs = await db[COL_FACULTY_SERVICE].find(
        {"status": "responded", "faculty.faculty_id": faculty_id},
        {"_id": 0, "section_id": 1, "from_department": 1},
    ).to_list(None)

    sec_ids = [str((d or {}).get("section_id") or "").strip() for d in (docs or [])]
    sec_ids = [s for s in sec_ids if s]
    if not sec_ids:
        return {}

    sec_docs = await db[COL_SECTIONS].find(
        {"section_id": {"$in": sec_ids}, "$or": [{"term_id": term_id}, {"termId": term_id}]},
        {"_id": 0, "section_id": 1},
    ).to_list(None)
    valid = {str(s.get("section_id") or "").strip() for s in (sec_docs or []) if s and s.get("section_id")}

    out: Dict[str, str] = {}
    for d in (docs or []):
        sid = str((d or {}).get("section_id") or "").strip()
        if not sid or sid not in valid:
            continue
        out[sid] = str((d or {}).get("from_department") or "").strip()
    return out

async def _apply_section_schedule_to_row(row: Dict[str, Any], section_id: str) -> None:
    """Override day/time/room fields from authoritative section_schedules + rooms.

    This guarantees:
    - If room is not assigned -> 'TBA' (so Calendar and List match)
    - Auto-updates when APO assigns rooms
    """
    section_id = (section_id or "").strip()
    if not section_id:
        return

    sch = await _special_class_schedule_two(
        section_id=section_id,
        schedule_id1=None,
        schedule_id2=None,
        schedule_cleared=False,
    )

    day1 = _day_code_to_long(sch.get("day1"))
    time1 = _fmt_band_from_hhmm(sch.get("begin1"), sch.get("end1"))
    room1 = (sch.get("room1") or "TBA") or "TBA"

    day2_raw = _day_code_to_long(sch.get("day2")) if sch.get("day2") else ""
    time2_raw = _fmt_band_from_hhmm(sch.get("begin2"), sch.get("end2")) if (sch.get("begin2") or sch.get("end2")) else ""
    room2_raw = (sch.get("room2") or "").strip()

    if day2_raw and day2_raw != "TBA" and time2_raw and time2_raw != "TBA":
        day2 = day2_raw
        time2 = time2_raw
        room2 = room2_raw or "TBA"
    else:
        day2 = None
        time2 = None
        room2 = None

    row["day1"] = day1 or "TBA"
    row["time1"] = time1 or "TBA"
    row["room1"] = room1 or "TBA"
    row["day2"] = day2
    row["time2"] = time2
    row["room2"] = room2

    # Mode rule for serviced rows.
    if bool(row.get("is_serviced")) and not bool(row.get("is_special_class")):
        row["mode"] = _serviced_mode_from_rooms(row.get("room1"), row.get("room2"))

async def _fetch_reflected_faculty_service_rows_for_faculty(
    *,
    term_id: str,
    faculty_id: str,
    exclude_section_ids: set[str] | None = None,
    limit: int = 500,
) -> List[Dict[str, Any]]:
    """Build synthetic teaching_load rows for CHAIR-approved Faculty Service assignments.

    Faculty overview normally shows rows from `faculty_assignments`. However, Faculty Service approvals
    (status=responded) may not create a faculty_assignments record.
    We reflect them similarly to Special Classes via synthetic rows.
    """
    term_id = (term_id or "").strip()
    faculty_id = (faculty_id or "").strip()
    if not term_id or not faculty_id:
        return []

    exclude_section_ids = exclude_section_ids or set()

    docs = await db[COL_FACULTY_SERVICE].find(
        {"status": "responded", "faculty.faculty_id": faculty_id},
        {"_id": 0, "section_id": 1, "from_department": 1},
    ).sort([("updated_at", -1), ("created_at", -1)]).limit(limit).to_list(limit)

    sec_ids = [str((d or {}).get("section_id") or "").strip() for d in (docs or [])]
    sec_ids = [s for s in sec_ids if s and s not in exclude_section_ids]
    if not sec_ids:
        return []

    sec_docs = await db[COL_SECTIONS].find(
        {"section_id": {"$in": sec_ids}, "$or": [{"term_id": term_id}, {"termId": term_id}]},
        {"_id": 0, "section_id": 1, "section_code": 1, "section": 1, "section_name": 1, "course_id": 1},
    ).to_list(None)

    sec_by_id: Dict[str, Dict[str, Any]] = {
        str(s.get("section_id") or "").strip(): (s or {})
        for s in (sec_docs or [])
        if s and s.get("section_id")
    }

    valid_ids = [sid for sid in sec_ids if sid in sec_by_id]
    if not valid_ids:
        return []

    course_ids = [str(sec_by_id[sid].get("course_id") or "").strip() for sid in valid_ids]
    course_ids = [c for c in course_ids if c]
    course_by_id: Dict[str, Dict[str, Any]] = {}
    if course_ids:
        course_docs = await db[COL_COURSES].find(
            {"course_id": {"$in": course_ids}},
            {"_id": 0, "course_id": 1, "course_code": 1, "course_title": 1, "units": 1, "syllabus": 1},
        ).to_list(None)
        course_by_id = {
            str(c.get("course_id") or "").strip(): (c or {})
            for c in (course_docs or [])
            if c and c.get("course_id")
        }

    # Latest doc per section_id (first wins because sorted newest first)
    doc_by_sid: Dict[str, Dict[str, Any]] = {}
    for d in (docs or []):
        sid = str((d or {}).get("section_id") or "").strip()
        if sid and sid in valid_ids and sid not in doc_by_sid:
            doc_by_sid[sid] = d or {}

    out: List[Dict[str, Any]] = []
    for sid in valid_ids:
        d = doc_by_sid.get(sid, {})
        sec = sec_by_id.get(sid, {})
        course = course_by_id.get(str(sec.get("course_id") or "").strip(), {})

        cc = course.get("course_code")
        if isinstance(cc, list):
            cc = cc[0] if cc else ""
        course_code = _as_code_str(cc or "")
        course_title = _as_code_str(course.get("course_title") or "")
        units = course.get("units") or 0
        syllabus = course.get("syllabus") or ""

        section_display = _as_code_str(
            (sec.get("section_code") or sec.get("section") or sec.get("section_name") or "—")
        )

        row: Dict[str, Any] = {
            "course_code": course_code or "—",
            "course_title": course_title or "—",
            "section": section_display or "—",
            "section_id": sid,
            "special_id": "",
            "is_special_class": False,
            "is_serviced": True,
            "serviced_department": str(d.get("from_department") or "").strip(),
            "units": units or 0,
            "mode": "FOL",
            "day1": "TBA",
            "day2": None,
            "room1": "TBA",
            "room2": None,
            "time1": "TBA",
            "time2": None,
            "syllabus": syllabus,
            "finalized": False,
        }

        await _apply_section_schedule_to_row(row, sid)
        # Ensure mode obeys serviced rule
        row["mode"] = _serviced_mode_from_rooms(row.get("room1"), row.get("room2"))

        out.append(row)

    out.sort(key=lambda x: (x.get("course_code", ""), x.get("section", "")))
    return out



def _calc_units_and_preps(teaching_load: List[Dict[str, Any]]) -> Tuple[float, int]:
    """Compute teaching units + course preps for the faculty overview.

    Rules:
    - Units are counted once per unique section_id.
    - Course preps are unique by course_code.
    - Special Classes are expected to carry a unique synthetic section_id (e.g., 'SPECIAL:<id>').
    """
    uniq_units: Dict[str, float] = {}
    for r in teaching_load or []:
        sid = str(r.get("section_id") or "").strip()
        if not sid:
            continue
        try:
            u = float(r.get("units") or 0)
        except Exception:
            u = 0.0
        uniq_units[sid] = u

    total_units = float(sum(uniq_units.values()))
    preps = len({str(r.get("course_code") or "").strip() for r in teaching_load or [] if str(r.get("course_code") or "").strip()})
    return total_units, preps

def _fmt_time_band(begin: str | None, end: str | None) -> str:
    b = _hhmm_to_hm(begin)
    e = _hhmm_to_hm(end)
    if not b or not e:
        return ""
    return f"{b}–{e}"

def _as_code_str(v: object) -> str:
    if v is None:
        return ""
    s = str(v).strip()
    return s

def _normalize_rfc_doc(doc: Dict[str, Any]) -> Dict[str, Any]:
    """Backwards-compatible normalization for RFC docs."""
    if not doc:
        return {}
    d = dict(doc)
    if not d.get("rfc_id"):
        d["rfc_id"] = d.get("rfcId") or "RFC" + uuid.uuid4().hex[:10].upper()
    raw_msgs = d.get("messages") if isinstance(d.get("messages"), list) else d.get("thread")
    msgs = []
    if isinstance(raw_msgs, list):
        for m in raw_msgs:
            if not isinstance(m, dict):
                continue
            if "sender_role" in m:
                msgs.append({
                    "sender_role": m.get("sender_role"),
                    "sender_user_id": m.get("sender_user_id"),
                    "message": m.get("message"),
                    "created_at": m.get("created_at"),
                })
            else:
                msgs.append({
                    "sender_role": m.get("from"),
                    "sender_user_id": m.get("from_user_id"),
                    "message": m.get("message"),
                    "created_at": (m.get("created_at").isoformat() if hasattr(m.get("created_at"), "isoformat") else m.get("created_at")),
                })
    d["messages"] = msgs
    st = (d.get("status") or "").upper()
    if st in RFC_TERMINAL or st in {"NEEDS_OM", "NEEDS_FACULTY", "OPEN"}:
        d["status"] = st
    elif (d.get("status") or "") == "open":
        last = msgs[-1]["sender_role"] if msgs else "faculty"
        d["status"] = "NEEDS_OM" if last == "faculty" else "NEEDS_FACULTY"
    elif (d.get("status") or "") == "closed":
        d["status"] = "APPROVED" if d.get("decision") == "approve" else "REJECTED"
    else:
        d["status"] = "OPEN"
    return d

def _now_utc():
    return datetime.now(timezone.utc)


# --- Helpers tied to your actual terms schema (augmented JSON) ---

async def _next_term_from_current() -> Dict[str, Any] | None:
    cur = await db["terms"].find_one({"is_current": True}, {"_id": 0})
    if not cur:
        return None

    ay = cur.get("acad_year_start")
    tn = cur.get("term_number")
    if ay is None or tn is None:
        return None

    nxt = await db["terms"].find_one(
        {"acad_year_start": ay, "term_number": int(tn) + 1},
        {"_id": 0},
    )
    if nxt:
        return nxt

    # fallback: earliest term whose start_at is after current.start_at
    cur_start = cur.get("start_at")
    if cur_start:
        nxt = await db["terms"].find_one(
            {"start_at": {"$gt": cur_start}},
            {"_id": 0},
            sort=[("start_at", 1)],
        )
        return nxt

    return None

async def _active_term() -> Dict[str, Any]:
    # 1) find the current anchor (must be is_current=True)
    cur = await db.terms.find_one(
        {"is_current": True},
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
    )
    if not cur:
        return {} # No anchor, so no "next" term

    # 2) get the next term in chronological order
    nxt = await db.terms.find(
        {
            "$or": [
                {"acad_year_start": {"$gt": cur["acad_year_start"]}},
                {
                    "acad_year_start": cur["acad_year_start"],
                    "term_number": {"$gt": cur["term_number"]},
                },
            ]
        },
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1, "is_current": 1}, 
    ).sort([("acad_year_start", 1), ("term_number", 1)]).to_list(1)
    
    # Return the next term, or an empty dict if no "next" term is found
    return (nxt[0] if nxt else {})

async def _get_current_term() -> Optional[Dict[str, Any]]:
    # 1) prefer is_current == True
    term = await db.terms.find_one({"is_current": True}, {"_id": 0})
    if term:
        term["term_label"] = _term_label(term)
        return term
    # No current term -> just say None here (we will fetch "previous" elsewhere)
    return None


def _term_label(t: Dict[str, Any]) -> str:
    ay = str(t.get("acad_year_start", "")).strip()
    try:
        ay_next = str(int(ay) + 1)
    except Exception:
        ay_next = ""
    tn = t.get("term_number", "")
    if ay and ay_next and tn:
        return f"AY {ay}-{ay_next} • Term {tn}"
    if tn:
        return f"Term {tn}"
    return "Term"

def _aa_web_base() -> str:
    # Prefer your deployed URL if set; fallback to localhost
    base = (os.getenv("ANIMOASSIGN_WEB_URL") or os.getenv("FRONTEND_URL") or "http://localhost:5173").strip()
    return base.rstrip("/")

def _aa_login_link() -> str:
    return _aa_web_base() + "/login"

def _build_load_accept_email_text(*, faculty_name: str, term_label: str, rows: List[Dict[str, Any]], login_link: str) -> str:
    lines = [
        f"Hi {faculty_name},",
        "",
        f"You have ACCEPTED your teaching load for {term_label}.",
        "",
        "Teaching Load Summary:",
        "Course | Section | Units | Mode | Day1 | Time1 | Room1 | Day2 | Time2 | Room2",
        "-" * 86,
    ]
    for r in rows:
        lines.append(
            f"{(r.get('course_code') or '')} | {(r.get('section') or '')} | {(r.get('units') or '')} | {(r.get('mode') or '')} | "
            f"{(r.get('day1') or '')} | {(r.get('time1') or '')} | {(r.get('room1') or '')} | "
            f"{(r.get('day2') or '')} | {(r.get('time2') or '')} | {(r.get('room2') or '')}"
        )

    lines += [
        "",
        "To view your schedule inside AnimoAssign, log in here:",
        login_link,
        "",
        "— AnimoAssign",
    ]
    return "\n".join(lines)

def _build_load_accept_email_html(*, faculty_name: str, term_label: str, rows: List[Dict[str, Any]], login_link: str) -> str:
    safe_name = _html_escape((faculty_name or "Faculty").strip() or "Faculty")
    safe_term = _html_escape((term_label or "Term").strip() or "Term")
    safe_link = _html_escape((login_link or "").strip())
    preheader = _html_escape(f"Teaching load accepted for {term_label}"[:120])

    # Build table rows
    tr = []
    for r in rows:
        course = _html_escape(str(r.get("course_code") or ""))
        sec = _html_escape(str(r.get("section") or ""))
        units = _html_escape(str(r.get("units") or ""))
        mode = _html_escape(str(r.get("mode") or ""))
        day1 = _html_escape(str(r.get("day1") or ""))
        time1 = _html_escape(str(r.get("time1") or ""))
        room1 = _html_escape(str(r.get("room1") or ""))
        day2 = _html_escape(str(r.get("day2") or ""))
        time2 = _html_escape(str(r.get("time2") or ""))
        room2 = _html_escape(str(r.get("room2") or ""))

        tr.append(f"""
          <tr>
            <td style="padding:10px 10px;border-top:1px solid #e5e7eb;">{course}</td>
            <td style="padding:10px 10px;border-top:1px solid #e5e7eb;text-align:center;">{sec}</td>
            <td style="padding:10px 10px;border-top:1px solid #e5e7eb;text-align:center;">{units}</td>
            <td style="padding:10px 10px;border-top:1px solid #e5e7eb;text-align:center;">{mode}</td>
            <td style="padding:10px 10px;border-top:1px solid #e5e7eb;text-align:center;">{day1}</td>
            <td style="padding:10px 10px;border-top:1px solid #e5e7eb;text-align:center;">{time1}</td>
            <td style="padding:10px 10px;border-top:1px solid #e5e7eb;">{room1}</td>
            <td style="padding:10px 10px;border-top:1px solid #e5e7eb;text-align:center;">{day2}</td>
            <td style="padding:10px 10px;border-top:1px solid #e5e7eb;text-align:center;">{time2}</td>
            <td style="padding:10px 10px;border-top:1px solid #e5e7eb;">{room2}</td>
          </tr>
        """)

    rows_html = "\n".join(tr) if tr else """
      <tr><td colspan="10" style="padding:12px;border-top:1px solid #e5e7eb;color:#6b7280;text-align:center;">
        No schedule rows found.
      </td></tr>
    """

    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Teaching Load Accepted</title>
  </head>
  <body style="margin:0;padding:0;background:#f6f7fb;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">{preheader}</div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7fb;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0"
                 style="width:600px;max-width:92vw;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 6px 18px rgba(17,24,39,0.08);">
            <tr>
              <td style="padding:20px 24px;background:#0B6B3A;color:#ffffff;font-family:Arial,Helvetica,sans-serif;">
                <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.9;">AnimoAssign</div>
                <div style="font-size:20px;font-weight:700;margin-top:6px;line-height:1.25;">Teaching Load Accepted</div>
              </td>
            </tr>

            <tr>
              <td style="padding:22px 24px;font-family:Arial,Helvetica,sans-serif;color:#111827;font-size:14px;line-height:1.55;">
                <p style="margin:0 0 10px 0;">Hi {safe_name},</p>
                <p style="margin:0 0 16px 0;color:#374151;">
                  This confirms you have <b>ACCEPTED</b> your teaching load for <b>{safe_term}</b>.
                </p>

                <div style="border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
                  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:12px;">
                    <thead style="background:#f3f4f6;color:#111827;">
                      <tr>
                        <th style="padding:10px 10px;text-align:left;">Course</th>
                        <th style="padding:10px 10px;text-align:center;">Section</th>
                        <th style="padding:10px 10px;text-align:center;">Units</th>
                        <th style="padding:10px 10px;text-align:center;">Mode</th>
                        <th style="padding:10px 10px;text-align:center;">Day 1</th>
                        <th style="padding:10px 10px;text-align:center;">Time 1</th>
                        <th style="padding:10px 10px;text-align:left;">Room 1</th>
                        <th style="padding:10px 10px;text-align:center;">Day 2</th>
                        <th style="padding:10px 10px;text-align:center;">Time 2</th>
                        <th style="padding:10px 10px;text-align:left;">Room 2</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows_html}
                    </tbody>
                  </table>
                </div>

                <div style="text-align:center;margin:18px 0 10px 0;">
                  <a href="{safe_link}" style="display:inline-block;background:#16A34A;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700;">
                    Log in to AnimoAssign
                  </a>
                </div>

                <p style="margin:0;color:#6b7280;font-size:12px;">
                  If the button doesn’t work, copy and paste this link:
                  <a href="{safe_link}" style="color:#16A34A;word-break:break-all;">{safe_link}</a>
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:14px 24px;background:#f9fafb;font-family:Arial,Helvetica,sans-serif;color:#6b7280;font-size:12px;line-height:1.4;">
                You’re receiving this email because you accepted your teaching load in AnimoAssign.
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>"""

# ====== OM NOTIFY EMAIL (drop-in) ======
OM_NOTIFY_EMAIL = (os.getenv("ANIMOASSIGN_OM_NOTIFY_EMAIL") or "jdom.animoassign@gmail.com").strip()
OM_LOAD_ASSIGNMENT_URL = (
    os.getenv("ANIMOASSIGN_OM_LOAD_ASSIGNMENT_URL")
    or "http://ccscloud.dlsu.edu.ph:11160/om/load-assignment"
).strip()

def _build_om_finalized_email(
    *,
    term_label: str,
    faculty_name: str,
    rows: List[Dict[str, Any]],
    om_link: str,
) -> Tuple[str, str, str]:
    safe_name = _html_escape((faculty_name or "Faculty").strip() or "Faculty")
    safe_term = _html_escape((term_label or "Term").strip() or "Term")
    safe_link = _html_escape((om_link or "").strip())
    preheader = _html_escape(f"{faculty_name} finalized teaching load for {term_label}"[:120])

    subject = f"[AnimoAssign] Faculty load finalized • {faculty_name} • {term_label}"

    # Plain text
    lines = [
        "Hi OM,",
        "",
        f"{faculty_name} has ACCEPTED and FINALIZED the faculty load assignment.",
        f"Term: {term_label}",
        "",
        "Schedule:",
    ]
    for r in rows:
        lines.append(
            f"- {r.get('course_code','')} {r.get('section','')} | {r.get('units','')}u | "
            f"{r.get('day1','')} {r.get('time1','')} {r.get('room1','')} | "
            f"{(r.get('day2') or '')} {(r.get('time2') or '')} {(r.get('room2') or '')}"
        )
    lines += ["", f"Open OM page: {om_link}", "", "— AnimoAssign"]
    body_text = "\n".join(lines)

    # Build HTML rows (same columns as your accepted-email table)
    tr = []
    for r in rows:
        course = _html_escape(str(r.get("course_code") or ""))
        sec = _html_escape(str(r.get("section") or ""))
        units = _html_escape(str(r.get("units") or ""))
        mode = _html_escape(str(r.get("mode") or ""))
        day1 = _html_escape(str(r.get("day1") or ""))
        time1 = _html_escape(str(r.get("time1") or ""))
        room1 = _html_escape(str(r.get("room1") or ""))
        day2 = _html_escape(str(r.get("day2") or ""))
        time2 = _html_escape(str(r.get("time2") or ""))
        room2 = _html_escape(str(r.get("room2") or ""))

        tr.append(f"""
          <tr>
            <td style="padding:10px 10px;border-top:1px solid #e5e7eb;">{course}</td>
            <td style="padding:10px 10px;border-top:1px solid #e5e7eb;text-align:center;">{sec}</td>
            <td style="padding:10px 10px;border-top:1px solid #e5e7eb;text-align:center;">{units}</td>
            <td style="padding:10px 10px;border-top:1px solid #e5e7eb;text-align:center;">{mode}</td>
            <td style="padding:10px 10px;border-top:1px solid #e5e7eb;text-align:center;">{day1}</td>
            <td style="padding:10px 10px;border-top:1px solid #e5e7eb;text-align:center;">{time1}</td>
            <td style="padding:10px 10px;border-top:1px solid #e5e7eb;">{room1}</td>
            <td style="padding:10px 10px;border-top:1px solid #e5e7eb;text-align:center;">{day2}</td>
            <td style="padding:10px 10px;border-top:1px solid #e5e7eb;text-align:center;">{time2}</td>
            <td style="padding:10px 10px;border-top:1px solid #e5e7eb;">{room2}</td>
          </tr>
        """)

    rows_html = "\n".join(tr) if tr else """
      <tr><td colspan="10" style="padding:12px;border-top:1px solid #e5e7eb;color:#6b7280;text-align:center;">
        No schedule rows found.
      </td></tr>
    """

    # Inbox-style card layout (same visual pattern as inbox_email + your accepted email)
    body_html = f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Faculty Load Finalized</title>
  </head>
  <body style="margin:0;padding:0;background:#f6f7fb;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">{preheader}</div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7fb;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0"
                 style="width:600px;max-width:92vw;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 6px 18px rgba(17,24,39,0.08);">
            <tr>
              <td style="padding:20px 24px;background:#0B6B3A;color:#ffffff;font-family:Arial,Helvetica,sans-serif;">
                <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.9;">AnimoAssign</div>
                <div style="font-size:20px;font-weight:700;margin-top:6px;line-height:1.25;">Faculty Load Finalized</div>
              </td>
            </tr>

            <tr>
              <td style="padding:22px 24px;font-family:Arial,Helvetica,sans-serif;color:#111827;font-size:14px;line-height:1.55;">
                <p style="margin:0 0 10px 0;">Hi OM,</p>
                <p style="margin:0 0 16px 0;color:#374151;">
                  Faculty <b>{safe_name}</b> has <b>ACCEPTED</b> and <b>FINALIZED</b> the load assignment for <b>{safe_term}</b>.
                </p>

                <div style="border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
                  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:12px;">
                    <thead style="background:#f3f4f6;color:#111827;">
                      <tr>
                        <th style="padding:10px 10px;text-align:left;">Course</th>
                        <th style="padding:10px 10px;text-align:center;">Section</th>
                        <th style="padding:10px 10px;text-align:center;">Units</th>
                        <th style="padding:10px 10px;text-align:center;">Mode</th>
                        <th style="padding:10px 10px;text-align:center;">Day 1</th>
                        <th style="padding:10px 10px;text-align:center;">Time 1</th>
                        <th style="padding:10px 10px;text-align:left;">Room 1</th>
                        <th style="padding:10px 10px;text-align:center;">Day 2</th>
                        <th style="padding:10px 10px;text-align:center;">Time 2</th>
                        <th style="padding:10px 10px;text-align:left;">Room 2</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows_html}
                    </tbody>
                  </table>
                </div>

                <div style="text-align:center;margin:18px 0 10px 0;">
                  <a href="{safe_link}" style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;
                                             padding:10px 14px;border-radius:10px;font-weight:700;font-size:14px;">
                    Open OM Load Assignment
                  </a>
                </div>

                <p style="margin:14px 0 0 0;color:#6b7280;font-size:12px;">
                  If the button doesn’t work, copy and paste this link:<br/>
                  <a href="{safe_link}" style="color:#0B6B3A;text-decoration:underline;">{safe_link}</a>
                </p>

                <hr style="border:none;border-top:1px solid #e5e7eb;margin:18px 0;" />
                <p style="margin:0;color:#6b7280;font-size:12px;">
                  This email was sent by AnimoAssign using the faculty’s connected Gmail account.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
"""
    return subject, body_text, body_html
# ====== end drop-in ======

def _build_load_accept_email(*, faculty_name: str, term_label: str, rows: List[Dict[str, Any]]) -> Tuple[str, str, str]:
    login_link = _aa_login_link()
    subject = f"[AnimoAssign] Teaching Load Accepted - {term_label}"
    text_body = _build_load_accept_email_text(
        faculty_name=faculty_name, term_label=term_label, rows=rows, login_link=login_link
    )
    html_body = _build_load_accept_email_html(
        faculty_name=faculty_name, term_label=term_label, rows=rows, login_link=login_link
    )
    return subject, text_body, html_body


def _as_code_str(val) -> str:
    if isinstance(val, list):
        return " / ".join(str(x) for x in val if x).strip()
    return str(val or "").strip()

_DAY_MAP = {
    "M": "Monday", "MON": "Monday",
    "T": "Tuesday", "TU": "Tuesday", "TUE": "Tuesday",
    "W": "Wednesday", "WED": "Wednesday",
    "TH": "Thursday", "THU": "Thursday", "H": "Thursday", "R": "Thursday",
    "F": "Friday", "FRI": "Friday",
    "S": "Saturday", "SAT": "Saturday",
}
_DAY_ORDER = {"Monday": 1, "Tuesday": 2, "Wednesday": 3, "Thursday": 4, "Friday": 5, "Saturday": 6}


def _to_full_day(day_val: str) -> str:
    s = (day_val or "").strip().upper()
    return _DAY_MAP.get(s, day_val or "")

def _fmt_hhmm(raw: Any) -> str:
    if raw is None:
        return ""
    s = str(raw).strip()
    if ":" in s:
        return s 
    if not s.isdigit():
        return s
    if len(s) == 3:
        h = int(s[0])
        m = int(s[1:])
    elif len(s) == 4:
        h = int(s[:2])
        m = int(s[2:])
    else:
        return s
    return f"{h:02d}:{m:02d}"

def _fmt_time_band(start_raw: Any, end_raw: Any) -> str:
    st = _fmt_hhmm(start_raw)
    en = _fmt_hhmm(end_raw)
    return f"{st} – {en}".strip(" –")

@router.post("/overview")
async def overview_handler(
    userId: str = Query(..., min_length=3),
    action: str = Query("fetch", description="fetch | options | profile"),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    # ---------- FACULTY (resolve first; used by all actions) ----------
    faculty = await db.faculty_profiles.find_one({"user_id": userId}, {"_id": 0})
    if not faculty:
        raise HTTPException(status_code=404, detail="Faculty not found for the given userId")

    # ---------- options ----------
    if action == "options":
        # Provide UI option lists needed by Faculty Overview.
        # Frontend expects `kacs` here so faculty can edit their Qualified KACs.
        kacs = await db.kacs.find(
            {},
            {
                "_id": 0,
                "kac_id": 1,
                "kac_name": 1,
                "kac_code": 1,
                "program_area": 1,
                "course_list": 1,
            },
        ).to_list(None)

        # Expand course_list (course_id) to course_code + course_title so the frontend can
        # show the course list while editing Qualified KACs in My Profile.
        course_ids: List[str] = []
        for kd in (kacs or []):
            for cid in (kd.get("course_list") or []):
                if isinstance(cid, str) and cid.strip():
                    course_ids.append(cid.strip())
        course_ids = sorted(set(course_ids))

        courses_map: Dict[str, Dict[str, Any]] = {}
        if course_ids:
            course_docs = await db[COL_COURSES].find(
                {"course_id": {"$in": course_ids}},
                {"_id": 0, "course_id": 1, "course_code": 1, "course_title": 1},
            ).to_list(None)
            for cd in (course_docs or []):
                cid = str(cd.get("course_id") or "").strip()
                if not cid:
                    continue
                courses_map[cid] = {
                    "course_id": cid,
                    "course_code": _as_code_str(cd.get("course_code")),
                    "course_title": cd.get("course_title") or "",
                }

        for kd in (kacs or []):
            clist = []
            for cid in (kd.get("course_list") or []):
                scid = str(cid or "").strip()
                if not scid:
                    continue
                clist.append(courses_map.get(scid, {"course_id": scid, "course_code": "", "course_title": ""}))
            kd["courses"] = clist

        # Stable ordering for predictable UI.
        try:
            kacs.sort(key=lambda x: (str(x.get("program_area") or ""), str(x.get("kac_name") or "")))
        except Exception:
            pass

        return {
            "ok": True,
            "days": ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"],
            "timeBands": ["07:30 – 09:00","09:15 – 10:45","11:00 – 12:30","12:30 – 14:15","14:30 – 16:00","16:15 – 17:45","18:00 – 19:30","19:45 – 21:00"],
            "kacs": kacs,
        }

    # ---------- profile ----------
    if action == "profile":
        dept = await db.departments.find_one(
            {"department_id": faculty.get("department_id")},
            {"_id": 0, "dept_name": 1},
        )
        user_doc = await db.users.find_one(
            {"user_id": userId},
            {"_id": 0, "first_name": 1, "last_name": 1, "firstName": 1, "lastName": 1, "email": 1},
        ) or {}
        def _pick(*vals):
            for v in vals:
                if isinstance(v, str) and v.strip():
                    return v.strip()
            return ""
        first = _pick(faculty.get("first_name"), faculty.get("firstName"), user_doc.get("first_name"), user_doc.get("firstName")).strip(" ,")
        last = _pick(faculty.get("last_name"), faculty.get("lastName"), user_doc.get("last_name"), user_doc.get("lastName")).strip(" ,")
        full_name = f"{first} {last}".strip() or _pick(faculty.get("full_name"), faculty.get("fullName"))
        if not full_name:
            email_local = _pick(user_doc.get("email"), faculty.get("email")).split("@")[0]
            if email_local:
                full_name = email_local.replace(".", " ").replace("_", " ").title()

        notifications = await db[COL_NOTIFICATIONS].find(
            {"user_id": userId}, {"_id": 0}
        ).to_list(None)

        # Expand faculty profile details (from faculty_profiles) for the Profile tab
        employment_type = faculty.get("employment_type")
        min_units = faculty.get("min_units")
        max_preps = faculty.get("max_preps")
        teaching_years = faculty.get("teaching_years")
        certifications = faculty.get("certifications") or []

        # Qualified KACs (include course list with code + title)
        kac_ids = faculty.get("qualified_kacs") or []
        if not isinstance(kac_ids, list):
            kac_ids = []
        kac_docs: List[Dict[str, Any]] = []
        if kac_ids:
            kac_docs = await db.kacs.find(
                {"kac_id": {"$in": kac_ids}},
                {"_id": 0, "kac_id": 1, "kac_name": 1, "kac_code": 1, "program_area": 1, "course_list": 1},
            ).to_list(None)

        kac_by_id = {str(k.get("kac_id")): k for k in (kac_docs or []) if k}
        course_ids: List[str] = []
        for kd in (kac_docs or []):
            for cid in (kd.get("course_list") or []):
                if isinstance(cid, str) and cid.strip():
                    course_ids.append(cid.strip())
        course_ids = sorted(set(course_ids))

        courses_map: Dict[str, Dict[str, Any]] = {}
        if course_ids:
            course_docs = await db[COL_COURSES].find(
                {"course_id": {"$in": course_ids}},
                {"_id": 0, "course_id": 1, "course_code": 1, "course_title": 1},
            ).to_list(None)
            for cd in course_docs:
                cid = str(cd.get("course_id") or "").strip()
                if not cid:
                    continue
                courses_map[cid] = {
                    "course_id": cid,
                    "course_code": _as_code_str(cd.get("course_code")),
                    "course_title": cd.get("course_title") or "",
                }

        qualified_kacs_details: List[Dict[str, Any]] = []
        for kac_id in kac_ids:
            kid = str(kac_id or "").strip()
            if not kid:
                continue
            kd = kac_by_id.get(kid)
            if not kd:
                continue
            clist = []
            for cid in (kd.get("course_list") or []):
                scid = str(cid or "").strip()
                if not scid:
                    continue
                clist.append(courses_map.get(scid, {"course_id": scid, "course_code": "", "course_title": ""}))

            qualified_kacs_details.append({
                "kac_id": kid,
                "kac_name": kd.get("kac_name") or "",
                "kac_code": kd.get("kac_code") or "",
                "program_area": kd.get("program_area") or "",
                "courses": clist,
            })

        return {
            "ok": True,
            "faculty": {
                "full_name": full_name,
                "fullName": full_name,
                "role": "Faculty",
                "department": (dept or {}).get("dept_name", "—"),

                # faculty_profiles fields
                "employment_type": employment_type,
                "min_units": min_units,
                "max_preps": max_preps,
                "teaching_years": teaching_years,
                "certifications": certifications,
                "qualified_kacs": qualified_kacs_details,
            },
            "notifications": notifications,
        }


    # ---------- profile_update (My Profile edits) ----------
    if action == "profile_update":
        data = payload or {}

        # Accept updates for: name, employment, certifications, qualified kacs.
        first_name = (data.get("first_name") or "").strip()
        last_name = (data.get("last_name") or "").strip()
        employment_type = (data.get("employment_type") or "").strip()
        certifications = data.get("certifications")
        qualified_kacs = data.get("qualified_kacs")

        updates_faculty: Dict[str, Any] = {}
        updates_user: Dict[str, Any] = {}

        if first_name or last_name:
            if not first_name or not last_name:
                raise HTTPException(status_code=400, detail="Both first_name and last_name are required.")
            # Keep both collections in sync (some screens read from users, others from faculty_profiles)
            updates_user["first_name"] = first_name
            updates_user["last_name"] = last_name
            updates_faculty["first_name"] = first_name
            updates_faculty["last_name"] = last_name
            updates_faculty["full_name"] = f"{first_name} {last_name}".strip()

        if employment_type:
            et = employment_type.upper().replace(" ", "")
            if et in ("FULLTIME", "FULL-TIME"):
                et = "FT"
            if et in ("PARTTIME", "PART-TIME"):
                et = "PT"
            if et not in ("FT", "PT"):
                raise HTTPException(status_code=400, detail="Invalid employment_type.")
            updates_faculty["employment_type"] = et

        if certifications is not None:
            if isinstance(certifications, str):
                # allow comma-separated string (frontend usually sends list)
                certifications = [c.strip() for c in certifications.split(",") if c.strip()]
            if not isinstance(certifications, list):
                raise HTTPException(status_code=400, detail="certifications must be a list of strings")
            clean: List[str] = []
            for c in certifications:
                if isinstance(c, str) and c.strip():
                    clean.append(c.strip())
            updates_faculty["certifications"] = clean

        if qualified_kacs is not None:
            if not isinstance(qualified_kacs, list):
                raise HTTPException(status_code=400, detail="qualified_kacs must be a list of kac_id strings")
            clean_k: List[str] = []
            for kid in qualified_kacs:
                if isinstance(kid, str) and kid.strip():
                    clean_k.append(kid.strip())
            updates_faculty["qualified_kacs"] = sorted(set(clean_k))

        if not updates_faculty and not updates_user:
            return {"ok": True, "updated": {}}

        now = datetime.now(timezone.utc)
        if updates_faculty:
            updates_faculty["updated_at"] = now
            await db[COL_FACULTY].update_one(
                {"user_id": userId},
                {"$set": updates_faculty},
            )

        if updates_user:
            await db["users"].update_one(
                {"user_id": userId},
                {"$set": updates_user},
            )

        # Notify Chair(s) of Dept. of Software Technology
        try:
            dept = await db[COL_DEPTS].find_one(
                {"$or": [
                    {"dept_name": {"$regex": r"Software\\s+Technology", "$options": "i"}},
                    {"dept_code": {"$regex": r"^ST$", "$options": "i"}},
                ]},
                {"_id": 0, "department_id": 1, "dept_name": 1},
            )
            st_dept_id = (dept or {}).get("department_id")

            chair_role_ids: List[str] = []
            # Prefer roles collection if present
            roles_coll = None
            try:
                roles_coll = db["roles"]
            except Exception:
                roles_coll = None
            if roles_coll is not None:
                role_docs = await roles_coll.find(
                    {"$or": [
                        {"role_name": {"$regex": r"^chair$", "$options": "i"}},
                        {"name": {"$regex": r"^chair$", "$options": "i"}},
                    ]},
                    {"_id": 0, "role_id": 1},
                ).to_list(10)
                chair_role_ids = [str(r.get("role_id") or "").strip() for r in (role_docs or []) if str(r.get("role_id") or "").strip()]

            # Heuristic fallback used in provided seed data
            if not chair_role_ids:
                chair_role_ids = ["ROLE0002"]

            chair_user_ids: List[str] = []
            if st_dept_id:
                ras = await db["role_assignments"].find(
                    {
                        "role_id": {"$in": chair_role_ids},
                        "scope": {"$elemMatch": {"type": "department", "id": st_dept_id}},
                    },
                    {"_id": 0, "user_id": 1},
                ).to_list(20)
                chair_user_ids = [str(x.get("user_id") or "").strip() for x in (ras or []) if str(x.get("user_id") or "").strip()]

            # Ensure unique
            chair_user_ids = sorted(set(chair_user_ids))
            if chair_user_ids:
                # Actor display name
                u = await db["users"].find_one({"user_id": userId}, {"_id": 0, "first_name": 1, "last_name": 1, "email": 1}) or {}
                actor_name = (f"{(u.get('first_name') or '').strip()} {(u.get('last_name') or '').strip()}".strip() or (u.get("email") or userId))

                changed_fields = []
                if first_name or last_name:
                    changed_fields.append("Name")
                if employment_type:
                    changed_fields.append("Employment")
                if certifications is not None:
                    changed_fields.append("Certifications")
                if qualified_kacs is not None:
                    changed_fields.append("Qualified KACs")
                changed_txt = ", ".join(changed_fields) if changed_fields else "Profile"

                for cuid in chair_user_ids:
                    await create_notification(
                        user_id=cuid,
                        title="Faculty profile updated",
                        details=f"{actor_name} updated: {changed_txt}.",
                        meta={
                            "type": "FACULTY_PROFILE_UPDATE",
                            "actor_user_id": userId,
                            "changed": changed_fields,
                            "when": now.isoformat(),
                        },
                        send_email=True,
                    )
        except Exception:
            # Best-effort: profile update should not fail if notification fails.
            pass

        return {"ok": True, "updated": {**updates_faculty, **updates_user}}


    # ---------- fetch (list) ----------
    if action == "fetch":
        term = await _active_term()
        if not term:
            term = await _get_current_term()
        
        if not term:
            term = {"term_id": None, "term_label": "No Term Found"}
        else:
            if not term.get("is_current"):
                term["term_label"] = _term_label(term) + " (Planning)"
            else:
                 term.setdefault("term_label", _term_label(term))

        # Pipeline: assignments -> sections -> courses -> schedules -> rooms -> campuses
        pipeline: List[Dict[str, Any]] = [
            {"$match": {"faculty_id": faculty.get("faculty_id"), "is_archived": False}},
            {"$lookup": {"from": "sections", "localField": "section_id", "foreignField": "section_id", "as": "sec"}},
            {"$unwind": {"path": "$sec", "preserveNullAndEmptyArrays": True}},

            # Match current term_id for assignments
            {"$match": {"sec.term_id": term.get("term_id")}},

            {"$lookup": {"from": "courses", "localField": "sec.course_id", "foreignField": "course_id", "as": "course"}},
            {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},

            {"$lookup": {"from": "section_schedules", "localField": "sec.section_id", "foreignField": "section_id", "as": "sched"}},
            {"$unwind": {"path": "$sched", "preserveNullAndEmptyArrays": True}},

            {"$lookup": {"from": "rooms", "localField": "sched.room_id", "foreignField": "room_id", "as": "room"}},
            {"$unwind": {"path": "$room", "preserveNullAndEmptyArrays": True}},

            {"$lookup": {"from": "campuses", "localField": "room.campus_id", "foreignField": "campus_id", "as": "camp"}},
            {"$unwind": {"path": "$camp", "preserveNullAndEmptyArrays": True}},

            {"$addFields": {
                "syllabus_display": {
                    "$cond": [
                        {"$or": [
                            {"$eq": [{"$type": "$course.syllabus"}, "missing"]},
                            {"$eq": ["$course.syllabus", None]},
                            {"$eq": [{"$toLower": {"$ifNull": ["$course.syllabus", ""]}}, "n/a"]},
                            {"$eq": ["$course.syllabus", ""]}
                        ]},
                        "",
                        "$course.syllabus"
                    ]
                },

                "day_display": {
                    "$switch": {
                        "branches": [
                            {"case": {"$in": [{"$toUpper": "$sched.day"}, ["M","MON"]]}, "then": "Monday"},
                            {"case": {"$in": [{"$toUpper": "$sched.day"}, ["T","TU","TUE"]]}, "then": "Tuesday"},
                            {"case": {"$in": [{"$toUpper": "$sched.day"}, ["W","WED"]]}, "then": "Wednesday"},
                            {"case": {"$in": [{"$toUpper": "$sched.day"}, ["TH","THU","R", "H"]]}, "then": "Thursday"},
                            {"case": {"$in": [{"$toUpper": "$sched.day"}, ["F","FRI"]]}, "then": "Friday"},
                            {"case": {"$in": [{"$toUpper": "$sched.day"}, ["S","SAT"]]}, "then": "Saturday"},
                        ],
                        "default": "$sched.day"
                    }
                },

                # IMPORTANT: Reflect room allocation changes consistently.
                # Previously this defaulted to "Online" when room is missing, which made
                # Face-to-Face schedules appear unchanged even after APO updates.
                "room_display": {
                    "$cond": [
                        {
                            "$and": [
                                {"$eq": [{"$toLower": {"$ifNull": ["$sched.room_type", ""]}}, "online"]},
                                {
                                    "$or": [
                                        {"$eq": ["$sched.room_id", None]},
                                        {"$eq": ["$sched.room_id", ""]},
                                        {"$eq": [{"$toUpper": {"$ifNull": ["$sched.room_id", ""]}}, "ONLINE"]},
                                    ]
                                },
                            ]
                        },
                        "ONLINE",
                        {"$cond": [
                            {"$and": [
                                {"$ne": [{"$type": "$room.room_number"}, "missing"]},
                                {"$ne": ["$room.room_number", None]},
                                {"$ne": ["$room.room_number", ""]},
                            ]},
                            "$room.room_number",
                            {"$cond": [
                                {"$and": [
                                    {"$ne": [{"$type": "$sched.room_number"}, "missing"]},
                                    {"$ne": ["$sched.room_number", None]},
                                    {"$ne": ["$sched.room_number", ""]},
                                ]},
                                "$sched.room_number",
                                "TBA",
                            ]},
                        ]},
                    ]
                },

                "campus_display": {
                    "$cond": [
                        {
                            "$and": [
                                {"$eq": [{"$toLower": {"$ifNull": ["$sched.room_type", ""]}}, "online"]},
                                {
                                    "$or": [
                                        {"$eq": ["$sched.room_id", None]},
                                        {"$eq": ["$sched.room_id", ""]},
                                        {"$eq": [{"$toUpper": {"$ifNull": ["$sched.room_id", ""]}}, "ONLINE"]},
                                    ]
                                },
                            ]
                        },
                        "Online",
                        {"$cond": [
                            {"$and": [
                                {"$ne": [{"$type": "$camp.campus_name"}, "missing"]},
                                {"$ne": ["$camp.campus_name", None]},
                                {"$ne": ["$camp.campus_name", ""]},
                            ]},
                            "$camp.campus_name",
                            "TBA",
                        ]},
                    ]
                },
            }},
            
            {"$project": {
                "_id": 0,
                "section_id": "$sec.section_id", 
                "day": "$day_display",
                "course_code": {"$ifNull": ["$course.course_code", ""]},
                "course_title": "$course.course_title",
                "section": "$sec.section_code",
                "units": {"$ifNull": ["$course.units", 0]},
                "campus": "$campus_display",
                "mode": {"$ifNull": ["$sched.room_type", "Online"]},
                "room": "$room_display",
                "start_raw": "$sched.start_time",
                "end_raw": "$sched.end_time",
                "syllabus": "$syllabus_display"
            }},
            
            {"$group": {
                "_id": "$section_id",
                "course_code": {"$first": "$course_code"},
                "course_title": {"$first": "$course_title"},
                "section": {"$first": "$section"},
                "units": {"$first": "$units"},
                "syllabus": {"$first": "$syllabus"},
                
                "meetings": {"$push": {
                    "day": "$day",
                    "room_type": "$mode",
                    "start": "$start_raw",
                    "end": "$end_raw",
                    "room": "$room",
                    "campus": "$campus",
                }},
            }},
        ]

        rows = [r async for r in db.faculty_assignments.aggregate(pipeline)]

        final_teaching_load: List[Dict[str, Any]] = []

        for r in rows:
            meetings = r.get("meetings", [])
            
            norm_meet: List[Tuple[int, Dict[str, Any]]] = []
            for m in meetings:
                day = m.get("day", "")
                if day or m.get("start") or m.get("end"):
                    order = _DAY_ORDER.get(day, 99)
                    norm_meet.append((order, m))
            
            norm_meet.sort(key=lambda x: x[0])
            
            day1, room1, mode, time1 = "TBA", "Online", "Online", "TBA"
            day2, room2, time2 = None, None, None
            
            if norm_meet:
                m1 = norm_meet[0][1]
                day1 = m1.get("day") or "TBA"
                room1 = m1.get("room") or "Online"
                mode = m1.get("room_type") or "Online"
                time1 = _fmt_time_band(m1.get("start"), m1.get("end")) or "TBA"

            if len(norm_meet) > 1:
                m2 = norm_meet[1][1]
                day2 = m2.get("day") or "TBA"
                room2 = m2.get("room") or "Online"
                time2 = _fmt_time_band(m2.get("start"), m2.get("end")) or "TBA"
                mode = mode if mode != "Online" else (m2.get("room_type") or "Online")

            # --- compute sec_id BEFORE append ---
            # Prefer aggregate _id as section_id (best if pipeline groups by section_id)
            sec_id = _as_code_str(r.get("_id") or r.get("section_id") or r.get("sectionId") or "")

            # If still missing, resolve via course_code + section code
            if not sec_id:
                sec_id = await _resolve_section_id_from_code_and_section(
                    term_id=term_id,
                    course_code=_as_code_str(r.get("course_code") or r.get("courseCode") or ""),
                    section_code=_as_code_str(r.get("section") or r.get("section_code") or ""),
                )

            # Dev fallback (keeps RFC per-subject even if DB lookup fails)
            if not sec_id:
                sec_id = f"TEMP:{term_id}:{_as_code_str(r.get('course_code') or '')}:{_as_code_str(r.get('section') or '')}"

            final_teaching_load.append({
                "section_id": sec_id,
                "special_id": "",
                "is_special_class": False,

                "course_code": _as_code_str(r.get("course_code")),
                "course_title": r.get("course_title", ""),
                "section": r.get("section", ""),
                "units": r.get("units", 0) or 0,
                "mode": mode,
                "day1": day1,
                "day2": day2,
                "room1": room1,
                "room2": room2,
                "time1": time1,
                "time2": time2,
                "syllabus": r.get("syllabus", ""),
            })



            
        final_teaching_load.sort(key=lambda x: (x.get("course_code", ""), x.get("section", "")))

        # --- *** MODIFIED: Calculate units/preps with FALLBACK LOGIC *** ---
        faculty_id = faculty.get("faculty_id")
        term_id = term.get("term_id")

        # 1. Try to fetch preference for the *specific* planned term
        prefs = await db.faculty_preferences.find_one(
            {"faculty_id": faculty_id, "term_id": term_id},
            {"_id": 0, "preferred_units": 1, "on_break": 1}
        )

        # 2. Fallback: If not found, fetch the *most recent* finished preference (Rollover logic)
        if not prefs:
            fallback_cursor = db.faculty_preferences.find(
                {"faculty_id": faculty_id, "is_finished": True},
                {"_id": 0, "preferred_units": 1, "on_break": 1}
            ).sort([("submitted_at", -1)]).limit(1)
            
            fallback_list = await fallback_cursor.to_list(length=1)
            if fallback_list:
                prefs = fallback_list[0]

        prefs = prefs or {}

        on_break = prefs.get("on_break", False)
        preferred_units = float(prefs.get("preferred_units", 0) or 0)
        
        pref_units_for_calc = 0.0 if on_break else preferred_units
        
        if pref_units_for_calc >= 12:
            max_preps = 3
        elif pref_units_for_calc >= 6:
            max_preps = 2
        elif pref_units_for_calc > 0:
            max_preps = 1 
        else: 
            max_preps = 0
            
        # NOTE: total units / preps are computed AFTER proposal overlay + special class merge,
        # so they always reflect what the faculty actually sees.
        # --- *** END OF MODIFICATION *** ---


        load_header = await db.faculty_loads.find_one(
            {"department_id": faculty.get("department_id"), "term_id": term.get("term_id")},
            {"_id": 0, "status": 1},
        )
        status = (load_header or {}).get("status", "pending").capitalize()

        # Summary is computed at the end after:
        # - proposal overlay selection
        # - special class merge
        summary: Dict[str, Any] = {
            "teaching_units": f"0/{int(pref_units_for_calc)}",
            "course_preps": f"0/{max_preps}",
            "load_status": status,
            "percent": 0,
            "exceeded_teaching_units": False,
            "exceeded_course_preps": False,
            "teaching_units_over_by": 0,
            "course_preps_over_by": 0,
        }

        
        # --- Proposed schedule overlay (sent by OM via /om/load-assignment/to-faculty) ---
        proposal = await db[COL_LOAD_PROPOSALS].find_one({"faculty_id": faculty_id, "term_id": term_id}, {"_id": 0}) or None
        rfc_doc = await db[COL_LOAD_RFC].find_one({"faculty_id": faculty_id, "term_id": term_id}, {"_id": 0}) or None
        rfc_norm = _normalize_rfc_doc(rfc_doc) if rfc_doc else None

        # IMPORTANT BEHAVIOR CHANGE:
        # - If this is a PLANNING term (next/upcoming term) and OM has NOT forwarded a proposal yet,
        #   do NOT surface any schedule/teaching load on the faculty side.
        # - Once OM forwards (proposal exists), faculty will see the proposed schedule (overlay below).
        is_planning_term = bool(term and not term.get("is_current"))
        if is_planning_term and not proposal:
            # Hide any pre-populated assignments for the planning term until OM forwards.
            # HOWEVER: Special Classes are independent of OM load forwarding and must
            # still reflect on the faculty side.
            final_teaching_load = []
            proposal_status = None
            proposal_status_l = ""
            schedule_final = False
            rfc_norm = None

        proposal_status = (proposal or {}).get("status")
        proposal_status_l = str(proposal_status or "").lower()

        # A schedule should be visible on the faculty side whenever OM has forwarded
        # a proposal OR the faculty has already accepted it.
        show_proposal = bool(
            proposal
            and proposal_status_l
            in (
                "proposed",
                "reply",
                "replied",
                # Faculty acceptance marks proposal as "approved" on the OM side.
                "approved",
                "accepted",
            )
        )

        # "Final" means *explicitly locked* only. Faculty acceptance must NOT lock/finalize.
        is_final = bool(proposal and bool((proposal or {}).get("locked")))
        schedule_final = bool(is_final)

        proposal_ts = _proposal_ts(proposal) if proposal else None

        proposed_load = []
        if show_proposal and isinstance(proposal.get("rows"), list):
            for rr in proposal.get("rows", []):
                # NOTE: Proposal rows can outlive the underlying section/schedule docs
                # (e.g., after an admin DB restore/clean). If the referenced section no
                # longer exists, we must NOT surface the stale proposal row on the
                # faculty side (otherwise schedule cards/list appear even though the
                # DB has been cleaned).

                # Best-effort section_id normalization.
                sec_id = (rr.get("section_id") or rr.get("sectionId") or rr.get("id") or "").strip()

                # If the row doesn't carry a section_id, try to resolve it from course+section.
                if not sec_id:
                    try:
                        sec_id = await _resolve_section_id_from_code_and_section(
                            term_id=term_id,
                            course_code=str(rr.get("course") or rr.get("course_code") or ""),
                            section_code=str(rr.get("section") or rr.get("section_code") or ""),
                        )
                    except Exception:
                        sec_id = ""

                # If we still can't resolve a valid section_id, skip the row.
                if not sec_id:
                    continue

                # Guard: skip rows that point to a section that no longer exists for this term.
                # This prevents stale proposals from displaying after DB clean.
                sec_doc = await db[COL_SECTIONS].find_one(
                    {"section_id": sec_id, "$or": [{"term_id": term_id}, {"termId": term_id}]},
                    {"_id": 0, "section_id": 1, "imported_at": 1, "created_at": 1, "createdAt": 1, "updated_at": 1, "updatedAt": 1},
                )
                if not sec_doc:
                    continue

                # Additional stale guard: if this proposal predates the current section snapshot (e.g., after DB restore/clean
                # then re-import), do not surface the old proposal even if the section_id matches again.
                sec_ts = _section_ts(sec_doc)
                if proposal_ts and sec_ts and proposal_ts < sec_ts:
                    continue

                # OM rows may come in multiple shapes depending on when/where they were created.
                # Prefer the faculty schema (start/end/time1), but gracefully fall back to OM schema (begin1/end1).
                b1 = rr.get("start") or rr.get("begin1") or rr.get("begin_1") or rr.get("begin")
                e1 = rr.get("end") or rr.get("end1") or rr.get("end_1") or rr.get("end")
                b2 = rr.get("start2") or rr.get("begin2") or rr.get("begin_2")
                e2 = rr.get("end2") or rr.get("end2") or rr.get("end_2")

                t1 = (rr.get("time1") or _fmt_time_band(b1, e1) or "TBA")
                t2 = (rr.get("time2") or _fmt_time_band(b2, e2)) if (b2 or e2 or rr.get("time2")) else None

                proposed_load.append({
                    "course_code": _as_code_str(rr.get("course") or rr.get("course_code")),
                    "course_title": _as_code_str(rr.get("course_title") or rr.get("title") or rr.get("courseTitle")),
                    "section": rr.get("section") or "",
                    "section_id": sec_id,   # <-- ADD THIS
                    "special_id": "",
                    "is_special_class": False,
                    "units": rr.get("units") or 0,
                    "mode": rr.get("mode") or "",
                    "day1": rr.get("day1") or "TBA",
                    "day2": rr.get("day2"),
                    "room1": rr.get("room1") or "Online",
                    "room2": rr.get("room2"),
                    "time1": t1,
                    "time2": t2,
                    "syllabus": rr.get("syllabus") or "",
                    "finalized": bool(rr.get("finalized")),
                })

            # If all proposal rows were filtered out (stale), treat as no proposal.
            if proposed_load:
                final_teaching_load = proposed_load

                # Faculty-side label:
                # - Locked -> Finalized
                # - Accepted/approved -> Accepted
                # - Otherwise -> Proposed
                if schedule_final:
                    summary["load_status"] = "Finalized"
                elif proposal_status_l in ("approved", "accepted"):
                    summary["load_status"] = "Accepted"
                else:
                    summary["load_status"] = "Proposed"
            else:
                # Proposal exists but is stale/empty after filtering; hide RFC thread as well.
                rfc_norm = None
                proposal_status = None
                proposal_status_l = ""
                schedule_final = False

        # Merge reflected Special Classes (Approved in OM_SpecialClass) as separate purple entries.
        special_rows = await _fetch_reflected_special_classes_for_faculty(
            term_id=term.get("term_id"),
            faculty_id=faculty.get("faculty_id"),
        )
        merged_load = (final_teaching_load or []) + (special_rows or [])

        # ---------------- Faculty Service (Serviced) reflection ----------------
        # Mark existing load rows as serviced (yellow styling) and append synthetic serviced rows
        # when Faculty Service approvals did not create a faculty_assignments record.
        existing_section_ids: set[str] = set()
        for rr in (merged_load or []):
            sid0 = str(rr.get("section_id") or rr.get("sectionId") or "").strip()
            if sid0 and not sid0.startswith("SPECIAL:"):
                existing_section_ids.add(sid0)

        serviced_map = await _serviced_section_map_for_faculty(
            term_id=term.get("term_id"),
            faculty_id=faculty.get("faculty_id"),
        )

        if serviced_map:
            for rr in (merged_load or []):
                if bool(rr.get("is_special_class")):
                    continue
                sid = str(rr.get("section_id") or rr.get("sectionId") or "").strip()
                if sid and sid in serviced_map:
                    rr["is_serviced"] = True
                    rr["serviced_department"] = serviced_map.get(sid) or ""
                    try:
                        await _apply_section_schedule_to_row(rr, sid)
                    except Exception:
                        pass
                    rr["mode"] = _serviced_mode_from_rooms(rr.get("room1"), rr.get("room2"))
                else:
                    rr["is_serviced"] = False
                    rr["serviced_department"] = ""

        try:
            serviced_rows = await _fetch_reflected_faculty_service_rows_for_faculty(
                term_id=term.get("term_id"),
                faculty_id=faculty.get("faculty_id"),
                exclude_section_ids=existing_section_ids,
            )
            if serviced_rows:
                merged_load.extend(serviced_rows)
        except Exception:
            pass

        merged_load.sort(
            key=lambda x: (x.get("course_code", ""), x.get("section", ""), str(bool(x.get("is_special_class"))))
        )

        # IMPORTANT: Special Classes must be reflected in the Faculty schedule views,
        # but they must NOT be included in the teaching units and course prep calculations.
        calc_load = [r for r in (merged_load or []) if not bool(r.get("is_special_class"))]
        total_units, course_preps = _calc_units_and_preps(calc_load)

        summary["teaching_units"] = f"{int(round(total_units))}/{int(pref_units_for_calc)}"
        summary["course_preps"] = f"{course_preps}/{max_preps}"
        summary["percent"] = int((total_units / pref_units_for_calc) * 100) if pref_units_for_calc > 0 else 0

        units_max = float(pref_units_for_calc or 0)
        preps_max = int(max_preps or 0)
        summary["exceeded_teaching_units"] = (total_units > units_max) if units_max > 0 else (total_units > 0)
        summary["exceeded_course_preps"] = (course_preps > preps_max) if preps_max > 0 else (course_preps > 0)
        summary["teaching_units_over_by"] = max(0, int(round(total_units - units_max))) if summary["exceeded_teaching_units"] else 0
        summary["course_preps_over_by"] = max(0, int(course_preps - preps_max)) if summary["exceeded_course_preps"] else 0


    return {
        "ok": True,
        "term": term,
        "summary": summary,
        "teaching_load": merged_load,
        # Only report "proposed" state if we have a valid (non-stale) proposal payload to show.
        "is_proposed": bool(proposed_load and proposal_status_l in ("proposed", "reply", "replied")),
        "proposal_status": proposal_status,
        "rfc": rfc_norm,
        "schedule_final": schedule_final,
    }
    raise HTTPException(status_code=400, detail="Invalid action parameter.")


@router.get("/overview")
async def get_faculty_overview(userId: str = Query(...)):
    """
    Faculty overview:
    - profile 
    - current/planned term
    - summary (with preferences fallback)
    - teaching load
    """
    faculty = await db.faculty_profiles.find_one({"user_id": userId}, {"_id": 0})
    if not faculty:
        raise HTTPException(status_code=404, detail="Faculty not found for the given userId")

    dept = await db.departments.find_one(
        {"department_id": faculty.get("department_id")},
        {"_id": 0, "dept_name": 1},
    )

    term = await _active_term()
    if not term:
        term = await _get_current_term()
    
    if not term:
        term = {"term_id": None, "term_label": "No Active Term"}
    else:
        if not term.get("is_current"):
            term["term_label"] = _term_label(term) + " (Planning)"
        else:
                term.setdefault("term_label", _term_label(term))

    
    # Pipeline: assignments -> sections -> courses -> schedules -> rooms -> campuses
    pipeline: List[Dict[str, Any]] = [
        {"$match": {"faculty_id": faculty.get("faculty_id"), "is_archived": False}},
        {"$lookup": {"from": "sections", "localField": "section_id", "foreignField": "section_id", "as": "sec"}},
        {"$unwind": {"path": "$sec", "preserveNullAndEmptyArrays": True}},
        {"$match": {"sec.term_id": term.get("term_id")}},
        {"$lookup": {"from": "courses", "localField": "sec.course_id", "foreignField": "course_id", "as": "course"}},
        {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {"from": "section_schedules", "localField": "sec.section_id", "foreignField": "section_id", "as": "sched"}},
        {"$unwind": {"path": "$sched", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {"from": "rooms", "localField": "sched.room_id", "foreignField": "room_id", "as": "room"}},
        {"$unwind": {"path": "$room", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {"from": "campuses", "localField": "room.campus_id", "foreignField": "campus_id", "as": "camp"}},
        {"$unwind": {"path": "$camp", "preserveNullAndEmptyArrays": True}},
        {"$addFields": {
            "day_display": {
                "$switch": {
                    "branches": [
                        {"case": {"$in": [{"$toUpper": "$sched.day"}, ["M","MON"]]}, "then": "Monday"},
                        {"case": {"$in": [{"$toUpper": "$sched.day"}, ["T","TU","TUE"]]}, "then": "Tuesday"},
                        {"case": {"$in": [{"$toUpper": "$sched.day"}, ["W","WED"]]}, "then": "Wednesday"},
                        {"case": {"$in": [{"$toUpper": "$sched.day"}, ["TH","THU","R", "H"]]}, "then": "Thursday"},
                        {"case": {"$in": [{"$toUpper": "$sched.day"}, ["F","FRI"]]}, "then": "Friday"},
                        {"case": {"$in": [{"$toUpper": "$sched.day"}, ["S","SAT"]]}, "then": "Saturday"},
                    ],
                    "default": "$sched.day"
                }
            },
        }},
        {"$project": {
            "_id": 0,
            "section_id": "$sec.section_id", 
            "day": "$day_display",
            "course_code": {"$ifNull": ["$course.course_code", ""]},
            "course_title": "$course.course_title",
            "section": "$sec.section_code",
            "units": {"$ifNull": ["$course.units", 0]},
            "campus": {"$ifNull": ["$camp.campus_name", "Online"]},
            "mode": {"$ifNull": ["$sched.room_type", "Online"]},
            "room": {"$ifNull": ["$room.room_number", "Online"]},
            "start_raw": "$sched.start_time",
            "end_raw": "$sched.end_time",
            "syllabus": "$course.syllabus"
        }},
        {"$group": {
            "_id": "$section_id",
            "course_code": {"$first": "$course_code"},
            "course_title": {"$first": "$course_title"},
            "section": {"$first": "$section"},
            "units": {"$first": "$units"},
            "syllabus": {"$first": "$syllabus"},
            
            "meetings": {"$push": {
                "day": "$day",
                "room_type": "$mode",
                "start": "$start_raw",
                "end": "$end_raw",
                "room": "$room",
                "campus": "$campus",
            }},
        }},
    ]

    rows = [r async for r in db.faculty_assignments.aggregate(pipeline)]

    final_teaching_load: List[Dict[str, Any]] = []

    for r in rows:
        meetings = r.get("meetings", [])
        
        norm_meet: List[Tuple[int, Dict[str, Any]]] = []
        for m in meetings:
            day = m.get("day", "")
            if day or m.get("start") or m.get("end"):
                order = _DAY_ORDER.get(day, 99)
                norm_meet.append((order, m))
        
        norm_meet.sort(key=lambda x: x[0])
        
        day1, room1, mode, time1 = "TBA", "Online", "Online", "TBA"
        day2, room2, time2 = None, None, None
        
        if norm_meet:
            m1 = norm_meet[0][1]
            day1 = m1.get("day") or "TBA"
            room1 = m1.get("room") or "Online"
            mode = m1.get("room_type") or "Online"
            time1 = _fmt_time_band(m1.get("start"), m1.get("end")) or "TBA"

        if len(norm_meet) > 1:
            m2 = norm_meet[1][1]
            day2 = m2.get("day") or "TBA"
            room2 = m2.get("room") or "Online"
            time2 = _fmt_time_band(m2.get("start"), m2.get("end")) or "TBA"
            mode = mode if mode != "Online" else (m2.get("room_type") or "Online")


        final_teaching_load.append({
            "course_code": _as_code_str(r.get("course_code")),
            "course_title": r.get("course_title", ""),
            "section": r.get("section", ""),
            "units": r.get("units", 0) or 0,
            "mode": mode,
            "day1": day1,
            "day2": day2,
            "room1": room1,
            "room2": room2,
            "time1": time1,
            "time2": time2,
            "syllabus": r.get("syllabus", ""),
        })
        
    final_teaching_load.sort(key=lambda x: (x.get("course_code", ""), x.get("section", "")))


    # --- *** MODIFIED: Calculate units/preps with FALLBACK LOGIC *** ---
    faculty_id = faculty.get("faculty_id")
    term_id = term.get("term_id")

    # 1. Try to fetch preference for the *specific* planned term
    prefs = await db.faculty_preferences.find_one(
        {"faculty_id": faculty_id, "term_id": term_id},
        {"_id": 0, "preferred_units": 1, "on_break": 1}
    )

    # 2. Fallback: If not found, fetch the *most recent* finished preference (Rollover logic)
    if not prefs:
        fallback_cursor = db.faculty_preferences.find(
            {"faculty_id": faculty_id, "is_finished": True},
            {"_id": 0, "preferred_units": 1, "on_break": 1}
        ).sort([("submitted_at", -1)]).limit(1)
        
        fallback_list = await fallback_cursor.to_list(length=1)
        if fallback_list:
            prefs = fallback_list[0]

    prefs = prefs or {}

    on_break = prefs.get("on_break", False)
    preferred_units = float(prefs.get("preferred_units", 0) or 0)
    
    pref_units_for_calc = 0.0 if on_break else preferred_units
    
    if pref_units_for_calc >= 12:
        max_preps = 3
    elif pref_units_for_calc >= 6:
        max_preps = 2
    elif pref_units_for_calc > 0:
        max_preps = 1 
    else: 
        max_preps = 0
        
    # Units/preps are computed after special class merge so the summary matches what the faculty sees.
    # --- *** END OF MODIFICATION *** ---

    load_header = await db.faculty_loads.find_one(
        {"department_id": faculty.get("department_id"), "term_id": term.get("term_id")},
        {"_id": 0, "status": 1},
    )
    status = (load_header or {}).get("status", "pending").capitalize()

    summary: Dict[str, Any] = {
        "teaching_units": f"0/{int(pref_units_for_calc)}",
        "course_preps": f"0/{max_preps}",
        "load_status": status,
        "percent": 0,
        "exceeded_teaching_units": False,
        "exceeded_course_preps": False,
        "teaching_units_over_by": 0,
        "course_preps_over_by": 0,
    }

    # IMPORTANT BEHAVIOR CHANGE (mirrors POST /overview?action=fetch):
    # If this is a PLANNING term and OM has NOT forwarded a proposal yet,
    # hide any schedule/teaching load on the faculty side.
    # Special Classes are independent of OM forwarding and must still reflect.
    is_planning_term = bool(term and not term.get("is_current"))
    if is_planning_term:
        proposal = await db[COL_LOAD_PROPOSALS].find_one(
            {"faculty_id": faculty_id, "term_id": term_id},
            {"_id": 1},
        )
        if not proposal:
            final_teaching_load = []
            summary["load_status"] = (summary.get("load_status") or "Pending")

    # Merge reflected Special Classes and compute summary against what will be displayed.
    special_rows = await _fetch_reflected_special_classes_for_faculty(
        term_id=term.get("term_id"),
        faculty_id=faculty.get("faculty_id"),
    )
    merged_load = (final_teaching_load or []) + (special_rows or [])

    # ---------------- Faculty Service (Serviced) reflection ----------------
    # Mark existing load rows as serviced (yellow styling) and append synthetic serviced rows
    # when Faculty Service approvals did not create a faculty_assignments record.
    existing_section_ids: set[str] = set()
    for rr in (merged_load or []):
        sid0 = str(rr.get("section_id") or rr.get("sectionId") or "").strip()
        if sid0 and not sid0.startswith("SPECIAL:"):
            existing_section_ids.add(sid0)

    serviced_map = await _serviced_section_map_for_faculty(
        term_id=term.get("term_id"),
        faculty_id=faculty.get("faculty_id"),
    )

    if serviced_map:
        for rr in (merged_load or []):
            if bool(rr.get("is_special_class")):
                continue
            sid = str(rr.get("section_id") or rr.get("sectionId") or "").strip()
            if sid and sid in serviced_map:
                rr["is_serviced"] = True
                rr["serviced_department"] = serviced_map.get(sid) or ""
                # Keep schedule/room consistent with calendar/list (TBA stays TBA)
                try:
                    await _apply_section_schedule_to_row(rr, sid)
                except Exception:
                    pass
                # Enforce serviced mode rule
                rr["mode"] = _serviced_mode_from_rooms(rr.get("room1"), rr.get("room2"))
            else:
                rr["is_serviced"] = False
                rr["serviced_department"] = ""

    # Add synthetic rows for serviced sections not present in regular load
    try:
        serviced_rows = await _fetch_reflected_faculty_service_rows_for_faculty(
            term_id=term.get("term_id"),
            faculty_id=faculty.get("faculty_id"),
            exclude_section_ids=existing_section_ids,
        )
        if serviced_rows:
            merged_load.extend(serviced_rows)
    except Exception:
        pass

    # IMPORTANT: Special Classes must be reflected in the Faculty schedule views,
    # but they must NOT be included in the teaching units and course prep calculations.
    calc_load = [r for r in (merged_load or []) if not bool(r.get("is_special_class"))]
    total_units, course_preps = _calc_units_and_preps(calc_load)
    summary["teaching_units"] = f"{int(round(total_units))}/{int(pref_units_for_calc)}"
    summary["course_preps"] = f"{course_preps}/{max_preps}"
    summary["percent"] = int((total_units / pref_units_for_calc) * 100) if pref_units_for_calc > 0 else 0

    units_max = float(pref_units_for_calc or 0)
    preps_max = int(max_preps or 0)
    summary["exceeded_teaching_units"] = (total_units > units_max) if units_max > 0 else (total_units > 0)
    summary["exceeded_course_preps"] = (course_preps > preps_max) if preps_max > 0 else (course_preps > 0)
    summary["teaching_units_over_by"] = max(0, int(round(total_units - units_max))) if summary["exceeded_teaching_units"] else 0
    summary["course_preps_over_by"] = max(0, int(course_preps - preps_max)) if summary["exceeded_course_preps"] else 0

    notifications = await db[COL_NOTIFICATIONS].find(
        {"user_id": userId}, {"_id": 0}
    ).to_list(None)

    user_doc = await db.users.find_one(
        {"user_id": userId},
        {"_id": 0, "first_name": 1, "last_name": 1, "firstName": 1, "lastName": 1, "email": 1},
    ) or {}

    def _pick(*vals):
        for v in vals:
            if isinstance(v, str) and v.strip():
                return v.strip()
        return ""

    first = _pick(
        faculty.get("first_name"),
        faculty.get("firstName"),
        user_doc.get("first_name"),
        user_doc.get("firstName"),
    ).strip(" ,")
    last = _pick(
        faculty.get("last_name"),
        faculty.get("lastName"),
        user_doc.get("last_name"),
        user_doc.get("lastName"),
    ).strip(" ,")
    full_name = f"{first} {last}".strip() or _pick(faculty.get("full_name"), faculty.get("fullName"))

    if not full_name:
        email_local = _pick(user_doc.get("email"), faculty.get("email")).split("@")[0]
        if email_local:
            full_name = email_local.replace(".", " ").replace("_", " ").title()
            
    merged_load.sort(key=lambda x: (x.get("course_code", ""), x.get("section", ""), str(bool(x.get("is_special_class")))))

    return {
        "ok": True,
        "faculty": {
            "full_name": full_name,
            "fullName": full_name, 
            "role": "Faculty",
            "department": (dept or {}).get("dept_name", "—"),
        },
        "term": term,
        "summary": summary,
        "teaching_load": merged_load,
        "notifications": notifications,
    }

async def _get_previous_term() -> Optional[Dict[str, Any]]:
    docs = await db.terms.find({}, {"_id": 0}) \
        .sort([("acad_year_start", -1), ("term_number", -1)]) \
        .to_list(length=2)

    if not docs:
        return None

    t = docs[1] if len(docs) >= 2 else docs[0]
    t["term_label"] = _term_label(t)
    return t


@router.get("/load-assignment/rfc")
async def faculty_get_load_rfc(
    userId: str = Query(...),
    term_id: Optional[str] = Query(None),
    section_id: Optional[str] = Query(None),
):
    faculty = await db[COL_FACULTY].find_one(
        {"user_id": userId},
        {"_id": 0, "faculty_id": 1}
    )
    if not faculty:
        raise HTTPException(status_code=404, detail="Faculty not found")

    if not term_id:
        term = await _active_term()
        term_id = (term or {}).get("term_id")

    if not term_id:
        return {"ok": True, "rfc": None}

    q = {"faculty_id": faculty.get("faculty_id"), "term_id": term_id}

    # per-course isolation
    if section_id:
        q["section_id"] = section_id
        rfc = await db[COL_LOAD_RFC].find_one(q, {"_id": 0})
        return {"ok": True, "rfc": _normalize_rfc_doc(rfc) if rfc else None}

    # fallback: latest RFC for the term
    lst = await db[COL_LOAD_RFC].find(q, {"_id": 0}).sort([("updated_at", -1), ("created_at", -1)]).to_list(1)
    rfc = lst[0] if lst else None
    return {"ok": True, "rfc": _normalize_rfc_doc(rfc) if rfc else None}


@router.post("/load-assignment/rfc/message")
async def faculty_send_load_rfc_message(userId: str = Query(...), payload: Dict[str, Any] = Body(...)):
    faculty = await db[COL_FACULTY].find_one({"user_id": userId}, {"_id": 0})
    if not faculty:
        raise HTTPException(status_code=404, detail="Faculty not found")

    term_id = (payload.get("term_id") or "").strip()
    if not term_id:
        term = await _active_term()
        term_id = (term or {}).get("term_id")
    if not term_id:
        raise HTTPException(status_code=409, detail="No active/upcoming term")

    section_id = (payload.get("section_id") or payload.get("sectionId") or "").strip()
    if not section_id:
        raise HTTPException(status_code=400, detail="section_id is required")

    message = (payload.get("message") or "").strip()
    if not message:
        raise HTTPException(status_code=400, detail="message is required")

    fid = faculty.get("faculty_id")

    proposal = await db[COL_LOAD_PROPOSALS].find_one(
        {"faculty_id": fid, "term_id": term_id},
        {"_id": 0, "om_user_id": 1}
    ) or {}
    om_uid = (proposal.get("om_user_id") or "").strip()

    # per-course RFC key (faculty_id + term_id + section_id)
    qkey = {"faculty_id": fid, "term_id": term_id, "section_id": section_id}

    existing = await db[COL_LOAD_RFC].find_one(qkey, {"_id": 0}) or {}
    existing = _normalize_rfc_doc(existing) if existing else {
        "rfc_id": "RFC" + uuid.uuid4().hex[:10].upper(),
        "faculty_id": fid,
        "term_id": term_id,
        "section_id": section_id,
        "messages": [],
        "status": "OPEN",
    }

    now = _now_utc()

    # Allow RFC again even if the previous RFC thread was terminal.
    # We archive the previous thread into `history` and start a fresh thread.
    if (existing.get("status") or "").upper() in RFC_TERMINAL:
        prev_status = str(existing.get("status") or "").upper()
        hist = list(existing.get("history") or [])
        hist.append({
            "rfc_id": existing.get("rfc_id"),
            "status": existing.get("status"),
            "locked": bool(existing.get("locked")),
            "messages": list(existing.get("messages") or []),
            "closed_at": existing.get("closed_at") or existing.get("closed_at"),
            "archived_at": now.isoformat(),
        })
        existing = {
            "rfc_id": "RFC" + uuid.uuid4().hex[:10].upper(),
            "faculty_id": fid,
            "term_id": term_id,
            "section_id": section_id,
            "messages": [],
            "status": "OPEN",
            "history": hist,
        }

        # Add a lightweight tag in the new thread so the UI can display the context
        # even if it does not render `history`.
        existing["messages"].append({
            "sender_role": "system",
            "sender_user_id": "system",
            "message": f"Previous RFC was {prev_status} (archived).",
            "created_at": now.isoformat(),
        })

    msgs = list(existing.get("messages") or [])
    msgs.append({
        "sender_role": "faculty",
        "sender_user_id": userId,
        "message": message,
        "created_at": now.isoformat(),
    })

    # Optional structured schedule request (sent by the Faculty UI)
    requested = payload.get("requested")
    if not isinstance(requested, dict):
        requested = {}


    await db[COL_LOAD_RFC].update_one(
        qkey,
        {"$set": {
            "rfc_id": existing.get("rfc_id"),
            "faculty_id": fid,
            "faculty_user_id": userId,
            "om_user_id": om_uid,
            "term_id": term_id,
            "section_id": section_id,
            "status": "NEEDS_OM",
            "locked": False,
            "messages": msgs,
            "requested": requested,
            "history": list(existing.get("history") or []),
            "updated_at": now,
        }, "$setOnInsert": {"created_at": now}},
        upsert=True,
    )

    if om_uid:
        await create_notification(
            user_id=om_uid,
            title="Load Assignment: Faculty sent a Request for Change",
            details=f"{faculty.get('first_name','')} {faculty.get('last_name','')} sent a Request for Change.",
            meta={
                "route": "/om/load-assignment",
                "kind": "load_rfc_received",
                "term_id": term_id,
                "faculty_id": fid,
                "section_id": section_id,   # ✅ IMPORTANT
                "rfc_id": existing.get("rfc_id"),
            },
            send_email=True,
            email_from_user_id=userId,
        )

    # Gmail notification is handled by create_notification(...send_email=True...).
    # Email sending is best-effort and runs asynchronously.

    return {
        "ok": True,
        "rfc_id": existing.get("rfc_id"),
        "status": "NEEDS_OM",
        "email_sent": True,
        "email_error": None,
    }

# END NEW BLOCK




def _format_time(t: str | None) -> str:
    return (t or "TBA").strip() or "TBA"

def _build_acceptance_email(term_label: str, rows: list[dict], recipient_email: str):
    subject = f"[DST] Teaching Load Assignments for {term_label}"

    lines = [
        f"Dear Faculty,",
        "",
        f"You have accepted your teaching load for {term_label}.",
        "",
        "Summary:",
    ]
    for r in rows:
        lines.append(
            f"- {r.get('course_code','')} {r.get('section','')} | "
            f"{r.get('day1','')} {_format_time(r.get('time1'))} ({r.get('room1','')})"
        )
    body_text = "\n".join(lines)

    def td(x): 
        return ("" if x is None else str(x))

    table_rows_html = ""
    for r in rows:
        table_rows_html += f"""
        <tr>
          <td>{td(r.get("course_code",""))}</td>
          <td style="text-align:center;">{td(r.get("units",""))}</td>
          <td>{td(r.get("faculty_name",""))}</td>
          <td style="text-align:center;">{td(r.get("day1",""))}</td>
          <td style="text-align:center;">{td(r.get("start1","") or r.get("time1",""))}</td>
          <td style="text-align:center;">{td(r.get("end1","") or "")}</td>
          <td>{td(r.get("room1",""))}</td>
          <td style="text-align:center;">{td(r.get("day2","") or "")}</td>
          <td style="text-align:center;">{td(r.get("start2","") or r.get("time2","") or "")}</td>
          <td style="text-align:center;">{td(r.get("end2","") or "")}</td>
          <td>{td(r.get("room2","") or "")}</td>
        </tr>
        """

    body_html = f"""
    <div style="font-family:Arial,sans-serif;font-size:13px;color:#111;">
      <p>Dear Faculty,</p>
      <p>This confirms you have <b>accepted</b> your teaching load for <b>{term_label}</b>.</p>

      <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:12px;">
        <thead style="background:#f3f4f6;">
          <tr>
            <th>Course</th>
            <th>Units</th>
            <th>Faculty</th>
            <th>Day 1</th>
            <th>Time 1</th>
            <th></th>
            <th>Room 1</th>
            <th>Day 2</th>
            <th>Time 2</th>
            <th></th>
            <th>Room 2</th>
          </tr>
        </thead>
        <tbody>
          {table_rows_html}
        </tbody>
      </table>

      <p style="margin-top:16px;">Thank you.<br/>AnimoAssign</p>
      <p>Log in here: <a href="http://ccscloud.dlsu.edu.ph:11160/login">http://ccscloud.dlsu.edu.ph:11160/login</a></p>
    </div>
    """
    return subject, body_text, body_html

def _build_faculty_accept_email(
    *,
    term_label: str,
    faculty_name: str,
    rows: List[Dict[str, Any]],
    login_url: str = "http://ccscloud.dlsu.edu.ph:11160/login",
) -> Tuple[str, str, str]:
    subject = f"[AnimoAssign] Accepted schedule • {term_label}"

    def td(x: Any) -> str:
        return _html_escape("" if x is None else str(x))

    # --- Special-class formatting for ACCEPTED-SCHEDULE email ---
    # Requirements:
    # - For special classes: TBA or Online classes display as TBA (not ONLINE)
    # - For special classes: Day 1/Day 2 use initials only (like regular classes)
    # - For special classes: Mode auto FOL if both rooms are unassigned/TBA/ONLINE, else HYB
    _DAY_INITIAL = {
        "MONDAY": "M",
        "TUESDAY": "T",
        "WEDNESDAY": "W",
        "THURSDAY": "H",  # common academic abbreviation
        "FRIDAY": "F",
        "SATURDAY": "S",
        "SUNDAY": "U",
        # pass-through if already an initial
        "M": "M",
        "T": "T",
        "W": "W",
        "H": "H",
        "F": "F",
        "S": "S",
        "U": "U",
    }

    def _day_to_initial(v: Any) -> str:
        s = ("" if v is None else str(v)).strip()
        if not s:
            return ""
        if s.upper() == "TBA":
            return "TBA"
        return _DAY_INITIAL.get(s.upper(), s[:1].upper())

    def _room_to_email_display(v: Any) -> str:
        s = ("" if v is None else str(v)).strip()
        if not s:
            return "TBA"
        if s.upper() in ("ONLINE", "TBA"):
            return "TBA"
        return s

    def _is_unassigned_room(v: Any) -> bool:
        s = ("" if v is None else str(v)).strip()
        return (not s) or (s.upper() in ("ONLINE", "TBA"))


    def _format_row_for_email(r: Dict[str, Any]) -> Dict[str, Any]:
        is_special = bool(r.get("is_special_class"))
        is_serviced = bool(r.get("is_serviced"))
        if not (is_special or is_serviced):
            return r

        rr = dict(r)

        # Day initials should be used for both Special and Serviced classes
        rr["day1"] = _day_to_initial(rr.get("day1"))
        rr["day2"] = _day_to_initial(rr.get("day2")) if rr.get("day2") not in (None, "") else ""

        # Special-class-specific formatting rules
        if is_special:
            rr["room1"] = _room_to_email_display(rr.get("room1"))
            rr["room2"] = _room_to_email_display(rr.get("room2")) if rr.get("room2") not in (None, "") else ""

            # Mode override for special classes per requirement
            if _is_unassigned_room(r.get("room1")) and _is_unassigned_room(r.get("room2")):
                rr["mode"] = "FOL"
            else:
                rr["mode"] = "HYB"

        return rr

    # Plain text fallback
    lines = [
        f"Dear {faculty_name},",
        f"",
        f"This confirms you have accepted your teaching load for {term_label}.",
        "",
        "Schedule:",
    ]
    for r in rows:
        r = _format_row_for_email(r)
        lines.append(
            f"- {r.get('course_code','')} {r.get('section','')} | {r.get('units','')}u | "
            f"{r.get('day1','')} {r.get('time1','')} {r.get('room1','')} | "
            f"{(r.get('day2') or '')} {(r.get('time2') or '')} {(r.get('room2') or '')}"
        )

    lines += ["", f"Login: {login_url}", "", "— AnimoAssign"]
    body_text = "\n".join(lines)

    # HTML table (inbox-style)
    tr_html = ""
    for r in rows:
        r = _format_row_for_email(r)
        # Visual cues in email:
        # - Special Classes: light purple
        # - Serviced Classes: light yellow
        if bool(r.get("is_special_class")):
            tr_style = ' style="background:#f3e8ff;"'
        elif bool(r.get("is_serviced")):
            tr_style = ' style="background:#fefce8;"'
        else:
            tr_style = ""
        tr_html += f"""
        <tr{tr_style}>
          <td>{td(r.get("course_code",""))}</td>
          <td style="text-align:center;">{td(r.get("section",""))}</td>
          <td style="text-align:center;">{td(r.get("units",""))}</td>
          <td style="text-align:center;">{td(r.get("mode",""))}</td>
          <td style="text-align:center;">{td(r.get("day1",""))}</td>
          <td style="text-align:center;">{td(r.get("time1",""))}</td>
          <td style="text-align:center;">{td(r.get("room1",""))}</td>
          <td style="text-align:center;">{td(r.get("day2",""))}</td>
          <td style="text-align:center;">{td(r.get("time2",""))}</td>
          <td style="text-align:center;">{td(r.get("room2",""))}</td>
        </tr>
        """

    body_html = f"""
    <div style="font-family:Arial,sans-serif;font-size:13px;color:#111;">
      <p>Dear {td(faculty_name)},</p>
      <p>This confirms you have <b>accepted</b> your teaching load for <b>{td(term_label)}</b>.</p>

      <table border="1" cellpadding="6" cellspacing="0"
             style="border-collapse:collapse;width:100%;font-size:12px;">
        <thead style="background:#f3f4f6;">
          <tr>
            <th>Course</th>
            <th>Section</th>
            <th>Units</th>
            <th>Mode</th>
            <th>Day 1</th>
            <th>Time 1</th>
            <th>Room 1</th>
            <th>Day 2</th>
            <th>Time 2</th>
            <th>Room 2</th>
          </tr>
        </thead>
        <tbody>
          {tr_html}
        </tbody>
      </table>

      <p style="margin-top:14px;">
        Login here: <a href="{td(login_url)}">{td(login_url)}</a>
      </p>

      <p style="margin-top:16px;">Thank you.<br/>AnimoAssign</p>
    </div>
    """

    return subject, body_text, body_html

@router.post("/load-assignment/accept")
async def faculty_accept_load_proposal(userId: str = Query(...), payload: Dict[str, Any] = Body({})):
    faculty = await db[COL_FACULTY].find_one({"user_id": userId}, {"_id": 0})
    if not faculty:
        raise HTTPException(status_code=404, detail="Faculty not found")

    user = await db["users"].find_one(
        {"user_id": userId},
        {"_id": 0, "email": 1, "gmail": 1, "google_token": 1, "first_name": 1, "last_name": 1},
    ) or {}

    # Calendar checkbox flag (default True = keeps current behavior)
    send_to_gcal = payload.get("send_to_gcal", True)
    send_to_gcal = True if send_to_gcal is None else bool(send_to_gcal)

    term_id = (payload.get("term_id") or "").strip()
    if not term_id:
        term = await _active_term()
        term_id = (term or {}).get("term_id")

    if not term_id:
        raise HTTPException(status_code=409, detail="No active/upcoming term")

    fid = faculty.get("faculty_id")
    proposal = await db[COL_LOAD_PROPOSALS].find_one({"faculty_id": fid, "term_id": term_id}, {"_id": 0})
    if not proposal:
        return {"ok": True, "message": "No proposal to accept."}

    base_rows = proposal.get("rows", []) or []

    # Email rows include reflected special classes + serviced classes.
    # Calendar rows also include special + serviced rows so they sync to Google Calendar on accept.
    email_rows = list(base_rows)
    calendar_rows = list(base_rows)

    # Some deployments include Faculty Service (serviced) sections inside the proposal rows
    # but without a marker. Ensure these rows are flagged so they appear (and are styled)
    # in the acceptance email, and stay consistent for calendar creation.
    try:
        serviced_map = await _serviced_section_map_for_faculty(term_id=term_id, faculty_id=fid)
        if serviced_map:
            for rr in email_rows:
                sid = str((rr or {}).get("section_id") or "").strip()
                if sid and sid in serviced_map:
                    rr["is_serviced"] = True
                    rr["serviced_department"] = serviced_map.get(sid) or rr.get("serviced_department") or ""
                    rr["mode"] = _serviced_mode_from_rooms(rr.get("room1"), rr.get("room2"))
            for rr in calendar_rows:
                sid = str((rr or {}).get("section_id") or "").strip()
                if sid and sid in serviced_map:
                    rr["is_serviced"] = True
                    rr["serviced_department"] = serviced_map.get(sid) or rr.get("serviced_department") or ""
                    rr["mode"] = _serviced_mode_from_rooms(rr.get("room1"), rr.get("room2"))
    except Exception:
        # Best-effort only. If this fails, we still try to reflect serviced rows below.
        serviced_map = {}

    # Exclude real section rows when reflecting serviced rows to avoid duplicates.
    exclude_section_ids = {
        str((r or {}).get("section_id") or "").strip()
        for r in (base_rows or [])
        if str((r or {}).get("section_id") or "").strip()
    }

    try:
        sc_rows = await _fetch_reflected_special_classes_for_faculty(term_id=term_id, faculty_id=fid)
        if sc_rows:
            email_rows += sc_rows
            calendar_rows += sc_rows
    except Exception:
        pass

    try:
        serviced_rows = await _fetch_reflected_faculty_service_rows_for_faculty(
            term_id=term_id,
            faculty_id=fid,
            exclude_section_ids=exclude_section_ids,
        )
        if serviced_rows:
            email_rows += serviced_rows
            calendar_rows += serviced_rows
    except Exception:
        pass

    # do not allow accept if pending RFC exists
    pending_rfc = await db[COL_LOAD_RFC].find_one({"faculty_id": fid, "term_id": term_id}, {"_id": 0}) or None
    if pending_rfc:
        existing_norm = _normalize_rfc_doc(pending_rfc)
        st = str(existing_norm.get("status") or "").upper()
        if st and st not in RFC_TERMINAL:
            raise HTTPException(
                status_code=409,
                detail="You have a pending RFC. Please wait for OM to respond before accepting the schedule.",
            )

    await db[COL_LOAD_PROPOSALS].update_one(
        {"faculty_id": fid, "term_id": term_id},
        {
            "$set": {
                "status": "approved",
                "locked": True,
                "accepted_at": _now_utc(),
                "updated_at": _now_utc(),
            },
            "$setOnInsert": {"created_at": _now_utc()},
        },
    )

    # Best-effort finalize all rows
    try:
        await db[COL_LOAD_PROPOSALS].update_one(
            {"faculty_id": fid, "term_id": term_id},
            {"$set": {"rows.$[].finalized": True}},
        )
    except Exception:
        pass

    now = _now_utc()
    await db[COL_LOAD_RFC].update_many(
        {"faculty_id": fid, "term_id": term_id},
        {"$set": {"status": "ACCEPTED", "locked": True, "updated_at": now}},
    )

    # --- send acceptance email to the faculty (best-effort, non-blocking) ---
    recipient_email = (
        ((user.get("google_token") or {}).get("connected_email") or "").strip()
        or (user.get("gmail") or "").strip()
        or (user.get("email") or "").strip()
    )

    term_doc = await db[COL_TERMS].find_one(
        {"term_id": term_id},
        {"_id": 0, "acad_year_start": 1, "term_number": 1},
    ) or {}
    term_label = _term_label(term_doc) if term_doc else term_id

    faculty_name = f"{(faculty.get('first_name') or '').strip()} {(faculty.get('last_name') or '').strip()}".strip() or "Faculty"

    email_sent = False
    email_error: Optional[str] = None

    if recipient_email:
        subject, body_text, body_html = _build_faculty_accept_email(
            term_label=term_label,
            faculty_name=faculty_name,
            rows=email_rows,
            login_url="http://ccscloud.dlsu.edu.ph:11160/login",  # removed leading space
        )
        try:
            email_sent, email_error = await _send_email_via_user_gmail(
                user_id=userId,
                to_email=recipient_email,
                subject=subject,
                body=body_text,
                html_body=body_html,
            )
        except Exception as e:
            email_sent = False
            email_error = str(e)
    else:
        email_error = "No recipient email found for this user."

    # --- notify OM mailbox using the faculty's connected Gmail (best-effort, non-blocking) ---
    om_mailbox_sent = False
    om_mailbox_error: Optional[str] = None

    if OM_NOTIFY_EMAIL:
        om_subject, om_body_text, om_body_html = _build_om_finalized_email(
            term_label=term_label,
            faculty_name=faculty_name,
            rows=base_rows,  # schedule rows only (usually what OM wants)
            om_link=OM_LOAD_ASSIGNMENT_URL,
        )
        try:
            om_mailbox_sent, om_mailbox_error = await _send_email_via_user_gmail(
                user_id=userId,
                to_email=OM_NOTIFY_EMAIL,
                subject=om_subject,
                body=om_body_text,
                html_body=om_body_html,
            )
        except Exception as e:
            om_mailbox_sent = False
            om_mailbox_error = str(e)

    # optional rfc_id for notif (latest one)
    rfc_id = None
    lst = await db[COL_LOAD_RFC].find(
        {"faculty_id": fid, "term_id": term_id},
        {"_id": 0, "rfc_id": 1},
    ).sort([("updated_at", -1), ("created_at", -1)]).to_list(1)
    if lst:
        rfc_id = lst[0].get("rfc_id")

    om_uid = (proposal.get("om_user_id") or "").strip()
    if om_uid:
        await create_notification(
            user_id=om_uid,
            title="Load Assignment: Faculty accepted schedule",
            details=f"{faculty.get('first_name','')} {faculty.get('last_name','')} accepted the proposed schedule.",
            meta={
                "route": "/om/load-assignment",
                "kind": "proposal_accepted",
                "term_id": term_id,
                "faculty_id": fid,
                "rfc_id": rfc_id or "",
            },
        )

    # --- create Google Calendar events (only if checkbox enabled) ---
    calendar_ok: Optional[bool] = None
    calendar_error: Optional[str] = None
    calendar_events_created = 0
    calendar_term_id: Optional[str] = None
    term_start_at = None
    week_count = _TERM_WEEK_COUNT

    if send_to_gcal:
        try:
            nxt_term = await _next_term_from_current()
            if not nxt_term:
                calendar_ok = False
                calendar_error = "No next term found after current term."
            else:
                calendar_term_id = (nxt_term.get("term_id") or "").strip()
                term_start_at = _coerce_dt(nxt_term.get("start_at"))
                term_end_at = _coerce_dt(nxt_term.get("end_at"))

                if not term_start_at:
                    calendar_ok = False
                    calendar_error = f"Next term {calendar_term_id or ''} has no start_at; cannot create calendar events."
                else:
                    if term_end_at:
                        span_weeks = max(1, ((term_end_at.date() - term_start_at.date()).days // 7) + 1)
                        week_count = min(_TERM_WEEK_COUNT, span_weeks)

                    calendar_ok, calendar_events_created, calendar_error = await _create_term_calendar_for_user(
                        user_id=userId,
                        term_start_at=term_start_at,
                        rows=calendar_rows,
                        week_count=week_count,
                    )
        except Exception as e:
            calendar_ok = False
            calendar_error = str(e)

    return {
        "ok": True,
        "status": "ACCEPTED",

        "email_sent": email_sent,
        "email_error": email_error,

        "om_mailbox_email": OM_NOTIFY_EMAIL,
        "om_mailbox_sent": om_mailbox_sent,
        "om_mailbox_error": om_mailbox_error,

        "send_to_gcal": send_to_gcal,
        "calendar_ok": calendar_ok,
        "calendar_events_created": calendar_events_created,
        "calendar_error": calendar_error,
        "calendar_term_id": calendar_term_id,
        "term_start_at": (term_start_at.isoformat() if term_start_at else None),
        "week_count": week_count,
        "calendar_url_used": _GCAL_EVENTS_INSERT_URL,
    }
