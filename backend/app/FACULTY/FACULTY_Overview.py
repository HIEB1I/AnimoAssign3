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

# OM <-> Faculty proposal + RFC collections
COL_LOAD_PROPOSALS = "faculty_load_proposals"
COL_LOAD_RFC = "faculty_rfc"

import uuid

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
        return {
            "ok": True,
            "days": ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"],
            "timeBands": ["07:30 – 09:00","09:15 – 10:45","11:00 – 12:30","12:30 – 14:15","14:30 – 16:00","16:15 – 17:45","18:00 – 19:30","19:45 – 21:00"],
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

        return {
            "ok": True,
            "faculty": {
                "full_name": full_name,
                "fullName": full_name,   
                "role": "Faculty",
                "department": (dept or {}).get("dept_name", "—"),
            },
            "notifications": notifications,
        }

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
        unique_units_calc = {}

        for r in rows:
            sec_id = r.get("_id")
            if sec_id:
                unique_units_calc[sec_id] = r.get("units", 0) or 0
            
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
            
        total_units = sum(unique_units_calc.values())
        course_preps = len(set(r.get("course_code", "") for r in final_teaching_load if r.get("course_code")))
        # --- *** END OF MODIFICATION *** ---


        load_header = await db.faculty_loads.find_one(
            {"department_id": faculty.get("department_id"), "term_id": term.get("term_id")},
            {"_id": 0, "status": 1},
        )
        status = (load_header or {}).get("status", "pending").capitalize()

        summary = {
            "teaching_units": f"{total_units}/{int(pref_units_for_calc)}",
            "course_preps": f"{course_preps}/{max_preps}",
            "load_status": status,
            "percent": int((total_units / pref_units_for_calc) * 100) if pref_units_for_calc > 0 else 0,
        }

        # Warnings / flags (used by frontend to show limit-exceeded warnings)
        # Note: If preferred units or max preps are 0, any positive current value is considered exceeded.
        units_max = float(pref_units_for_calc or 0)
        preps_max = int(max_preps or 0)
        summary["exceeded_teaching_units"] = (total_units > units_max) if units_max > 0 else (total_units > 0)
        summary["exceeded_course_preps"] = (course_preps > preps_max) if preps_max > 0 else (course_preps > 0)
        summary["teaching_units_over_by"] = max(0, int(round(total_units - units_max))) if summary["exceeded_teaching_units"] else 0
        summary["course_preps_over_by"] = max(0, int(course_preps - preps_max)) if summary["exceeded_course_preps"] else 0

        
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
            final_teaching_load = []
            summary["teaching_units"] = f"0/{int(pref_units_for_calc)}"
            summary["course_preps"] = f"0/{max_preps}"
            summary["percent"] = 0
            summary["exceeded_teaching_units"] = False
            summary["exceeded_course_preps"] = False
            summary["teaching_units_over_by"] = 0
            summary["course_preps_over_by"] = 0
            # keep the header-derived status if present, otherwise show Pending
            summary["load_status"] = (summary.get("load_status") or "Pending")
            return {
                "ok": True,
                "term": term,
                "summary": summary,
                "teaching_load": final_teaching_load,
                "is_proposed": False,
                "proposal_status": None,
                "rfc": None,
                "schedule_final": False,
            }

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

        return {
            "ok": True,
            "term": term,
            "summary": summary,
            "teaching_load": final_teaching_load,
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
    unique_units_calc = {}

    for r in rows:
        sec_id = r.get("_id")
        if sec_id:
            unique_units_calc[sec_id] = r.get("units", 0) or 0
        
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
        
    total_units = sum(unique_units_calc.values())
    course_preps = len(set(r.get("course_code", "") for r in final_teaching_load if r.get("course_code")))
    # --- *** END OF MODIFICATION *** ---

    load_header = await db.faculty_loads.find_one(
        {"department_id": faculty.get("department_id"), "term_id": term.get("term_id")},
        {"_id": 0, "status": 1},
    )
    status = (load_header or {}).get("status", "pending").capitalize()

    summary = {
        "teaching_units": f"{total_units}/{int(pref_units_for_calc)}",
        "course_preps": f"{course_preps}/{max_preps}",
        "load_status": status,
        "percent": int((total_units / pref_units_for_calc) * 100) if pref_units_for_calc > 0 else 0,
    }

    # Warnings / flags (used by frontend to show limit-exceeded warnings)
    # Note: If preferred units or max preps are 0, any positive current value is considered exceeded.
    units_max = float(pref_units_for_calc or 0)
    preps_max = int(max_preps or 0)
    summary["exceeded_teaching_units"] = (total_units > units_max) if units_max > 0 else (total_units > 0)
    summary["exceeded_course_preps"] = (course_preps > preps_max) if preps_max > 0 else (course_preps > 0)
    summary["teaching_units_over_by"] = max(0, int(round(total_units - units_max))) if summary["exceeded_teaching_units"] else 0
    summary["course_preps_over_by"] = max(0, int(course_preps - preps_max)) if summary["exceeded_course_preps"] else 0

    # IMPORTANT BEHAVIOR CHANGE (mirrors POST /overview?action=fetch):
    # If this is a PLANNING term and OM has NOT forwarded a proposal yet,
    # hide any schedule/teaching load on the faculty side.
    is_planning_term = bool(term and not term.get("is_current"))
    if is_planning_term:
        proposal = await db[COL_LOAD_PROPOSALS].find_one(
            {"faculty_id": faculty_id, "term_id": term_id},
            {"_id": 1},
        )
        if not proposal:
            final_teaching_load = []
            summary["teaching_units"] = f"0/{int(pref_units_for_calc)}"
            summary["course_preps"] = f"0/{max_preps}"
            summary["percent"] = 0
            summary["exceeded_teaching_units"] = False
            summary["exceeded_course_preps"] = False
            summary["teaching_units_over_by"] = 0
            summary["course_preps_over_by"] = 0
            summary["load_status"] = (summary.get("load_status") or "Pending")

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
            
    final_teaching_load.sort(key=lambda x: (x.get("day", ""), x.get("time", ""), x.get("section", "")))

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
        "teaching_load": final_teaching_load,
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
      <p>Log in here: <a href=" http://ccscloud.dlsu.edu.ph:11160/login">http://ccscloud.dlsu.edu.ph:11160/login</a></p>
    </div>
    """
    return subject, body_text, body_html

def _build_faculty_accept_email(
    *,
    term_label: str,
    faculty_name: str,
    rows: List[Dict[str, Any]],
    login_url: str = " http://ccscloud.dlsu.edu.ph:11160/login",
) -> Tuple[str, str, str]:
    subject = f"[AnimoAssign] Accepted schedule • {term_label}"

    def td(x: Any) -> str:
        return _html_escape("" if x is None else str(x))

    # Plain text fallback
    lines = [
        f"Dear {faculty_name},",
        f"",
        f"This confirms you have accepted your teaching load for {term_label}.",
        "",
        "Schedule:",
    ]
    for r in rows:
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
        tr_html += f"""
        <tr>
          <td>{td(r.get("course_code",""))}</td>
          <td style="text-align:center;">{td(r.get("section",""))}</td>
          <td style="text-align:center;">{td(r.get("units",""))}</td>
          <td style="text-align:center;">{td(r.get("mode",""))}</td>
          <td style="text-align:center;">{td(r.get("day1",""))}</td>
          <td style="text-align:center;">{td(r.get("time1",""))}</td>
          <td>{td(r.get("room1",""))}</td>
          <td style="text-align:center;">{td(r.get("day2",""))}</td>
          <td style="text-align:center;">{td(r.get("time2",""))}</td>
          <td>{td(r.get("room2",""))}</td>
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

    user = await db["users"].find_one({"user_id": userId}, {"_id": 0, "email": 1, "gmail": 1, "google_token": 1, "first_name": 1, "last_name": 1}) or {}

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

    proposal_rows = proposal.get("rows", []) or []

    # do not allow accept if pending RFC exists
    pending_rfc = await db[COL_LOAD_RFC].find_one({"faculty_id": fid, "term_id": term_id}, {"_id": 0}) or None
    if pending_rfc:
        existing_norm = _normalize_rfc_doc(pending_rfc)
        st = str(existing_norm.get("status") or "").upper()
        if st and st not in RFC_TERMINAL:
            raise HTTPException(
                status_code=409,
                detail="You have a pending RFC. Please wait for OM to respond before accepting the schedule."
            )

    await db[COL_LOAD_PROPOSALS].update_one(
        {"faculty_id": fid, "term_id": term_id},
        {"$set": {"status": "approved", "locked": True, "accepted_at": _now_utc(), "updated_at": _now_utc()},
         "$setOnInsert": {"created_at": _now_utc()}},
    )

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

    # --- NEW: send acceptance email to the faculty (best-effort, non-blocking) ---
    recipient_email = (
        ((user.get("google_token") or {}).get("connected_email") or "").strip()
        or (user.get("gmail") or "").strip()
        or (user.get("email") or "").strip()
    )

    # Term label (best effort)
    term_doc = await db[COL_TERMS].find_one({"term_id": term_id}, {"_id": 0, "acad_year_start": 1, "term_number": 1}) or {}
    term_label = _term_label(term_doc) if term_doc else term_id

    faculty_name = f"{(faculty.get('first_name') or '').strip()} {(faculty.get('last_name') or '').strip()}".strip() or "Faculty"

    email_sent = False
    email_error: Optional[str] = None

    if recipient_email:
        subject, body_text, body_html = _build_faculty_accept_email(
            term_label=term_label,
            faculty_name=faculty_name,
            rows=proposal_rows,
            login_url=" http://ccscloud.dlsu.edu.ph:11160/login",
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
        email_sent = False
        email_error = "No recipient email found for this user."

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

    # Keep old shape + add email fields (won't break existing callers)
    return {"ok": True, "status": "ACCEPTED", "email_sent": email_sent, "email_error": email_error}
