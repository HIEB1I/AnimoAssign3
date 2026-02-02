# backend/app/FACULTY/FACULTY_Overview.py
from fastapi import APIRouter, Query, HTTPException, Body
from ..main import db

# In-app bell notifications (shared Notifications collection)
from ..Notifications import create_notification
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple


import os
import base64
from email.message import EmailMessage
import httpx

_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
_GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
_RFC_EMAIL_TO = "johntario27@gmail.com"

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
    msg.set_content(body)

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

def _fmt_time_band(begin: str | None, end: str | None) -> str:
    if not begin or not end:
        return ""
    return f"{begin}–{end}"

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

        is_proposed = bool(proposal and proposal_status_l in ("proposed", "reply", "replied"))
        is_final = bool(proposal and (bool((proposal or {}).get("locked")) or proposal_status_l in ("accepted", "approved")))
        schedule_final = bool(is_final or (rfc_norm and str((rfc_norm.get("status") or "")).upper() in RFC_TERMINAL))

        proposed_load = []
        if (is_proposed or is_final) and isinstance(proposal.get("rows"), list):
            for rr in proposal.get("rows", []):
                sec_id = (rr.get("section_id") or rr.get("id") or "").strip()
                t1 = _fmt_time_band(rr.get("start"), rr.get("end")) or "TBA"
                t2 = _fmt_time_band(rr.get("start2"), rr.get("end2")) if rr.get("start2") or rr.get("end2") else None
                proposed_load.append({
                    "course_code": _as_code_str(rr.get("course") or rr.get("course_code")),
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


            if proposed_load:
                final_teaching_load = proposed_load
                summary["load_status"] = "Approved" if is_final else "Proposed"

        return {
            "ok": True,
            "term": term,
            "summary": summary,
            "teaching_load": final_teaching_load,
            "is_proposed": is_proposed,
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

# NEW BLOCK
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

    if (existing.get("status") or "").upper() in RFC_TERMINAL:
        raise HTTPException(status_code=409, detail="RFC is locked")

    now = _now_utc()
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
        )

    # Fetch some context for the email 
    term_doc = await db[COL_TERMS].find_one({"term_id": term_id}, {"_id": 0, "acad_year_start": 1, "term_number": 1}) or {}
    term_label = _term_label(term_doc) if term_doc else term_id

    sec_doc = await db[COL_SECTIONS].find_one({"section_id": section_id}, {"_id": 0}) or {}
    course_id = (sec_doc.get("course_id") or "").strip()
    course_doc = await db[COL_COURSES].find_one({"course_id": course_id}, {"_id": 0}) if course_id else ({})

    code = (course_doc or {}).get("course_code") or (course_doc or {}).get("code") or ""
    title = (course_doc or {}).get("course_title") or (course_doc or {}).get("title") or ""
    section_label = sec_doc.get("section_code") or sec_doc.get("section") or section_id

    sender_name = f"{faculty.get('first_name','')} {faculty.get('last_name','')}".strip() or userId

    subject = f"[AnimoAssign] RFC - {code} {section_label}".strip()

    thread_lines = []
    for m in msgs:
        who = (m.get("sender_role") or "").upper()
        ts = m.get("created_at") or ""
        txt = m.get("message") or ""
        thread_lines.append(f"- {who} @ {ts}\n  {txt}")

    email_body = (
        f"Request for Change (RFC)\n\n"
        f"From: {sender_name}\n"
        f"Term: {term_label}\n"
        f"Course: {code} - {title}\n"
        f"Section: {section_label}\n"
        f"Section ID: {section_id}\n\n"
        f"Latest message:\n{message}\n\n"
        f"Thread:\n" + "\n".join(thread_lines) +
        f"\n\n[AnimoAssign]"
    )

    email_sent = False
    email_error: Optional[str] = None
    try:
        email_sent, email_error = await _send_email_via_user_gmail(
            user_id=userId,
            to_email=_RFC_EMAIL_TO,
            subject=subject,
            body=email_body,
        )
    except Exception as e:
        email_sent = False
        email_error = str(e)

    return {
        "ok": True,
        "rfc_id": existing.get("rfc_id"),
        "status": "NEEDS_OM",
        "email_sent": email_sent,
        "email_error": email_error,
    }

# END NEW BLOCK

@router.post("/load-assignment/accept")
async def faculty_accept_load_proposal(userId: str = Query(...), payload: Dict[str, Any] = Body({})):
    faculty = await db[COL_FACULTY].find_one({"user_id": userId}, {"_id": 0})
    if not faculty:
        raise HTTPException(status_code=404, detail="Faculty not found")

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


    # --- NEW: do not allow "Accept Schedule" if there is a pending RFC thread ---
    pending_rfc = await db[COL_LOAD_RFC].find_one({"faculty_id": fid, "term_id": term_id}, {"_id": 0}) or None
    if pending_rfc:
        existing_norm = _normalize_rfc_doc(pending_rfc)
        st = str(existing_norm.get("status") or "").upper()
        if st and st not in RFC_TERMINAL:
            raise HTTPException(status_code=409, detail="You have a pending RFC. Please wait for OM to respond before accepting the schedule.")

    await db[COL_LOAD_PROPOSALS].update_one(
        {"faculty_id": fid, "term_id": term_id},
        {
            "$set": {
                "status": "approved",
                "locked": True,
                "accepted_at": _now_utc(),
                "updated_at": _now_utc(),
            },
            # mark all proposed rows as finalized so OM & Faculty UIs become read-only
            "$setOnInsert": {"created_at": _now_utc()},
        },
    )

    # Best-effort: finalize all rows (schema-compatible)
    try:
        await db[COL_LOAD_PROPOSALS].update_one(
            {"faculty_id": fid, "term_id": term_id},
            {"$set": {"rows.$[].finalized": True}},
        )
    except Exception:
        pass

    # lock ALL RFC threads for this faculty+term (RFC is per-course now)
    now = _now_utc()

    await db[COL_LOAD_RFC].update_many(
        {"faculty_id": fid, "term_id": term_id},
        {"$set": {"status": "ACCEPTED", "locked": True, "updated_at": now}},
    )

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

    return {"ok": True, "status": "ACCEPTED"}

